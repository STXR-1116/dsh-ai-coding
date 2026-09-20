# Team Skill admin (Web governance console)

English | [中文](README.zh.md)

A Next.js console for Team Skill, knowledge, project-memory, telemetry, and account governance. It talks to the deterministic local fixture through the same HTTP contract the production backend will expose; it is not a production deployment.

## Boundary

- Authentication proxies through Auth.js; the fixture's plaintext passwords, fixed demo sessions, and wildcard CORS are fixture-only and documented in `apps/team-skill-service/README.md`. Production credential handling and origin allowlists are owned by the backend team.
- Every write goes through the server with an `Idempotency-Key` and the server revision (`If-Match`); the console never infers roles or permissions in the browser — pages show what the service returns for the signed-in account.

## Capabilities

- Skill governance: organization-scoped directory, drafts, reviews, releases, and audit logs; the Skill detail shows the owning organization and the server-side project bindings, so a published Skill without bindings is visibly not yet discoverable.
- Account and organization governance: user creation with one-time passwords, display-name edits, suspension and restoration, organization membership add/remove, organization lifecycle (create, rename, archive, restore), and manager binding.
- Projects, knowledge bases, project memory, and the AI Coding observability pages read the same server state the plugin and Host see.

## Tests

`pnpm exec vitest run apps/team-skill-admin/tests` covers the API client validators and the dashboard pages with mocked fetch. Direct URL, refresh, and post-revocation behavior for governance pages is verified against the fixture.
## Cloud workspace administration

- The 云工作空间 group adds four pages: Agent 配置 (draft -> version -> publish/archive guarded by `If-Match` plus `Idempotency-Key`, and project bindings), Workspace 运维 (status filters, stop with the current revision, start), Agent Run (global search and configuration snapshots), and 审计 (unified query where every row must carry a non-empty literal `actor_name`). The pages consume the service fixture and display fixture-only notices; they are not production governance evidence.
- The Agent 配置 page covers the full governance surface: server-side filters (status, agent type, project, readiness, creator), enriched cards (readiness with reason, creator, timestamps, draft-pending hint, credential-reference summary), a strictly validated detail snapshot, clone-as-new-draft, publish/archive confirmation dialogs, ordered Skill selection with required flags and move up/down, knowledge multi-select, a single memory picker whose first option is 不使用记忆库 (`memory: null`), schema-driven type-extension fields rendered from the server's per-type schema, and a live `agent_profile` stream subscription that re-reads the authoritative list instead of applying event payloads. List payloads that miss any enriched field fail validation instead of rendering as an empty success.
