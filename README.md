# dshm-boot-rescue — DSHM 启动救援

给 **DSHM（鸿蒙端 DeepSeek Harness）** 用的一把「启动备用钥匙」。

当某个插件把 Web UI 弄成只剩一行 `Failed to load plugins` 的失败页、而插件管理页
也跟着一起打不开时，这个插件会由宿主直接把一段很小的救援脚本注入失败页，让你在
**不依赖其它插件加载链**的情况下找出肇事插件、临时停用，然后把工作区救回来。

> 一句话：**插件的启停只在进程启动时拼装**。救援中心只负责把「停用」写进持久配置，
> 真正生效靠**划掉后台、重新打开 DSHM 应用**，不是重新打开这个页面。

---

## 它解决什么问题

DSH 的插件是启动时由 `cordis.patch.yml` 拼装加载的。一旦某个插件在加载阶段报错，
Web UI 可能停在失败页，而「设置 → 插件」本身也是 Web UI 的一部分——于是形成一个
死循环：**知道是哪个插件的问题，却没有入口去关它。**

`dshm-boot-rescue` 不依赖正常的客户端插件加载链：

- 它是**纯宿主插件**（只有宿主半身，没有 cordis client 半身）；
- 宿主启动时会注册 `/dshm-boot-rescue/*` 路由，并在 `index.html` 里通过 `tapIndex`
  追加一段**单文件、零依赖**的救援脚本 `lib/rescue-client.js`；
- 即使其它插件全部无法激活，这段脚本仍然会被浏览器执行，从而在失败页上挂出
  「启动恢复中心」。

它和一般的「插件守护」不同，专门处理 DSHM 的端侧现实：

1. DSHM 的**持久启停位置**是 profile 目录下的 `.dshm-plugin-rows.yml`
   （`$DSH_HOME/profiles/<profile>/.dshm-plugin-rows.yml`）；
2. `cordis.patch.yml` **每次进程启动都会被核心种子重新拼装**，直接改它只能撑到下次
   重启，所以默认不写它；
3. 用户行文件里的「行 id」是 **profile patch 的 entry id**（如 `dsh-market`、
   `ui-chat`），**不是包名**，所以必须先做「失败文案里的名字 → 真实行 id」映射；
4. DSHM 的「插件」页会重写用户行文件，只保留它自己的头注释和 `id/disabled` 行，
   **会丢掉其它注释**，所以救援标记不能假设永远存在。

---

## 目录结构

```text
dshm-boot-rescue/
  package.json
  cordis.patch.yml          # bundle patch：注册插件自身（行 id = dshm-boot-rescue）
  lib/index.js              # 宿主插件：路由、状态、用户行读写、注入
  lib/rescue-client.js      # 注入失败页的单文件救援脚本
  README.md                 # 本文件
  test/rescue.test.mjs      # node:test 单元测试
  tools/check.mjs           # 零依赖静态自检脚本
```

---

## 安装（DSHM 端侧）

前置：DSHM 已安装并能正常进入界面。

> 本仓库是 huangshou1/dshm-boot-rescue 的镜像，`lib/index.js` 已带本地安全加固（见 NOTICE.md）。

### 方式 A：设置里安装（推荐）

1. 打开 DSHM → **设置 → 插件**；
2. 在「安装插件」输入框里填：
   ```text
   github:yinghan-123/dshm-boot-rescue
   ```
3. 确认安装，等待完成（端侧安装要下载、解包、写 profile，通常需要几十秒）；
4. **划掉后台重新打开应用**（从最近任务里划掉 DSHM，再重新打开）。
   只重新打开页面或切回前台都不算，插件行不会重新拼装。

> 安装 spec 的通用写法是 `github:<owner>/dshm-boot-rescue`；本仓库把 `<owner>` 换成
> `yinghan-123`。

### 方式 B：端侧命令行安装

DSHM 端侧没有真正的 node/pnpm，`pnpm` 是宿主提供的假壳：它会把安装请求投递给
Host 进程内安装器，并同步返回结果。在 DSHM 的终端/Agent Shell 里执行：

```sh
pnpm add github:yinghan-123/dshm-boot-rescue
```

成功会打印 `ok:true` 的 JSON，失败会打印 `ok:false` 与原因。
安装完成后同样必须**划掉后台重新打开应用**。

### 安装后确认

重新打开应用后，用浏览器访问（端口以 `$DSH_HOME/host-ready.json` 的 `baseUrl`
为准，本机当前是 `http://127.0.0.1:3120`）：

- 健康检查：`http://127.0.0.1:3120/dshm-boot-rescue/health`
- 只读自检页：`http://127.0.0.1:3120/dshm-boot-rescue/preview`

`/health` 返回 `{"ok":true,...}` 即说明宿主半身已加载、路由已注册。

如果安装后设置 → 插件里看不到它，或者 `/health` 打不开，先看诊断日志
（见下文「诊断日志」），并确认已经**划掉后台重新打开**过应用。

### 卸载

- 优先：DSHM **设置 → 插件** 中停用/卸载 `dshm-boot-rescue`，然后**划掉后台重新打开应用**；
- 如果插件页也打不开：按「只读与手动恢复」里的方法删除本插件写入的标记行，
  再从系统侧卸载插件包（或在能进系统后回到设置页卸载）。

---

## 失败页救援流程

### 救援中心何时出现

同时满足以下条件时，救援脚本会挂出覆盖层面板：

1. 页面根节点（`#root`，或 `document.body`）的文本包含失败标题
   `Failed to load plugins`；
2. 根节点内**没有**任何「健康 UI」信号（树、输入框、可编辑区域等）——
   所以在聊天记录里引用这段错误文本不会误挂面板；
3. 救援脚本由宿主注入成功（`/dshm-boot-rescue/client.js` 可加载）。

面板只挂一次（幂等），挂载成功后停止观察；最多观察 120 秒。

### 操作步骤

1. 失败页出现后，稍等片刻，「启动恢复中心」会覆盖在页面上；
2. 顶部会显示救援服务状态：**在线 / 只读 / 降级模式**，以及版本号；
3. 「疑似故障」标签页会列出从失败文案里解析出的插件，并**自动勾选**可操作的项；
   如果没猜中，可以搜索名称/包名/入口 id，或切到「用户插件」手动勾选；
4. 点击 **「停用所选并等待重启」**；
5. 成功后页面会提示：**「停用后请划掉后台重新打开应用」**；
   插件启停只在进程启动时拼装，重新打开这个页面不会生效；
6. 从最近任务里**划掉 DSHM 后台，重新打开应用**；
7. 界面恢复正常后，**再普通重启一次**，确认停用状态保持（说明已写进持久用户行文件）。

### 修好插件之后恢复

- 单行恢复：在恢复中心列表里点该行的「恢复」；
- 批量恢复：「恢复救援停用项」需要**二次点击确认**；
- 恢复后同样需要**划掉后台重新打开应用**才真正生效。

### 复制诊断

面板上的「复制诊断」会复制：版本、生成时间、模式、只读原因、`rowsPath` /
`profileDir`、疑似插件、已救援项、失败页文本。剪贴板不可用时会退化为文本框选中，
方便贴到 Issue 里排查。

---

## 弹窗提示（本副本新增）

`lib/rescue-client.js` 在原有覆盖式面板之外，新增了一层**自绘弹窗**（零依赖、与面板同风格、
支持暗色、非阻塞）。弹窗完全由客户端脚本渲染，只在浏览器里出现，不会回写任何配置。

| 弹窗时机 | 标题 | 主要动作 |
| --- | --- | --- |
| 失败页刚挂载救援面板 | 「检测到插件加载失败」 | 「打开恢复中心」关闭弹窗、露出面板 |
| 失败页 + 降级模式（patch-fallback） | 红色「降级模式：本次停用重启后可能失效」 | 正文固定包含降级警示原文 |
| 正常界面启动（无异常） | 「启动救援已就绪」：**日常检查清单**（7 项） | 「知道了」关闭；点遮罩也能关 |
| 正常界面启动（存在救援停用项） | 「N 个插件由启动救援停用」，列出 entry id | 「立即恢复全部」撤销救援停用行；「稍后」忽略 |
| 停用 / 恢复成功之后 | 「已停用 N 个插件」/「已恢复 N 个插件」 | 强调**必须划掉后台重新打开应用** |
| 停用 / 恢复失败 | 「停用失败」/「恢复失败」 | 展示错误原因 |

行为约束：

- 弹窗与面板互相独立：正常界面没有面板也会弹，失败页则叠在面板之上；
- 同一页面生命周期内同类提示只弹一次（内存去重，**不写 cookie / localStorage / sessionStorage**）；
- 操作结果类弹窗允许重复（每次停用 / 恢复都会弹一次）；
- 支持 ESC 关闭、`role="dialog"` / `role="alertdialog"` 无障碍属性；
- 弹窗只做提示与「恢复」入口，不会自动重载页面、不会自动跳转；
- 正常界面每次页面加载弹一次状态提示（「启动救援已就绪」+ 日常检查清单）；若存在救援
  停用项或已进入降级模式，则改弹对应的强提醒，强提醒里同样附检查清单；
- 当救援服务完全不可用（连 `/state` 都拿不到）时，正常界面保持安静，不弹错误提示。

### 日常检查

每次 `/state` 请求都会生成一份**只读**检查结果（`state.checks`），客户端在弹窗里渲染成清单；
宿主进程启动后第一次生成时会往 `$DSH_HOME/dshm-boot-rescue.log` 写一行
「日常检查：救援服务=ok，数据目录=ok，…」。

1.1.1 的固定 7 项（保留）+ 1.2.0 追加的 6 项，现在共 **13 项**：

| 检查项 | 通过 | 注意 | 失败 |
| --- | --- | --- | --- |
| 救援服务 | 在线（带版本） | 降级模式（写 patch，重启后可能失效） | 只读（附只读原因） |
| 数据目录 | 已定位 `DSH_HOME` / `DSHM_HOME` | — | 未找到 |
| Profile | 已定位声明 `dsh.profile` 的目录 | — | 无法定位 |
| 用户行文件 | 存在且结构正常 / 尚未创建（首次写入时自动创建） | 结构异常 → 已切换降级写入 | 无法读取 |
| 写入目标 | profile 的 `.dshm-plugin-rows.yml` | `cordis.patch.yml`（降级） | 只读，无法写入 |
| 救援停用项 | 无 | N 项（列出 entry id） | — |
| 写入前备份 | 存在（大小）/ 尚无备份（首次写入时创建） | — | — |

1.2.0 追加的 6 项：

| 检查项 | 通过 | 注意 | 失败 |
| --- | --- | --- | --- |
| loader 状态 | 全部 active（附计数） | 有 pending（列出 entry id）；或读不到 loader（退回文案判定） | 有 failed |
| 注入通道 | 双通道均可用（tapIndex + index-inject） | 只有单通道可用（附两边状态） | 两条都不可用 |
| 救援台账 | 可读（N 条记录 / 空台账） | 损坏或读不出（恢复降级为只用注释标记） | — |
| 良好快照 | 有快照（份数 + 最近一份时间/原因） | 还没有快照（启动 15 秒后自动创建） | — |
| 启动失败残留 | 无残留 | 检测到 `.dshm-boot-failed`，或 N 个隔离文件可合并恢复 | — |
| profile bundles | 可读（N 项，其中 M 项可被救援移除） | 读不出（附原因） | — |

弹窗里的符号：`✓` 通过、`!` 注意、`✕` 失败。检查只读文件与内存状态，**不写任何文件**、
不额外读 profile；唯一额外 I/O 是对备份文件的一次 `stat`。

---

## 恢复功能语义（只删本插件标记行）

默认模式写入的是 **`.dshm-plugin-rows.yml`**，追加一个 3 行块：

```yaml
# [dshm-boot-rescue] disabled <id>
- id: <id>
  disabled: true
```

- `<id>` **必须**来自「已知真实 entry id」集合，绝不会直接拿失败文案里的名字乱写；
- 需要 YAML 引号时（以 `@ \` * & ! % # ~ |` 开头、含 ` #` / `@` / `#`、首尾空格等）
  使用单引号规则；标记行里的 id 保持原字符串；
- 写入前会把原文件备份到 `<文件>.dshm-boot-rescue.bak`（覆盖旧备份即可）；
  备份失败则拒绝写入（fail closed）；
- 通过同目录临时文件 + 原子 rename 提交，提交前复核文件未被外部修改，最多重试 4 次；
  同一文件的所有修改串行执行；
- 追加时保留原文件内容：BOM、注释、其它用户行都不动；换行风格会按文件的主导风格
  （CRLF 或 LF）统一归一化，因此「逐字节不动」只对原本就是同一换行风格的文件成立。

恢复时**只删除本插件自己写入的完整块**：

- 标记行 + 下一行 `- id: <同一 id>` + 再下一行严格 `  disabled: true`；
- 且该块后面不能紧跟缩进续行；
- 用户改过的块（加了字段、改了缩进、id 对不上、`disabled` 不是 `true`）一律**拒绝删除**，
  只提示，不猜测。

因为 DSHM 插件页会重写用户行文件、丢掉其它注释：**如果标记注释被 DSHM 插件页抹掉，
恢复功能就无法证明这一行是本插件写的，会拒绝删除**。这不影响正常启停，只是提示你
需要手动处理（见下一节）。

本插件不会删除插件包、不会碰插件数据、不会动 `node_modules`，也不会清理别人的行。

---

## 1.2.0 增强：从「写一行」到「多级可逆救援」

1.1.1 只有一条路：把停用写进 `.dshm-plugin-rows.yml`，再划掉后台重开。1.2.0 在这条路
旁边补齐了几条退路，核心原则没变：**不删插件包、不动 `node_modules`、所有写操作可逆、
任何环节出错只降级不阻塞**。

1.2.0 新增的落点与入口：

| 能力 | 一句话 | 对应路由 |
| --- | --- | --- |
| 三级停用 | 用户行 → patch 降级 → 从 `dsh.profile.bundles` 移除 | `/disable`、`/disable-bundle`、`/restore-bundle` |
| 运行期热停用 | 能热停用就「重新打开本页面」生效，不能才划掉后台 | `/disable`、`/safe-mode` 的 `hotDisabled` |
| 救援台账 | 注释被 DSHM 插件页抹掉后，按行块指纹恢复 | 复用 `/restore` |
| 良好快照 | 启动 15s 后自动存一份，可一键回滚 | `/snapshot`、`/rollback` |
| 隔离残留恢复 | 识别 `.dshm-boot-failed` 与 `*.quarantine-*` 并合并 | `/quarantine/restore` |
| 安全模式 | 一键停用全部非核心插件（二次确认） | `/safe-mode` |
| 双通道注入 | `tapIndex` + `webserver/index-inject`，任一即可 | `/health` 的 `channels` |
| loader 真实状态 | 直接读 `state.loader.pending/failed/missing`，不再靠文案猜 | `/state` 的 `loader` |
| required 黑名单 | 宿主骨架 entry 永不停用 | `/state` 的 `protectedReason: "required"` |

### 三级停用：用户行 → patch 降级 → bundles 移除

同一个插件有三个落点，救援中心按「先轻后重」尝试：

| 级别 | 写什么 | 何时用 | 跨重启 |
| --- | --- | --- | --- |
| `rows` | `.dshm-plugin-rows.yml` 加标记块 | 默认 | 持久 |
| `patch` | `cordis.patch.yml` 加降级块 | 用户行文件结构非法 | 可能被 carry，不保证 |
| `bundles` | 从 profile `package.json` 的 `dsh.profile.bundles` 里移除该项 | rows/patch 已写但插件仍参与启动，或用户行被插件页反复改写 | 持久、**不删包** |

`bundles` 级的三条铁律，违反任意一条整单拒绝（`bundle-protected`，一个 id 非法就全单
不执行，不做部分移除）：

1. 名字以 `@deepseek-ai/` 开头的一律不可移除；`dshm-boot-rescue` 自己也不可移除；
2. 剥离后数组**不允许为空**；
3. 剥离后必须仍包含 `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app`。

移除只改 `dsh.profile.bundles` 数组：其余项**顺序不变**、`dependencies` /
`peerDependencies` 不动、`node_modules` 不删。每个被移除项连同**原 index** 记进救援
台账；「恢复 bundle 移除项」按原位置插回，原位置不存在（数组变短了）就追加到末尾。

### 运行期热停用：先「重新打开本页面」

停用成功后宿主会尝试在**当前进程内**热停用（`loader.update(id, {disabled:true})`，
失败回退 `entry.update({disabled:true})`）。结果写在响应的 `hotDisabled` /
`hotFailed` 里：

- `hotDisabled` 非空：这些插件已经不再参与本进程的加载，**重新打开本页面即可生效**，
  不用划掉后台；
- `hotFailed` 或热停用没成功：仍然需要**划掉后台重新打开应用**。面板会照旧显示
  「停用后请划掉后台重新打开应用」，不会假装成功。

热停用只是「少一次重启」的加分项：它依赖宿主 loader 的运行时 API，拿不到就静默回退，
绝不影响已经写进配置的持久停用。

### 救援台账：注释被抹掉也能恢复

`$DSH_HOME/dshm-boot-rescue-ledger.json` 是「注释没了怎么证明这行是我们写的」的答案。

- 每次 `/disable` / `/disable-bundle` / `/safe-mode` 成功后 upsert 一条记录：
  `{id, at, mode/level, file, blockDigest, fileDigestAfter, index?}`；
- `blockDigest` = `sha256(id + "\u0000" + 归一化 disabled 值)`。归一化把
  `true` / `True` / `" true "` 都算 `true`，**不含**标记注释——所以 DSHM 插件页抹掉
  注释后指纹仍然对得上；
- 恢复优先级：① 注释标记块（原有逻辑）→ ② 台账 + 指纹匹配 → ③ 台账里有、但行块被
  改过或找不到 → **拒绝删除**并给出手改指引（`skipped` 里注明
  `block-modified-or-missing` / `no-marker-no-ledger`）；
- 删除行块成功后，对应台账条目一并移除；
- 台账损坏（非法 JSON、结构不对）只会让 `ledger.ok=false`，恢复自动降级为「只用注释
  标记」，**不阻塞**其它救援能力，也不影响插件启动。

台账最多保留 200 条，按 `at` 倒序；它只是**兜底**，不是权威状态——真相永远在
`.dshm-plugin-rows.yml` 里。

### 良好快照：启动成功 15 秒后自动存一份

「刚才还能进，停用之后进不去了」是最难处理的事故，所以 1.2.0 会在做得成事的时候
先留退路：

- 目录：`$DSH_HOME/dshm-boot-rescue-snapshots/<YYYYMMDD-HHMMSS>-<reason>/`；
- 内容：`rows.yml`（用户行文件原样）、`profile-package.json`（profile 的
  `package.json` 原样）、`meta.json`（id / 时间 / 原因 / 路径 / bundles 快照 / 版本）；
- 自动时机：宿主 `apply()` 成功后 **15 秒**存一份 `reason:"startup"`（宿主起来了就是
  好消息）；客户端检测到**健康 UI** 后再 `POST /snapshot {reason:"healthy"}`，30 秒内
  去重，不重复写；
- 保留 **`keep=5`** 份，超出删最旧的；
- 一键回滚：`POST /rollback {"id":"…"}`（省略 id = 最近一份）→ 备份当前用户行 →
  用快照覆盖 `rows.yml`；`profile-package.json` 存在时**只恢复
  `dsh.profile.bundles` 数组**，不动 `dependencies`；全程原子写。

回滚同样需要**划掉后台重新打开应用**才真正生效（回滚改的是持久配置）。

### 隔离残留恢复：`.dshm-boot-failed` 与 `*.quarantine-*`

DSHM 在 Host 级启动失败后会把用户行文件隔离、清空 profile 依赖再按纯种子启动。
1.2.0 把这件事变成可恢复的：

- `/state.quarantine` 报告：`bootFailed`（`$DSH_HOME/.dshm-boot-failed` 是否存在）、
  `bootFailedAt`、`files[]`（profile 目录里匹配 `*.quarantine-*` /
  `*.dshm-quarantine-*` / `*rows*.bak-*` 的文件，带字节数、可解析行数、可合并性）、
  `profileDeps`（当前 profile 的 dependencies / peerDependencies）；
- 面板「隔离残留」区块列出这些文件，每项一个「合并恢复」；
- `POST /quarantine/restore {"name":"<文件名>"}` 的合并规则：
  1. 目标固定是当前 `rowsPath`（`.dshm-plugin-rows.yml`）；
  2. 隔离文件里解析出的 `- id:` 块，当前文件里**没有**该 id 才合并；
     已有 → 跳过（`already-exists`）；`disabled` 值冲突 → 跳过（`conflict`）；
  3. 合并时**保留隔离文件里的救援标记注释**，恢复后的行仍能被救援中心识别和撤销；
  4. 写入前备份当前文件（`.dshm-boot-rescue.bak`），原子写、保留 BOM 与 CRLF；
  5. 任何解析失败 → 整单拒绝（`quarantine-unmergeable`），**不做部分合并**。
- 检测到残留时 `/state.notice` 非空，面板会提示「建议先合并恢复，或改用行内
  『bundle 停用』」；但**不强制只读**——否则用户连救援能力都失去了。

### 安全模式：一键停用全部非核心（二次确认）

`POST /safe-mode {"confirm":true,"keep":["…"]}`：

- 目标 = `entries` 里 `actionable && !builtin && !protected && id != 自己` 且不在
  `keep` 里的全部 id；
- 能走 rows 的先一次性批量写进用户行；对 `bundleRemovable` 且仍有风险的不再重复处理，
  再走 bundles 移除；
- 返回两级各自处理的 id（`levels.rows[]` / `levels.bundles[]`）、`kept[]`、
  `skipped[]`（只读、降级、不可映射等）；
- 按钮**必须二次点击**才执行，第一次只显示「将停用 N 个非核心插件」；
- 没有 `confirm:true` 直接 400 `nothing-to-do`，防误触。

安全模式是「先让系统能进来」的应急手段，不是日常操作。进来之后应当先去卸载真正的
肇事插件，再逐项恢复。

### 双通道注入：tapIndex + webserver/index-inject

1.1.1 只靠 `webServer.tapIndex` 改 `index.html`。1.2.0 再挂一条
`webserver/index-inject` 结构化注入通道（往注入表里加一条
`{kind:"script-src", placement:"body", src:"/dshm-boot-rescue/client.js"}`）：

- 两条通道**任一可用**脚本就能加载；都可用时客户端脚本本身幂等（哨兵
  `__DSHM_BOOT_RESCUE__`），不会重复挂面板；
- `/health` 新增 `indexInject` 与 `channels`（0..2）；`/state.checks` 的
  `inject-channels` 会告诉你「双通道 / 单通道 / 都不可用」；
- `indexInject` 取值：`ok` / `failed: …` / `unsupported`（宿主没有
  `ctx.on("webserver/index-inject")` 时）。旧宿主没有这条通道也能正常工作。

### loader 真实状态：不再只靠失败文案猜

1.1.1 只能解析失败页文本猜「谁 pending」。1.2.0 直接读宿主 loader：

```jsonc
"loader": {
  "ok": true, "reason": "",
  "pending": [{ "id": "ui-chat", "name": "ui-chat", "missing": ["demo-service"] }],
  "failed":  [{ "id": "dsh-market", "name": "dshmarket" }],
  "counts": { "active": 12, "pending": 1, "failed": 0 }
}
```

- 状态映射沿用 cordis `FiberState`：`0=pending 1=loading 2=active 3=failed 4=disposed`；
- `missing` = `fiber.ctx.inject` 里声明了、但 `fiber.ctx.get(service) === undefined`
  的服务名。面板会显示「缺服务：xxx」，比只看文案精确得多；
- 客户端判定失败页的优先级：**loader 报告 pending/failed** 最高，其次才是失败文案；
- 正常界面健康、但 loader 仍报 pending/failed 时，就绪弹窗会明确说出来，不会假装
  「没有检测到失败」。

### required 黑名单：宿主骨架永不停用

`agent-loop` / `webserver` / `web-runtime` / `modules` / `connection` /
`headless-runner` / `acp` / `sdk-jsonrpc-server` 这 8 个 entry 是宿主骨架——停掉它们
连救援入口都会消失。它们一律 `protectedReason: "required"`、`actionable:false`，
救援中心不会显示它们的停用按钮，安全模式也会跳过。

### 新路由与新字段一览

前缀仍是 `/dshm-boot-rescue`。写接口一律 `POST` + `application/json` + 回环校验。

| 方法 | 路径 | 请求体 | 成功响应关键字段 |
| --- | --- | --- | --- |
| GET | `/health` | – | `ok version webServer loader route tapIndex indexInject channels injections mode` |
| GET | `/state` | – | 见下 |
| GET | `/client.js` | – | 脚本本体 |
| GET | `/preview?shape=title\|pending\|import\|empty` | – | 自检页（`body[data-dshm-boot-rescue-shape]`） |
| POST | `/disable` | `{"ids":[…]}` | `disabled[] already[] mode rescueRows[] warning level hotDisabled[] hotFailed[] notice` |
| POST | `/restore` | `{"ids":[]}` | `restored[] skipped[] mode level markerRestored[] ledgerRestored[]` |
| POST | `/disable-bundle` | `{"ids":[…]}` | `removed[] alreadyFailed[] mode:"bundles"` |
| POST | `/restore-bundle` | `{"ids":[]}` | `restored[] skipped[]` |
| POST | `/safe-mode` | `{"confirm":true,"keep":[…]}` | `levels{rows[],bundles[]} kept[] skipped[] hotDisabled[]` |
| POST | `/snapshot` | `{"reason":"manual"}` | `id at path` |
| POST | `/rollback` | `{"id":"…"}`（可省=最新） | `restoredFrom{id,at} rowsBytes bundlesRestored` |
| POST | `/quarantine/restore` | `{"name":"<文件名>"}`（可省=唯一候选） | `merged[] skipped[] backup` |

`/state` 在 1.1.1 的字段之外追加（只加不改）：

- `entries[]` 每项新增 `inBundles` / `bundleRemovable` / `bundleName` /
  `levels[]`（取值 `rows` | `patch` | `bundles`）；
- 顶层新增：`features{ledger,snapshot,quarantine,bundles,dualInject}`（客户端据此决定
  是否显示按钮，旧宿主没有就整块隐藏）、`inject{tapIndex,indexInject,channels}`、
  `ledger{path,ok,error,entries[]}`、`bundles{path,ok,count,removable[],protected[]}`、
  `quarantine{bootFailed,bootFailedAt,files[],profileDeps}`、
  `snapshot{dir,ok,count,keep,latest}`、`loader{ok,reason,pending[],failed[],counts}`、
  `notice`。

新增错误码：`unknown-bundle`、`bundle-protected`、`nothing-to-do`、
`snapshot-not-found`、`quarantine-not-found`、`quarantine-unmergeable`、
`merge-conflict`；其余沿用 1.1.1 的 `self-protected` / `protected-id` /
`not-actionable` / `unknown-id` / `read-only` 等。

## 降级模式（patch-fallback）

如果用户行文件存在但**结构无法安全解析**（出现非注释/非空、又不是 `- id:` /
`  disabled: ...` 的行，空 id，控制字符，非 YAML 标量结构等），为了不猜坏用户文件，
本插件会切换到降级模式：

- 目标文件改为 profile 的 `cordis.patch.yml`，写入带 `fallback-disabled` 标记的块：
  ```yaml
  # [dshm-boot-rescue] fallback-disabled <id>
  - id: <id>
    disabled: true
  ```
- 同样备份、临时文件 + 原子 rename、串行、恢复只删自己标记的行；
- 面板会**显著**展示固定提示（需求指定文案，不能改）：
  > **本次停用重启应用后失效，请进入系统后立即卸载肇事插件**
- 为什么这么说：`cordis.patch.yml` **每次进程启动都会被核心种子重拼**，正常路径下
  写进去的停用最多撑到下一次启动。所以进入系统后第一件事是卸载肇事插件，而不是留着它。
- 实际行为可能更复杂，**不要依赖它持久**：DSHM 拼装用户行时会把旧 patch 里「核心
  seed 没有定义的顶层条目」carry（沿用）到新 patch，因此降级写入的
  `- id: <id>` + `disabled: true` **可能被带到后续启动**；是否延续取决于该 id 是否在
  核心 seed 里以及下次拼装路径。另：`fallback-disabled` 只是一行注释，carry/重拼时
  不再与对应的 `- id:` 行相邻（会被并到上一个条目或作为头部注释丢弃）——之后救援
  面板的 `rescueRows` 会为空、没有「恢复」按钮，但 DSHM 插件页会把该行显示为
  「配置已禁用」。
- 降级写入后的恢复途径（不依赖注释标记）：在 DSHM **设置 → 插件** 里重新启用该插件，
  或手动编辑 profile 的 `cordis.patch.yml` 删除对应的 `- id:` 块，再**划掉后台重新
  打开应用**。
- 如果连 `cordis.patch.yml` 也无法安全追加，则整体进入只读模式。

---

## 只读与手动恢复

### 什么时候是只读

- 找不到数据目录（`DSH_HOME` / `DSHM_HOME` 都没有）；
- 无法证明当前 profile 目录（例如 `host-ready.json` 缺失/不可读、profile 不明确）；
- 用户行文件不可读，或目标文件不可写；
- 降级模式下的 patch 也无法安全追加。

只读时面板按钮禁用，并显示原因与手改指引。state 里会给出
`readOnlyReason`、`readOnlyReasonCode`、`rowsPath`、`profileDir`（能定位到时）。

### 手动删除救援停用行（持久模式）

行文件位置（本机真实路径）：

```text
/data/storage/el2/base/haps/entry/files/dsh/home/profiles/ondevice/.dshm-plugin-rows.yml
```

即 `$DSH_HOME/profiles/<profile>/.dshm-plugin-rows.yml`。手工编辑步骤：

1. 先备份该文件（例如复制一份 `.bak`）；
2. 找到本插件写入的完整块：
   ```yaml
   # [dshm-boot-rescue] disabled <id>
   - id: <id>
     disabled: true
   ```
3. 只删除这 3 行（**不要**动同 id 的其它配置块，如果用户自己还有一行的话）；
4. 保存后**划掉后台重新打开应用**。

> 注意：`<id>` 是 entry id，不是包名。面板「复制诊断」或诊断日志里能看到真实 id。
> 不要把包名当行 id 写。DSHM 的 loader 对「非 `insert:` 的 `- id:` 覆盖行」通常只
> 告警/跳过：目标 entry 不存在时该行可能无效，但一般不会像未加引号的 YAML 那样
> 直接把 profile 卡死；仍建议先备份，并且只删本插件的标记块。

### 手动删除降级模式写入的块

降级模式写的是 profile 的 `cordis.patch.yml`：

```text
/data/storage/el2/base/haps/entry/files/dsh/home/profiles/ondevice/cordis.patch.yml
```

找到 `# [dshm-boot-rescue] fallback-disabled <id>` 标记块并删除；如果注释已经被
carry/重拼丢掉，就按 `- id: <id>` + `disabled: true` 找到对应块删除，再重启应用。
再次强调：这个文件**每次启动会被重拼**，降级写入还可能被 carry 延续；根治办法是
卸载肇事插件，或到 DSHM 插件页重新启用。

### 系统设置卸载

如果面板里没法操作（只读、按钮禁用、页面异常），最稳的路径是：

1. 进入 DSHM **设置 → 插件**，停用/卸载肇事插件；
2. 检查 `.dshm-plugin-rows.yml` 里是否还残留 `[dshm-boot-rescue]` 标记行，按上面方法删除；
3. **划掉后台重新打开应用**。

---

## 安全边界

这个插件会修改本地配置，所以边界写得很死：

- **只写数据目录内**：`DSH_HOME` → `DSHM_HOME` 顺序定位；所有读写限定在该目录内，
  profile 必须是 home 的子目录；不猜路径；
- 写接口只接受**同源 `POST` + JSON**；默认只允许**本机回环**连接
  （`127.*`、`::1`、`::ffff:127.*` 等），非回环直接 403；
- 写接口还要求 `Host` 头本身是回环字面量（`127.*` / `[::1]` / `localhost`），
  防 DNS rebinding（攻击页把 Origin/Host 都写成自己的域名并解析到 127.0.0.1）；
- 校验 `sec-fetch-site` / `origin` 与 `host` 是否一致，防跨站写入；
- 请求体 ≤ 32 KiB；ids ≤ 32 个；每个 id 去空白后 1..200 字符、禁止控制字符、去重；
- 整批 fail closed：一个 id 非法整单拒绝，不做部分执行；
- 只能停用 catalog 里 `actionable` 的真实 entry；**不能停用自己**，`@deepseek-ai/*`
  内置插件一律受保护、不可写；无法映射到真实 entry id 的用户行也拒绝写入；
- 核心 seed 的覆盖行（`web-runtime`、`subprocess`、`sandbox` 这类只有 `- id:` 没有
  `name:` 的 profile 行）**永远不作为候选、也不可停用**——它们只用于 name→行 id 映射，
  避免有人误停掉 `web-runtime` 后连 webServer 都不再启动、救援入口彻底消失；
- 恢复只删本插件自己的标记块，用户手改过的块拒绝删除；
- 写入前备份、临时文件 + 原子 rename、串行队列、提交前复核外部改动；
- **零遥测**：不向外发请求、不埋点、不读 cookie/localStorage；
- 插件自身所有逻辑都在 `try/catch` 里，任何错误只记诊断日志，不影响宿主启动；
- 不静态声明 `inject`，`webServer` / `loader` 都用 `ctx.get(...)` 判空，拿不到就降级，
  不会让插件树进入 pending。
- **三级停用的 bundles 级只改 `dsh.profile.bundles` 数组**：删项不删包，
  `@deepseek-ai/*` 与 `dsh-base` / `dsh-web-app` 受保护，清空或缺少核心项整单拒绝
  （`bundle-protected`），一个非法 id 不做部分执行。
- **台账 / 快照 / 诊断日志都写在 `$DSH_HOME` 内**；快照只保留最近 5 份，超出时删除的
  是本插件自己的快照目录，不碰任何插件包；回滚前先备份当前用户行。
- **隔离残留合并先备份后原子写，解析失败整单拒绝**（`quarantine-unmergeable`），
  绝不部分合并；合并只追加缺失的 id，已有项与冲突项跳过。

---

## 已知限制

- **只在失败页能被渲染出来时有效**。如果 Host 进程本身起不来、webServer 没监听、
  或失败页根本没有 `Failed to load plugins` 标题，救援脚本没有执行机会。
- **DSHM Host 级启动失败有独立的自愈，可能让救援写入“消失”**：如果上次启动在 Host
  层失败，DSHM 会写 `$DSH_HOME/.dshm-boot-failed`；下次启动时入口脚本/`ensureProfile`
  会调用用户行模块的 `quarantineAfterBootFailure()`，把 `.dshm-plugin-rows.yml`
  **改名**为 `.quarantine-<ts>`（保数据不删），清空 profile `package.json` 的
  `dependencies` / `peerDependencies`（原文件也会备份），再按纯种子启动。这个自愈只发生在 Host 级失败，
  **不是**本插件针对的 client pending 失败页；因此本插件写入的停用行可能在隔离后
  “消失”。排查时先看 `$DSH_HOME/.dshm-boot-failed`；隔离文件原样保留，可在确认环境
  后人工合并恢复。
- **必须依赖注入通道和 webServer 路由**。1.2.0 起 `tapIndex` 与
  `webserver/index-inject` 任一可用即可注入救援脚本，但两条都拿不到时仍然没有入口。
  DSH 是大版本演进中的 developer preview，如果上游改了渲染/注入接口，本插件可能需要
  跟进；拿不到能力时会降级并写日志。
- **只能停用能映射到真实 entry id 的插件**。未映射到已知 entry id 的用户行会被标为
  「未映射」并禁止直接写入，避免写坏 profile。
- **DSHM 插件页重写用户行会丢注释**，之后救援恢复会拒绝删除（但不会误删）。
- **降级模式的停用不保证跨启动**，也可能被 carry 延续（见「降级模式」一节）；固定
  warning 是保守提示。进入系统后应立即卸载肇事插件；恢复途径是 DSHM 插件页重新启用，
  或手改 patch 删除对应 `- id:` 块。
- **降级模式对「仅含 `[]` 的 patch」不保留 `[]`**：写入时会把只有 `[]` 的
  `cordis.patch.yml` 归一化为空再追加标记块，恢复后不会把 `[]` 原样写回。
  真实 profile 的 patch 总有核心种子，且该文件下次启动会被重写，这是已知边缘限制。
- **不处理插件包本身**：不删除、不隔离 `node_modules`，也不修改插件数据。
  安装包坏掉/入口文件缺失这类问题仍需重装或卸载插件。
- **不做远程救援**：默认只允许本机回环写操作，且没有额外认证，不要暴露到局域网。
- 单元测试需要 PC 上的 **Node.js 24**（`node:test` + ESM）；DSHM 端侧没有 node CLI，
  测试是在 PC 上跑，不是端侧跑。
- **热停用可能不可用**。`loader.update(id,{disabled:true})` 依赖宿主 loader 的运行时
  API；拿不到、抛错、或该 entry 已经被别的插件接管时，会回退到「划掉后台重新打开
  应用」。面板的 `hotFailed` 就是这种情况，不要指望每个插件都能热停用。
- **救援台账只是兜底，不是权威状态**。它只能证明「某个 id 的这一行是本插件写过
  的」；若有人手工改过 `disabled` 值、或同一 id 被别人也写了一行，指纹就不匹配，
  恢复会拒绝删除并让你手改。台账损坏时功能自动降级为「只用注释标记」。
- **bundles 移除不删 `node_modules`、也不等于卸载插件**。它只是把该项从 profile 的
  `dsh.profile.bundles` 数组里摘掉；插件包、数据、依赖都原地保留，随时可以插回。
  名字以 `@deepseek-ai/` 开头的内置 bundle 与 `dsh-base` / `dsh-web-app` 永远不可移除。
- **隔离残留合并可能冲突**。隔离文件与当前用户行是两次不同时刻的快照：同 id 已有
  配置会跳过（`already-exists`），`disabled` 值不同会跳过（`conflict`），解析失败
  整单拒绝。合并不进去就别硬合并，先看 `/state.quarantine` 里的 `reason`。
- **安全模式是应急手段**，会停掉所有非核心插件。它能让你进系统，但也会掩盖真正的
  肇事者；进来后应尽快卸载问题插件，再逐项恢复。
- **1.2.0 尚未发布到 GitHub**。仓库镜像与安装 spec 仍指向已发布版本；1.2.0 需要先
  发布（`github:<owner>/dshm-boot-rescue#v1.2.0` 或本地安装）才能在端侧装到。

---

## 诊断日志

启动诊断日志写在：

```text
$DSH_HOME/dshm-boot-rescue.log
```

本机真实路径：

```text
/data/storage/el2/base/haps/entry/files/dsh/home/dshm-boot-rescue.log
```

每次启动至少记录 **5 类**信息（当前实现记录 6 条）：

1. **版本号**：插件当前版本；
2. **数据目录定位**：`DSH_HOME` / `DSHM_HOME` 命中了哪个，`$DSH_HOME` 值；
3. **webServer 获取结果**：拿不到会写降级原因；
4. **路由注册结果**：`/dshm-boot-rescue` 是否注册成功；
5. **tapIndex 结果**：救援脚本注入是否挂上；
6. **用户行文件定位结果**：`rowsPath` 及其是否存在/是否可读。

排查顺序建议：先看日志里这些项是否齐全 → 再看 `/health` → 最后看失败页是否出现。
日志只写本地，不会上传；贴 Issue 前请自行检查是否包含敏感路径。

---

## 只读自检（不用真的弄坏插件）

安装并重启后，直接打开：

- 自检页：`http://127.0.0.1:3120/dshm-boot-rescue/preview`
  （一个假的失败页 + 恢复中心，`<body data-dshm-boot-rescue-preview>` 标记自检模式）
- 健康检查：`http://127.0.0.1:3120/dshm-boot-rescue/health`
- 救援脚本：`http://127.0.0.1:3120/dshm-boot-rescue/client.js`

`/preview` 支持 4 种失败形态（1.2.0 追加），body 上带
`data-dshm-boot-rescue-shape` 标记，用来验证客户端「文案变了也能识别」：

| shape | 页面内容 | 验证什么 |
| --- | --- | --- |
| `title`（默认） | 1.1.1 那种标题式失败页 | 已知标题/正则 |
| `pending` | 只有 `ui-chat: pending (waiting for service: …)` | 宽松 pending 信号 |
| `import` | `dsh-market: import failed` + `web boot:` | import 失败文案 |
| `empty` | 空 `#root` | 兜底小胶囊（15s 后出现）|

自检页是**只读**的：搜索、筛选、勾选都能试，但所有写操作都会被禁用，状态会显示
「只读自检：不会修改任何配置」。可以用它确认界面、诊断和交互是否正常，不必故意装
一个坏插件。

预览页 CSP（至少）：

```text
default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self';
img-src 'self' data:; base-uri 'none'; form-action 'none'
```

---

## 开发与测试

要求：**Node.js 24**（PC 上），零依赖，不需要 `npm install`。

```sh
# 1. 语法检查
node --check lib/index.js
node --check lib/rescue-client.js

# 2. 单元测试（node:test + node:assert/strict）
node --test test/rescue.test.mjs

# 3. 静态自检（零依赖；没有 node 时也可人工对照）
node tools/check.mjs
```

`test/rescue.test.mjs` 全部使用 `mkdtemp` 创建的临时目录，**不会读写真机 profile**；
测试覆盖：用户行解析/序列化、标记写入、只删自己标记、其它行内容不动（同换行风格时
逐字节一致）、builtin/self
保护、ids 校验、回环地址判断、profile 定位、catalog 映射、state 结构，以及救援脚本的
文本约束（检测正则、必备文案、无 reload / 无轮询 / 无 import 等）。

1.2.0 追加的测试分组：救援台账（`blockDigestOf` 归一化指纹、
`removeRowsByLedger` 的五个删除场景 + `readLedger` 损坏降级）、隔离残留
（`parseQuarantineBlocks` / `mergeQuarantineRows` 的去重、protected、冲突、非法结构、
空文件、CRLF）、profile bundles（`bundlesOfManifest` / `isProtectedBundleName` /
`planBundleRemoval` 的原 index、保护名单、清空拒绝、核心 bundle 必留）、loader 真实
状态（`fiberStateName` / `readLoaderDetails` 的 pending·failed·active·missing /
`tryHotDisable` 的回退）、注入通道（`injectChannelCount`）、快照 id 格式、
`snapshotIdNow`，以及救援脚本的 1.2.0 文本约束（新路由、新文案、哨兵、boot ready）。

`tools/check.mjs` 做的是没有 node 环境时的替代自检：禁止模式、必备文案、
`package.json` 约束、`cordis.patch.yml` 行 id、救援脚本的纯净性（无 import/require/
Worker/WASM/setInterval、无自动刷新引导）。1.2.0 追加：宿主必须导出救援纯函数、
**禁止** `rmSync` / `rmdir` / 拼接 `node_modules` 后删除（不许真删插件包）、README
必须出现新章节关键词，救援脚本的纯净性规则一条不放松。

DSHM 端侧没有 node CLI，因此端侧不跑上述命令；端侧验收见下一节。

---

## 真机验收步骤

> 建议先备份 profile 的 `.dshm-plugin-rows.yml` 和 `cordis.patch.yml`。

1. **安装检查**：按上文安装 → **划掉后台重新打开应用** → 正常进入界面，没有新的
   pending；打开 `/dshm-boot-rescue/health` 返回 `ok:true`；检查
   `$DSH_HOME/dshm-boot-rescue.log` 的诊断项（至少 5 类）齐全；打开 `/dshm-boot-rescue/preview`
   能看到恢复中心且显示「只读自检」。
2. **失败页救援**：安装/保留一个已知会让启动 pending 的插件 → **划掉后台重新打开** →
   出现失败页与「启动恢复中心」；确认「疑似故障」自动选中；点击「停用所选并等待重启」；
   看到「停用后请划掉后台重新打开应用」。
3. **恢复界面**：**划掉后台重新打开应用** → 界面正常进入；再普通重启一次，确认停用
   状态保持（持久模式应跨启动保持）。
4. **恢复语义**：在救援中心恢复该项 → **划掉后台重新打开应用** → 插件重新参与加载；
   对比 `.dshm-plugin-rows.yml`，确认只有本插件的 3 行标记块被删除，其它行、注释、
   BOM/换行风格原样。
5. **降级模式（可选）**：在测试 profile 里构造一个结构非法的用户行文件触发降级 →
   面板显示固定 warning；停用并重启后按「已知限制」判断是否被 carry 延续
   （可能只生效一轮，也可能继续；不要假设持久）；随后卸载肇事插件。
6. **只读（可选）**：临时移走 `host-ready.json` 或让 profile 无法证明 → 面板进入只读，
   按钮禁用，展示原因与手改指引。
7. **自检页**：在 `/dshm-boot-rescue/preview` 上尝试操作，确认不会产生任何文件写入；
   再依次打开 `?shape=pending|import|empty`，确认页面形态正确、写按钮仍禁用。
8. **1.2.0 新字段**：`/health` 的 `channels >= 1`；`/state` 出现 `features` / `inject` /
   `ledger` / `bundles` / `quarantine` / `snapshot` / `loader` / `notice`；
   `checks` 共 13 项且没有 `fail`。
9. **台账与快照**：救援停用一次后确认 `$DSH_HOME/dshm-boot-rescue-ledger.json` 里出现
   该 id 与 `blockDigest`；启动 15 秒后确认
   `$DSH_HOME/dshm-boot-rescue-snapshots/` 下出现 `*-startup` 目录；在面板「良好快照」
   里点「立即存快照」后再「回滚到该快照」（各需二次确认）。
10. **三级停用与安全模式（可选，测试 profile 上做）**：对一个测试插件点「bundle 停用」，
    确认它从 profile `package.json` 的 `dsh.profile.bundles` 消失、`node_modules` 仍在，
    再点「恢复 bundle 移除项」按原位置插回；最后（仅在愿意恢复的情况下）试一次
    「安全模式」的二次确认与 `keep` 行为。

---

## License

MIT。插件只修改 DSHM 的本地 profile 配置，不做遥测、不联网上传。
