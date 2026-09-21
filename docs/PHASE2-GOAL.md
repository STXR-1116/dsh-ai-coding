# 二期适配：真机挂载修复与收尾（P0–P2）

前置事实（一期收尾时实测，2026-09-20）：插件已能构建（双半产物 19 导出 + 闭包包络）、
159 文件/1413 用例全绿、单包身份改名完成、`dsh plugin add` 后 bundle 进入 profile。
**遗留的 P0 缺陷**：真机浏览器报
`dsh-ai-coding: pending (waiting for services: remote.teamSkills, remote.cloudWorkspaces)`。

## P0-1 · 浏览器侧 remote 服务表为空（挂载缺陷根因）

### P0-1 修订（严格按官方教程，2026-09-21，**本节优先于下方全部旧路径**）

官方 develop/ 教程 18 页完整阅读后（docs/official-tutorial-notes.md），P0-1 的
修复不再走两条非官方路径（typert staging 生成器 / api-remotes 组装逆向），改为
**只用官方文档化的机制**：

1. **浏览器 fragment 导出 Config（Schemastery）**：`apiBaseUrl`（required）、
   `accessToken`、`authMode`——官方配置章机制：cordis.patch.yml 行的 `config`
   块经 `!!js process.env.*` 注入部署值（env 在 node 侧组合期读取，值随组合
   下发浏览器 runner）；`apiBaseUrl` 用 `.required()` 使缺失 env 时**加载期
   响亮失败**（官方：错误配置要响亮），同时满足 P0-2。
2. **浏览器半自提供 `remote` 服务（官方 Service 模式）**：`@deepseek-ai/cordis`
   在浏览器种子表中（PLATFORM_MODULES），Service 子类在浏览器上下文同样合法。
   新增浏览器安全的 remote 客户端层：基于 `src/workspace-http.ts`（0 个 node
   依赖，已验证）构造 HTTP 客户端，按宿主网关同形的方法面实现
   `remote.teamSkills` / `remote.cloudWorkspaces` 两组方法（写操作带
   `idempotency-key: crypto.randomUUID()`，createRun 复刻 `if-match`），envelope
   解包为 `{kind:'ready', value}` 形状供组件 `READY()` 消费；本插件 apply() 将
   其提供为 `remote` / `remote.teamSkills` / `remote.cloudWorkspaces` 服务。
3. **inject 修正**：浏览器 fragment 的 inject 移除 `remote`、`remote.teamSkills`、
   `remote.cloudWorkspaces`（自提供者不得等待自己），保留 locale/slots/sessions/
   workspaces/layout（shell 提供）。PENDING 随之消失（不再等待无人提供的服务）。
4. **约束承认**：typert strict 编解码、api-remotes 组装、`$mount` 扩展点均为
   官方未文档化的内部机制，独立插件不依赖它们（台账 D18/D22 相应降级为备忘）；
   代价是浏览器侧跳过 strict 校验（fixture 侧仍有服务端校验），SSE 经
   `streamState`/`streamEventsAfter` 轮询面等价覆盖。
5. **验收不变**：真机 chromium 渲染 ws-alpha-1 / k-1；冒烟 3 连绿含浏览器侧
   断言；typecheck 0；测试全绿。

### P0-1 原始调查（已被上方修订取代，留档）

### P0-1 追加（二期执行时实测，根因收窄）

探针实测（`remoteMethods(Object.create(cls.prototype))`，对照已发布 typert-protocol）：
**本仓与 monorepo 旧网关编译产物的原型上 remote-methods 描述符计数均为 0**——即
`remoteMethods()` 一无所获，网关的 claims 集合为空 → 浏览器投影表没有我们的命名空间。
结合一期笔记（typert-wiring-notes.md）已知：描述符是 `REMOTE_METHOD_DESCRIPTOR`
own-property、附着在原型上，附着者是 `@Remote` 装饰器；且 0.1.5 网关对浏览器半的
typed surface 要求 **strict codec（registry 主路径）**，`dsh-api-gateway/lib/client.js`
无 SRC 发现。**因此 SRC 兜底只覆盖宿主侧请求分发，不覆盖浏览器注册清单——
「不生成 typert 面」的一期结论（typert-wiring-notes §2.9）对宿主分发成立、对浏览器
挂载不成立**。二期 §2.8 的 staging 生成配方（stage packages 骗过 analyzer 的三个
硬假设 + `WorkspaceTypertGenerator` 产四件套）是已知的生成通路，卡在 run#5 的
TS checker 崩溃（`getSymbolLinks`），需按其 unknowns 段的 staging 方案收尾。

**下一步（按序）**：
1. 检查我们编译后 `lib/index.js` 里 `@Remote` 装饰器的附着代码形态（本仓 tsconfig
   未开 `experimentalDecorators`，TS5 标准装饰器语义 vs 协议装饰器的书写签名）；
   用真实实例（live boot 后从 `ctx.reflect.props` 取）而非 fake 原型重跑探针。
2. 若附着确实缺失：优先试验 tsconfig 开 `experimentalDecorators`（+ 视情况
   `emitDecoratorMetadata`）重编译再探针；仍不行则走 §2.8 staging 生成配方，
   解决 run#5 的 checker 崩溃（单副本 staging：用 compilerOptions.paths 把协议
   映射到 staged 副本）。
3. 生成/注册成功判据：`remoteMethods(真实实例)` ≥ 85；真机浏览器 pending 消失。

**证据链**（已实测）：服务器启动 0 报错、宿主两行（`dsh-ai-coding`、`dsh-ai-coding/workspace`）
已激活；带令牌页面下发的 `__DSH_BOOT__` 图里插件条目的 inject 链正确
（api-remotes / api-workspace-controller / locale / runtime / ui-layout / ui-sidebar /
ui-renderer / ui-session / ui-workspace / api-session-controller）；
但**整页 0 次出现 `remote.teamSkills` / `remote.cloudWorkspaces`**，且带齐
`DSH_*` 环境变量后依旧 pending——排除漏配 env，定位到**宿主半在 npm 0.1.5-rc.2
基线上的 typert/remote 注册面位移**：网关从宿主 typert 注册表导出浏览器投影的
调用形态变了（对应台账 D18/D22）。

**修复计划**：
1. 读 `@deepseek-ai/dsh-typert-protocol@0.1.0-rc.6` 与随 `@deepseek-ai/dsh@0.1.5-rc.2`
   安装的 `@deepseek-ai/dsh-api-gateway` / `@deepseek-ai/dsh-api-remotes` /
   `@deepseek-ai/dsh-api-workspace-controller` 源码，确认 0.1.5 的「宿主服务 →
   浏览器 remote 投影」暴露契约（注册 API、服务键命名、投影清单的挂载时机）。
2. 修 `src/` 网关 apply()：使 `remote.teamSkills`（主行）与
   `remote.cloudWorkspaces`（/workspace 行）进入网关的浏览器投影表。
3. `build/mount-smoke.mjs` **补浏览器侧断言**（一期冒烟的盲点）：真实页面 boot 后
   `page.evaluate` 断言两服务可注入、且工作台面板对 fixture 渲染出种子行
   （ws-alpha-1）；冒烟必须注入全套 `DSH_*` 环境变量并断言"缺变量时报错 fail loud"
   而非静默 pending。
4. 验收：真机 chromium 打开 `dsh web`，侧边栏 AI Coding 入口 → 工作台面板渲染
   fixture 种子（ws-alpha-1 / k-1 发布流程）；连续 3 次冒烟全绿；红/绿双日志留档。

## P0-2 · 环境变量契约的 fail-loud 与文档

一期两次误诊都源于「缺 `DSH_*` 变量时宿主半静默降级」。修复：
1. 宿主半对 `apiBaseUrl === undefined` 时**启动期抛出**带修复指引的错误
   （配置属部署错误，按仓库惯例 fail loud），或提供 settings 面替代配置
   （apiKeyEnv 同款机制），二选一并在 README 写明。
2. README 安装节列出精确 env 集：`DSH_AI_CODING_PLATFORM_API_URL`、
   `DSH_CLOUD_WORKSPACE_API_URL`、`DSH_CLOUD_WORKSPACE_AUTH_MODE`、
   `DSH_CLOUD_WORKSPACE_ACCESS_TOKEN`。
3. `docs/ADAPTATION-GOAL.md` 补三条一期教训：`--patch` 覆盖层是顶层数组；
   安装器会自动应用包内 `cordis.patch.yml`（profile patch 里重述 = duplicate
   loader entry id）；宿主行缺 env 时浏览器半表现为 pending 而非启动失败。

## P1-1 · 安装程序化与 README 安装节重写

实测 `dsh plugin --profile web add <本地目录>` 的 CLI 形状未走通（被 pnpm help
吞掉），已验证的通路是 `pnpm pack` → profile `package.json` 加 `file:` 依赖 +
`dsh.profile.bundles` 加包名 → `pnpm install`。修复：
1. 核实 `dsh plugin` 子命令在 0.1.5 的正确用法（`dsh plugin --help` 直查）；
   若 CLI 可用，README 用 CLI 版；不可用则提供 `scripts/install-to-profile.mjs`
   （pack → 改 profile package.json → install → 校验 bundles）一键脚本。
2. README 记录 profile patch 不可重述插件行（duplicate id）。

## P1-2 · CI 钉版门禁（ROADMAP-5，未开工）

`.github/workflows/ci.yml`：push/PR 跑 install+build+typecheck+test；
**每周**任务探测 `@deepseek-ai/*` 新版本 → 自动开「基线 bump」PR → PR 上跑
install+build+挂载冒烟 → 绿则可合并发版。基线段写进 `dsh.plugin.json` engines
与 peerDependencies。

## P2（非阻塞，按序清）

- **D18**：RemoteErrorCode 封闭词汇表——改为从已发布协议包导入的字面联合类型，
  替换窄化比较兜底。
- **D22**：拆 `tsconfig.host.json` / `tsconfig.client.json` 双 face（对齐
  monorepo 编译面惯例），消除单程序类型化双半的含混。
- **`/plugins/??dsh-ai-coding/client.js` 的 `??`**：实机可用但形迹可疑（scope 段
  空替换？）。确认服务端 URL 模板对无 scope 包名的预期形状，并在换 scope/发布
  npm 前确认不破。
- **worker 丢失根因**：约半数运行丢 1 个 worker（0 断言失败）。在
  fileParallelism:false 下采一次堆/事件 tracing 定位；属基础设施，不改产品。
- **`src/client-node/invariant.ts` 注册名**：保留旧两包名（invariants 服务按
  字符串注册所有权）——在台账补「保留理由」或改名，二选一，不留无记录状态。
- **README/ROADMAP 时效**：一期已完成项从 ROADMAP 挪入完成清单，避免误导。

## 纪律（不变）

RED 先行、红绿双日志、skipped=0、不发布 npm、不改产品语义；每完成一项在
本文打勾并提交推送；`pnpm test` 允许对基础设施失败（worker 丢失，0 断言失败）
重试，任何断言失败立即非零；重试用例的原始红跑留档。

---

## /goal（派发文本 · 二期修订版，严格按官方教程）

```
/goal 完成 dsh-ai-coding 插件的二期适配（本地 C:/Users/13588/dev/dsh-ai-coding）。
需求源：docs/PHASE2-GOAL.md 的「P0-1 修订（严格按官方教程）」节 + 官方教程
https://deepseek-harness.github.io/deepseek-harness/develop/ 全部 18 页（笔记在
docs/official-tutorial-notes.md）。只使用官方文档化机制：

1. 浏览器 fragment 导出 Schemastery Config（apiBaseUrl required / accessToken /
   authMode），cordis.patch.yml 行以 !!js process.env.* 注入部署值；apiBaseUrl
   缺失时加载期响亮失败（即 P0-2）。
2. 新增浏览器安全 remote 客户端层（基于 0 node 依赖的 src/workspace-http.ts），
   按宿主网关同形方法面实现 remote.teamSkills / remote.cloudWorkspaces（写操作
   带 idempotency-key: crypto.randomUUID()，createRun 复刻 if-match），envelope
   解包为 {kind:'ready', value}；本插件 apply() 将其提供为 remote /
   remote.teamSkills / remote.cloudWorkspaces 服务（官方 Service 模式，
   @deepseek-ai/cordis 在浏览器种子表中）。
3. 浏览器 fragment inject 移除 remote 三键（自提供者不等待自己），PENDING 消失。
4. 不依赖任何未文档化内部机制：不做 typert staging 生成器、不改 api-remotes
   组装、不用 $mount 扩展点（全部降级为备忘，见台账 D18/D22）。
5. mount-smoke 补真机断言：无 pending 横幅、工作台渲染 fixture 种子 ws-alpha-1、
   知识库渲染 k-1；连续 3 次全绿，红/绿双日志留档；冒烟注入全套 DSH_* 变量并
   断言缺变量时加载期响亮失败。
6. README 精确 env 集 + 官方安装通路（dsh plugin --profile web add）；
   ADAPTATION-GOAL 补三条一期教训；CI（push/PR 全量 + 每周基线 bump PR）；
   P2 按序清（D18/D22 降级备忘、?? 形状、worker 丢失、invariant 名、时效整理）。

验收（所有者复核，缺一打回）：真机 chromium 打开 dsh web → 侧边栏 AI Coding 入口
→ 工作台渲染 ws-alpha-1、知识库渲染 k-1；typecheck 0；pnpm test 全绿 skipped=0
（基础设施失败分级重试、红跑留档）；不发布 npm、不改产品语义、git 干净并推送。

我允许你不受任何限制地决定顺序与并行，但你要对质量负责。整体结论在真机面板
渲染验收通过前维持「未完成」。
```
