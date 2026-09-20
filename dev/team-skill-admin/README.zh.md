# Team Skill 管理后台（Web 治理控制台）

[English](README.md) | 中文

一个覆盖团队 Skill、知识库、项目记忆、可观测和账号治理的 Next.js 控制台。它通过与生产后端相同的 HTTP 契约访问确定性本地 fixture；它不是生产部署。

## 边界

- 登录通过 Auth.js 代理；fixture 的明文密码、固定演示会话和通配 CORS 仅限联调使用，已在 `apps/team-skill-service/README.md` 标记。生产凭据处理和来源白名单由后端同事负责。
- 每个写操作都通过服务端完成并携带 `Idempotency-Key` 和服务端 revision（`If-Match`）；后台从不在浏览器自行推断角色或权限——页面展示服务端为当前登录账号返回的状态。

## 能力

- Skill 治理：按组织限定范围的目录、草稿、审核、发布和审计日志；Skill 详情展示所属组织和来自服务端的项目绑定，已发布但未绑定的 Skill 可以直接看出尚未可被发现。
- 账号与组织治理：带一次性密码的账号创建、显示名编辑、停用与恢复、组织成员新增/移除、组织生命周期（创建、重命名、归档、恢复）和经理绑定。
- 项目、知识库、项目记忆和 AI Coding 可观测页面读取的是与插件、Host 相同的服务端状态。

## 测试

`pnpm exec vitest run apps/team-skill-admin/tests` 覆盖 API 客户端校验器和基于 mock fetch 的后台页面。治理页面的 direct URL、刷新和撤权后的状态针对 fixture 验证。
## 云工作空间管理

- 云工作空间分组新增四个页面：Agent 配置（草稿 -> 版本 -> 发布/归档，带 `If-Match` 与 `Idempotency-Key` 守卫，以及项目绑定）、Workspace 运维（状态筛选、按当前 revision 停止、启动）、Agent Run（全局检索与配置快照）和审计（统一查询，每行必须携带非空字面字段 `actor_name`）。页面消费服务端 fixture 并展示 fixture-only 提示，不构成生产治理证据。
- Agent 配置页覆盖完整治理面：服务端筛选（状态、Agent 类型、项目、readiness、创建人）、富化卡片（readiness 与原因、创建人、时间戳、草稿未发布提示、凭据引用摘要）、严格校验的详情快照、复制为新草稿、发布/归档确认弹窗、带必需标记与上移/下移的有序 Skill 选择、知识库多选、首项为“不使用记忆库”（`memory: null`）的单选记忆库、由服务端 schema 驱动的类型扩展字段，以及订阅 `agent_profile` 流事件后重读权威列表（不把事件 payload 拼成本地状态）。列表载荷缺少任何富化字段都会校验失败，绝不降级成空成功。
