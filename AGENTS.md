# 本仓工作约定

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
  **不要**裸读 `process.env`（见全局 `~/.dsh/AGENTS.md`，DSH 子进程不继承 host 环境，裸读会静默失败）。
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
