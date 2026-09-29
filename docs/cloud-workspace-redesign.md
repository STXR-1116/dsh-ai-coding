# 云工作空间重设计 · 方案设计稿

**状态：方案稿，未实施。** 本文只定义目标形态、复用边界与待验证项，不含实现代码。

## 0. 依据与口径

**所有者口径（2026-09-22，本文的目标）**

1. 插件是**浮层全屏**的，进「云工作空间」后占满整个界面（主区；不含 DSH 侧栏）。
2. 目标形态**仿 Codex 主界面**：左 = 项目/文件列表，中 = 会话，右 = 打开文件后的预览。
3. **云工作空间的会话是它自己的，独立于 DSH 原生会话**；不是"直接使用 DSH 的会话"。
4. 但会话的**实现要复用 DSH 的实现**，而不是重头造轮子。

**原始设计文档**（`Desktop/new-front-page/deepseek-harness-plugin-design/插件设计/`）

- `插件-云工作空间设计文档.md` §2/§4/§5/§6 —— 三栏布局与各栏职责，**仍然有效**。
- `插件-云工作空间设计说明书.md` §3「中栏嵌入 DSH 原生 Session 列表和会话内容」—— **按新口径作废**：中栏是云工作空间自己的会话，不再是原生会话。
- §5.4「当前 Session ID 作为 `createRun` 的 sessionId」—— **需修正**为「本 Workspace 的 Session ID」。

**技术依据**（随包源码与类型，非推测）

- `@deepseek-ai/dsh-client-ui-conversation` 的 `README.zh.md` 与 `lib/types/client/**`
- `@deepseek-ai/dsh-client-ui-layout` 的 `ILayout` 契约
- 本机文档镜像 `~/.dsh/dsh-manual/`（`reference__subsystems__slots` / `client-modules` / `conversation`）

## 1. S1 可行性验证结论：**不可行**

「把 DSH 那个会话界面组件直接搬进我们的容器」这条路已实测排除，三条独立依据：

| 检查 | 实测结果 |
| --- | --- |
| `exports["."] / ["./client"] / ["./src/*"]` | 声明了 `./src/*`，但包的 `files` **不含 `src/`** —— 安装副本里该目录**不存在**，路径取不到 |
| `ConversationRoot` / `ConversationSession` / `ConversationPanel` | **不在公开导出面**；`./client` 只导出装配层与 composer 零件；`lib/client.js` 无额外值导出 |
| 包的设计意图（README 原文） | 「本包**占据 root 作用域 `main` 中的 `conversation` key**…Session 首次绑定或缓存的 Session 成为 **current** 时，shell 才会渲染」——**壳绑定当前会话**，不是"给任意会话渲染一个壳" |

**因此**：会话的**壳**与**渲染器**都归各自 package 且绑在"当前会话"上；第三方能扩展的是"注册 definition / 快照构造器 / View"，由那个壳来渲染。

## 2. 「复用」的真实边界

| 层 | 内容 | 能否复用 | 依据 |
| --- | --- | --- | --- |
| 装配 / 状态 | `ctx.uiConversation.binding(sessionId)` → `ConversationBinding`（`snapshot`、`target(id)`、`activate(id)`）；`events` / `views` 注册表；`ConversationNodeAssembler`；`ConversationLocationIndex` | ✅ 公开、**逐会话**、identity 稳定，「不会另开 event source」 | 公开导出 + README |
| 契约 / 类型 | `ConversationSnapshot`、`ConversationPhase`、`conversationPhase()`、`ConversationStoreState`、`ViewTab`、`ConversationViewRequest`、`ComposerChainProps`、全部 snapshot/Location data map | ✅ 公开 | 公开导出 |
| 图片授权 | `ctx.uiConversation.imageUrl(sessionId, attachment)` / `peekImageUrl` —— 按会话授权、随 binding 释放而撤销、全 target 共享一次读取 | ✅ 公开 | README |
| 输入器零件 | `ComposerContentEditable`、`DecoratorPortals`、`ReferenceChip`、`registerComposerKeymap`、`registerTextRefDecoration` | ✅ 公开（零件，非整机） | 公开导出 |
| **会话壳** | header/body、View ring、composer chain/bar、Hero、queue dock、草稿持久化、phase 计算 | ❌ 归 `main.conversation`，绑定当前会话 | README |
| **target 渲染器** | Chat 的 View 与 renderer | ❌ 归 chat target 包，只经 `conversation.view` 槽由壳渲染 | README |
| 发送链路 | 乐观提交、`sendSession`、队列与插话、附件上传队列、回显 | ❌ 在壳内 | README §Shell |

**结论**：可复用的是**数据模型、事件解析、节点装配、注册表、图片授权、契约与输入器零件**；**壳与发送链路要自建**。这仍是实质性的复用（不是重造轮子），但不是"拿一个组件就能用"。

## 3. 推荐方案 A：自绘壳 + 复用装配

### 3.1 目标形态

```
┌ 云工作空间（全屏浮层，覆盖外壳主区） ────────────────────────────────┐
│ 顶栏：项目 / Workspace / 连接态 / 布局预设 / 专注模式 / 关闭            │
├──────────────┬───────────────────────────────────┬────────────────┤
│ 左栏          │ 中栏                                │ 右栏            │
│ 项目列表       │ 会话（本 Workspace 的 Session）      │ Preview         │
│ Workspace 树  │  · 消息与工具卡（复用 target 快照）   │ Changes         │
│ 工程目录       │  · 输入器（复用 composer 零件）       │ Run             │
└──────────────┴───────────────────────────────────┴────────────────┘
```

与四档布局预设的关系（`layout-presets.ts` 已冻结：**只控三栏可见性**）：标准三栏 / 专注会话 / 审阅 diff / 监控运行 —— **不变**，只是"中栏"的内容从"让给外壳"改为"我们自己的会话"。

### 3.2 复用清单 / 自写清单

| 自写 | 说明 |
| --- | --- |
| 中栏容器与消息呈现 | 从 `binding(workspaceSessionId).target('chat')` 读快照并渲染 |
| 发送链路 | 复用 composer 编辑器零件，自建提交（经会话/agent 接口） |
| 左右栏 | 已有实现，基本不动 |
| 全屏浮层与三栏布局 | 已有实现（0.1.11 已改为 `openRightbar(false, true)`） |

| 复用 | 来源 |
| --- | --- |
| 会话事件 → 节点装配、Location/Turn/Step 索引 | `ConversationNodeAssembler`、`ConversationLocationIndex` |
| 每个会话的稳定快照源 | `ctx.uiConversation.binding(sessionId)` |
| 会话授权图片 URL（含缓存与撤销） | `imageUrl` / `peekImageUrl` |
| 输入器：Lexical 编辑器、引用 chip、slash command、附件契约 | `ComposerContentEditable` 等零件 + `contract/composer-*` |
| 全部数据契约与类型 | `contract/*` |

### 3.3 Workspace ↔ Session 规则（新定义）

| 事项 | 规则 |
| --- | --- |
| 归属 | **一个 Workspace 一个会话**（1:1）。会话由插件创建并命名（如 `workspace: <workspaceId>`），与用户在 DSH 主界面聊的那个会话**无关联** |
| 创建时机 | 选中 Workspace 且状态达到可交互（`ready`；`provisioning`/`starting` 时显示状态而非会话）时创建；创建失败不静默降级 |
| 切换 | 切 Workspace → 释放旧 binding、停止旧订阅、清中栏；**草稿按会话保存**（复用 `ConversationStoreState.draft` 的持久化语义） |
| 释放 | 离开云工作空间视图 / 切 Workspace / 登出 / 失权 → 释放 binding（图片 URL 随之撤销）；会话本身保留（可在左栏找回），**不在切换时删除会话** |
| 与 Run 的关系 | `createRun` 的 `sessionId` = **本 Workspace 的会话 id**（修正原设计 §5.4） |
| 删除 Workspace | 先确认是否一并删除其会话；默认**保留会话**并在不可用时从列表移除（避免误删对话记录） |

### 3.4 binding 的生命周期（设计约束）

- 取用：`ctx.uiConversation.binding(sessionId)` —— identity 稳定，**不得**每次渲染都取（放进 effect 或 memo）。
- 订阅：`binding.snapshot` 与 `binding.target('chat')` 都是 `ObservableSnapshot`，**必须在释放时取消订阅**（组件卸载 / 切会话）。
- 释放：切换与卸载时按「取消订阅 → 释放 binding → 停订阅」的顺序，**放进同一个 effect 的清理器内串行执行** —— 依据官方手册：多个异步 disposer 并发执行，有顺序依赖的清理必须在同一个 disposer 内串行等待。
- 失败语义：binding 取不到 / target 未注册时，中栏显示**明确状态**（"会话不可用：<原因>"），不得显示空壳假装就绪。

### 3.5 同时要修掉的现存问题（本次一并处置）

| 问题 | 处置 |
| --- | --- |
| 中栏大片空白 | 由新中栏（会话）取代 |
| 文案「工作台已让出中栏…」已过期 | 删除该提示；改为会话区自身的空态文案 |
| 「未连接」状态含义不明 | 区分三种：未配置部署值 / 服务不可达 / 已连接但会话未就绪，各自给可执行提示 |
| 左栏与 DSH 侧栏并存造成两套导航 | 云工作空间内以我们的左栏为准；外壳侧栏保留不动（`fullscreen` 不覆盖它，实测已确认） |

## 4. 动手前必须验证的三件事（**不验证不写实现**）

1. **chat target 的快照是否足以渲染消息** —— 读 chat target 包的 snapshot 类型：是否含消息文本、工具卡、审批、Plan、时间与来源；若不含，中栏自写渲染的范围会显著变大，方案 A 需重新评估。
2. **composer 零件能否在壳外使用** —— `ComposerContentEditable` 等是否依赖只在壳内提供的标准 props（`useConversation`/`useInput`/`inputActions` 来自 `ctx.uiSession`，而那是**当前会话**的）。若依赖，输入器要么自建，要么需要一条"给任意会话提供 input source"的路径（是否存在待查）。
3. **binding 的释放语义** —— README 说图片 URL「随 Session binding 释放而撤销」，但没写 binding 何时释放、由谁释放；需读 `service.d.ts` / `ISessions` 确认，避免泄漏或过早撤销。

## 5. 风险与退路

| 风险 | 退路 |
| --- | --- |
| 验证 1 不通过（target 快照不足以渲染） | 方案 A′：中栏自建最简会话视图（消息 + 工具卡 + 输入），只复用**装配与事件解析**，不复用 target 快照 |
| 验证 2 不通过（编辑器零件不能壳外使用） | 用 DSH 的 `ui-primitives` 或自建纯文本输入；先保证"能发消息"，再逐步补齐附件与引用 |
| 两条都不通过 | 方案 B：云工作空间会话完全自建（`sessions` + `agent/*` + `session/event`），放弃复用 —— 代价最大，最后手段 |

## 6. 本文不覆盖

- 不改 DSH 自身、不新增 DSH 侧机制；
- 右栏 Preview/Changes/Run 的既有契约不变；
- 不动四档布局预设的可见性契约。

## 7. 三项验证结果（2026-09-22，据随包源码与类型）

### 7.1 chat target 的快照足以渲染 —— 数据可复用，**渲染要自写**

`@deepseek-ai/dsh-client-ui-chat` 存在，其客户端入口**只导出类型**（值为 `apply`/`inject`），关键形状：

```ts
// contract/snapshot.d.ts
export interface ChatSnapshot { readonly nodes: ChatNodeStore; … }
```

节点种类由各 `conversation-nodes/*` 模块声明合并而来，覆盖：`assistant`、`message`、`tool`、
`command`、`compaction`、`retry`、`request-prompt`、`turn-error`、`turn-max-tokens`、
`turn-process`、`turn-tail`、`fallback`。另导出 `ChatNodeKind`、`ChatConversationViewNode`、
`AssistantMessageNode`、`AssistantBlock`、`TurnProcessViewEntry`、`TranscriptViewRowProps`、
`ChatStoreState`。

**结论**：`binding(workspaceSessionId).target('chat')` 拿到的是**带类型的完整节点树**（消息、工具卡、
压缩、回合错误、计划过程都在内）。**数据与装配 100% 复用；每种节点的渲染要自写** —— 即方案 A 的
「自绘壳」，而不是 A′（不必自建装配）。工作量集中在节点渲染器与流式增量。

### 7.2 composer 零件可在壳外使用 —— 组件可复用，**editor 实例要自建**

```ts
ComposerContentEditable({ editor, editable, ...rest }: ComposerContentEditableProps)
/** The shell-owned editor; null renders the same div unbound and inert. */
readonly editor: LexicalEditor | null
readonly editable: boolean
```

**它不要求任何壳内标准 props**（`useConversation`/`useInput`/`inputActions` 都不在其 props 里），
`editor` 传 `null` 时渲染同一个 inert div。包同时公开了搭建编辑器所需的零件：
`registerComposerKeymap`、`registerClaimDecoration`/`refreshClaimDecoration`、
`registerTextRefDecoration`、`ReferenceChip`、`DecoratorPortals`、`ATOMIC_CHAR`、
以及 `contract/composer-blocks`、附件与队列契约。

**结论**：**输入器的可见表面与交互零件可复用**；需要自建的是 **Lexical editor 实例**与**发送链路**
（乐观提交、队列、附件上传在壳内，README 明确列为壳的职责）。

### 7.3 binding 的生命周期跟随 **Session binding**，不是独立释放

- `ConversationBinding` **没有** `release()`/`dispose()`；其成员只有 `snapshot`、`activate()`、`target()`。
- 释放语义的表述一律指向会话：`imageUrl` 返回的 URL「valid until the **Session binding** is released」；
  `historical-images.d.ts` 以 **session scope** 持有 `scopeDisposers`；`input.d.ts`「**release/session
  teardown** aborts them all」；`composer-blocks.d.ts`「@param sessionId - **Session being released**」。
- 会话侧公开 `ISessions`（`sessions.d.ts`）与 `SessionBinding`（`service.d.ts:103`），并有 `create(...)`。

**结论**：**我们创建会话 → 持有 SessionBinding → `ConversationBinding` 是它的投影**；释放由会话层负责
（我们自己 `create` 的会话由我们释放）。因此设计约束成立：**释放顺序「取消订阅 → 释放会话绑定」须放在
同一个 effect 清理器内串行执行**。

**仍存的唯一空白**：`SessionBinding` 的**具体释放成员名**（`release()` 还是 `dispose()`）尚未读到 ——
只影响写法，不影响本节结论。

### 7.4 对方案的影响

| 原计划 | 验证后 |
| --- | --- |
| 中栏「复用快照渲染」或退到 A′ | **确定走方案 A**：装配与数据全复用，自写**节点渲染器** |
| 输入器可能整体自建 | 复用 `ComposerContentEditable` 与零件，自建 editor 实例 + 发送链路 |
| binding 释放语义未知 | 跟随 SessionBinding；释放归我们（会话由我们创建） |

## 8. 会话 API 事实与实现计划

### 8.1 本轮新确认的 API（`dsh-api-session-controller` 公开契约）

```ts
interface ISessions {
  readonly list: ObservableSnapshot<SessionListState>
  /** Create or adopt a Session on the Host.
   *  @returns the Session identity after its local binding is addressable. */
  create(opts?: { workspaceId?: WorkspaceId; cwd?: string; sessionId?: SessionId }): Promise<SessionId>
  /** Select a session as current. */
  open(id: SessionId): void
  …
}
interface SessionBinding {          // 数据句柄，非句柄对象
  readonly sessionId: SessionId
  readonly session: SessionFace
  readonly eventSource: SessionEventSource
  readonly ctx: AgentContext
}
```

两条对设计有直接约束：

1. **`create({ cwd, sessionId? })` 就是「给每个 Workspace 建自己的会话」的正规入口** —— 可指定工作目录，也可预分配 sessionId（便于我们自己做 workspaceId→sessionId 的稳定映射）。
2. **`open(id)` 是"选中为当前"** —— 我们**绝不对 Workspace 会话调用它**，否则就退化成"使用 DSH 原生会话"，违背独立性的要求。

`SessionBinding` 是纯数据句柄（`sessionId`/`session`/`eventSource`/`ctx`），**未见 `release()`**；绑定由 `ClientSessions` 的 object-layer manager 持有。

### 8.2 一条必须先让你知道的副作用（**推断，依据契约措辞**）

`create` 的描述是「Create or **adopt** a Session **on the Host**」—— 也就是说我们建的是**Host 上的真实会话**，因此（推断）它会**出现在 DSH 的会话列表里**，与用户自己的对话并列。`useSessions` 的列表是外壳的，我们改不了。

**独立 ≠ 隐身**：这是"复用 DSH 会话机制"的固有代价。缓解：命名清晰（如 `workspace: <name>`）。**若你要求它完全不出现在原生列表里，那就必须放弃复用 → 回到方案 B（完全自建），代价明显更大。**

### 8.3 分步计划（每步一个可验收产出）

| 步骤 | 内容 | 验收点 |
| --- | --- | --- |
| **1. 会话归属**（无 UI） | 选中 Workspace → `create({ cwd, sessionId? })`；维护 workspaceId→sessionId 映射并持久化，避免重复创建 | 连续两次进入同一 Workspace 复用同一会话；不同 Workspace 不同会话；会话在 DSH 列表中命名可辨 |
| **2. 中栏壳（只读）** | `ctx.uiConversation.binding(sessionId)` → 订阅 `snapshot` 与 `target('chat')` → 遍历 `ChatSnapshot.nodes`，先渲染**最小节点集**（assistant 文本 / tool / turn-error / fallback） | 真机里能读出该会话的历史消息与工具卡；无消息显示空态；不可用显示明确原因 |
| **3. 输入器** | 复用 `ComposerContentEditable` + 自建 Lexical editor 与发送链路 | 能在我们的中栏发出一条消息并看到**流式**回复（装配复用带来的增量） |
| **4. 左右栏联动** | 左栏项目/Workspace/工程目录接上新会话；点文件 → 右栏 Preview | Codex 式三栏闭环：左列表 / 中会话 / 右预览 |
| **5. 清理与边界**（每步都做） | 切 Workspace / 离开视图 / 登出 / 失权：**同一个 effect 清理器内串行**「取消订阅 → 释放会话绑定」；未连接三态；删过期文案；组件崩溃不得退役槽位 | 重复进出 20 次会话数不增长；四档布局预设全部可用；断网/失权有明确提示 |

### 8.4 步骤 1 顺手确认的一处

`ISessions` 是否另有释放/回收成员（`release` / `close` / `forget`），以及 `ConversationBinding` 何时真正失效 —— 读 `contract/sessions.d.ts` 全文与 `sessions/service.d.ts` 的 manager 部分。**只影响写法，不影响计划。**

### 8.5 风险

- **步骤 2 是主要工作量**（节点种类多）。先做最小集，按需补；不能一次铺满。
- 若 8.2 的副作用不可接受 → 回到方案 B，代价大，需重新评估工期。
- 输入器若发现 editor 实例无法在壳外构造（验证 2 只证明了**组件**不依赖壳），则退到"纯文本输入先保证能发消息"。

## 9. 专题：能不能让 Workspace 会话**不出现在原生列表**里

所有者不接受 8.2 的副作用，故专项调查。**结论：在本版 DSH 上，「不出现于原生会话列表」与「复用 DSH 会话实现」互斥。**

### 9.1 三条实测依据

1. **会话必须由会话控制器认识。** `UiConversation` 内部是 `this.sessions.binding(sessionId)`；不认识就
   `ui-conversation: unknown session …` 直接拒绝。所以"自造一个 client-only 会话、把事件喂给装配器"**不成立**。
   （`events.d.ts` 里的 `transient` 是**会话内**的 Client-only 实时分片，不是"客户端会话"。）
2. **`create` 无法创建隐藏会话。** `SessionCreateRequest = { workspaceId?, cwd?, sessionId?, agentPreset? }`
   —— **没有** visibility / hidden / ephemeral / parent 之类字段。
3. **没有任何"归档/隐藏"入口。** `ISessions` 全部成员为：`list`、`searchResultLimit`、`create`、`open`、
   `openSubagent`、`subagentAddress`、`setSubagentCatalogOpen`、`refreshSubagents`、`clear`、`refresh`、
   `search`、`scope`、`scopeOf`、`sessionOf`、`binding` —— **既无 archive，也无 delete/release**。

### 9.2 唯一让会话不进顶层列表的机制：**子代理路由**

`SessionListState.ids` 的注释是「Host-list order; **addressed breadcrumb-only rows are excluded**」，且另有
`subagentsByParent` / `subagentAddress(id)` / `openSubagent(address)`。即：**被作为子代理寻址的会话不在顶层
列表里**，而是挂在父会话的子代理目录下。

**但这是子代理的语义**：它把我们的会话**挂到某个父会话上**，并继承子代理的生命周期（README 描述的子代理
有 inbox 控制、parent 离线锁定等）。用它承载"工作空间会话"属于**滥用机制**，且父会话结束/被删除时行为未知。
**不建议**，除非另有验证证明存在"不挂父会话的隐藏会话"。

### 9.3 因此只剩两条路，代价截然相反

| | 可见性 | 复用程度 | 代价 |
| --- | --- | --- | --- |
| **路线 1：Host 会话 + 组织（推荐）** | **可见**，但可归组与命名 | **全复用**（装配/数据/渲染零件/图片授权） | 侧栏多出一个分组；且**客户端删不掉会话**（无 delete API），故必须**懒创建 + 复用映射** |
| **路线 3：完全自建（方案 B）** | **不可见** | **零复用** | 装配、事件解析、节点渲染、输入器、发送链路全自建 —— 正是"重造轮子" |

**"不可见"的唯一代价是"不复用"**，这是机制层面的取舍，不是实现选择。除非推动后端把
「云工作空间会话」做成**平台自己的会话**（设计文档 §9 说真实后端由同事负责）——但即便如此，
**渲染侧的装配仍需自建**（9.1 第 1 条），只是把数据源从 DSH 会话换成平台 API。

### 9.4 若走路线 1，必须同时做两件事

1. **懒创建 + 稳定映射**：只在用户**真正发起对话**时 `create({ workspaceId, cwd, agentPreset? })`，并把
   `workspaceId → sessionId` 持久化；绝不"进一次建一个"（客户端无法删除，会累积）。
2. **命名与归组**：会话标题用可辨前缀（如 `workspace: <name>`），`workspaceId` 传云工作空间的标识，
   使其落在侧栏的**专用分组**下 —— 所有者截图里的侧栏本就按 workspace 分组（`dsh-ai-coding` /
   `AI Coding Hub`），这条能直接复用。

## 10. **结论更新（同日）：§9 的「互斥」判断被推翻 —— 有正规机制同时满足两者**

所有者要求继续在官方手册/参考区寻找方案。结果是**找到了**，而且是一等机制，不是绕过。

### 10.1 机制：会话归档（registry-global archive set）

据 `dsh-workspace` / `dsh-api-workspace-controller` / `dsh-client-ui-workspace` 的类型与包文档：

```
dsh-workspace/index.d.ts:111   The registry-global archive set: sessions hidden from every
                               grouping surface. Archiving never touches workspace accounting…
dsh-client-ui-workspace/slots.d.ts:128
                               Archive a Session into the registry-global set: hidden from
                               grouping surfaces, log and accounting slot retained.
dsh-client-ui-workspace/README.zh.md:40
                               Archive 不经确认对话框直接提交，归档集合回声落地后，
                               该行从所有分组视图中消失
```

**可调用面**（公开）：

```ts
// dsh-api-workspace-controller —— 公开客户端面
export type { IWorkspaces, WorkspaceSource } from './service.ts'
// model.d.ts:95
archiveSession(sessionId): Promise<RemoteResult<WorkspaceArchiveValue>>
```

### 10.2 两项验证（本轮实测读取，非推断）

| 验证 | 结果 | 依据 |
| --- | --- | --- |
| 插件能否程序化调用归档 | ✅ 可以 | `IWorkspaces` 在 `./client` 公开导出，`archiveSession` 是其 Remote 方法；插件 `inject: ['workspaces']` 即可调用 |
| 归档后能否仍被 `binding()` 解析 | ✅ 可以 | **`dsh-api-session-controller` 全树搜 `archiv` 零命中** —— 会话控制器**完全不感知归档**，归档是**呈现层过滤**，`SessionListState` 不变，故 `sessions.binding(id)` → `uiConversation.binding(id)` 照常 |

**因此：§9.3 的「可见性 ⟺ 不复用」互斥结论作废。** 正确的做法是：

> **每个 Workspace 建自己的会话 → 立即 `archiveSession(sessionId)` → 它从侧栏所有分组消失，
> 而日志与记账保留、控制器照常解析** —— 于是「独立 + 不可见 + 全复用」三者同时成立。

### 10.3 采用该机制时必须一并处理的四条

1. **归档没有反悔入口。** README 已知限制：「已归档会话**没有查看或取消归档入口**」。因此
   `workspaceId → sessionId` 的映射**必须持久化**，且**云工作空间自己是唯一的查看/管理入口**；
   映射一旦丢失，用户无法从 UI 找回该会话。→ 映射写入插件状态并以 Workspace 为键，缺失时才新建。
2. **归档「当前会话」有特殊语义。** `slots.d.ts` 该条注释被截断处含 "Archiving the current …"，需在
   实现前读全（预期是禁止或要求先切换）。我们**从不**对 Workspace 会话调用 `open()`，故预期不受影响。
3. **懒创建 + 建完即归档**：仍应只在用户真正发起对话时 `create()`，随后立刻归档；避免"进一次建一个"。
4. **`WorkspaceArchiveValue` 是否含"取消归档"能力未确认** —— 若含，可给用户一条恢复入口（加分项，不阻塞）。

### 10.4 对实现计划的影响

§8.3 的五步计划**不变**，只在步骤 1 增加一步动作（`create` 之后 `archiveSession`），并新增一条验收：

- 步骤 1 验收补充：**新建的 Workspace 会话不出现在侧栏任何分组下**，且 `binding(sessionId)` 仍能取到快照。
