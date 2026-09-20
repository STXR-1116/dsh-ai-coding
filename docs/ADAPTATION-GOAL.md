# 适配执行计划（交接执行者）

需求源：本 README 的 ROADMAP。三件事的详细计划如下，文末为可直接派发的 /goal。

## 任务一：tsdown 双半构建调通

**目标**：`pnpm build` 产出 `lib/index.js`（host 半）与 `lib/client.js`（浏览器闭包包络）。

1. 移植 monorepo `packages/client/tsdown.client.ts` 预设为本仓 `tsdown.config.ts`：
   - `workspaceManifest()` 的 `packages/*/*/package.json` glob 改为读本仓 `package.json`；
   - `PLATFORM_MODULES`/`PRELOADED_CLIENT_EXTERNALS` 从 `build/platform-modules.ts` 导入（已迁）；
   - `clientBuildEnvironmentDefines` 从 harness `scripts/client-build-environment.ts`（311 行）内联——只保留本插件消费的键，逐键核对；
   - `optionalStringArray` 改从已发布的 `@deepseek-ai/dsh-client-modules/client` 导入。
2. 构建链：`tsc`（emit `lib/types`，JS+声明，`rewriteRelativeImportExtensions`）→ tsdown 从 `lib/types` 打双半。client 闭包包络 banner/footer/intro 三段与模块表 externals 规则（requested external 留 import、其余内联、`@deepseek-ai` 值导入纯度闸）必须原样保留。
3. CSS：`*.module.css`/`*.css?inline`/全局 CSS 三条 lightningcss 管线随预设走。
4. 验收：`node -e "import('./lib/index.js')"` 成功；`lib/client.js` 首行含 `window.__ModuleLoader__.load`。

## 任务二：测试移植

1. 先迁自包含面：`dev/team-skill-service/tests`（仅依赖 fflate+vitest）与 `dev/team-skill-admin/tests`。
2. 平台/客户端单测逐文件核对 import：依赖 harness `test-support`（如 `dsh-acp-snapshot`）的，查 npm 是否已发布；未发布的要么以 devDep git 依赖引入、要么把该测试留在 harness 仓并在本文登记豁免。
3. 浏览器 e2e（挂载冒烟）：build → `pnpm pack` → `dsh plugin --profile web add <tarball>` → 启动 web profile → Playwright 无头渲染断言（参照 better-sidebar 的 14 例冒烟与 harness `apps/web/tests/scaffold.ts` 的组合方式）。
4. 验收：`pnpm test` 全绿 skipped=0；冒烟套件红/绿双日志留档。

## 任务三：API 漂移适配（0.1.1-rc.2 → npm 基线）

1. `pnpm install && pnpm typecheck`——让 TS 枚举全部位移，逐项修复；每修一类在本文打勾。
2. 重点核对面（better-sidebar 漂移清单中与我们相关的）：credentials/一次性 token 鉴权、session 投影与 `SessionEventMap`、telemetry 上报契约、typert 协议版本、workspace 实体形状。
3. 单包身份改名（全部改完后一次提交）：`cordis.patch.yml` 两行 name、`src/client-node/invariant.ts` 的 invariants 注册名、client inject 旧名引用——先对照已发布 invariants/registry 契约再改。
4. 验收：挂载冒烟全绿 + fixture 全部用例绿 + `dsh plugin --profile web add` 后真实 `dsh web` 可见工作台。

## 纪律

RED 先行、红绿双日志、skipped=0、不改产品语义、不推送 npm（GitHub 源码通道）；每完成一任务在本文件打勾并提交。

---

## /goal（派发文本）

```
/goal 继续完成 https://github.com/STXR-1116/dsh-ai-coding 插件仓的适配三任务（本地
C:\Users\13588\dev\dsh-ai-coding，先读 README.md 与 docs/ADAPTATION-GOAL.md）。需求源即
ADAPTATION-GOAL.md：①tsdown 双半构建调通（host lib/index.js + 浏览器闭包 lib/client.js，
纯度闸与 CSS 管线原样保留）；②测试移植（fixture/admin 自包含面先行，harness test-support
依赖逐个查 npm 可得性，未发布则登记豁免；挂载冒烟 build→pack→dsh plugin add→无头渲染）；
③API 漂移适配（0.1.1-rc.2 → npm @deepseek-ai/* 基线：typecheck 枚举位移逐项修复，重点
credentials 鉴权/session 投影/telemetry 契约/typert 版本，最后单包身份改名一次提交）。

交付后由所有者复核，复核门禁（不满足即打回）：
1. 干净检出上 `pnpm install && pnpm build` 一次通过；lib/index.js 可 import，
   lib/client.js 首行为 window.__ModuleLoader__.load 闭包包络；纯度闸仍生效；
2. `pnpm test` 全绿 skipped=0；依赖 harness test-support 未迁的用例必须在
   ADAPTATION-GOAL.md 登记豁免理由与 npm 可得性核查结论；
3. 单包身份改名完整（cordis.patch.yml 三行、client-node/invariant 注册名、client inject），
   并注明与已发布契约的核对依据；
4. 挂载冒烟红/绿双日志留档，≥3 次绿方可宣布通过，不得以单次绿宣布稳定；
5. API 漂移台账逐项打勾，每个修复点注明「0.1.1-rc.2 旧行为 → 新基线行为」；
6. skipped=0、不发布 npm、不改产品语义、git status 干净、推送完成。

我允许你不受任何限制地决定顺序与并行，但你要对质量负责。整体结论在挂载冒烟全绿并
满足上述门禁前维持「未完成」。每完成一任务在 ADAPTATION-GOAL.md 打勾并提交推送。
```
