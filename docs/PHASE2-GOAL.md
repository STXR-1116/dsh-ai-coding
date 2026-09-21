# 二期适配：真机挂载修复与收尾（P0–P2）

前置事实（一期收尾时实测，2026-09-20）：插件已能构建（双半产物 19 导出 + 闭包包络）、
159 文件/1413 用例全绿、单包身份改名完成、`dsh plugin add` 后 bundle 进入 profile。
**遗留的 P0 缺陷**：真机浏览器报
`dsh-ai-coding: pending (waiting for services: remote.teamSkills, remote.cloudWorkspaces)`。

## P0-1 · 浏览器侧 remote 服务表为空（挂载缺陷根因）

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

## /goal（派发文本）

```
/goal 完成 dsh-ai-coding 插件的二期适配（本地 C:\Users\13588\dev\dsh-ai-coding，
先读 README.md、docs/ADAPTATION-GOAL.md、docs/PHASE2-GOAL.md）。需求源即
PHASE2-GOAL.md，按优先级：

P0-1 浏览器侧 remote 服务表为空的挂载缺陷：对照随 @deepseek-ai/dsh@0.1.5-rc.2
安装的 typert-protocol/api-gateway/api-remotes/api-workspace-controller 源码，
确认「宿主服务→浏览器 remote 投影」的 0.1.5 暴露契约，修 src/ 网关 apply() 使
remote.teamSkills 与 remote.cloudWorkspaces 进入浏览器投影表；mount-smoke 补
浏览器侧断言（boot 后两服务可注入 + 工作台渲染 fixture 种子 ws-alpha-1），冒烟
注入全套 DSH_* 变量并断言缺变量时 fail loud。
P0-2 环境变量契约 fail-loud（apiBaseUrl 缺失时启动期报错或提供 settings 面替代）
+ README 精确 env 集 + ADAPTATION-GOAL 补三条一期教训（--patch 顶层数组；安装器
自动应用包内 patch、profile 重述即 duplicate id；缺 env 表现为浏览器 pending）。
P1-1 核实 dsh plugin 子命令 0.1.5 用法，README 安装节用可用通路，提供
scripts/install-to-profile.mjs 一键脚本；记录 profile patch 不可重述插件行。
P1-2 CI：push/PR 跑 install+build+typecheck+test；每周探测 @deepseek-ai/* 新版
自动开基线 bump PR，PR 跑挂载冒烟。
P2 按序清：D18 用已发布协议字面联合类型替换窄化比较；D22 拆双 face tsconfig；
排查 /plugins/??包名/client.js 的 ?? 形状；定位 worker 丢失根因；
invariant 注册名补台账或改名；README/ROADMAP 时效整理。

验收（所有者复核标准，缺一打回）：真机 chromium 打开 dsh web，侧边栏 AI Coding
入口 → 云工作空间工作台渲染 fixture 种子 ws-alpha-1、知识库渲染 k-1；挂载冒烟
连续 3 次全绿且含浏览器侧服务注入断言；typecheck 0；pnpm test 全绿 skipped=0
（基础设施失败分级重试、红跑留档）；漂移台账与本文逐项打勾；不发布 npm、不改
产品语义、git 干净并推送。

我允许你不受任何限制地决定顺序与并行，但你要对质量负责。整体结论在真机面板
渲染验收通过前维持「未完成」。
```


### P0-1 追加勘误（二次核对轮，2026-09-21）

追加段的两个结论被本轮复核证伪/修正：①`experimentalDecorators` 假设作废——协议
`Remote` 装饰器是 TS5 标准装饰器原生写法（`context.addInitializer`，构造实例时逐实例
把 marker 附到原型），不需要 legacy 语义；②「两侧描述符计数均为 0」的探针方法无效——
伪原型（Object.create）不触发构造，initializer 从未运行，对旧仓同样得 0 恰好证明探针
失真，不能作为「注册表为空」的证据。真正未解的问题收窄为：**浏览器侧 `remote.<ns>`
服务的提供者是谁**。实测：`dsh-api-remotes` client.js 无 fetch、无 remote.* 提供点；
`dsh-api-workspace-controller` client.js 含 "workspaces"/"remote.workspace" 字符串——
说明 controller 形态条目按命名空间提供 `remote.<ns>`。下一步：在 monorepo web-app
bundle patch 的浏览器 roster 里找到提供 `remote.teamSkills`/`remote.cloudWorkspaces`
的对应条目（或确认其由 api-remotes 按宿主 typert 注册清单动态构建），再对照本仓安装
形态补齐缺失的浏览器条目/清单注入。