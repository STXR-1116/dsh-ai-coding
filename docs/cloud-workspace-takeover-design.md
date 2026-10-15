# 云工作空间「接管模式」设计稿

> 状态：**待所有者评审**（按所有者要求，先设计、后开工）。
> 依据强度在每节标注：**手册** = 官方文档原文；**随包类型/源码** = 手册未覆盖，依据为已发布契约与实测。
> 目标形态由所有者的标注图给定（2026-10-14）：点「云工作空间」后，**插件接管 DSH 原生界面本身**。

---

## 1. 目标形态（所有者标注图逐条 ↔ 落点）

| 标注 | 含义 | 落点（本设计的答案） |
| --- | --- | --- |
| 左栏上 | 展示**后端返回的会话记录** | 官方左栏席位 `sidebar.workspaces`（单席位）由我们**临时遮蔽** |
| 左栏下 | 展示**文件列表** | 同一席位内，会话记录之下 |
| 中央 | **原生会话区功能与样式保持不变**，内容来自后端服务 | 官方中央 `main` 的保留键 `conversation`（**我们不动它**） |
| 右上 | 出现**已连接 / 已被接管**的标志 | 官方 `conversation.session.header.actions` 席位 |
| 右栏 | **全部撤掉**，预览走原生 | 撤除现有三个右栏 pane（A2/A3 的产物） |

一句话：**接管 = 临时成为官方左栏的占用者 + 在会话标题栏挂一个标志**，中央与右栏都不归我们。

---

## 2. 官方依据（逐条可指回页面）

### 2.1 槽位与遮蔽（`reference/subsystems/slots`）

> 「对于 single、list 和 keyed cell，**priority 是遮蔽优先级**；对于 chain，它是选举顺序。」
> 「cardinality single：单个 cell，**渲染当前 priority 胜者**；需要并列内容时应声明 child slot，而不是把它当作列表。」
> 「包通过声明合并写入 key、cardinality、scope、owner props…」「**增量扩展使用 list id 或尚未占用的 key**。」

⇒ 结论：左栏是 **single** 席位 ⇒ **可以用更高的 `priority` 遮蔽**；遮蔽是"谁渲染"的替换，
**不改动声明**（children、owner props 仍由原包声明）。

### 2.2 生命周期（`develop/cordis-tutorial/02-lifecycle-and-effects`、`develop/basic`）

> 「通过 Cordis API 建立的注册属于 effect，**会在所属插件卸载时撤销**；在这些 API 之外管理的资源必须包装在 `ctx.effect()` 中。」
> 「通过 ctx 注册的任何东西——事件监听、工具、定时器——**在插件卸载时都会被自动清理**。」

⇒ 结论：把"接管期间的注册"放进一个**子插件**里，用 `ctx.plugin(...)` 装载、`fiber.dispose()` 卸载 ⇒
**退出即还原**是框架保证的，不需要我们手工 remove（也不会漏）。

### 2.3 会话面归外壳（`reference/subsystems/conversation`）

> 「`ui-conversation` 拥有 event 与 **view registry**、identity-stable binding、增量 Context assembly、
> **target source、共享 shell 与输入编排**。`ui-chat` 和 `ui-trajectory` 等 target 包拥有各自的
> Definition、最终 snapshot 与渲染。」
> 「**shell 拥有 View 选择** … 解析已注册的偏好 View 或 **Chat fallback**。」

⇒ 结论：中央的"功能与样式保持不变"**不需要我们做任何事** —— 它是外壳自己的会话面；
我们要做的是**把当前会话切到本工作空间的会话**，让外壳去渲染它（内容来自后端见 §5）。

### 2.4 插件形态（`develop/basic`）

> 「在 Harness 中，插件是一个导出 `apply` 函数的 TypeScript 模块。」

⇒ 子插件同样是一个模块（导出 `apply`），由 `ctx.plugin()` 装载。

### 2.5 手册未覆盖、依据为随包类型 + 实测的部分（**显式标注**）

| 事实 | 来源 |
| --- | --- |
| `sidebar.workspaces`：`kind: 'single'`，`scope: 'root'`，owner props = `{ wide: boolean; expandSidebar: () => void }` | `dsh-client-ui-sidebar/lib/types/client/contract/slots.d.ts` |
| ui-workspace 占用该席位时**未声明 `priority`** ⇒ 我们给 `priority: 1` 即可在它之上 | `dsh-client-ui-workspace` 产物源码 |
| `conversation.session.header.actions` 存在且由会话包声明（`HeaderActionProps`） | `reference/subsystems/slots` 的席位树 + 随包类型 |
| 右栏 API：`ISidebarRight` 只有 `isExpanded()` / `toggleExpanded()`，**呈现形态不可由插件设定** | `reference/subsystems/sidebar-right` + 实测 |
| `ISessions.open(id)` 可切当前会话；`sessions.list` 的 `current` 是读面 | `dsh-api-session-controller` 类型 |

---

## 3. 模式状态机

```
        ┌──────────────── 未接管（官方左栏 = 工作区/会话浏览）────────────────┐
        │                                                                  │
   点「云工作空间」                                                  点「退出云工作空间」
   （侧栏 footer action）                                            （左栏底部按钮）
        │                                                                  │
        ▼                                                                  │
        ┌──────── 接管中：cloudMode 子插件已装载 ────────┐                  │
        │  · sidebar.workspaces 遮蔽者（priority 1）      │                  │
        │  · conversation.session.header.actions 标志     │                  │
        │  · 当前会话 = 本工作空间的会话（外壳渲染）      │──────────────────┘
        └─────────────────────────────────────────────────┘   fiber.dispose()
```

- **进入**：`enterCloudMode(ctx)` → `ctx.plugin(cloudModePlugin)`（返回 fiber ✓ 存起来）→
  同时把当前会话切到本工作空间会话（§2.3）。
- **退出**：`fiber.dispose()` → 两个注册随 effect 一起撤销 ⇒ 官方左栏**自动回来**（§2.2）。
- **幂等**：重复进入只装载一次（fiber 存在即返回）；退出后 fiber 置空。

---

## 4. 各区域的实现

### 4.1 左栏占用者（`CloudSidebar`）

- props：`{ remote, workspaceId, wide, expandSidebar, onExit }` —— 后两个来自官方 owner props（§2.5）；
- `wide === false`（rail 态）时**只画一个图标**，点它调用 `expandSidebar()`（官方契约要求占用者自己处理窄态）；
- `wide === true` 时自上而下：**会话记录区**（复用 `SessionRecords`）→ **文件列表**（复用 `FileTreeView`）→ 底部「退出云工作空间」；
- 数据**只来自本插件远程面**（`workspaceSessionRecords` / `workspaceFiles`），不读 DSH 本地会话列表；
- 每种非 ready 状态都要**说出原因**（沿用本仓既有取向：`signed-out` / `not-ready` 不是"空列表"）。

### 4.2 接管标志（`CloudModeBadge`）

- 注册进 `conversation.session.header.actions`，显示「云工作空间 · 已连接」+ 一个状态点；
- 只读一个布尔（是否已接管），不读业务数据 —— 标志不该因为某次读取失败而消失。

### 4.3 中央会话区

- **不改动**：外壳的 `conversation` 键自带会话面与输入编排（§2.3）；
- 我们只做"切当前会话"：`ISessions.open(本工作空间映射的会话)`（§2.5），
  并在退出接管时恢复进入前的那一个。

### 4.4 右栏

- 撤除 `ai-coding-cloud-workspace` / `ai-coding-cloud-files` / `ai-coding-cloud-preview`
  三个 pane 及其组件（A2/A3 路线整体让位给"接管左栏 + 原生预览"）。

---

## 5. 内容来源（后端的边界，必须写清）

| 区域 | 现在能从哪拿到 | 缺口 |
| --- | --- | --- |
| 会话记录列表 | **已有**：夹具 `GET /v1/workspaces/:id/sessions`（`docs/backend-api-requirements.md` §3.1 的参考实现） | 真后端实现 |
| 文件列表 | **已有**：`workspaceFiles`（平台目录读） | 无 |
| 中央会话内容 | **只能来自 DSH 本地会话** | **后端 §3.1 的会话内容与 LLM 事件流** ⇒ 需要 Host 适配层把平台事件写成 DSH 会话事件（能力已具备：`session/event` 观察面 + 会话格式） |
| 原生预览 | 需要**会话作用域的文件地址**（`dsh-resource://file/…`） | 云文件尚不是 DSH 资源 ⇒ 需要 `ctx.fs`/资源提供者接线（**本轮不做，单独评估**） |

**结论**：本轮能交付的是"**接管骨架**"（左栏两段 + 标志 + 切换/还原），中央**结构上**已经是原生会话面，
真实内容等后端；文件列表**可浏览**，点击打开原生预览**留待资源接线**（届时文件行接上地址即可）。

---

## 6. 分步交付（每步独立可验，且随时可退）

| 步 | 内容 | 验证 |
| --- | --- | --- |
| **T1 ✅ 已完成（0.1.82）** | 模式状态机 + 左栏占用者（会话记录 + 文件列表 + 退出）+ 标志 | 真机冒烟：点入口 ⇒ **浮层自动关闭**、左栏换成两段；点退出 ⇒ 官方左栏**原样回来** |
| **T2 ✅ 已完成（0.1.83）** | 进入接管时把外壳切到**本工作空间的会话** | 代码路径真机跑通（切换在 `onEnter` 里做一次，避开 effect 闭包身份导致的死循环）；**内容**要等 §3.1 |
| **T3** | 会话记录点一条 ⇒ 切到该会话（`sessions.open`） | 真机：点第二条 ⇒ 中央换会话 |
| **T4** | 会话记录来自**真后端**（等 §3.1）；中央内容来自后端事件 | 后端到位后 |

每步都走本仓收尾清单：全量绿 → build → pack → 离线安装 → 冒烟 GREEN → 才报完成。

---

## 7. 明确不做的事

- **不重写**官方的会话/工作区浏览器：退出即注销 ⇒ 官方实现回来（§2.2）；
- **不长期遮蔽**任何席位：只在接管期间注册；
- **不改**官方包、不依赖未公开的导出（上一轮已确认聊天渲染器不可复用）；
- **不动**中央会话面与输入编排：那是外壳的所有物（§2.3）。

---

## 8. 风险与回退

| 风险 | 处理 |
| --- | --- |
| 遮蔽影响其它插件对该席位的注入 | 只遮蔽 **occupant**，不改声明（§2.1）；退出即撤销 |
| 官方在该席位上还有 children 槽（如 `sidebar.workspaces.directoryFlow`） | 声明仍归 ui-workspace，我们只是渲染者；若实测有 child 槽依赖占用者渲染，再评估 |
| 接管期间用户无法回到普通会话列表 | 左栏底部常驻「退出云工作空间」；退出后官方浏览器立即恢复 |
| 出问题 | 一键退出 + 版本可回退（每步都留 tgz） |
