# 官方教程完整阅读笔记（2026-09-21）

来源：deepseek-harness.github.io/deepseek-harness/develop/ 全部 18 页
（basic×4、framework×3、practice×3、cordis-tutorial×8），逐页抓取核对。
本笔记是「严格遵守官方文档」约束下的对照结论。

## 全教程覆盖范围与关键空缺

- **官方教程只覆盖 Node 侧插件开发**。浏览器半（`dsh.client` 声明、`lib/client.js`、
  boot 图、`remote.<ns>` 服务、api-remotes 组装）在全部 18 页中**零覆盖**。
- 结论：我们插件浏览器半的实现（含 P0-1 的修复路径）属于官方未公开文档化的领域；
  实现以官方机制不冲突为底线，机制细节以随包安装的 0.1.5-rc.2 源码为准。

## 逐章要点（与插件仓相关的契约）

| 章 | 要点 |
|---|---|
| basic/第一个插件 | 插件=导出 name/inject/apply 的 TS 模块；`pnpm dsh web --patch <overlay>` 载入；`ctx.effect()` 自定义清理 |
| basic/tool | `ctx.tools.register(defineTool({...}))`；两段式输出（canonical value + output.render） |
| basic/config | 必须导出 Schemastery schema（Standard Schema 接口），导出普通对象无效；配置错误加载期响亮失败 |
| basic/publish | **官方打包清单 = package.json 的 `dsh.bundle.patch`**（无 dsh.plugin.json 概念）；本仓已对齐；`dsh plugin --profile <name> add` 官方安装；git 安装需 prepare 脚本或 tgz；层序：bundles → profile patch → home patch → --patch；**patch 整体替换目标行 config** |
| framework/ | Fiber 状态机 PENDING→LOADING→ACTIVE→UNLOADING→DISPOSED（FAILED 分支）；必需服务消失→自动卸载、恢复→自动重载；反序清理、异步清理并发 |
| framework/service | Service 子类 `super(ctx, 'key')` 注册即 effect；inject 硬依赖、`ctx.get()` 可选依赖；声明合并供类型 |
| framework/events | ctx.on/emit + 声明合并；emit/bail/serial/waterfall（观察者必须调用 next()）；命名空间/action 约定 |
| practice/三层拆分 | Service Definition / Provider / Consumer 三角色；不预防性拆包 |
| practice/llm-adapter | LlmAdapter.stream 契约、StreamChunk 配对规则、LlmError 稳定码、attributionHeaders + abort signal |
| practice/dynamic-cordis | dsh-tool-cordis：agent 运行期挂载/卸载内存插件 |
| cordis-tutorial 01-07 | id 稳定标识（无 id 的行编辑即删+重挂）；disabled 语义；PENDING 是合法状态（inject 无人提供时静默等待，可用 ctx.registry 诊断）；`!!js` 仅在 config 与 disabled 内有效（与本仓用法一致）；组/isolate/isolate 配置 |

## 对本仓的直接修正与确认

1. `package.json` 已含官方 `dsh.bundle.patch: ./cordis.patch.yml` ✓（安装器自动应用
   插件 patch 的机制来源；**profile patch 不可重述插件行**——duplicate loader entry id）。
2. `dsh.plugin.json` 是 better-sidebar 的自有约定，非官方必需——保留为元数据无害，
   但装载不依赖它。
3. patch 行整体替换 config、必须重述全部键 ✓（与本仓 cordis.patch.yml 注释一致）。
4. PENDING 是官方合法状态：浏览器半等 remote.* 服务时的 pending 与框架语义一致；
   修复方向仍是「由本插件浏览器半自行提供 remote.teamSkills / remote.cloudWorkspaces」
   （见 PHASE2-GOAL.md P0-1），官方文档对此无约束也无现成机制。
5. `!!js` 仅限 config/disabled ✓（本仓两处挂载行的 env 读取合规）。

## 未尽事项

- 官方文档站无浏览器半插件开发文档；如后续发现 `develop/` 之外的新章节（如 web
  客户端指南），需重新对照。
- 派发 /goal 前在文首追加：以官方 develop/ 教程与随包源码为准绳。

## 增补（2026-09-21，二期实测，「随包源码为准绳」条款的两条落点）

1. **basic/config 的「导出 Config 即获校验」只覆盖宿主 fragment**。真机探针
   （见台账 D23）：0.1.5-rc.2 的浏览器 runner 不向 fragment 下发挂载行配置，
   `apply(ctx, config)` 的第二参恒为 `undefined`，boot 清单与页面均无部署值。
   因此浏览器 fragment 导出 `Config` 会拿 `undefined` 过校验而永久打红；
   本仓浏览器部署值改走工作台设置面（P0-2 的「settings 面替代配置」选项），
   `PlatformClientConfigSchema` 以非 `Config` 名字保留。若未来基线开始下发
   行配置，此决定需重审。
2. **framework/service 的 Service 模式在浏览器半同样成立且被本仓实际使用**：
   `super(ctx, 'remote.teamSkills')` / `super(ctx, 'remote.cloudWorkspaces')`
   经 `ctx.reflect.provide` 注册即 effect，inject 硬依赖语义一致；cordis 在
   浏览器种子表（PLATFORM_MODULES）中可作值导入。同一键二次注册抛
   `service "..." has been registered`（cordis `reflect.provide`），故本插件
   不提供已被 `@deepseek-ai/dsh-api-gateway` 占用的 `remote` 键，只提供两个
   命名空间键。
