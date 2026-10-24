// dshm-boot-rescue — 失败页救援脚本（单文件、零依赖，由宿主 tapIndex 注入浏览器）。
//
// 契约来源：.recon/SPEC.md 第 6 节。关键行为：
//   * 只在 DSHM「插件加载失败页」挂载：根文本含 "Failed to load plugins" 且没有健康 UI 时。
//     失败页 root 在 #root 内、标题是一个 div，因此这里只按根节点文本检测。
//   * 已知失败文案全部识别：failed to import loader entry、failed to apply / resolve /
//     initialize loader entry、client-modules: bundle script ... failed to load、
//     web boot: N entries did not activate、<name>: pending (waiting for service: ...)。
//   * 插件启停只在进程启动时拼装，本页面里做任何重载都不会生效 —— 脚本从不触发页面重载，
//     只写带标记的停用行并提示「停用后请划掉后台重新打开应用」。
//   * 只用 var/function 传统语法（ArkWeb 兼容）；全部逻辑 try/catch；零遥测。
//
// 1.2.0 增强（契约：docs/ENHANCE-2026-10-24.md 第 9 节）：
//   * C：失败信号宽松识别（did not activate / import failed / client-modules / pending ( /
//     Failed to load / web boot: / waiting for service / cannot activate / loader entry），
//     并在 DOMContentLoaded 后 15s 仍无健康 UI 时挂一个右下角小胶囊兜底；
//   * 消费 state 新字段 features / inject / ledger / bundles / quarantine / snapshot，
//     以及 entries[].levels / bundleRemovable / bundleName / inBundles；旧宿主缺字段时静默降级；
//   * 新增面板区块：安全模式（二次确认）、每行 bundle 停用、隔离残留合并恢复、
//     快照回滚 / 立即快照、救援台账；只读或自检时全部写按钮禁用并给出原因；
//   * 所有写操作成功都不重载页面，只刷新 UI 并强调「划掉后台重新打开应用」。
//
// 调研增量（Lead 第二轮）：state.loader 真实状态优先判定失败页、疑似项优先用
// loader.pending/failed（带「缺服务」）、/disable 与 /safe-mode 的 hotDisabled/hotFailed
// 热停用结果、state.notice 顶部提示、protectedReason:"required" 跳过疑似、
// 以及先等 __DSH_BOOT_READY__ 再扫 DOM（5s 兜底，startWatching 幂等）。
(function () {
  "use strict";

  try {
    if (window.__DSHM_BOOT_RESCUE__) return;
    window.__DSHM_BOOT_RESCUE__ = true;
  } catch (error) {
    return;
  }

  // ── 1. 常量 ───────────────────────────────────────────────────────────────
  var API_STATE = "/dshm-boot-rescue/state";
  var API_DISABLE = "/dshm-boot-rescue/disable";
  var API_RESTORE = "/dshm-boot-rescue/restore";
  var API_HEALTH = "/dshm-boot-rescue/health";
  // 1.2.0 写路由（契约第 4 节）。
  var API_SAFE_MODE = "/dshm-boot-rescue/safe-mode";
  var API_DISABLE_BUNDLE = "/dshm-boot-rescue/disable-bundle";
  var API_RESTORE_BUNDLE = "/dshm-boot-rescue/restore-bundle";
  var API_SNAPSHOT = "/dshm-boot-rescue/snapshot";
  var API_ROLLBACK = "/dshm-boot-rescue/rollback";
  var API_QUARANTINE_RESTORE = "/dshm-boot-rescue/quarantine/restore";
  // 失败页标题：「Failed to load plugins」渲染在 #root 内的一个 div 里，不是语义标题元素。
  var FAILURE_TITLE = "Failed to load plugins";
  // 健康 DSHM 界面一定存在树控件或可编辑控件；聊天里引用错误文本时用它排除误挂。
  var HEALTHY_UI_SELECTOR = '[role="tree"],textarea,[contenteditable="true"],[role="textbox"],input:not([type="hidden"])';
  var PREVIEW_ATTR = "data-dshm-boot-rescue-preview";
  var MAX_SELECTION = 32;
  var MAX_WATCH_MS = 120000;
  var MAX_FAILURE_TEXT = 12000;
  // 1.2.0：DOMContentLoaded 后 15s 仍无健康 UI 时挂兜底小胶囊（契约 9.2）。
  var CAPSULE_DELAY_MS = 15000;
  var CAPSULE_ID = "dshm-boot-rescue-capsule";
  // 二次确认有效期：超时自动回退，避免误触累积。
  var CONFIRM_TIMEOUT_MS = 5000;
  // 等待宿主 boot ready deferred 的兜底时长（增量第 6 条）。
  var BOOT_READY_FALLBACK_MS = 5000;
  // 救援插件自身入口 id（与宿主 SELF_ENTRY_ID 一致），安全模式排除之。
  var SELF_ENTRY_ID = "dshm-boot-rescue";
  // 面板上展示的台账条数 / 隔离残留条数上限。
  var MAX_LEDGER_ROWS = 5;
  var MAX_QUARANTINE_ITEMS = 8;
  var RESTART_GUIDE = "停用后请划掉后台重新打开应用";
  var RESTART_DETAIL = "插件启停只在进程启动时拼装，重新打开本页面不会生效";
  var PREVIEW_NOTICE = "只读自检：不会修改任何配置";
  var FALLBACK_WARNING = "本次停用重启应用后失效，请进入系统后立即卸载肇事插件";
  var SERVICE_DOWN_TITLE = "救援服务暂时不可用";
  // 自绘弹窗：独立于救援面板，失败页与正常界面都可能弹出。
  var DIALOG_ID = "dshm-boot-rescue-dialog";
  var MAX_DIALOG_QUEUE = 8;
  // 已知失败文案逐条识别（name 只用于诊断；不要求每条同时出现）：
  //   failed to import loader entry <name> (<pkg>)
  //   failed to apply / resolve / initialize loader entry <name> (<pkg>)
  //   client-modules: bundle script <url> failed to load
  //   web boot: N entries did not activate（整体错误，不单独提取名字）
  //   <name>: pending (waiting for service: <service>)
  var LOADER_HINT_PATTERNS = [
    /failed to import loader entry\s+([^\s(]+)(?:\s+\(([^)]+)\))?/i,
    /failed to apply loader entry\s+([^\s(]+)(?:\s+\(([^)]+)\))?/i,
    /failed to resolve loader entry\s+([^\s(]+)(?:\s+\(([^)]+)\))?/i,
    /failed to initialize loader entry\s+([^\s(]+)(?:\s+\(([^)]+)\))?/i
  ];
  var BUNDLE_HINT_PATTERN = /client-modules:\s*bundle script\s+([^\s]+)\s+failed to load/i;
  var ACTIVATION_PATTERN = /web boot:\s*\d+\s+entr(?:y|ies)\s+did not activate/i;
  var PENDING_HINT_PATTERN = /([^\s:]+):\s*pending \(waiting for service[^)]*\)/i;
  // dsh 0.2.1 的失败项实际文案是 "<name>: import failed: <message>" /
  // "<name>: import failed (see console for the import error)"（见核心 bundle 的 bZ()）。
  var IMPORT_FAILED_PATTERN = /([^\s:]+):\s*import failed\b/i;
  // 契约 9.1：文案完全变了也要能进救援中心。宽松信号只做包含匹配，大小写不敏感；
  // 命中任一即视为失败页（前提仍然是根文本非空且没有健康 UI）。
  var LOOSE_FAILURE_SIGNALS = [
    "did not activate",
    "import failed",
    "client-modules",
    "pending (",
    "Failed to load",
    "web boot:",
    "waiting for service",
    "cannot activate",
    "loader entry"
  ];

  // ── 2. 运行时状态 ─────────────────────────────────────────────────────────
  var INSERTED = false;
  var observer = null;
  var watchStopTimer = null;
  var mountTimer = null;
  var restoreConfirmTimer = null;
  var safeModeConfirmTimer = null;
  var rollbackConfirmTimer = null;
  var panel = null;
  var isPreview = false;
  var failureText = "";
  // 兜底小胶囊状态：只存在于内存，不写任何浏览器存储。
  var capsule = null;
  var capsuleTimer = null;
  var capsuleDismissed = false;
  var healthySeen = false;
  // 健康 UI 快照去重时间戳（30s 内不重复 POST，契约第 6 节）。
  var healthySnapshotAt = 0;
  // loader 真实状态探针：本次页面只探一次；boot ready 等待的兜底定时器。
  var loaderProbe = false;
  var bootReadyTimer = null;
  var started = false;
  var model = {
    version: "", generatedAt: "", mode: "rows", writable: true,
    readOnlyReason: "", readOnlyReasonCode: "", warning: "",
    rowsPath: "", profileDir: "",
    entries: [], rescueRows: {}, suspects: {}, selected: {}, checks: [],
    filter: "user", query: "", busy: false, confirmRestore: false,
    confirmSafeMode: false, confirmRollback: false,
    // 1.2.0 新 state 字段（旧宿主缺失时保持空值，按老逻辑工作）。
    // known 表示宿主是否返回了 features 对象（= 支持 1.2.0 路由），仅用于客户端判断按钮可见性。
    features: { known: false, ledger: false, snapshot: false, quarantine: false, bundles: false, dualInject: false },
    inject: { tapIndex: "", indexInject: "", channels: 0 },
    ledger: { path: "", ok: false, error: "", entries: [] },
    bundles: { path: "", ok: false, count: 0, removable: [], protected: [] },
    quarantine: { bootFailed: false, bootFailedAt: "", files: [], profileDeps: { dependencies: [], peerDependencies: [] } },
    snapshot: { dir: "", ok: false, error: "", count: 0, keep: 5, latest: null },
    // 增量（Lead 2026-10-24 第二轮）：真实 loader 状态 / 宿主提示。
    loader: { ok: false, reason: "", pending: [], failed: [], counts: { active: 0, pending: 0, failed: 0 } },
    notice: "",
    statusText: "", statusTone: ""
  };
  // 弹窗独立状态：队列、当前弹窗、本页已弹过的 key（内存，不落任何存储）。
  var dialogQueue = [];
  var activeDialog = null;
  var dialogShown = {};
  var healthyNoticeChecked = false;

  // ── 3. 通用工具 ───────────────────────────────────────────────────────────
  function esc(value) {
    try {
      return String(value === undefined || value === null ? "" : value).replace(/[&<>"']/g, function (character) {
        return character === "&" ? "&amp;" : character === "<" ? "&lt;" : character === ">" ? "&gt;" : character === '"' ? "&quot;" : "&#39;";
      });
    } catch (error) {
      return "";
    }
  }

  function normalizeText(value) {
    try {
      return String(value === undefined || value === null ? "" : value).replace(/\s+/g, " ").trim();
    } catch (error) {
      return "";
    }
  }

  function asStringArray(value) {
    var output = [];
    var index;
    try {
      if (typeof value === "string") value = [value];
      if (!value || !value.length) return output;
      for (index = 0; index < value.length; index++) {
        var item = String(value[index] === undefined || value[index] === null ? "" : value[index]).trim();
        if (item && output.indexOf(item) === -1) output.push(item);
      }
    } catch (error) {
      return [];
    }
    return output;
  }

  // 服务端 skipped/merged 等列表既可能是字符串，也可能是 {id,reason} 对象；统一成可读标签。
  function asLabelArray(value) {
    var output = [];
    try {
      if (typeof value === "string") value = [value];
      if (!value || !value.length) return output;
      for (var index = 0; index < value.length; index++) {
        var item = value[index];
        var label = "";
        if (item && typeof item === "object") {
          label = String(item.id || item.name || item.reason || item.error || "");
        } else if (item !== undefined && item !== null) {
          label = String(item);
        }
        label = normalizeText(label);
        if (label && output.indexOf(label) === -1) output.push(label);
      }
    } catch (error) {
      return [];
    }
    return output;
  }

  function formatTime(value) {
    try {
      var date = new Date(value);
      if (isNaN(date.getTime())) return "";
      var pad = function (number) { return number < 10 ? "0" + number : String(number); };
      return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " +
        pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
    } catch (error) {
      return "";
    }
  }

  function errorMessage(error) {
    return error && error.message ? String(error.message) : "未知错误";
  }

  // ── 4. 条目判定 ───────────────────────────────────────────────────────────
  function groupKey(entry) {
    try {
      return String(entry.groupId || entry.packageName || entry.name || entry.id || "");
    } catch (error) {
      return "";
    }
  }

  function aliasesOf(raw) {
    var output = [];
    try {
      var list = raw && raw.aliases;
      for (var index = 0; list && index < list.length; index++) {
        var value = String(list[index] === undefined || list[index] === null ? "" : list[index]).trim();
        if (value && output.indexOf(value) === -1) output.push(value);
      }
    } catch (error) {
      return [];
    }
    return output;
  }

  // 防御式合并同 id 条目（服务端已去重，这里只做兜底）。
  function normalizeEntries(list) {
    var output = [];
    var byId = {};
    if (!list || !list.length) return output;
    try {
      for (var index = 0; index < list.length; index++) {
        var raw = list[index];
        if (!raw || !raw.id) continue;
        var id = String(raw.id);
        var entry = byId[id];
        if (!entry) {
          entry = {
            id: id, groupId: String(raw.groupId || ""),
            name: String(raw.name || raw.packageName || id), packageName: String(raw.packageName || ""),
            aliases: aliasesOf(raw), builtin: !!raw.builtin, protected: !!raw.protected,
            protectedReason: String(raw.protectedReason || ""), installed: raw.installed !== false,
            hasUserRow: !!raw.hasUserRow, disabled: !!raw.disabled,
            disabledByRescue: !!raw.disabledByRescue, actionable: raw.actionable !== false,
            inBundles: !!raw.inBundles, bundleRemovable: !!raw.bundleRemovable,
            bundleName: String(raw.bundleName || ""), levels: asStringArray(raw.levels),
            reason: String(raw.reason || "")
          };
          byId[id] = entry;
          output.push(entry);
          continue;
        }
        var extraAliases = aliasesOf(raw);
        for (var aliasIndex = 0; aliasIndex < extraAliases.length; aliasIndex++) {
          if (entry.aliases.indexOf(extraAliases[aliasIndex]) === -1) entry.aliases.push(extraAliases[aliasIndex]);
        }
        entry.hasUserRow = entry.hasUserRow || !!raw.hasUserRow;
        entry.installed = entry.installed || raw.installed !== false;
        entry.disabled = entry.disabled || !!raw.disabled;
        entry.disabledByRescue = entry.disabledByRescue || !!raw.disabledByRescue;
        entry.builtin = entry.builtin || !!raw.builtin;
        entry.protected = entry.protected || !!raw.protected;
        entry.actionable = entry.actionable && raw.actionable !== false;
        if (!entry.reason && raw.reason) entry.reason = String(raw.reason);
        if (!entry.protectedReason && raw.protectedReason) entry.protectedReason = String(raw.protectedReason);
        // 1.2.0：levels / bundle 字段按并集合并（旧宿主没有这些字段时保持空）。
        var extraLevels = asStringArray(raw.levels);
        for (var levelIndex = 0; levelIndex < extraLevels.length; levelIndex++) {
          if (entry.levels.indexOf(extraLevels[levelIndex]) === -1) entry.levels.push(extraLevels[levelIndex]);
        }
        entry.inBundles = entry.inBundles || !!raw.inBundles;
        entry.bundleRemovable = entry.bundleRemovable || !!raw.bundleRemovable;
        if (!entry.bundleName && raw.bundleName) entry.bundleName = String(raw.bundleName);
      }
    } catch (error) {
      return output;
    }
    return output;
  }

  // 1.2.0：entry 可用停用级别（"rows" | "patch" | "bundles"）。旧宿主没有该字段 → false。
  function hasLevel(entry, level) {
    try {
      return !!(entry && entry.levels && entry.levels.indexOf(level) !== -1);
    } catch (error) {
      return false;
    }
  }

  function findEntry(id) {
    try {
      for (var index = 0; index < model.entries.length; index++) {
        if (model.entries[index].id === id) return model.entries[index];
      }
    } catch (error) {
      return null;
    }
    return null;
  }

  function isRescueDisabled(entry) {
    try {
      return !!entry.disabledByRescue || !!model.rescueRows[entry.id];
    } catch (error) {
      return false;
    }
  }

  // 可写 + 非内置/受保护 + 未被救援停用 + 未被配置禁用。
  function isActionable(entry) {
    try {
      if (!entry || !model.writable || entry.actionable === false) return false;
      if (entry.builtin || entry.protected) return false;
      if (isRescueDisabled(entry) || entry.disabled) return false;
      return true;
    } catch (error) {
      return false;
    }
  }

  function isUserEntry(entry) {
    return !entry.builtin && !entry.protected;
  }

  // ── 5. 失败页检测与疑似识别（SPEC 4.2 + 契约 9.1）──────────────────────────
  function hasKnownFailure(text) {
    try {
      var index;
      for (index = 0; index < LOADER_HINT_PATTERNS.length; index++) {
        if (LOADER_HINT_PATTERNS[index].test(text)) return true;
      }
      return BUNDLE_HINT_PATTERN.test(text) || ACTIVATION_PATTERN.test(text) || PENDING_HINT_PATTERN.test(text)
        || IMPORT_FAILED_PATTERN.test(text);
    } catch (error) {
      return false;
    }
  }

  // 契约 9.1：已知正则之外再叠一层宽松包含匹配，覆盖「文案完全变了」的失败页。
  function hasLooseFailure(text) {
    try {
      var lower = String(text === undefined || text === null ? "" : text).toLowerCase();
      for (var index = 0; index < LOOSE_FAILURE_SIGNALS.length; index++) {
        if (lower.indexOf(String(LOOSE_FAILURE_SIGNALS[index]).toLowerCase()) !== -1) return true;
      }
    } catch (error) {
      return false;
    }
    return false;
  }

  // 失败页最终判定（契约 9.1）：无健康 UI + 根文本非空 + 命中标题/已知正则/宽松信号之一。
  function hasFailureSignal(text) {
    try {
      var value = String(text === undefined || text === null ? "" : text);
      if (value.indexOf(FAILURE_TITLE) !== -1) return true;
      return hasKnownFailure(value) || hasLooseFailure(value);
    } catch (error) {
      return false;
    }
  }

  // 从 client-modules 的 bundle URL 里尽力取出包名 / 插件 id。
  function packageNamesFromUrl(url) {
    var names = [];
    try {
      var value = String(url || "");
      try { value = decodeURIComponent(value); } catch (decodeError) { /* 用原始值继续 */ }
      var match = /\/plugins\/([^\/\s?#]+)\//.exec(value);
      if (match && match[1]) names.push(match[1]);
      match = /node_modules\/((?:@[^\/\s?#]+\/)?[^\/\s?#]+)/.exec(value);
      if (match && match[1]) names.push(match[1]);
      var file = value.split(/[?#]/)[0].split("/").pop() || "";
      if (file) {
        var base = file.replace(/\.(?:js|cjs|mjs|json)(?:\.map)?$/i, "");
        if (base) names.push(base);
      }
    } catch (error) {
      return names;
    }
    return names;
  }

  function collectHints(text) {
    var hints = [];
    var index;
    var match;
    try {
      for (index = 0; index < LOADER_HINT_PATTERNS.length; index++) {
        var pattern = new RegExp(LOADER_HINT_PATTERNS[index].source, "gi");
        while ((match = pattern.exec(text))) {
          if (match[1]) hints.push(match[1]);
          if (match[2]) hints.push(match[2]);
        }
      }
      var bundlePattern = new RegExp(BUNDLE_HINT_PATTERN.source, "gi");
      while ((match = bundlePattern.exec(text))) {
        var names = packageNamesFromUrl(match[1]);
        for (index = 0; index < names.length; index++) hints.push(names[index]);
      }
      var pendingPattern = new RegExp(PENDING_HINT_PATTERN.source, "gi");
      while ((match = pendingPattern.exec(text))) {
        if (match[1]) hints.push(match[1]);
      }
      var importFailedPattern = new RegExp(IMPORT_FAILED_PATTERN.source, "gi");
      while ((match = importFailedPattern.exec(text))) {
        if (match[1]) hints.push(match[1]);
      }
    } catch (error) {
      return hints;
    }
    return hints;
  }

  // 增量（Lead 第二轮第 4 条）：内置 / 受保护（含 protectedReason:"required" 的宿主骨架）条目
  // 不可停用，绝不自动标成疑似，避免误导用户。
  function suspectableEntry(entry) {
    try {
      if (!entry) return false;
      if (entry.builtin || entry.protected) return false;
      if (entry.protectedReason === "required") return false;
      return true;
    } catch (error) {
      return false;
    }
  }

  // 该 entry 在真实 loader 状态里缺哪些服务（用于「缺服务：xxx」提示）。
  function missingServicesOf(entry) {
    var output = [];
    try {
      if (!entry) return output;
      var values = [entry.id, entry.name, entry.packageName].concat(entry.aliases || []);
      for (var index = 0; index < model.loader.pending.length; index++) {
        var pending = model.loader.pending[index];
        var pendingId = String(pending.id || "").trim().toLowerCase();
        if (!pendingId) continue;
        var matched = false;
        for (var valueIndex = 0; valueIndex < values.length; valueIndex++) {
          var value = String(values[valueIndex] === undefined || values[valueIndex] === null ? "" : values[valueIndex]).trim().toLowerCase();
          if (value && value === pendingId) { matched = true; break; }
        }
        if (!matched) continue;
        var missing = pending.missing || [];
        for (var missingIndex = 0; missingIndex < missing.length; missingIndex++) {
          if (output.indexOf(missing[missingIndex]) === -1) output.push(missing[missingIndex]);
        }
      }
    } catch (error) {
      return output;
    }
    return output;
  }

  function identifySuspects(entries, text) {
    var suspects = {};
    var index;
    try {
      // 最高优先：真实 loader 状态里 pending / failed 的 entry id（增量第 1 条）。
      var loaderIds = [];
      for (index = 0; index < model.loader.pending.length; index++) loaderIds.push(model.loader.pending[index].id);
      for (index = 0; index < model.loader.failed.length; index++) loaderIds.push(model.loader.failed[index].id);
      for (index = 0; index < entries.length; index++) {
        var entry = entries[index];
        if (!suspectableEntry(entry)) continue;
        var values = [entry.id, entry.name, entry.packageName].concat(entry.aliases || []);
        for (var loaderIndex = 0; loaderIndex < loaderIds.length; loaderIndex++) {
          var loaderId = String(loaderIds[loaderIndex] === undefined || loaderIds[loaderIndex] === null ? "" : loaderIds[loaderIndex]).trim().toLowerCase();
          if (!loaderId) continue;
          var loaderHit = false;
          for (var valueIndex = 0; valueIndex < values.length; valueIndex++) {
            var value = String(values[valueIndex] === undefined || values[valueIndex] === null ? "" : values[valueIndex]).trim().toLowerCase();
            if (value && value === loaderId) { loaderHit = true; break; }
          }
          if (loaderHit) { suspects[entry.id] = true; break; }
        }
      }
      // 文案解析只作补充。
      var hints = collectHints(text);
      var lowerText = String(text || "").toLowerCase();
      var lowerHints = [];
      for (index = 0; index < hints.length; index++) {
        var hint = String(hints[index] === undefined || hints[index] === null ? "" : hints[index]).trim().toLowerCase();
        if (hint) lowerHints.push(hint);
      }
      for (index = 0; index < entries.length; index++) {
        var candidate = entries[index];
        if (suspects[candidate.id] || !suspectableEntry(candidate)) continue;
        var candidateValues = [candidate.id, candidate.name, candidate.packageName].concat(candidate.aliases || []);
        for (var candidateIndex = 0; candidateIndex < candidateValues.length; candidateIndex++) {
          var candidateValue = String(candidateValues[candidateIndex] === undefined || candidateValues[candidateIndex] === null ? "" : candidateValues[candidateIndex]).trim().toLowerCase();
          if (candidateValue && lowerHints.indexOf(candidateValue) !== -1) { suspects[candidate.id] = true; break; }
        }
      }
      // 兜底：较长且带 -/@/. 的 alias 出现在失败页文本里即命中（短 alias 只认精确命中）。
      for (index = 0; index < entries.length; index++) {
        if (suspects[entries[index].id] || !suspectableEntry(entries[index])) continue;
        var aliases = entries[index].aliases || [];
        for (var aliasIndex = 0; aliasIndex < aliases.length; aliasIndex++) {
          var alias = String(aliases[aliasIndex] || "").trim().toLowerCase();
          if (alias.length >= 5 && /[-@.]/.test(alias) && lowerText.indexOf(alias) !== -1) {
            suspects[entries[index].id] = true;
            break;
          }
        }
      }
      // 整插件：命中 entry 的同 groupId 条目全部视为疑似（整组停用）。
      var groups = {};
      for (index = 0; index < entries.length; index++) {
        if (suspects[entries[index].id]) groups[groupKey(entries[index])] = true;
      }
      for (index = 0; index < entries.length; index++) {
        if (groups[groupKey(entries[index])] && suspectableEntry(entries[index])) suspects[entries[index].id] = true;
      }
      // 最终再兜一层：任何 builtin / 受保护项都不留在疑似集合里。
      for (index = 0; index < entries.length; index++) {
        if (!suspectableEntry(entries[index])) delete suspects[entries[index].id];
      }
    } catch (error) {
      return suspects;
    }
    return suspects;
  }

  // 返回失败页根节点；健康 UI、空页、加载页一律返回 null（永不挂载）。
  function findFailureRoot() {
    try {
      var root = document.getElementById("root") || document.body;
      if (!root || !root.querySelector) return null;
      if (root.querySelector(HEALTHY_UI_SELECTOR)) return null;
      var text = normalizeText(root.textContent || "");
      if (!text) return null;
      failureText = text.slice(0, MAX_FAILURE_TEXT);
      // 契约 9.1 最终判定：标题 / 已知正则 / 宽松失败信号任一命中即挂载；
      // 三者都不命中时不猜（15s 小胶囊负责「文案完全变了」的兜底入口）。
      if (!hasFailureSignal(text)) return null;
      return root;
    } catch (error) {
      return null;
    }
  }

  // ── 6. state 归一化（SPEC 5.2）────────────────────────────────────────────
  // 日常检查项：{id,label,status:ok|warn|fail,detail}，只用于弹窗展示。
  function normalizeChecks(value) {
    var output = [];
    var index;
    try {
      if (!value || !value.length) return output;
      for (index = 0; index < value.length && index < 12; index++) {
        var item = value[index] || {};
        var label = String(item.label || "");
        if (!label) continue;
        var status = String(item.status || "ok");
        if (status !== "warn" && status !== "fail") status = "ok";
        output.push({
          id: String(item.id || ""),
          label: label,
          status: status,
          detail: String(item.detail || "")
        });
      }
    } catch (error) {
      return [];
    }
    return output;
  }

  // ── 6.5 1.2.0 新 state 字段归一化（契约第 3 节）────────────────────────────
  // 全部防御式：旧宿主（1.1.1）没有这些字段时保持空值，不抛错、也不显示新按钮。
  // features.known 只是客户端判断「宿主是否支持 1.2.0 路由」的依据，不属于契约字段。
  function normalizeFeatures(value, data) {
    var output = { known: false, ledger: false, snapshot: false, quarantine: false, bundles: false, dualInject: false };
    try {
      var raw = value && typeof value === "object" ? value : null;
      var source = raw || {};
      output.known = !!raw;
      var pick = function (name, present) {
        if (raw && source[name] !== undefined) return source[name] === true;
        return !!(data && present);
      };
      output.ledger = pick("ledger", data && data.ledger);
      output.snapshot = pick("snapshot", data && data.snapshot);
      output.quarantine = pick("quarantine", data && data.quarantine);
      output.bundles = pick("bundles", data && data.bundles);
      output.dualInject = pick("dualInject", data && data.inject && data.inject.channels !== undefined);
    } catch (error) {
      return { known: false, ledger: false, snapshot: false, quarantine: false, bundles: false, dualInject: false };
    }
    return output;
  }

  function normalizeInject(value) {
    var data = value && typeof value === "object" ? value : {};
    var channels = Number(data.channels);
    return {
      tapIndex: String(data.tapIndex || ""),
      indexInject: String(data.indexInject || ""),
      channels: isNaN(channels) ? 0 : Math.max(0, Math.min(2, Math.floor(channels)))
    };
  }

  // 增量（Lead 第二轮）：真实 loader 状态。ok:false 表示宿主还没拿到 loader（旧宿主 / 只读），
  // 此时一律按不可用降级，绝不影响文案判定。
  function normalizeLoader(value) {
    var output = { ok: false, reason: "", pending: [], failed: [], counts: { active: 0, pending: 0, failed: 0 } };
    try {
      var data = value && typeof value === "object" ? value : {};
      output.ok = data.ok === true;
      output.reason = String(data.reason || "");
      var index;
      var list = data.pending;
      for (index = 0; list && index < list.length && index < 64; index++) {
        var item = list[index] || {};
        var id = String(item.id || "").trim();
        if (!id) continue;
        output.pending.push({ id: id, name: String(item.name || ""), missing: asStringArray(item.missing) });
      }
      list = data.failed;
      for (index = 0; list && index < list.length && index < 64; index++) {
        var failedItem = list[index] || {};
        var failedId = String(failedItem.id || "").trim();
        if (!failedId) continue;
        output.failed.push({ id: failedId, name: String(failedItem.name || "") });
      }
      var counts = data.counts && typeof data.counts === "object" ? data.counts : {};
      output.counts.active = Number(counts.active) || 0;
      output.counts.pending = Number(counts.pending) || 0;
      output.counts.failed = Number(counts.failed) || 0;
    } catch (error) {
      return output;
    }
    return output;
  }

  // loader 明确报告 pending / failed 时，判定为失败页（最高优先级，契约增量第 1 条）。
  function loaderIndicatesFailure() {
    try {
      return !!(model.loader.ok && (model.loader.pending.length || model.loader.failed.length));
    } catch (error) {
      return false;
    }
  }

  function normalizeLedger(value) {
    var output = { path: "", ok: false, error: "", entries: [] };
    try {
      var data = value && typeof value === "object" ? value : {};
      output.path = String(data.path || "");
      output.ok = data.ok === true;
      output.error = String(data.error || "");
      var list = data.entries;
      for (var index = 0; list && index < list.length && index < 200; index++) {
        var item = list[index] || {};
        var id = String(item.id || "").trim();
        if (!id) continue;
        var mode = String(item.mode || item.level || "");
        if (mode !== "rows" && mode !== "patch" && mode !== "bundles") mode = "rows";
        output.entries.push({
          id: id,
          at: String(item.at || ""),
          mode: mode,
          level: mode,
          file: String(item.file || ""),
          blockDigest: String(item.blockDigest || ""),
          fileDigestAfter: String(item.fileDigestAfter || "")
        });
      }
    } catch (error) {
      return output;
    }
    return output;
  }

  function normalizeBundles(value) {
    var output = { path: "", ok: false, count: 0, removable: [], protected: [] };
    try {
      var data = value && typeof value === "object" ? value : {};
      var count = Number(data.count);
      output.path = String(data.path || "");
      output.ok = data.ok === true;
      output.count = isNaN(count) ? 0 : Math.max(0, Math.floor(count));
      output.protected = asStringArray(data.protected);
      var list = data.removable;
      for (var index = 0; list && index < list.length && index < 64; index++) {
        var item = list[index] || {};
        var name = String(item.name || "").trim();
        if (!name) continue;
        output.removable.push({ name: name, entries: asStringArray(item.entries) });
      }
    } catch (error) {
      return output;
    }
    return output;
  }

  function normalizeQuarantine(value) {
    var output = { bootFailed: false, bootFailedAt: "", files: [], profileDeps: { dependencies: [], peerDependencies: [] } };
    try {
      var data = value && typeof value === "object" ? value : {};
      output.bootFailed = data.bootFailed === true;
      output.bootFailedAt = String(data.bootFailedAt || "");
      var list = data.files;
      for (var index = 0; list && index < list.length && index < 50; index++) {
        var item = list[index] || {};
        var name = String(item.name || "").trim();
        if (!name) continue;
        output.files.push({
          name: name,
          path: String(item.path || ""),
          at: String(item.at || ""),
          bytes: Number(item.bytes) || 0,
          rows: Number(item.rows) || 0,
          rescueBlocks: Number(item.rescueBlocks) || 0,
          mergeable: item.mergeable !== false,
          reason: String(item.reason || "")
        });
      }
      var deps = data.profileDeps && typeof data.profileDeps === "object" ? data.profileDeps : {};
      output.profileDeps.dependencies = asStringArray(deps.dependencies);
      output.profileDeps.peerDependencies = asStringArray(deps.peerDependencies);
    } catch (error) {
      return output;
    }
    return output;
  }

  function normalizeSnapshot(value) {
    var output = { dir: "", ok: false, error: "", count: 0, keep: 5, latest: null };
    try {
      var data = value && typeof value === "object" ? value : {};
      var count = Number(data.count);
      var keep = Number(data.keep);
      output.dir = String(data.dir || "");
      output.ok = data.ok === true;
      output.error = String(data.error || "");
      output.count = isNaN(count) ? 0 : Math.max(0, Math.floor(count));
      output.keep = isNaN(keep) || keep <= 0 ? 5 : Math.floor(keep);
      var latest = data.latest;
      if (latest && typeof latest === "object") {
        var id = String(latest.id || "").trim();
        if (id) {
          output.latest = {
            id: id,
            at: String(latest.at || ""),
            reason: String(latest.reason || ""),
            rowsBytes: Number(latest.rowsBytes) || 0,
            bundlesCount: Number(latest.bundlesCount) || 0
          };
        }
      }
    } catch (error) {
      return output;
    }
    return output;
  }

  function normalizeState(state) {
    try {
      var data = state || {};
      model.version = String(data.version || "");
      model.generatedAt = String(data.generatedAt || "");
      model.mode = String(data.mode || "rows");
      model.writable = data.writable !== false;
      model.readOnlyReason = String(data.readOnlyReason || "");
      model.readOnlyReasonCode = String(data.readOnlyReasonCode || "");
      model.warning = String(data.warning || "");
      model.rowsPath = String(data.rowsPath || "");
      model.profileDir = String(data.profileDir || "");
      model.entries = normalizeEntries(data.entries);
      model.checks = normalizeChecks(data.checks);
      // 1.2.0 新字段：宿主没给就保持空模型（旧宿主按老逻辑工作）。
      model.features = normalizeFeatures(data.features, data);
      model.inject = normalizeInject(data.inject);
      model.ledger = normalizeLedger(data.ledger);
      model.bundles = normalizeBundles(data.bundles);
      model.quarantine = normalizeQuarantine(data.quarantine);
      model.snapshot = normalizeSnapshot(data.snapshot);
      model.loader = normalizeLoader(data.loader);
      model.notice = normalizeText(data.notice || "");
      model.rescueRows = {};
      var index;
      var rescue = asStringArray(data.rescueRows);
      for (index = 0; index < rescue.length; index++) model.rescueRows[rescue[index]] = true;
      for (index = 0; index < model.entries.length; index++) {
        if (model.rescueRows[model.entries[index].id]) model.entries[index].disabledByRescue = true;
      }
      model.suspects = identifySuspects(model.entries, failureText);
      model.selected = {};
      model.query = "";
      model.busy = false;
      model.confirmRestore = false;
      model.confirmSafeMode = false;
      model.confirmRollback = false;
      model.statusText = "";
      model.statusTone = "";
      var actionableSuspects = 0;
      for (index = 0; index < model.entries.length; index++) {
        var suspectEntry = model.entries[index];
        if (model.suspects[suspectEntry.id] && isActionable(suspectEntry)) actionableSuspects++;
      }
      // 有「可操作」疑似时默认看「疑似故障」，否则默认「用户插件」。
      // 疑似高亮与诊断条不受影响：全部疑似项都受保护/不可操作时不再落入空标签页。
      model.filter = actionableSuspects ? "suspect" : "user";
      // 自动勾选所有可操作的疑似项（最多 32 项）。
      var selected = 0;
      for (index = 0; index < model.entries.length; index++) {
        var entry = model.entries[index];
        if (!model.suspects[entry.id] || !isActionable(entry)) continue;
        if (selected >= MAX_SELECTION) break;
        model.selected[entry.id] = true;
        selected++;
      }
    } catch (error) {
      model.entries = [];
      model.suspects = {};
      model.selected = {};
    }
  }

  // ── 7. 样式（固定覆盖层 + 暗色适配，类前缀统一 dbr-）──────────────────────
  function detectDark() {
    try {
      if (document.body && document.body.hasAttribute("data-ds-dark-theme")) return true;
      if (document.documentElement && document.documentElement.hasAttribute("data-ds-dark-theme")) return true;
      if (document.documentElement) {
        var explicit = document.documentElement.getAttribute("data-theme") || document.documentElement.getAttribute("data-color-scheme");
        if (explicit === "dark") return true;
        if (explicit === "light") return false;
      }
      return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    } catch (error) {
      return false;
    }
  }

  function injectStyles() {
    try {
      if (document.getElementById("dshm-boot-rescue-styles")) return;
      var style = document.createElement("style");
      style.id = "dshm-boot-rescue-styles";
      style.textContent = [
        ".dbr-overlay{--dbr-bg:#fff;--dbr-raised:#f5f6f8;--dbr-hover:#edf1f5;--dbr-border:#dde2e8;--dbr-border-strong:#c4ccd5;--dbr-text:#1c232b;--dbr-muted:#68727e;--dbr-faint:#8a939e;--dbr-accent:#c4543a;--dbr-accent-hover:#ab452d;--dbr-accent-ink:#fff;--dbr-warn-bg:#fff6e8;--dbr-warn-border:#ecc78d;--dbr-warn-text:#8a4a15;--dbr-danger:#c34a4a;--dbr-ok:#2b8f68;position:fixed;inset:0;z-index:2147483000;overflow:auto;overscroll-behavior:contain;padding:24px 12px 56px;background:rgba(10,14,20,.5);color:var(--dbr-text);font:13px/1.55 'HarmonyOS Sans',Inter,system-ui,-apple-system,'Segoe UI',sans-serif;text-align:left;-webkit-overflow-scrolling:touch}",
        ".dbr-overlay.dbr-dark{--dbr-bg:#1a1d21;--dbr-raised:#24272c;--dbr-hover:#2b2f35;--dbr-border:#33383f;--dbr-border-strong:#464d56;--dbr-text:#eef1f4;--dbr-muted:#a6aeb8;--dbr-faint:#7e8893;--dbr-accent:#e07a5f;--dbr-accent-hover:#ea8b72;--dbr-accent-ink:#17191c;--dbr-warn-bg:#2c241c;--dbr-warn-border:#6b4a27;--dbr-warn-text:#f1bd80;--dbr-danger:#e06868;--dbr-ok:#54b98d;background:rgba(0,0,0,.6)}",
        ".dbr-overlay *,.dbr-overlay *:before,.dbr-overlay *:after{box-sizing:border-box}.dbr-overlay [hidden]{display:none!important}.dbr-overlay button,.dbr-overlay input{font:inherit;color:inherit}.dbr-overlay button{appearance:none;border:0;background:transparent;cursor:pointer}.dbr-svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;display:block;flex:0 0 auto}",
        ".dbr-card{width:min(760px, calc(100% - 24px));margin:0 auto;background:var(--dbr-bg);border:1px solid var(--dbr-border);border-radius:18px;box-shadow:0 18px 60px rgba(8,12,18,.28);overflow:hidden}",
        ".dbr-head{display:flex;align-items:flex-start;gap:14px;padding:20px 22px 16px;border-bottom:1px solid var(--dbr-border)}",
        ".dbr-emblem{width:42px;height:42px;display:flex;align-items:center;justify-content:center;flex:0 0 auto;color:var(--dbr-accent);background:var(--dbr-raised);border:1px solid var(--dbr-border);border-radius:12px}.dbr-emblem .dbr-svg{width:23px;height:23px}",
        ".dbr-head-main{min-width:0;flex:1}.dbr-kicker{display:flex;align-items:center;gap:8px;color:var(--dbr-muted);font-size:10px;font-weight:700;letter-spacing:.12em}.dbr-live{display:inline-flex;align-items:center;gap:5px;letter-spacing:0;font-weight:600;text-transform:none}.dbr-dot{width:6px;height:6px;border-radius:50%;background:var(--dbr-ok);box-shadow:0 0 0 3px rgba(43,143,104,.14)}.dbr-live.dbr-readonly-state .dbr-dot{background:var(--dbr-warn-text);box-shadow:0 0 0 3px rgba(210,138,62,.16)}.dbr-live.dbr-degraded-state .dbr-dot{background:var(--dbr-danger);box-shadow:0 0 0 3px rgba(195,74,74,.16)}.dbr-live.dbr-preview-state .dbr-dot{background:var(--dbr-faint);box-shadow:none}",
        ".dbr-title{font-size:19px;line-height:1.35;font-weight:650;letter-spacing:-.01em;margin-top:3px}.dbr-subtitle{margin-top:3px;color:var(--dbr-muted);font-size:12px}.dbr-version{margin-top:3px;color:var(--dbr-faint);font:10px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace}",
        ".dbr-preview{flex:0 0 auto;padding:3px 9px;border:1px solid var(--dbr-warn-border);border-radius:999px;background:var(--dbr-warn-bg);color:var(--dbr-warn-text);font-size:10px;font-weight:650;white-space:nowrap}",
        ".dbr-diagnosis{display:flex;align-items:center;gap:11px;margin:14px 20px 0;padding:11px 12px;border:1px solid var(--dbr-warn-border);border-radius:11px;background:var(--dbr-warn-bg);color:var(--dbr-warn-text)}.dbr-diagnosis .dbr-svg{flex:0 0 auto}.dbr-diagnosis-text{min-width:0;flex:1}.dbr-diagnosis-text strong{display:block;font-size:12px}.dbr-diagnosis-text span{display:block;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:11px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace}.dbr-diagnosis-note{flex:0 0 auto;font-size:10px;font-weight:650}",
        ".dbr-warning{display:flex;align-items:flex-start;gap:10px;margin:12px 20px 0;padding:11px 12px;border:1px solid var(--dbr-warn-border);border-left:3px solid var(--dbr-danger);border-radius:10px;background:var(--dbr-warn-bg);color:var(--dbr-warn-text)}.dbr-warning .dbr-svg{margin-top:1px;color:var(--dbr-danger)}.dbr-warning-text strong{display:block;font-size:12px}.dbr-warning-text span{display:block;margin-top:2px;font-size:11.5px;line-height:1.5}",
        ".dbr-notice{display:flex;flex-direction:column;gap:2px;margin:14px 20px 0;padding:11px 13px;border-left:3px solid var(--dbr-accent);border-radius:8px;background:var(--dbr-raised)}.dbr-notice strong{font-size:12.5px}.dbr-notice span{color:var(--dbr-muted);font-size:11.5px}",
        ".dbr-controls{padding:14px 20px 8px}.dbr-search{width:100%;height:40px;padding:0 12px;color:var(--dbr-text);background:var(--dbr-raised);border:1px solid var(--dbr-border-strong);border-radius:10px;outline:none}.dbr-search::placeholder{color:var(--dbr-faint)}.dbr-search:focus{border-color:var(--dbr-accent);box-shadow:0 0 0 3px rgba(196,84,58,.16)}",
        ".dbr-tabs{display:flex;align-items:center;gap:3px;margin-top:10px;overflow-x:auto;scrollbar-width:none}.dbr-tabs::-webkit-scrollbar{display:none}.dbr-tab{min-height:32px;padding:5px 10px;border-radius:8px;color:var(--dbr-muted);font-size:11.5px;white-space:nowrap}.dbr-tab:hover{background:var(--dbr-hover)}.dbr-tab[aria-selected='true']{color:var(--dbr-text);background:var(--dbr-raised);font-weight:650}",
        ".dbr-list-meta{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 20px;min-height:30px;color:var(--dbr-muted);font-size:11px}.dbr-meta-actions{display:flex;gap:12px}.dbr-text-btn{padding:3px 0;color:var(--dbr-muted);font-size:11px}.dbr-text-btn:hover{color:var(--dbr-text)}.dbr-text-btn[disabled]{opacity:.4;cursor:not-allowed}",
        ".dbr-list{max-height:42vh;overflow:auto;padding:0 12px 8px;scrollbar-color:var(--dbr-border-strong) transparent}",
        ".dbr-item{display:flex;align-items:center;gap:10px;min-height:54px;padding:7px 9px;border:1px solid transparent;border-radius:10px}.dbr-item+.dbr-item{margin-top:3px}.dbr-item:hover{background:var(--dbr-hover)}.dbr-item.dbr-selected{border-color:var(--dbr-accent);background:var(--dbr-raised)}.dbr-item.dbr-suspect:not(.dbr-selected){border-color:var(--dbr-warn-border)}.dbr-item-main{display:flex;align-items:center;gap:10px;flex:1;min-width:0;cursor:pointer}.dbr-item-main.dbr-inert{cursor:default}",
        ".dbr-check{width:18px;height:18px;flex:0 0 auto;accent-color:var(--dbr-accent);cursor:pointer}.dbr-check[disabled]{cursor:not-allowed;opacity:.4}.dbr-plugin{display:flex;flex-direction:column;min-width:0;flex:1;gap:1px}.dbr-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;font-weight:600}.dbr-meta{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dbr-muted);font:10.5px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace}",
        ".dbr-badges{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:4px;flex:0 1 auto;max-width:46%}.dbr-badge{padding:2px 7px;border:1px solid var(--dbr-border);border-radius:999px;background:var(--dbr-raised);color:var(--dbr-muted);font-size:10px;font-weight:600;white-space:nowrap}.dbr-badge-warn{border-color:var(--dbr-warn-border);background:var(--dbr-warn-bg);color:var(--dbr-warn-text)}.dbr-badge-info{border-color:var(--dbr-border-strong);color:var(--dbr-text)}.dbr-badge-muted{opacity:.85}",
        ".dbr-row-btn{flex:0 0 auto;min-height:28px;padding:3px 9px;border:1px solid var(--dbr-border-strong);border-radius:7px;font-size:11px;font-weight:600;white-space:nowrap}.dbr-row-btn:hover{background:var(--dbr-hover)}.dbr-row-btn[disabled]{opacity:.4;cursor:not-allowed}.dbr-empty{padding:28px 12px;text-align:center;color:var(--dbr-muted);font-size:12px}",
        ".dbr-readonly{margin:12px 20px 0;padding:12px 14px;border:1px solid var(--dbr-warn-border);border-radius:10px;background:var(--dbr-warn-bg);color:var(--dbr-warn-text);font-size:11.5px;line-height:1.55}.dbr-readonly-title{font-size:12px;font-weight:650;margin-bottom:4px}.dbr-readonly p{margin:4px 0 0}.dbr-readonly code,.dbr-fallback code{display:inline-block;padding:1px 5px;border-radius:5px;background:rgba(0,0,0,.06);font:11px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;word-break:break-all}",
        ".dbr-dark .dbr-readonly code,.dbr-dark .dbr-fallback code{background:rgba(255,255,255,.08)}",
        ".dbr-foot{display:flex;flex-direction:column;gap:10px;margin-top:14px;padding:14px 20px 16px;border-top:1px solid var(--dbr-border);background:var(--dbr-raised)}.dbr-status{min-height:18px;color:var(--dbr-muted);font-size:11.5px}.dbr-status[data-tone='error']{color:var(--dbr-danger)}.dbr-status[data-tone='success']{color:var(--dbr-ok)}.dbr-status[data-tone='warn']{color:var(--dbr-warn-text)}.dbr-status[data-tone='preview']{color:var(--dbr-warn-text)}.dbr-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px}.dbr-foot-hint{color:var(--dbr-warn-text);font-size:11px;line-height:1.5;word-break:break-word}",
        ".dbr-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:38px;padding:7px 14px;border:1px solid var(--dbr-border-strong);border-radius:10px;background:var(--dbr-bg);font-size:12px;font-weight:600;white-space:nowrap}.dbr-btn:hover{background:var(--dbr-hover)}.dbr-btn .dbr-svg{width:15px;height:15px}.dbr-btn.dbr-primary{border-color:var(--dbr-accent);background:var(--dbr-accent);color:var(--dbr-accent-ink)}.dbr-btn.dbr-primary:hover{background:var(--dbr-accent-hover);border-color:var(--dbr-accent-hover)}.dbr-btn.dbr-restore-confirm{border-color:var(--dbr-warn-border);background:var(--dbr-warn-bg);color:var(--dbr-warn-text)}.dbr-btn[disabled]{opacity:.45;cursor:not-allowed}",
        ".dbr-overlay button:focus-visible,.dbr-overlay input:focus-visible{outline:2px solid var(--dbr-accent);outline-offset:2px}",
        ".dbr-fallback-body{padding:24px}.dbr-fallback-body p{margin:10px 0 0;color:var(--dbr-muted);font-size:12px;line-height:1.6}.dbr-fallback-body .dbr-title{font-size:17px}.dbr-hint{color:var(--dbr-warn-text)!important}",
        "@media(max-width:640px){.dbr-overlay{padding:12px 8px 32px}.dbr-card{width:calc(100% - 16px);border-radius:14px}.dbr-head{padding:16px 15px 13px}.dbr-controls{padding:12px 15px 6px}.dbr-diagnosis,.dbr-notice,.dbr-warning,.dbr-readonly{margin-left:15px;margin-right:15px}.dbr-list-meta{padding:0 15px}.dbr-list{padding-left:7px;padding-right:7px;max-height:38vh}.dbr-foot{padding:12px 15px 14px}.dbr-actions{display:grid;grid-template-columns:1fr 1fr}.dbr-actions .dbr-primary{grid-column:1/-1}.dbr-btn{min-height:42px}.dbr-badges{max-width:38%}}",
        ".dbr-dialog{--dbr-bg:#fff;--dbr-raised:#f5f6f8;--dbr-hover:#edf1f5;--dbr-border:#dde2e8;--dbr-border-strong:#c4ccd5;--dbr-text:#1c232b;--dbr-muted:#68727e;--dbr-accent:#c4543a;--dbr-accent-hover:#ab452d;--dbr-accent-ink:#fff;--dbr-warn-bg:#fff6e8;--dbr-warn-border:#ecc78d;--dbr-warn-text:#8a4a15;--dbr-danger:#c34a4a;--dbr-ok:#2b8f68;position:fixed;inset:0;z-index:2147483001;display:flex;align-items:center;justify-content:center;padding:20px;overflow:auto;overscroll-behavior:contain;background:rgba(10,14,20,.55);color:var(--dbr-text);font:13px/1.55 'HarmonyOS Sans',Inter,system-ui,-apple-system,'Segoe UI',sans-serif;text-align:left;-webkit-overflow-scrolling:touch}",
        ".dbr-dialog.dbr-dark{--dbr-bg:#1a1d21;--dbr-raised:#24272c;--dbr-hover:#2b2f35;--dbr-border:#33383f;--dbr-border-strong:#464d56;--dbr-text:#eef1f4;--dbr-muted:#a6aeb8;--dbr-accent:#e07a5f;--dbr-accent-hover:#ea8b72;--dbr-accent-ink:#17191c;--dbr-warn-bg:#2c241c;--dbr-warn-border:#6b4a27;--dbr-warn-text:#f1bd80;--dbr-danger:#e06868;--dbr-ok:#54b98d;background:rgba(0,0,0,.64)}",
        ".dbr-dialog *,.dbr-dialog *:before,.dbr-dialog *:after{box-sizing:border-box}",
        ".dbr-dialog-card{width:min(460px,100%);max-height:calc(100% - 8px);overflow:auto;background:var(--dbr-bg);border:1px solid var(--dbr-border);border-radius:16px;box-shadow:0 18px 60px rgba(8,12,18,.32);animation:dbr-pop .18s ease-out}",
        ".dbr-dialog-head{display:flex;align-items:flex-start;gap:12px;padding:18px 20px 10px}",
        ".dbr-dialog-icon{width:36px;height:36px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;border:1px solid var(--dbr-border);border-radius:10px;background:var(--dbr-raised);color:var(--dbr-accent)}.dbr-dialog-icon .dbr-svg{width:20px;height:20px}",
        ".dbr-tone-warn .dbr-dialog-icon{border-color:var(--dbr-warn-border);background:var(--dbr-warn-bg);color:var(--dbr-warn-text)}",
        ".dbr-tone-danger .dbr-dialog-icon{border-color:var(--dbr-danger);color:var(--dbr-danger)}",
        ".dbr-tone-success .dbr-dialog-icon{border-color:var(--dbr-ok);color:var(--dbr-ok)}",
        ".dbr-dialog-heading{min-width:0;flex:1}",
        ".dbr-dialog-kicker{color:var(--dbr-muted);font-size:9px;font-weight:700;letter-spacing:.14em}",
        ".dbr-dialog-title{margin-top:2px;font-size:15.5px;line-height:1.4;font-weight:650;letter-spacing:-.01em}",
        ".dbr-dialog-body{padding:0 20px 2px;color:var(--dbr-muted);font-size:12px;line-height:1.62}",
        ".dbr-dialog-body p{margin:8px 0 0}.dbr-tone-danger .dbr-dialog-body{color:var(--dbr-warn-text)}.dbr-dialog-body strong{color:var(--dbr-text)}",
        ".dbr-dialog-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;padding:14px 20px 16px}",
        ".dbr-dialog .dbr-btn{min-height:36px;appearance:none;cursor:pointer;color:inherit;font:inherit;font-size:12px;font-weight:600}",
        ".dbr-dialog button:focus-visible{outline:2px solid var(--dbr-accent);outline-offset:2px}",
        "@keyframes dbr-pop{from{opacity:0;transform:translateY(8px) scale(.985)}to{opacity:1;transform:none}}",
        "@keyframes dbr-fade{from{opacity:0}to{opacity:1}}",
        "@media(max-width:640px){.dbr-dialog{padding:12px}.dbr-dialog-card{width:100%;max-height:calc(100% - 4px);border-radius:14px}.dbr-dialog-head{padding:16px 16px 8px}.dbr-dialog-body{padding:0 16px}.dbr-dialog-actions{padding:12px 16px 14px}.dbr-dialog-actions .dbr-btn{flex:1 1 auto}}",
        ".dbr-checks{margin:10px 20px 0;border:1px solid var(--dbr-border);border-radius:10px;overflow:hidden;background:var(--dbr-raised)}",
        ".dbr-check-row{display:flex;align-items:flex-start;gap:8px;padding:7px 10px;font-size:11px;line-height:1.45;border-top:1px solid var(--dbr-border)}",
        ".dbr-check-row:first-child{border-top:0}",
        ".dbr-check-mark{flex:0 0 auto;width:14px;text-align:center;font-weight:700}",
        ".dbr-check-ok .dbr-check-mark{color:var(--dbr-ok)}",
        ".dbr-check-warn .dbr-check-mark{color:var(--dbr-warn-text)}",
        ".dbr-check-fail .dbr-check-mark{color:var(--dbr-danger)}",
        ".dbr-check-label{flex:0 0 auto;color:var(--dbr-text);font-weight:600}",
        ".dbr-check-detail{flex:1;min-width:0;color:var(--dbr-muted);word-break:break-all}",
        "@media(max-width:640px){.dbr-checks{margin-left:16px;margin-right:16px}.dbr-check-row{flex-wrap:wrap;gap:2px 8px}}",
        "@media(prefers-reduced-motion:reduce){.dbr-dialog *{animation:none!important;transition:none!important}}",
        "@media(prefers-reduced-motion:reduce){.dbr-overlay *{animation:none!important;transition:none!important}}",
        ".dbr-sections{display:flex;flex-direction:column;gap:8px;padding:2px 20px 0;margin-top:2px}",
        ".dbr-section{border:1px solid var(--dbr-border);border-radius:10px;background:var(--dbr-raised);overflow:hidden}",
        ".dbr-section-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 11px;border-bottom:1px solid var(--dbr-border)}.dbr-section-title{font-size:11.5px;font-weight:700;letter-spacing:.02em}.dbr-section-meta{color:var(--dbr-muted);font-size:10.5px;white-space:nowrap}",
        ".dbr-section-body{display:flex;flex-direction:column;gap:6px;padding:8px 11px}",
        ".dbr-section-line{color:var(--dbr-muted);font-size:11px;line-height:1.5;word-break:break-word}.dbr-section-line strong{color:var(--dbr-text)}.dbr-section-warn{color:var(--dbr-warn-text)}",
        ".dbr-section-actions{display:flex;flex-wrap:wrap;gap:8px}",
        ".dbr-quarantine-item{display:flex;align-items:center;flex-wrap:wrap;gap:6px 8px}.dbr-quarantine-name{min-width:0;flex:1 1 150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dbr-text);font:10.5px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace}.dbr-quarantine-meta{flex:0 1 auto;color:var(--dbr-muted);font-size:10.5px}",
        ".dbr-ledger-row{display:flex;align-items:center;gap:8px;color:var(--dbr-muted);font-size:10.5px;line-height:1.45}.dbr-ledger-id{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dbr-text);font:10.5px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace}",
        ".dbr-row-btn.dbr-row-btn-bundle{border-color:var(--dbr-warn-border);color:var(--dbr-warn-text)}",
        ".dbr-capsule{position:fixed;right:16px;bottom:18px;z-index:2147483000;display:flex;align-items:center;gap:7px;padding:9px 14px 9px 11px;border:1px solid #ecc78d;border-radius:999px;background:#fff6e8;color:#8a4a15;box-shadow:0 10px 30px rgba(8,12,18,.22);font:12px/1.2 'HarmonyOS Sans',Inter,system-ui,-apple-system,'Segoe UI',sans-serif;font-weight:650;cursor:pointer;animation:dbr-pop .18s ease-out}.dbr-capsule .dbr-svg{width:16px;height:16px}.dbr-capsule.dbr-capsule-dark{border-color:#6b4a27;background:#2c241c;color:#f1bd80}.dbr-capsule:focus-visible{outline:2px solid #c4543a;outline-offset:3px}.dbr-capsule[hidden]{display:none!important}",
        "@media(max-width:640px){.dbr-sections{padding-left:15px;padding-right:15px}.dbr-capsule{right:12px;bottom:14px;padding:8px 12px 8px 10px}}"
      ].join("");
      document.head.appendChild(style);
    } catch (error) {
      // 样式失败不影响功能：面板仍可操作，只是无样式。
    }
  }

  // ── 8. 同源 API ───────────────────────────────────────────────────────────
  function api(url, options) {
    try {
      var init = { credentials: "same-origin" };
      if (options) {
        if (options.method) init.method = options.method;
        if (options.headers) init.headers = options.headers;
        if (options.body !== undefined) init.body = options.body;
      }
      return fetch(url, init).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (body) {
          if (!response.ok || (body && body.ok === false)) {
            var failure = new Error((body && body.error) || ("HTTP " + response.status));
            failure.code = (body && body.code) || "";
            throw failure;
          }
          return body || {};
        });
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function postJSON(url, payload) {
    return api(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload || {}) });
  }

  // ── 9. 数据视图 ───────────────────────────────────────────────────────────
  function countSelected() {
    try { return Object.keys(model.selected).length; } catch (error) { return 0; }
  }

  function countRescueRows() {
    try { return Object.keys(model.rescueRows).length; } catch (error) { return 0; }
  }

  function selectedActionableIds() {
    var ids = [];
    try {
      for (var index = 0; index < model.entries.length; index++) {
        var entry = model.entries[index];
        if (model.selected[entry.id] && isActionable(entry)) ids.push(entry.id);
      }
    } catch (error) {
      return ids;
    }
    return ids;
  }

  function suspectEntries() {
    var output = [];
    try {
      for (var index = 0; index < model.entries.length; index++) {
        if (model.suspects[model.entries[index].id]) output.push(model.entries[index]);
      }
    } catch (error) {
      return output;
    }
    return output;
  }

  function suspectText() {
    var suspects = suspectEntries();
    var names = [];
    for (var index = 0; index < suspects.length; index++) {
      names.push((suspects[index].name || suspects[index].id) + " [" + suspects[index].id + "]");
    }
    return names.join(", ");
  }

  function filteredEntries() {
    var output = [];
    try {
      var query = model.query.trim().toLowerCase();
      for (var index = 0; index < model.entries.length; index++) {
        var entry = model.entries[index];
        if (query) {
          var haystack = [entry.name, entry.id, entry.packageName].concat(entry.aliases || []).join(" ").toLowerCase();
          if (haystack.indexOf(query) !== -1) output.push(entry);
          continue;
        }
        if (model.filter === "suspect" && !model.suspects[entry.id]) continue;
        if (model.filter === "user" && !isUserEntry(entry)) continue;
        if (model.filter === "rescue" && !isRescueDisabled(entry) && !entry.disabled) continue;
        output.push(entry);
      }
      output.sort(function (left, right) {
        var suspectDelta = (model.suspects[right.id] ? 1 : 0) - (model.suspects[left.id] ? 1 : 0);
        if (suspectDelta) return suspectDelta;
        var actionableDelta = (isActionable(right) ? 1 : 0) - (isActionable(left) ? 1 : 0);
        if (actionableDelta) return actionableDelta;
        var leftName = String(left.name || left.id).toLowerCase();
        var rightName = String(right.name || right.id).toLowerCase();
        return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
      });
    } catch (error) {
      return output;
    }
    return output;
  }

  // ── 10. 面板渲染 ──────────────────────────────────────────────────────────
  var ICONS = {
    rescue: '<svg class="dbr-svg" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.4"/><path d="M5.7 5.7 9.3 9.3m5.4 5.4 3.6 3.6m0-12.6-3.6 3.6m-5.4 5.4-3.6 3.6"/></svg>',
    warning: '<svg class="dbr-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M10.3 4.1 2.6 17.5A1.7 1.7 0 0 0 4.1 20h15.8a1.7 1.7 0 0 0 1.5-2.5L13.7 4.1a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4m0 3.4v.01"/></svg>',
    copy: '<svg class="dbr-svg" viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
    arrow: '<svg class="dbr-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5"/></svg>',
    check: '<svg class="dbr-svg" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8 12.4 2.7 2.7L16 9.6"/></svg>'
  };

  function buildOverlay() {
    injectStyles();
    var overlay = document.createElement("div");
    overlay.className = "dbr-overlay" + (detectDark() ? " dbr-dark" : "");
    overlay.id = "dshm-boot-rescue-overlay";
    overlay.innerHTML = [
      '<section class="dbr-card" role="dialog" aria-labelledby="dbr-title">',
      '<header class="dbr-head">',
      '<div class="dbr-emblem">' + ICONS.rescue + '</div>',
      '<div class="dbr-head-main">',
      '<div class="dbr-kicker">DSHM BOOT RESCUE<span class="dbr-live" data-role="service-state"><span class="dbr-dot"></span><span data-role="service-label">救援服务在线</span></span></div>',
      '<div class="dbr-title" id="dbr-title">启动恢复中心</div>',
      '<div class="dbr-subtitle">插件加载中断。这里可以定位故障插件并临时停用，让 DSHM 恢复启动。</div>',
      '<div class="dbr-version" data-role="version"></div>',
      '</div>',
      '<span class="dbr-preview" data-role="preview-badge" hidden>只读自检</span>',
      '</header>',
      '<div class="dbr-diagnosis" data-role="diagnosis" hidden>' + ICONS.warning + '<div class="dbr-diagnosis-text"><strong>已定位疑似故障插件</strong><span data-role="suspects"></span></div><span class="dbr-diagnosis-note">已自动勾选</span></div>',
      '<div class="dbr-warning" data-role="state-notice" hidden>' + ICONS.warning + '<div class="dbr-warning-text"><strong>启动残留提示</strong><span data-role="state-notice-text"></span></div></div>',
      '<div class="dbr-warning" data-role="warning" hidden>' + ICONS.warning + '<div class="dbr-warning-text"><strong data-role="warning-title">降级模式警示</strong><span data-role="warning-text"></span></div></div>',
      '<div class="dbr-notice"><strong>' + RESTART_GUIDE + '</strong><span>' + RESTART_DETAIL + '</span></div>',
      '<div class="dbr-controls">',
      '<input class="dbr-search" data-role="search" type="search" autocomplete="off" spellcheck="false" placeholder="搜索插件名称、包名或入口 id" aria-label="搜索插件">',
      '<div class="dbr-tabs" role="tablist" aria-label="插件范围">',
      '<button class="dbr-tab" data-filter="suspect" role="tab" type="button">疑似故障</button>',
      '<button class="dbr-tab" data-filter="user" role="tab" type="button">用户插件</button>',
      '<button class="dbr-tab" data-filter="rescue" role="tab" type="button">已停用</button>',
      '<button class="dbr-tab" data-filter="all" role="tab" type="button">全部</button>',
      '</div>',
      '</div>',
      '<div class="dbr-list-meta"><span data-role="summary"></span><span class="dbr-meta-actions"><button class="dbr-text-btn" data-act="select-visible" type="button">选择当前可用项</button><button class="dbr-text-btn" data-act="clear" type="button">清除选择</button></span></div>',
      '<div class="dbr-list" data-role="list" role="list"></div>',
      '<div class="dbr-sections" data-role="sections" hidden>',
      '<section class="dbr-section" data-role="quarantine" hidden>',
      '<div class="dbr-section-head"><span class="dbr-section-title">隔离残留</span><span class="dbr-section-meta" data-role="quarantine-meta"></span></div>',
      '<div class="dbr-section-body" data-role="quarantine-body"></div>',
      '</section>',
      '<section class="dbr-section" data-role="snapshot" hidden>',
      '<div class="dbr-section-head"><span class="dbr-section-title">良好快照</span><span class="dbr-section-meta" data-role="snapshot-meta"></span></div>',
      '<div class="dbr-section-body">',
      '<div class="dbr-section-line" data-role="snapshot-info"></div>',
      '<div class="dbr-section-actions">',
      '<button class="dbr-row-btn" data-act="snapshot" type="button">立即存快照</button>',
      '<button class="dbr-row-btn" data-act="rollback" type="button"><span data-role="rollback-label">回滚到该快照</span></button>',
      '</div>',
      '</div>',
      '</section>',
      '<section class="dbr-section" data-role="ledger" hidden>',
      '<div class="dbr-section-head"><span class="dbr-section-title">救援台账</span><span class="dbr-section-meta" data-role="ledger-meta"></span></div>',
      '<div class="dbr-section-body">',
      '<div class="dbr-ledger-rows" data-role="ledger-rows"></div>',
      '<div class="dbr-section-actions"><button class="dbr-row-btn" data-act="restore-bundle" type="button">恢复 bundle 移除项</button></div>',
      '</div>',
      '</section>',
      '</div>',
      '<div class="dbr-readonly" data-role="readonly" hidden></div>',
      '<footer class="dbr-foot">',
      '<div class="dbr-status" data-role="status" role="status" aria-live="polite"></div>',
      '<div class="dbr-foot-hint" data-role="disable-hint" hidden></div>',
      '<div class="dbr-actions">',
      '<button class="dbr-btn" data-act="copy" type="button">' + ICONS.copy + '<span>复制诊断</span></button>',
      '<button class="dbr-btn" data-act="safe-mode" type="button" hidden><span data-role="safe-mode-label">安全模式</span></button>',
      '<button class="dbr-btn" data-act="restore-all" type="button"><span data-role="restore-label">恢复救援停用项</span></button>',
      '<button class="dbr-btn dbr-primary" data-act="disable" type="button"><span data-role="disable-label">停用所选并等待重启</span>' + ICONS.arrow + '</button>',
      '</div>',
      '</footer>',
      '</section>'
    ].join("");
    return overlay;
  }

  function entryMarkup(entry) {
    var suspect = !!model.suspects[entry.id];
    var rescueDisabled = isRescueDisabled(entry);
    var selected = !!model.selected[entry.id];
    var actionable = isActionable(entry);
    var classes = "dbr-item" + (selected ? " dbr-selected" : "") + (suspect ? " dbr-suspect" : "");
    var badges = [];
    if (suspect) badges.push('<span class="dbr-badge dbr-badge-warn">疑似故障</span>');
    // 增量：loader 报告 pending 时直接显示缺哪个服务，比只看文案更可信。
    var missingServices = missingServicesOf(entry);
    if (missingServices.length) {
      badges.push('<span class="dbr-badge dbr-badge-warn" title="loader 报告该 entry 缺少依赖服务">缺服务：' + esc(missingServices.slice(0, 2).join("、")) + (missingServices.length > 2 ? " 等" : "") + '</span>');
    }
    if (rescueDisabled) badges.push('<span class="dbr-badge dbr-badge-info">已由救援停用</span>');
    else if (entry.disabled) badges.push('<span class="dbr-badge">配置已禁用</span>');
    if (entry.builtin) {
      badges.push('<span class="dbr-badge dbr-badge-muted" title="内置受保护条目，救援脚本不会修改">内置受保护</span>');
    } else if (entry.protected) {
      var protectedLabel = entry.protectedReason === "self" ? "救援自身" : entry.protectedReason === "required" ? "宿主必需" : "受保护";
      badges.push('<span class="dbr-badge dbr-badge-muted" title="' + esc(entry.protectedReason || "") + '">' + protectedLabel + '</span>');
    } else if (!actionable && !rescueDisabled && entry.reason) {
      badges.push('<span class="dbr-badge dbr-badge-muted" title="' + esc(entry.reason) + '">未映射</span>');
    }
    var meta = [];
    if (entry.packageName && entry.packageName !== entry.id) meta.push("包名 " + entry.packageName);
    meta.push("入口 id: " + entry.id);
    if (entry.bundleName) meta.push("bundle " + entry.bundleName);
    else if (entry.inBundles) meta.push("在 bundles 中");
    if (entry.hasUserRow) meta.push("已有用户行");
    var checkbox = '<input class="dbr-check" type="checkbox" data-id="' + esc(entry.id) + '"' + (selected ? " checked" : "") + (actionable && !model.busy && !isPreview ? "" : " disabled") + ' aria-label="选择 ' + esc(entry.name || entry.id) + '">';
    var restoreButton = rescueDisabled
      ? '<button class="dbr-row-btn" data-act="restore-one" data-id="' + esc(entry.id) + '" type="button"' + (model.busy || !model.writable || isPreview ? " disabled" : "") + '>恢复</button>'
      : "";
    // 1.2.0 D 项：entry.levels 含 "bundles" 时给一个「bundle 停用」次级按钮。
    // 旧宿主没有 levels / features.bundles，这里整段不渲染。
    var bundleButton = "";
    if (model.features.bundles && hasLevel(entry, "bundles") && !rescueDisabled) {
      var bundleDisabled = model.busy || !model.writable || isPreview || entry.bundleRemovable === false;
      var bundleReason = "";
      if (isPreview) bundleReason = PREVIEW_NOTICE;
      else if (!model.writable) bundleReason = model.readOnlyReason || "当前为只读模式，无法修改配置。";
      else if (entry.bundleRemovable === false) bundleReason = entry.reason || "该插件不能从 dsh.profile.bundles 移除。";
      else bundleReason = entry.bundleName ? "从 dsh.profile.bundles 移除 " + entry.bundleName : "从 dsh.profile.bundles 移除该插件（重启后生效）";
      bundleButton = '<button class="dbr-row-btn dbr-row-btn-bundle" data-act="disable-bundle" data-id="' + esc(entry.id) + '" type="button"' + (bundleDisabled ? " disabled" : "") + ' title="' + esc(bundleReason) + '">bundle 停用</button>';
    }
    return '<div class="' + classes + '" role="listitem" data-id="' + esc(entry.id) + '">' +
      '<label class="dbr-item-main' + (actionable ? "" : " dbr-inert") + '">' + checkbox +
      '<span class="dbr-plugin"><span class="dbr-name" title="' + esc(entry.name || entry.id) + '">' + esc(entry.name || entry.id) + '</span>' +
      '<span class="dbr-meta" title="' + esc(meta.join(" · ")) + '">' + esc(meta.join(" · ")) + '</span></span></label>' +
      '<span class="dbr-badges">' + badges.join("") + '</span>' + bundleButton + restoreButton + '</div>';
  }

  function defaultStatus() {
    if (isPreview) return { text: PREVIEW_NOTICE, tone: "preview" };
    if (!model.writable) return { text: model.readOnlyReason || "当前无法安全修改配置，已进入只读模式。", tone: "error" };
    var selected = countSelected();
    if (selected) return { text: "已选择 " + selected + " 个插件；只会写入带救援标记的临时停用行。", tone: "" };
    var rescueCount = countRescueRows();
    if (rescueCount) return { text: "当前有 " + rescueCount + " 个插件由救援停用。", tone: "" };
    if (model.mode === "patch-fallback") return { text: "当前为降级模式：停用只在本轮启动内有效，请按上方警示处理。", tone: "warn" };
    if (model.notice) return { text: "检测到启动残留：建议先合并恢复，或改用行内「bundle 停用」；直接写用户行可能再次被隔离。", tone: "warn" };
    return { text: "选择疑似故障插件后执行停用；不会删除插件或用户数据。", tone: "" };
  }

  function paintStatus() {
    if (!panel) return;
    try {
      var element = panel.querySelector('[data-role="status"]');
      if (!element) return;
      var text = model.statusText;
      var tone = model.statusTone;
      if (!text) {
        var preset = defaultStatus();
        text = preset.text;
        tone = preset.tone;
      }
      element.textContent = text;
      element.setAttribute("data-tone", tone || "");
    } catch (error) {
      // 状态渲染失败不抛出
    }
  }

  function setStatus(text, tone) {
    model.statusText = text || "";
    model.statusTone = tone || "";
    paintStatus();
  }

  function renderPanel() {
    if (!panel) return;
    try {
      // 统一复位所有按钮：setBusy(true) 会禁用全部按钮，重渲染若只细化部分按钮，
      // 标签页等按钮会永久保持禁用。先按 busy 复位，再由下面的具体逻辑细化。
      var allButtons = panel.querySelectorAll("button");
      for (var allIndex = 0; allIndex < allButtons.length; allIndex++) allButtons[allIndex].disabled = !!model.busy;
      // 顶部状态 + 版本小字
      var label = "救援服务在线";
      var stateClass = "dbr-live";
      if (isPreview) { label = "只读自检"; stateClass += " dbr-preview-state"; }
      else if (!model.writable) { label = "救援服务只读"; stateClass += " dbr-readonly-state"; }
      else if (model.mode === "patch-fallback") { label = "降级模式"; stateClass += " dbr-degraded-state"; }
      var serviceLabel = panel.querySelector('[data-role="service-label"]');
      if (serviceLabel) serviceLabel.textContent = label;
      var serviceState = panel.querySelector('[data-role="service-state"]');
      if (serviceState) serviceState.className = stateClass;
      var versionLine = model.version ? "版本 " + model.version : "";
      if (model.generatedAt) {
        var stamp = formatTime(model.generatedAt);
        if (stamp) versionLine += (versionLine ? " · " : "") + "生成于 " + stamp;
      }
      var versionElement = panel.querySelector('[data-role="version"]');
      if (versionElement) versionElement.textContent = versionLine;
      var previewBadge = panel.querySelector('[data-role="preview-badge"]');
      if (previewBadge) previewBadge.hidden = !isPreview;

      // 疑似诊断条（增量：真实 loader 状态优先于文案解析）
      var suspects = suspectEntries();
      var loaderNote = "";
      if (model.loader.ok && model.loader.pending.length) {
        var loaderBits = [];
        for (var pendingIndex = 0; pendingIndex < model.loader.pending.length && pendingIndex < 4; pendingIndex++) {
          var pendingItem = model.loader.pending[pendingIndex];
          var pendingMissing = (pendingItem.missing || []).slice(0, 2).join("、");
          loaderBits.push((pendingItem.name || pendingItem.id) + (pendingMissing ? "（缺 " + pendingMissing + "）" : ""));
        }
        loaderNote = "loader 未激活：" + loaderBits.join(" · ");
      } else if (model.loader.ok && model.loader.failed.length) {
        var failedBits = [];
        for (var failedIndex = 0; failedIndex < model.loader.failed.length && failedIndex < 4; failedIndex++) {
          failedBits.push(model.loader.failed[failedIndex].name || model.loader.failed[failedIndex].id);
        }
        loaderNote = "loader 失败：" + failedBits.join(" · ");
      }
      var diagnosis = panel.querySelector('[data-role="diagnosis"]');
      if (diagnosis) diagnosis.hidden = !(suspects.length || loaderNote);
      var suspectNames = [];
      for (var index = 0; index < suspects.length; index++) suspectNames.push(suspects[index].name || suspects[index].id);
      var suspectElement = panel.querySelector('[data-role="suspects"]');
      if (suspectElement) {
        var suspectParts = [];
        if (suspectNames.length) suspectParts.push(suspectNames.join(" · "));
        if (loaderNote) suspectParts.push(loaderNote);
        suspectElement.textContent = suspectParts.join("；");
      }

      // 降级模式 warning（显著展示）
      var warningText = model.mode === "patch-fallback" ? (model.warning || FALLBACK_WARNING) : model.warning;
      var warningBox = panel.querySelector('[data-role="warning"]');
      if (warningBox) warningBox.hidden = !warningText;
      var warningTitle = panel.querySelector('[data-role="warning-title"]');
      if (warningTitle) warningTitle.textContent = model.mode === "patch-fallback" ? "降级模式警示" : "提示";
      var warningElement = panel.querySelector('[data-role="warning-text"]');
      if (warningElement) warningElement.textContent = warningText;

      // 增量第 3 条：宿主 state.notice（检测到 .dshm-boot-failed / 可合并隔离文件）。
      var noticeBox = panel.querySelector('[data-role="state-notice"]');
      if (noticeBox) noticeBox.hidden = !model.notice;
      var noticeElement = panel.querySelector('[data-role="state-notice-text"]');
      if (noticeElement) noticeElement.textContent = model.notice;
      var disableHint = panel.querySelector('[data-role="disable-hint"]');
      if (disableHint) {
        disableHint.hidden = !model.notice;
        disableHint.textContent = model.notice
          ? "直接写用户行可能再次被隔离：建议先「合并恢复」，或改用每行的「bundle 停用」；仍失败时再划掉后台重开应用。"
          : "";
      }

      // 标签页
      var tabs = panel.querySelectorAll(".dbr-tab");
      for (var tabIndex = 0; tabIndex < tabs.length; tabIndex++) {
        tabs[tabIndex].setAttribute("aria-selected", tabs[tabIndex].getAttribute("data-filter") === model.filter ? "true" : "false");
      }

      // 列表
      var visible = filteredEntries();
      var html = [];
      var actionableVisible = 0;
      for (var listIndex = 0; listIndex < visible.length; listIndex++) {
        html.push(entryMarkup(visible[listIndex]));
        if (isActionable(visible[listIndex])) actionableVisible++;
      }
      var list = panel.querySelector('[data-role="list"]');
      if (list) list.innerHTML = visible.length ? html.join("") : '<div class="dbr-empty">当前范围内没有匹配的插件</div>';
      var summary = panel.querySelector('[data-role="summary"]');
      if (summary) summary.textContent = "显示 " + visible.length + " 项 · 可操作 " + actionableVisible + " 项 · 已选择 " + countSelected() + " 项";
      var selectVisible = panel.querySelector('[data-act="select-visible"]');
      if (selectVisible) selectVisible.disabled = model.busy || !model.writable || isPreview || actionableVisible === 0;
      var clear = panel.querySelector('[data-act="clear"]');
      if (clear) clear.disabled = model.busy || countSelected() === 0;

      // 只读原因 + 手改指引
      var readonlyBox = panel.querySelector('[data-role="readonly"]');
      if (readonlyBox) {
        if (model.writable) {
          readonlyBox.hidden = true;
          readonlyBox.innerHTML = "";
        } else {
          var target = "";
          if (model.mode === "patch-fallback") target = model.profileDir ? model.profileDir.replace(/\/+$/, "") + "/cordis.patch.yml" : "当前 profile 目录下的 cordis.patch.yml";
          else if (model.rowsPath) target = model.rowsPath;
          else if (model.profileDir) target = model.profileDir.replace(/\/+$/, "") + "/.dshm-plugin-rows.yml";
          else target = "当前 profile 目录下的 .dshm-plugin-rows.yml";
          readonlyBox.hidden = false;
          readonlyBox.innerHTML = '<div class="dbr-readonly-title">只读模式：按钮已禁用，不会写入任何配置</div>' +
            '<p>原因：' + esc(model.readOnlyReason || "当前无法安全修改配置，已进入只读模式。") + '</p>' +
            '<p>手改指引：编辑 <code>' + esc(target) + '</code>，为故障插件追加 <code>- id: &lt;entry id&gt;</code> 与 <code>&nbsp;&nbsp;disabled: true</code> 两行后保存；或到系统设置 → 插件 中卸载该插件。</p>';
        }
      }

      // 底部按钮
      var selectedCount = countSelected();
      var rescueCount = countRescueRows();
      var disableButton = panel.querySelector('[data-act="disable"]');
      var restoreButton = panel.querySelector('[data-act="restore-all"]');
      var disableLabel = panel.querySelector('[data-role="disable-label"]');
      var restoreLabel = panel.querySelector('[data-role="restore-label"]');
      if (disableLabel) disableLabel.textContent = "停用所选并等待重启" + (selectedCount ? "（" + selectedCount + "）" : "");
      if (restoreLabel) restoreLabel.textContent = (model.confirmRestore ? "再次点击确认恢复" : "恢复救援停用项") + (rescueCount ? "（" + rescueCount + "）" : "");
      if (disableButton) disableButton.disabled = model.busy || !model.writable || isPreview || selectedCount === 0;
      if (restoreButton) {
        restoreButton.disabled = model.busy || !model.writable || isPreview || rescueCount === 0;
        restoreButton.className = "dbr-btn" + (model.confirmRestore ? " dbr-restore-confirm" : "");
      }
      var copyButton = panel.querySelector('[data-act="copy"]');
      if (copyButton) copyButton.disabled = model.busy;

      // 1.2.0 新增区块（隔离残留 / 快照 / 台账），全部按 features 显示。
      renderAdvancedSections();

      // 1.2.0 F 项：安全模式按钮（二次点击确认；旧宿主没有 features 对象时隐藏）。
      var safeTargets = safeModeTargets();
      var safeButton = panel.querySelector('[data-act="safe-mode"]');
      if (safeButton) {
        safeButton.hidden = !model.features.known;
        safeButton.disabled = model.busy || !model.writable || isPreview || !model.features.known || safeTargets.length === 0;
        safeButton.className = "dbr-btn" + (model.confirmSafeMode ? " dbr-restore-confirm" : "");
        safeButton.title = !model.features.known
          ? ""
          : (advancedBlockedReason() || (safeTargets.length ? "一次停用全部非核心插件（需要二次点击确认）" : "没有可停用的非核心插件"));
      }
      var safeLabel = panel.querySelector('[data-role="safe-mode-label"]');
      if (safeLabel) {
        safeLabel.textContent = model.confirmSafeMode
          ? "再次点击确认停用 " + safeTargets.length + " 个"
          : "安全模式（" + safeTargets.length + " 个非核心）";
      }

      paintStatus();
    } catch (error) {
      // 单次渲染失败不影响宿主页面
    }
  }

  // ── 10.5 1.2.0 高级区块渲染（隔离残留 / 快照 / 台账）──────────────────────
  // 安全模式目标：与契约第 6 节一致（actionable && 非内置 && 非受保护 && 非自身）。
  function safeModeTargets() {
    var targets = [];
    try {
      for (var index = 0; index < model.entries.length; index++) {
        var entry = model.entries[index];
        if (!entry.actionable) continue;
        if (entry.builtin || entry.protected) continue;
        if (String(entry.id) === SELF_ENTRY_ID) continue;
        targets.push(entry.id);
      }
    } catch (error) {
      return targets;
    }
    return targets;
  }

  // 台账里 mode 为 bundles 的记录数 = 可恢复的 bundle 移除项数量。
  function countLedgerBundles() {
    var count = 0;
    try {
      for (var index = 0; index < model.ledger.entries.length; index++) {
        if (model.ledger.entries[index].mode === "bundles") count++;
      }
    } catch (error) {
      return count;
    }
    return count;
  }

  function reasonLabel(reason) {
    var value = String(reason || "");
    if (value === "healthy") return "启动成功";
    if (value === "startup") return "启动完成";
    if (value === "manual") return "手动保存";
    return value || "未知";
  }

  // 只读 / 自检时的统一原因文案：所有写按钮禁用并把它放进 title。
  function advancedBlockedReason() {
    if (isPreview) return PREVIEW_NOTICE;
    if (!model.writable) return model.readOnlyReason || "当前为只读模式，无法修改配置。";
    return "";
  }

  function renderQuarantineSection() {
    if (!panel) return false;
    var section = panel.querySelector('[data-role="quarantine"]');
    if (!section) return false;
    var files = model.quarantine.files || [];
    var visible = model.features.quarantine && (files.length > 0 || model.quarantine.bootFailed);
    section.hidden = !visible;
    if (!visible) return false;
    var meta = panel.querySelector('[data-role="quarantine-meta"]');
    if (meta) meta.textContent = files.length ? files.length + " 个待处理" : "检出启动失败标记";
    var body = panel.querySelector('[data-role="quarantine-body"]');
    if (!body) return true;
    var html = [];
    var blocked = advancedBlockedReason();
    if (model.quarantine.bootFailed) {
      var failedAt = formatTime(model.quarantine.bootFailedAt);
      html.push('<div class="dbr-section-line dbr-section-warn">检测到上次启动失败标记 <strong>.dshm-boot-failed</strong>' + (failedAt ? "（" + esc(failedAt) + "）" : "") + '。</div>');
    }
    if (!files.length) {
      html.push('<div class="dbr-section-line">没有发现可合并的隔离残留文件。</div>');
    }
    for (var index = 0; index < files.length && index < MAX_QUARANTINE_ITEMS; index++) {
      var file = files[index];
      var info = [];
      if (file.at) info.push(formatTime(file.at) || file.at);
      if (file.rows) info.push(file.rows + " 行");
      if (file.rescueBlocks) info.push("救援标记 " + file.rescueBlocks + " 块");
      if (file.bytes) info.push(file.bytes + " 字节");
      var disabled = model.busy || !model.writable || isPreview || file.mergeable === false;
      var reason = blocked || (file.mergeable === false ? (file.reason || "该残留无法安全合并") : "");
      html.push('<div class="dbr-quarantine-item"><span class="dbr-quarantine-name" title="' + esc(file.path || file.name) + '">' + esc(file.name) + '</span>' +
        '<span class="dbr-quarantine-meta">' + esc(info.join(" · ")) + '</span>' +
        '<button class="dbr-row-btn" data-act="quarantine-restore" data-name="' + esc(file.name) + '" type="button"' + (disabled ? " disabled" : "") + (reason ? ' title="' + esc(reason) + '"' : "") + '>合并恢复</button></div>');
    }
    if (files.length > MAX_QUARANTINE_ITEMS) {
      html.push('<div class="dbr-section-line">还有 ' + (files.length - MAX_QUARANTINE_ITEMS) + ' 个残留文件未列出。</div>');
    }
    body.innerHTML = html.join("");
    return true;
  }

  function renderSnapshotSection() {
    if (!panel) return false;
    var section = panel.querySelector('[data-role="snapshot"]');
    if (!section) return false;
    section.hidden = !model.features.snapshot;
    if (!model.features.snapshot) return false;
    var latest = model.snapshot.latest;
    var meta = panel.querySelector('[data-role="snapshot-meta"]');
    if (meta) meta.textContent = "共 " + (model.snapshot.count || 0) + " 份 · 保留 " + (model.snapshot.keep || 5) + " 份";
    var info = panel.querySelector('[data-role="snapshot-info"]');
    if (info) {
      if (latest) {
        var stamp = formatTime(latest.at) || latest.at;
        var bits = [];
        if (stamp) bits.push(stamp);
        bits.push("原因 " + reasonLabel(latest.reason));
        if (latest.rowsBytes) bits.push("rows " + latest.rowsBytes + " 字节");
        if (latest.bundlesCount) bits.push("bundles " + latest.bundlesCount + " 项");
        info.textContent = "最近快照 " + latest.id + "（" + bits.join(" · ") + "）";
      } else {
        info.textContent = model.snapshot.ok === false && model.snapshot.error
          ? "快照目录不可读：" + model.snapshot.error
          : "还没有快照；手动保存或下一次启动成功时会自动生成。";
      }
    }
    var blocked = advancedBlockedReason();
    var snapshotButton = panel.querySelector('[data-act="snapshot"]');
    if (snapshotButton) {
      snapshotButton.disabled = model.busy || !model.writable || isPreview;
      snapshotButton.title = blocked || "立即保存当前用户行与 bundles 为一份快照";
    }
    var rollbackButton = panel.querySelector('[data-act="rollback"]');
    if (rollbackButton) {
      rollbackButton.disabled = model.busy || !model.writable || isPreview || !latest;
      rollbackButton.className = "dbr-row-btn" + (model.confirmRollback ? " dbr-restore-confirm" : "");
      rollbackButton.title = blocked || (latest ? "用该快照覆盖当前用户行与 bundles（会先备份）" : "还没有可回滚的快照");
    }
    var rollbackLabel = panel.querySelector('[data-role="rollback-label"]');
    if (rollbackLabel) rollbackLabel.textContent = model.confirmRollback ? "再次点击确认回滚" : "回滚到该快照";
    return true;
  }

  function renderLedgerSection() {
    if (!panel) return false;
    var section = panel.querySelector('[data-role="ledger"]');
    if (!section) return false;
    var entries = model.ledger.entries || [];
    var visible = model.features.ledger && (entries.length > 0 || model.ledger.ok === false);
    section.hidden = !visible;
    if (!visible) return false;
    var meta = panel.querySelector('[data-role="ledger-meta"]');
    if (meta) meta.textContent = model.ledger.ok === false ? "不可读" : entries.length + " 条";
    var rows = panel.querySelector('[data-role="ledger-rows"]');
    if (rows) {
      var html = [];
      if (model.ledger.ok === false) {
        html.push('<div class="dbr-section-line dbr-section-warn">' + (model.ledger.error
          ? "台账不可读" + "：" + esc(model.ledger.error) + "；恢复已降级为只用注释标记。"
          : "台账在本次只读状态里没有读取；恢复可写后会重新生成。") + '</div>');
      } else if (!entries.length) {
        html.push('<div class="dbr-section-line">台账为空：还没有救援写入记录。</div>');
      }
      for (var index = 0; index < entries.length && index < MAX_LEDGER_ROWS; index++) {
        var item = entries[index];
        var stamped = formatTime(item.at) || item.at;
        html.push('<div class="dbr-ledger-row"><span class="dbr-ledger-id" title="' + esc(item.id) + '">' + esc(item.id) + '</span>' +
          '<span>' + esc(stamped) + '</span><span>' + esc(item.mode) + '</span></div>');
      }
      rows.innerHTML = html.join("");
    }
    var restoreBundleButton = panel.querySelector('[data-act="restore-bundle"]');
    if (restoreBundleButton) {
      var bundlesCount = countLedgerBundles();
      restoreBundleButton.disabled = model.busy || !model.writable || isPreview || bundlesCount === 0;
      restoreBundleButton.title = advancedBlockedReason()
        || (bundlesCount ? "把台账里记录过的 bundles 项按原位置插回（" + bundlesCount + " 条）" : "台账里没有 bundles 移除记录");
      restoreBundleButton.textContent = "恢复 bundle 移除项" + (bundlesCount ? "（" + bundlesCount + "）" : "");
    }
    return true;
  }

  function renderAdvancedSections() {
    try {
      var any = false;
      if (renderQuarantineSection()) any = true;
      if (renderSnapshotSection()) any = true;
      if (renderLedgerSection()) any = true;
      var container = panel.querySelector('[data-role="sections"]');
      if (container) container.hidden = !any;
    } catch (error) {
      // 高级区块渲染失败不影响主列表与底部按钮
    }
  }

  // ── 11. 挂载 / 回退 ───────────────────────────────────────────────────────
  function wireEvents() {
    if (!panel) return;
    panel.addEventListener("input", onPanelInput);
    panel.addEventListener("change", onPanelChange);
    panel.addEventListener("click", onPanelClick);
  }

  function appendOverlay(overlay, interactive) {
    try {
      var host = document.body || document.getElementById("root") || document.documentElement;
      if (!host || !overlay) return false;
      host.appendChild(overlay);
      if (interactive) {
        panel = overlay;
        wireEvents();
        renderPanel();
      }
      return true;
    } catch (error) {
      return false;
    }
  }

  // 服务不可用回退面板：不猜路径，只给同源 health 与手改指引。
  function buildFallback(error) {
    injectStyles();
    var overlay = document.createElement("div");
    overlay.className = "dbr-overlay" + (detectDark() ? " dbr-dark" : "");
    overlay.id = "dshm-boot-rescue-overlay";
    overlay.innerHTML = [
      '<section class="dbr-card dbr-fallback" role="dialog" aria-label="' + SERVICE_DOWN_TITLE + '">',
      '<div class="dbr-fallback-body">',
      '<div class="dbr-title">' + SERVICE_DOWN_TITLE + '</div>',
      '<p>无法读取救援状态：<code>' + esc(errorMessage(error)) + '</code></p>',
      '<p>可以尝试：打开 <code>' + API_HEALTH + '</code> 检查救援服务；或手动编辑当前 profile 的用户行文件，为故障插件追加 <code>- id: &lt;entry id&gt;</code> 与 <code>&nbsp;&nbsp;disabled: true</code> 两行；也可以在系统设置 → 插件 中卸载该插件。</p>',
      '<p class="dbr-hint">' + RESTART_GUIDE + '。' + RESTART_DETAIL + '。</p>',
      '</div></section>'
    ].join("");
    return overlay;
  }

  // ── 12. 写操作（成功后不重载页面，只更新 UI + 重启指引）──────────────────
  function setBusy(busy) {
    model.busy = !!busy;
    if (!panel) return;
    if (busy) {
      var buttons = panel.querySelectorAll("button");
      for (var index = 0; index < buttons.length; index++) buttons[index].disabled = true;
    } else {
      renderPanel();
    }
  }

  function markDisabled(ids, data) {
    var changed = {};
    var index;
    try {
      for (index = 0; index < ids.length; index++) changed[String(ids[index])] = true;
      var added = asStringArray(data && data.disabled);
      for (index = 0; index < added.length; index++) changed[added[index]] = true;
      var already = asStringArray(data && data.already);
      for (index = 0; index < already.length; index++) changed[already[index]] = true;
      if (data && data.rescueRows) {
        model.rescueRows = {};
        var rows = asStringArray(data.rescueRows);
        for (index = 0; index < rows.length; index++) model.rescueRows[rows[index]] = true;
      }
      var keys = Object.keys(changed);
      for (index = 0; index < keys.length; index++) {
        model.rescueRows[keys[index]] = true;
        var entry = findEntry(keys[index]);
        if (entry) {
          entry.disabledByRescue = true;
          entry.disabled = true;
        }
      }
      if (data && data.mode) model.mode = String(data.mode);
      if (data && data.warning) model.warning = String(data.warning);
    } catch (error) {
      return changed;
    }
    return changed;
  }

  // 写操作成功后拉取一次权威 state：以服务端 entries 为准重渲染，避免本地猜测与真实用户行不符。
  // 刷新失败时保留调用方已做的本地更新与结果文案，不阻断流程。
  function refreshAfterWrite(message, tone) {
    var previousFilter = model.filter;
    var previousQuery = model.query;
    clearRestoreTimer();
    clearSafeModeTimer();
    clearRollbackTimer();
    model.confirmRestore = false;
    model.confirmSafeMode = false;
    model.confirmRollback = false;
    api(API_STATE).then(function (state) {
      try {
        normalizeState(state);
        model.filter = previousFilter;
        model.query = previousQuery;
        model.selected = {};
        var search = panel ? panel.querySelector('[data-role="search"]') : null;
        if (search) search.value = model.query;
        setStatus(message, tone);
        renderPanel();
      } catch (error) {
        setStatus(message, tone);
        setBusy(false);
      }
    }).catch(function () {
      setStatus(message, tone);
      setBusy(false);
    });
  }

  function doDisable() {
    if (isPreview) {
      setStatus(PREVIEW_NOTICE, "preview");
      return;
    }
    if (!model.writable) {
      setStatus(model.readOnlyReason || "当前为只读模式，无法写入配置。", "error");
      return;
    }
    var ids = selectedActionableIds();
    if (!ids.length) {
      setStatus("请先选择要停用的插件。", "error");
      return;
    }
    if (ids.length > MAX_SELECTION) {
      setStatus("单次最多停用 " + MAX_SELECTION + " 个插件，请分批操作。", "error");
      return;
    }
    setBusy(true);
    setStatus("正在写入临时停用行…", "");
    postJSON(API_DISABLE, { ids: ids }).then(function (result) {
      var data = result || {};
      markDisabled(ids, data);
      model.selected = {};
      model.confirmRestore = false;
      // 增量第 2 条：既能热停用就不必划掉后台，提示改为「重新打开本页面即可生效」。
      var hot = hotSummary(data);
      var addedCount = asStringArray(data.disabled).length;
      var reopened = hot.disabled.length > 0;
      var noticeText = normalizeText(data.notice || model.notice || "");
      var message = addedCount ? "已停用 " + addedCount + " 个插件。" : "所选插件已在救援停用列表中。";
      if (reopened) {
        message += "其中 " + hot.disabled.length + " 个已在运行期热停用：重新打开本页面即可生效；若仍然失败，再划掉后台重开应用。";
      } else {
        message += RESTART_GUIDE + "。" + RESTART_DETAIL + "。";
      }
      if (noticeText) message += " " + noticeText;
      if (model.mode === "patch-fallback") message += " " + (model.warning || FALLBACK_WARNING);
      var disabledLines = [];
      if (reopened) {
        disabledLines.push(esc("已在运行期热停用 " + hot.disabled.length + " 个插件：重新打开本页面即可生效；若仍然失败，再划掉后台重开应用。"));
      } else {
        disabledLines.push(esc(RESTART_GUIDE) + "。插件启停只在进程启动时拼装，重新打开本页面不会生效。");
      }
      if (hot.failed.length) {
        disabledLines.push(esc("有 " + hot.failed.length + " 个插件未能热停用（" + hot.failed.join("、") + "），需要划掉后台重开应用。"));
      }
      if (noticeText) disabledLines.push(esc(noticeText));
      if (model.mode === "patch-fallback") disabledLines.push(esc(model.warning || FALLBACK_WARNING) + "。");
      popupWriteResult(addedCount ? "已停用 " + addedCount + " 个插件" : "所选插件已在救援停用列表中", disabledLines, "success");
      refreshAfterWrite(message, "success");
    }).catch(function (error) {
      setStatus("停用失败：" + errorMessage(error), "error");
      popupWriteResult("停用失败", [esc(errorMessage(error))], "danger");
      setBusy(false);
    });
  }

  function doRestore(ids) {
    if (isPreview) {
      setStatus(PREVIEW_NOTICE, "preview");
      return;
    }
    if (!model.writable) {
      setStatus(model.readOnlyReason || "当前为只读模式，无法写入配置。", "error");
      return;
    }
    var restoringAll = !ids || !ids.length;
    var payload = restoringAll ? {} : { ids: ids };
    setBusy(true);
    setStatus(restoringAll ? "正在恢复全部救援停用项…" : "正在恢复插件…", "");
    postJSON(API_RESTORE, payload).then(function (result) {
      var data = result || {};
      var restored = asStringArray(data.restored);
      for (var index = 0; index < restored.length; index++) {
        delete model.rescueRows[restored[index]];
        var entry = findEntry(restored[index]);
        if (entry) {
          entry.disabledByRescue = false;
          entry.disabled = false;
        }
      }
      model.selected = {};
      model.confirmRestore = false;
      if (data.mode) model.mode = String(data.mode);
      var message = restored.length ? "已恢复 " + restored.length + " 个插件。" + RESTART_GUIDE + "。" : "没有可恢复的救援停用项。";
      var restoredLines = [esc(RESTART_GUIDE) + "，恢复才会真正生效。"];
      if (model.mode === "patch-fallback") restoredLines.push(esc(model.warning || FALLBACK_WARNING) + "。");
      popupWriteResult(restored.length ? "已恢复 " + restored.length + " 个插件" : "没有可恢复的救援停用项", restoredLines, restored.length ? "success" : "info");
      refreshAfterWrite(message, restored.length ? "success" : "");
    }).catch(function (error) {
      setStatus("恢复失败：" + errorMessage(error), "error");
      popupWriteResult("恢复失败", [esc(errorMessage(error))], "danger");
      setBusy(false);
    });
  }

  // ── 12.5 1.2.0 写操作（bundle 停用 / 安全模式 / 快照 / 回滚 / 隔离合并）──────
  // 统一规则：只读或自检直接拒绝（不发任何请求）；成功后不重载页面，只刷新 UI。
  function writeBlocked() {
    if (isPreview) {
      setStatus(PREVIEW_NOTICE, "preview");
      return true;
    }
    if (!model.writable) {
      setStatus(model.readOnlyReason || "当前为只读模式，无法写入配置。", "error");
      return true;
    }
    if (model.busy) return true;
    return false;
  }

  function finishWriteFailure(title, error) {
    setStatus(title + "：" + errorMessage(error), "error");
    popupWriteResult(title, [esc(errorMessage(error))], "danger");
    setBusy(false);
  }

  // 增量第 2 条：/disable、/safe-mode 响应里的热停用结果。
  function hotSummary(data) {
    var output = { disabled: [], failed: [] };
    try {
      output.disabled = asLabelArray(data && data.hotDisabled);
      var failedRaw = data && data.hotFailed;
      for (var index = 0; failedRaw && index < failedRaw.length; index++) {
        var item = failedRaw[index];
        var label = "";
        if (item && typeof item === "object") label = String(item.id || "");
        else if (item !== undefined && item !== null) label = String(item);
        label = normalizeText(label);
        if (label && output.failed.indexOf(label) === -1) output.failed.push(label);
      }
    } catch (error) {
      return output;
    }
    return output;
  }

  function doDisableBundle(id) {
    if (writeBlocked()) return;
    if (!model.features.bundles) {
      setStatus("当前救援服务不支持 bundle 级停用。", "error");
      return;
    }
    var entry = findEntry(String(id || ""));
    if (!entry) {
      setStatus("找不到该插件条目，请刷新后重试。", "error");
      return;
    }
    if (entry.bundleRemovable === false) {
      setStatus("该插件不能从 profile 的 dsh.profile.bundles 移除。", "error");
      return;
    }
    setBusy(true);
    setStatus("正在从 profile 的 bundles 中移除…", "");
    postJSON(API_DISABLE_BUNDLE, { ids: [entry.id] }).then(function (result) {
      var data = result || {};
      var removed = asLabelArray(data.removed);
      if (data.mode) model.mode = String(data.mode);
      var message = (removed.length ? "已从 bundles 移除 " + removed.length + " 个插件。" : "该插件已不在 bundles 中。") + RESTART_GUIDE + "。" + RESTART_DETAIL + "。";
      var lines = [entry.bundleName
        ? esc("已从 dsh.profile.bundles 移除：" + entry.bundleName + "。")
        : esc("已从 dsh.profile.bundles 移除该插件。")];
      lines.push(esc(RESTART_GUIDE) + "。插件启停只在进程启动时拼装，重新打开本页面不会生效。");
      lines.push("如需撤销，可在「救援台账」区块点「恢复 bundle 移除项」。");
      popupWriteResult(removed.length ? "已从 bundles 移除 " + removed.length + " 个插件" : "该插件已不在 bundles 中", lines, "success");
      refreshAfterWrite(message, "success");
    }).catch(function (error) {
      finishWriteFailure("bundle 停用失败", error);
    });
  }

  function doRestoreBundle() {
    if (writeBlocked()) return;
    if (!model.features.bundles) {
      setStatus("当前救援服务不支持 bundle 级恢复。", "error");
      return;
    }
    var pending = countLedgerBundles();
    if (!pending) {
      setStatus("台账里没有可恢复的 bundle 移除记录。", "error");
      return;
    }
    setBusy(true);
    setStatus("正在恢复被移除的 bundles 项…", "");
    postJSON(API_RESTORE_BUNDLE, {}).then(function (result) {
      var data = result || {};
      var restored = asLabelArray(data.restored);
      var skipped = asLabelArray(data.skipped);
      var message = (restored.length ? "已恢复 " + restored.length + " 个 bundles 项。" : "没有可恢复的 bundles 项。") + RESTART_GUIDE + "。";
      var lines = [restored.length ? esc("已按原位置恢复：" + restored.join("、") + "。") : esc("没有可恢复的 bundles 项。")];
      if (skipped.length) lines.push(esc("跳过 " + skipped.length + " 项：" + skipped.join("、") + "。"));
      lines.push(esc(RESTART_GUIDE) + "，恢复才会真正生效。");
      popupWriteResult(restored.length ? "已恢复 " + restored.length + " 个 bundles 项" : "没有可恢复的 bundles 项", lines, restored.length ? "success" : "info");
      refreshAfterWrite(message, restored.length ? "success" : "");
    }).catch(function (error) {
      finishWriteFailure("bundle 恢复失败", error);
    });
  }

  function doSafeMode() {
    if (writeBlocked()) return;
    if (!model.features.known) {
      setStatus("当前救援服务版本不支持安全模式。", "error");
      return;
    }
    var targets = safeModeTargets();
    if (!targets.length) {
      setStatus("没有可停用的非核心插件（全部已停用或受保护）。", "error");
      return;
    }
    if (!model.confirmSafeMode) {
      model.confirmSafeMode = true;
      clearSafeModeTimer();
      safeModeConfirmTimer = window.setTimeout(function () {
        safeModeConfirmTimer = null;
        model.confirmSafeMode = false;
        if (panel && !model.busy) renderPanel();
      }, CONFIRM_TIMEOUT_MS);
      setStatus("再次点击「安全模式」以确认：将停用 " + targets.length + " 个非核心插件。", "warn");
      renderPanel();
      return;
    }
    clearSafeModeTimer();
    model.confirmSafeMode = false;
    setBusy(true);
    setStatus("正在进入安全模式…", "");
    postJSON(API_SAFE_MODE, { confirm: true, keep: [] }).then(function (result) {
      var data = result || {};
      var levels = data.levels && typeof data.levels === "object" ? data.levels : {};
      var rowIds = asLabelArray(levels.rows);
      var bundleIds = asLabelArray(levels.bundles);
      var kept = asLabelArray(data.kept);
      var skipped = asLabelArray(data.skipped || data.bundlesSkipped);
      var already = asLabelArray(data.already);
      var hot = hotSummary(data);
      var noticeText = normalizeText(data.notice || model.notice || "");
      var total = rowIds.length + bundleIds.length;
      model.selected = {};
      var message = "已进入安全模式：停用 " + total + " 个非核心插件。";
      if (hot.disabled.length) {
        message += "其中 " + hot.disabled.length + " 个已在运行期热停用：重新打开本页面即可生效；若仍然失败，再划掉后台重开应用。";
      } else {
        message += RESTART_GUIDE + "。" + RESTART_DETAIL + "。";
      }
      if (noticeText) message += " " + noticeText;
      var lines = [esc("已进入安全模式，共停用 " + total + " 个非核心插件（rows " + rowIds.length + " 个 · bundles " + bundleIds.length + " 个）。")];
      if (already.length) lines.push(esc("已在救援停用列表中 " + already.length + " 项：" + already.join("、") + "。"));
      if (skipped.length) lines.push(esc("未处理 " + skipped.length + " 项：" + skipped.join("、") + "。"));
      if (kept.length) lines.push(esc("保留：" + kept.join("、") + "。"));
      if (hot.disabled.length) {
        lines.push(esc("已在运行期热停用 " + hot.disabled.length + " 个插件：重新打开本页面即可生效；若仍然失败，再划掉后台重开应用。"));
      } else {
        lines.push(esc(RESTART_GUIDE) + "。插件启停只在进程启动时拼装，重新打开本页面不会生效。");
      }
      if (hot.failed.length) lines.push(esc("有 " + hot.failed.length + " 个插件未能热停用（" + hot.failed.join("、") + "），需要划掉后台重开应用。"));
      if (noticeText) lines.push(esc(noticeText));
      popupWriteResult("已进入安全模式", lines, "success");
      refreshAfterWrite(message, "success");
    }).catch(function (error) {
      finishWriteFailure("安全模式失败", error);
    });
  }

  function doSnapshot() {
    if (writeBlocked()) return;
    if (!model.features.snapshot) {
      setStatus("当前救援服务不支持快照。", "error");
      return;
    }
    setBusy(true);
    setStatus("正在保存当前状态快照…", "");
    postJSON(API_SNAPSHOT, { reason: "manual" }).then(function (result) {
      var data = result || {};
      var id = String(data.id || "");
      var at = formatTime(data.at) || String(data.at || "");
      var message = "快照已保存" + (at ? "（" + at + "）" : "") + "。";
      var lines = [esc("快照 id：" + (id || "未知") + (at ? " · " + at : "") + "。")];
      lines.push("快照只记录当前用户行与 bundles，不改变正在运行的进程；需要时可以回滚。");
      popupWriteResult("快照已保存", lines, "success");
      refreshAfterWrite(message, "success");
    }).catch(function (error) {
      finishWriteFailure("保存快照失败", error);
    });
  }

  function doRollback() {
    if (writeBlocked()) return;
    if (!model.features.snapshot) {
      setStatus("当前救援服务不支持快照回滚。", "error");
      return;
    }
    var latest = model.snapshot.latest;
    if (!latest) {
      setStatus("还没有可回滚的快照。", "error");
      return;
    }
    if (!model.confirmRollback) {
      model.confirmRollback = true;
      clearRollbackTimer();
      rollbackConfirmTimer = window.setTimeout(function () {
        rollbackConfirmTimer = null;
        model.confirmRollback = false;
        if (panel && !model.busy) renderPanel();
      }, CONFIRM_TIMEOUT_MS);
      setStatus("再次点击「回滚到该快照」以确认：将用 " + (formatTime(latest.at) || latest.id) + " 的快照覆盖当前用户行与 bundles。", "warn");
      renderPanel();
      return;
    }
    clearRollbackTimer();
    model.confirmRollback = false;
    setBusy(true);
    setStatus("正在回滚到快照…", "");
    postJSON(API_ROLLBACK, { id: latest.id }).then(function (result) {
      var data = result || {};
      var from = data.restoredFrom && typeof data.restoredFrom === "object" ? data.restoredFrom : {};
      var fromAt = formatTime(from.at) || String(from.at || "");
      var rowsBytes = Number(data.rowsBytes) || 0;
      var bundlesRestored = Number(data.bundlesRestored) || 0;
      var message = "已回滚到快照" + (fromAt ? "（" + fromAt + "）" : "") + "。" + RESTART_GUIDE + "。";
      var lines = [esc("已回滚到 " + String(from.id || latest.id) + (fromAt ? " · " + fromAt : "") + "。")];
      lines.push(esc("恢复 rows " + rowsBytes + " 字节、bundles " + bundlesRestored + " 项。"));
      lines.push(esc(RESTART_GUIDE) + "，回滚才会真正生效。");
      popupWriteResult("已回滚到快照", lines, "success");
      refreshAfterWrite(message, "success");
    }).catch(function (error) {
      finishWriteFailure("回滚失败", error);
    });
  }

  function doQuarantineRestore(name) {
    if (writeBlocked()) return;
    if (!model.features.quarantine) {
      setStatus("当前救援服务不支持隔离残留合并。", "error");
      return;
    }
    setBusy(true);
    setStatus("正在合并隔离残留…", "");
    var payload = name ? { name: String(name) } : {};
    postJSON(API_QUARANTINE_RESTORE, payload).then(function (result) {
      var data = result || {};
      var merged = asLabelArray(data.merged);
      var skipped = asLabelArray(data.skipped);
      var backup = String(data.backup || "");
      var message = merged.length
        ? "已合并恢复 " + merged.length + " 行隔离残留。" + RESTART_GUIDE + "。"
        : "没有需要合并的隔离残留。";
      var lines = [merged.length ? esc("已合并 " + merged.length + " 个插件行：" + merged.join("、") + "。") : esc("没有需要合并的插件行。")];
      if (skipped.length) lines.push(esc("跳过 " + skipped.length + " 项：" + skipped.join("、") + "。"));
      if (backup) lines.push("合并前已备份到：" + esc(backup) + "。");
      lines.push(esc(RESTART_GUIDE) + "，合并结果才会生效。");
      popupWriteResult(merged.length ? "已合并恢复 " + merged.length + " 行" : "没有需要合并的行", lines, merged.length ? "success" : "info");
      refreshAfterWrite(message, merged.length ? "success" : "");
    }).catch(function (error) {
      finishWriteFailure("合并恢复失败", error);
    });
  }

  // ── 13. 复制诊断 ──────────────────────────────────────────────────────────
  function buildReport() {
    var lines = [];
    try {
      lines.push("DSHM 启动救援诊断");
      lines.push("版本: " + (model.version || "未知"));
      lines.push("时间: " + (formatTime(model.generatedAt) || new Date().toISOString()));
      lines.push("模式: " + (model.mode || "rows"));
      lines.push("只读: " + (model.writable ? "否" : "是"));
      if (!model.writable) lines.push("只读原因: " + (model.readOnlyReason || "未提供"));
      lines.push("rowsPath: " + (model.rowsPath || "未提供"));
      lines.push("profileDir: " + (model.profileDir || "未提供"));
      lines.push("疑似故障: " + (suspectText() || "未识别"));
      lines.push("已由救援停用: " + (Object.keys(model.rescueRows).join(", ") || "无"));
      if (model.warning) lines.push("降级警示: " + model.warning);
      lines.push("失败页文本: " + (failureText || "未捕获"));
      // 1.2.0 新字段的只读诊断（旧宿主全部显示「未提供」）。
      lines.push("注入通道: tapIndex=" + (model.inject.tapIndex || "未提供") + " · indexInject=" + (model.inject.indexInject || "未提供") + " · 生效 " + (model.inject.channels || 0) + " 条");
      lines.push("loader: " + (model.loader.ok
        ? "可读 · active " + model.loader.counts.active + " · pending " + model.loader.pending.length + " · failed " + model.loader.failed.length
        : "不可用" + (model.loader.reason ? "（" + model.loader.reason + "）" : "")));
      if (model.notice) lines.push("宿主提示: " + model.notice);
      lines.push("bundle 数: " + (model.bundles.count || 0) + " · 可移除 " + model.bundles.removable.length + " 项");
      lines.push("台账: " + (model.ledger.ok ? "可读，共 " + model.ledger.entries.length + " 条" : "不可读" + (model.ledger.error ? "（" + model.ledger.error + "）" : "")));
      lines.push("隔离残留: " + (model.quarantine.files.length ? model.quarantine.files.length + " 个文件" : "无") + (model.quarantine.bootFailed ? " · 上次启动失败标记存在" : ""));
      lines.push("快照: " + (model.snapshot.latest ? model.snapshot.latest.id + "（" + model.snapshot.latest.reason + "）" : "无") + " · 共 " + (model.snapshot.count || 0) + " 份");
      if (isPreview) lines.push(PREVIEW_NOTICE);
    } catch (error) {
      return "DSHM 启动救援诊断（收集失败）";
    }
    return lines.join("\n");
  }

  function copyDiagnostics() {
    var report = buildReport();
    var done = function () { setStatus("诊断信息已复制到剪贴板。", "success"); };
    var fallback = function () {
      var area = null;
      var copied = false;
      try {
        area = document.createElement("textarea");
        area.value = report;
        area.setAttribute("readonly", "readonly");
        area.style.position = "fixed";
        area.style.top = "-1000px";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        copied = !!document.execCommand("copy");
      } catch (error) {
        copied = false;
      }
      try {
        if (area && area.parentNode) area.parentNode.removeChild(area);
      } catch (removeError) {
        // 忽略清理失败
      }
      if (copied) done();
      else setStatus("剪贴板不可用，请手动复制诊断信息。", "error");
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(report).then(done, fallback);
      else fallback();
    } catch (error) {
      fallback();
    }
  }

  // ── 14. 事件 ──────────────────────────────────────────────────────────────
  function closestButton(node) {
    try {
      while (node && node !== panel) {
        if (node.nodeType === 1 && node.tagName === "BUTTON") return node;
        node = node.parentNode;
      }
    } catch (error) {
      return null;
    }
    return null;
  }

  function onPanelInput(event) {
    try {
      var target = event.target;
      if (!target || target.getAttribute("data-role") !== "search") return;
      model.query = String(target.value || "");
      model.statusText = "";
      model.statusTone = "";
      renderPanel();
    } catch (error) {
      // 搜索渲染失败不影响操作
    }
  }

  function onPanelChange(event) {
    try {
      var target = event.target;
      if (!target || !target.classList || !target.classList.contains("dbr-check")) return;
      if (isPreview) return;
      var id = target.getAttribute("data-id");
      if (!id) return;
      if (target.checked) {
        if (countSelected() >= MAX_SELECTION) {
          target.checked = false;
          setStatus("单次最多停用 " + MAX_SELECTION + " 个插件，请分批操作。", "error");
          return;
        }
        model.selected[id] = true;
      } else {
        delete model.selected[id];
      }
      model.statusText = "";
      model.statusTone = "";
      renderPanel();
    } catch (error) {
      // 选择状态异常时保持原状
    }
  }

  function clearRestoreTimer() {
    if (restoreConfirmTimer) {
      window.clearTimeout(restoreConfirmTimer);
      restoreConfirmTimer = null;
    }
  }

  function clearSafeModeTimer() {
    if (safeModeConfirmTimer) {
      window.clearTimeout(safeModeConfirmTimer);
      safeModeConfirmTimer = null;
    }
  }

  function clearRollbackTimer() {
    if (rollbackConfirmTimer) {
      window.clearTimeout(rollbackConfirmTimer);
      rollbackConfirmTimer = null;
    }
  }

  function onPanelClick(event) {
    try {
      var button = closestButton(event.target);
      if (!button || button.disabled) return;
      var filter = button.getAttribute("data-filter");
      if (filter) {
        model.filter = filter;
        model.query = "";
        var search = panel.querySelector('[data-role="search"]');
        if (search) search.value = "";
        model.statusText = "";
        model.statusTone = "";
        renderPanel();
        return;
      }
      var action = button.getAttribute("data-act");
      if (action === "select-visible") {
        var room = MAX_SELECTION - countSelected();
        if (room <= 0) {
          setStatus("单次最多停用 " + MAX_SELECTION + " 个插件，请先清除部分选择。", "error");
          return;
        }
        var visible = filteredEntries();
        var added = 0;
        var skipped = 0;
        for (var index = 0; index < visible.length; index++) {
          var entry = visible[index];
          if (!isActionable(entry) || model.selected[entry.id]) continue;
          if (added >= room) { skipped++; continue; }
          model.selected[entry.id] = true;
          added++;
        }
        model.statusText = "";
        model.statusTone = "";
        renderPanel();
        if (skipped) setStatus("已选择前 " + added + " 项；单次最多 " + MAX_SELECTION + " 项。", "warn");
      } else if (action === "clear") {
        model.selected = {};
        model.statusText = "";
        model.statusTone = "";
        renderPanel();
      } else if (action === "copy") {
        copyDiagnostics();
      } else if (action === "disable") {
        doDisable();
      } else if (action === "disable-bundle") {
        var bundleId = button.getAttribute("data-id");
        if (bundleId) doDisableBundle(bundleId);
      } else if (action === "safe-mode") {
        doSafeMode();
      } else if (action === "snapshot") {
        doSnapshot();
      } else if (action === "rollback") {
        doRollback();
      } else if (action === "restore-bundle") {
        doRestoreBundle();
      } else if (action === "quarantine-restore") {
        doQuarantineRestore(button.getAttribute("data-name"));
      } else if (action === "restore-one") {
        var restoreId = button.getAttribute("data-id");
        if (restoreId) doRestore([restoreId]);
      } else if (action === "restore-all") {
        if (!model.writable) {
          setStatus(model.readOnlyReason || "当前为只读模式，无法写入配置。", "error");
          return;
        }
        if (countRescueRows() === 0) return;
        if (!model.confirmRestore) {
          model.confirmRestore = true;
          clearRestoreTimer();
          restoreConfirmTimer = window.setTimeout(function () {
            restoreConfirmTimer = null;
            model.confirmRestore = false;
            if (panel && !model.busy) renderPanel();
          }, 5000);
          setStatus("再次点击「恢复救援停用项」以确认；只会撤销救援写入的临时停用行。", "warn");
          renderPanel();
        } else {
          clearRestoreTimer();
          model.confirmRestore = false;
          doRestore(null);
        }
      }
    } catch (error) {
      setStatus("操作失败：" + errorMessage(error), "error");
    }
  }

  // ── 15. 弹窗提示（自绘，零依赖，与面板同风格）─────────────────────────────
  // 设计约束：
  //   * 独立于救援面板：正常界面（无面板）也能弹，失败页则叠在面板之上；
  //   * 只用 var/function；全部逻辑 try/catch；不写任何浏览器存储或 cookie；
  //   * 同一页面生命周期内，同一 key 只弹一次；操作结果类不设 key，允许重复；
  //   * 弹窗只做提示与「恢复」入口，不自动跳转、不自动重载页面。
  function dialogToneIcon(tone) {
    if (tone === "danger" || tone === "warn") return ICONS.warning;
    if (tone === "success") return ICONS.check;
    return ICONS.rescue;
  }

  function notifyDialog(options) {
    try {
      if (!options || !options.title) return;
      if (typeof options.key === "string" && options.key) {
        if (dialogShown[options.key]) return;
        dialogShown[options.key] = true;
      }
      if (dialogQueue.length >= MAX_DIALOG_QUEUE) return;
      dialogQueue.push(options);
      if (!activeDialog) showNextDialog();
    } catch (error) {
      // 提示失败不影响救援流程
    }
  }

  function showNextDialog() {
    var host = null;
    var tone = "info";
    try {
      if (activeDialog) return;
      var options = dialogQueue.shift();
      if (!options) return;
      host = document.body || document.documentElement;
      if (!host || !document.createElement) return;
      tone = options.tone || "info";
      injectStyles();
      var wrap = document.createElement("div");
      wrap.className = "dbr-dialog" + (detectDark() ? " dbr-dark" : "");
      wrap.id = DIALOG_ID;
      wrap.setAttribute("role", tone === "danger" ? "alertdialog" : "dialog");
      wrap.setAttribute("aria-modal", "true");
      wrap.setAttribute("aria-labelledby", "dbr-dialog-title");
      if (tone === "danger") wrap.setAttribute("aria-live", "assertive");
      var lines = options.lines || [];
      var body = [];
      var index;
      for (index = 0; index < lines.length; index++) body.push("<p>" + String(lines[index]) + "</p>");
      var checks = options.checks || [];
      var checksHtml = "";
      if (checks.length) {
        var checkRows = [];
        for (index = 0; index < checks.length; index++) {
          var check = checks[index];
          var checkStatus = check.status === "warn" || check.status === "fail" ? check.status : "ok";
          var checkMark = checkStatus === "ok" ? "✓" : (checkStatus === "warn" ? "!" : "✕");
          checkRows.push('<div class="dbr-check-row dbr-check-' + checkStatus + '" role="listitem">' +
            '<span class="dbr-check-mark" aria-hidden="true">' + checkMark + "</span>" +
            '<span class="dbr-check-label">' + esc(check.label) + "</span>" +
            '<span class="dbr-check-detail">' + esc(check.detail) + "</span></div>");
        }
        checksHtml = '<div class="dbr-checks" role="list" aria-label="日常检查结果">' + checkRows.join("") + "</div>";
      }
      var actions = options.actions || [];
      var buttons = [];
      for (index = 0; index < actions.length; index++) {
        var action = actions[index];
        if (!action || !action.label) continue;
        buttons.push('<button class="dbr-btn' + (action.primary ? " dbr-primary" : "") + '" type="button" data-dialog-action="' + esc(action.action || "close") + '">' + esc(action.label) + "</button>");
      }
      if (!buttons.length) buttons.push('<button class="dbr-btn dbr-primary" type="button" data-dialog-action="close">知道了</button>');
      wrap.innerHTML = '<div class="dbr-dialog-card dbr-tone-' + esc(tone) + '">' +
        '<div class="dbr-dialog-head"><span class="dbr-dialog-icon">' + dialogToneIcon(tone) + "</span>" +
        '<div class="dbr-dialog-heading"><div class="dbr-dialog-kicker">DSHM BOOT RESCUE</div>' +
        '<div class="dbr-dialog-title" id="dbr-dialog-title">' + esc(options.title) + "</div></div></div>" +
        '<div class="dbr-dialog-body">' + body.join("") + "</div>" + checksHtml +
        '<div class="dbr-dialog-actions">' + buttons.join("") + "</div>" +
        "</div>";
      if (options.dismissible) wrap.setAttribute("data-dismissible", "1");
      wrap.addEventListener("click", onDialogClick);
      host.appendChild(wrap);
      activeDialog = wrap;
      try {
        var primary = wrap.querySelector("[data-dialog-action]");
        if (primary && typeof primary.focus === "function") primary.focus();
      } catch (focusError) {
        // 聚焦失败不影响弹窗
      }
    } catch (error) {
      activeDialog = null;
    }
  }

  function closeDialog() {
    var current = activeDialog;
    try {
      activeDialog = null;
      if (current) {
        var host = current.parentNode || document.body || document.documentElement;
        if (host && host.removeChild) host.removeChild(current);
      }
    } catch (error) {
      // 忽略移除失败
    }
    try {
      showNextDialog();
    } catch (nextError) {
      // 队列异常不外抛
    }
  }

  function onDialogClick(event) {
    var button = null;
    try {
      if (event && activeDialog && event.target === activeDialog &&
        activeDialog.getAttribute("data-dismissible") === "1") {
        closeDialog();
        return;
      }
      var target = event ? event.target : null;
      while (target && target !== activeDialog) {
        if (target.nodeType === 1 && target.tagName === "BUTTON") {
          button = target;
          break;
        }
        target = target.parentNode;
      }
    } catch (error) {
      button = null;
    }
    if (!button) return;
    var action = "";
    try {
      action = button.getAttribute("data-dialog-action") || "";
    } catch (error) {
      action = "";
    }
    closeDialog();
    if (action === "restore") {
      try {
        doRestore(null);
      } catch (error) {
        setStatus("恢复失败：" + errorMessage(error), "error");
      }
    }
  }

  function onDialogKeydown(event) {
    try {
      if (!activeDialog || !event) return;
      var key = event.key === undefined || event.key === null ? "" : String(event.key);
      if (key === "Escape" || key === "Esc" || event.keyCode === 27) {
        if (typeof event.preventDefault === "function") event.preventDefault();
        closeDialog();
      }
    } catch (error) {
      // 键盘处理失败不影响页面
    }
  }

  // 写操作结果弹窗：停用/恢复成功后强提示「必须划掉后台重开应用」。
  function popupWriteResult(title, lines, tone) {
    notifyDialog({
      tone: tone || "success",
      title: title,
      lines: lines || [],
      actions: [{ label: "知道了", action: "close", primary: true }]
    });
  }

  // 失败页刚挂载时：先弹一条「已就绪」提示，再露出救援面板。
  function popupFailureReady() {
    // 增量第 1 条：有真实 loader 状态时，弹窗里优先给「谁 pending / 缺哪个服务」。
    var loaderLines = [];
    try {
      if (model.loader.ok && model.loader.pending.length) {
        var pendingNames = [];
        for (var index = 0; index < model.loader.pending.length && index < 4; index++) {
          var item = model.loader.pending[index];
          var missing = (item.missing || []).slice(0, 2).join("、");
          pendingNames.push((item.name || item.id) + (missing ? "（缺 " + missing + "）" : ""));
        }
        loaderLines.push(esc("loader 报告 pending：" + pendingNames.join(" · ") + "。"));
      }
      if (model.loader.ok && model.loader.failed.length) {
        var failedNames = [];
        for (var failedIndex = 0; failedIndex < model.loader.failed.length && failedIndex < 4; failedIndex++) {
          failedNames.push(model.loader.failed[failedIndex].name || model.loader.failed[failedIndex].id);
        }
        loaderLines.push(esc("loader 报告失败：" + failedNames.join(" · ") + "。"));
      }
    } catch (error) {
      loaderLines = [];
    }
    if (model.mode === "patch-fallback") {
      notifyDialog({
        key: "failure-fallback",
        tone: "danger",
        title: "降级模式：本次停用重启后可能失效",
        lines: [
          "启动恢复中心已就绪：可以定位肇事插件并临时停用。"
        ].concat(loaderLines, [
          esc(FALLBACK_WARNING) + "。",
          "恢复后同样需要" + esc(RESTART_GUIDE) + "。"
        ]),
        checks: model.checks,
        actions: [{ label: "打开恢复中心", action: "close", primary: true }]
      });
      return;
    }
    notifyDialog({
      key: "failure",
      tone: "warn",
      title: "检测到插件加载失败",
      lines: [
        "启动恢复中心已就绪：可以定位肇事插件并临时停用，让 DSHM 恢复启动。"
      ].concat(loaderLines, [
        esc(RESTART_GUIDE) + "。插件启停只在进程启动时拼装，重新打开本页面不会生效。"
      ]),
      checks: model.checks,
      actions: [{ label: "打开恢复中心", action: "close", primary: true }]
    });
  }

  // 正常界面巡检：有救援停用项（或已进入降级模式）时弹一次提醒。
  function popupHealthyNotice() {
    var degraded = model.mode === "patch-fallback";
    var rescueIds = [];
    var index;
    var rescueCount = 0;
    try {
      rescueCount = countRescueRows();
      if (rescueCount) {
        var keys = Object.keys(model.rescueRows);
        for (index = 0; index < keys.length && index < 6; index++) rescueIds.push(keys[index]);
      }
      if (!rescueCount && !degraded) {
        // 增量第 1 条：界面健康但 loader 仍有 pending/failed 时不要说「没有检测到失败」。
        var loaderIssue = "";
        if (model.loader.ok && model.loader.pending.length) {
          loaderIssue = model.loader.pending.length + " 个 entry 处于 pending";
        } else if (model.loader.ok && model.loader.failed.length) {
          loaderIssue = model.loader.failed.length + " 个 entry 启动失败";
        }
        var readyLines = [];
        if (loaderIssue) {
          readyLines.push("DSHM 界面已正常显示，但 loader 报告 " + loaderIssue + "。");
          readyLines.push("如果界面功能异常，可以划掉后台重新打开应用；失败页会自动出现「启动恢复中心」。");
        } else {
          readyLines.push("DSHM 已正常启动，没有检测到插件加载失败。");
          readyLines.push("下面是本次启动的日常检查结果；如果以后某个插件把界面弄坏，失败页会自动出现「启动恢复中心」。");
        }
        notifyDialog({
          key: "healthy-ready",
          tone: "info",
          title: "启动救援已就绪",
          lines: readyLines,
          checks: model.checks,
          actions: [{ label: "知道了", action: "close", primary: true }],
          dismissible: true
        });
        return;
      }
      if (rescueCount) {
        var actions = [];
        if (model.writable) actions.push({ label: "立即恢复全部", action: "restore", primary: true });
        actions.push({ label: "稍后", action: "close" });
        var lines = [
          "启动救援临时停用了 " + rescueCount + " 个插件：" + esc(rescueIds.join("、")) + (rescueCount > rescueIds.length ? " 等" : "") + "。"
        ];
        if (degraded) lines.push(esc(model.warning || FALLBACK_WARNING) + "。");
        else lines.push("如果肇事插件已经修好，可以一键恢复；恢复后同样需要" + esc(RESTART_GUIDE) + "。");
        notifyDialog({
          key: "healthy-rescue:" + model.mode + ":" + rescueIds.join(","),
          tone: degraded ? "danger" : "warn",
          title: rescueCount + " 个插件由启动救援停用",
          lines: lines,
          checks: model.checks,
          actions: actions
        });
      }
      if (degraded) {
        notifyDialog({
          key: "healthy-fallback:" + esc(model.warning || ""),
          tone: "danger",
          title: "降级模式警示",
          lines: [
            esc(model.warning || FALLBACK_WARNING) + "。",
            "救援已改用 profile 的 cordis.patch.yml 写入，进程重启后可能失效；进入系统后请立即卸载肇事插件，或到「设置 → 插件」重新启用相关插件。"
          ],
          checks: model.checks,
          actions: [{ label: "知道了", action: "close", primary: true }]
        });
      }
    } catch (error) {
      // 正常界面提示失败不打扰用户
    }
  }

  // 1.2.0 F 项：检测到健康 UI 后顺手存一份 reason:"healthy" 快照。
  // 只在宿主返回 features.snapshot 时发（旧宿主没有该路由）；30s 内去重，失败静默。
  function requestHealthySnapshot() {
    try {
      if (!model.writable || !model.features.snapshot) return;
      var now = new Date().getTime();
      if (healthySnapshotAt && now - healthySnapshotAt < 30000) return;
      healthySnapshotAt = now;
      postJSON(API_SNAPSHOT, { reason: "healthy" }).catch(function () {
        // 快照写入失败不影响正常界面
      });
    } catch (error) {
      // 忽略：快照只是加分项
    }
  }

  function checkHealthyNotice(preloaded) {
    if (isPreview || healthyNoticeChecked) return;
    healthyNoticeChecked = true;
    var ready = preloaded ? Promise.resolve(preloaded) : api(API_STATE);
    ready.then(function (state) {
      try {
        normalizeState(state);
        requestHealthySnapshot();
        popupHealthyNotice();
      } catch (error) {
        // 状态归一化失败时保持安静
      }
    }).catch(function () {
      // 救援服务不可用时，正常界面保持安静
    });
  }

  // ── 16. 兜底小胶囊（1.2.0 C 项：文案完全变了时的最后入口）──────────────────
  // 约束（契约 9.2）：不是全屏面板、不遮挡；role="button" + aria-label；ESC 可关；
  // 只在 DOMContentLoaded 后 15s 仍无健康 UI 且救援面板未挂载时出现；
  // 只要健康 UI 在任何一个时刻出现过，就永不显示；自检页永不显示。
  function removeCapsule() {
    try {
      if (capsule && capsule.parentNode) capsule.parentNode.removeChild(capsule);
    } catch (error) {
      // 忽略移除失败
    }
    capsule = null;
  }

  function closeCapsule() {
    capsuleDismissed = true;
    removeCapsule();
  }

  function buildCapsule() {
    injectStyles();
    var host = document.body || document.documentElement;
    if (!host || !document.createElement) return null;
    var element = document.createElement("div");
    element.className = "dbr-capsule" + (detectDark() ? " dbr-capsule-dark" : "");
    element.id = CAPSULE_ID;
    element.setAttribute("role", "button");
    element.setAttribute("tabindex", "0");
    element.setAttribute("aria-label", "启动恢复：应用似乎没有正常启动，点按打开启动恢复中心");
    element.innerHTML = ICONS.rescue + '<span class="dbr-capsule-text">启动恢复中心</span>';
    element.addEventListener("click", onCapsuleClick);
    element.addEventListener("keydown", onCapsuleKeydown);
    host.appendChild(element);
    capsule = element;
    return element;
  }

  function showCapsule() {
    try {
      if (capsule || INSERTED || capsuleDismissed || isPreview || healthySeen) return;
      if (document.getElementById && document.getElementById(CAPSULE_ID)) return;
      buildCapsule();
    } catch (error) {
      // 胶囊只是兜底入口，失败不影响页面
    }
  }

  function onCapsuleClick(event) {
    try {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
    } catch (error) {
      // 忽略事件差异
    }
    removeCapsule();
    try {
      openPanel();
    } catch (error) {
      // 面板打开失败时不自动重试
    }
  }

  function onCapsuleKeydown(event) {
    try {
      if (!capsule || !event) return;
      var key = event.key === undefined || event.key === null ? "" : String(event.key);
      if (key === "Enter" || key === " " || key === "Spacebar" || event.keyCode === 13 || event.keyCode === 32) {
        if (typeof event.preventDefault === "function") event.preventDefault();
        onCapsuleClick(event);
      }
    } catch (error) {
      // 忽略键盘处理失败
    }
  }

  // ESC 关闭胶囊（契约 9.2）；胶囊不存在时完全不干预页面。
  function onCapsuleEscape(event) {
    try {
      if (!capsule || !event) return;
      var key = event.key === undefined || event.key === null ? "" : String(event.key);
      if (key === "Escape" || key === "Esc" || event.keyCode === 27) {
        if (typeof event.preventDefault === "function") event.preventDefault();
        closeCapsule();
      }
    } catch (error) {
      // 忽略键盘处理失败
    }
  }

  // DOMContentLoaded 后 15s：仍无健康 UI、也没挂救援面板时才挂小胶囊。
  // 用一次性 setTimeout（本文件禁止 setInterval 轮询）；观察上限沿用 MAX_WATCH_MS。
  function scheduleCapsuleCheck() {
    if (capsuleTimer || INSERTED || healthySeen || isPreview) return;
    capsuleTimer = window.setTimeout(function () {
      capsuleTimer = null;
      try {
        if (isPreview || capsuleDismissed || INSERTED) return;
        if (healthyUiPresent()) return;
        // 失败页识别成功就直接挂面板；识别不出（文案全变）才用胶囊兜底。
        mount();
        if (!INSERTED) showCapsule();
      } catch (error) {
        // 兜底入口失败不抛出
      }
    }, CAPSULE_DELAY_MS);
  }

  // ── 17. 侦测 / 挂载生命周期 ───────────────────────────────────────────────
  function stopWatching() {
    try {
      if (observer) observer.disconnect();
    } catch (error) {
      // 忽略断开失败
    }
    observer = null;
    if (watchStopTimer) { window.clearTimeout(watchStopTimer); watchStopTimer = null; }
    if (mountTimer) { window.clearTimeout(mountTimer); mountTimer = null; }
  }

  function scheduleMount() {
    if (INSERTED || mountTimer) return;
    mountTimer = window.setTimeout(function () {
      mountTimer = null;
      try { mount(); } catch (error) { stopWatching(); }
    }, 100);
  }

  // 健康 UI 已出现时说明不是失败页，没必要继续观察（避免健康页白挂 120s observer）。
  // 同时记下「健康 UI 出现过」这个事实：此后永不显示兜底小胶囊（契约 9.2）。
  function healthyUiPresent() {
    try {
      var host = document.getElementById("root") || document.body;
      if (host && host.querySelector && host.querySelector(HEALTHY_UI_SELECTOR)) {
        healthySeen = true;
        return true;
      }
    } catch (error) {
      return false;
    }
    return false;
  }

  // 增量第 1 条：loader 真实状态优先。无失败页文案、也无健康 UI 时先探一次 /state，
  // loader 报告 pending / failed 就直接挂救援面板（state 已拿到就复用，不重复请求）。
  function probeLoader() {
    if (INSERTED || loaderProbe) return;
    loaderProbe = true;
    api(API_STATE).then(function (state) {
      try {
        normalizeState(state);
        if (loaderIndicatesFailure()) {
          openPanel(state);
          return;
        }
        if (healthyUiPresent()) {
          removeCapsule();
          stopWatching();
          checkHealthyNotice(state);
        }
      } catch (error) {
        // 探针归一化失败：按文案判定 + 15s 胶囊继续兜底
      }
    }).catch(function () {
      // 探针失败不重试，避免频繁请求
    });
  }

  // 打开救援面板（失败页文案命中、loader 判定失败、或用户点小胶囊都会走这里）。
  // preloaded 用于复用已拿到的 /state，避免同一次判定发两次请求。
  function openPanel(preloaded) {
    if (INSERTED) return false;
    INSERTED = true;
    isPreview = !!(document.body && document.body.hasAttribute(PREVIEW_ATTR));
    removeCapsule();
    // 一旦决定挂载/展开就停止观察，避免自身 DOM 变更反复触发。
    stopWatching();
    var ready = preloaded ? Promise.resolve(preloaded) : api(API_STATE);
    ready.then(function (state) {
      try {
        normalizeState(state);
        if (appendOverlay(buildOverlay(), true)) popupFailureReady();
      } catch (error) {
        appendOverlay(buildFallback(error), false);
      }
    }).catch(function (error) {
      appendOverlay(buildFallback(error), false);
    });
    return true;
  }

  function mount() {
    try {
      if (INSERTED) return;
      var root = findFailureRoot();
      if (!root) {
        if (healthyUiPresent()) {
          removeCapsule();
          stopWatching();
          checkHealthyNotice();
          return;
        }
        // 文案判不出失败页：用真实 loader 状态再判一次（最高优先）；
        // 都不中才等 15s 小胶囊兜底。
        probeLoader();
        return;
      }
      openPanel();
    } catch (error) {
      stopWatching();
    }
  }

  // 增量第 6 条：先等宿主 __DSH_BOOT_READY__ 再扫 DOM，避免首帧竞态。
  // 带 5s 兜底（deferred 永不 settle 也能开始）；startWatching 自身幂等。
  function waitBootReady() {
    var deferred = null;
    try {
      if (typeof window !== "undefined") deferred = window.__DSH_BOOT_READY__;
    } catch (error) {
      deferred = null;
    }
    try {
      if (!deferred && typeof globalThis !== "undefined") deferred = globalThis.__DSH_BOOT_READY__;
    } catch (globalError) {
      deferred = null;
    }
    if (deferred && deferred.promise && typeof deferred.promise.then === "function") {
      try {
        deferred.promise.then(startWatching, startWatching);
        bootReadyTimer = window.setTimeout(startWatching, BOOT_READY_FALLBACK_MS);
        return;
      } catch (error) {
        // deferred 异常时按「没有 deferred」处理
      }
    }
    startWatching();
  }

  function startWatching() {
    try {
      if (started || INSERTED) return;
      started = true;
      if (bootReadyTimer) { window.clearTimeout(bootReadyTimer); bootReadyTimer = null; }
      // 首次检查：DOMContentLoaded（或 boot ready）后立即执行一次。
      mount();
      // 1.2.0 C 项：15s 后仍无健康 UI 时挂兜底小胶囊（面板已挂载则不挂）。
      scheduleCapsuleCheck();
      if (INSERTED || observer || typeof MutationObserver === "undefined") return;
      var target = document.documentElement || document.body;
      if (!target) return;
      // 只观察、不轮询；失败页可能在首次检查之后才渲染出来。
      observer = new MutationObserver(scheduleMount);
      observer.observe(target, { childList: true, characterData: true, subtree: true });
      // 观察上限 120000ms，超时后永久停止，避免长期占用渲染进程。
      watchStopTimer = window.setTimeout(stopWatching, MAX_WATCH_MS);
    } catch (error) {
      stopWatching();
    }
  }

  function boot() {
    try {
      if (document.body && document.body.hasAttribute(PREVIEW_ATTR)) isPreview = true;
      if (document.addEventListener) {
        document.addEventListener("keydown", onDialogKeydown);
        document.addEventListener("keydown", onCapsuleEscape);
      }
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", waitBootReady, { once: true });
      else waitBootReady();
    } catch (error) {
      stopWatching();
    }
  }

  boot();
})();
