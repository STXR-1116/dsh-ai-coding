# 0.2.1-rc.2 适配：与官方文档的逐条核对

> 所有者要求：**安装前重新核对官方文档，确认适配是正确的**。
> 本文件是那次核对的记录。证据强度分三类，逐条标注：
> **【文档】** = 官方手册有原文；**【随包】** = 随 DSH 安装的类型/实现；**【实测】** = 本机跑出来的。
> 手册镜像已刷新（`build/fetch-dsh-manual.ps1`，2026-10-19）：**86 页里只有 3 页变化**
> （`develop/basic/tool`、`develop/practice/dynamic-cordis`、`reference/tool-execution-pipeline`），
> 均与本次适配无关 ⇒ 本文引用的页面都是**当前版本**。

---

## 结论一览

| # | 适配里的结论 | 与文档的关系 | 判定 |
| --- | --- | --- | --- |
| 1 | 插件不自带运行时，运行时包走 `peerDependencies` | 文档未直接覆盖第三方插件；**随包**证据充分 | ✅ 成立（证据类型已标注） |
| 2 | 席位注册要**遮蔽**才能替换展示；**priority 越小越胜** | **【文档】** 原文支持 | ✅ 与文档一致 |
| 3 | `PropsRuntime` / `PropsLocale` 在 0.2.1 不可用 ⇒ props 改内联签名 | **文档仍教 `PropsRuntime`**，与随包实现**冲突** | ⚠️ **被迫偏离文档** |
| 4 | primitives 不再导出图标 ⇒ 换成 `lucide-react` | **【文档】未覆盖**图标 | ✅ 结论成立；换成什么是我的选择 |
| 5 | 注入上下文的 `source.kind`：`'plugin'` → `'system-prompt'` | 与文档**不冲突**（kind 联合只在随包类型里） | ✅ 成立；`'user'` 已实测排除 |
| 6 | 插件读不到外壳的"当前会话"（绑定改绑插件自己的会话） | **【文档】未覆盖** | ✅ 成立（随包原文 + 实测） |
| 7 | 0.2.1 没有 `invariants` 服务 ⇒ 伴生插件退役 | 站点无该页（HTTP 404）；随包无该导出 | ✅ 成立，属**能力损失** |

---

## 逐条依据

### 1. 依赖形态（peerDependencies）

- **【随包】** 官方三个客户端插件包：`dsh-client-ui-workspace` / `dsh-client-ui-sidebar` 的
  `dependencies` **为空**、`peerDependencies` 只有 `@deepseek-ai/cordis`；
  `dsh-client-ui-chat` 的 `dependencies` 只有独立库 `@deepseek-ai/schemastery`。
- **【文档】** `docs/cookbook/adding-a-package.zh.md` 讲的是 **DSH 仓库内部**的分组/约束
  （`private: true`、版本与根一致等），**不是**第三方插件如何声明运行时依赖
  ⇒ 这一条**不能**引文档，按本仓规矩标注为"随包证据 + 实测"。

### 2. 席位遮蔽与 priority 方向

**【文档】** `reference/subsystems/slots` 原文：

> 对于 `single`、`list` 和 `keyed` cell，**priority 是遮蔽优先级**……**数值越小越先运行或渲染**。
> 普通增量贡献应选用新的 list id 或 keyed key；**复用已有 cell 表示有意替换其展示**。

⇒ 与实现一致（左栏遮蔽取 `SHADOW_PRIORITY = -1000`）。

### 3. props 类型：**被迫偏离文档** ⚠️

**【文档】** 同一页的示例仍写：

```ts
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
type HeaderActionProps = PropsRuntime<'conversation.session.header.actions'>
```

**【随包】** 而 0.2.1 里：

- `@deepseek-ai/dsh-client-ui-slots` **这个包不存在**（整个安装里都没有）；
- `PropsRuntime` / `PropsLocale` 存在于 `dsh-client-locale` 的**内部**文件，但**未公开导出**；
- 随之消失的还有 `SnapshotSelectorHook`（它搬到了 `dsh-client-ui-renderer/client`）。

⇒ 我们的做法：props **内联声明**（`t` / `useSessions` / `useWorkspaces` / `wide`），
用显式函数签名而不是再找辅助类型。**这是对文档的偏离**，原因是文档未跟进随包实现；
代码注释里已写明。

### 4. 图标

**【文档】未覆盖**（`IconRefreshOutline16` 等在整个手册里搜不到）。
**【随包 + 实测】** 0.2.1 的 `dsh-client-ui-primitives` **不再导出任何图标**，
且整个 DSH 安装里都搜不到那些名字 ⇒ React 报 `Element type is invalid`（实测 1347 次）。

⇒ 换成 `lucide-react` 等价图标（别名导入，调用点不改）。
**换成什么是我的选择**：自绘 SVG 也成立；选 lucide 是因为本仓已有该依赖、且不再依赖 DSH 内部图标体系。

### 5. `source.kind`

**【文档】** `reference/persistence-catalog` 确认 `'user/message'` 与 `'system/message'` 都是
**事件类型**，且 `source` / `surfaceOp` 只存在于 `SurfaceEventType` 变体上
⇒ 我们注入走 `createUserMessage({ source })` 与之相符。
**【随包】** kind 的联合只在随包类型里：`'user' | 'model' | 'tool' | 'system-prompt' |
'model-selection' | 'skill-invocation' | 'user-question-reply' | 'session-reference'`（**无 `'plugin'`**）。
**【实测】** 用 `'user'` 会让注入上下文被当成用户输入 ⇒ 召回自激，多条用例变红 ⇒ 排除。

### 6. 读不到"当前会话"

**【文档】未覆盖**。
**【随包】** `ISessions` 的注释原文：「Host catalog and local reference-source counts;
**navigation belongs to view owners**」；`SessionListState` 只有 `ids` / `byId` / `phase` /
`projectionsBySession`。
**【实测】** 真机上插件拿不到外壳当前会话 ⇒ 知识库绑定改绑"插件自己打开的会话"（所有者选定方案 A）。

### 7. `invariants` 服务

**【文档】** 站点 `reference/subsystems/invariants` **404**（只在 URL 清单里出现过，属仓库内部路径）。
**【随包】** 0.2.1 类型里既无 `InvariantInstaller`，也无 `invariants` 服务。
⇒ 伴生插件退役。**这是一项能力损失**，若要保留需另找落点（例如做成一个校验工具）。

---

## 复核方式（可重跑）

```pwsh
# 1) 刷新手册镜像（本次：86 页里只有 3 页变化，均与适配无关）
.\build\fetch-dsh-manual.ps1

# 2) 搜文档原文
Select-String -Path "$env:USERPROFILE\.dsh\dsh-manual\site\reference__subsystems__slots.txt" `
  -Pattern 'priority 是遮蔽优先级|数值越小'

# 3) 与随包实现对照（示例：确认 0.2.1 没有 dsh-client-ui-slots）
Test-Path "$env:USERPROFILE\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-client-ui-slots"
```
