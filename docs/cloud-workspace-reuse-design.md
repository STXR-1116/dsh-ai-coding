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

## 9. 重点设计：平台会话列表（所有者第 2 条）

> 「"云工作空间"中的会话列表应该展示**服务端返回的会话列表**，与原生 DSH 的本地会话列表**不同**，
> 这点需要重点设计。」

### 9.1 先把机制摆清（决定可选方案空间）

| 事实 | 出处 | 含义 |
| --- | --- | --- |
| `single` 基数的席位「渲染当前 **priority 胜者**」；「对于 single/list/keyed，priority 是**遮蔽优先级**，数值越小越先渲染」；「**复用已有 cell 表示有意替换其展示**」；「将 single 和已有 occupant 的 keyed cell 视为**替换点**」 | `reference/subsystems/slots` | 插件**可以**顶掉一个 single 席位的占位者 |
| `ui-workspace` 自述填充的是「the sidebar shell's **`sidebar.workspaces` hole**」 | 随包 `dsh-client-ui-workspace/lib/client.js` | 左栏那块是**一个洞**（可被替换），不是黑盒 |
| 插件在 `sidebar.panellist` 注册的是**图标入口**，其 id「寻址布局中 root 作用域 **`main`** keyed slot 的组件」 | `dsh-client-ui-sidebar` README | 面板入口配对**中央**；它**不是**"左栏内容"的入口 |
| 右侧 Sidebar 支持**多 pane**：`split(paneId?)`、`float`、`dock`；tab 类型 = `sidebarRightTabs.register` ＋ `sidebar.right.pane.tab` 正文 | `reference/subsystems/sidebar-right` | 右栏可以放多块我们自己的内容 |

### 9.2 会话模型：平台会话 ⇄ DSH 会话

平台会话要显示在**外壳的 Conversation** 里，就必须对应一个 DSH 会话（前端消费的是持久会话事件）。
两种关系：

- **1:1 映射（推荐）**：一个平台会话 ↔ 一个 DSH 会话；平台的 LLM 输出由 **Host 适配层**写成该会话的
  事件（§5）。选用哪个平台会话 = 把外壳切到对应 DSH 会话（`ISessions.open`）。
- **平台会话不映射**：会话由我们自己渲染（回到方案 D 的世界）—— 放弃"复用会话渲染"，与所有者第 1 条
  「走 A」相抵，仅作备选。

### 9.3 列表放哪：两个可选位置（各有代价）

**选择甲：替换左栏 `sidebar.workspaces`（布局最像参考图，但有全局影响）**

在 `sidebar.workspaces` 上以更高优先级（更小数值）注册我们的浏览器，内容为**平台会话列表**。
- ✅ 布局＝参考图：左列表｜中会话｜右预览；
- ✅ 完全在官方机制内（single 遮蔽是文档化的替换点）；
- ⚠️ **全局生效**：左栏浏览器是应用级的，替换后**任何视图**下都不再是 DSH 原生会话浏览器；
- ⚠️ 与 `ui-workspace` 的既有能力（分组/搜索/重命名/fork/归档/目录流）冲突 —— 我们只做平台列表，
  等于让用户在这些视图下失去本地会话管理；
- ⚠️ 官方术语里这叫「替换**风险**」。

**选择乙：放进右侧 Sidebar 的第一个 pane（零替换风险，但列表在右）**

用官方多 pane：右栏放 `[平台会话][文件树][文件预览]`，`split` 分出多块。
- ✅ 不动任何官方席位，零替换风险；
- ✅ 复用 `dockkit` 的分栏/浮出/折叠/tab 菜单；
- ✅ 与所有者第 1 条「走 A」完全一致（中央仍是官方 Conversation）；
- ⚠️ 列表位置在右侧，与参考图（列表在左）不同。

**选择丙（折中，供考虑）**：替换左栏，但我们的浏览器**同时**渲染平台会话与 DSH 本地会话（分区展示）。
保留本地会话管理入口，同时满足"云工作空间的会话列表是平台的"。代价是我们承接了整个左栏的维护。

### 9.4 建议

- **首选乙**：先把「平台会话 + 文件树 + 预览」做成右栏三个 pane。零替换风险、全官方机制、与"走 A"
  一致；**列表位置**是唯一让步（可在后续用选择甲迁到左侧，不影响数据层）。
- **若必须左列表** ⇒ 选甲，但要接受它对**所有视图**生效，并明确"本地会话管理入口就此让位"这一后果。

### 9.5 需要真机验证的机制（所有者第 3 条）

以下四条**不验证不实施**（按所有者要求：机制可行才作为备选）：

| # | 待验证 | 判据 | 验证方式 |
| --- | --- | --- | --- |
| M1 | 外壳 Conversation 能否渲染**我们创建的会话** | `ISessions.open(id)` 后，`main.conversation` 显示该会话内容 | 客户端探针：`open()` 后读会话面 |
| M2 | **归档会话能否 `open`** | 归档不改变控制器的列表（早前已证实控制器对 archive 零感知 ⇒ 高置信可 open） | 探针：对一个已归档会话 `open()`，看是否抛错 |
| M3 | 右侧 Sidebar 能否承载**我们注册的 pane** | `sidebarRightTabs.register` ＋ `sidebar.right.pane.tab` 注册后，`openTab(kind)` 能打开我们的正文 | 探针插件：注册一个 demo kind + 正文，`openResource/openTab` 打开 |
| M4 | 右栏**多 pane**（会话列表 + 文件 + 预览）能否共存 | `split()` 返回新 paneId 且三块同时可见 | 探针：连续 `openTab` + `split`，读 pane 数 |

**探针形态**：一个临时的客户端探针（在插件内、带开关），把上述结果写进 console + 一个可被
Puppeteer 读到的 DOM 节点；由 `build/` 下的脚本启动自己的 `dsh web` 实例读取结果 —— 这样
**不影响所有者正在运行的实例**，也无需他重启。

## 10. 机制验证结果：**四条全部通过**（2026-09-22，真机）

| # | 机制 | 结果 | 证据 |
| --- | --- | --- | --- |
| **M1** | 外壳 Conversation 能渲染我们创建的会话 | ✅ | `uiConversation.binding(id).target("chat")` 可解析且具备 `getSnapshot/subscribe` |
| **M2** | **归档**会话能否 `open` | ✅ | `open(已归档 id)` 未抛错，且该会话**仍在控制器列表**（列表 34 个 id，映射的 1 个在列） |
| **M3** | 右侧 Sidebar 能承载我们注册的 pane | ✅ | `sidebarRightTabs.register({id,kind,patterns,canOpen,title})` 成功；正文经 `slots.inject('sidebar.right.pane.tab', …)` 登记 |
| **M4** | 右栏**多 pane** 能共存 | ✅ | `openTab(kind)` + `split()` 成功；所有者截图里**同一右栏并列两块**：我们的「探针 pane」（正文已渲染）与内置「文件」树 |

**⇒ 方案乙成立**（右栏承载「平台会话列表 + 云文件树 + 文件预览」，两模式＝右栏折叠/展开）。
且 M2 说明**归档策略可以保留**：归档只影响列表呈现，不影响它成为外壳的当前会话。

### 10.1 三次"失败"都是探针自己的 bug（记录以免重蹈）

| 表象 | 真因 |
| --- | --- |
| `Cannot read properties of undefined (reading 'ids')` | 我把方法**摘下来调用**丢了 `this`，而注册表用私有字段 `this.ids`。**本仓早有测试守着这个坑**（`conversation-source.ts`：「calls the underlying methods with their own receiver」），我却在探针里踩了，还据此误判"机制不可行" |
| `layout: tab false has no pane` | **两条同名 API 的选项类型不同**：导航服务 `ctx.sidebarRight.openTab` 的 `replaceTab?: TabId`（字符串），tab 自身动作 `tab.actions.openTab` 的 `replaceTab?: boolean`。文档页举的是后者，我照着写却调了前者 |
| 所有者"一进会话就被踢回首页"（每 4 秒） | 探针每轮都调 `ISessions.open()`，而它会改变界面上的当前会话。**这是我该预见到的副作用** |

### 10.2 验证方法本身的两条经验

- **判据不能自己发明**：我最初用 `[contenteditable="true"]` / `<main>` 判断"会话面是否挂载"，
  两个标记都不存在 —— 该 facts 项不可信，已作废。官方契约给的可靠判据是**写操作的行为**：
  没有挂载的会话面时 `openTab` 抛 `no session surface is mounted`。
- **"没测到"要区分三种**：机制不可行 / 调用写错 / 环境不具备。三次失败分别属于后两种，
  而我第一次就下了"机制不可行"的结论 —— 这正是本文开头那条规矩要防的错误。

## 11. 右侧那一列"覆盖在界面上"是**官方形态**，不是插件造成的

所有者两次问到同一件事（第一次：「右侧弹出了窗口且没有挤压会话区域」；第二次：「为什么我们的
预览是浮在原生的界面上的」）。官方文档给了确定答案：**这是列自身的两种呈现形态之一，插件无法选择。**

`dsh-client-ui-sidebar-right/README.zh.md` 原文：

> 「**普通面板贴靠右栏；全屏面板覆盖窗口**并保留宽屏底层列宽。」
> 「**宽屏切换全屏不改变中栏宽度**；宽度拖拽区只在普通展开态显示。」
> description：「每会话一个停靠面、**两种呈现形态**、导航控制器 ctx.sidebarRight…」

| 形态 | 表现 |
| --- | --- |
| 普通（展开） | **贴靠右栏**：真正占位，中栏变窄；有宽度拖拽区 |
| 全屏 | **覆盖窗口**：盖在会话之上、中栏宽度不变 —— 看起来就像"浮在界面上" |

**关键：插件不能指定形态。** 随包 `service.d.ts` 里 `ISidebarRight` 的公开成员只有
`isExpanded()` / `toggleExpanded()`（另有 `openResource/close/focus/split/float/dock/active`），
**没有**任何设置 presentation 的接口；形态由「手动模式或视口宽度」决定（面板工具条上的控件），
且「**在折叠状态下也保留**」。因此：

- 我们的 `openTab(kind)` 落在**活动的停靠 pane**（契约：「缺省为活动的停靠 pane（活动的是浮窗时
  取第一个停靠 pane）」）—— 我们从没请求过全屏或浮窗；
- 内置「文件」面板在同一形态下表现**完全一致**（所有者第一次验收时用的就是内置面板）；
- 想换回贴靠形态，用**面板工具条上的形态切换控件**；插件侧无需（也无法）改代码。

## 13. 施工计划：最后一块「预览时主会话区让出右半」（**待执行**）

步骤①②已完成：删掉四档预设（0.1.39）、左栏上方加会话记录区（0.1.40）。剩下这一块**必须两步一起做**，
因为它是**同一个契约变更的两面**。

### 13.1 诊断结论（已坐实，别再重新查）

`vitest.config.ts` 的 jsdom 项目开了 **`css: true`** ⇒ **测试里 CSS 真的生效**；testing-library 的
`getByRole` 会**跳过可访问性树里被隐藏的元素**。所以"把右栏改成默认不可见"会让
`Unable to find role="tab" and name /Changes/` 在 **7 个文件、31 条测试**上同时出现 ——
**不是查询写错，而是那些 tab 真的不可见了**。这也解释了为什么"删预设"单独做没问题
（不改可见性），而"改网格"一改就红。

### 13.2 步骤 1：网格（`CloudWorkspacesView`）

- `.columns`（`CloudWorkspacesView.module.css`）基础模板最后一轨：`var(--dsh-panel-w, 320px)` → **`0`**
  （其余四轨不动：`var(--dsh-tree-w,260px) 0 minmax(0,1fr) 0`）；
- 视图里给 `.columns` 加 `{...(state.preview === undefined ? {} : { 'data-preview-open': '' })}`；
- CSS 追加两条：
  - `.columns:not([data-preview-open]) .rightPane, .columns:not([data-preview-open]) .panelDivider[data-panel-divider='right'] { display: none }`
    —— **必须整栏隐藏**（隐藏元素不释放轨道，0 宽轨道里带内边距的栏会溢出到邻栏，本仓踩过）；
  - `.columns[data-preview-open] { grid-template-columns: var(--dsh-tree-w,260px) 0 minmax(0,1fr) 0 minmax(0,1fr) }`
    —— 预览吃掉主会话区的一半（所有者规格）。

### 13.3 步骤 2：同步 7 个 spec 的 31 处（**这是主要工作量**）

契约变更：**右栏默认不存在**，要先"打开一个文件"才有。所以：

1. 在 `tests/` 加一个共享助手（如 `tests/support/open-preview.ts`）：
   - 让该 spec 的 fake 的 `workspaceFiles` 返回**一个文件**（形状照 `WorkspaceDirectory`：
     `{ path, revision, items: [{ path, kind: 'file', size, etag }] }`）；
   - 点它（`fireEvent.click(await screen.findByRole('button', { name: /README\.md/u }))`），
     并 `await waitFor(() => expect(columns.getAttribute('data-preview-open')).not.toBeNull())`。
2. 在**每个**使用 Changes/Run/Preview 页签的测试里，**在那次点击之前**插入该助手调用。
   需要改的文件：跑一次全量、筛 `Unable to find role="tab"` 即可拿到完整清单
   （首次实测为 7 个文件 / 31 条，含 `cloud-workspaces.client.spec.tsx` 15 条）。
3. **不要**改回"右栏一直可见"来让测试通过 —— 那正是本条禁止的"把隐藏逻辑改松掩盖问题"
   （见 `AGENTS.md` 客户端坑一节）。

### 13.4 步骤 3：左栏只留「会话记录 + 文件列表」

所有者规格是左栏两块。当前左栏顺序：**会话记录区（已加）→ 新建 Workspace → 工作空间列表 →
工程目录（文件树，已在最后）**。

**定案（所有者 2026-09-22 选定候选一）**：把「新建 Workspace / 工作空间列表 / 上下文镜头 /
生命周期动作」**折进「会话记录区」下方的可折叠区，默认收起**。

实现要点：

- 用一个原生 `<details>/<summary>`（无需自己管展开状态、默认收起、键盘可达、无需额外 ARIA）
  包住这些块，标题写明里面是什么（例如「工作空间与操作」）；
- 折叠**不能**改变这些块的行为：展开/收起只是可见性，不得触发任何重新读取（沿用本仓
  「布局只切可见性」的既有约束）；
- 注意 `AGENTS.md` 那条：**改动"某块默认是否可见"会让按角色的查询失效**。这些块里若有
  被 spec 按角色查的元素（如生命周期按钮、Agent 配置下拉、资产快照），
  要么测试里先展开，要么**只折叠"外壳"而让内容仍在可访问性树里**（`<details>` 收起时内容
  从可访问性树里移除，所以这条要按实测决定）。

## 12. 决策记录：右侧 Sidebar 承载文件预览这条路线**已实施、已验证、随后按所有者要求撤除**

A 段曾把「云文件（目录）」与「预览」注册成官方右栏的两个产品页（0.1.32–0.1.36）。所有者验收后
给出结论：

> 「我需要这样的效果，**预览是出现在插件界面中的**。」

即：预览要**长在插件自己的界面里**（工作台右栏的「预览」页签），而不是被官方右栏那一列（它是
"全屏"形态时覆盖窗口，见 §11）**压在插件界面上**。

**最终形态（0.1.37 起）**：

| 面 | 结论 |
| --- | --- |
| 插件工作台内的预览 | **保留并成为唯一入口**：点「工程目录」里的文件 → `setOpenPath` + `setPane('preview')` → 工作台右栏渲染（`CloudWorkspacesView.openFile`） |
| 官方右栏的两个产品页与迁移按钮 | **撤除**（连同 `cloud-files-state.ts` 那条共享选择通道） |
| **A 段真正的收获** | **渲染复用**：`FilePreview` 用官方原语（`CodeBlock` 的语言表头/行号/复制、`MarkdownText`、安全地板）—— 这条与"挂在哪一列"无关，因此留下来了 |

**留给将来的判断依据**（免得重做）：机制上右栏方案完全可行（M3/M4 已实测），复用的是**渲染原语**；
但**位置**由所有者定为"插件界面内"，因此右栏那条路只在"插件不再是浮层"时才值得重新考虑（届时
`dsh-resource://` 地址体系与 `ctx.fs` 组合才有可能一并复用，见 §3）。

## 14. 性能事故：开合右栏"越用越慢"（0.1.47 修复，所有者确认顺畅）

**症状**（所有者）：点 `×` 第一次很快，之后越来越慢；补报「**点变更运行也会卡**」——这句把问题
从"预览"挪到了"**开合本身**"。

**诊断过程里的一条教训（比结论更值钱）**：

第一版 perf 探针量出"全是 0ms"，我差点据此下结论。**那是无效测量** —— 我在 `click()` 之后
*立刻*读标记，而 **React 是异步提交的**，量到的是"还没发生"。改成"等提交完（两帧 + 一个宏任务）
再强制一次同步布局（读 `offsetHeight`）"之后，数字才有意义：

```
第 1..6 轮：提交 9–12ms / 开(布局) 0ms / 关+布局 14ms / DOM 705 —— 完全持平
```

**根因**：`.columns` 里包含**整个对话区**，而右栏可见性是视图 state ⇒ 每次开合都会**连带重渲染
对话、文件树、预览**。对话越长这一下越贵 —— 这正是"越用越慢"的形状（我本地页面 DOM 只有 705，
所以复现不出 10 秒，但形状一致）。

**修法（结构性）**：`ConversationPane` / `FileTreeView` / `FilePreview` 三个重子树 `memo` 化，
并补齐 memo 需要的**稳定引用**（`NO_TREE_CHANGES` + 两个 `useCallback`）—— 否则每次新建对象/函数
会把 memo 击穿，等于白做。效果：**开合成本与对话长度解耦**。

**留下的工具**：`node build/mount-smoke.mjs <port> --perf` —— 复用冒烟的登录与进入工作台，
量真机提交/布局耗时与 DOM 规模。**界面卡的报障先用它取数，不再靠猜。**

## 15. 决策记录：会话渲染的复用上限（所有者 2026-09-22 选 **B**）

第 2 项「会话复用外壳渲染」的两个选项与取舍（所有者已定）：

| 选项 | 内容 | 代价 |
| --- | --- | --- |
| A 真迁移 | 进入云工作空间时把外壳切到我们的会话 → **外壳用自己的完整聊天 UI 渲染**（消息/工具卡/审批/计划/流式全部白拿） | **预览要挪到外壳右栏**（与 0.1.37「预览要出现在插件界面中」冲突）；且要撤掉刚做完的左栏会话记录区、文件树、预览面板 |
| **B 保留浮层（选定）** | 现状即上限 | 外壳的聊天渲染器（`ConversationRoot` / `ConversationSession` / `ConversationPanel`）**不是包的公开导出**（`/client` 只导出插件主体），浮层里无法复用 |

**已复用的部分（B 之下的天花板）**：`uiConversation.binding()` 会话装配（官方快照 + `target('chat')`）
＋ 官方 primitives（`CodeBlock` 高亮/语言表头/行号/复制、`MarkdownText`、`FileTypeIcon`、HTML 安全地板）。

**将来的路径（等后端 §3.1 落地后按此做）**：

1. Host 适配层把平台的会话/LLM 输出**写成 DSH 会话事件**（映射表见 §5 与 `docs/backend-api-requirements.md` §3.1）；
2. `ConversationPane` 继续用官方 `binding()` 快照渲染 —— 它已经是这条路径，后端到位即可显示真实内容；
3. 若届时仍想要外壳的完整聊天 UI，再**一次性**做 A，并把「预览位置」「浮层去留」两个取舍一起定。





