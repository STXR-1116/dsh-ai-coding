# dsh-ai-coding

AI Coding platform plugin for DSH: cloud workspace workbench, team skill
governance, knowledge and memory surfaces — packaged as a standalone
double-half (host + browser) plugin, modeled on the ecosystem blueprint
([DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)).

## Status: phase-1 complete, phase-2 (real-browser mount) in progress

Build (dual-half tsdown), tests (159 files / 1413 cases green), single-package
identity, and npm-baseline dependency pins are done and verified. Remaining
defect: the browser half waits for `remote.teamSkills` / `remote.cloudWorkspaces`
at real-browser mount — see docs/PHASE2-GOAL.md P0-1 for the narrowed root cause
and docs/PHASE2-GOAL.md §/goal for the dispatched plan.

Migrated from the harness monorepo snapshot (v0.1.1-rc.2 era). Layout:

- `src/` — host half (Cordis plugin: workspace host/gateway/http, installer,
  knowledge/memory loops, telemetry) — from `packages/platform/ai-coding-platform`
- `src/client/` — browser half (React surfaces) — from
  `packages/client/ui-ai-coding-platform/src/client`
- `src/client-node/` — the client package's node-half pieces (index/invariant)
- `dev/team-skill-service/` — deterministic fixture backend (self-contained; runtime dep: `fflate` only)
- `dev/team-skill-admin/` — governance console (standalone Next.js app, zero DSH deps)
- `build/platform-modules.ts` — module-table baseline, mirrored from the monorepo

## ROADMAP

1. `tsdown.config.ts`: port the dual-half preset (node lib from `lib/types` +
   closure-factory client bundle with the CSS pipeline) from the monorepo's
   `packages/client/tsdown.client.ts`; inline `clientBuildEnvironmentDefines`
   (`scripts/client-build-environment.ts`, 311 lines) or the subset this
   plugin's bundle actually needs.
2. Port unit/fixture tests (`tests/`), then the heavier suites (gateway
   matrix, client lifecycle specs) — several import harness `test-support`
   packages; check npm availability per import.
3. Rename the two-package split identity to the single package
   (`@deepseek-ai/dsh-ai-coding-platform` → this package) across
   `cordis.patch.yml`, `src/client-node/invariant.ts` registration, and the
   client inject wiring — verify against the published invariants/registry
   contracts first.
4. API-drift port: compile against npm `@deepseek-ai/*` (see `package.json`
   pins) and fix every surfaced displacement from the 0.1.1-rc.2 snapshot
   APIs. Mount smoke (build → pack → real mount → headless render) is the
   acceptance gate.
5. CI: pinned-baseline mount gate + fixture lane; upstream bump PRs.

## Install (GitHub source channel)

```
git clone https://github.com/STXR-1116/dsh-ai-coding
dsh plugin --profile web add <link-or-path>
dsh --patch cordis.patch.yml web
```

Demo backend: `node --import tsx dev/team-skill-service/src/server.ts` (port
4100) with `DSH_AI_CODING_PLATFORM_API_URL`/`DSH_CLOUD_WORKSPACE_API_URL`
pointed at `http://127.0.0.1:4100/v1`.

## LLM provider (GOAT / Command Code)

Configured in `~/.dsh/settings.yaml` (works, verified end-to-end): custom
provider `goat` (`api: openai-completions`, baseURL
`https://api.commandcode.ai/provider/v1`, `apiKeyEnv: COMMANDCODE_API_KEY`)
serving `deepseek/deepseek-v4.1-flash`; default model set to it. Declare `reasoningEfforts` on the model (off/high/max -> protocol `high`) and set default `reasoningEffort: high` — verified on GOAT.
