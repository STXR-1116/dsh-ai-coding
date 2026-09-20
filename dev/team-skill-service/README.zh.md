# Team Skill 服务（确定性本地 fixture）

[English](README.md) | 中文

一个内存态 HTTP 服务，在插件、Host 和 Web 管理后台开发与验收期间代替生产环境的 AI Coding 账号、项目和团队 Skill API。它是联调 fixture：其中没有任何生产基础设施，fixture 行为不构成生产验收证据。

## 范围与边界

- 生产持久化、密码哈希、凭据交付、组织目录、制品存储和聚合服务由后端同事负责，不在本目录范围内。
- 仅限 fixture 的实现，保留原因是确定性本地联调需要它们：账号密码在内存中明文存储和比较；种子演示账号使用固定密码和固定会话（`admin-demo`、`manager-demo`、`demo-token`）；创建账号在 HTTP 响应中直接返回一次性初始密码；每个响应都带 `access-control-allow-origin: *`。
- P0-01 边界：fixture 测试全部通过也不构成生产证据。真实 IAM、密码哈希、持久化、制品存储、审计存储、来源白名单与跨实例一致性仍为同事负责的前置条件，在生产后端交付前保持 BLOCKED。
- 生产部署必须逐项替换：带邀请和改密交付的哈希凭据、服务端签发的短时会话、真实组织目录、由部署配置提供的来源白名单、受保护的制品存储。直接部署这些路由会造成凭据暴露和浏览器来源过宽。

## 授权模型

- Skill 创建时归属一个组织，归属来自作者的 active 成员关系；admin 创建时必须显式传 `organization_id`。
- 普通用户 Skill 入口（目录、详情、release-status、安装、下载）都是"可安装读取"：调用者能访问项目、Skill 的组织等于项目的组织、Skill 已作为 `skill` 资产关系绑定到该项目、调用者在 Skill 在该组织内的可见范围内，**且 Skill 与请求的版本必须都处于 `published`**。已绑定但未发布的 Skill（draft、pending_review、approved、withdrawn）在所有普通用户路径上与不存在的资源返回相同的 404/空语义，不泄露其元数据或存在性。请求版本还必须是该 Skill **当前**的 published 版本：新增草稿版本会把 Skill 拉回 draft，从那一刻起旧 published 版本的安装被拒绝（目录、详情、release-status、安装与所有已签发的下载地址一致）。
- 治理读取是独立授权：管理路由（`/v1/admin/team-skills`）使用组织范围的管理判定，而非可安装门禁，因此有权限的 manager/admin 可以查看 draft、pending_review、approved、withdrawn 状态的 Skill。
- 发布与绑定的规则：发布使版本可安装，把 Skill 绑定为项目资产才使它在项目目录中可发现。未绑定的已发布 Skill 对所有项目目录不可见；管理端 Skill 视图展示已绑定项目 id，让缺失步骤与发布状态同时可见。
- 管理端读写按组织限定范围：admin 覆盖平台，manager 覆盖自己的 active 组织。人员和组的可见目标必须是该 Skill 组织目录中的 active 成员或组织内组。
- 停用、移除成员和解除资产绑定在下一次请求即生效。下载地址在每次请求时重新校验当前 Skill 状态、操作版本、项目绑定、组织、可见范围和操作主体；Skill 或版本离开 `published`（或绑定被解除）会立即以 **403 `INSTALL_AUTHORIZATION_REVOKED`** 撤销所有已签发的下载地址——这与详情、目录、release-status 的 404/空语义不同，因为该地址此前已签发。权威 release-status 响应不再报告某版本为 published 时，Host 会隔离本地已安装副本。
- 各入口响应语义：未发布 Skill 的详情返回 `404 RESOURCE_NOT_FOUND`；目录和 release-status 直接省略不可安装的资源（不返回伪造记录）；对非 published 或非当前版本的新安装返回 `404 RESOURCE_NOT_FOUND`；被撤销的下载返回 `403 INSTALL_AUTHORIZATION_REVOKED`、`data: null` 且不含制品字节。

## HTTP 契约

- 所有 JSON 响应使用统一 envelope：`{code, message, request_id, data}`，成功 `code: 0`，失败 `data: null`。唯一例外是成功的制品下载，它返回原始 `application/zip` 字节而非 JSON envelope。
- 缺失或空必填字段返回 `422 VALIDATION_REQUIRED`；字段类型错误和非法枚举返回 `422 VALIDATION_ERROR`；非法 JSON 返回 `400 INVALID_JSON`。写操作缺少 `Idempotency-Key` 返回 `400 IDEMPOTENCY_KEY_REQUIRED`。各路由保留既有的 `Idempotency-Key` 与 `If-Match`/`expected_revision` 校验顺序。
- 写操作必须携带 `Idempotency-Key`；并发更新由 `If-Match` 或 `expected_revision` 保护。
- 遥测交付分类：`accepted`、`duplicate`、`retryable`、`rejected` 折叠请求时间窗口内的逐事件 ACK 台账；`gaps` 为已持久化缺口事件数。`queued` 是**服务端**当前交付积压快照。fixture 同步聚合、无法观察 Host 队列，因此恒为 `queued: 0`——这是 fixture-only 口径，绝不能解读为"真实生产积压为零"。真实快照由生产服务提供。

## 测试

`pnpm exec vitest run apps/team-skill-service/tests` 通过真实 HTTP 覆盖账号与项目授权、Skill 组织与项目授权、请求校验、项目记忆、遥测和治理生命周期。这些测试只证明 fixture 行为。
## 云工作空间 fixture

- fixture 还提供插件、Host 与后台闭环所用的确定性云工作空间接口：Agent 类型、项目可用的 published Agent 配置、Workspace 生命周期（`provisioning` -> `starting` -> `ready`，以及停止/重试/归档/删除）、远程目录与文件读取、预览（`text`、`markdown`、`json`、`image`、带服务端 CSP 与 sandbox 的 `static_html`、`diff`）、相对基线 revision 的变更、携带不可变配置快照的 Run、可重放的 SSE `/v1/events/stream`（未知水位返回 `resync_required`），以及统一携带字面字段 `actor_name` 的审计行。
- 每个云工作空间响应都带 `x-fixture-only: true`。生命周期转换在被读取时推进；保留窗口裁剪与事件重放是 fixture 场景（`x-fixture-scenario: workspace-prune-events`）；审计行仅存于内存。这些路由背后没有真实容器、运行实例、Git Provider、Agent 执行或持久审计。
- Agent 配置治理：`/v1/me/agent-profiles` 按项目返回富化的 published 版本（描述、Agent 类型名称/key/readiness/能力、名称与 readiness 由服务端解析的有序 Skill 绑定、知识库集合、单个记忆库或 `null`、含 `write_mode` 的执行策略、通用 `type_extension_config`、readiness 结论与原因、默认标记、创建人与时间戳）；`/v1/admin/agent-types` 与 `/v1/admin/agent-types/{id}/schema` 提供各类型扩展 schema（Claude Code、Hermes 和已退役的 `legacy_shell`），`/v1/admin/asset-candidates` 提供授权与 readiness 元数据；生命周期覆盖创建、草稿保存（`If-Match`）、新版本（必须 `If-Match`）、复制（新不透明 ID，无绑定无发布状态）、发布（阻断不可用类型、缺失必填扩展字段、缺失资产、未授权资产与未就绪凭据引用）、归档、绑定（拒绝未知或跨组织项目、未授权给该项目的资产，跨 Profile 保证每项目单一默认）与解绑——每个动作都发出 `agent_profile` 流事件和带字面量 `actor_name` 的审计行。写请求体必须是 JSON 对象（否则 `400 INVALID_RESPONSE`），required 标记绝不默认，Run 的写入模式只能收紧不能扩大 Profile 的 `write_mode`（`422 AGENT_TYPE_UNAVAILABLE` 同时守护工作空间与 Run 创建的不可用类型）。
- fixture 直接提供 `/v1` 接口。使用者把 `apiBaseUrl` 配置为服务端点：尾部 `/v1` 与尾部斜杠均可有可无，因为 Host 会归一化为恰好一个 `/v1`，因此 `http://127.0.0.1:<port>` 与 `http://127.0.0.1:<port>/v1` 都能到达每条 REST 路由与 SSE 流。
