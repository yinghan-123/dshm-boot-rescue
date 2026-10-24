# dshm-boot-rescue 1.3.0 —— 使用期体检与提前预警

在 1.2.0 基础上新增「**平时就在看**」的能力：不等失败页，使用过程中就发现新出现的故障插件，
通过弹窗 / 角标 / 报告文件告知，并支持在弹窗里一键停用。

版本：`1.2.0` → **`1.3.0`**。

## 1. 巡检模型（宿主侧）

```jsonc
// risk 对象（/state.risks[]、/risks、报告文件三者同构）
{
  "id": "dsh-market",              // entry id；配置类风险没有 id 时用 "config:<name>"
  "name": "dsh-market",
  "level": "critical" | "warn" | "info",
  "kind": "failed" | "pending" | "disposed" | "missing-package" | "config" | "self-heal" | "rescue-readonly" | "inject-channel",
  "message": "加载失败（state=failed）",
  "missing": ["demo-service"],     // pending 时缺失的服务
  "firstSeen": "ISO",
  "lastSeen": "ISO",
  "hits": 3,                       // 连续命中采样次数
  "sinceBaseline": true,           // 相对「上次健康快照」是新增/变坏
  "actionable": true,              // 可以在弹窗里一键停用
  "suggest": "disable" | "inspect" | "none"
}
```

判定规则（每次采样按顺序算）：

| kind | 条件 | level | actionable |
| --- | --- | --- | --- |
| `failed` | `fiber.state === "failed"` | critical | true（`levels` 里有 rows/bundles 且非 protected） |
| `pending` | `fiber.state === "pending"`；`hits < 2` 时 warn，`hits >= 2` 升 critical | warn→critical | 同上 |
| `disposed` | 运行期 `state === "disposed"`，且**在** baseline 里（原本健康、现在被销毁） | warn | true |
| `missing-package` | `dsh.profile.bundles` 里的项在 `node_modules` 里不存在 | critical | false（包都不在，停用无意义；指引重装或用 `/disable-bundle`） |
| `config` | 用户行/patch 结构解析失败、bundles 不是数组、package.json 非法 | warn | false |
| `self-heal` | 检测到 `.dshm-boot-failed` 或可合并的 `*.quarantine-*` | warn | false |
| `rescue-readonly` | 救援服务处于只读（`readOnlyReasonCode` 非空） | warn | false |
| `inject-channel` | `injectChannelCount < 2` | info | false |

`sinceBaseline`：与「健康基线」（记在 `risks.json` 的 `baseline` 里）比较——
**baseline 里原本是 active、当前不是 → `true`（变坏）**；从没进过基线的插件不标「新增」
（新装插件第一次出问题算「已知现状」，等修好后基线才把它收进去）。
基线只在「全部 entry 都 active 且无 critical/warn」时更新，所以装好后第一次干净启动才会建立。

## 2. 巡检节奏

- **事件驱动**：`ctx.on("loader/entry-init" | "loader/config-update" | "loader/partial-dispose" | "loader/volatile-update", …)`，
  每个事件 600ms debounce 后触发一次采样；事件只做「触发」，不做逻辑。
- **兜底采样**：每 **60s** 一次（`setTimeout` 链，`unref()`；停止时清理）。
- 采样必须**极轻**：只读 `loader.entries()` 的 state + 已缓存的配置读取，单次 < 5ms 量级；任何异常只记日志，绝不影响宿主。
- 采样结果与上一次 diff：state 变化 / 集合变化 → 写一行 `watch.jsonl`，并更新 `runtime.watch.changes`。
- `POST /watch {"enabled":false}` 可以关掉巡检（关闭后 `/state.risks` 只做一次性采样）。

## 3. 落盘

| 文件 | 内容 |
| --- | --- |
| `$DSH_HOME/dshm-boot-rescue-risks.json` | 最新全量：`{version, generatedAt, watch:{...}, risks:[...]}`（原子写，最多保留全部 risk ≤ 100 条） |
| `$DSH_HOME/dshm-boot-rescue-watch.jsonl` | 追加式变化历史，一行一个事件 `{at, type:"state-change"/"scan"/"risk-added"/"risk-cleared", id, from, to}`；超过 500 行时重写保留最近 200 行 |

## 4. `/state` 新增字段

```jsonc
{
  "risks": [ /* risk 对象 */ ],
  "watch": {
    "enabled": true,
    "intervalMs": 60000,
    "lastScanAt": "ISO",
    "lastChangeAt": "ISO",
    "scans": 12,
    "changes": 3,
    "events": { "loader/entry-init": 2, "loader/config-update": 0 },
    "risksFile": "…/dshm-boot-rescue-risks.json",
    "watchFile": "…/dshm-boot-rescue-watch.jsonl"
  },
  "riskCounts": { "critical": 1, "warn": 2, "info": 0 }
}
```

`/state` 请求时**先做一次即时采样**（同步逻辑，走缓存），保证 UI 拿到的是新鲜的。

## 5. 新路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/risks` | `{ok, generatedAt, risks[], riskCounts, watch}`，比 `/state` 轻，给角标轮询用 |
| GET | `/watch` | 巡检状态摘要 |
| POST | `/watch` | `{enabled: bool}` 开关巡检；返回新状态 |

## 6. 客户端（rescue-client.js）

### 6.1 启动时风险弹窗

正常界面（健康 UI 在）加载完成后，若 `state.risks` 非空：

- 标题按最高等级：critical → 「发现 N 个插件状态异常」，warn → 「发现 N 个插件可能需要关注」
- 正文列表最多 5 条：`名称 — 状态说明`（`sinceBaseline` 为 true 的打「新增」标记）
- 按钮：**「立即停用有问题的插件」**（收集 `actionable` 的 id，`POST /disable`）｜「打开恢复中心」｜「稍后」
- 复用现有弹窗组件（`notifyDialog` / `popupWriteResult`），不新造轮子。
- 若是失败页场景，救援面板照旧；风险信息并进面板顶部（`state.notice` 旁边显示 `风险 N`）。

### 6.2 常驻角标（仅健康界面）

- 右下角小胶囊：`● N`，critical 红色 / 仅 warn 黄色 / 全 info 灰色。
- 点击展开轻面板：风险列表 + 「停用这些」+「打开恢复中心」+「关闭角标」（本次页面生命周期内）。
- 轮询：**`window.setTimeout` 链，每 60s 一次**（禁止 `setInterval`），满足：
  - `document.hidden` 时暂停，`visibilitychange` 恢复时立即拉一次；
  - 连续 3 次请求失败 → 自动停止并隐藏角标；
  - 页面卸载/隐藏超过 30 分钟停止；
  - 自检页（`data-dshm-boot-rescue-preview`）不显示角标，也不轮询。
- 角标 DOM id：`dshm-boot-rescue-badge`；类前缀沿用 `dbr-`。
- 角标数字 = critical 数；无 critical 但有 warn 时显示 warn 数并变黄；全清空时角标淡出移除。

### 6.3 旧宿主 / 旧页面兼容

- `state.risks` 缺失 → 客户端按「无风险」处理，不弹窗、不显示角标；
- 自身仍是零依赖 IIFE、ES5 语法，不新增 import/require/Worker/WASM/eval/new Function/可选链/空值合并/外部请求/浏览器存储。

## 7. 静态规则调整（tools/check.mjs）

- 保留「禁止 setInterval」；新增「角标轮询必须用 setTimeout 链，且必须有 `document.hidden` 判断」的正向检查（出现 `dshm-boot-rescue-badge` 时必须同时出现 `document.hidden`）。
- 新增宿主侧必需导出：`scanRisks` / `readRisksReport` / `startWatchdog`；
- 新增禁止：`/state` 里出现阻塞式同步大 IO（保持只读、轻量）——以「禁止 `readFileSync` 在 scanRisks 里处理大文件」的口径人工检查即可，规则只做提示。

## 8. 验收

- `/state.risks` 有结构、`/risks` 轻量可用；
- 造一个假 pending（`/state` 里能看到的真实插件不行就造测试用 `loader` 假对象）→ risks 里出现 `pending`；
- 正常界面刷新 → 有 risks 时弹窗出现，点「立即停用」走 `/disable` 并提示热停用/重启；
- 角标出现、60s 后自动刷新、切后台暂停、自检页不出现；
- 报告文件与 jsonl 生成；关掉巡检后 `/state.watch.enabled === false`；
- 端侧无 node：用 python 复刻规则 + 词法/结构检查 + 语义对照测试。
