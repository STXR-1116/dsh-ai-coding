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

### Browser half — the workbench settings face

The 0.1.5-rc.2 client runner delivers no mount-row configuration to browser
fragments (see docs/api-drift-ledger.md D23), so the browser deployment values
are set once in the workbench's own settings face (persisted in
`localStorage`, applied live):

- 平台服务地址 `apiBaseUrl` (required) and optional platform access token
- 云工作空间服务地址 (defaults to the platform URL), identity mode
  `account` / `static-token`, and the static workspace token

An unconfigured browser opens the workbench straight onto this form — the
failure is loud and named, never a silent `not-ready` blur (P0-2).

## Development

```
pnpm install
pnpm run build          # generate remote face + tsc + dual-half tsdown
pnpm run typecheck      # 0 errors expected
pnpm test               # full suite; retries infrastructure losses only
pnpm run verify:face    # remote-face drift guard against the host gateways
node build/mount-smoke.mjs [port]   # real-Chromium mount gate (18 steps)
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
