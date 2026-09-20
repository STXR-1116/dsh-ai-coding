# API 漂移台账 — 0.1.1-rc.2 源码 → `@deepseek-ai/*` 0.1.5-rc.2 基线

本文件是门禁 5 的交付物：逐项登记每一处适配，格式固定为
**「0.1.1-rc.2 旧行为 → 0.1.5-rc.2 新基线行为」**，并附证据位置与修复方式。

- **源码版本**：本仓检出时的 0.1.1-rc.2 快照（harness monorepo）。
- **基线版本**：npm `@deepseek-ai/*` = `0.1.5-rc.2`（与本机全局 dsh 一致）。
- **状态图例**：✅ 已修复并有验证 · ⚠️ 已修复但带已知保留 · ⛔ 结构性未解（已记录）

| # | 状态 | 一句话 |
|---|------|--------|
| D1 | ✅ | `dsh-client-runtime/client` 被撤，客户端根 context 回落为 cordis `Context` |
| D2 | ✅ | `dsh-api-remotes/client` 是封闭装配，本插件 Remote 契约改由自己发布 |
| D3 | ✅ | `AgentLoop.create()` 由同步返回 `Agent` 变为 `Promise<Agent>` |
| D4 | ✅ | `AgentLoop` 的 `inject` 新增 `sessionProjections` |
| D5 | ✅ | `dsh-client-ui-primitives` 运行时依赖未声明 + CSS 需内联 |
| D6 | ✅ | invariants 注册身份唯一，重复注册会抛错 |
| D7 | ✅ | dev harness 的 tsconfig 需要共享 `tsconfig.base.json` |
| D8 | ✅ | typert face 在单包根布局下无法生成 → 改为机械派生 |
| D9 | ✅ | `session.events`（属性）→ `session.ownEvents()`（方法） |
| D10 | ✅ | `SessionEventMap` 由开放变封闭，插件必须显式合并 |
| D11 | ✅ | `ILayout.reserveRight(px)` → `openRightbar(track, fullscreen)` / `closeRightbar()` |
| D12 | ✅ | `IWorkspaces.startSession()` 移除 → 客户端 `ISessions.create()` |
| D13 | ✅ | 槽位标准 props `useSessions` / `useWorkspaces` 的贡献方是 UI 包 |
| D14 | ✅ | `ctx.slots` 由 `dsh-client-ui-renderer/client` 声明 |
| D15 | ✅ | 程序未引入 `@types/node`，`node:*` 与 `NodeJS` 全部失解 |
| D16 | ✅ | `MarkdownText` 的 `labels` 由可选变必填 |
| D17 | ✅ | `SessionTelemetryCoordinator` 的 capture 模式由裸字符串变 options 对象 |
| D18 | ⚠️ | `RemoteResult.error.code` 收窄为封闭 `RemoteErrorCode` |
| D19 | ✅ | `dsh-client-modules/client` 不再转发 `optionalStringArray` |
| D20 | ✅ | TypeScript 6 要求显式 `rootDir` |
| D21 | ✅ | 单包身份改名（门禁 3） |
| D22 | ⛔ | 双半插件无法在单一 TS 程序里同时正确类型化两侧服务 |

---

## D1 — 客户端根 context 与 `SessionId` 的来源

**旧行为**：`@deepseek-ai/dsh-client-runtime/client` 导出客户端根 context 类型与
`SessionId`；该包在 0.1.5 基线上 **已从 npm 撤回（404）**。

**新基线行为**：客户端插件的根 context **就是** cordis `Context` —— 已发布的每一个
客户端包都写 `import type { Context as ClientContext } from '@deepseek-ai/cordis'`；
`SessionId` 由 API-remotes 门面从 `@deepseek-ai/dsh-client-connection/client` 组装。

**证据**：`node_modules/@deepseek-ai/dsh-client-*/lib/types/client/index.d.ts` 首行导入。
**修复**：`src/client/index.ts:8-9` 改为 `Context as ClientContext` + `SessionId from
'@deepseek-ai/dsh-api-remotes/client'`。`tests/helpers/client-runtime-types.ts` 保留为
兼容垫片。

---

## D2 — 本插件的 Remote 契约不再能挂进平台装配

**旧行为**：客户端从平台装配好的 `ClientRemote` 取本插件的 Remote 命名空间；
各双半插件通过生成的 `typert.remote-client.d.ts` 做声明合并把它加宽。

**新基线行为**：`@deepseek-ai/dsh-api-remotes/client` 是**封闭的第一方装配**
（25 行 `export type {} from '<pkg>/remote'`），第三方插件的命名空间无法加入。

**证据**：`node_modules/@deepseek-ai/dsh-api-remotes/lib/types/client/index.d.ts`。
**修复**：契约改由本仓发布 —— `./types` 导出全部边界类型，`./remote` 由 D8 的派生
face 提供（类型层）。14 个 `src/client/**` 文件的
`@deepseek-ai/dsh-ai-coding-platform/types` 导入改写为本地 `../types.ts` /
`../../types.ts`。

---

## D3 — `AgentLoop.create()` 变异步

**旧行为**：`ctx.agentLoop.create(...)` 同步返回 `Agent`。
**新基线行为**：返回 `Promise<Agent>`（装配需要 `await`）。

**修复**：42 处调用点补 `await`（`tests/**` 7 个文件）。

---

## D4 — `AgentLoop` 新增 `sessionProjections` 依赖

**旧行为**：`AgentLoop.inject` 不含 `sessionProjections`，直接 `ctx.plugin(AgentLoop)`
即可。

**新基线行为**：0.1.5 的 `AgentLoop` 声明了 `sessionProjections` 依赖；未挂载时
`ctx.agentLoop` 取到 `undefined`，报
`TypeError: Cannot read properties of undefined (reading 'create')`。

**修复**：7 个测试文件补
`import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'` 并在
11 处挂载点 `await ctx.plugin(SessionProjectionRegistry)` 后再挂 AgentLoop。

---

## D5 — `dsh-client-ui-primitives` 的未声明运行时依赖与 CSS

**旧行为**：`dsh-client-ui-primitives@0.1.1-rc.2` 自洽。
**新基线行为**：`0.1.5-rc.2` 发布了 **18 个未声明**的运行时导入（上游只写进
devDependencies），且组件引 `node_modules` 内的 `.module.css`。

**症状与修复**（两步，缺一不可）：
1. `Cannot find package 'clsx' imported from …ui-primitives` → 根 devDeps 补 16 个
   运行时依赖（`clsx`、`shiki`、`@shikijs/langs`、`anser`、`katex`、`mdast-util-*`、
   `micromark-*`）。
2. `TypeError: Unknown file extension ".css" for …StateDot.module.css` →
   `vitest.config.ts` 加 `css: true` + `server.deps.inline: [/@deepseek-ai\/dsh-client/]`。

---

## D6 — invariants 注册身份唯一

**旧行为**：`client-node/invariant.ts` 与 `invariant.ts` 各自注册，重名不报错。
**新基线行为**：`@deepseek-ai/dsh-invariants` 对重复包名抛
`invariants: package "<name>" is already registered`。

**修复**：`src/client-node/invariant.ts` 改为 `export { apply, inject, name } from
'../invariant.ts'` 的别名再导出（客户端半边原本是 `install = () => {}` 空实现）。
**⚠️ 需 owner 复核**：这是唯一一处「为满足新基线约束而改变文件形态」的地方。

---

## D7 — 共享 `tsconfig.base.json`

**旧行为**：monorepo 根有 `tsconfig.base.json`，dev harness 的 tsconfig 继承它。
**新基线行为**：本仓单包，最初没有该文件，dev 侧报
`[TSCONFIG_ERROR] Failed to load tsconfig 'tsconfig.base.json': Tsconfig not found`。

**修复**：新增根 `tsconfig.base.json`，`tsconfig.json` 与 dev harness 共同继承。

---

## D8 — typert face：单包根布局下不可生成，改为机械派生

**旧行为**：`@deepseek-ai/dsh-typert-generator` 在 tsdown 构建期产出
`lib/typert.host.js`（TYPERT manifest）+ `lib/typert.remote-client.js/.d.ts`。

**新基线行为**：该生成器**在本仓布局下无法运行**，三个硬阻断（证据见
`docs/typert-wiring-notes.md`，含 5 次探针运行）：

1. `analyzer.js` 只读根 face 聚合的 `projectReferences`，并把候选包硬过滤到
   `<root>/packages/**` 之下 —— 单包根布局无法表达。
2. `isTypeMetaSymbol` 仅当 `@Remote` 的**声明**归属于字面名为
   `@deepseek-ai/dsh-typert-protocol` 的注册时才认；从 `node_modules` 消费该包时
   永远为假（探针：`name-ok reg=NONE`）→ 0 个 marker → `validateExport` 抛
   「publishes Remote artifacts but has no Remote methods」。
3. `tsdown-plugin.js` 的 `packageRoot()` 对 workspace 根包返回 `undefined`，
   `mode:'package'` 静默 no-op。

**运行时后果（已核实）**：
- **Host 半边不需要它**：`dsh-api-gateway/lib/index.js:758-762` 先查严格注册表，未命中
  则回落 SRC 发现；本插件 85 个 `@Remote` 方法全是裸标识符参数，SRC 兼容。
- **浏览器半边需要它**：`dsh-api-gateway/lib/client.js:1823-1830` 只接受严格 codec，
  无 SRC 路径。
- **已声明但构建不出的 export 是硬失败**：`dsh-typert-loader` 对*缺失*的 export 静默
  跳过（`index.js:278-279`），但对*已声明却导入失败*的 export 会抛错并在激活期被
  重抛为 `AggregateError`（`255-257` / `322-326`），而 `dsh-base` 会挂载该 loader。

**修复**：
- `build/generate-remote-face.mjs` 从两个网关类机械派生 face（85 个端点）：端点名取
  `@Remote('x')` 字面量否则方法名；参数列表原样过线；返回值包进协议传输信封
  `RemoteResult<T>`。产物 `src/client/remote-face.ts` 入库，
  `tests/remote-face.spec.ts` 以 `--check` 做漂移守卫。
- `package.json` **删除** `./typert` 与 `./remote` 两个 export（以及 `files` 里对应的
  四个字面量），消除激活期硬失败。

**与已发布契约的核对依据**：派生结果与 0.1.1 实际发布的
`~/.dsh/profiles/node_modules/@deepseek-ai/dsh-ai-coding-platform/lib/typert.remote-client.d.ts`
逐端点比对一致，例如
`profileEditContext: (profileId: string) => Promise<RemoteResult<WorkspaceQueryResult<ProfileEditContext>>>`。

---

## D9 — 会话事件读取 API

**旧行为**：`session.events` 是属性，返回 `readonly SessionEvent[]`。
**新基线行为**：`Session` **没有** `events` 属性；等价物是方法
`ownEvents(): readonly SessionEvent[]`（另有 `eventAt(seq)`、`deriveMessages()`、
`endSeq`、`firstLiveSeq`）。

**证据**：`node_modules/@deepseek-ai/dsh-session/lib/types/index.d.ts:192`。
**修复**：`src/context-ledger.ts`、`src/knowledge-loop.ts`、`src/memory-loop.ts` 共 4 处，
`tests/**` 22 处，全部改为 `session.ownEvents()`。
**症状对照**：改前 22 个测试报 `Cannot read properties of undefined (reading
'some'/'filter'/'find')`、`session.events is not iterable`。

---

## D10 — `SessionEventMap` 由开放变封闭

**旧行为**：`SessionEvent<T>` 与 `Session.append(type, data)` 接受任意字符串类型，
插件可以随手发明持久事件类型。

**新基线行为**：0.1.5 把事件词汇表封进 `SessionEventMap`，并以此为约束
（`SessionEvent<T extends keyof SessionEventMap>`、
`Session.append<T extends keyof SessionEventMap>`）。自持事件的插件**必须合并该表**，
第一方包全部通过 `declare module '@deepseek-ai/dsh-session/types'` 做这件事。

**证据**：`@deepseek-ai/dsh-agent/lib/types/types.d.ts:74`、
`@deepseek-ai/dsh-compaction/lib/types/types.d.ts:15` 等 12 处同形合并。
**修复**：新增 `src/session-events.ts`，把本插件的两个持久事件
（`'context-ledger'` → `ContextLedger`、`'knowledge-search'` →
`TeamSkillKnowledgeSearchEventData`）登记进 `SessionEventMap`；
`src/knowledge-loop.ts` 的本地 `SessionEventData` 改为导出并重命名。

---

## D11 — 右侧栏几何 API

**旧行为**：`ILayout.reserveRight(px: number)` —— 浮层自己测量并上报像素宽度，`0` 表示撤销。
**新基线行为**：`openRightbar(track: boolean, fullscreen: boolean)` 与
`closeRightbar()` —— 框架自己拥有轨道宽度，占用方只报告**呈现方式**。

**证据**：`@deepseek-ai/dsh-client-ui-layout/lib/types/client/service.d.ts:47,50`。
**修复**：`src/client/PlatformSurface.tsx` 的 docked effect 改为
`openRightbar(true, false)` / `closeRightbar()`；原先仅为测量宽度而存在的
`ResizeObserver` 随之删除（已确认 `src/**` 中不再有 `ResizeObserver`）。
**测试同改**：9 处 mock `layout` 由 `reserveRight: vi.fn()` 换成
`openRightbar`/`closeRightbar`，并重写 docked 断言。

---

## D12 — 会话创建的归属

**旧行为**：`ctx.workspaces.startSession()` —— 会话创建挂在 workspace 注册表上。
**新基线行为**：客户端 `IWorkspaces` **没有** `startSession`；会话创建属于会话层，
客户端面为 `ISessions.create(opts?)`。

**证据**：`@deepseek-ai/dsh-api-workspace-controller/lib/types/client/service.d.ts:27`、
`@deepseek-ai/dsh-api-session-controller/lib/types/client/contract/sessions.d.ts`。
**修复**：`src/client/index.ts` 的 `startSession` 改调 `ISessions.create()`；
`tests/plugin-registration.client.spec.ts` 的假 context 改为在 `sessions` 上计数。

---

## D13 — 槽位标准 props 的贡献方

**旧行为**：`useSessions` / `useWorkspaces` 由客户端运行时统一提供。
**新基线行为**：二者由具体 UI 包声明合并进槽位框架的
`GlobalStandardProps` —— `useSessions` 来自 `dsh-client-ui-session/client`，
`useWorkspaces` 来自 `dsh-client-ui-workspace/client`（`dsh-client-ui-conversation`
另有一份同名贡献）。未引入这两个包时，浮层组件的 props 里根本没有这两个键，报
`Property 'useSessions' does not exist on type …`。

**修复**：两者补为 devDeps 并 type-only 引入；`dsh-client-ui-session` 同时补进
`package.json` 的 `dsh.client.inject`。

---

## D14 — `ctx.slots` 的声明方

**旧行为**：客户端运行时直接给 `Context` 挂 `slots`。
**新基线行为**：`declare module '@deepseek-ai/cordis'` 里的
`slots: SlotRegistry` 由 `@deepseek-ai/dsh-client-ui-renderer/client` 声明
（`lib/types/client/index.d.ts:26`）。不引入该包就报
`Property 'slots' does not exist on type 'Context'`。

**修复**：`src/client/index.ts` 补 `import type {} from
'@deepseek-ai/dsh-client-ui-renderer/client'`，并把该包补为 devDep。

---

## D15 — `@types/node` 未进入程序

**旧行为**：monorepo 的 tsconfig 显式列了 node 类型。
**新基线行为**：本仓 `tsconfig.base.json` 未声明 `types`，20 处
`node:crypto` 等报 `TS2591`、3 处 `NodeJS` 报 `TS2503`。

**修复**：`tsconfig.base.json` 加 `"types": ["node"]`（`@types/node` 本就是 devDep）。

---

## D16 — `MarkdownText.labels` 变必填

**旧行为**：`<MarkdownText text={…} />`，围栏/脚注文案由原语内部默认。
**新基线行为**：`labels: MarkdownLabels`（`{ code: { copyLabel, copiedLabel },
footnotes }`）为**必填**。

**证据**：`dsh-client-ui-primitives/lib/types/markdown/MarkdownText.d.ts:38`。
**修复**：`CloudWorkspacesView.tsx` 增加模块级 `MARKDOWN_LABELS` 常量并传入。
**常量放在模块级是有意的**：该原语文档明确「新的对象身份会丢弃流式渲染缓存」，
故必须引用稳定；文案沿用本浮层既有的中文优先措辞。

---

## D17 — 遥测采集模式参数形态

**旧行为**：`new SessionTelemetryCoordinator(ctx, backend, 'live')`。
**新基线行为**：第三参数为 `SessionTelemetryCaptureOptions`
（`{ capture?: 'live' | 'on-demand'; includeHistory?: boolean }`）。

**证据**：`dsh-session-telemetry/lib/types/coordinator.d.ts:22`。
**修复**：`src/telemetry/backend.ts` 改为 `{ capture: 'live' }`，语义不变。

---

## D18 — ⚠️ `RemoteErrorCode` 是封闭词汇表

**旧行为**：`RemoteResult.error.code` 是普通字符串，可直接与服务域错误码比较。
**新基线行为**：`RemoteFailure` 的 `code` 收窄为合并扩展的 `RemoteErrorCode`；
平台文档说明「每个 owner 在自己的抛出点旁合并自己的域错误码」。

**保留原因**：`src/client/PlatformSurface.tsx` 比较的 `'PROJECT_NOT_MEMBER'` /
`'RESOURCE_NOT_FOUND'` 是 **Team Skill 服务**发出的码，不是本插件抛出的码；
把它们登记进 `RemoteErrorDetailsMap` 等于宣称所有权，而该运行时契约尚未核实。

**采用的最小修复**：把比较对象窄化为 `const failureCode: string = result.error.code`，
**比较本身一字未改**，只放宽其静态定义域。
**待办**：核实网关是否以 `RemoteError` 抛出这些码；若是，应改为合并
`RemoteErrorDetailsMap`。

---

## D19 — `dsh-client-modules/client` 不再转发 `optionalStringArray`

**旧行为**：构建预设从 `@deepseek-ai/dsh-client-modules/client` 导入
`optionalStringArray`。
**新基线行为**：该函数仍在包内，但 `./client` 入口只转发
`parseBootManifest` / `stripClientSuffix`，已无公开子路径可达。

**证据**：`dsh-client-modules/lib/types/client/index.d.ts:17` 与
`lib/types/client/manifest.d.ts:128`（函数存在但未导出）。
**修复**：`build/tsdown.client.ts` 内联等价实现，**含逐字相同的抛错文案**
（`client-modules: <subject> <field> must be a string array`）。

---

## D20 — TypeScript 6 要求显式 `rootDir`

**旧行为**：TS 5 可从 `include` 推断公共源目录。
**新基线行为**：TS 6 报
`TS5011: The common source directory of 'tsconfig.json' is './src'. The 'rootDir'
setting must be explicitly set`。

**修复**：`tsconfig.json` 加 `"rootDir": "src"`。

---

## D21 — 单包身份改名（门禁 3）

**旧行为**：`dsh-ai-coding-platform`（host 半边）+
`dsh-client-ui-ai-coding-platform`（客户端半边），两个包名。
**新基线行为**：合并为单包 `dsh-ai-coding`，双半通过 `exports` 子路径区分。

**改名范围（仅门禁 3 点名的三处）**：
1. `cordis.patch.yml` 行名 → `dsh-ai-coding` 与 `dsh-ai-coding/workspace`；
2. invariant 注册名 → `src/invariant.ts` 的 `name = 'dsh-ai-coding-invariant'`、
   `PACKAGE_NAME = 'dsh-ai-coding'`；
3. 客户端 inject → `package.json` 的 `dsh.client.inject`。

**复核提示：门禁 3 写的是「`cordis.patch.yml` 三行」，本仓实际是两行（两行都是改名后的
新名），这是实测约束不是遗漏**。挂载机制核实结论（完整证据见
`docs/mount-mechanics-notes.md`）：
- 行集必须是「一个**裸包名**行 + 一个 host-only 子路径行」这一对。裸名行是**唯一**能注册
  浏览器包的行（浏览器 roster 只从 name 恰为包说明符的行读取 `dsh.client`）；
- 再加第二个裸名行会**致命**：`client-modules: package dsh-ai-coding resolves from multiple
  active Loader sources: …; remove one entry`；
- 旧的 `ui-ai-coding-platform` 行必须删除，否则 `assertEntriesLoaded` 直接中止启动。
所以「三行」若按字面理解会装不起来；这里按「三处改名点」执行并已挂载验证通过
（门禁 4 的 7 次绿跑即为此约束的实证）。

**刻意不改（持久化身份，改了会动产品语义，违反门禁 6）**：
`credentialKey('dsh-ai-coding-platform', 'account')`（`src/host.ts:51`、
`src/workspace-gateway.ts:142`）；`source: { kind: 'plugin', plugin:
'@deepseek-ai/dsh-ai-coding-platform', form: 'recall' }`（`src/knowledge-loop.ts:129`、
`src/memory-loop.ts:110`）。断言这些字面量的测试保持原样并通过。

---

## D22 — ⛔ 双半插件无法在单一 TS 程序中正确类型化

**旧行为**：上游用 `tsconfig.host.json` + `tsconfig.client.json` 两个程序分别持有
host / client 两侧的服务声明。

**新基线行为**（本仓现状）：单一根程序同时包含两半，于是同一个 cordis `Context`
键被两侧各声明一次，声明合并只留其一：

| 键 | host 声明 | client 声明 | 本仓实际生效 |
|----|-----------|-------------|--------------|
| `sessions` | `@deepseek-ai/dsh-session` → `SessionStore` | `@deepseek-ai/dsh-api-session-controller/client` → `ISessions` | **host** |
| `workspaces` | `@deepseek-ai/dsh-workspace` → 主机 `IWorkspaces` | `@deepseek-ai/dsh-api-workspace-controller/client` → 客户端 `IWorkspaces` | **host** |

**症状**：`Property 'open' does not exist on type 'SessionStore'`
（而浏览器里运行时值确实是客户端 `ISessions`）。

**当前处置**：`src/client/index.ts` 在唯一一处跨界点上做一次具名窄化
（`ClientSessionFace`），并在注释里写清成因；所窄化的成员逐一读自已发布的客户端契约
（`ISessions.open(id: SessionId): void`、`ISessions.create(opts?)`），不是猜测。

**建议**：按上游做法拆 `tsconfig.host.json` / `tsconfig.client.json`。
这同时是 D8 里 typert 生成器唯一期望的布局。

---

## 附：未纳入台账的两项观察

1. `dsh-client-ui-primitives` 的构建产物缺 `index.js.map`，Vite 打
   `Failed to load source map … ENOENT` —— 上游发布物缺文件，非本仓问题，仅噪音。
2. `pnpm-workspace.yaml` 的 `allowBuilds: { esbuild: true }` 在 vitest 改用 `oxc`
   之后已无必要；保留不影响正确性。
