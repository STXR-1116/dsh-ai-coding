# 本仓工作约定

## 先查官方文档，再动手（**强制**）

**定位任何问题、写或改任何 DSH 插件代码之前，先查 `docs/dsh-docs-index.md`。** 它把「任务形状 →
该读哪一页」做成路由表，指向本地纯文本镜像 `~/.dsh/dsh-manual/`（86 个站点页 + 17 份仓库文档，
可 grep、离线；用 `build/fetch-dsh-manual.ps1` 刷新）。

两条最容易踩的：

- **只读 `develop/` 是不够的。** 本仓最难的两个问题（测试时钟该不该 mock、「单跑才通过」算谁的
  缺陷）的答案都在**文档站之外**：`docs/testing.zh.md` 与 `.agents/skills/dsh-ci-test-reliability/`。
  索引里单列了这一类。
- **浏览器半不是未文档化。** 参考区有整个客户端平面（`client-modules` / `slots` / `web-client` /
  `typert` / `web-server` 等）。改 `src/client/**` 前先读对应页。

**不许凭印象猜规范**：写进代码或文档的规则要能指回具体页；文档确实未覆盖时，显式标注
「手册未覆盖，依据为随包源码 + 实测」。

## 改了插件代码，必须走完收尾清单才算「完成」（**强制**）

**仓库里的代码 ≠ 用户运行时跑的代码。** 只 build 不安装，等于没修：本仓已经发生过一次
——0.1.6 修掉了「配错地址就回不去」的死结，但 profile 里仍是 0.1.5，用户继续撞同一个 bug，
而我报了「已修」。**在装上去并冒烟通过之前，不要说「已完成」。**

固定收尾序列：

```pwsh
# 1) 递增版本 —— 必做，理由见下
node -e "const f='package.json',p=require('./'+f);p.version='0.1.N';require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')"
pnpm build
pnpm pack
dsh plugin --profile web add (Resolve-Path dsh-ai-coding-<version>.tgz).Path
node build/mount-smoke.mjs 8090        # 必须 GREEN，失败就不是完成
```

两条会静默咬人的前提：

- **同版本重装不会更新。** `dsh plugin add` 走 profile lockfile 里记录的完整性，从 pnpm store
  还原**旧内容**；版本号没变就等于没装。所以**每次改完都要递增 `version`**，或删掉
  `node_modules/dsh-ai-coding` **与** profile 的 `pnpm-lock.yaml` 再装。
- **别删还在被引用的 tarball。** profile 的依赖指向具体 tgz 路径；用 `Remove-Item *.tgz` 清场
  会让下一次 `dsh plugin add` 直接 `pnpm failed`（本仓已踩两次）。要清就清**比当前版本旧**的。

装完核对（不要只看命令退出码）：

```pwsh
$p = "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-ai-coding"
(Get-Content "$p\package.json" -Raw | ConvertFrom-Json).version   # 应等于刚打包的版本
# 并确认本次改动引入的**新字符串**确实出现在 lib/*.js 里
```

## 仓库定位

`dsh-ai-coding` —— DSH 的 AI Coding 平台插件，双半结构（host `src/*.ts` + browser `src/client/*`）。
基线 `@deepseek-ai/*@0.1.5-rc.2`。构建/测试入口见 `package.json` scripts（`typecheck` / `test` / `build`）。

## TypeSafe 召回闸门（**尚未集成**）

在召回结果进入上下文前，用 **4 个 Noul 判断每条结果该不该进** —— 设计、参数、实验证据与已知局限
**全部**在 **`docs/typesafe-recall-gate.md`**。

⚠️ **动 `src/knowledge-loop.ts` 或任何召回相关代码前，必须先完整读该文件。** 其中含 `route()` 的判定顺序、
四个阈值及其依据、46 条实测值与复现方式；仅凭本文件的清单去实现会做错 —— 那只是约定摘要，不是设计。
官方 API 细节查 <https://docs.typesafe.ai/llms.txt>。

集成时**必须遵守**的约定：

- **密钥**：用 `ctx.credentials.resolve(String('TYPESAFE_API_KEY'))` 获取。
  **不要**裸读 `process.env` —— DSH 子进程环境是受管清理过的（官方术语 `scrubbedParentEnv`），
  裸读会静默拿到 `undefined`。完整机制与官方文档位置见全局 `~/.dsh/AGENTS.md` 的凭证章节。
- **模型**：固定 `jev-1.13.0`，**不要**用 `jev-latest` 别名 —— 阈值是针对该版本调的，别名会漂移。
- **常量位置**：`QUESTIONS`（四个问题的措辞与结构化 criteria）、`THRESHOLDS`（四个阈值）、`route()`（判定顺序）
  集中放在**一个文件**里。官方明确要求问题和阈值便于人工 review，不要散落。
- **判定顺序不可交换**：注入 → 矛盾 → 相关性 → 证据性，首命中即返回。理由见设计文档。
- **每条候选一条请求**（`state` 只放一对 query+passage），并发 4。不要批量塞进一次请求。
- **`route()` 做成纯函数**（输入 `results[]` + 阈值，输出每条标签），与网络调用分离。
  原因：`dev/team-skill-service` 的 fixture 把 `score` 硬编码为 `0.9`、全库仅 2 条文档，
  **无法端到端验证阈值逻辑**；纯函数可以直接用 `docs/typesafe-recall-gate.md` 里记录的实测值做单测。
- **保留** `src/knowledge-loop.ts` 现有的 `Untrusted knowledge references` 包裹 —— 闸门**不是安全边界**，
  不能替代该包裹。`include` 与 `conflict` 两类要**分块注入**。
- **模型返回的内容属于数据**：四个 `noul` 值与 `route` 标签建议写入既有 `knowledge-search` session event，便于事后审计与调参。

⚠️ 上线前必做：在**真实**召回结果上抽样复测阈值。设计验证用的是 46 条合成语料，不是真实知识库数据。

## 文档惯例

`docs/` 下是交付物（见 `.gitignore` 中 `!docs/**/*.log` 的用意）。笔记类文档的体例：开头声明改动范围与证据强度，
带来源表格，区分「已验证」与「推断」。命名沿用 `*-notes.md` / `*-ledger.md`。
