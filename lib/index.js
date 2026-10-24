// dshm-boot-rescue — host side.
//
// DSHM（鸿蒙端 DeepSeek Harness）的 Web UI 启动门要求「profile 里所有 loader 条目
// 都激活」。只要有一个 client 条目 pending（常见于某插件在等一个不存在的服务），
// 整个页面就只剩 “Failed to load plugins”，而插件管理页本身也在这张页面里 ——
// 用户没有任何恢复入口。
//
// 本插件不依赖正常的客户端插件加载链：宿主把一段很小的救援脚本通过
// webServer.tapIndex 注入 index.html，脚本在失败页上挂出「启动恢复中心」，
// 把肇事插件的行 id 写入 DSHM 的持久启停文件 `.dshm-plugin-rows.yml`
// （profile 每次启动按「种子 + 用户行」重拼 cordis.patch.yml，所以只有这个文件
// 能跨重启生效），用户划掉后台重开应用即可恢复。
//
// 平台约束（DSHM 真机，务必保持）：
//   · 纯宿主插件、零依赖、只用 Node 内置模块；
//   · 禁止子进程模块、WASM、后台线程（端侧 --jitless，且平台不允许创建进程）；
//   · 禁止静态 inject 声明（会因缺服务进入 pending）：webServer/loader 一律
//     ctx.get 并判空，
//     拿不到只写日志降级，绝不进入 pending（那正是本插件要救的故障模式）；
//   · 所有文件读写只能在 $DSH_HOME / $DSHM_HOME 内。

import { readFile, writeFile, rename, unlink, copyFile, stat, mkdir, rm } from "node:fs/promises";
import { readFileSync, existsSync, statSync, readdirSync, appendFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, resolve, isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";

// ── 常量 ────────────────────────────────────────────────────────────────
const PACKAGE_NAME = "dshm-boot-rescue";
const SELF_ENTRY_ID = "dshm-boot-rescue";
const ROUTE_PATH = "/dshm-boot-rescue";
const ROWS_FILENAME = ".dshm-plugin-rows.yml";
const ROW_MARKER_PREFIX = "# [dshm-boot-rescue] disabled ";
const PATCH_MARKER_PREFIX = "# [dshm-boot-rescue] fallback-disabled ";
const FALLBACK_WARNING = "本次停用重启应用后失效，请进入系统后立即卸载肇事插件";
const RESCUE_MARKER = "dshm-boot-rescue-client";
const LOG_FILENAME = "dshm-boot-rescue.log";
const BACKUP_SUFFIX = ".dshm-boot-rescue.bak";
const MAX_BODY_BYTES = 32 * 1024;
const MAX_IDS = 32;
const MAX_ID_LENGTH = 200;
const MAX_ENTRIES = 400;
const MAX_ALIASES = 12;
const MAX_MUTATION_ATTEMPTS = 4;
const SERVICE_WAIT_MS = 1000;
const SERVICE_WAIT_TRIES = 30;
const LEDGER_FILENAME = "dshm-boot-rescue-ledger.json";
const LEDGER_VERSION = 1;
const LEDGER_MAX = 200;
const SNAPSHOT_DIRNAME = "dshm-boot-rescue-snapshots";
const SNAPSHOT_KEEP = 5;
const SNAPSHOT_AUTO_DELAY_MS = 15000;
const BOOT_FAILED_FILENAME = ".dshm-boot-failed";
const QUARANTINE_PATTERN = /(?:\.quarantine-|\.dshm-quarantine-|rows.*\.bak-)/i;
const CORE_BUNDLES_REQUIRED = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"];
const BUNDLE_PROTECT_PREFIX = "@deepseek-ai/";
// 与 dsh-app-boot 的 FIBER_* 对齐：cordis 的 FiberState 是 const enum，没有运行时对象，
// 宿主侧也只能写死。0=pending，1=loading，2=active，3=failed，4=disposed。
const FIBER_STATE_NAMES = { 0: "pending", 1: "loading", 2: "active", 3: "failed", 4: "disposed" };
// 这些 entry 是宿主骨架，停掉它们连救援入口都会消失，永不作为救援候选。
const REQUIRED_ENTRY_IDS = [
  "agent-loop",
  "webserver",
  "web-runtime",
  "modules",
  "connection",
  "headless-runner",
  "acp",
  "sdk-jsonrpc-server",
];

export const name = "dshm-boot-rescue";
export const version = readVersion();
export const ROUTE = ROUTE_PATH;
export const ROWS_FILE_NAME = ROWS_FILENAME;
export const DISABLE_MARKER = ROW_MARKER_PREFIX;
export const FALLBACK_MARKER = PATCH_MARKER_PREFIX;
export const FALLBACK_MESSAGE = FALLBACK_WARNING;

const fileMutationQueues = new Map();
const installedScanCache = new Map();

function readVersion() {
  try {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof manifest.version === "string" && manifest.version.length > 0 ? manifest.version : "0.0.0";
  } catch (_) {
    return "0.0.0";
  }
}

// ── 通用小工具 ──────────────────────────────────────────────────────────
function errText(error) {
  if (error === null || error === undefined) {
    return "unknown error";
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error.message === "string" && error.message.length > 0) {
    return error.message;
  }
  try {
    return String(error);
  } catch (_) {
    return "unknown error";
  }
}

function errorWithStatus(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) {
    error.code = code;
  }
  return error;
}

function sha256(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

function json(res, statusCode, value) {
  if (!res || res.writableEnded) {
    return;
  }
  if (typeof res.writeHead === "function") {
    res.writeHead(statusCode, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
  }
  if (typeof res.end === "function") {
    res.end(JSON.stringify(value));
  }
}

function methodAllowed(req, res, expected) {
  if (req && req.method === expected) {
    return true;
  }
  if (res && typeof res.writeHead === "function") {
    res.writeHead(405, { allow: expected, "cache-control": "no-store" });
  }
  if (res && typeof res.end === "function") {
    res.end();
  }
  return false;
}

function isInside(parent, child) {
  try {
    const parentPath = resolve(String(parent || ""));
    const childPath = resolve(String(child || ""));
    const rel = relative(parentPath, childPath);
    if (rel === "") {
      return true;
    }
    return !rel.startsWith("..") && !isAbsolute(rel);
  } catch (_) {
    return false;
  }
}

function isProfileDirectory(dir) {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return !!(manifest && typeof manifest === "object" && manifest.dsh
      && typeof manifest.dsh === "object" && manifest.dsh.profile
      && typeof manifest.dsh.profile === "object");
  } catch (_) {
    return false;
  }
}

function readJsonSync(filename) {
  try {
    return JSON.parse(readFileSync(filename, "utf8"));
  } catch (_) {
    return null;
  }
}

// ── YAML 文本 / 标量 ────────────────────────────────────────────────────
function parseYamlScalar(source) {
  const raw = String(source === null || source === undefined ? "" : source).trim();
  if (!raw) {
    return null;
  }
  const commentOffset = raw.search(/\s+#/);
  const value = (commentOffset === -1 ? raw : raw.slice(0, commentOffset)).trim();
  if (!value) {
    return null;
  }
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch (_) {
      return null;
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function yamlQuoteId(value) {
  const id = String(value === null || value === undefined ? "" : value);
  if (!id) {
    return id;
  }
  const needs = /^[@`*&!%#~|]/.test(id)
    || /[#]:\s/.test(id)
    || id !== id.trim()
    || /[@#]/.test(id);
  if (needs) {
    return "'" + id.replace(/'/g, "''") + "'";
  }
  return id;
}

function textFormat(text) {
  const source = String(text === null || text === undefined ? "" : text);
  const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = bom ? source.slice(1) : source;
  const newline = body.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
  return {
    bom,
    newline,
    body: body.replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
  };
}

function encodeText(body, format) {
  return format.bom + String(body).replace(/\n/g, format.newline);
}

function isValidRowId(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_ID_LENGTH
    && !/[\u0000-\u001f\u007f]/.test(value)
    && !/\s/.test(value);
}

// ── 用户行文件（.dshm-plugin-rows.yml）解析 ─────────────────────────────
// 格式只有两种行：`- id: <行id>` 与缩进的 `disabled: true|false`；
// 注释/空行允许。任何其它内容都视为「结构无法安全解析」→ 降级模式。
export function parseUserRows(text) {
  const format = textFormat(text);
  const lines = format.body.split("\n");
  const rows = [];
  let current = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const idMatch = /^-\s+id:\s*(.*)$/.exec(line);
    if (idMatch) {
      const id = parseYamlScalar(idMatch[1]);
      if (!isValidRowId(id)) {
        return { ok: false, rows: [], format, issue: "line " + String(index + 1) + ": invalid row id" };
      }
      current = { id, disabled: false, line: index, disabledLine: -1 };
      rows.push(current);
      continue;
    }
    const disabledMatch = /^\s+disabled:\s*(.*?)\s*$/.exec(line);
    if (disabledMatch && current) {
      const raw = parseYamlScalar(disabledMatch[1]);
      current.disabled = !(raw !== null && String(raw).toLowerCase() === "false");
      current.disabledLine = index;
      continue;
    }
    return { ok: false, rows: [], format, issue: "line " + String(index + 1) + ": unsupported content" };
  }
  return { ok: true, rows, format, issue: "" };
}

function collectMarkers(body, markerPrefix) {
  const found = [];
  const lines = String(body || "").split("\n");
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].indexOf(markerPrefix) === 0) {
      const id = lines[index].slice(markerPrefix.length).trim();
      if (id && found.indexOf(id) === -1) {
        found.push(id);
      }
    }
  }
  return found;
}

function buildDisableBlock(markerPrefix, id) {
  return markerPrefix + id + "\n- id: " + yamlQuoteId(id) + "\n  disabled: true";
}

// 把 ids 追加成带标记的禁用行；已由用户禁用或已有本插件标记的 id 不重复写。
export function renderDisableRows(text, ids) {
  const source = String(text === null || text === undefined ? "" : text);
  const parsed = parseUserRows(source);
  if (!parsed.ok) {
    throw errorWithStatus(422, "用户行文件结构无法安全解析：" + parsed.issue, "rows-invalid");
  }
  const format = parsed.format;
  const already = [];
  const added = [];
  const blocks = [];
  const markers = collectMarkers(format.body, ROW_MARKER_PREFIX);
  for (const rawId of ids || []) {
    const id = String(rawId);
    const existing = parsed.rows.filter(function (row) { return row.id === id; })[0];
    if (markers.indexOf(id) !== -1 || (existing && existing.disabled)) {
      if (already.indexOf(id) === -1) {
        already.push(id);
      }
      continue;
    }
    blocks.push(buildDisableBlock(ROW_MARKER_PREFIX, id));
    added.push(id);
  }
  if (!blocks.length) {
    return { text: source, result: { added, already } };
  }
  let body = format.body;
  if (body.length > 0 && !body.endsWith("\n")) {
    body += "\n";
  }
  body += blocks.join("\n") + "\n";
  return { text: encodeText(body, format), result: { added, already } };
}

// 只删除「本插件标记 + 精确 3 行块」；用户改过的块、其它行一律原样保留。
export function removeRescueRows(text, ids, options) {
  const source = String(text === null || text === undefined ? "" : text);
  const opts = options && typeof options === "object" ? options : {};
  const markerPrefix = typeof opts.markerPrefix === "string" && opts.markerPrefix.length > 0
    ? opts.markerPrefix
    : ROW_MARKER_PREFIX;
  const wanted = Object.prototype.toString.call(ids) === "[object Set]"
    ? new Set(Array.from(ids).map(String))
    : (Array.isArray(ids) && ids.length > 0
      ? new Set(ids.map(String))
      : (typeof ids === "string" && ids.length > 0 ? new Set([ids]) : null));
  const format = textFormat(source);
  const lines = format.body.split("\n");
  const output = [];
  const restored = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.indexOf(markerPrefix) === 0) {
      const id = line.slice(markerPrefix.length).trim();
      const selected = wanted === null || wanted.has(id);
      const idLine = lines[index + 1] !== undefined ? lines[index + 1] : "";
      const disabledLine = lines[index + 2] !== undefined ? lines[index + 2] : "";
      const nextLine = lines[index + 3] !== undefined ? lines[index + 3] : "";
      const idMatch = /^-\s+id:\s*(.*?)\s*$/.exec(idLine);
      const parsedId = idMatch ? parseYamlScalar(idMatch[1]) : null;
      // 即使有人手工伪造了本插件标记，也绝不删除 @deepseek-ai 内置行或插件自身。
      const forbidden = id.indexOf("@deepseek-ai/") === 0 || id === SELF_ENTRY_ID || id === PACKAGE_NAME;
      const exact = selected
        && !forbidden
        && id.length > 0
        && parsedId === id
        && /^\s{2}disabled:\s*true\s*$/.test(disabledLine)
        && !/^\s+\S/.test(nextLine);
      if (exact) {
        restored.push(id);
        index += 3;
        continue;
      }
    }
    output.push(line);
    index += 1;
  }
  if (!restored.length) {
    return { text: source, result: { restored } };
  }
  return { text: encodeText(output.join("\n"), format), result: { restored } };
}

// ── cordis.patch.yml 解析（降级模式 + name→row id 映射） ────────────────
// 解析 `- id: X` 行及其块内（缩进 +2）的 name / disabled。
export function parsePatchRows(text) {
  const format = textFormat(text);
  const lines = format.body.split("\n");
  const rows = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const match = /^(\s*)-\s+id:\s*(.*?)\s*$/.exec(line);
    if (!match) {
      continue;
    }
    const indent = match[1].length;
    const id = parseYamlScalar(match[2]);
    if (!isValidRowId(id)) {
      continue;
    }
    const row = { id, name: "", disabled: false, insert: isInsertRow(lines, index, indent), indent, line: index };
    for (let next = index + 1; next < lines.length; next++) {
      const candidate = lines[next];
      if (!candidate.trim() || candidate.trim().startsWith("#")) {
        continue;
      }
      const indentMatch = /^(\s*)/.exec(candidate);
      const candidateIndent = indentMatch ? indentMatch[1].length : 0;
      if (candidateIndent <= indent) {
        break;
      }
      if (candidateIndent === indent + 2) {
        const nameMatch = /^\s+name:\s*(.*?)\s*$/.exec(candidate);
        if (nameMatch && !row.name) {
          row.name = parseYamlScalar(nameMatch[1]) || "";
        }
        if (/^\s+disabled:\s*true\b/.test(candidate)) {
          row.disabled = true;
        }
      }
    }
    rows.push(row);
  }
  return rows;
}

// 判断一条 `- id:` 行是否位于某个 `- insert:` 块内（新的 loader 条目），
// 而不是对已有条目的 patch 覆盖行。Bundle patch 里只有 insert 行才是可停用的真实新行。
function isInsertRow(lines, rowIndex, indent) {
  for (let index = rowIndex - 1; index >= 0; index--) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const indentMatch = /^(\s*)/.exec(line);
    const lineIndent = indentMatch ? indentMatch[1].length : 0;
    if (lineIndent >= indent) {
      continue;
    }
    return /^-\s+insert:\s*$/.test(line) || /^\s+insert:\s*$/.test(line);
  }
  return false;
}

function significantPatchLines(body) {
  return String(body || "").split("\n").filter(function (line) {
    const trimmed = line.trim();
    return trimmed && !trimmed.startsWith("#") && trimmed !== "---";
  });
}

// 降级写 cordis.patch.yml 前确认它是可追加的顶层 YAML 数组。
export function checkPatchAppendable(text) {
  const format = textFormat(text);
  const significant = significantPatchLines(format.body);
  if (!significant.length) {
    return { ok: true, reason: "" };
  }
  if (/^\[\]\s*(?:#.*)?$/.test(significant[0]) && significant.length === 1) {
    return { ok: true, reason: "" };
  }
  if (!/^-($|\s)/.test(significant[0])) {
    return { ok: false, reason: "cordis.patch.yml 不是顶层 YAML 数组" };
  }
  for (const line of significant) {
    if (!/^\s/.test(line) && !/^-($|\s)/.test(line)) {
      return { ok: false, reason: "cordis.patch.yml 含不支持的顶层内容" };
    }
  }
  return { ok: true, reason: "" };
}

function normalizePatchBody(body) {
  const lines = String(body || "").split("\n");
  const significant = significantPatchLines(body);
  if (significant.length === 1 && /^\[\]\s*(?:#.*)?$/.test(significant[0])) {
    for (let index = 0; index < lines.length; index++) {
      if (/^\s*\[\]\s*(?:#.*)?$/.test(lines[index])) {
        lines.splice(index, 1);
        break;
      }
    }
  }
  return lines.join("\n").replace(/[ \t\n]+$/g, "");
}

// 降级模式：把 ids 追加成带标记的禁用行。只用于用户行文件无法解析时。
export function renderPatchDisableRows(text, ids) {
  const source = String(text === null || text === undefined ? "" : text);
  const format = textFormat(source);
  const appendable = checkPatchAppendable(source);
  if (!appendable.ok) {
    throw errorWithStatus(422, appendable.reason, "patch-invalid");
  }
  const parsedRows = parsePatchRows(source);
  const disabledIds = parsedRows.filter(function (row) { return row.disabled; }).map(function (row) { return row.id; });
  const markers = collectMarkers(format.body, PATCH_MARKER_PREFIX);
  const added = [];
  const already = [];
  const blocks = [];
  for (const rawId of ids || []) {
    const id = String(rawId);
    if (markers.indexOf(id) !== -1 || disabledIds.indexOf(id) !== -1) {
      if (already.indexOf(id) === -1) {
        already.push(id);
      }
      continue;
    }
    blocks.push(buildDisableBlock(PATCH_MARKER_PREFIX, id));
    added.push(id);
  }
  if (!blocks.length) {
    return { text: source, result: { added, already } };
  }
  let body = normalizePatchBody(format.body);
  if (body.length > 0) {
    body += "\n";
  }
  body += blocks.join("\n") + "\n";
  return { text: encodeText(body, format), result: { added, already } };
}

// ── 原子文件修改（备份 + tmp + rename + 快照校验 + 串行队列） ───────────
function statSignature(value) {
  return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(":");
}

async function captureSnapshot(filename) {
  for (let attempt = 0; attempt < MAX_MUTATION_ATTEMPTS; attempt++) {
    let before = null;
    try {
      before = await stat(filename, { bigint: true });
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return { exists: false, text: "", signature: "missing", hash: "" };
      }
      throw error;
    }
    const text = await readFile(filename, "utf8");
    let after = null;
    try {
      after = await stat(filename, { bigint: true });
    } catch (_) {
      continue;
    }
    const signature = statSignature(after);
    if (statSignature(before) === signature) {
      return { exists: true, text, signature, hash: sha256(text) };
    }
  }
  throw errorWithStatus(409, "文件在读取过程中被修改，请重试", "file-busy");
}

async function mutateTextFileUnlocked(filename, render) {
  for (let attempt = 0; attempt < MAX_MUTATION_ATTEMPTS; attempt++) {
    const snapshot = await captureSnapshot(filename);
    const rendered = render(snapshot.text);
    if (rendered.text === snapshot.text) {
      return rendered.result;
    }
    const temporary = filename + ".dshm-boot-rescue-" + String(process.pid) + "-" + randomUUID() + ".tmp";
    try {
      await writeFile(temporary, rendered.text, { encoding: "utf8", flag: "wx" });
      const current = await captureSnapshot(filename);
      if (current.exists !== snapshot.exists || current.signature !== snapshot.signature || current.hash !== snapshot.hash) {
        try {
          await unlink(temporary);
        } catch (_) {
          // ignore
        }
        continue;
      }
      if (snapshot.exists) {
        try {
          await copyFile(filename, filename + BACKUP_SUFFIX);
        } catch (error) {
          try {
            await unlink(temporary);
          } catch (_) {
            // ignore
          }
          throw errorWithStatus(500, "写前备份失败，已拒绝写入：" + errText(error), "backup-failed");
        }
      }
      await rename(temporary, filename);
      return rendered.result;
    } catch (error) {
      try {
        await unlink(temporary);
      } catch (_) {
        // ignore
      }
      throw error;
    }
  }
  throw errorWithStatus(409, "文件持续变化，未写入任何修改", "file-busy");
}

export function mutateTextFile(filename, render) {
  const previous = fileMutationQueues.get(filename) || Promise.resolve();
  const run = previous.then(
    function () { return mutateTextFileUnlocked(filename, render); },
    function () { return mutateTextFileUnlocked(filename, render); }
  );
  const tail = run.then(function () {}, function () {});
  fileMutationQueues.set(filename, tail);
  tail.then(function () {
    if (fileMutationQueues.get(filename) === tail) {
      fileMutationQueues.delete(filename);
    }
  });
  return run;
}

// ── 数据目录 / profile 定位 ─────────────────────────────────────────────
export function resolveHomeDir(env) {
  const source = env && typeof env === "object" ? env : process.env;
  for (const key of ["DSH_HOME", "DSHM_HOME"]) {
    try {
      const raw = String(source[key] === undefined ? "" : source[key]).trim();
      if (!raw || !isAbsolute(raw)) {
        continue;
      }
      const dir = resolve(raw);
      if (statSync(dir).isDirectory()) {
        return { dir, source: key };
      }
    } catch (_) {
      // try next source
    }
  }
  return { dir: "", source: "" };
}

export function readHostReadyProfile(homeDir) {
  if (!homeDir) {
    return "";
  }
  const manifest = readJsonSync(join(homeDir, "host-ready.json"));
  if (manifest && typeof manifest.profile === "string" && manifest.profile.length > 0) {
    return manifest.profile;
  }
  return "";
}

export function findProfileDir(startDir, homeDir) {
  try {
    let current = resolve(String(startDir || ""));
    for (let depth = 0; depth < 12; depth++) {
      // 先判边界再读 package.json：任何读取都必须留在 DSH_HOME 内。
      if ((!homeDir || isInside(homeDir, current)) && isProfileDirectory(current)) {
        return current;
      }
      const parent = dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  } catch (_) {
    // ignore
  }
  return "";
}

function resolveProfileDir(homeDir, startDir) {
  // 1) 插件自身安装路径向上找（profile/node_modules/dshm-boot-rescue/lib → profile）
  const fromPlugin = findProfileDir(startDir, homeDir);
  if (fromPlugin) {
    return { dir: fromPlugin, source: "plugin-path" };
  }
  // 2) DSHM_PROFILE 环境变量
  const envProfile = String(process.env.DSHM_PROFILE === undefined ? "" : process.env.DSHM_PROFILE).trim();
  if (envProfile) {
    const candidate = join(homeDir, "profiles", envProfile);
    if (isInside(homeDir, candidate) && isProfileDirectory(candidate)) {
      return { dir: candidate, source: "DSHM_PROFILE" };
    }
  }
  // 3) host-ready.json（DSHM 入口脚本必写，含当前 profile 名）
  const readyProfile = readHostReadyProfile(homeDir);
  if (readyProfile) {
    const candidate = join(homeDir, "profiles", readyProfile);
    if (isInside(homeDir, candidate) && isProfileDirectory(candidate)) {
      return { dir: candidate, source: "host-ready" };
    }
  }
  // 4) 默认 profile 名
  const fallback = join(homeDir, "profiles", "ondevice");
  if (isInside(homeDir, fallback) && isProfileDirectory(fallback)) {
    return { dir: fallback, source: "default-ondevice" };
  }
  // 5) 扫描 profiles/*：只有一个时采用；多个时优先包含本插件的目录
  try {
    const profilesRoot = join(homeDir, "profiles");
    const dirents = readdirSync(profilesRoot, { withFileTypes: true });
    const found = [];
    for (const dirent of dirents) {
      if (!dirent || !dirent.isDirectory || !dirent.isDirectory()) {
        continue;
      }
      const candidate = join(profilesRoot, dirent.name);
      if (isInside(homeDir, candidate) && isProfileDirectory(candidate)) {
        found.push(candidate);
      }
    }
    if (found.length === 1) {
      return { dir: found[0], source: "profiles-scan" };
    }
    for (const candidate of found) {
      if (existsSync(join(candidate, "node_modules", PACKAGE_NAME, "package.json"))) {
        return { dir: candidate, source: "profiles-scan-plugin" };
      }
    }
  } catch (_) {
    // ignore
  }
  return { dir: "", source: "" };
}

function readRowsFile(filename) {
  return readFile(filename, "utf8").then(function (text) {
    const parsed = parseUserRows(text);
    return { state: "found", exists: true, text, parse: parsed };
  }, function (error) {
    if (error && error.code === "ENOENT") {
      return { state: "missing", exists: false, text: "", parse: { ok: true, rows: [] } };
    }
    return { state: "unreadable", exists: false, text: "", parse: { ok: false, rows: [] }, error: errText(error) };
  });
}

async function readPatchInfo(profileDir) {
  const patchPath = join(profileDir, "cordis.patch.yml");
  try {
    const text = await readFile(patchPath, "utf8");
    return { ok: true, text, rows: parsePatchRows(text) };
  } catch (error) {
    return { ok: false, text: "", rows: [], error: errText(error) };
  }
}

// ── 已安装插件（bundle patch 的 entry id ↔ name 映射） ──────────────────
function pushUnique(list, seen, item) {
  if (!item || typeof item.id !== "string" || !item.id || !isValidRowId(item.id)) {
    return;
  }
  const key = item.id + "\u0000" + String(item.packageName || "");
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  list.push(item);
}

async function readInstalledPluginEntries(profileDir) {
  const cached = installedScanCache.get(profileDir);
  if (cached && Date.now() - cached.at < 8000) {
    return cached.value;
  }
  const value = await scanInstalledPluginEntries(profileDir);
  installedScanCache.set(profileDir, { at: Date.now(), value });
  return value;
}

async function scanInstalledPluginEntries(profileDir) {
  const output = [];
  const seen = new Set();
  let profileManifest = null;
  try {
    profileManifest = JSON.parse(await readFile(join(profileDir, "package.json"), "utf8"));
  } catch (_) {
    profileManifest = null;
  }
  const dependencyNames = new Set(Object.keys((profileManifest && profileManifest.dependencies) || {}));
  const candidates = new Set();
  dependencyNames.forEach(function (item) { candidates.add(item); });
  try {
    const dirents = await readdirSync(join(profileDir, "node_modules"), { withFileTypes: true });
    for (const dirent of dirents) {
      if (!dirent || !dirent.isDirectory || !dirent.isDirectory()) {
        continue;
      }
      if (dirent.name.startsWith(".")) {
        continue;
      }
      if (dirent.name.startsWith("@")) {
        try {
          const scoped = await readdirSync(join(profileDir, "node_modules", dirent.name), { withFileTypes: true });
          for (const child of scoped) {
            if (child && child.isDirectory && child.isDirectory()) {
              candidates.add(dirent.name + "/" + child.name);
            }
          }
        } catch (_) {
          // ignore
        }
        continue;
      }
      candidates.add(dirent.name);
    }
  } catch (_) {
    // node_modules 不存在：只用 package.json dependencies
  }
  let inspected = 0;
  for (const name of candidates) {
    if (inspected >= 160) {
      break;
    }
    inspected += 1;
    if (name === PACKAGE_NAME || name === SELF_ENTRY_ID) {
      continue;
    }
    // 包名来自 profile package.json / 目录扫描：拒绝任何可逃逸 node_modules 的写法，
    // 保证所有读取都留在 DSH_HOME 内（依赖名不允许 `..` / 绝对路径）。
    if (!name || isAbsolute(name) || name.indexOf("..") !== -1 || name.indexOf("\\") !== -1
      || /[\u0000-\u001f\u007f]/.test(name) || /\s/.test(name)) {
      continue;
    }
    const packageDir = join(profileDir, "node_modules", name);
    if (!isInside(join(profileDir, "node_modules"), packageDir)) {
      continue;
    }
    let packageManifest = null;
    try {
      packageManifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
    } catch (_) {
      continue;
    }
    const packageName = typeof packageManifest.name === "string" && packageManifest.name
      ? packageManifest.name
      : name;
    if (packageName === PACKAGE_NAME || packageName === SELF_ENTRY_ID) {
      continue;
    }
    let dsh = null;
    if (packageManifest.dsh && typeof packageManifest.dsh === "object") {
      dsh = packageManifest.dsh;
    }
    const hasBundle = !!(dsh && (dsh.bundle !== undefined || dsh.bundles !== undefined));
    if (!hasBundle && !dependencyNames.has(name)) {
      continue;
    }
    let patchRelative = "cordis.patch.yml";
    if (dsh && dsh.bundle && typeof dsh.bundle === "object" && typeof dsh.bundle.patch === "string" && dsh.bundle.patch) {
      patchRelative = dsh.bundle.patch;
    }
    let patchPath = "";
    try {
      patchPath = resolve(packageDir, patchRelative);
    } catch (_) {
      patchPath = "";
    }
    let bundleRows = [];
    if (patchPath && isInside(packageDir, patchPath)) {
      try {
        const bundleText = await readFile(patchPath, "utf8");
        bundleRows = parsePatchRows(bundleText);
      } catch (_) {
        bundleRows = [];
      }
    }
    if (bundleRows.length > 0) {
      let insertedCount = 0;
      for (const row of bundleRows) {
        // 只认 bundle patch 顶层 `- insert:` 块里的行（标准缩进 2~4）；
        // 更深的 `- id:` 可能是 config 里的普通数组项，不能当插件行。
        if (!row.insert || row.indent > 4) {
          continue;
        }
        insertedCount += 1;
        pushUnique(output, seen, {
          id: row.id,
          name: row.name || packageName,
          packageName,
          disabled: !!row.disabled,
          source: "installed",
        });
      }
      if (insertedCount > 0) {
        continue;
      }
    }
    if (hasBundle) {
      pushUnique(output, seen, {
        id: packageName,
        name: packageName,
        packageName,
        disabled: false,
        source: "installed-fallback",
      });
    } else {
      pushUnique(output, seen, {
        id: packageName,
        name: packageName,
        packageName,
        disabled: false,
        source: "dependency",
      });
    }
  }
  return output;
}

// ── 宿主 loader（可选：只做映射补全与状态显示） ─────────────────────────
function readLoaderEntries(ctx) {
  try {
    const loader = ctx && typeof ctx.get === "function" ? ctx.get("loader") : undefined;
    if (!loader || typeof loader.entries !== "function") {
      return { ok: false, reason: "unavailable", entries: [] };
    }
    const output = [];
    for (const entry of loader.entries()) {
      const options = entry && entry.options ? entry.options : {};
      const id = options.id;
      if (typeof id !== "string" || !id) {
        continue;
      }
      output.push({
        id,
        name: typeof options.name === "string" ? options.name : "",
        disabled: !!entry.disabled,
      });
    }
    return { ok: true, reason: "ok", entries: output };
  } catch (error) {
    return { ok: false, reason: "error: " + errText(error), entries: [] };
  }
}

// ── catalog：候选行 + name→row id 映射（纯函数，便于测试） ──────────────
export function buildCatalog(input) {
  const opts = input && typeof input === "object" ? input : {};
  const selfId = typeof opts.selfId === "string" && opts.selfId ? opts.selfId : SELF_ENTRY_ID;
  const selfName = typeof opts.selfName === "string" && opts.selfName ? opts.selfName : PACKAGE_NAME;
  const writable = opts.writable !== false;
  const allowPatch = opts.allowPatch === true;
  const bundleList = Array.isArray(opts.bundles)
    ? opts.bundles.filter(function (value) { return typeof value === "string" && value; })
    : [];
  const rescueRows = new Set((opts.rescueRows || []).map(String));
  const known = new Map();

  function ensure(id) {
    let item = known.get(id);
    if (!item) {
      item = {
        id,
        name: "",
        packageName: "",
        aliases: [],
        installed: false,
        hasUserRow: false,
        disabled: false,
        knownRow: false,
      };
      known.set(id, item);
    }
    return item;
  }

  function addAlias(item, value) {
    if (typeof value !== "string") {
      return;
    }
    const alias = value.trim();
    if (!alias || alias.length > MAX_ID_LENGTH) {
      return;
    }
    if (item.aliases.indexOf(alias) === -1 && item.aliases.length < MAX_ALIASES) {
      item.aliases.push(alias);
    }
  }

  function mergeRow(row, flags) {
    if (!row || typeof row.id !== "string" || !isValidRowId(row.id)) {
      return;
    }
    const item = ensure(row.id);
    const options = flags || {};
    item.knownRow = item.knownRow || options.known !== false;
    if (typeof row.name === "string" && row.name && !item.name) {
      item.name = row.name;
    }
    if (options.installed) {
      item.installed = true;
      if (typeof row.packageName === "string" && row.packageName && !item.packageName) {
        item.packageName = row.packageName;
      }
    }
    if (options.userRow) {
      item.hasUserRow = true;
    }
    if (row.disabled) {
      item.disabled = true;
    }
    addAlias(item, row.id);
    addAlias(item, row.name);
    addAlias(item, row.packageName);
  }

  const loaderById = new Map();
  (opts.loaderEntries || []).forEach(function (row) {
    if (row && typeof row.id === "string" && row.id) {
      loaderById.set(row.id, row);
    }
  });
  (opts.patchEntries || []).forEach(function (row) {
    // 核心 seed / 覆盖行只用于 name→row id 映射，不作为候选。
    // 没有 name 的行（如 `- id: web-runtime` / `- id: subprocess` 这类核心覆盖行）
    // 无法证明是用户插件，连 knownRow 都不给：宁可拒绝写入，也不能误停 webServer 行。
    const hasName = !!(row && typeof row.name === "string" && row.name.length > 0);
    mergeRow(row, { known: hasName });
  });
  (opts.installedEntries || []).forEach(function (row) {
    // 只有「bundle patch 里真实 insert 出来的行」才算已验证存在；
    // 单纯依赖兜底出来的包名只作为映射候选，是否真实存在由宿主 loader 佐证。
    const verified = !!row && row.source === "installed";
    mergeRow(row, { known: verified || (row && loaderById.has(row.id)), installed: true });
  });
  (opts.userRows || []).forEach(function (row) { mergeRow(row, { known: false, userRow: true }); });
  // loader 只做补全（name/disabled），绝不凭空新增候选行。
  loaderById.forEach(function (row, id) {
    if (!known.has(id)) {
      return;
    }
    mergeRow({ id, name: row.name, disabled: row.disabled }, { known: true });
  });

  const output = [];
  known.forEach(function (item) {
    const aliases = [];
    function addFinal(value) {
      if (typeof value === "string" && value && aliases.indexOf(value) === -1 && aliases.length < MAX_ALIASES) {
        aliases.push(value);
      }
    }
    addFinal(item.id);
    addFinal(item.name);
    addFinal(item.packageName);
    item.aliases.forEach(addFinal);

    let builtin = false;
    for (const alias of aliases) {
      if (alias.indexOf("@deepseek-ai/") === 0) {
        builtin = true;
        break;
      }
    }
    const self = item.id === selfId
      || item.name === selfName
      || item.packageName === selfName
      || aliases.indexOf(selfId) !== -1
      || aliases.indexOf(selfName) !== -1;
    if (builtin && !item.hasUserRow && !item.installed) {
      return;
    }
    // 候选只来自：用户行文件里真实存在的行，或已安装 bundle patch 里验证过的 insert 行。
    // 核心 seed / 覆盖行即使出现在 profile patch 里也不默认列出（只做映射）。
    if (!item.hasUserRow && !item.installed) {
      return;
    }
    const unmapped = !item.knownRow;
    let protectedReason = "";
    if (self) {
      protectedReason = "self";
    } else if (builtin) {
      protectedReason = "builtin";
    } else if (REQUIRED_ENTRY_IDS.indexOf(item.id) !== -1) {
      protectedReason = "required";
    }
    let reason = "";
    if (protectedReason === "self") {
      reason = "救援插件自身，禁止停用";
    } else if (builtin) {
      reason = "内置 @deepseek-ai 行受保护，救援插件不会修改";
    } else if (protectedReason === "required") {
      reason = "宿主骨架 entry（停掉它救援入口也会消失），不允许停用";
    } else if (unmapped) {
      reason = "未映射到真实插件行，禁止直接写入";
    }
    const actionable = writable && !protectedReason && !unmapped && !item.disabled && !rescueRows.has(item.id);
    let bundleName = "";
    const bundleCandidates = [item.id, item.name, item.packageName].concat(aliases);
    for (const candidate of bundleCandidates) {
      if (candidate && bundleList.indexOf(candidate) !== -1) {
        bundleName = candidate;
        break;
      }
    }
    const inBundles = !!bundleName;
    const bundleRemovable = inBundles && !isProtectedBundleName(bundleName) && !self && !builtin;
    const levels = ["rows"];
    if (allowPatch) {
      levels.push("patch");
    }
    if (bundleRemovable) {
      levels.push("bundles");
    }
    output.push({
      id: item.id,
      groupId: item.packageName || item.name || item.id,
      name: item.name || item.id,
      packageName: item.packageName || "",
      aliases,
      builtin,
      protected: !!protectedReason,
      protectedReason,
      installed: !!item.installed,
      hasUserRow: !!item.hasUserRow,
      disabled: !!item.disabled,
      disabledByRescue: rescueRows.has(item.id),
      actionable,
      reason,
      inBundles,
      bundleName,
      bundleRemovable,
      levels,
    });
  });

  output.sort(function (left, right) {
    if (left.actionable !== right.actionable) {
      return left.actionable ? -1 : 1;
    }
    const leftName = String(left.name || left.id).toLowerCase();
    const rightName = String(right.name || right.id).toLowerCase();
    if (leftName < rightName) {
      return -1;
    }
    if (leftName > rightName) {
      return 1;
    }
    return 0;
  });
  return output.slice(0, MAX_ENTRIES);
}

// ── 请求校验 ────────────────────────────────────────────────────────────
export function isLoopbackAddress(address) {
  const value = String(address === null || address === undefined ? "" : address).toLowerCase().split("%")[0];
  if (!value) {
    return false;
  }
  if (value === "::1" || value === "0:0:0:0:0:0:0:1") {
    return true;
  }
  // 严格 IPv4 回环字面量（127.0.0.0/8）。不能用前缀匹配 ——
  // `127.0.0.1.evil.com` 这类域名同样以 "127." 开头，会把 DNS-rebinding 放进来。
  if (/^127\.(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){2}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/.test(value)) {
    return true;
  }
  // IPv4-mapped IPv6 回环，同样要求是完整字面量（防御 `::ffff:127.evil.com` 式 Host 头）。
  if (/^::ffff:127\.(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){2}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/.test(value)) {
    return true;
  }
  if (/^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(value)) {
    return true;
  }
  return false;
}

function hostHeaderIsLoopback(value) {
  const raw = String(value === null || value === undefined ? "" : value).trim().toLowerCase();
  if (!raw) {
    return false;
  }
  let host = raw;
  if (host.charAt(0) === "[") {
    const end = host.indexOf("]");
    if (end === -1) {
      return false;
    }
    host = host.slice(1, end);
  } else {
    const colons = host.split(":");
    if (colons.length === 2) {
      host = colons[0];
    }
  }
  if (host === "localhost") {
    return true;
  }
  return isLoopbackAddress(host);
}

export function assertMutationRequest(req) {
  const remoteAddress = req && req.socket ? req.socket.remoteAddress : "";
  if (!isLoopbackAddress(remoteAddress)) {
    throw errorWithStatus(403, "remote mutation is disabled; use the DSHM Web UI on this device", "remote-mutation-disabled");
  }
  const headers = (req && req.headers) || {};
  // 防 DNS rebinding：攻击页可以把 Origin/Host 都写成自己的域名并解析到 127.0.0.1，
  // 因此写操作还要求 Host 头本身是回环字面量（127.* / [::1] / localhost）。
  if (!hostHeaderIsLoopback(headers.host)) {
    throw errorWithStatus(403, "host must be a loopback address", "non-loopback-host");
  }
  const contentType = String(headers["content-type"] === undefined ? "" : headers["content-type"]).toLowerCase();
  if (contentType.indexOf("application/json") !== 0) {
    throw errorWithStatus(415, "content-type must be application/json", "content-type");
  }
  const fetchSite = String(headers["sec-fetch-site"] === undefined ? "" : headers["sec-fetch-site"]).toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw errorWithStatus(403, "cross-origin mutation denied", "cross-origin");
  }
  const origin = headers.origin;
  if (origin) {
    let parsed = null;
    try {
      parsed = new URL(origin);
    } catch (_) {
      throw errorWithStatus(403, "invalid origin", "invalid-origin");
    }
    if (!headers.host || parsed.host !== headers.host) {
      throw errorWithStatus(403, "origin does not match host", "origin-mismatch");
    }
  }
}

export function normalizeIds(body, options) {
  const opts = options && typeof options === "object" ? options : {};
  let values = [];
  if (body && Array.isArray(body.ids)) {
    values = body.ids;
  } else if (body && typeof body.ids === "string" && body.ids.length > 0) {
    // 兼容标量形式 `{"ids":"dsh-market"}`（SPEC 5.1 数组或单值）。
    values = [body.ids];
  } else if (body && body.id !== undefined && body.id !== null && body.id !== "") {
    values = [body.id];
  }
  if (values.length === 0) {
    if (opts.allowEmpty) {
      return [];
    }
    throw errorWithStatus(400, "missing ids", "empty-ids");
  }
  if (values.length > MAX_IDS) {
    throw errorWithStatus(400, "too many ids", "too-many-ids");
  }
  const ids = [];
  for (const value of values) {
    let id = "";
    try {
      id = String(value).trim();
    } catch (_) {
      id = "";
    }
    if (!id || id.length > MAX_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(id) || /\s/.test(id)) {
      throw errorWithStatus(400, "invalid id", "invalid-id");
    }
    if (ids.indexOf(id) === -1) {
      ids.push(id);
    }
  }
  return ids;
}

async function readJsonBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw errorWithStatus(413, "request body too large", "body-too-large");
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch (_) {
    throw errorWithStatus(400, "invalid JSON body", "invalid-json");
  }
}

// ── 诊断日志 ────────────────────────────────────────────────────────────
function writeDiagnostic(runtime, message) {
  const line = "[" + new Date().toISOString() + "] [" + PACKAGE_NAME + "@" + version + "] " + message;
  try {
    console.log(line);
  } catch (_) {
    // console 不可用时忽略
  }
  try {
    const logger = runtime && runtime.ctx ? runtime.ctx.logger : undefined;
    if (logger && typeof logger.info === "function") {
      logger.info(line);
    }
  } catch (_) {
    // ignore
  }
  try {
    if (runtime && runtime.logFile) {
      appendFileSync(runtime.logFile, line + "\n", "utf8");
    }
  } catch (_) {
    // 日志文件写不进不能影响插件
  }
}

// ── 运行时 ──────────────────────────────────────────────────────────────
function createRuntime(ctx) {
  return {
    ctx,
    homeDir: "",
    homeSource: "",
    profileDir: "",
    profileSource: "",
    rowsPath: "",
    patchPath: "",
    logFile: "",
    readOnly: true,
    readOnlyReason: "",
    readOnlyReasonCode: "",
    injections: 0,
    dailyChecksLogged: false,
    autoSnapshotDone: false,
    diag: {
      homeDir: "",
      profileDir: "",
      webServer: "pending",
      loader: "pending",
      route: "pending",
      tapIndex: "pending",
      indexInject: "pending",
      rowsFile: "unknown",
      logFile: "",
    },
  };
}

function resolveRuntimePaths(runtime) {
  try {
    const home = resolveHomeDir(process.env);
    runtime.homeDir = home.dir;
    runtime.homeSource = home.source;
    writeDiagnostic(runtime, "启动：版本 " + version + "（宿主插件，" + PACKAGE_NAME + "）");
    if (!home.dir) {
      runtime.readOnly = true;
      runtime.readOnlyReason = "未找到可用的 DSH_HOME / DSHM_HOME 数据目录，救援写入已禁用（只读）。";
      runtime.readOnlyReasonCode = "home-unresolved";
      writeDiagnostic(runtime, "数据目录：未设置 DSH_HOME / DSHM_HOME → 只读降级");
      return;
    }
    runtime.diag.homeDir = home.source;
    runtime.logFile = join(home.dir, LOG_FILENAME);
    runtime.diag.logFile = runtime.logFile;
    writeDiagnostic(runtime, "数据目录：由 " + home.source + " 定位 = " + home.dir);

    const profile = resolveProfileDir(home.dir, dirname(fileURLToPath(import.meta.url)));
    runtime.profileDir = profile.dir;
    runtime.profileSource = profile.source;
    if (!profile.dir) {
      runtime.readOnly = true;
      runtime.readOnlyReason = "无法安全定位声明了 dsh.profile 的 DSHM profile 目录，救援写入已禁用（只读）。";
      runtime.readOnlyReasonCode = "profile-unresolved";
      writeDiagnostic(runtime, "profile：未定位到声明 dsh.profile 的目录 → 只读降级");
      return;
    }
    runtime.diag.profileDir = profile.source;
    runtime.rowsPath = join(profile.dir, ROWS_FILENAME);
    runtime.patchPath = join(profile.dir, "cordis.patch.yml");
    runtime.readOnly = false;
    writeDiagnostic(runtime, "profile：" + profile.dir + "（来源：" + profile.source + "）");
    writeDiagnostic(runtime, "用户行文件：" + runtime.rowsPath + "（" + (existsSync(runtime.rowsPath) ? "存在" : "尚未创建") + "）");
    writeDiagnostic(runtime, "诊断日志：" + runtime.logFile);
  } catch (error) {
    runtime.readOnly = true;
    runtime.readOnlyReason = "救援插件定位数据目录时出错，已降级为只读：" + errText(error);
    runtime.readOnlyReasonCode = "path-error";
    writeDiagnostic(runtime, "路径定位异常：" + errText(error));
  }
}

// ── state / 目标解析 ────────────────────────────────────────────────────
function emptyState(runtime) {
  return {
    ok: true,
    version,
    generatedAt: new Date().toISOString(),
    mode: "readonly",
    writable: false,
    readOnlyReason: "",
    readOnlyReasonCode: "",
    warning: "",
    rowsPath: runtime.rowsPath || "",
    profileDir: runtime.profileDir || "",
    homeDir: runtime.homeDir || "",
    entries: [],
    rescueRows: [],
    counts: { entries: 0, actionable: 0, rescue: 0 },
    diagnostics: Object.assign({}, runtime.diag),
    checks: [],
    features: { ledger: true, snapshot: true, quarantine: true, bundles: true, dualInject: true },
    inject: { tapIndex: "pending", indexInject: "pending", channels: 0 },
    ledger: emptyLedgerState(""),
    bundles: { path: "", ok: false, error: "", count: 0, removable: [], protected: [] },
    quarantine: { bootFailed: false, bootFailedAt: "", files: [], profileDeps: { dependencies: [], peerDependencies: [] } },
    snapshot: { dir: "", ok: false, error: "", count: 0, keep: 5, latest: null },
    loader: { ok: false, reason: "", pending: [], failed: [], counts: { active: 0, pending: 0, failed: 0 } },
    notice: "",
  };
}

async function resolveTarget(runtime) {
  const target = { mode: "readonly", reason: "", code: "", warning: "", rowsPath: runtime.rowsPath || "", patchPath: runtime.patchPath || "", rowsFile: null, patchText: "" };
  if (runtime.readOnly || !runtime.profileDir) {
    target.reason = runtime.readOnlyReason || "救援服务处于只读模式。";
    target.code = runtime.readOnlyReasonCode || "read-only";
    return target;
  }
  const rowsFile = await readRowsFile(runtime.rowsPath);
  target.rowsFile = rowsFile;
  runtime.diag.rowsFile = rowsFile.state;
  if (rowsFile.state === "unreadable") {
    target.reason = "用户行文件无法读取（" + String(rowsFile.error || "unknown") + "），已进入只读模式。";
    target.code = "rows-unreadable";
    return target;
  }
  if (rowsFile.state === "found" && !rowsFile.parse.ok) {
    // 用户行文件结构解析失败 → 降级写 cordis.patch.yml（本次停用重启后失效）
    let patchText = "";
    try {
      patchText = await readFile(runtime.patchPath, "utf8");
    } catch (error) {
      if (!(error && error.code === "ENOENT")) {
        target.reason = "用户行文件结构解析失败，且 cordis.patch.yml 无法读取，已进入只读模式。";
        target.code = "patch-unreadable";
        return target;
      }
      patchText = "";
    }
    const appendable = checkPatchAppendable(patchText);
    if (!appendable.ok) {
      target.reason = "用户行文件结构解析失败，且 cordis.patch.yml 无法安全追加（" + appendable.reason + "），已进入只读模式。";
      target.code = "patch-unappendable";
      return target;
    }
    target.mode = "patch-fallback";
    target.warning = FALLBACK_WARNING;
    target.patchText = patchText;
    return target;
  }
  target.mode = "rows";
  return target;
}

async function buildState(runtime) {
  const state = emptyState(runtime);
  let target = null;
  try {
    target = await resolveTarget(runtime);
  } catch (error) {
    state.readOnlyReason = "读取救援状态失败：" + errText(error);
    state.readOnlyReasonCode = "state-error";
    await attachChecks(runtime, state, null);
    return state;
  }
  state.mode = target.mode;
  state.writable = target.mode !== "readonly";
  state.readOnlyReason = target.reason;
  state.readOnlyReasonCode = target.code;
  state.warning = target.warning;
  if (target.rowsPath) {
    state.rowsPath = target.rowsPath;
  }
  state.diagnostics = Object.assign({}, runtime.diag);
  if (target.mode === "readonly") {
    await attachChecks(runtime, state, target);
    return state;
  }

  const rows = target.mode === "rows" && target.rowsFile && target.rowsFile.parse && target.rowsFile.parse.ok
    ? target.rowsFile.parse.rows
    : [];
  const patchInfo = await readPatchInfo(runtime.profileDir);
  const installed = await readInstalledPluginEntries(runtime.profileDir);
  const manifest = readProfileManifest(runtime);
  const bundleList = manifest.ok ? bundlesOfManifest(manifest.json) : [];
  const loader = readLoaderEntries(runtime.ctx);
  runtime.diag.loader = loader.ok ? "ok" : "unavailable";
  state.diagnostics = Object.assign({}, runtime.diag);

  const markerPrefix = target.mode === "patch-fallback" ? PATCH_MARKER_PREFIX : ROW_MARKER_PREFIX;
  const markerText = target.mode === "patch-fallback" ? target.patchText : (target.rowsFile ? target.rowsFile.text : "");
  const rescueRows = collectMarkers(textFormat(markerText).body, markerPrefix);
  const entries = buildCatalog({
    userRows: rows,
    patchEntries: patchInfo.rows,
    installedEntries: installed,
    loaderEntries: loader.entries,
    rescueRows,
    selfId: SELF_ENTRY_ID,
    selfName: PACKAGE_NAME,
    writable: true,
    bundles: bundleList,
    allowPatch: target.mode === "patch-fallback",
  });
  state.entries = entries;
  state.rescueRows = rescueRows;
  state.counts = {
    entries: entries.length,
    actionable: entries.filter(function (entry) { return entry.actionable; }).length,
    rescue: rescueRows.length,
  };
  fillEnhanceState(runtime, state, entries);
  await attachChecks(runtime, state, target);
  return state;
}

// 1.2.0：把台账 / bundles / 隔离残留 / 快照 / 注入通道打包进 state。
function fillEnhanceState(runtime, state, entries) {
  try {
    state.features = { ledger: true, snapshot: true, quarantine: true, bundles: true, dualInject: true };
    state.inject = {
      tapIndex: runtime.diag.tapIndex || "pending",
      indexInject: runtime.diag.indexInject || "pending",
      channels: injectChannelCount(runtime.diag),
    };
    const ledger = readLedger(runtime);
    state.ledger = {
      path: ledger.path,
      ok: ledger.ok,
      error: ledger.error,
      entries: ledger.entries.slice(0, 50).map(function (item) {
        return { id: item.id, at: item.at, mode: item.mode, level: item.level, index: item.index };
      }),
    };
    state.bundles = describeBundles(runtime, entries);
    state.quarantine = scanQuarantine(runtime);
    const loaderDetails = readLoaderDetails(runtime.ctx);
    state.loader = {
      ok: loaderDetails.ok,
      reason: loaderDetails.reason,
      pending: loaderDetails.pending.slice(0, 64),
      failed: loaderDetails.failed.slice(0, 64),
      counts: {
        active: loaderDetails.active,
        pending: loaderDetails.pending.length,
        failed: loaderDetails.failed.length,
      },
    };
    const mergeableFiles = (state.quarantine.files || []).filter(function (item) { return item && item.mergeable; });
    state.notice = state.quarantine.bootFailed || mergeableFiles.length
      ? "检测到 DSHM 启动自愈留下的隔离文件（" + mergeableFiles.length + " 个可合并），"
        + "直接写入用户行可能在下次启动时再次被隔离；建议先合并恢复，或改从 bundles 停用。"
      : "";
    const snapshots = listSnapshots(runtime);
    const latest = snapshots.items[0] || null;
    state.snapshot = {
      dir: snapshots.dir,
      ok: snapshots.ok,
      error: snapshots.error,
      count: snapshots.items.length,
      keep: SNAPSHOT_KEEP,
      latest: latest ? {
        id: latest.id,
        at: latest.at,
        reason: latest.reason,
        rowsBytes: latest.rowsBytes,
        bundlesCount: latest.bundlesCount,
      } : null,
    };
  } catch (error) {
    state.enhanceError = errText(error);
  }
}

// ── 1.2.0：台账 / bundles 三级停用 / 启动失败残留 / 快照 / 双通道注入 ──
// 共同原则：只碰 $DSH_HOME、写前备份、任何异常只降级不抛给宿主启动链。

// —— 摘要与指纹 ——
function digestText(text) {
  try {
    return "sha256:" + createHash("sha256").update(String(text === null || text === undefined ? "" : text), "utf8").digest("hex");
  } catch (_) {
    return "";
  }
}

// 块指纹不含标记注释：DSHM 插件页抹掉注释后仍然能匹配（B）。
export function normalizeDisabledValue(value) {
  const raw = String(value === null || value === undefined ? "" : value).trim().toLowerCase();
  if (raw === "true" || raw === "yes" || raw === "1") {
    return "true";
  }
  if (raw === "false" || raw === "no" || raw === "0") {
    return "false";
  }
  return raw;
}

export function blockDigestOf(id, disabledValue) {
  return digestText(String(id === null || id === undefined ? "" : id) + "\u0000" + normalizeDisabledValue(disabledValue));
}

function statSafe(filename) {
  try {
    const info = statSync(filename);
    return { exists: true, size: info.size, mtime: new Date(info.mtimeMs).toISOString() };
  } catch (_) {
    return { exists: false, size: 0, mtime: "" };
  }
}

async function writeJsonAtomic(filename, value) {
  const temporary = join(dirname(filename), "." + basename(filename) + ".tmp-" + String(process.pid) + "-" + randomUUID());
  const text = JSON.stringify(value, null, 2) + "\n";
  await writeFile(temporary, text, { encoding: "utf8", flag: "wx" });
  try {
    await rename(temporary, filename);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch (_) {
      // ignore
    }
    throw error;
  }
}

// ── B 救援台账（$DSH_HOME/dshm-boot-rescue-ledger.json）─────────────────
function ledgerPathOf(runtime) {
  return runtime && runtime.homeDir ? join(runtime.homeDir, LEDGER_FILENAME) : "";
}

export function emptyLedgerState(path) {
  return { path: path || "", ok: false, error: "", entries: [] };
}

export function readLedger(runtime) {
  const path = ledgerPathOf(runtime);
  const result = emptyLedgerState(path);
  if (!path) {
    result.error = "数据目录未定位";
    return result;
  }
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      result.ok = true;
      return result;
    }
    result.error = "读取台账失败（已降级为只用注释标记恢复）：" + errText(error);
    return result;
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
      throw new Error("台账结构不合法");
    }
    const entries = [];
    for (const raw of parsed.entries) {
      if (!raw || typeof raw !== "object") {
        continue;
      }
      const id = typeof raw.id === "string" ? raw.id : "";
      if (!id) {
        continue;
      }
      const level = typeof raw.level === "string" && raw.level ? raw.level : (typeof raw.mode === "string" && raw.mode ? raw.mode : "rows");
      const safeLevel = level === "bundles" || level === "patch" ? level : "rows";
      entries.push({
        id,
        at: typeof raw.at === "string" ? raw.at : "",
        level: safeLevel,
        mode: safeLevel,
        file: typeof raw.file === "string" ? raw.file : "",
        blockDigest: typeof raw.blockDigest === "string" ? raw.blockDigest : "",
        fileDigestAfter: typeof raw.fileDigestAfter === "string" ? raw.fileDigestAfter : "",
        index: typeof raw.index === "number" ? raw.index : -1,
      });
    }
    entries.sort(function (left, right) { return String(right.at).localeCompare(String(left.at)); });
    result.ok = true;
    result.entries = entries.slice(0, LEDGER_MAX);
    return result;
  } catch (error) {
    result.error = "台账内容损坏（已降级为只用注释标记恢复）：" + errText(error);
    return result;
  }
}

async function writeLedger(runtime, entries) {
  const path = ledgerPathOf(runtime);
  if (!path) {
    throw errorWithStatus(503, "数据目录未定位，无法写台账", "home-unresolved");
  }
  await writeJsonAtomic(path, { version: LEDGER_VERSION, entries: (entries || []).slice(0, LEDGER_MAX) });
}

async function upsertLedgerEntry(runtime, entry) {
  if (!runtime || !runtime.homeDir || !entry || !entry.id) {
    return false;
  }
  try {
    const ledger = readLedger(runtime);
    const base = ledger.ok ? ledger.entries.slice() : [];
    const level = entry.level === "bundles" || entry.level === "patch" ? entry.level : "rows";
    const next = base.filter(function (item) { return !(item.id === entry.id && item.level === level); });
    next.unshift({
      id: String(entry.id),
      at: entry.at || new Date().toISOString(),
      level,
      mode: level,
      file: entry.file || "",
      blockDigest: entry.blockDigest || "",
      fileDigestAfter: entry.fileDigestAfter || "",
      index: typeof entry.index === "number" ? entry.index : -1,
    });
    await writeLedger(runtime, next);
    return true;
  } catch (error) {
    writeDiagnostic(runtime, "台账写入失败（不影响本次停用）：" + errText(error));
    return false;
  }
}

async function removeLedgerEntries(runtime, ids, level) {
  if (!runtime || !runtime.homeDir) {
    return;
  }
  try {
    const wanted = new Set((ids || []).map(String));
    const ledger = readLedger(runtime);
    if (!ledger.ok) {
      return;
    }
    const next = ledger.entries.filter(function (item) {
      if (level && item.level !== level) {
        return true;
      }
      return !wanted.has(item.id);
    });
    if (next.length === ledger.entries.length) {
      return;
    }
    await writeLedger(runtime, next);
  } catch (error) {
    writeDiagnostic(runtime, "台账清理失败（不影响恢复结果）：" + errText(error));
  }
}

// 注释标记被抹掉之后，按台账指纹删除「本插件写过」的 disabled 行块。
export function removeRowsByLedger(text, targets) {
  const source = String(text === null || text === undefined ? "" : text);
  const wanted = new Map();
  for (const target of targets || []) {
    if (target && typeof target.id === "string" && target.blockDigest) {
      wanted.set(target.id, target.blockDigest);
    }
  }
  if (!wanted.size) {
    return { text: source, result: { restored: [], skipped: [] } };
  }
  const format = textFormat(source);
  const lines = format.body.split("\n");
  const output = [];
  const restored = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const idMatch = /^-\s+id:\s*(.*?)\s*$/.exec(line);
    if (!idMatch) {
      output.push(line);
      index += 1;
      continue;
    }
    const id = parseYamlScalar(idMatch[1]);
    const wantedDigest = typeof id === "string" ? wanted.get(id) : undefined;
    if (wantedDigest === undefined) {
      output.push(line);
      index += 1;
      continue;
    }
    let end = index + 1;
    let disabledValue = "";
    let hasDisabled = false;
    while (end < lines.length) {
      const next = lines[end];
      if (/^-\s+id:/.test(next)) {
        break;
      }
      const disabledMatch = /^\s+disabled:\s*(.*?)\s*$/.exec(next);
      if (disabledMatch) {
        disabledValue = parseYamlScalar(disabledMatch[1]);
        hasDisabled = true;
        end += 1;
        continue;
      }
      if (/^\s+\S/.test(next)) {
        end += 1;
        continue;
      }
      break;
    }
    const forbidden = String(id).indexOf(BUNDLE_PROTECT_PREFIX) === 0 || id === SELF_ENTRY_ID || id === PACKAGE_NAME;
    const matched = !forbidden
      && hasDisabled
      && normalizeDisabledValue(disabledValue) === "true"
      && blockDigestOf(id, disabledValue) === wantedDigest;
    if (matched) {
      const previous = output.length > 0 ? output[output.length - 1] : "";
      if (previous.indexOf(ROW_MARKER_PREFIX) === 0 && previous.slice(ROW_MARKER_PREFIX.length).trim() === id) {
        output.pop();
      }
      restored.push(id);
      index = end;
      continue;
    }
    output.push(line);
    index += 1;
  }
  if (!restored.length) {
    return { text: source, result: { restored: [], skipped: [] } };
  }
  return { text: encodeText(output.join("\n"), format), result: { restored, skipped: [] } };
}

// ── D profile package.json 的 dsh.profile.bundles ───────────────────────
function profileManifestPath(runtime) {
  return runtime && runtime.profileDir ? join(runtime.profileDir, "package.json") : "";
}

export function readProfileManifest(runtime) {
  const path = profileManifestPath(runtime);
  const result = { path, ok: false, error: "", text: "", json: null };
  if (!path) {
    result.error = "profile 目录未定位";
    return result;
  }
  try {
    result.text = readFileSync(path, "utf8");
    const parsed = JSON.parse(result.text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("不是 JSON 对象");
    }
    result.json = parsed;
    result.ok = true;
  } catch (error) {
    result.error = "读取 profile package.json 失败：" + errText(error);
  }
  return result;
}

export function bundlesOfManifest(manifest) {
  try {
    const list = manifest && manifest.dsh && manifest.dsh.profile ? manifest.dsh.profile.bundles : null;
    if (!Array.isArray(list)) {
      return [];
    }
    const output = [];
    for (const item of list) {
      if (typeof item === "string" && item && output.indexOf(item) === -1) {
        output.push(item);
      }
    }
    return output;
  } catch (_) {
    return [];
  }
}

export function isProtectedBundleName(name) {
  const value = String(name === null || name === undefined ? "" : name);
  if (!value) {
    return true;
  }
  if (value === PACKAGE_NAME || value === SELF_ENTRY_ID) {
    return true;
  }
  return value.indexOf(BUNDLE_PROTECT_PREFIX) === 0;
}

export function describeBundles(runtime, entries) {
  const path = profileManifestPath(runtime);
  const result = { path, ok: false, error: "", count: 0, removable: [], protected: [] };
  const manifest = readProfileManifest(runtime);
  if (!manifest.ok) {
    result.error = manifest.error;
    return result;
  }
  const list = bundlesOfManifest(manifest.json);
  result.ok = true;
  result.count = list.length;
  const removable = [];
  const protectedNames = [];
  for (const name of list) {
    if (isProtectedBundleName(name)) {
      protectedNames.push(name);
      continue;
    }
    const mapped = [];
    for (const entry of entries || []) {
      if (entry && entry.bundleName === name && mapped.indexOf(entry.id) === -1) {
        mapped.push(entry.id);
      }
    }
    removable.push({ name, entries: mapped });
  }
  result.removable = removable;
  result.protected = protectedNames;
  return result;
}

export function planBundleRemoval(runtime, names) {
  const manifest = readProfileManifest(runtime);
  if (!manifest.ok) {
    throw errorWithStatus(503, manifest.error, "bundles-unreadable");
  }
  const list = bundlesOfManifest(manifest.json);
  const removals = [];
  const already = [];
  for (const rawName of names || []) {
    const name = String(rawName === null || rawName === undefined ? "" : rawName);
    if (!name) {
      continue;
    }
    if (isProtectedBundleName(name)) {
      throw errorWithStatus(409, "受保护的 bundle，救援不会移除：" + name, "bundle-protected");
    }
    const index = list.indexOf(name);
    if (index === -1) {
      if (already.indexOf(name) === -1) {
        already.push(name);
      }
      continue;
    }
    if (!removals.some(function (item) { return item.name === name; })) {
      removals.push({ name, index });
    }
  }
  const nextList = list.filter(function (name) {
    return !removals.some(function (item) { return item.name === name; });
  });
  if (!nextList.length) {
    throw errorWithStatus(409, "拒绝清空 bundles（至少保留核心 bundle）", "bundle-protected");
  }
  for (const required of CORE_BUNDLES_REQUIRED) {
    if (nextList.indexOf(required) === -1) {
      throw errorWithStatus(409, "核心 bundle 不可移除：" + required, "bundle-protected");
    }
  }
  return { manifest, list, removals, already, nextList };
}

async function writeProfileBundles(runtime, nextList) {
  const path = profileManifestPath(runtime);
  const before = readProfileManifest(runtime);
  if (!before.ok) {
    throw errorWithStatus(503, before.error, "bundles-unreadable");
  }
  const json = before.json;
  if (!json.dsh || typeof json.dsh !== "object") {
    json.dsh = {};
  }
  if (!json.dsh.profile || typeof json.dsh.profile !== "object") {
    json.dsh.profile = {};
  }
  json.dsh.profile.bundles = nextList.slice();
  const text = JSON.stringify(json, null, 2) + "\n";
  try {
    await copyFile(path, path + BACKUP_SUFFIX);
  } catch (error) {
    throw errorWithStatus(500, "写前备份失败，已拒绝写入：" + errText(error), "backup-failed");
  }
  const temporary = path + ".dshm-boot-rescue-" + String(process.pid) + "-" + randomUUID() + ".tmp";
  await writeFile(temporary, text, { encoding: "utf8", flag: "wx" });
  const after = readProfileManifest(runtime);
  if (!after.ok || after.text !== before.text) {
    try {
      await unlink(temporary);
    } catch (_) {
      // ignore
    }
    throw errorWithStatus(409, "profile package.json 在写入过程中被修改，请重试", "file-busy");
  }
  await rename(temporary, path);
  return { text };
}

async function removeBundles(runtime, names) {
  const plan = planBundleRemoval(runtime, names);
  if (!plan.removals.length) {
    return { removed: [], already: plan.already };
  }
  await writeProfileBundles(runtime, plan.nextList);
  for (const removal of plan.removals) {
    await upsertLedgerEntry(runtime, {
      id: removal.name,
      level: "bundles",
      file: profileManifestPath(runtime),
      index: removal.index,
      blockDigest: "",
      fileDigestAfter: "",
    });
  }
  writeDiagnostic(runtime, "bundle 停用：removed=" + JSON.stringify(plan.removals.map(function (item) { return item.name; })) + " already=" + JSON.stringify(plan.already));
  return { removed: plan.removals.map(function (item) { return item.name; }), already: plan.already };
}

async function restoreBundles(runtime, names) {
  const ledger = readLedger(runtime);
  if (!ledger.ok) {
    throw errorWithStatus(503, "台账不可用，无法按记录恢复 bundle：" + ledger.error, "read-only");
  }
  const explicit = (names || []).map(String).filter(function (name) { return !!name; });
  const wanted = explicit.length
    ? explicit
    : ledger.entries.filter(function (item) { return item.level === "bundles"; }).map(function (item) { return item.id; });
  const manifest = readProfileManifest(runtime);
  if (!manifest.ok) {
    throw errorWithStatus(503, manifest.error, "bundles-unreadable");
  }
  const list = bundlesOfManifest(manifest.json);
  const restores = [];
  const skipped = [];
  for (const name of wanted) {
    const record = ledger.entries.filter(function (item) { return item.level === "bundles" && item.id === name; })[0];
    if (!record) {
      skipped.push({ id: name, reason: "not-in-ledger" });
      continue;
    }
    if (isProtectedBundleName(name)) {
      skipped.push({ id: name, reason: "protected" });
      continue;
    }
    if (list.indexOf(name) !== -1) {
      skipped.push({ id: name, reason: "already-present" });
      continue;
    }
    restores.push(record);
  }
  if (!restores.length) {
    return { restored: [], skipped };
  }
  const nextList = list.slice();
  restores.sort(function (left, right) { return left.index - right.index; });
  for (const record of restores) {
    const at = typeof record.index === "number" && record.index >= 0 && record.index <= nextList.length
      ? record.index
      : nextList.length;
    nextList.splice(at, 0, record.id);
  }
  await writeProfileBundles(runtime, nextList);
  await removeLedgerEntries(runtime, restores.map(function (item) { return item.id; }), "bundles");
  writeDiagnostic(runtime, "bundle 恢复：restored=" + JSON.stringify(restores.map(function (item) { return item.id; })));
  return { restored: restores.map(function (item) { return item.id; }), skipped };
}

// ── E 启动失败残留（.dshm-boot-failed / *.quarantine-*）─────────────────
export function parseQuarantineBlocks(text) {
  const format = textFormat(text);
  const lines = format.body.split("\n");
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const idMatch = /^-\s+id:\s*(.*?)\s*$/.exec(line);
    if (!idMatch) {
      index += 1;
      continue;
    }
    const id = parseYamlScalar(idMatch[1]);
    if (!isValidRowId(id)) {
      index += 1;
      continue;
    }
    let end = index + 1;
    let disabled = false;
    while (end < lines.length) {
      const next = lines[end];
      if (/^-\s+id:/.test(next)) {
        break;
      }
      const disabledMatch = /^\s+disabled:\s*(.*?)\s*$/.exec(next);
      if (disabledMatch) {
        disabled = normalizeDisabledValue(parseYamlScalar(disabledMatch[1])) === "true";
        end += 1;
        continue;
      }
      if (/^\s+\S/.test(next)) {
        end += 1;
        continue;
      }
      break;
    }
    let start = index;
    if (index > 0 && lines[index - 1].indexOf(ROW_MARKER_PREFIX) === 0
      && lines[index - 1].slice(ROW_MARKER_PREFIX.length).trim() === id) {
      start = index - 1;
    }
    blocks.push({ id, disabled, start, end, hasMarker: start !== index, lines: lines.slice(start, end) });
    index = end;
  }
  return { ok: true, blocks, format };
}

export function mergeQuarantineRows(currentText, quarantineText) {
  const current = parseUserRows(currentText);
  if (!current.ok) {
    return {
      ok: false,
      reason: "当前用户行文件结构无法安全解析：" + current.issue,
      text: String(currentText === null || currentText === undefined ? "" : currentText),
      merged: [],
      skipped: [],
    };
  }
  const parsed = parseQuarantineBlocks(quarantineText);
  const existing = new Set(current.rows.map(function (row) { return row.id; }));
  const merged = [];
  const skipped = [];
  const append = [];
  for (const block of parsed.blocks) {
    if (existing.has(block.id)) {
      skipped.push({ id: block.id, reason: "already-exists" });
      continue;
    }
    if (isProtectedBundleName(block.id)) {
      skipped.push({ id: block.id, reason: "protected" });
      continue;
    }
    append.push(block.lines.join("\n"));
    merged.push(block.id);
  }
  if (!merged.length) {
    return { ok: true, text: String(currentText === null || currentText === undefined ? "" : currentText), merged, skipped };
  }
  const source = String(currentText === null || currentText === undefined ? "" : currentText);
  const format = textFormat(source);
  let body = format.body;
  if (body.length > 0 && !body.endsWith("\n")) {
    body += "\n";
  }
  body += append.join("\n") + "\n";
  return { ok: true, text: encodeText(body, format), merged, skipped };
}

export function scanQuarantine(runtime) {
  const result = {
    bootFailed: false,
    bootFailedAt: "",
    files: [],
    profileDeps: { dependencies: [], peerDependencies: [] },
  };
  try {
    if (runtime && runtime.homeDir) {
      const info = statSafe(join(runtime.homeDir, BOOT_FAILED_FILENAME));
      if (info.exists) {
        result.bootFailed = true;
        result.bootFailedAt = info.mtime;
      }
    }
  } catch (_) {
    // ignore
  }
  try {
    if (runtime && runtime.profileDir && existsSync(runtime.profileDir)) {
      const names = readdirSync(runtime.profileDir);
      for (const name of names) {
        if (!QUARANTINE_PATTERN.test(name)) {
          continue;
        }
        const path = join(runtime.profileDir, name);
        const info = statSafe(path);
        if (!info.exists) {
          continue;
        }
        let rows = 0;
        let rescueBlocks = 0;
        let mergeable = false;
        let reason = "";
        try {
          const parsed = parseQuarantineBlocks(readFileSync(path, "utf8"));
          rows = parsed.blocks.length;
          rescueBlocks = parsed.blocks.filter(function (block) { return block.hasMarker; }).length;
          mergeable = rows > 0;
          reason = mergeable ? "" : "没有可合并的 - id 行";
        } catch (error) {
          reason = "解析失败：" + errText(error);
        }
        result.files.push({ name, path, at: info.mtime, bytes: info.size, rows, rescueBlocks, mergeable, reason });
      }
    }
  } catch (_) {
    // ignore
  }
  try {
    const manifest = readProfileManifest(runtime);
    if (manifest.ok && manifest.json) {
      const deps = manifest.json.dependencies && typeof manifest.json.dependencies === "object" ? manifest.json.dependencies : {};
      const peer = manifest.json.peerDependencies && typeof manifest.json.peerDependencies === "object" ? manifest.json.peerDependencies : {};
      result.profileDeps.dependencies = Object.keys(deps);
      result.profileDeps.peerDependencies = Object.keys(peer);
    }
  } catch (_) {
    // ignore
  }
  result.files.sort(function (left, right) { return String(right.at).localeCompare(String(left.at)); });
  return result;
}

// ── F 良好快照 ───────────────────────────────────────────────────────────
function snapshotRootOf(runtime) {
  return runtime && runtime.homeDir ? join(runtime.homeDir, SNAPSHOT_DIRNAME) : "";
}

export function listSnapshots(runtime) {
  const root = snapshotRootOf(runtime);
  const result = { dir: root, ok: false, error: "", items: [] };
  if (!root) {
    result.error = "数据目录未定位";
    return result;
  }
  try {
    if (!existsSync(root)) {
      result.ok = true;
      return result;
    }
    const names = readdirSync(root);
    for (const name of names) {
      if (!/^\d{8}-\d{6}-[a-z0-9-]+$/.test(name)) {
        continue;
      }
      const dir = join(root, name);
      let meta = null;
      try {
        meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
      } catch (_) {
        meta = null;
      }
      if (!meta || typeof meta !== "object") {
        continue;
      }
      result.items.push({
        id: name,
        dir,
        at: typeof meta.at === "string" ? meta.at : "",
        reason: typeof meta.reason === "string" ? meta.reason : "",
        rowsBytes: typeof meta.rowsBytes === "number" ? meta.rowsBytes : 0,
        bundlesCount: Array.isArray(meta.bundles) ? meta.bundles.length : 0,
      });
    }
    result.items.sort(function (left, right) { return String(right.id).localeCompare(String(left.id)); });
    result.ok = true;
  } catch (error) {
    result.error = "读取快照目录失败：" + errText(error);
  }
  return result;
}

export function snapshotIdNow(reason) {
  const now = new Date();
  const pad = function (value) { return value < 10 ? "0" + String(value) : String(value); };
  const stamp = String(now.getFullYear()) + pad(now.getMonth() + 1) + pad(now.getDate())
    + "-" + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
  const safe = String(reason || "manual").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 16) || "manual";
  return stamp + "-" + safe;
}

async function pruneSnapshots(runtime, keep) {
  try {
    const list = listSnapshots(runtime);
    if (!list.ok) {
      return;
    }
    const limit = typeof keep === "number" && keep > 0 ? keep : SNAPSHOT_KEEP;
    for (let index = limit; index < list.items.length; index++) {
      try {
        await rm(list.items[index].dir, { recursive: true, force: true });
      } catch (_) {
        // ignore
      }
    }
  } catch (_) {
    // ignore
  }
}

async function createSnapshot(runtime, reason) {
  if (!runtime || !runtime.homeDir || !runtime.profileDir) {
    throw errorWithStatus(503, "数据目录或 profile 未定位，无法创建快照", "snapshot-unavailable");
  }
  const root = snapshotRootOf(runtime);
  const id = snapshotIdNow(reason);
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  let rowsText = "";
  let rowsExists = false;
  try {
    rowsText = await readFile(runtime.rowsPath, "utf8");
    rowsExists = true;
  } catch (error) {
    if (!(error && error.code === "ENOENT")) {
      throw error;
    }
  }
  const manifest = readProfileManifest(runtime);
  const manifestText = manifest.ok ? manifest.text : "";
  const bundles = manifest.ok ? bundlesOfManifest(manifest.json) : [];
  const meta = {
    id,
    at: new Date().toISOString(),
    reason: String(reason || "manual"),
    version,
    homeDir: runtime.homeDir,
    profileDir: runtime.profileDir,
    rowsPath: runtime.rowsPath,
    rowsExists,
    rowsBytes: Buffer.byteLength(rowsText, "utf8"),
    bundles,
  };
  await writeFile(join(dir, "rows.yml"), rowsText, { encoding: "utf8", flag: "w" });
  await writeFile(join(dir, "profile-package.json"), manifestText, { encoding: "utf8", flag: "w" });
  await writeFile(join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n", { encoding: "utf8", flag: "w" });
  await pruneSnapshots(runtime, SNAPSHOT_KEEP);
  writeDiagnostic(runtime, "快照：已创建 " + id + "（reason=" + meta.reason + "，rows=" + meta.rowsBytes + "B，bundles=" + bundles.length + "）");
  return { id, at: meta.at, dir, rowsBytes: meta.rowsBytes, bundlesCount: bundles.length };
}

async function restoreSnapshotById(runtime, id) {
  const list = listSnapshots(runtime);
  if (!list.ok) {
    throw errorWithStatus(503, list.error, "snapshot-not-found");
  }
  const target = id
    ? list.items.filter(function (item) { return item.id === id; })[0]
    : list.items[0];
  if (!target) {
    throw errorWithStatus(404, id ? "找不到快照：" + id : "还没有可用快照", "snapshot-not-found");
  }
  let rowsRestored = false;
  let rowsBytes = 0;
  try {
    const rowsText = await readFile(join(target.dir, "rows.yml"), "utf8");
    await mutateTextFile(runtime.rowsPath, function () {
      return { text: rowsText, result: { ok: true } };
    });
    rowsRestored = true;
    rowsBytes = Buffer.byteLength(rowsText, "utf8");
  } catch (error) {
    if (!(error && error.code === "ENOENT")) {
      throw error;
    }
  }
  let bundlesRestored = 0;
  try {
    const manifestText = await readFile(join(target.dir, "profile-package.json"), "utf8");
    const snapshotManifest = JSON.parse(manifestText);
    const snapshotBundles = bundlesOfManifest(snapshotManifest);
    if (snapshotBundles.length) {
      const current = readProfileManifest(runtime);
      if (current.ok) {
        const currentBundles = bundlesOfManifest(current.json);
        const missing = snapshotBundles.filter(function (name) { return currentBundles.indexOf(name) === -1; });
        if (missing.length) {
          await writeProfileBundles(runtime, currentBundles.concat(missing));
          bundlesRestored = missing.length;
        }
      }
    }
  } catch (_) {
    // ignore
  }
  const summary = { restoredFrom: { id: target.id, at: target.at, reason: target.reason }, rowsRestored, rowsBytes, bundlesRestored };
  writeDiagnostic(runtime, "回滚：from=" + target.id + " rows=" + (rowsRestored ? rowsBytes + "B" : "未恢复") + " bundles+=" + bundlesRestored);
  return summary;
}

// ── G 宿主 loader 真实状态（替代从失败文案猜）──────────────────────────
export function fiberStateName(value) {
  const key = Number(value);
  try {
    if (Object.prototype.hasOwnProperty.call(FIBER_STATE_NAMES, key)) {
      return FIBER_STATE_NAMES[key];
    }
  } catch (_) {
    // ignore
  }
  return "unknown";
}

export function readLoaderDetails(ctx) {
  const result = { ok: false, reason: "", entries: [], pending: [], failed: [], active: 0 };
  try {
    const loader = ctx && typeof ctx.get === "function" ? ctx.get("loader") : undefined;
    if (!loader || typeof loader.entries !== "function") {
      result.reason = "unavailable";
      return result;
    }
    const output = [];
    for (const entry of loader.entries()) {
      const options = entry && entry.options ? entry.options : {};
      const id = typeof options.id === "string" ? options.id : "";
      if (!id) {
        continue;
      }
      const fiber = entry && entry.fiber ? entry.fiber : null;
      const stateName = fiber && typeof fiber.state === "number" ? fiberStateName(fiber.state) : "unknown";
      const missing = [];
      try {
        const fiberCtx = fiber && fiber.ctx ? fiber.ctx : null;
        const inject = fiberCtx && fiberCtx.inject && typeof fiberCtx.inject === "object" ? fiberCtx.inject : null;
        if (inject) {
          for (const service of Object.keys(inject)) {
            let got;
            try {
              got = typeof fiberCtx.get === "function" ? fiberCtx.get(service) : undefined;
            } catch (_) {
              got = undefined;
            }
            if (got === undefined) {
              missing.push(service);
            }
          }
        }
      } catch (_) {
        // 读 missing 失败不影响状态本身
      }
      output.push({
        id,
        name: typeof options.name === "string" ? options.name : "",
        state: stateName,
        missing,
      });
    }
    result.ok = true;
    result.entries = output.slice(0, MAX_ENTRIES);
    result.pending = output.filter(function (item) { return item.state === "pending"; })
      .map(function (item) { return { id: item.id, name: item.name, missing: item.missing }; });
    result.failed = output.filter(function (item) { return item.state === "failed"; })
      .map(function (item) { return { id: item.id, name: item.name }; });
    result.active = output.filter(function (item) { return item.state === "active"; }).length;
    return result;
  } catch (error) {
    result.reason = "error: " + errText(error);
    return result;
  }
}

// ── H 运行期热停用（能成就不用划掉后台，刷新页面即可）──────────────────
export async function tryHotDisable(runtime, ids) {
  const result = { ok: false, updated: [], failed: [] };
  try {
    const ctx = runtime && runtime.ctx ? runtime.ctx : null;
    const loader = ctx && typeof ctx.get === "function" ? ctx.get("loader") : undefined;
    for (const id of ids || []) {
      let done = false;
      let lastError = "";
      if (loader && typeof loader.update === "function") {
        try {
          await loader.update(id, { disabled: true });
          done = true;
        } catch (error) {
          lastError = errText(error);
        }
      }
      if (!done && loader && typeof loader.resolve === "function") {
        try {
          const entry = loader.resolve(id);
          if (entry && typeof entry.update === "function") {
            await entry.update({ disabled: true });
            done = true;
          }
        } catch (error) {
          lastError = errText(error);
        }
      }
      if (done) {
        result.updated.push(id);
      } else {
        result.failed.push({ id, error: lastError || "no-loader-api" });
      }
    }
    result.ok = result.updated.length > 0;
  } catch (error) {
    result.failed.push({ id: "", error: errText(error) });
  }
  return result;
}

// ── A 双通道注入（tapIndex + webserver/index-inject）────────────────────
export function injectChannelCount(diag) {
  let count = 0;
  try {
    if (diag && diag.tapIndex === "ok") {
      count += 1;
    }
    if (diag && diag.indexInject === "ok") {
      count += 1;
    }
  } catch (_) {
    // ignore
  }
  return count;
}

function attachIndexInject(runtime, cleanups) {
  try {
    const ctx = runtime && runtime.ctx;
    if (!ctx || typeof ctx.on !== "function") {
      runtime.diag.indexInject = "unsupported";
      writeDiagnostic(runtime, "index-inject：宿主没有 ctx.on，保持 tapIndex 单通道");
      return;
    }
    const src = ROUTE_PATH + "/client.js";
    const dispose = ctx.on("webserver/index-inject", function (table) {
      try {
        if (!Array.isArray(table)) {
          return;
        }
        for (const row of table) {
          if (row && row.kind === "script-src" && row.src === src) {
            return;
          }
        }
        table.push({ kind: "script-src", placement: "body", src });
        runtime.injections += 1;
      } catch (_) {
        // ignore
      }
    });
    if (typeof dispose === "function") {
      cleanups.push(dispose);
    }
    runtime.diag.indexInject = "ok";
    writeDiagnostic(runtime, "index-inject：注册成功（结构化注入通道可用）");
  } catch (error) {
    runtime.diag.indexInject = "failed: " + errText(error);
    writeDiagnostic(runtime, "index-inject：失败（已降级，不影响宿主）：" + errText(error));
  }
}

// ── 日常检查（只读，不写任何文件）──────────────────────────────────────
// 每个 /state 请求都会生成一次检查结果，客户端弹窗据此展示「日常检查」清单。
// 检查项只使用已经读取到的文件内容 + 一次 backup 文件的 stat，不额外读 profile。
function statBackup(filePath) {
  try {
    const info = statSync(filePath);
    return { exists: true, size: info.size };
  } catch (_) {
    return { exists: false, size: 0 };
  }
}

async function buildDailyChecks(runtime, state, target) {
  const checks = [];
  const mode = target && target.mode ? target.mode : "readonly";
  const writable = mode !== "readonly";
  // 1. 救援服务
  let serviceStatus = "ok";
  let serviceDetail = "在线（v" + version + "）";
  if (mode === "readonly") {
    serviceStatus = "fail";
    serviceDetail = "只读：" + (state.readOnlyReason || "无法修改救援配置");
  } else if (mode === "patch-fallback") {
    serviceStatus = "warn";
    serviceDetail = "降级模式：写入 cordis.patch.yml，重启后可能失效";
  }
  checks.push({ id: "service", label: "救援服务", status: serviceStatus, detail: serviceDetail });
  // 2. 数据目录
  checks.push({
    id: "home",
    label: "数据目录",
    status: runtime.homeDir ? "ok" : "fail",
    detail: runtime.homeDir ? String(runtime.homeDir) : "未找到 DSH_HOME / DSHM_HOME",
  });
  // 3. profile 目录
  checks.push({
    id: "profile",
    label: "Profile",
    status: runtime.profileDir ? "ok" : "fail",
    detail: runtime.profileDir ? String(runtime.profileDir) : "无法定位声明 dsh.profile 的目录",
  });
  // 4. 用户行文件
  const rowsFile = target && target.rowsFile ? target.rowsFile : null;
  if (!rowsFile) {
    checks.push({ id: "rows", label: "用户行文件", status: "warn", detail: "未能读取，详见只读原因" });
  } else if (rowsFile.state === "missing") {
    checks.push({ id: "rows", label: "用户行文件", status: "ok", detail: "尚未创建，首次救援停用时会自动创建" });
  } else if (rowsFile.state === "found") {
    const parsed = !!(rowsFile.parse && rowsFile.parse.ok);
    checks.push({
      id: "rows",
      label: "用户行文件",
      status: parsed ? "ok" : "warn",
      detail: parsed ? "存在，结构与救援标记正常" : "存在但结构异常，已切换降级写入",
    });
  } else {
    checks.push({ id: "rows", label: "用户行文件", status: "fail", detail: "无法读取：" + String(rowsFile.error || "unknown") });
  }
  // 5. 写入目标
  let targetStatus = "ok";
  let targetDetail = "";
  if (!writable) {
    targetStatus = "fail";
    targetDetail = state.readOnlyReason || "只读模式，无法写入";
  } else if (mode === "patch-fallback") {
    targetStatus = "warn";
    targetDetail = String(target.patchPath || runtime.patchPath || "cordis.patch.yml");
  } else {
    targetDetail = String(target.rowsPath || runtime.rowsPath || ROWS_FILENAME);
  }
  checks.push({ id: "target", label: "写入目标", status: targetStatus, detail: targetDetail });
  // 6. 救援停用项
  const rescue = Array.isArray(state.rescueRows) ? state.rescueRows : [];
  checks.push({
    id: "rescue",
    label: "救援停用项",
    status: rescue.length ? "warn" : "ok",
    detail: rescue.length ? rescue.length + " 项：" + rescue.join("、") : "无",
  });
  // 7. 写入前备份
  const backupBase = mode === "patch-fallback"
    ? (target.patchPath || runtime.patchPath)
    : runtime.rowsPath;
  const backup = backupBase ? statBackup(backupBase + BACKUP_SUFFIX) : { exists: false, size: 0 };
  checks.push({
    id: "backup",
    label: "写入前备份",
    status: "ok",
    detail: backup.exists ? "存在（" + backup.size + " B）" : "尚无备份，首次写入时创建",
  });
  // 8. loader 真实状态（1.2.0：不再靠失败文案猜）
  const loaderState = state.loader && typeof state.loader === "object"
    ? state.loader
    : { ok: false, pending: [], failed: [], counts: { active: 0, pending: 0, failed: 0 } };
  const pendingCount = (loaderState.pending || []).length;
  const failedCount = (loaderState.failed || []).length;
  checks.push({
    id: "loader",
    label: "loader 状态",
    status: !loaderState.ok ? "warn" : (failedCount ? "fail" : (pendingCount ? "warn" : "ok")),
    detail: !loaderState.ok
      ? "读不到 loader（" + String(loaderState.reason || "unavailable") + "），失败页判定退回文案匹配"
      : ("active " + loaderState.counts.active + "，pending " + pendingCount + (failedCount ? "，failed " + failedCount : "")
        + (pendingCount ? "：" + loaderState.pending.map(function (item) { return item.id; }).join("、") : "")),
  });
  // 9. 注入通道（1.2.0）
  const channels = injectChannelCount(runtime.diag);
  checks.push({
    id: "inject-channels",
    label: "注入通道",
    status: channels >= 2 ? "ok" : (channels === 1 ? "warn" : "fail"),
    detail: channels >= 2
      ? "双通道均可用（tapIndex + index-inject）"
      : (channels === 1
        ? "只有单通道可用（tapIndex=" + String(runtime.diag.tapIndex) + "，index-inject=" + String(runtime.diag.indexInject) + "）"
        : "两条注入通道都不可用，失败页上不会出现救援入口"),
  });
  // 9. 救援台账
  const ledgerState = state.ledger && typeof state.ledger === "object" ? state.ledger : emptyLedgerState("");
  const ledgerCount = Array.isArray(ledgerState.entries) ? ledgerState.entries.length : 0;
  checks.push({
    id: "ledger",
    label: "救援台账",
    status: ledgerState.ok ? "ok" : "warn",
    detail: ledgerState.ok
      ? (ledgerCount ? ledgerCount + " 条记录（注释被抹掉时按台账恢复）" : "空台账，恢复只依赖注释标记")
      : String(ledgerState.error || "台账不可用"),
  });
  // 10. 良好快照
  const snapshotState = state.snapshot && typeof state.snapshot === "object" ? state.snapshot : { count: 0, latest: null };
  checks.push({
    id: "snapshot",
    label: "良好快照",
    status: snapshotState.latest ? "ok" : "warn",
    detail: snapshotState.latest
      ? String(snapshotState.count) + " 份，最近 " + String(snapshotState.latest.at || snapshotState.latest.id) + "（" + String(snapshotState.latest.reason) + "）"
      : "还没有快照，启动 15 秒后会自动创建",
  });
  // 11. 启动失败残留
  const quarantineState = state.quarantine && typeof state.quarantine === "object" ? state.quarantine : { bootFailed: false, files: [] };
  const mergeableCount = (quarantineState.files || []).filter(function (item) { return item && item.mergeable; }).length;
  checks.push({
    id: "quarantine",
    label: "启动失败残留",
    status: quarantineState.bootFailed || mergeableCount ? "warn" : "ok",
    detail: quarantineState.bootFailed
      ? "检测到 .dshm-boot-failed（上次 Host 级启动失败）" + (mergeableCount ? "，" + mergeableCount + " 个隔离文件可合并恢复" : "")
      : (mergeableCount ? mergeableCount + " 个隔离文件可合并恢复" : "无残留"),
  });
  // 12. profile bundles
  const bundlesState = state.bundles && typeof state.bundles === "object" ? state.bundles : { ok: false, count: 0, removable: [] };
  checks.push({
    id: "bundles",
    label: "profile bundles",
    status: bundlesState.ok ? "ok" : "warn",
    detail: bundlesState.ok
      ? String(bundlesState.count) + " 项，其中 " + String((bundlesState.removable || []).length) + " 项可被救援移除"
      : String(bundlesState.error || "无法读取 bundles"),
  });
  return checks;
}

async function attachChecks(runtime, state, target) {
  try {
    state.checks = await buildDailyChecks(runtime, state, target);
  } catch (_) {
    state.checks = [];
  }
  try {
    if (!runtime.dailyChecksLogged) {
      runtime.dailyChecksLogged = true;
      const parts = (state.checks || []).map(function (item) { return item.label + "=" + item.status; });
      writeDiagnostic(runtime, "日常检查：" + (parts.join("，") || "无检查项"));
    }
  } catch (_) {
    // 写日志失败不影响 state
  }
}

// ── 写接口 ──────────────────────────────────────────────────────────────
async function stateHandler(runtime, req, res) {
  try {
    if (!methodAllowed(req, res, "GET")) {
      return;
    }
    const state = await buildState(runtime);
    if (!isLoopbackAddress(req && req.socket ? req.socket.remoteAddress : "")) {
      state.writable = false;
      state.readOnlyReason = "当前连接不是本机回环地址；救援配置变更默认禁用。";
      state.readOnlyReasonCode = "remote-mutation-disabled";
      for (const entry of state.entries) {
        entry.actionable = false;
      }
      state.counts = {
        entries: state.entries.length,
        actionable: 0,
        rescue: state.rescueRows.length,
      };
    }
    json(res, 200, state);
  } catch (error) {
    json(res, error.statusCode || 500, { ok: false, error: errText(error), code: error.code || "state-error" });
  }
}

async function disableHandler(runtime, req, res) {
  try {
    if (!methodAllowed(req, res, "POST")) {
      return;
    }
    assertMutationRequest(req);
    const body = await readJsonBody(req);
    const ids = normalizeIds(body);
    const state = await buildState(runtime);
    if (!state.writable) {
      throw errorWithStatus(503, state.readOnlyReason || "rescue is read-only", state.readOnlyReasonCode || "read-only");
    }
    const byId = new Map();
    for (const entry of state.entries) {
      byId.set(entry.id, entry);
    }
    for (const id of ids) {
      if (id === SELF_ENTRY_ID || id === PACKAGE_NAME) {
        throw errorWithStatus(409, PACKAGE_NAME + " cannot disable itself", "self-protected");
      }
      const entry = byId.get(id);
      if (!entry) {
        throw errorWithStatus(404, "unknown plugin row: " + id, "unknown-id");
      }
      if (entry.protected && entry.protectedReason === "self") {
        throw errorWithStatus(409, PACKAGE_NAME + " cannot disable itself", "self-protected");
      }
      if (entry.protected) {
        throw errorWithStatus(409, "protected row: " + id, "protected-id");
      }
      if (!entry.actionable) {
        throw errorWithStatus(409, "row is not actionable: " + id, "not-actionable");
      }
    }

    const target = await resolveTarget(runtime);
    if (target.mode === "readonly") {
      throw errorWithStatus(503, target.reason || "rescue is read-only", target.code || "read-only");
    }
    let outcome = null;
    let targetFile = "";
    if (target.mode === "rows") {
      targetFile = target.rowsPath;
      outcome = await mutateTextFile(target.rowsPath, function (text) {
        const rendered = renderDisableRows(text, ids);
        rendered.result.textAfter = rendered.text;
        return rendered;
      });
      outcome.mode = "rows";
    } else {
      targetFile = target.patchPath;
      outcome = await mutateTextFile(target.patchPath, function (text) {
        const rendered = renderPatchDisableRows(text, ids);
        rendered.result.textAfter = rendered.text;
        return rendered;
      });
      outcome.mode = "patch-fallback";
    }
    writeDiagnostic(runtime, "停用：mode=" + outcome.mode + " added=" + JSON.stringify(outcome.added) + " already=" + JSON.stringify(outcome.already) + " ids=" + JSON.stringify(ids));
    const ledgerLevel = outcome.mode === "patch-fallback" ? "patch" : "rows";
    const fileDigestAfter = digestText(typeof outcome.textAfter === "string" ? outcome.textAfter : "");
    for (const addedId of outcome.added || []) {
      await upsertLedgerEntry(runtime, {
        id: addedId,
        level: ledgerLevel,
        file: targetFile,
        blockDigest: blockDigestOf(addedId, "true"),
        fileDigestAfter,
      });
    }
    // 能热停用就不用重开应用（失败也不影响已写好的持久行）。
    const hot = await tryHotDisable(runtime, outcome.added || []);
    if (hot.updated.length || hot.failed.length) {
      writeDiagnostic(runtime, "热停用：updated=" + JSON.stringify(hot.updated) + " failed=" + JSON.stringify(hot.failed.map(function (item) { return item.id; })));
    }
    const after = await buildState(runtime);
    json(res, 200, {
      ok: true,
      mode: outcome.mode,
      level: ledgerLevel,
      disabled: outcome.added,
      already: outcome.already,
      rescueRows: after.rescueRows,
      warning: after.warning,
      hotDisabled: hot.updated,
      hotFailed: hot.failed,
      notice: after.notice || "",
    });
  } catch (error) {
    json(res, error.statusCode || 500, { ok: false, error: errText(error), code: error.code || "disable-failed" });
  }
}

async function restoreHandler(runtime, req, res) {
  try {
    if (!methodAllowed(req, res, "POST")) {
      return;
    }
    assertMutationRequest(req);
    const body = await readJsonBody(req);
    const ids = normalizeIds(body, { allowEmpty: true });
    const state = await buildState(runtime);
    if (!state.writable) {
      throw errorWithStatus(503, state.readOnlyReason || "rescue is read-only", state.readOnlyReasonCode || "read-only");
    }
    const target = await resolveTarget(runtime);
    if (target.mode === "readonly") {
      throw errorWithStatus(503, target.reason || "rescue is read-only", target.code || "read-only");
    }
    const requested = ids.length > 0 ? ids : null;
    const markerPrefix = target.mode === "patch-fallback" ? PATCH_MARKER_PREFIX : ROW_MARKER_PREFIX;
    const targetFile = target.mode === "patch-fallback" ? target.patchPath : target.rowsPath;
    const ledgerLevel = target.mode === "patch-fallback" ? "patch" : "rows";
    const result = await mutateTextFile(targetFile, function (text) {
      return removeRescueRows(text, requested, { markerPrefix });
    });
    // 1.2.0 兜底：注释标记被 DSHM 插件页抹掉时，按台账指纹恢复。
    const skipped = [];
    let ledgerRestored = [];
    try {
      const ledger = readLedger(runtime);
      if (ledger.ok && ledger.entries.length) {
        const done = new Set(result.restored || []);
        const candidates = ledger.entries.filter(function (item) {
          if (item.level !== ledgerLevel) {
            return false;
          }
          if (done.has(item.id)) {
            return false;
          }
          return requested === null ? true : requested.indexOf(item.id) !== -1;
        });
        if (candidates.length) {
          const ledgerResult = await mutateTextFile(targetFile, function (text) {
            return removeRowsByLedger(text, candidates);
          });
          ledgerRestored = ledgerResult.restored || [];
          for (const restoredId of ledgerRestored) {
            done.add(restoredId);
          }
        }
        if (requested !== null) {
          for (const wantedId of requested) {
            if (done.has(wantedId)) {
              continue;
            }
            const known = ledger.entries.filter(function (item) {
              return item.id === wantedId && item.level === ledgerLevel;
            })[0];
            skipped.push({ id: wantedId, reason: known ? "block-modified-or-missing" : "no-marker-no-ledger" });
          }
        }
      }
    } catch (error) {
      writeDiagnostic(runtime, "台账兜底恢复失败（不影响标记恢复）：" + errText(error));
    }
    const restored = (result.restored || []).concat(ledgerRestored);
    if (restored.length) {
      await removeLedgerEntries(runtime, restored, ledgerLevel);
    }
    writeDiagnostic(runtime, "恢复：mode=" + target.mode + " marker=" + JSON.stringify(result.restored) + " ledger=" + JSON.stringify(ledgerRestored));
    json(res, 200, {
      ok: true,
      mode: target.mode,
      level: ledgerLevel,
      restored,
      markerRestored: result.restored,
      ledgerRestored,
      skipped,
    });
  } catch (error) {
    json(res, error.statusCode || 500, { ok: false, error: errText(error), code: error.code || "restore-failed" });
  }
}

// ── 1.2.0 新写接口：bundle 级停用 / 安全模式 / 快照 / 隔离残留 ──────────
async function disableBundleHandler(runtime, req, res) {
  try {
    if (!methodAllowed(req, res, "POST")) {
      return;
    }
    assertMutationRequest(req);
    const body = await readJsonBody(req);
    const ids = normalizeIds(body);
    const state = await buildState(runtime);
    if (!state.writable) {
      throw errorWithStatus(503, state.readOnlyReason || "rescue is read-only", state.readOnlyReasonCode || "read-only");
    }
    const byId = new Map();
    for (const entry of state.entries) {
      byId.set(entry.id, entry);
    }
    const names = [];
    for (const id of ids) {
      if (id === SELF_ENTRY_ID || id === PACKAGE_NAME) {
        throw errorWithStatus(409, PACKAGE_NAME + " cannot disable itself", "self-protected");
      }
      const entry = byId.get(id);
      if (!entry) {
        throw errorWithStatus(404, "unknown plugin row: " + id, "unknown-id");
      }
      if (!entry.bundleRemovable || !entry.bundleName) {
        throw errorWithStatus(409, "row is not removable from bundles: " + id, "not-actionable");
      }
      if (names.indexOf(entry.bundleName) === -1) {
        names.push(entry.bundleName);
      }
    }
    const outcome = await removeBundles(runtime, names);
    json(res, 200, { ok: true, mode: "bundles", level: "bundles", removed: outcome.removed, already: outcome.already });
  } catch (error) {
    json(res, error.statusCode || 500, { ok: false, error: errText(error), code: error.code || "disable-bundle-failed" });
  }
}

async function restoreBundleHandler(runtime, req, res) {
  try {
    if (!methodAllowed(req, res, "POST")) {
      return;
    }
    assertMutationRequest(req);
    const body = await readJsonBody(req);
    const ids = normalizeIds(body, { allowEmpty: true });
    const outcome = await restoreBundles(runtime, ids);
    json(res, 200, { ok: true, mode: "bundles", restored: outcome.restored, skipped: outcome.skipped });
  } catch (error) {
    json(res, error.statusCode || 500, { ok: false, error: errText(error), code: error.code || "restore-bundle-failed" });
  }
}

async function safeModeHandler(runtime, req, res) {
  try {
    if (!methodAllowed(req, res, "POST")) {
      return;
    }
    assertMutationRequest(req);
    const body = await readJsonBody(req);
    if (!body || body.confirm !== true) {
      throw errorWithStatus(400, "安全模式需要 confirm:true 显式确认", "nothing-to-do");
    }
    const state = await buildState(runtime);
    if (!state.writable) {
      throw errorWithStatus(503, state.readOnlyReason || "rescue is read-only", state.readOnlyReasonCode || "read-only");
    }
    const keep = new Set((Array.isArray(body.keep) ? body.keep : []).map(String));
    const targets = state.entries.filter(function (entry) {
      if (!entry || entry.id === SELF_ENTRY_ID) {
        return false;
      }
      if (entry.builtin || entry.protected) {
        return false;
      }
      if (keep.has(entry.id) || (entry.bundleName && keep.has(entry.bundleName))) {
        return false;
      }
      if (!entry.actionable) {
        return false;
      }
      const levels = Array.isArray(entry.levels) ? entry.levels : ["rows"];
      return levels.indexOf("rows") !== -1;
    });
    if (!targets.length) {
      throw errorWithStatus(400, "没有可停用的候选插件", "nothing-to-do");
    }
    const target = await resolveTarget(runtime);
    if (target.mode === "readonly") {
      throw errorWithStatus(503, target.reason || "rescue is read-only", target.code || "read-only");
    }
    const rowIds = targets.map(function (entry) { return entry.id; });
    let rowsOutcome = null;
    let targetFile = "";
    if (target.mode === "rows") {
      targetFile = target.rowsPath;
      rowsOutcome = await mutateTextFile(target.rowsPath, function (text) {
        const rendered = renderDisableRows(text, rowIds);
        rendered.result.textAfter = rendered.text;
        return rendered;
      });
    } else {
      targetFile = target.patchPath;
      rowsOutcome = await mutateTextFile(target.patchPath, function (text) {
        const rendered = renderPatchDisableRows(text, rowIds);
        rendered.result.textAfter = rendered.text;
        return rendered;
      });
    }
    const ledgerLevel = target.mode === "patch-fallback" ? "patch" : "rows";
    const fileDigestAfter = digestText(typeof rowsOutcome.textAfter === "string" ? rowsOutcome.textAfter : "");
    for (const addedId of rowsOutcome.added || []) {
      await upsertLedgerEntry(runtime, {
        id: addedId,
        level: ledgerLevel,
        file: targetFile,
        blockDigest: blockDigestOf(addedId, "true"),
        fileDigestAfter,
      });
    }
    // 第二级：仍在 bundles 里的可移除项一并移除，重启后 bundle 完全不加载。
    const bundlesRemoved = [];
    const bundlesSkipped = [];
    try {
      const removableNames = [];
      for (const entry of targets) {
        if (entry.bundleRemovable && entry.bundleName && removableNames.indexOf(entry.bundleName) === -1) {
          removableNames.push(entry.bundleName);
        }
      }
      if (removableNames.length) {
        const bundleOutcome = await removeBundles(runtime, removableNames);
        for (const name of bundleOutcome.removed) {
          bundlesRemoved.push(name);
        }
        for (const name of bundleOutcome.already) {
          bundlesSkipped.push({ id: name, reason: "already-removed" });
        }
      }
    } catch (error) {
      bundlesSkipped.push({ id: "", reason: errText(error) });
    }
    writeDiagnostic(runtime, "安全模式：rows=" + JSON.stringify(rowsOutcome.added) + " already=" + JSON.stringify(rowsOutcome.already) + " bundles=" + JSON.stringify(bundlesRemoved));
    const hot = await tryHotDisable(runtime, rowsOutcome.added || []);
    if (hot.updated.length || hot.failed.length) {
      writeDiagnostic(runtime, "安全模式热停用：updated=" + JSON.stringify(hot.updated) + " failed=" + JSON.stringify(hot.failed.map(function (item) { return item.id; })));
    }
    const after = await buildState(runtime);
    json(res, 200, {
      ok: true,
      mode: target.mode,
      levels: { rows: rowsOutcome.added, bundles: bundlesRemoved },
      already: rowsOutcome.already,
      bundlesSkipped,
      kept: Array.from(keep),
      rescueRows: after.rescueRows,
      warning: after.warning,
      hotDisabled: hot.updated,
      hotFailed: hot.failed,
      notice: after.notice || "",
    });
  } catch (error) {
    json(res, error.statusCode || 500, { ok: false, error: errText(error), code: error.code || "safe-mode-failed" });
  }
}

async function snapshotHandler(runtime, req, res) {
  try {
    if (!methodAllowed(req, res, "POST")) {
      return;
    }
    assertMutationRequest(req);
    const body = await readJsonBody(req);
    const reason = body && typeof body.reason === "string" && /^[a-z][a-z0-9-]{0,15}$/.test(body.reason)
      ? body.reason
      : "manual";
    const snapshot = await createSnapshot(runtime, reason);
    json(res, 200, { ok: true, id: snapshot.id, at: snapshot.at, path: snapshot.dir, rowsBytes: snapshot.rowsBytes });
  } catch (error) {
    json(res, error.statusCode || 500, { ok: false, error: errText(error), code: error.code || "snapshot-failed" });
  }
}

async function rollbackHandler(runtime, req, res) {
  try {
    if (!methodAllowed(req, res, "POST")) {
      return;
    }
    assertMutationRequest(req);
    const body = await readJsonBody(req);
    const id = body && typeof body.id === "string" && body.id.trim() ? body.id.trim() : "";
    const result = await restoreSnapshotById(runtime, id);
    json(res, 200, Object.assign({ ok: true }, result));
  } catch (error) {
    json(res, error.statusCode || 500, { ok: false, error: errText(error), code: error.code || "rollback-failed" });
  }
}

async function quarantineRestoreHandler(runtime, req, res) {
  try {
    if (!methodAllowed(req, res, "POST")) {
      return;
    }
    assertMutationRequest(req);
    const body = await readJsonBody(req);
    const name = body && typeof body.name === "string" ? body.name.trim() : "";
    const scan = scanQuarantine(runtime);
    const candidates = scan.files.filter(function (item) { return item.mergeable; });
    if (!candidates.length) {
      throw errorWithStatus(404, scan.files.length ? "隔离文件都无法安全解析" : "没有可合并的隔离文件", "quarantine-not-found");
    }
    let chosen = null;
    if (name) {
      chosen = scan.files.filter(function (item) { return item.name === name; })[0];
      if (!chosen) {
        throw errorWithStatus(404, "找不到隔离文件：" + name, "quarantine-not-found");
      }
    } else if (candidates.length === 1) {
      chosen = candidates[0];
    } else {
      throw errorWithStatus(400, "存在多个隔离文件，请在 name 里指定", "quarantine-unmergeable");
    }
    if (!chosen.mergeable) {
      throw errorWithStatus(422, "隔离文件结构无法安全解析：" + chosen.reason, "quarantine-unmergeable");
    }
    if (chosen.name.indexOf("/") !== -1 || chosen.name.indexOf("\\") !== -1 || chosen.name.indexOf("..") !== -1) {
      throw errorWithStatus(400, "非法文件名", "quarantine-unmergeable");
    }
    const quarantineText = await readFile(chosen.path, "utf8");
    let merged = [];
    let skipped = [];
    await mutateTextFile(runtime.rowsPath, function (currentText) {
      const mergedResult = mergeQuarantineRows(currentText, quarantineText);
      if (!mergedResult.ok) {
        throw errorWithStatus(422, mergedResult.reason, "quarantine-unmergeable");
      }
      merged = mergedResult.merged;
      skipped = mergedResult.skipped;
      return { text: mergedResult.text, result: { merged, skipped } };
    });
    writeDiagnostic(runtime, "隔离残留合并：" + chosen.name + " merged=" + JSON.stringify(merged) + " skipped=" + JSON.stringify(skipped));
    json(res, 200, { ok: true, name: chosen.name, merged, skipped, backup: runtime.rowsPath + BACKUP_SUFFIX });
  } catch (error) {
    json(res, error.statusCode || 500, { ok: false, error: errText(error), code: error.code || "quarantine-restore-failed" });
  }
}

// ── 页面注入 ────────────────────────────────────────────────────────────
function injectRescue(runtime, html) {
  try {
    if (typeof html !== "string") {
      return html;
    }
    const source = html;
    if (source.indexOf(RESCUE_MARKER) !== -1) {
      return source;
    }
    const offset = source.lastIndexOf("</head>");
    if (offset === -1) {
      return source;
    }
    const meta = '<meta name="' + RESCUE_MARKER + '" content="' + RESCUE_MARKER + '">';
    const script = '<script defer src="' + ROUTE_PATH + '/client.js"></script>';
    const injected = source.slice(0, offset) + meta + "\n" + script + "\n" + source.slice(offset);
    runtime.injections += 1;
    if (runtime.injections === 1) {
      writeDiagnostic(runtime, "tapIndex：已向 index.html 注入救援脚本（" + ROUTE_PATH + "/client.js）");
    }
    return injected;
  } catch (error) {
    writeDiagnostic(runtime, "tapIndex：注入时异常（已返回原页面）：" + errText(error));
    return html;
  }
}

// 自检页支持多种「失败形态」，用来验证客户端的判定不会误伤、也不会漏救：
//   title（默认，1.1.1 那种标题式失败页）
//   pending（只有 pending 行，没有标题）
//   import（import failed 文案）
//   empty（空 #root，只有 data-dsh-boot）
function previewHtml(shape) {
  const variant = String(shape || "title");
  let body = "";
  if (variant === "pending") {
    body = "<div class=\"preview-item\">ui-chat: pending (waiting for service: demo-service)</div>";
  } else if (variant === "import") {
    body = "<div class=\"preview-item\">dsh-market: import failed: Cannot find module 'x'</div>"
      + "<div class=\"preview-item\">web boot: 2 entries did not activate</div>";
  } else if (variant === "empty") {
    body = "";
  } else {
    body = "<div class=\"preview-failed\">Failed to load plugins</div>"
      + "<div class=\"preview-item\">web boot: 1 entry did not activate</div>"
      + "<div class=\"preview-item\">dsh-market: pending (waiting for service: demo-service)</div>";
  }
  return "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
    + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
    + "<title>DSHM Boot Rescue 自检</title>"
    + "<style>html,body{margin:0;height:100%}body{font-family:system-ui,sans-serif}"
    + "#root{height:100%;display:grid;place-items:center;background:#f5f6f8;color:#1d232b}"
    + ".preview-card{border:1px solid rgba(0,0,0,.12);border-radius:14px;padding:24px 28px;background:#fff;max-width:560px}"
    + ".preview-wordmark{font-size:12px;font-weight:700;letter-spacing:.16em;margin-bottom:12px}"
    + ".preview-failed{font-weight:600;margin-bottom:8px}"
    + ".preview-item{font:12px/1.6 ui-monospace,Menlo,Consolas,monospace;color:#5b6570;white-space:pre-wrap}"
    + "</style></head><body data-dshm-boot-rescue-preview=\"1\" data-dshm-boot-rescue-shape=\"" + variant + "\"><div id=\"root\">"
    + "<div data-dsh-boot=\"\" class=\"preview-card\"><div class=\"preview-wordmark\">HARNESS</div>"
    + body
    + "</div></div>"
    + "<script defer src=\"" + ROUTE_PATH + "/client.js\"></script></body></html>";
}

// ── 路由 ────────────────────────────────────────────────────────────────
async function routeHandler(runtime, req, res) {
  try {
    const url = new URL(req && req.url ? req.url : "/", "http://localhost");
    let subpath = url.pathname;
    if (subpath.indexOf(ROUTE_PATH) === 0) {
      subpath = subpath.slice(ROUTE_PATH.length);
    }
    if (subpath === "" || subpath === "/") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end("dshm-boot-rescue " + version + "\n");
      return;
    }
    if (subpath === "/client.js") {
      if (!methodAllowed(req, res, "GET")) {
        return;
      }
      const body = await readFile(new URL("./rescue-client.js", import.meta.url));
      res.writeHead(200, {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(body);
      return;
    }
    if (subpath === "/health") {
      if (!methodAllowed(req, res, "GET")) {
        return;
      }
      json(res, 200, {
        ok: true,
        version,
        webServer: runtime.diag.webServer,
        loader: runtime.diag.loader,
        route: runtime.diag.route,
        tapIndex: runtime.diag.tapIndex,
        indexInject: runtime.diag.indexInject,
        channels: injectChannelCount(runtime.diag),
        injections: runtime.injections,
        mode: runtime.readOnly ? "readonly" : "ready",
      });
      return;
    }
    if (subpath === "/preview") {
      if (!methodAllowed(req, res, "GET")) {
        return;
      }
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
      });
      res.end(previewHtml(url.searchParams.get("shape")));
      return;
    }
    if (subpath === "/state") {
      await stateHandler(runtime, req, res);
      return;
    }
    if (subpath === "/disable") {
      await disableHandler(runtime, req, res);
      return;
    }
    if (subpath === "/restore") {
      await restoreHandler(runtime, req, res);
      return;
    }
    if (subpath === "/disable-bundle") {
      await disableBundleHandler(runtime, req, res);
      return;
    }
    if (subpath === "/restore-bundle") {
      await restoreBundleHandler(runtime, req, res);
      return;
    }
    if (subpath === "/safe-mode") {
      await safeModeHandler(runtime, req, res);
      return;
    }
    if (subpath === "/snapshot") {
      await snapshotHandler(runtime, req, res);
      return;
    }
    if (subpath === "/rollback") {
      await rollbackHandler(runtime, req, res);
      return;
    }
    if (subpath === "/quarantine/restore") {
      await quarantineRestoreHandler(runtime, req, res);
      return;
    }
    res.writeHead(404, { "cache-control": "no-store" });
    res.end();
  } catch (error) {
    json(res, error.statusCode || 500, { ok: false, error: errText(error), code: error.code || "route-error" });
  }
}

// ── 服务获取（绝不进入 pending） ────────────────────────────────────────
function attachWebServer(runtime, cleanups) {
  let webServer = null;
  try {
    webServer = runtime.ctx && typeof runtime.ctx.get === "function"
      ? runtime.ctx.get("webServer")
      : undefined;
  } catch (error) {
    runtime.diag.webServer = "error: " + errText(error);
  }
  if (!webServer || typeof webServer.register !== "function") {
    return false;
  }
  runtime.diag.webServer = "ok";
  writeDiagnostic(runtime, "webServer：已获取");
  try {
    const dispose = webServer.register({
      kind: "prefix",
      path: ROUTE_PATH,
      handler: function (req, res) { return routeHandler(runtime, req, res); },
    });
    if (typeof dispose === "function") {
      cleanups.push(dispose);
    }
    runtime.diag.route = "ok";
    writeDiagnostic(runtime, "路由注册：ok（" + ROUTE_PATH + "）");
  } catch (error) {
    runtime.diag.route = "failed: " + errText(error);
    writeDiagnostic(runtime, "路由注册：失败（已降级，不影响宿主）：" + errText(error));
  }
  try {
    if (typeof webServer.tapIndex !== "function") {
      throw new Error("webServer.tapIndex 不可用");
    }
    const dispose = webServer.tapIndex(function (html) {
      return injectRescue(runtime, html);
    });
    if (typeof dispose === "function") {
      cleanups.push(dispose);
    }
    runtime.diag.tapIndex = "ok";
    writeDiagnostic(runtime, "tapIndex：注册成功（等待 index.html 渲染时注入）");
  } catch (error) {
    runtime.diag.tapIndex = "failed: " + errText(error);
    writeDiagnostic(runtime, "tapIndex：失败（已降级，不影响宿主）：" + errText(error));
  }
  // 1.2.0：第二条注入通道（结构化 index-inject）。tapIndex 失效或被上游改名时，
  // 这条仍能把救援脚本挂进 index.html。
  attachIndexInject(runtime, cleanups);
  writeDiagnostic(runtime, "注入通道："
    + injectChannelCount(runtime.diag) + " 条可用（tapIndex=" + runtime.diag.tapIndex
    + "，index-inject=" + runtime.diag.indexInject + "）");
  return true;
}

export function apply(ctx) {
  try {
    if (!ctx || typeof ctx.effect !== "function") {
      try {
        console.error("[" + PACKAGE_NAME + "] apply：ctx.effect 不可用，跳过（不影响宿主启动）");
      } catch (_) {
        // ignore
      }
      return;
    }
    const runtime = createRuntime(ctx);
    ctx.effect(function () {
      const cleanups = [];
      let stopped = false;
      let attached = false;
      let timer = null;
      let attempts = 0;

      function cleanup() {
        stopped = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        while (cleanups.length > 0) {
          const dispose = cleanups.pop();
          try {
            if (typeof dispose === "function") {
              dispose();
            }
          } catch (_) {
            // ignore
          }
        }
      }

      function tryAttach() {
        if (stopped || attached) {
          return;
        }
        let webServer = null;
        try {
          webServer = typeof ctx.get === "function" ? ctx.get("webServer") : undefined;
        } catch (error) {
          runtime.diag.webServer = "error: " + errText(error);
        }
        if (!webServer || typeof webServer.register !== "function") {
          attempts += 1;
          if (runtime.diag.webServer !== "unavailable") {
            runtime.diag.webServer = "unavailable";
            writeDiagnostic(runtime, "webServer：暂不可用（等待 internal/service 事件并重试；插件自身不会进入 pending）");
          }
          if (attempts < SERVICE_WAIT_TRIES) {
            timer = setTimeout(tryAttach, SERVICE_WAIT_MS);
            try {
              if (timer && typeof timer.unref === "function") {
                timer.unref();
              }
            } catch (_) {
              // ignore
            }
          } else {
            runtime.diag.webServer = "unavailable(timeout)";
            writeDiagnostic(runtime, "webServer：等待超时，已降级为无路由 / 无注入模式（不影响宿主启动）");
          }
          return;
        }
        attached = true;
        attachWebServer(runtime, cleanups);
      }

      try {
        resolveRuntimePaths(runtime);
      } catch (error) {
        runtime.readOnly = true;
        runtime.readOnlyReason = "救援插件初始化异常，已降级为只读：" + errText(error);
        runtime.readOnlyReasonCode = "init-error";
        writeDiagnostic(runtime, "初始化异常：" + errText(error));
      }

      try {
        const loader = typeof ctx.get === "function" ? ctx.get("loader") : undefined;
        runtime.diag.loader = loader && typeof loader.entries === "function" ? "ok" : "unavailable";
      } catch (error) {
        runtime.diag.loader = "error: " + errText(error);
      }
      writeDiagnostic(runtime, "loader：" + runtime.diag.loader);

      try {
        const dispose = ctx.on("internal/service", function (serviceName, impl) {
          if (!stopped && serviceName === "webServer" && impl) {
            tryAttach();
          }
        });
        if (typeof dispose === "function") {
          cleanups.push(dispose);
        }
      } catch (error) {
        writeDiagnostic(runtime, "internal/service 监听注册失败（改用定时重试）：" + errText(error));
      }

      tryAttach();

      // 1.2.0：启动成功 15 秒后自动存一份「良好快照」（F）。宿主能起来就是好消息。
      try {
        const snapshotTimer = setTimeout(function () {
          if (stopped || runtime.readOnly) {
            return;
          }
          try {
            const pending = createSnapshot(runtime, "startup");
            if (pending && typeof pending.catch === "function") {
              pending.catch(function (error) {
                writeDiagnostic(runtime, "自动快照失败（不影响宿主）：" + errText(error));
              });
            }
          } catch (error) {
            writeDiagnostic(runtime, "自动快照失败（不影响宿主）：" + errText(error));
          }
        }, SNAPSHOT_AUTO_DELAY_MS);
        if (snapshotTimer && typeof snapshotTimer.unref === "function") {
          snapshotTimer.unref();
        }
        cleanups.push(function () {
          try {
            clearTimeout(snapshotTimer);
          } catch (_) {
            // ignore
          }
        });
      } catch (_) {
        // ignore
      }

      return cleanup;
    }, PACKAGE_NAME + ": rescue routes and script");
  } catch (error) {
    try {
      console.error("[" + PACKAGE_NAME + "] apply 失败（已忽略，不影响宿主启动）：" + errText(error));
    } catch (_) {
      // ignore
    }
  }
}
