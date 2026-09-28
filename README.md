# dsh-ai-coding

AI Coding platform plugin for DSH: cloud workspace workbench, team skill
governance, knowledge and memory surfaces — packaged as a standalone
double-half (host + browser) plugin, modeled on the ecosystem blueprint
([DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)).

## Status: phase-2 complete (real-browser mount verified)

- Host half: Team Skill gateway + cloud workspace gateway over the fixture
  backend, installer, knowledge/memory loops, telemetry collector.
- Browser half: self-provided `remote.teamSkills` / `remote.cloudWorkspaces`
  services (official cordis Service mode) answering the full generated faces —
  the workbench runs entirely in the browser against the AI Coding backend.
- Verified on the npm baseline `@deepseek-ai/* 0.1.5-rc.2`:
  `typecheck` 0 errors, 161 test files / 1435 cases green (`skipped=0`),
  real-Chromium mount smoke 18/18 three consecutive greens plus an archived
  red run (docs/mount-smoke/phase2/, docs/mount-smoke-log.md), and owner
  acceptance screenshots (docs/mount-acceptance/).

Migrated from the harness monorepo snapshot (v0.1.1-rc.2 era). Layout:

- `src/` — host half (Cordis plugin: workspace host/gateway/http, installer,
  knowledge/memory loops, telemetry) — from `packages/platform/ai-coding-platform`
- `src/client/` — browser half (React surfaces) — from
  `packages/client/ui-ai-coding-platform/src/client`
- `src/client/remote/` — the browser-provided remote faces: config resolution,
  settings persistence, the two Service classes, envelope helpers
- `src/client-node/` — the client package's node-half pieces (index/invariant)
- `dev/team-skill-service/` — deterministic fixture backend (self-contained; runtime dep: `fflate` only)
- `dev/team-skill-admin/` — governance console (standalone Next.js app, zero DSH deps)
- `build/` — dual-half build preset, mount smoke, acceptance capture

## Install

Build and install through the official channel (the installer applies the
package's own `cordis.patch.yml`; never restate these rows in the profile
patch — a duplicate loader entry id aborts the boot):

```
pnpm install && pnpm run build && pnpm pack
dsh plugin --profile web add ./dsh-ai-coding-<version>.tgz
dsh --profile web
```

`dsh plugin` requires `--profile`; `add` copies the tarball into the profile,
applies the bundle patch, and adds the bundle row. Removing the plugin means
removing its row from the profile `package.json` (`dependencies` and
`dsh.profile.bundles`), deleting `node_modules/dsh-ai-coding`, and running
`pnpm install` in the profile.

### Two delivery traps this path avoids

**Do not install this package from git** (`dsh plugin --profile web add
github:…`). A git install pulls *source*, and nothing runs a build step, so the
package arrives without `lib/` and the row fails to load. Making it work would
require a self-contained `prepare` script plus the user granting pnpm permission
to run that package's install-time code (`allowBuilds` in the profile's
`pnpm-workspace.yaml`) — i.e. allowing this repository's code to execute on their
machine outside any sandbox. The tarball above needs neither, which is why it is
the only supported channel.

**Bump the version on every rebuild.** `dsh plugin add` resolves a `file:`
tarball through the profile lockfile's recorded integrity, so re-packing over an
unchanged version silently restores the *previous* contents from the pnpm store.
Either raise `version`, or delete `node_modules/dsh-ai-coding` and the profile's
`pnpm-lock.yaml` before re-adding.

## Configuration

### Host half — environment variables (read at composition via `!!js`)

| Variable | Row | Meaning |
| --- | --- | --- |
| `DSH_AI_CODING_PLATFORM_API_URL` | `ai-coding-platform` | AI Coding platform backend base URL including `/v1` |
| `DSH_AI_CODING_PLATFORM_ACCESS_TOKEN` | `ai-coding-platform` | Optional static platform token |
| `DSH_CLOUD_WORKSPACE_API_URL` | `cloud-workspaces` | Workspace backend base URL; falls back to the platform URL |
| `DSH_CLOUD_WORKSPACE_ACCESS_TOKEN` | `cloud-workspaces` | Static workspace token; required when `authMode` is `static-token` |
| `DSH_CLOUD_WORKSPACE_AUTH_MODE` | `cloud-workspaces` | `account` (default) or `static-token` |

Unset host variables degrade to the gateways' explicit `not-ready` states —
they never fabricate data.

### Browser half — deployment values come from the deployment

The 0.1.5-rc.2 client runner delivers no mount-row configuration to browser
fragments: `apply(ctx, config)` receives `undefined` and the boot manifest
carries no config keys (re-measured — the served page contains the module roster
record but none of `apiBaseUrl` / `accessToken` / `stateDirectory`; see
`docs/api-drift-ledger.md` D23).

So each mount row **declares its own slice into the served index** through the
webserver's structured injection table (`{ kind: 'global' }`, rendered as
`globalThis["<name>"] = <json>` in the head, ahead of every module script). This
is the mechanism `@deepseek-ai/dsh-client-ui-theme` uses to publish the boot
theme, and it is why opening the workbench now goes **straight to sign-in** —
nobody types a service address.

| Value | Declared? |
| --- | --- |
| platform / workspace endpoint | always |
| platform access token | when the row config sets one (that key means "static token for a no-login deployment") |
| workspace access token | only with `authMode: 'static-token'` |

An `account` deployment therefore hands the page no secret: users sign in and the
browser uses that session. Pages are served behind the browser-session index
authorization, so only an authenticated page receives a declaration at all.

The workbench's **settings face** remains as the config channel for a deployment
that declared nothing (a bare mount with no endpoint configured) — that is when
it opens, and it persists to `localStorage`. It deliberately does **not** override
a declared deployment: a stale browser value shadowing the deployment would
strand an operator on the wrong endpoint with no way back to the form, since the
form only shows when nothing is configured.

An unconfigured browser opens the workbench straight onto that form — the failure
is loud and named, never a silent `not-ready` blur (P0-2).

## 验收与排查

两条**与插件代码无关**的前置条件，验收时都被当成插件 bug 查过：

### 1. 平台服务必须在跑

工作台直接访问 AI Coding 服务。本地验收就是 `dev/team-skill-service` 夹具，默认端口 **4100**：

```pwsh
$env:TEAM_SKILL_SERVICE_PORT='4100'      # 可省略：4100 就是默认值
node --import tsx dev/team-skill-service/src/server.ts
```

没起 → 工作台显示「服务暂时不可用 / Failed to fetch」。自 0.1.6 起报错会**点名它够不着的地址**
（形如「当前服务地址：http://127.0.0.1:4100/v1」）—— 那行就是判断「服务没起」还是「配错地址」的依据。

### 2. 浏览器里存的平台令牌会盖过账号登录

浏览器半把部署值存在 `localStorage`，且**显式保存的值优先于部署声明**。若其中存了 `accessToken`，
**每个数据请求都会带它** —— 于是服务端看到的是**那个令牌的身份**，而不是你刚登录的账号。

夹具里 `demo-token` 就是一个绑定到 `member-1` 的静态会话（`account-store.ts`），而 `member-1`
是 `project-alpha` 的成员、**不是** `project-beta` 的。所以只要 `demo-token` 还存着，
**换成 `admin@example.com` 登录也没用**：工作台会一直回 `PROJECT_NOT_MEMBER`。

清除方式：**服务设置 → 清除本机覆盖，改用部署声明的地址**（0.1.6 加的逃生口），
或把「平台访问令牌」那一栏清空后保存。

### 权限拒绝会说明自己是权限问题

自 0.1.10 起，访问被拒渲染为**「无权访问」**，而不是「服务暂时不可用」。在那之前，成员拒绝被呈现成
服务中断，把排查引向服务可达性、而不是「这条请求以谁的身份发出」。

平台对这个拒绝**故意返回 404**（不泄露项目是否存在），所以**只有 code（`PROJECT_NOT_MEMBER`）
能区分**「无权限」「不存在」「够不着」—— 不能按 HTTP 状态判断。`isForbiddenCode` 已按应用自己在
目录页与 Team Skill 页早就使用的那套词汇补齐；认证类（`UNAUTHORIZED` / `TOKEN_REVOKED` /
`INVALID_CREDENTIALS` / `ACCOUNT_SUSPENDED`）**刻意不算权限问题**，那是「重新登录」。

## Development

```
pnpm install
pnpm run build          # generate remote face + tsc + dual-half tsdown
pnpm run typecheck      # 0 errors expected
pnpm test               # full suite; retries infrastructure losses only
pnpm run verify:face    # remote-face drift guard against the host gateways
node build/mount-smoke.mjs [port]   # real-Chromium mount gate (21 steps)
node build/capture-acceptance.mjs   # owner acceptance screenshots
```

Demo backend: `node --import tsx dev/team-skill-service/src/server.ts` (port
4100; `TEAM_SKILL_SERVICE_PORT` overrides). Fixture sign-ins:
`admin@example.com` / `admin-pass`, `manager@example.com` / `manager-pass`,
`member@example.com` / `member-pass`; static tokens `admin-demo`,
`manager-demo`, `demo-token` (member identity).

## LLM provider (GOAT / Command Code)

Configured in `~/.dsh/settings.yaml` (works, verified end-to-end): custom
provider `goat` (`api: openai-completions`, baseURL
`https://api.commandcode.ai/provider/v1`, `apiKeyEnv: COMMANDCODE_API_KEY`)
serving `deepseek/deepseek-v4.1-flash`; default model set to it. Declare `reasoningEfforts` on the model (off/high/max -> protocol `high`) and set default `reasoningEffort: high` — verified on GOAT.
