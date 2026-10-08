# 云工作空间 · 两模式界面设计（会话 / 预览）

**状态：设计稿，待所有者确认后实施。** 本文严格依据官方参考区（本机镜像
`~/.dsh/dsh-manual/site/`，逐条注明页码/原文），不凭印象设计。

## 0. 口径与依据

**所有者口径（2026-09-22，取代蓝图 §5.2）**

> 「为什么要分成标准三栏、专注会话、审阅 diff、监控运行 这四个独立的 tab？我是希望云工作空间就参考
> DSH 的界面功能，**只要分为会话模式和预览模式就行**。第一张图是会话模式，第二张图是预览模式
> （**将会话部分一分为二，右侧进行文件预览**）。」

**官方依据**

| 依据 | 出处 | 用到的内容 |
| --- | --- | --- |
| 右侧 Sidebar 契约 | `reference__subsystems__sidebar-right` | 「每个会话一份的停靠面：会话区旁的一列 pane 与 tab」；地址模型；tab 类型注册；挂载条件 |
| 客户端槽位 | `reference__subsystems__slots` | `sidebar.right.pane.tab`、`.pane.tab.title`、`.tab.guide`、`.tab.menu.item` |
| Conversation 组装 | `reference__subsystems__conversation` | 我们已复用的装配与 target（`uiConversation.binding`） |
| 客户端插件组装 | `reference__subsystems__client-modules`、`web-client` | 插件如何在浏览器侧装配 |

**本仓既有实测**（非本文新增）：浮层几何由我们自己的 CSS 决定（`docs/cloud-workspace-redesign.md`
§11）、`ILayout` 只报告不定位（同上）、五轨网格（`CloudWorkspacesView.module.css` 注释）。

## 1. 两种模式

| 模式 | 左（工程树） | 中（会话） | 右（预览） | 用途 |
| --- | --- | --- | --- | --- |
| `conversation` 会话 | ✓ | ✓ 吃掉右侧空间 | — | 与 agent 对话（主界面） |
| `preview` 预览 | ✓ | ✓ | ✓ **与会话等分** | 边看会话边看文件 |

**沿用旧预设的冻结约束**（原文照搬，仍然成立）：**切换模式只改可见性 —— 不得改变运行状态、
不得触发重新读取。**

## 2. 关键取舍：右侧预览用官方机制，还是自有栏位？

### 2.1 官方机制是什么（逐字引用）

`reference__subsystems__sidebar-right` 开篇：

> 「右侧 Sidebar 是 Web Client 里**每个会话一份的停靠面**：会话区旁的一列 pane 与 tab，
> **按地址寻址**的内容——工作区文件、目录树、产品自带页面——在这里打开、分栏、浮出、关闭。」

- **地址模型**：`dsh-resource://<protocol>/…`；本地文件是
  `dsh-resource://file/session/<sessionId>/<相对路径>`，由 `fileAddressFor(sessionId, cwd, path)`
  构造（`dsh-util/workspace-path`）。
- **扩展方式**（官方示例逐字）：`ctx.sidebarRightTabs.register({ id, kind, patterns, canOpen, title })`
  ＋ `ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name, key }, Body))`。
- **导航服务**：`openResource(address, options?)` / `openTab(kind, options?)`，另有
  `close / focus / split / float / dock / isExpanded / toggleExpanded`。
- **内置类型**：`dsh-client-ui-sidebar-documentpreview`（text）、`dsh-client-ui-sidebar-files`。
- **挂载条件**：「root 作用域的 rightbar 控制器**仅在选中 Conversation 时**挂载该席位」；
  刷新后每个会话回到**折叠**默认态。

### 2.2 判定：**不采用**，改用自有栏位（三条理由，各有依据）

1. **可见性冲突。** 官方这个面只在**外壳的 Conversation 被选中**时挂载，而本工作台是**全屏浮层**
   （`shell.overlay`；`.surface` 为 `position: fixed; inset: 0`，见 §11 的实测）。浮层会把外壳的会话区
   与右侧 Sidebar **一起盖住**。改用它等于放弃所有者的「占满整个界面」。
2. **数据来源不同。** 官方 `file` 协议读的是 **Host 本地工作区文件**（地址以会话工作区根为基准，
   `dsh-resource://file/session/<id>/…`）；云工作空间的预览来自**平台服务**（`workspacePreview`），
   是远端资源，且设计说明书 §4 明确「插件不显示或保存远程物理路径」。
3. **会话归属不同。** 官方面是「**每个会话一份**」，绑外壳当前会话；本工作空间的会话是我们**自己创建
   并归档**的独立会话（§3.3/§10），外壳并不把它当作当前会话 —— 该面根本不会为它挂载。

### 2.3 但官方这套给出了**将来的正确落法**（写进设计，供演进）

若工作台将来不再是全屏浮层（例如改成 `main` 主面板 + 外壳右侧 Sidebar），顺序是：

1. 注册一个资源协议 host（如 `dsh-resource://cloud-workspace/…`），把平台返回的预览内容变成
   `ctx.resources` 可读的活数据；
2. `ctx.sidebarRightTabs.register({ kind: 'cloud-file', canOpen, title })`；
3. `ctx.slots.register({ name: 'sidebar.right.pane.tab', key })` 提供正文；
4. 打开走 `ctx.sidebarRight.openResource(address)`。

即可白拿**分栏 / 浮出 / 折叠 / tab 菜单 / 键盘导航**，无需自己写拖拽与宽度状态。
**「按地址寻址」这一语义现在就该沿用**：把「当前打开的文件」当作一个可持久化的地址标识
（当前实现用 `openPath`，见 §4.3）。

## 3. 布局规格

### 3.1 网格：仍是五轨

`.columns` 的子元素是**三个 pane ＋ 两条拖拽分隔条**（`grid-template-columns` 必须是五轨，否则
自动放置会把会话列塞进 320px 轨、把面板挤到第二行 —— 这个 bug 刚修完，见该文件注释）。

| 模式 | `grid-template-columns` | 隐藏 |
| --- | --- | --- |
| `conversation` | `var(--dsh-tree-w,260px) 0 minmax(0,1fr) 0 0` | 右面板（整栏）＋右侧分隔条 |
| `preview` | `var(--dsh-tree-w,260px) 0 minmax(0,1fr) 0 minmax(0,1fr)` | 无 |

- **隐藏必须整栏**：隐藏栏内子面板不释放轨道，且 0 宽轨道里带内边距的栏会溢出到邻栏（已踩过）。
- **隐藏必须同时重写模板**（否则轨道留空、中栏被挤成缝 —— 已踩过，且已有结构性测试守着）。
- 两条分隔条在 `conversation` 模式下都隐藏；`preview` 模式下两条都可用（会话/预览可拖）。

### 3.2 宽度

- 会话列：内容用 DSH 自己的 **`--dsh-chat-content-width`** 居中（官方会话页的度量），不是拉满；
- 预览列：默认与会话**等分**（`minmax(0,1fr)`）× 可拖。等分依据是所有者的第二张参考图
  （会话区一分为二）；
- 工程树：`--dsh-tree-w`，默认 260px，可拖（不变）。

## 4. 交互规格

### 4.1 模式切换控件

四个文本按钮 → **两段式分段控件**（`role="toolbar"` 容器 ＋ 两个 `aria-pressed` 按钮；
标签取自 `WORKSPACE_LAYOUT_LABELS`）。沿用现有 `data-layout` 属性驱动 CSS，避免引入第二套开关。

### 4.2 打开文件 → 自动进入预览模式

依据所有者早前口径：「打开要预览的文件后**展示在右侧预览区域**」。因此在 `conversation` 模式下点击
工程树里的文件时：切到 `preview` **并**打开该文件。这样「会话模式」保持干净，而动作自然带来所需空间。

### 4.3 持久化

沿用现有每账号每工作空间的 `uiStateKey`，存 `{ mode, openPath }`（现在存 `{ selectedId, openPath, pane }`）。
登出/失权时随既有清理逻辑一并清除 —— 与「不把上一个账号的选择带给下一个账号」的既有约束一致。

### 4.4 无障碍与键盘

- 分段控件：两个按钮可 Tab 到达，`aria-pressed` 表达当前模式；容器 `aria-label="布局模式"`。
- 分隔条：`role="separator"` ＋ `aria-orientation` ＋ `aria-valuenow/min/max` ＋ 方向键调整（**已实现**，
  本次不动）。

## 5. 改动清单（实施时）

| 位置 | 动作 |
| --- | --- |
| `layout-presets.ts` | **删除**（四档预设作废） |
| `layout-modes.ts` | **新增**：`WorkspaceLayoutMode`、`WORKSPACE_LAYOUT_MODES/LABELS`、`LAYOUT_MODE_SPECS`、`layoutModeSpec()`（词表外取值抛错，不静默兜底） |
| `CloudWorkspacesView.tsx` | 导入与状态改两模式；默认 `conversation`；四按钮 → 分段控件；`data-layout={mode}`；打开文件时切模式 |
| `CloudWorkspacesView.module.css` | 四档预设规则 → 两模式规则；新增分段控件样式；`.layoutToolbar` 退役 |
| `tests/cloud-workspaces-layout.client.spec.tsx` | 断言改两模式（按钮名、`aria-pressed`、`data-layout`） |
| `tests/layout-presets-css.spec.ts` | 结构性不变量保留（隐藏栏必须同时重写五轨模板；只能隐藏整栏），模式表改两个 |
| `tests/layout-presets.model.client.spec.ts` | 改为两模式模型测试（顺序、标签、可见性、未知取值抛错） |

## 6. 明确不做

- **不**注册官方右侧 Sidebar 的 pane/tab（我们不是那个面的拥有者，且它被浮层覆盖）；
- **不**动外壳的会话面、不改 DSH 自身；
- **不**自建分栏/浮出/折叠那一套（将来若改用官方面，这些白拿）。

## 7. 待所有者确认（3 条）

1. **预览列宽度**：与会话**等分**（我按你第二张图的理解，且可拖）？还是固定宽度（如 360px）？
2. **会话模式是否留一个「拉出预览」的入口**？还是只靠分段控件切换？
3. **打开文件自动切到预览模式** —— 确认？（依据你早前「打开要预览的文件后展示在右侧预览区域」）
