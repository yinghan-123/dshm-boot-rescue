# 来源与改动说明（NOTICE）

本目录不是本项目作者的官方仓库，而是对以下上游代码的**镜像 + 本地安全加固**：

- 上游：<https://github.com/huangshou1/dshm-boot-rescue>
- 分支 / commit：`main` / `3c0456576ba9aba327633bd1bc9f296fe854e08b`
- 抓取时间：2026-10-23
- 仓库关系：自 2026-10-23 起 `yinghan-123/dshm-boot-rescue` 是上游的 **GitHub fork**
  （页头 forked from `huangshou1/dshm-boot-rescue`，可用 Sync fork 同步上游）。
  下列增量以多条提交叠在上游历史之上：`27d1f190` 引入 1.0.0 副本、
  `d684dbb4` 弹窗提示 1.1.0、`03407cf9` 文档修正；当前版本 **1.1.1**。

## 与上游的差异

| 文件 | 上游 blob sha1 | 本副本 |
| --- | --- | --- |
| `README.md` | `6ca31dc5…` | **已改**：安装命令指向本仓库，新增「弹窗提示」章节 |
| `package.json` | `94432e66…` | **已改**：补 `repository` / `homepage` / `bugs`，版本 1.1.1 |
| `cordis.patch.yml` | `5841af2b…` | 未改动 |
| `lib/index.js` | `0d906b6b…` | **已加固**，见下 |
| `lib/rescue-client.js` | `4dfbbb0e…` | **已新增弹窗提示**（见下） |
| `test/rescue.test.mjs` | `9f14458f…` | **已随弹窗调整断言**（见下） |
| `tools/check.mjs` | `e6bd5ee6…` | 未改动 |

### 加固 1：回环校验从「前缀匹配」改为严格 IPv4 字面量

`lib/index.js` 的 `isLoopbackAddress()` 原本用 `value.indexOf("127.") === 0` 判断回环，
而 `hostHeaderIsLoopback()` 直接复用该函数校验 `Host` 头。结果
`Host: 127.0.0.1.attacker.com:3120` 这类**域名**会被当成回环字面量，与 README 声称的
「Host 头本身是回环字面量」不符。

后果：本机 webServer 无 token/Cookie 鉴权（`@deepseek-ai/dsh-host-webserver` 已核），
这层回环判断是写接口唯一防线。攻击者用 `127.0.0.1.<自己的域名>` 先返回恶意页、
再 DNS rebind 到 `127.0.0.1`，即可同源 `POST + application/json` 调用
`/dshm-boot-rescue/disable` 停用任意插件（Origin/Host 一致、`sec-fetch-site: same-origin`、
`socket.remoteAddress = 127.0.0.1` 三项校验全部通过）。

改法：`127.0.0.0/8` 与 `::ffff:127.0.0.0/104` 都要求完整四段字面量、每段 0–255。

对抗矩阵（Python 移植 JS 语义实测，15/15）：

- 放行：`127.0.0.1:3120`、`localhost:3120`、`[::1]:3120`、`127.0.0.1%eth0:3120`、
  `::ffff:127.0.0.1`、`::ffff:7f00:1`
- 拒绝：`127.0.0.1.attacker.com:3120`、`127.0.0.1.nip.io:3120`、`127.evil.com:3120`、
  `127.0.0.01:3120`、`127.0.0.256:3120`、`localhost.evil.com:3120`、
  `[::ffff:127.0.0.1.evil.com]:3120`

### 未修的上游问题（如实列出）

1. `isInside()` 不解析符号链接：profile 目录若被替换成指向 home 外的链接，写入会落到
   home 外；备份用固定文件名 `<rows>.dshm-boot-rescue.bak` 也可被预置链接利用。
   前提是攻击者已能在 profile 目录建链接。
2. `GET /state` 不做 Host/Origin 校验，DNS rebind 下可读 `rowsPath`/`profileDir`/插件列表。
3. 客户端挂载条件比 README 宽：无 `Failed to load plugins` 标题时命中 5 类失败正则也会挂。
4. `yamlQuoteId()` 未覆盖 `[` `{` `]` `}` `,` 等 flow 指示符开头（现有 id 不触发）。
5. 「核心 seed 覆盖行永不可停用」靠「patch 行无 `name:` + `@deepseek-ai/` 前缀」间接保证，
   没有 `web-runtime` / `subprocess` / `sandbox` 硬黑名单。
6. `/health`、`/preview`、`/client.js` 无回环限制（只读）。
7. 恢复拒绝删除时没有逐块提示，与 README 关于「只提示」的描述有落差。

## 声明

本副本的加固改动与上游作者无关，不代表上游认可。上游 README 声明 MIT，
但上游仓库当时没有 `LICENSE` 文件；本目录补的 `LICENSE` 保留原始版权人
（`dshm-boot-rescue contributors`），本副本的修改同样以 MIT 发布。

### 本地新增功能：救援脚本弹窗提示（2026-10-23）

`lib/rescue-client.js` 增加自绘弹窗组件与五类提示：失败页就绪提示、降级模式红色警示、
正常启动时的「启动救援已就绪」状态提示、正常界面的「救援停用项」提醒、
以及停用/恢复成功与失败的结果提示。
实现约束与原脚本一致：ES5 语法、零依赖、不写浏览器存储、不新增外部请求、不自动重载页面。

同步更新 `test/rescue.test.mjs` 中受影响的浏览器行为断言（健康界面巡检、失败页面板 +
弹窗、幂等），并新增 2 个弹窗用例（正常界面救援停用项、降级模式）。
随后追加「日常检查」：宿主 `lib/index.js` 新增只读的 `buildDailyChecks()` /
`attachChecks()`，`/state` 返回 `state.checks`（7 项，含救援服务、数据目录、profile、
用户行文件、写入目标、救援停用项、写入前备份），首次生成时写一行诊断日志；客户端弹窗
渲染成 `✓ / ! / ✕` 清单。检查不写文件、不额外读 profile，回环校验加固补丁原样保留。

`package.json` 版本从 1.0.0 提升到 1.1.0；宿主半身除上述日常检查外未改动其他逻辑。

## 1.2.0 增强（2026-10-24，尚未发布到 GitHub）

本轮按 `docs/ENHANCE-2026-10-24.md` 契约实现，分六个增强 + 六条调研增量：

### 宿主半身（`lib/index.js`，+1569 行）

| 代号 | 能力 | 落点 |
| --- | --- | --- |
| A | **注入双通道**：`webServer.tapIndex` + 订阅 `webserver/index-inject` 推 `script-src` 行 | `attachIndexInject()`、`injectChannelCount()`；`/health` 增加 `indexInject` / `channels` |
| B | **救援台账**：注释标记被抹掉后按 `blockDigest` 指纹恢复 | `readLedger()`/`upsertLedgerEntry()`/`removeLedgerEntries()`/`removeRowsByLedger()`；`$DSH_HOME/dshm-boot-rescue-ledger.json` |
| C | （客户端）失败识别增强 + 15s 兜底胶囊 | 见下 |
| D | **三级停用**：用户行 → patch 降级 → 从 `dsh.profile.bundles` 移除 | `/disable-bundle` `/restore-bundle`、`planBundleRemoval()`、`writeProfileBundles()`；`@deepseek-ai/*` 与 `dsh-base`/`dsh-web-app` 硬保护、拒绝清空 |
| E | **启动失败残留恢复**：`.dshm-boot-failed` / `*.quarantine-*` 检测与合并 | `scanQuarantine()` `parseQuarantineBlocks()` `mergeQuarantineRows()`、`/quarantine/restore` |
| F | **安全模式 + 良好快照** | `/safe-mode`（`confirm:true` 二次确认）、`/snapshot` `/rollback`、启动 15s 后自动快照、`keep=5` |
| G | **loader 真实状态**：不再只靠失败文案猜 | `readLoaderDetails()`；`state.loader.pending/failed/missing`；`fiberStateName()` 对齐 cordis FiberState |
| H | **运行期热停用**：能热停用就「重新打开本页面」即可生效 | `tryHotDisable()`（`loader.update(id,{disabled:true})`，失败回退 `entry.update`） |
| I | **required 黑名单** | `REQUIRED_ENTRY_IDS`（`agent-loop`/`webserver`/`web-runtime`/`modules`/`connection`/`headless-runner`/`acp`/`sdk-jsonrpc-server`）→ `protectedReason:"required"` |
| K | 隔离残留提示 | `state.notice` |
| L | 自检页多形态 | `/preview?shape=title\|pending\|import\|empty` |

`/state` 新增 `features` / `inject` / `ledger` / `bundles` / `quarantine` / `snapshot` / `loader` / `notice`，
`entries[]` 新增 `inBundles` / `bundleName` / `bundleRemovable` / `levels`；日常检查从 7 项扩到 12 项。

### 客户端半身（`lib/rescue-client.js`，+1258 行）

- 失败页判定改为三级：`state.loader` 有 pending/failed → 文案/正则 → 15s 无健康 UI 的右下角兜底胶囊；
- 先等宿主 `__DSH_BOOT_READY__`（5s 兜底）再扫 DOM，避免首帧竞态；
- 面板新增：安全模式（二次确认）、每行「bundle 停用」、隔离残留合并、快照回滚/立即快照、救援台账；
- 写操作后按 `hotDisabled` 决定文案：「重新打开本页面即可生效」或「划掉后台重新打开应用」；
- 旧宿主（1.1.1 无新字段）静默降级；仍是零依赖 IIFE、无 import/require/Worker/WASM/setInterval、
  无 `location.reload`、无可选链/空值合并、不写浏览器存储、不请求外部 URL。

### 调研依据

外部：systemd-delta（按内容判归属）、ClamAV（隔离只 move/copy 不 delete）、VS Code extension bisect
（全自动二分不可靠，保留人工确认）、cordis-plugin-loader 官方 API 表、dsh-host-webserver 源码（注入 row 类型）。
本机：`@deepseek-ai/dsh-app-boot`（FIBER_* 与 required 列表）、`@deepseek-ai/dsh-host-webserver`
（`renderIndex` = rows 后跑 taps、`__DSH_BOOT_READY__` deferred、compression/threshold）。

调研明确**不做**的：不自动删除插件包（只做可逆移动/移除 bundles 项）、不做全自动二分、
不把 `cordis.patch.yml` 当持久层、不靠注释标记证明归属。

> 1.2.0 目前只存在于工作区副本，**未 push 到 `yinghan-123/dshm-boot-rescue`**；
> 端侧验证走「本地 dev 部署」（直接覆盖 `node_modules/dshm-boot-rescue`），回滚用
> `_build/deploy_120.py rollback` 或重新 `pnpm add` 安装 GitHub 版。

