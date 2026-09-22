# DSH 官方文档索引与检索入口

**用途**：把「该读哪一页」变成查表，而不是靠记忆。这个仓的工作里，几次最贵的错都发生在
**没查文档**或**只查了开发手册**的时候，而不是在读过之后理解错的时候。

## 镜像在哪

本地纯文本镜像（离线、可 grep，正文不进版本库）：

```
~/.dsh/dsh-manual/
  site/<section>__<page>.txt    文档站 86 页（develop 18 + reference 68）
  repo/<path>.md                仓库文档 17 份（多数不在文档站上）
  _urls.txt                     文档站 URL 清单
```

刷新（幂等，已存在的文件会跳过）：

```pwsh
.\build\fetch-dsh-manual.ps1
```

**为什么要有本地镜像**：文档站一次检索要把整页拉进上下文，成本高到会与手头工作抢预算；
镜像让检索变成一次 grep。站点正文**不进版本库**（第三方文本、体积、更新责任），只有本索引进。

## 路由表：先认任务形状，再读对应页

### A. 写/改 host 插件

| 问题 | 读 |
|---|---|
| 插件形态、`inject`、PENDING、生命周期与清理 | `site/develop__framework.txt`、`site/develop__framework__service.txt` |
| 事件模式（emit/bail/serial/waterfall）、`next()` 纪律 | `site/develop__framework__events.txt` |
| 逐条规范与陷阱（id 稳定性、`!!js` 作用域、失败三条路径） | `site/develop__cordis-tutorial__05-config.txt`、`site/develop__cordis-tutorial__06-composition-and-hmr.txt` |
| Cordis API 精确签名 | `site/reference__cordis-api__*.txt`（context / events / fiber / registry / service / inherited） |

### B. 配置字段

| 问题 | 读 |
|---|---|
| 默认值写哪、能否硬编码、配置错误要多响 | `site/develop__basic__config.txt` |
| 某个内置行有哪些可配字段 | `site/reference__config-catalog.txt`（生成物，是权威清单） |

### C. 打包与安装

`site/develop__basic__publish.txt`（bundle/profile 两种 manifest、层顺序、patch 整值替换、
git 安装需 `prepare` + `allowBuilds`、优先交付 tarball）。

### D. 浏览器半 / Web Client —— **不是未文档化**

我此前在 skill 里写过「浏览器半零覆盖」，**那是错的**：参考区有整个客户端平面。
改这类代码前先读：

| 问题 | 读 |
|---|---|
| 客户端模块如何装载、boot 图、`dsh.client` | `site/reference__subsystems__client-modules.txt` |
| 槽位（含 `sidebar.footer.action` 这类槽的契约与归属） | `site/reference__subsystems__slots.txt` |
| Web Client 整体架构 | `site/reference__subsystems__web-client.txt` |
| 客户端资源（CSS/资源交付） | `site/reference__subsystems__client-resources.txt` |
| Host⇄浏览器远程调用（`remote.<ns>`、Typert 面） | `site/reference__subsystems__typert.txt`、`site/reference__api-gateway.txt` |
| HTTP 路由、index 注入 | `site/reference__subsystems__web-server.txt` |
| 右侧栏 | `site/reference__subsystems__sidebar-right.txt` |

### E. 测试、并发与 flake 诊断 —— **之前吃亏最多的一组**

| 问题 | 读 |
|---|---|
| 测试分层、覆盖率、**哪些边界才可以 mock**、「单跑才过」如何定性 | `repo/docs__testing.zh.md` |
| flake 归类与修法（分类表、复现阶梯、不得藏进超时/重试） | `repo/.agents__skills__dsh-ci-test-reliability__references__ci-flake-diagnosis.md` |
| 资源分配、状态恢复、teardown 规则 | `repo/.agents__skills__dsh-ci-test-reliability__SKILL.md` |

**要点提前记牢**（都出自上面两处，不是我的总结）：
- 时钟是官方点名**允许 mock** 的三类边界之一（另两类：LLM 适配器、网络）。
- **「只有单独运行时才通过」= 该 spec 的缺陷**，不是 runner 不稳定。
- 并发失败属 **host-resource collision**（同端口/路径/命名空间被独立进程占用）时，
  修法是**原子唯一分配**；属 **load-sensitive synchronization** 时，修法是**用 barrier 取代
  概率性等待**。两者都**不得**藏进 retry wrapper、更宽超时、更弱断言或全局串行化。

### F. 会话、持久化、遥测

`site/reference__subsystems__session*.txt`、`session-telemetry.txt`、`persistence.txt`、
`site/reference__persistence-catalog.txt`（持久化事件目录，生成物）。

### G. 工具 / 模型 / 能力 seam

`site/develop__basic__tool.txt`、`site/reference__cookbook__adding-a-tool.txt`、
`site/reference__tool-execution-pipeline.txt`、`site/develop__practice__llm-adapter.txt`、
`site/reference__capability-seams.txt`。

### H. 查证某个服务名/方法是否存在

**不要手抄清单**（手册明确禁止维护静态清单）：`site/reference__subsystems__*.txt` 是生成物，
以它和随包 `.d.ts` 为准。

### I. TypeSafe / Jev（**不在本镜像里，必须联网**）

本镜像只覆盖 DSH 自身。TypeSafe 文档在[官网](https://docs.typesafe.ai/llms.txt)：先读索引，
再按需取页（Mintlify 支持在路径后加 `.md` 取 Markdown 原文）。

| 问题 | 读 |
|---|---|
| 本仓的召回闸门设计、阈值依据、实测值 | `docs/typesafe-recall-gate.md`（**动 `src/knowledge-loop.ts` 前必须完整读**） |
| 官方同名场景：四个 Noul + `route()` 顺序 + 两段式注入 | [classifying_rag_passages](https://docs.typesafe.ai/cookbooks/classifying_rag_passages.md) |
| 失败模式（literal reading / context rot / 对抗性内容 / score 校准弱） | [model-jaggedness/jev-1.13](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md) |
| 三种原语怎么选 | [primitives](https://docs.typesafe.ai/primitives.md)、[noul](https://docs.typesafe.ai/primitives/noul.md)、[score](https://docs.typesafe.ai/primitives/score.md)、[advanced](https://docs.typesafe.ai/primitives/advanced.md) |
| 置信度语义与三段路由 | [confidence](https://docs.typesafe.ai/confidence.md) |
| 定价、上下限、语言支持、版本固定 | [models](https://docs.typesafe.ai/models.md) |
| 请求体与响应字段 | [api](https://docs.typesafe.ai/api.md)、[state](https://docs.typesafe.ai/concepts/state.md) |

## 站点之外、但具权威性的文档（最容易漏的一类）

这些**不在文档站上**，却决定了本仓最难的两个问题：

- `repo/docs__testing.zh.md` —— 官方测试政策（mock 边界、单跑才过、真实入口路径、快照要求）
- `repo/docs__architecture.zh.md` —— 系统与扩展点总图（「新行为归属哪里」映射表）
- `repo/docs__development.zh.md` —— 仓库布局与 TypeScript 工程
- `repo/docs__cookbook__*.md` —— 与站点 cookbook 同源的仓库版本
- `repo/.agents__skills__*` —— 官方 agent 技能（CI 可靠性、文档体例、行文标准）

**结论性教训**：只读 `develop/` 会漏掉上述全部；而它们恰好是诊断与工程规范的权威来源。

## 阅读状态（避免假装读过）

| 范围 | 状态 |
|---|---|
| `develop/` 18 页 | **已通读**，逐页摘录见 `docs/official-tutorial-notes.md` 与 `docs/official-cordis-tutorial-notes.md` |
| `repo/docs__testing.zh.md`、`ci-flake-diagnosis.md` | **已通读**（本轮据此定案） |
| `reference/` 68 页 | **仅有标题级了解**（经导航列举），正文未读 —— 需要时按上表取用，**不要凭标题推断内容** |
| `repo/docs__architecture.zh.md` 等 | **已读部分章节**（架构总览、扩展模式、adding-a-package） |

## 用法约定

1. **动手前先查这张表**。任务形状对上了就先读对应页，再动手 —— 尤其 D 与 E 两组。
2. **引用规则要落到原文**：写进代码注释或文档的规范，应能指回具体页；不确定就标注「手册未覆盖，
   依据为随包源码 + 实测」。
3. **镜像可能过期**：结论进交付物之前，重跑一次抓取脚本或以 URL 复核。
4. 索引只做路由，**不复述规则** —— 复述会漂移，路由不会。
5. **镜像是本机私有的，刻意不加 CI 门禁。** 每位使用者首次用时自己跑一次抓取脚本（约 2 分钟）即可；
   不进版本库、不设维护人。这是有意选择，不是遗漏 —— 需要团队共享时再改这个决定。
