# 云工作空间 · 样式优化点梳理

**状态：梳理稿，未实施。** 基准是 DSH 自己的会话页；每条都带我们代码里的实测数值。

## 0. 结论先说

我们的三栏是**手写卡片 UI**：每个区域是一张带 `border + border-radius + padding` 的盒子，尺寸靠
逐条硬编码。DSH 的会话页是**满幅分区 + 1px 分隔线 + token 化排版**：区域之间靠分隔线而不是卡片边界，
所有尺寸来自 `--dsh-*` token（随主题/密度切换）。

**这不是"丑得需要重新设计"，而是"没有接到 DSH 的设计系統上"。**

### 实测数据（`CloudWorkspacesView.module.css`，658 行）

| 项 | 实测 |
| --- | --- |
| 使用 `var(--dsh-*)` | 72 处 |
| **硬编码 px** | **143 处** |
| 圆角 | **5 种**：`7px`×13、`10px`×4、`14px`×4、`8px`×3、`1px`×1 |
| 字号 | **4 种**：`14px`×12、`12px`×9、`11px`×3、`17px`×1 |
| 滚动条样式 | **0 处**（DSH 有 `--dsh-scrollbar-width` / `-thumb` / `-thumb-hover`） |
| 空态规则 | **0 条**（中栏那片空白没有任何空态样式） |
| `focus-visible` | 2 处 |
| `box-shadow` | 1 处 |

`PlatformSurface.module.css`（3115 行）同病：364 处 token vs **576 处硬编码**（圆角 40、字号 119）。

### DSH 会话页实际依赖的 token（从随包客户端产物中提取）

```
--dsh-chat-content-width         居中内容列宽（会话页的核心）
--dsh-chat-flow-gap              消息流间距
--dsh-chat-user-width            用户消息宽度约束
--dsh-composer-height            |
--dsh-composer-dock-inset        | 停靠输入器的尺寸与让位
--dsh-composer-side-clearance    |
--dsh-composer-stack-gap         |
--dsh-composer-hint              输入器提示色
--dsh-session-list-edge-inset    会话列表左右边距
--dsh-session-list-scrollbar-*   列表滚动条偏移与宽度
--dsh-scrollbar-width / -thumb / -thumb-hover
--dsh-content-font-size / -secondary / --dsh-content-font-delta
--dsh-sidebar-inline-padding
--dsh-state-ongoing · --dsh-file-type-* · --dsh-table-lead / -spare · --dsh-toast-hold
```

**要点**：会话页不是"卡片拼起来的"，而是**一列居中的内容 + 停靠的输入器 + 由 token 控制的滚动与边距**。

## 1. 左栏（项目 / Workspace 列表 / 工程目录）

**现状**：`border + radius 10px + padding 8px` 的独立盒子；列表项 `gap: 4px`；层级全靠字号缩小。

**问题**

1. 卡片边界与中/右栏重复 —— 三张卡片并排，视觉噪声大；DSH 用**分隔线**划分区域。
2. Workspace 卡片选中态与 hover 态缺 `focus-visible`（键盘用户看不到焦点）。
3. 状态文字（`main · ready · rev 7`、`初始化失败：磁盘配额不足`）用硬编码字号，与 DSH 的
   `--dsh-content-font-size-secondary` 不一致，深浅主题下对比度靠 `opacity` 硬撑。
4. 工程目录树的行高没有对齐 DSH 密度 token（我们 `.surface` 已定义 `--dsh-density-row`，
   但列表没消费它）。

## 2. 中栏（会话区）——**最需要改的一栏**

**现状**：一片空白；我加的会话状态行**还落在了右栏**（见 §5 的 bug）。

**问题**

1. **没有空态**。DSH 的会话页在无会话时有明确的 Hero/引导；我们什么都没有，看起来像坏了。
2. 会话区应当是**居中内容列**：`max-width: var(--dsh-chat-content-width)`，消息流用
   `--dsh-chat-flow-gap`。我们现在没有任何列宽约束，将来渲染节点时会横跨整个视口宽度。
3. 缺滚动容器约定（DSH 的滚动条有 token，我们的 `overflow:auto` 是裸的）。

## 3. 右栏（Preview / Changes / Run）

**现状**：底部那张横跨半个屏幕的 `Preview | Changes | Run` 卡片 + 「在左侧目录中选择文件」小字 +
「打开 Web App」按钮，与上方的「原生会话 / 上下文镜头」面板**各成一块**，比例失衡。

**问题**

1. **两块应该合并成一个右栏**：上方是会话/镜头、下方是 Preview/Changes/Run 的分工来自 docked 时代，
   全屏后中栏空着、右栏却挤着两套面板。
2. Tab 组（Preview/Changes/Run）没有做成 DSH 的 tab 样式（无下划线/无选中背景规范）。
3. 空态文案（「在左侧目录中选择文件。」）用 11–12px 灰字，应改为统一空态组件。

## 4. 顶栏与工具条

1. 顶栏（组织/项目/账号/角色/数据来源）是**宿主级 chrome**，样式应与 DSH 顶栏一致：
   高度、`--dsh-sidebar-inline-padding` 级别的左右内边距、分隔线。
2. 布局预设（标准三栏/专注会话/审阅 diff/监控运行）现在是**四个独立按钮**；DSH 里同类切换是
   **分段控件（segmented）**，选中态有明确背景。
3. 「fixture-only」标记是纯文本；DSH 用**徽标（badge）**，有边框/底色/大写小字。

## 5. 顺带发现的两个功能问题（不是样式，但同一屏）

1. **会话状态行位置错了**：它现在渲染在右栏的「原生会话」面板内（我插在了旧提示的位置），
   而它描述的是**中栏的会话** —— 应移到中栏。
2. **会话创建失败（真 bug）**：

   ```
   session create failed: workspace/not-found: workspace "ws-alpha-1" not found
   ```

   我把**云工作空间 id**（`ws-alpha-1`）当成了 DSH 的 `workspaceId` 传给 `sessions.create`。
   两者不是一回事：前者是平台的远端工作空间，后者是 DSH 本地工作区注册表里的 id。
   原文（设计文档 §4）也明确：插件不得保存或使用远程物理路径。**修法**：不传 `workspaceId`
   （或传用户当前选中的**本地** DSH 工作区 id），只保留会话本身。

## 6. 建议的样式契约（可执行）

| 项 | 现在 | 改为 |
| --- | --- | --- |
| 区域划分 | 三张卡片（border + radius 10） | **满幅三栏 + 1px 分隔线**（`--dsh-border-subtle`），仅浮层整体保留外边框 |
| 圆角 | 5 种（7/10/14/8/1） | 统一到 DSH 的圆角 token；交互控件一档、容器一档 |
| 字号 | 4 种硬编码（17/14/12/11） | `--dsh-content-font-size` / `-secondary` / `--dsh-content-font-delta` |
| 中栏内容 | 无约束 | `max-width: var(--dsh-chat-content-width)` 居中 |
| 输入器 | 未实现 | 停靠，用 `--dsh-composer-*` 一组 token |
| 滚动条 | 裸 `overflow:auto` | `--dsh-scrollbar-*` |
| 列表边距 | `padding: 8px` | `--dsh-session-list-edge-inset` / `--dsh-sidebar-inline-padding` |
| 空态 | 无 | 统一空态组件（图标 + 一句说明 + 一个动作） |
| 分段切换 | 四按钮 | segmented 控件 |
| 状态标记 | 纯文本 | badge（边框 + 底色） |

## 7. 建议的实施顺序

1. **修 §5 的两个功能问题**（状态行位置、`workspaceId` 传错）—— 否则样式改了也是在错的骨架上。
2. **区域划分 + 圆角/字号 token 化**（改动最集中、观感提升最大）。
3. **中栏居中内容列 + 空态**（配合步骤 2 的会话渲染一起做）。
4. **右栏合并 + tab/分段控件规范化**。
5. **滚动条、焦点态、深浅主题对比度**的统一收尾。

> 依据：`CloudWorkspacesView.module.css` / `PlatformSurface.module.css` 实测统计；DSH 随包客户端产物中
> 出现的 `--dsh-*` token 清单（`dsh-client-ui-conversation` / `dsh-client-ui-chat` /
> `dsh-client-ui-session` / `dsh-client-ui-workspace` 等）。**未做**逐 token 取值核对（值由运行时主题注入，
> 引用 token 名即可随主题变化）。
