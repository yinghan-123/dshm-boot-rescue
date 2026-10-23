# 来源与改动说明（NOTICE）

本目录不是本项目作者的官方仓库，而是对以下上游代码的**镜像 + 本地安全加固**：

- 上游：<https://github.com/huangshou1/dshm-boot-rescue>
- 分支 / commit：`main` / `3c0456576ba9aba327633bd1bc9f296fe854e08b`
- 抓取时间：2026-10-23

## 与上游的差异（仅 1 个文件）

| 文件 | 上游 blob sha1 | 本副本 |
| --- | --- | --- |
| `README.md` | `6ca31dc5…` | 未改动（仅安装段落占位符替换，见下） |
| `package.json` | `94432e66…` | 仅补 `repository` / `homepage` 字段 |
| `cordis.patch.yml` | `5841af2b…` | 未改动 |
| `lib/index.js` | `0d906b6b…` | **已加固**，见下 |
| `lib/rescue-client.js` | `4dfbbb0e…` | **已新增弹窗提示**（见下） |
| `test/rescue.test.mjs` | `9f14458f…` | 未改动 |
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
`package.json` 版本从 1.0.0 提升到 1.1.0；宿主半身 `lib/index.js` 未改动，
「回环校验严格化」加固补丁原样保留。
