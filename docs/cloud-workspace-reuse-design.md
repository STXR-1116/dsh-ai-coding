# 云工作空间 · 复用 DSH 前端 + 后端接口要求（设计稿 v2）

**状态：设计稿，待所有者确认。** 本文取代 v1（`cloud-workspace-two-modes-design.md`）的**架构部分**；
v1 里「两模式」的产品定义仍然有效，但**实现方式整体改变**：不再自建三栏，改用外壳自己的面。

依据：官方参考区（本机镜像 `~/.dsh/dsh-manual/site/`）＋ 随包 README/类型，逐条注明出处。

## 0. 所有者口径（2026-09-22，本文的出发点）

> 「我是希望**尽量复用 DSH 的前端实现**，只是会话数据、LLM 输出、云端文件等等"云工作空间"内容
> 是从**服务端获取**，对于后端接口的要求可以整理出来提供给后端同事，让他按要求开发。」

拆成三条约束：
1. **前端复用优先** —— 能在官方面上做的，不自建；
2. **数据来自服务端** —— 会话/LLM 输出/云端文件都来自平台；
3. **产出后端接口要求** —— §4 是给后端同事的部分。

## 1. 复用清单：我们不再自建什么

| 前端面 | 复用的官方实现 | 我们只贡献 |
| --- | --- | --- |
| **会话渲染**（消息/推理/工具卡/审批/计划/流式/压缩/重试） | 外壳的 Conversation（`main.conversation`）＋ `dsh-client-ui-chat` 的节点渲染器 | **会话事件的数据来源**（§5 的 Host 适配） |
| **输入器 / 队列 / 附件** | `ui-conversation` 的 shell（composer chain / queue dock / 草稿持久化） | 无（我们不自建输入器） |
| **文件树 / 文件预览** | 官方右侧 Sidebar：`dsh-client-ui-sidebar-files`（files 类型）、`dsh-client-ui-sidebar-documentpreview`（text 类型）、`dsh-client-resources`（资源模型） | 注册**云文件**的 tab 类型与资源协议（若内置类型可直接吃我们的数据源，则连这步都省） |
| **布局：分栏 / 浮出 / 折叠 / 拖拽 / tab 菜单** | `dsh-client-ui-dockkit`（官方布局引擎）＋ `ctx.sidebarRight`（`split` / `float` / `dock` / `toggleExpanded`） | 无（**删掉我们自建的拖拽与宽度状态**） |
| **会话列表 / 工作区浏览** | `dsh-client-ui-workspace`（填充 `sidebar.workspaces`） | 无 |
| **入口** | `sidebar.panellist` 全局面板入口 | 一个面板入口 + 文案 |
| **主题 / 密度 / 排版 / 滚动条** | `--dsh-*` token（我们已接入的部分保留） | 无 |

**净效果**：`CloudWorkspacesView` 里那些自建件（三栏网格、两条拖拽条、四种预设、我们自己的会话面板
`ConversationPane`、`conversation-model`/`conversation-source` 适配层）**大部分可以删掉或退役**。
它们存在的理由是「在外壳之外自建一套」，而这个前提现在被撤掉了。

## 2. 两模式 = 官方右侧 Sidebar 的折叠/展开

| 模式 | 实现 |
| --- | --- |
| **会话模式** | 右侧 Sidebar **折叠**（`ctx.sidebarRight.isExpanded() === false`） |
| **预览模式** | 右侧 Sidebar **展开**并打开该文件（`ctx.sidebarRight.openResource(address)`；折叠时 open 会在同一步展开） |

依据（`reference/subsystems/sidebar-right` 原文）：「折叠的列会在同一步展开」；
`isExpanded()` / `toggleExpanded()` 读写这一列，翻转记入序列。

**于是 v1 的这段设计作废**：五轨网格、分段控件、`data-layout` 模板重写、我们自己的面板分隔条 ——
官方已经有一套，而且带分栏/浮出/历史记录。

## 3. 三股数据 + 一条 Host 适配

```
① 会话与 LLM 输出   平台 →[Host 适配]→ DSH 会话事件 → 外壳 Conversation 渲染
② 云端文件（树/内容） 平台 →[资源协议]→ 右侧 Sidebar 的 files / text 类型
③ 工作空间与运行     平台 →[既有 remote 面]→ 工作列表 / 状态 / 生命周期 / run / plan / approval / changes
```

①是新东西：**前端显示会话，需要的是 DSH 会话事件**（`session/event` 流），而内容由平台产出，
因此中间必须有 Host 适配层把平台输出映射成事件。映射目标见 §5。

## 4. 后端接口要求（**交给后端同事的部分**）

### 4.1 会话与 LLM 输出

| 需求 | 说明 |
| --- | --- |
| 创建/取得会话 | 一个云工作空间对应一个会话；返回稳定 session 标识与服务端时间基准 |
| **增量事件流** | 流式：文本增量、推理增量、工具调用开始/参数增量/结束、工具结果、轮次与步骤边界、终止原因（正常/取消/超长/错误） |
| 顺序与去重 | 每事件带**单调序号**（前端会话装配依赖连续 revision/seq；断档必须能识别） |
| 断线重连 | 支持按「最后收到的事件 id」续传；无法续传时明确告知需重读快照（对应官方 `resync_required` 语义） |
| 分页快照 | 打开一个已有会话时按页取历史（前端有窗口化装配，会 prepend） |
| 失败语义 | 区分：可重试的下游失败 / 需要用户介入（审批）/ 终态失败；**不得用空结果代替失败** |

### 4.2 云端文件（右侧 Sidebar 消费）

| 需求 | 说明 |
| --- | --- |
| 目录树 | 给定路径返回条目（名/类型/大小/etag/revision），支持分页或增量 |
| 文件内容 | 返回内容 + 内容类型 + 大小 + etag + revision；大文件需分页或流式 |
| **可显示性** | 明确「哪些类型可直接预览」（文本/Markdown/JSON/图片/HTML），HTML 需带 CSP 与 sandbox 声明 |
| 短期预览 URL | 服务端签发、绑定工作空间、带过期时间（前端不自行拼 URL） |
| 变更基线 | 当前 revision 与基线 revision，供 diff 与冲突判断 |

### 4.3 工作空间

| 需求 | 说明 |
| --- | --- |
| 列表 / 详情 | 项目授权范围内的工作空间；状态机取值固定（`draft`…`archived` 等），未知状态必须显式未知 |
| 生命周期 | 启动/停止/重试/归档/删除：请求带 revision 与幂等键；冲突、忙碌、无权、不可用各自稳定错误码 |
| 代码源与分支 | 创建表单的候选（仓库、分支），来自服务端，不由前端拼 |

### 4.4 运行（run）

| 需求 | 说明 |
| --- | --- |
| 创建 run | 绑定工作空间 + 会话 + Agent 配置版本 + 写模式 + 期望 revision |
| 状态与阶段 | 排队/启动/运行/等待审批/成功/失败/取消/过期；未知状态显式未知 |
| 取消 / 重试 | 重试**产生新 run id**，并带 `retryOfRunId`；不覆盖原 run |
| 审批 | 等待审批可被前端展示，**审批结果仍由服务端鉴权与记录** |
| 计划 | 计划草稿/审阅/确认的状态与 revision（若要复用外壳的计划 UI，需与官方 `plan/mode` 事件对齐） |

### 4.5 身份与授权

| 需求 | 说明 |
| --- | --- |
| 账号 | 登录/刷新/登出；会话过期可识别（前端据此走重新登录，而不是显示空数据） |
| 项目授权 | 账号可见项目；**无权与不存在必须可区分**（官方契约：git 里我们已按 code 分类，不靠 HTTP 状态） |
| 错误码 | 稳定 code 词汇表（`FORBIDDEN` / `PROJECT_NOT_MEMBER` / `REVISION_CONFLICT` / `WORKSPACE_BUSY` / `SERVICE_UNAVAILABLE` …）——前端按 code 分类，不解析文案 |

**通用要求**（每条接口都要满足）：
- 幂等键（写操作）、`If-Match`/`expected_revision`（竞争资源）；
- 稳定错误 envelope（code + message + request_id）；
- 服务端时间为准（前端不做时间推断）；
- **分页/增量/续传**三件套；
- 不返回本地物理路径、凭证、模型密钥。

## 5. Host 适配：平台输出 → DSH 会话事件

前端 Conversation 消费的是持久会话事件。官方权威清单：`reference/persistence-catalog`
（109 个类型）。与本产品相关的是这一子集：

```
turn/start · turn/end
step/start · step/end
user/message
assistant/message · assistant/attempt
text/reasoning
tool/call · tool/result
approval/asked · approval/decided
llm/retry · llm/retry-started
compaction/start · compaction/summary · compaction/end
session/title · system/message
request/header · request/context
model/selection · plan/mode · permission/preset · sandbox/mode
goal/change · todo/write · deliverables/presented · subagent/catalog · subagent/descriptor
```

**这意味着后端输出必须至少能区分**：轮次/步骤边界、文本与推理增量、工具调用的 id 与参数与结果、
审批请求与决定、重试、终止原因。**映射由我们（Host）做** —— 后端只要把这些语义表达清楚即可，
不必模仿 DSH 事件名。

## 6. 这条路线要付的代价（**必须所有者确认**）

**它与此前的「工作台是全屏浮层」冲突。** 官方会话面（`main.conversation`）与右侧 Sidebar 都在
**外壳之内**：右侧 Sidebar 的挂载条件是「root 作用域的 rightbar 控制器仅在**选中 Conversation** 时
挂载该席位」，而全屏浮层（`shell.overlay`，`.surface` 为 `position: fixed; inset: 0`）会把它们一起盖住。
**要复用它们，就不能再盖住外壳。**

⇒ 新的目标形态是：**DSH 外壳自己的布局** —— 左栏（我们的面板入口 + 会话/工作区浏览）｜
中间（外壳 Conversation 渲染本工作空间的会话）｜右侧 Sidebar（文件树与文件预览）。
这正是所有者给的 Codex 参考图的样子，只是左侧列表由官方 `ui-workspace` 承担。

## 7. 待确认（3 条）

1. **接受放弃全屏浮层**（换成外壳自身布局）以换取前端复用吗？——这是本设计的**前提**。
2. 左侧那份「项目/文件列表」用**官方 `sidebar.workspaces`**（会话/工作区浏览），还是用
   `sidebar.panellist` 做一个我们自己的面板（项目列表）？前者复用最大化，后者更接近参考图。
3. 云文件的右侧 pane：优先**复用官方 `files` / `text` 两种类型**（需要后端数据能经过 `resources`
   资源协议接进去），还是先注册一个我们自己的 tab 类型（更快落地，但少复用一层）？

## 8. 「整体性」冲突的解决方案（2026-09-22 追加）

所有者澄清：**「全屏浮层」只是实现方式**，真实目的是

> 「让工作台成为**一个整体**，而不是当工作台切换到"云工作空间"时**同时出现 DSH 原生界面和
> 云工作空间界面**。」

这把冲突从"必须盖住外壳"改写为"**不能让两套界面并排**"。据此重新求解，并先摆清两条机制事实
（都出自官方参考区，非推断）：

| 机制事实 | 出处 | 后果 |
| --- | --- | --- |
| `sidebar.panellist` 的条目「**同一个 id 寻址布局中 root 作用域 `main` keyed slot 的组件**」 | `dsh-client-ui-sidebar` README「全局面板入口」 | 面板入口配对的是**中央**主面板；左栏正文（`sidebar.workspaces`）由 `ui-workspace` 填充，**没有**让插件替换它的席位 |
| 右侧 Sidebar「root 作用域的 rightbar 控制器**仅在选中 Conversation 时**挂载该席位」 | `reference/subsystems/sidebar-right` | **中央必须是外壳的 Conversation**，右侧 Sidebar 才存在 |

### 8.1 可行方案（三个，按复用度排序）

**方案 A（推荐）：外壳三面 ＋ 内容全是我们的**

```
[左栏：官方会话/工作区浏览]  [中央：官方 Conversation（渲染本工作空间的会话）]  [右侧 Sidebar：项目/文件树 + 文件预览]
```

- 进入云工作空间时把外壳切到**本工作空间的会话**（`ISessions.open`），离开时恢复原会话；
- 文件树与预览走官方右侧 Sidebar（官方 `files`/`text` 类型，或我们注册的云文件类型）；
- **两模式** = 右侧 Sidebar 折叠（会话模式）／展开（预览模式）——官方既有语义；
- **整体性达成**：所见三面**都在显示云工作空间的内容**（我们的会话、我们的文件、我们的预览）。
  DSH 的部件在这里是"外壳家具"，不存在"并排两套界面"；
- **复用度最高**：会话渲染、输入器、队列、审批、计划、文件树、预览、分栏浮出折叠全官方。

**方案 A′（A 的加强版：左栏也不显示无关内容）**

若"左栏必须只体现云工作空间"，把**项目/文件列表做成右侧 Sidebar 的第一个 pane**（官方支持
多 pane 分栏，`split` 即可），左栏仅作为外壳导航保留。既符合参考图的"列表 + 会话 + 预览"三块，
又完全不越出官方机制。

**方案 D（中央也归我们）**

中央是我们的主面板（`sidebar.panellist` 入口 + `main` 占位者），左树与会话渲染自建。
**代价**：右侧 Sidebar 因上表第二条**用不了**（中央不是 Conversation），所以文件预览也要自建；
会话渲染只能复用装配层（`uiConversation.binding`）而非官方 shell ⇒ 输入器/队列/审批 UI 自建。
**复用度中等**，但界面 100% 是我们的。

### 8.2 不可行：我们的中央 ＋ 官方右侧 Sidebar

由第二条机制事实直接排除 —— 中央不是 Conversation 时右侧 Sidebar **根本不挂载**。
（这是机制约束，不是取舍偏好。）

### 8.3 方案 A 需要一并确认的三件事

1. **左栏内容**：接受官方会话/工作区浏览吗？还是走 A′（把项目列表放右侧 Sidebar 的 pane）？
2. **会话可见性反转**：走 A 后，"本工作空间的会话"就是外壳正在显示的会话。此前为"不出现在原生
   列表"而做的**归档**与此相抵：归档把它从列表隐藏，而用户恰恰需要能在列表里切回它。
   建议改为**不归档 + 清晰命名**（如「云工作空间：<名称>」），并让它落在按工作空间分组的位置。
3. **切换当前会话**：进入云工作空间会切换外壳当前会话，离开时恢复 —— 接受吗？
   （`ISessions.open(id)` 契约：「id 必须存在于列表，未知 id 响亮失败」。归档会话是否仍可 `open`
   尚未真机验证；若不可，第 2 条按"不归档"执行即可回避。）

