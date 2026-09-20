# Test Port Survey — `dsh-ai-coding` (0.1.1-rc.2 sources → `@deepseek-ai/*` 0.1.5-rc.2 baseline)

Survey only. **No source file was modified** to produce this document.

| Role | Path |
| --- | --- |
| Target repo (plugin being adapted) | `C:\Users\13588\dev\dsh-ai-coding` |
| Reference monorepo `<B>` (0.1.1-rc.2, source of tests) | `C:\Users\13588\Downloads\deepseek-harness-master1\deepseek-harness-master` |
| Monorepo host-half tests | `<B>\packages\platform\ai-coding-platform\tests` |
| Monorepo browser-half tests | `<B>\packages\client\ui-ai-coding-platform\tests` |
| Already-migrated fixture suite | `C:\Users\13588\dev\dsh-ai-coding\dev\team-skill-service\tests` |
| Already-migrated admin suite | `C:\Users\13588\dev\dsh-ai-coding\dev\team-skill-admin\tests` |

## 0. Key structural findings (evidence basis for §5)

1. **Relative paths do not need rewriting for `../src/...`.** Both monorepo packages keep tests in
   `<pkg>/tests/` with sources in `<pkg>/src/`. The target repo also has `tests/` and `src/` as
   siblings at the repo root. Therefore `../src/...` resolves to the same shape in the target:
   `<root>/tests/x.spec.ts` → `../src/...` → `<root>/src/...`. Verified: every `../src/...`
   specifier used by all 104 monorepo test files exists in the target `src/` tree, and every named
   import was found in the target file (0 missing files, 0 missing identifiers).
   The 14 "missing file" hits from the automated check were all *extensionless* UI imports
   (`../src/client/agent-config/AgentConfigView`) whose `.tsx` counterpart exists — resolved by Vite,
   no change needed.
2. **Two monorepo path aliases are load-bearing and have no target equivalent.**
   `<B>\tsconfig.base.json` maps (used via `vite-tsconfig-paths` in `<B>\vitest.config.ts`):
   * `@deepseek-ai/dsh-ai-coding-platform/*` → `packages/platform/ai-coding-platform/src/*`
   * `@deepseek-ai/dsh-client-ui-ai-coding-platform` → `packages/client/ui-ai-coding-platform/src`
   That is why UI tests can write `@deepseek-ai/dsh-ai-coding-platform/workspace-host` even though the
   published `package.json` has no `./workspace-host` export. **`@deepseek-ai/dsh-ai-coding-platform` is
   404 on npm** (Appendix A), and the target package is named `dsh-ai-coding`, so these must become
   relative imports.
3. **`../../../core/agent-loop/tests/mock-adapter.ts` is not a package.** `MockAdapter` / `textResponse`
   live in a *test-local* file of `packages/core/agent-loop` (`packages/core/agent-loop/package.json`
   `files` = `lib/index.js, lib/invariant.js, lib/types/**/*.d.ts`; no `./src/*` export, no `tests` in
   `files`). No published package re-exports them: `@deepseek-ai/dsh-agent-loop-testkit@0.1.5-rc.2`
   exports only `.` and `./src/*`, and `grep -r "class MockAdapter" packages/test-support` returns
   nothing. The file is 133 lines and imports **only** `@deepseek-ai/dsh-llm`
   (`CallId, LlmAdapter` + types) — it is trivially inlinable into the target repo.
4. **`../../../../apps/team-skill-service/src/server.ts` is portable.** The target
   `dev/team-skill-service/src/server.ts` is **byte-identical** to `<B>\apps\team-skill-service\src\server.ts`
   (SHA256 `178BB3B6CB55A8D97280995D8127E6A331A446F244167A26F5B6D89F732D5403` for both), including the
   `TeamSkillServiceOptions` interface and `createTeamSkillService(options)`. Only the *relative path
   spelling* changes: `<root>/tests/x.spec.ts` → `../dev/team-skill-service/src/server.ts`.
5. **No file in the four directories imports any `packages/test-support/*` package.** See §3.
6. **The root repo has no `vitest.config.ts`.** `package.json#scripts.test` is a bare `vitest run`, so
   today it would use the default include (`**/*.{test,spec}.?(c|m)[jt]s?(x)`), default `environment:
   'node'`, and would therefore mis-handle the 24 UI specs that need jsdom. A root config is required
   for §6 to hold (see Appendix B).

---

## 1. Full inventory

### 1.1 `<B>\packages\platform\ai-coding-platform\tests` — 61 files (host half)

| # | File | Lines |
| --- | --- | --- |
| 1 | agent-profile-parse.spec.ts | 180 |
| 2 | blueprint-tables.spec.ts | 111 |
| 3 | context-ledger.spec.ts | 184 |
| 4 | context-lens-parse.spec.ts | 162 |
| 5 | gateway-install-wiring.integration.spec.ts | 182 |
| 6 | gateway-live-session.integration.spec.ts | 344 |
| 7 | gateway-matrix.spec.ts | 204 |
| 8 | gateway-seam-remaining.integration.spec.ts | 191 |
| 9 | gateway-seam.integration.spec.ts | 216 |
| 10 | gateway.spec.ts | 55 |
| 11 | host-installation-states.integration.spec.ts | 440 |
| 12 | host-residual-closure.integration.spec.ts | 574 |
| 13 | host-service.integration.spec.ts | 395 |
| 14 | host-unreachable-matrix.integration.spec.ts | 441 |
| 15 | host.spec.ts | 737 |
| 16 | http-client-options.spec.ts | 293 |
| 17 | http-parser-vocabulary.spec.ts | 367 |
| 18 | install-failure-request-id.spec.ts | 105 |
| 19 | install-stages.spec.ts | 132 |
| 20 | installation-store.spec.ts | 176 |
| 21 | installer-matrix.spec.ts | 337 |
| 22 | installer.spec.ts | 163 |
| 23 | invariant.spec.ts | 71 |
| 24 | knowledge-loop.spec.ts | 260 |
| 25 | knowledge-search-parse.spec.ts | 76 |
| 26 | knowledge.spec.ts | 166 |
| 27 | loop-utils.spec.ts | 28 |
| 28 | memory-loop.spec.ts | 263 |
| 29 | project-memory.spec.ts | 103 |
| 30 | run-asset-snapshot.spec.ts | 130 |
| 31 | run-checkpoint.spec.ts | 165 |
| 32 | telemetry-backend.spec.ts | 213 |
| 33 | telemetry-gateway.integration.spec.ts | 1011 |
| 34 | telemetry-loop.integration.spec.ts | 922 |
| 35 | telemetry-projection.spec.ts | 201 |
| 36 | telemetry-queue.spec.ts | 250 |
| 37 | telemetry-reporter.spec.ts | 451 |
| 38 | telemetry-sanitize.spec.ts | 24 |
| 39 | telemetry-sensitive-scan.spec.ts | 264 |
| 40 | telemetry-settings.spec.ts | 35 |
| 41 | trust-card-parse.spec.ts | 138 |
| 42 | workspace-base-url.spec.ts | 129 |
| 43 | workspace-credentials.spec.ts | 199 |
| 44 | workspace-gateway-lifecycle.integration.spec.ts | 285 |
| 45 | workspace-gateway-seam.integration.spec.ts | 145 |
| 46 | workspace-gateway-seam2.integration.spec.ts | 120 |
| 47 | workspace-gateway.spec.ts | 105 |
| 48 | workspace-host-residual.integration.spec.ts | 468 |
| 49 | workspace-host.integration.spec.ts | 375 |
| 50 | workspace-http-gaps.spec.ts | 39 |
| 51 | workspace-http-gaps2.spec.ts | 165 |
| 52 | workspace-http-matrix.spec.ts | 546 |
| 53 | workspace-http-residual.spec.ts | 165 |
| 54 | workspace-http-sse-decoding.spec.ts | 134 |
| 55 | workspace-http-vocabulary.spec.ts | 236 |
| 56 | workspace-pagination.spec.ts | 174 |
| 57 | workspace-plan.spec.ts | 259 |
| 58 | workspace-provenance.spec.ts | 90 |
| 59 | workspace-stream-events.spec.ts | 123 |
| 60 | workspace-stream.spec.ts | 175 |
| 61 | workspace-strict-parsing.spec.ts | 367 |

Total lines: 15 059. No `@vitest-environment` pragma in any file → all run under the default (node) environment.

### 1.2 `<B>\packages\client\ui-ai-coding-platform\tests` — 43 files (browser half)

| # | File | Lines | jsdom pragma |
| --- | --- | --- | --- |
| 1 | agent-config-editor.client.spec.tsx | 149 | yes |
| 2 | agent-config-editor.model.client.spec.ts | 87 | no |
| 3 | agent-config.client.spec.tsx | 436 | yes |
| 4 | appearance.model.client.spec.ts | 63 | yes |
| 5 | cloud-workspaces-checkpoint.client.spec.tsx | 140 | yes |
| 6 | cloud-workspaces-code-source.spec.tsx | 149 | yes |
| 7 | cloud-workspaces-isolation.spec.tsx | 378 | yes |
| 8 | cloud-workspaces-layout.client.spec.tsx | 118 | yes |
| 9 | cloud-workspaces-plan.client.spec.tsx | 236 | yes |
| 10 | cloud-workspaces.client.spec.tsx | 2308 | yes |
| 11 | collector.client.spec.tsx | 126 | yes |
| 12 | context-lens.client.spec.tsx | 167 | yes |
| 13 | context-lens.model.client.spec.ts | 117 | no |
| 14 | controller.client.spec.ts | 34 | no |
| 15 | host-entry.client.spec.ts | 21 | no |
| 16 | knowledge-search-state.client.spec.ts | 200 | no |
| 17 | layout-presets.model.client.spec.ts | 34 | no |
| 18 | locales.client.spec.ts | 18 | no |
| 19 | memory-recall.client.spec.ts | 104 | no |
| 20 | operation-evidence.client.spec.ts | 69 | no |
| 21 | platform-entry.client.spec.tsx | 40 | yes |
| 22 | platform.client.spec.tsx | 876 | yes |
| 23 | plugin-registration.client.spec.ts | 118 | no |
| 24 | preview-security.model.client.spec.ts | 109 | no |
| 25 | recovery-center-model.client.spec.ts | 52 | no |
| 26 | recovery-center.client.spec.tsx | 128 | yes |
| 27 | recovery-center.model.client.spec.ts | 76 | no |
| 28 | run-approval-drawer.client.spec.tsx | 186 | yes |
| 29 | run-asset-snapshot-model.client.spec.ts | 83 | no |
| 30 | run-asset-snapshot.client.spec.tsx | 121 | yes |
| 31 | run-asset-snapshot.model.client.spec.ts | 89 | no |
| 32 | run-pulse.client.spec.tsx | 159 | yes |
| 33 | run-pulse.model.client.spec.ts | 92 | no |
| 34 | team-skills-installed-state.client.spec.tsx | 143 | yes |
| 35 | team-skills-stages.client.spec.tsx | 218 | yes |
| 36 | team-skills-trust-card.client.spec.tsx | 169 | yes |
| 37 | team-skills.client.spec.tsx | 329 | yes |
| 38 | trust-card.model.client.spec.ts | 151 | no |
| 39 | ux-platform.client.spec.tsx | 565 | yes |
| 40 | ux12-a11y.client.spec.tsx | 295 | yes |
| 41 | workspace-markers.client.spec.ts | 25 | no |
| 42 | workspace-markers.model.client.spec.ts | 50 | no |
| 43 | workspace-tree-preview.client.spec.tsx | 185 | yes |

Total lines: 9 213. **24 of 43 files carry `// @vitest-environment jsdom`** (verbatim, first line of each);
the other 19 are node-environment model/unit specs.

### 1.3 `C:\Users\13588\dev\dsh-ai-coding\dev\team-skill-service\tests` — 30 files

| # | File | Lines | # | File | Lines |
| --- | --- | --- | --- | --- | --- |
| 1 | access.spec.ts | 922 | 17 | request-validation.spec.ts | 174 |
| 2 | afc02-schema.spec.ts | 60 | 18 | response.ts *(helper, not a spec)* | 6 |
| 3 | afc03-pagination.spec.ts | 142 | 19 | run-approval-takeover.spec.ts | 306 |
| 4 | agent-config-editor.spec.ts | 181 | 20 | run-checkpoint.spec.ts | 254 |
| 5 | agent-config.spec.ts | 1060 | 21 | run-pulse.spec.ts | 176 |
| 6 | asset-snapshot.spec.ts | 205 | 22 | run-state-machine.spec.ts | 150 |
| 7 | audit-actor-name.spec.ts | 151 | 23 | service.spec.ts | 359 |
| 8 | context-lens.spec.ts | 250 | 24 | skill-auth.spec.ts | 645 |
| 9 | denial-audit.spec.ts | 122 | 25 | skill-release-gate.spec.ts | 765 |
| 10 | error-envelope.spec.ts | 87 | 26 | skill-trust-card.spec.ts | 306 |
| 11 | knowledge.spec.ts | 257 | 27 | telemetry.spec.ts | 402 |
| 12 | org-lifecycle-auth.spec.ts | 199 | 28 | workspace-admin.spec.ts | 363 |
| 13 | permission-check.spec.ts | 159 | 29 | workspace-plan.spec.ts | 330 |
| 14 | permission-simulate.spec.ts | 128 | 30 | workspace.spec.ts | 469 |
| 15 | phase-2-0-contracts.spec.ts | 240 | | | |
| 16 | project-memory.spec.ts | 564 | | | |

29 specs + 1 non-spec helper (`response.ts`). Total lines: 9 432.

### 1.4 `C:\Users\13588\dev\dsh-ai-coding\dev\team-skill-admin\tests` — 26 files

| # | File | Lines | # | File | Lines |
| --- | --- | --- | --- | --- | --- |
| 1 | admin-dashboard.spec.tsx | 1285 | 14 | page.spec.tsx | 17 |
| 2 | agent-asset-governance.model.spec.ts | 90 | 15 | permission-chain.model.spec.ts | 77 |
| 3 | agent-config-chain.e2e.spec.tsx | 633 | 16 | project-governance.model.spec.ts | 75 |
| 4 | asset-governance.view.spec.tsx | 148 | 17 | project-management.spec.tsx | 125 |
| 5 | cloud-agent-config.spec.tsx | 656 | 18 | request-capture.ts *(helper)* | 90 |
| 6 | cloud-workspace-admin.spec.tsx | 708 | 19 | run-evidence.model.spec.ts | 64 |
| 7 | cloud-workspace-capability.spec.tsx | 377 | 20 | team-skill-api.spec.ts | 530 |
| 8 | cloud-workspace-e2e.spec.ts | 658 | 21 | team-skill-proxy.spec.ts | 181 |
| 9 | cloud-workspace-stream.spec.ts | 776 | 22 | telemetry-page-scan.spec.tsx | 115 |
| 10 | command-palette.model.spec.ts | 49 | 23 | telemetry.spec.tsx | 393 |
| 11 | command-palette.view.spec.tsx | 119 | 24 | workbench-groups.spec.ts | 89 |
| 12 | load-page-real-reads.spec.tsx | 362 | 25 | workbench-page.spec.tsx | 145 |
| 13 | observability.model.spec.ts | 61 | 26 | workspace-ops.model.spec.ts | 49 |

24 specs + 2 non-spec helpers (`request-capture.ts`; `response.ts` is *not* here — it lives in the service suite). Total lines: 7 872.

---

## 2. Import classification

Legend — **R** = relative (`./`, `../`): note target resolution. **D** = `@deepseek-ai/*`. **N** = other npm. **H** = helper/fixture inside the tests dir. `✎` = specifier must change in the target.

### 2.1 Host half — `packages\platform\ai-coding-platform\tests` (61 files)

All 61 files import `vitest`. All `../src/...` specifiers below were verified to exist in
`C:\Users\13588\dev\dsh-ai-coding\src\...`, and every named import to be present in the target file.

| File | R (target status) | D | N | H |
| --- | --- | --- | --- | --- |
| agent-profile-parse.spec.ts | `../src/workspace-http.ts` ok | — | — | — |
| blueprint-tables.spec.ts | `../src/workspace-http.ts` ok | — | — | — |
| context-ledger.spec.ts | `../src/context-ledger.ts` ok; `../../../core/agent-loop/tests/mock-adapter.ts` **✎ not in target** | `@deepseek-ai/cordis`, `dsh-llm`, `dsh-session`, `dsh-system-prompt`, `dsh-tools`, `dsh-agent`, `dsh-agent-loop` | — | monorepo-only `mock-adapter.ts` |
| context-lens-parse.spec.ts | `../src/workspace-http.ts`, `../src/workspace-host.ts` ok | — | — | — |
| gateway-install-wiring.integration.spec.ts | `../../../../apps/team-skill-service/src/server.ts` **✎**; `../src/gateway.ts` ok | `@deepseek-ai/cordis`, `dsh-credentials`, `dsh-session`, `dsh-agent` | — | — |
| gateway-live-session.integration.spec.ts | app path **✎**; `../src/gateway.ts` ok; `mock-adapter.ts` **✎** | `@deepseek-ai/cordis`, `dsh-llm`, `dsh-credentials`, `dsh-session`, `dsh-system-prompt`, `dsh-tools`, `dsh-agent`, `dsh-agent-loop` | — | monorepo-only `mock-adapter.ts` |
| gateway-matrix.spec.ts | app path **✎**; `../src/workspace-gateway.ts`, `../src/workspace-types.ts` ok | `@deepseek-ai/cordis` | — | — |
| gateway-seam-remaining.integration.spec.ts | app path **✎**; `../src/gateway.ts` ok | `@deepseek-ai/cordis`, `dsh-credentials`, `dsh-session`, `dsh-agent` | — | — |
| gateway-seam.integration.spec.ts | app path **✎**; `../src/gateway.ts` ok | `@deepseek-ai/cordis`, `dsh-credentials`, `dsh-session`, `dsh-agent` | — | — |
| gateway.spec.ts | `../src/gateway.ts` ok | `@deepseek-ai/cordis`, `dsh-typert-protocol` | — | — |
| host-installation-states.integration.spec.ts | app path **✎**; `../src/host.ts`, `types.ts`, `installation-store.ts` ok | — | — | — |
| host-residual-closure.integration.spec.ts | app path **✎**; `../src/host.ts`, `installation-store.ts`, `types.ts` ok | `@deepseek-ai/dsh-credentials` | — | — |
| host-service.integration.spec.ts | app path **✎**; `../src/host.ts` ok | `@deepseek-ai/dsh-credentials` | `fflate` | — |
| host-unreachable-matrix.integration.spec.ts | app path **✎**; `../src/host.ts` ok | `@deepseek-ai/cordis`, `dsh-credentials` | — | — |
| host.spec.ts | `../src/host.ts`, `installation-store.ts`, `types.ts` ok | `@deepseek-ai/dsh-credentials` | `fflate` | — |
| http-client-options.spec.ts | `../src/http.ts` ok | — | — | — |
| http-parser-vocabulary.spec.ts | `../src/http.ts` ok | — | — | — |
| install-failure-request-id.spec.ts | `../src/host.ts` ok | — | — | — |
| install-stages.spec.ts | `../src/install-stages.ts` ok | — | — | — |
| installation-store.spec.ts | `../src/installation-store.ts`, `types.ts` ok | — | — | — |
| installer-matrix.spec.ts | `../src/installer.ts` ok | — | `fflate` | — |
| installer.spec.ts | `../src/installer.ts` ok | — | `fflate` | — |
| invariant.spec.ts | `../src/invariant.ts` ok | `@deepseek-ai/cordis`, `dsh-session`, `dsh-invariants` | — | — |
| knowledge-loop.spec.ts | `../src/knowledge-loop.ts`, `types.ts` ok; `mock-adapter.ts` **✎** | `@deepseek-ai/cordis`, `dsh-llm`, `dsh-session`, `dsh-system-prompt`, `dsh-tools`, `dsh-agent`, `dsh-agent-loop` | — | monorepo-only `mock-adapter.ts` |
| knowledge-search-parse.spec.ts | `../src/http.ts` ok | — | — | — |
| knowledge.spec.ts | `../src/host.ts` ok | `@deepseek-ai/dsh-credentials` | — | — |
| loop-utils.spec.ts | `../src/loop-utils.ts` ok | — | — | — |
| memory-loop.spec.ts | `../src/memory-loop.ts` ok; `mock-adapter.ts` **✎** | `@deepseek-ai/cordis`, `dsh-llm`, `dsh-session`, `dsh-system-prompt`, `dsh-tools`, `dsh-agent`, `dsh-agent-loop` | — | monorepo-only `mock-adapter.ts` |
| project-memory.spec.ts | `../src/host.ts`, `http.ts` ok | — | — | — |
| run-asset-snapshot.spec.ts | `../src/workspace-http.ts`, `workspace-host.ts` ok | — | — | — |
| run-checkpoint.spec.ts | `../src/workspace-http.ts`, `workspace-host.ts` ok | — | — | — |
| telemetry-backend.spec.ts | `../src/telemetry/{queue,reporter,backend}.ts`, `types.ts` ok; `mock-adapter.ts` **✎** | `@deepseek-ai/cordis`, `dsh-llm`, `dsh-session`, `dsh-system-prompt`, `dsh-tools`, `dsh-agent`, `dsh-agent-loop` | — | monorepo-only `mock-adapter.ts` |
| telemetry-gateway.integration.spec.ts | app path **✎**; `../src/gateway.ts`, `telemetry/{queue,reporter}.ts`, `types.ts` ok; `mock-adapter.ts` **✎** | `@deepseek-ai/cordis`, `dsh-credentials`, `dsh-session`, `dsh-llm`, `dsh-system-prompt`, `dsh-tools`, `dsh-agent`, `dsh-agent-loop` | — | monorepo-only `mock-adapter.ts` |
| telemetry-loop.integration.spec.ts | app path **✎**; `../src/host.ts`, `telemetry/*.ts`, `types.ts` ok; `mock-adapter.ts` **✎** | `@deepseek-ai/cordis`, `dsh-llm`, `dsh-session`, `dsh-system-prompt`, `dsh-tools`, `dsh-agent`, `dsh-agent-loop`, `dsh-credentials` | — | monorepo-only `mock-adapter.ts` |
| telemetry-projection.spec.ts | `../src/telemetry/projection.ts`, `types.ts` ok | `@deepseek-ai/dsh-session-telemetry` *(type-only)* | — | — |
| telemetry-queue.spec.ts | `../src/telemetry/queue.ts`, `types.ts` ok | — | — | — (dynamic `import('node:sqlite')`) |
| telemetry-reporter.spec.ts | `../src/telemetry/{queue,reporter}.ts`, `types.ts` ok | — | — | — |
| telemetry-sanitize.spec.ts | `../src/telemetry/sanitize.ts` ok | — | — | — |
| telemetry-sensitive-scan.spec.ts | app path **✎**; `../src/host.ts`, `telemetry/{queue,reporter,sanitize}.ts` ok; dynamic `@deepseek-ai/cordis` + dynamic `../src/gateway.ts` | `@deepseek-ai/cordis` *(dynamic)* | — | — |
| telemetry-settings.spec.ts | `../src/telemetry/settings.ts` ok | — | — | — |
| trust-card-parse.spec.ts | `../src/http.ts` ok | — | — | — |
| workspace-base-url.spec.ts | `../src/workspace-http.ts`, `workspace-host.ts` ok | — | — | — |
| workspace-credentials.spec.ts | `../src/workspace-gateway.ts` ok | `@deepseek-ai/cordis` | — | — |
| workspace-gateway-lifecycle.integration.spec.ts | app path **✎**; `../src/workspace-gateway.ts`, `workspace-types.ts` ok | `@deepseek-ai/cordis` | — | — |
| workspace-gateway-seam.integration.spec.ts | app path **✎**; `../src/workspace-gateway.ts` ok | `@deepseek-ai/cordis` | — | — |
| workspace-gateway-seam2.integration.spec.ts | app path **✎**; `../src/workspace-gateway.ts` ok | `@deepseek-ai/cordis` | — | — |
| workspace-gateway.spec.ts | `../src/workspace-gateway.ts` ok | `@deepseek-ai/cordis`, `dsh-typert-protocol` | — | — |
| workspace-host-residual.integration.spec.ts | `../src/workspace-host.ts` ok | — | — | — |
| workspace-host.integration.spec.ts | app path **✎**; `../src/workspace-host.ts` ok | — | — | — |
| workspace-http-gaps.spec.ts | `../src/workspace-http.ts` ok | — | — | — |
| workspace-http-gaps2.spec.ts | `../src/workspace-http.ts` ok | — | — | — |
| workspace-http-matrix.spec.ts | `../src/workspace-http.ts` ok | — | — | — |
| workspace-http-residual.spec.ts | `../src/workspace-http.ts` ok | — | — | — |
| workspace-http-sse-decoding.spec.ts | `../src/workspace-http.ts` ok | — | — | — |
| workspace-http-vocabulary.spec.ts | `../src/workspace-http.ts` ok | — | — | — |
| workspace-pagination.spec.ts | `../src/workspace-host.ts` ok | — | — | — |
| workspace-plan.spec.ts | `../src/workspace-http.ts`, `workspace-host.ts` ok | — | — | — |
| workspace-provenance.spec.ts | app path **✎**; `../src/workspace-host.ts` ok | — | — | — |
| workspace-stream-events.spec.ts | `../src/workspace-host.ts` ok | — | — | — |
| workspace-stream.spec.ts | `../src/workspace-host.ts` ok | — | — | — |
| workspace-strict-parsing.spec.ts | `../src/workspace-http.ts`, `workspace-host.ts` ok | — | — | — |

Also imported by every file: `vitest`; `node:*` builtins (`node:crypto`, `node:fs/promises`, `node:http`,
`node:net`, `node:os`, `node:path`) — no action needed.

### 2.2 Browser half — `packages\client\ui-ai-coding-platform\tests` (43 files)

| File | R (target status) | D | N | H |
| --- | --- | --- | --- | --- |
| agent-config-editor.client.spec.tsx | `../src/client/agent-config/AgentConfigEditor` ok | `@deepseek-ai/dsh-api-remotes/client` *(type-only)* | `@testing-library/react` | — |
| agent-config-editor.model.client.spec.ts | `../src/client/cloud-workspaces/agent-config-editor.ts` ok | — | `@testing-library/react` (`cleanup`) | — |
| agent-config.client.spec.tsx | `../src/client/agent-config/AgentConfigView` ok | `@deepseek-ai/dsh-api-remotes/client` *(type-only)*; `@deepseek-ai/dsh-ai-coding-platform/workspace-host` **✎ value import, 404 on npm** | `@testing-library/react` | — |
| appearance.model.client.spec.ts | `../src/client/appearance.ts` ok | — | — | — |
| cloud-workspaces-checkpoint.client.spec.tsx | `../src/client/cloud-workspaces/CloudWorkspacesView` ok | `@deepseek-ai/dsh-api-remotes/client` *(type-only)* | `@testing-library/react` | — |
| cloud-workspaces-code-source.spec.tsx | `../src/client/cloud-workspaces/CloudWorkspacesView` ok | `@deepseek-ai/dsh-api-remotes/client` *(type-only)* | `@testing-library/react` | — |
| cloud-workspaces-isolation.spec.tsx | `../src/client/cloud-workspaces/CloudWorkspacesView` ok | `@deepseek-ai/dsh-api-remotes/client` *(type-only)* | `@testing-library/react` | — |
| cloud-workspaces-layout.client.spec.tsx | `../src/client/cloud-workspaces/CloudWorkspacesView` ok | `@deepseek-ai/dsh-api-remotes/client` *(type-only)* | `@testing-library/react` | — |
| cloud-workspaces-plan.client.spec.tsx | `../src/client/cloud-workspaces/CloudWorkspacesView` ok | `@deepseek-ai/dsh-api-remotes/client` *(type-only)* | `@testing-library/react` | — |
| cloud-workspaces.client.spec.tsx | `../src/client/cloud-workspaces/CloudWorkspacesView` ok | `@deepseek-ai/dsh-api-remotes/client` *(type-only)*; `@deepseek-ai/dsh-ai-coding-platform/workspace-host` **✎ value import, 404 on npm** | `@testing-library/react` | — |
| collector.client.spec.tsx | `../src/client/PlatformSurface.tsx`, `controller.ts` ok | `@deepseek-ai/dsh-api-remotes/client` *(type-only)* | `@testing-library/react` | — |
| context-lens.client.spec.tsx | `../src/client/cloud-workspaces/CloudWorkspacesView` ok | `@deepseek-ai/dsh-api-remotes/client` *(type-only)* | `@testing-library/react` | — |
| context-lens.model.client.spec.ts | `../src/client/cloud-workspaces/context-lens.ts` ok | — | — | — |
| controller.client.spec.ts | `../src/client/controller.ts` ok | — | — | — |
| host-entry.client.spec.ts | `../src/index.ts` **✎ target has no UI `src/index.ts`** → `../src/client-node/index.ts` (verified identical content: `export function apply(): void {}`) | — | — | — |
| knowledge-search-state.client.spec.ts | `../src/client/knowledge-search-state.ts` ok | `@deepseek-ai/dsh-ai-coding-platform/types` **✎ type-only, 404 on npm** | — | — |
| layout-presets.model.client.spec.ts | `../src/client/cloud-workspaces/layout-presets.ts` ok | — | — | — |
| locales.client.spec.ts | `../src/client/locales.ts` ok | — | — | — |
| memory-recall.client.spec.ts | `../src/client/memory-recall.ts` ok | `@deepseek-ai/dsh-ai-coding-platform/types` **✎ type-only** | — | — |
| operation-evidence.client.spec.ts | `../src/client/cloud-workspaces/operation-evidence.ts` ok | `@deepseek-ai/dsh-ai-coding-platform/types` **✎ type-only** | — | — |
| platform-entry.client.spec.tsx | `../src/client/PlatformEntry.tsx`, `locales.ts` ok | — | `@testing-library/react` | — |
| platform.client.spec.tsx | `../src/client/PlatformSurface.tsx`, `PlatformEntry.tsx`, `controller.ts` ok | `@deepseek-ai/dsh-api-remotes/client` *(type-only)*; `@deepseek-ai/dsh-client-runtime/client` **✎ type-only, no 0.1.5-rc.2 on npm** | `@testing-library/react` | — |
| plugin-registration.client.spec.ts | `../src/client/index.ts`, `locales.ts` ok | — | — | — |
| preview-security.model.client.spec.ts | `../src/client/cloud-workspaces/preview-security.ts` ok | — | — | — |
| recovery-center-model.client.spec.ts | `../src/client/cloud-workspaces/recovery-center.ts` ok | `@deepseek-ai/dsh-ai-coding-platform/types` **✎ type-only** | — | — |
| recovery-center.client.spec.tsx | `../src/client/cloud-workspaces/CloudWorkspacesView` ok | `@deepseek-ai/dsh-api-remotes/client` *(type-only)* | `@testing-library/react` | — |
| recovery-center.model.client.spec.ts | `../src/client/cloud-workspaces/recovery-center.ts` ok | `@deepseek-ai/dsh-ai-coding-platform/types` **✎ type-only** | — | — |
| run-approval-drawer.client.spec.tsx | `../src/client/cloud-workspaces/CloudWorkspacesView` ok | `@deepseek-ai/dsh-api-remotes/client` *(type-only)* | `@testing-library/react` | — |
| run-asset-snapshot-model.client.spec.ts | `../src/client/cloud-workspaces/run-asset-snapshot.ts` ok | `@deepseek-ai/dsh-ai-coding-platform/types` **✎ type-only** | — | — |
| run-asset-snapshot.client.spec.tsx | `../src/client/cloud-workspaces/CloudWorkspacesView` ok | `@deepseek-ai/dsh-api-remotes/client` *(type-only)* | `@testing-library/react` | — |
| run-asset-snapshot.model.client.spec.ts | `../src/client/cloud-workspaces/run-asset-snapshot.ts` ok | — | — | — |
| run-pulse.client.spec.tsx | `../src/client/cloud-workspaces/CloudWorkspacesView` ok | `@deepseek-ai/dsh-api-remotes/client` *(type-only)* | `@testing-library/react` | — |
| run-pulse.model.client.spec.ts | `../src/client/cloud-workspaces/run-pulse.ts` ok | — | — | — |
| team-skills-installed-state.client.spec.tsx | `../src/client/team-skills/TeamSkillsView.tsx` ok | `@deepseek-ai/dsh-api-remotes/client` *(type-only)*; `@deepseek-ai/dsh-client-runtime/client` **✎ type-only** | `@testing-library/react` | — |
| team-skills-stages.client.spec.tsx | `../src/client/team-skills/TeamSkillsView.tsx` ok | `@deepseek-ai/dsh-api-remotes/client` *(type-only)*; `@deepseek-ai/dsh-client-runtime/client` **✎ type-only** | `@testing-library/react` | — |
| team-skills-trust-card.client.spec.tsx | `../src/client/team-skills/TeamSkillsView.tsx` ok | `@deepseek-ai/dsh-api-remotes/client` *(type-only)*; `@deepseek-ai/dsh-client-runtime/client` **✎ type-only** | `@testing-library/react` | — |
| team-skills.client.spec.tsx | `../src/client/team-skills/TeamSkillsView.tsx` ok | `@deepseek-ai/dsh-api-remotes/client` *(type-only)*; `@deepseek-ai/dsh-client-runtime/client` **✎ type-only** | `@testing-library/react` | — |
| trust-card.model.client.spec.ts | `../src/client/team-skills/trust-card.ts` ok | `@deepseek-ai/dsh-ai-coding-platform/types` **✎ type-only** | — | — |
| ux-platform.client.spec.tsx | `../src/client/PlatformSurface.tsx`, `controller.ts` ok | `@deepseek-ai/dsh-api-remotes/client` *(type-only)*; `@deepseek-ai/dsh-client-runtime/client` **✎ type-only** | `@testing-library/react` | — |
| ux12-a11y.client.spec.tsx | `../src/client/PlatformSurface.tsx`, `controller.ts` ok | `@deepseek-ai/dsh-api-remotes/client` *(type-only)*; `@deepseek-ai/dsh-client-runtime/client` **✎ type-only** | `@testing-library/react` | — |
| workspace-markers.client.spec.ts | `../src/client/cloud-workspaces/workspace-markers.ts` ok | — | — | — |
| workspace-markers.model.client.spec.ts | `../src/client/cloud-workspaces/workspace-markers.ts` ok | — | — | — |
| workspace-tree-preview.client.spec.tsx | `../src/client/cloud-workspaces/CloudWorkspacesView`, `preview-security.ts` ok | `@deepseek-ai/dsh-api-remotes/client` *(type-only)* | `@testing-library/react` | — |

No `vi.mock()` of any `@deepseek-ai/*` module appears in this directory; no dynamic imports.

### 2.3 `dev\team-skill-service\tests` (30 files)

Uniform shape. Relative imports: `../src/server.ts` (resolves to `dev/team-skill-service/src/server.ts` — exists)
and `./response.ts` (helper inside the tests dir — exists, 6 lines). All specifiers are already correct
for the target layout; **zero `@deepseek-ai/*` imports**.

| Import | Kind | Files |
| --- | --- | --- |
| `vitest` | npm (present) | all 29 specs |
| `node:http`, `node:net` | builtin | most specs |
| `fflate` | other npm (present as a root `dependencies` entry, `^0.8.2`) | skill-auth.spec.ts, skill-release-gate.spec.ts, skill-trust-card.spec.ts |
| `../src/server.ts` | relative, ok | all 29 specs |
| `./response.ts` | helper in tests dir, ok | 15 specs (access, afc02-schema, afc03-pagination, agent-config, denial-audit, knowledge, org-lifecycle-auth, request-validation, service, skill-auth, skill-release-gate, skill-trust-card, telemetry, workspace, workspace-admin; plus `response.ts` itself is the helper) |
| `@deepseek-ai/*` | **none** | — |

### 2.4 `dev\team-skill-admin\tests` (26 files)

| Import | Kind | Files |
| --- | --- | --- |
| `vitest` | npm (present) | all 24 specs |
| `react` | npm (present at root devDeps `^18.3.1`) | admin-dashboard, agent-config-chain.e2e, asset-governance.view, cloud-agent-config, cloud-workspace-admin, cloud-workspace-capability, command-palette.view, load-page-real-reads, page, project-management, telemetry-page-scan, telemetry, workbench-page |
| `@testing-library/react` | npm (**NOT installed anywhere**) | admin-dashboard, agent-config-chain.e2e, asset-governance.view, cloud-agent-config, cloud-workspace-admin, cloud-workspace-capability, command-palette.view, load-page-real-reads, project-management, telemetry-page-scan, telemetry, workbench-page |
| `next-auth/react` | npm (**not a root devDep**) — mocked via `vi.mock('next-auth/react')` in admin-dashboard, load-page-real-reads | admin-dashboard, load-page-real-reads |
| `next/server` | npm (**not a root devDep**) | team-skill-proxy.spec.ts |
| `node:http`, `node:net` | builtin | various |
| `@deepseek-ai/dsh-ai-coding-platform/src/workspace-host` | **`@deepseek-ai/dsh-ai-coding-platform` is 404 on npm** — unresolved in the target as written | agent-config-chain.e2e.spec.tsx |
| `@deepseek-ai/dsh-client-ui-ai-coding-platform/src/client/agent-config/AgentConfigView` | **404 on npm** — unresolved as written | agent-config-chain.e2e.spec.tsx |
| `@deepseek-ai/dsh-api-remotes/client` (dynamic `await import()`) | npm, available at `0.1.5-rc.2` | agent-config-chain.e2e.spec.tsx |
| `../../../apps/team-skill-service/src/server.ts` | **✎ relative path is monorepo-shaped** — must become `../../team-skill-service/src/server.ts` | agent-config-chain.e2e.spec.tsx, cloud-workspace-capability.spec.tsx |
| `../../../apps/team-skill-service/tests/response.ts` | **✎ same** → `../../team-skill-service/tests/response.ts` | cloud-workspace-e2e.spec.ts |
| `../../team-skill-service/src/server.ts` | ok (already target-shaped) | telemetry-page-scan.spec.tsx |
| `./request-capture.ts` | helper in tests dir, ok | agent-config-chain.e2e.spec.tsx |
| `../src/...` | relative, ok (dev/team-skill-admin/src exists) | all specs |
| `vi.mock('../src/auth.ts')` | relative, ok | page.spec.tsx |

> Note: a naive regex sweep flags `field present and empty` in `cloud-workspace-stream.spec.ts` as an
> "import". It is a string literal inside an assertion, not an import. Same for no other file.

Third-party version ranges (from `dev\team-skill-admin\package.json`, verbatim):
`@tanstack/react-query ^5.85.5`, `@tanstack/react-table ^8.21.3`, `lucide-react ^0.468.0`,
`next ^15.5.0`, `next-auth 5.0.0-beta.32`, `react ^18.3.1`, `react-dom ^18.3.1`,
`react-hook-form ^7.62.0`, `zod ^4.1.5`; devDeps `@vitejs/plugin-react ^4.7.0`, `tailwindcss ^4.1.12`.
**Caveat:** that `package.json` also declares `@deepseek-ai/dsh-ai-coding-platform: workspace:*`,
`@deepseek-ai/dsh-api-remotes: workspace:*`, `@deepseek-ai/dsh-client-ui-ai-coding-platform: workspace:*`
— there is **no `pnpm-workspace.yaml` and no `workspaces` field in the target root**, and the two
`@deepseek-ai/dsh-*-ai-coding-platform` names 404 on npm, so `pnpm install` inside `dev/team-skill-admin`
cannot succeed as written. The suite can only run from the target root with root-level deps + fixed
relative specifiers.

### 2.5 The two `vitest.config.ts` files, verbatim

`C:\Users\13588\dev\dsh-ai-coding\dev\team-skill-service\vitest.config.ts` (8 lines):
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
  },
})
```
- `environment`: `'node'`
- `setupFiles`: *absent*
- `plugins`: *absent*
- `alias`: *absent*
- `include`: `['tests/**/*.spec.ts']`

`C:\Users\13588\dev\dsh-ai-coding\dev\team-skill-admin\vitest.config.ts` (12 lines):
```ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react({ jsxRuntime: 'automatic' })],
  esbuild: { jsx: 'automatic', loader: 'tsx', tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } } },
  oxc: { jsx: { runtime: 'automatic', importSource: 'react', development: false } },
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    environment: 'jsdom',
  },
})
```
- `environment`: `'jsdom'`
- `setupFiles`: *absent*
- `plugins`: `[react({ jsxRuntime: 'automatic' })]` (from `@vitejs/plugin-react`)
- `esbuild`: `{ jsx: 'automatic', loader: 'tsx', tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } } }`
- `oxc`: `{ jsx: { runtime: 'automatic', importSource: 'react', development: false } }`
- `alias`: *absent*
- `include`: `['tests/**/*.spec.ts', 'tests/**/*.spec.tsx']`

Neither config declares `alias`, so the two unresolved `@deepseek-ai/*-ai-coding-platform` specifiers in
`agent-config-chain.e2e.spec.tsx` are currently dead imports.

---

## 3. Harness `test-support` dependency analysis

### 3.1 Which `packages/test-support/*` packages the four directories actually use

**None.** A regex sweep for
`@deepseek-ai/dsh-(acp-snapshot|client-test-runtime|loader-smoke|agent-loop-testkit|llm-replay|llm-mock-server|test-support)`
across all 104 monorepo test files and the 56 target dev-suite files returns **zero** hits.
(Those packages are used by *other* monorepo suites — `ui-workspace`, `ui-tool`, `ui-conversation`,
`subagent*`, `compaction-basic`, `schedule`, `hooks-*`, etc. — which are **out of scope** here.)

The one test-support-shaped dependency that *is* used is a **plain file**, not a package:

| Used by | Specifier | What it provides | npm status |
| --- | --- | --- | --- |
| context-ledger.spec.ts, gateway-live-session.integration.spec.ts, knowledge-loop.spec.ts, memory-loop.spec.ts, telemetry-backend.spec.ts, telemetry-gateway.integration.spec.ts, telemetry-loop.integration.spec.ts (7 files) | `../../../core/agent-loop/tests/mock-adapter.ts` | `MockAdapter` (extends `LlmAdapter`), `textResponse`, plus `maxTokensResponse` / `toolCallResponse` / `HangAfter` that the 7 files do not use | **Not on npm and not exported by any package.** `packages/core/agent-loop/package.json#files` = `lib/index.js, lib/invariant.js, lib/types/**/*.d.ts`; `exports` has only `.` and `./invariant`. `<B>\packages\test-support\agent-loop-testkit@0.1.1-rc.2` exports only `.` / `./invariant`, and the published `0.1.5-rc.2` manifest exports only `.` / `./src/*`; neither ships a `mock-adapter`. `grep -r "class MockAdapter" packages/test-support` → no matches. |

**Substitution cost:** the file is 133 lines, self-contained, and imports only
`CallId`, `LlmAdapter`, and types from `@deepseek-ai/dsh-llm` (available at `0.1.5-rc.2`). Copying it to
`<root>/tests/helpers/mock-adapter.ts` and rewriting the 7 specifiers to `./helpers/mock-adapter.ts`
(both the 7 files and the helper are in `tests/`) is sufficient. The 7 files do **not** need
`mountAgentLoopTestDependencies`: they mount `Context` + `LlmRuntime` + `SessionStore` + `SystemPrompt`
+ `ToolRuntime` + `AgentRegistry` + `AgentLoop` explicitly, which is why only the mock adapter is missing.

### 3.2 npm availability verdicts for the six `packages/test-support/*` packages

Queried with `Invoke-RestMethod` against `https://registry.npmjs.org/@deepseek-ai%2F<name>` (`-TimeoutSec 90`,
up to 3 attempts with a 4 s backoff). Raw records in Appendix A.

| Package (npm name) | Exists on npm? | `0.1.5-rc.2` present? | Versions found | Used by the four dirs? |
| --- | --- | --- | --- | --- |
| `@deepseek-ai/dsh-acp-snapshot` | **yes** | **NO** | 10: `0.0.1-rc.1, 0.0.1-rc.2, 0.0.1-rc.5, 0.1.0-rc.2, 0.1.0-rc.3, 0.1.0-rc.6, 0.1.0-rc.7, 0.1.0-rc.8, 0.1.1-rc.1, 0.1.1-rc.2` (latest tag `0.0.1-rc.1`) | no |
| `@deepseek-ai/dsh-client-test-runtime` | **yes** | **yes** | 22: `…0.1.1-rc.2, 0.1.2-alpha.2…0.1.2-rc.1, 0.1.3-alpha.2, 0.1.5-alpha.1, 0.1.5-alpha.2, 0.1.5-rc.1, 0.1.5-rc.2, 0.1.6-alpha.1, 0.1.6-alpha.2` (latest tag `0.0.1-rc.1`) | no |
| `@deepseek-ai/dsh-loader-smoke` | **yes** | **yes** | same 22-version shape as above | no |
| `@deepseek-ai/dsh-agent-loop-testkit` | **yes** | **yes** | same 22-version shape as above | no |
| `@deepseek-ai/dsh-llm-mock-server` | **yes** | **yes** | same 22-version shape as above | no |
| `@deepseek-ai/dsh-llm-replay` | **yes** | **yes** | same 22-version shape as above | no |

**Conclusion for §3:** no test file in scope needs a test-support package, therefore **no test is
EXEMPT for a missing harness package**. The only true gap is the un-published `mock-adapter.ts`
helper, which is substituted by inlining (finding 3 in §0).

---

## 4. Target-repo test dependency summary

### 4.1 `dev/team-skill-service/tests`

Third-party npm imports: `vitest` (all 29 specs), `fflate` (3 specs), `node:http` / `node:net`.
**`@deepseek-ai/*` imports: none.** Helper module: `./response.ts` (6 lines, in-dir).
Cross-package: `../src/server.ts` only (the fixture server itself).

### 4.2 `dev/team-skill-admin/tests`

Third-party npm imports: `vitest`, `react`, `@testing-library/react`, `next-auth/react`,
`next/server`, `node:http`, `node:net`.
**`@deepseek-ai/*` imports: yes, and both are unresolvable in the target:**
- `@deepseek-ai/dsh-ai-coding-platform/src/workspace-host` — npm **404**; target package is `dsh-ai-coding`.
- `@deepseek-ai/dsh-client-ui-ai-coding-platform/src/client/agent-config/AgentConfigView` — npm **404**.
- plus a dynamic `await import('@deepseek-ai/dsh-api-remotes/client')` — available at `0.1.5-rc.2`.

No `@testing-library/jest-dom` and no jest-dom matchers (`toBeInTheDocument`, `toHaveClass`,
`toHaveAttribute`, `toHaveTextContent`) anywhere in the four directories — a `setupFiles` entry is
therefore **not** required for matchers, only `jsdom` for the DOM itself.

Configs are reproduced verbatim in §2.5.

---

## 5. Port recommendation per monorepo test file

Rules applied (evidence-only):
- The target `src/` contains a counterpart for **every** `../src/...` import; the `../src/...` specifier
  itself is already correct for `<root>/tests/`. → no rewrite for those.
- `../../../../apps/team-skill-service/src/server.ts` → **rewrite** to `../dev/team-skill-service/src/server.ts`
  (fixture verified byte-identical).
- `../../../core/agent-loop/tests/mock-adapter.ts` → **inline** the 133-line helper at
  `tests/helpers/mock-adapter.ts` and rewrite the specifier.
- `@deepseek-ai/dsh-ai-coding-platform/types` (type-only, npm 404) → **rewrite** to `../src/types.ts`.
- `@deepseek-ai/dsh-ai-coding-platform/workspace-host` (value, npm 404) → **rewrite** to `../src/workspace-host.ts`.
- `../src/index.ts` in `host-entry.client.spec.ts` → **rewrite** to `../src/client-node/index.ts`
  (the target's UI host entry; contents verified identical to the monorepo UI `src/index.ts`).
- `@deepseek-ai/dsh-client-runtime/client` (type-only; no `0.1.5-rc.2` on npm) → does **not** block
  `vitest run` because `import type` is erased; needs either a local type alias or the older
  `0.1.1-rc.2` devDep if `tsc` is ever pointed at `tests/`.

### 5.1 Host half (61 files)

| File | Recommendation | Required rewrites |
| --- | --- | --- |
| agent-profile-parse.spec.ts | **PORT** | none |
| blueprint-tables.spec.ts | **PORT** | none |
| context-ledger.spec.ts | **PORT** | inline `mock-adapter` → `./helpers/mock-adapter.ts` |
| context-lens-parse.spec.ts | **PORT** | none |
| gateway-install-wiring.integration.spec.ts | **PORT** | app server path → `../dev/team-skill-service/src/server.ts` |
| gateway-live-session.integration.spec.ts | **PORT** | app server path; inline `mock-adapter` |
| gateway-matrix.spec.ts | **PORT** | app server path |
| gateway-seam-remaining.integration.spec.ts | **PORT** | app server path |
| gateway-seam.integration.spec.ts | **PORT** | app server path |
| gateway.spec.ts | **PORT** | none |
| host-installation-states.integration.spec.ts | **PORT** | app server path |
| host-residual-closure.integration.spec.ts | **PORT** | app server path |
| host-service.integration.spec.ts | **PORT** | app server path |
| host-unreachable-matrix.integration.spec.ts | **PORT** | app server path |
| host.spec.ts | **PORT** | none |
| http-client-options.spec.ts | **PORT** | none |
| http-parser-vocabulary.spec.ts | **PORT** | none |
| install-failure-request-id.spec.ts | **PORT** | none |
| install-stages.spec.ts | **PORT** | none |
| installation-store.spec.ts | **PORT** | none |
| installer-matrix.spec.ts | **PORT** | none |
| installer.spec.ts | **PORT** | none |
| invariant.spec.ts | **PORT** | none |
| knowledge-loop.spec.ts | **PORT** | inline `mock-adapter` |
| knowledge-search-parse.spec.ts | **PORT** | none |
| knowledge.spec.ts | **PORT** | none |
| loop-utils.spec.ts | **PORT** | none |
| memory-loop.spec.ts | **PORT** | inline `mock-adapter` |
| project-memory.spec.ts | **PORT** | none |
| run-asset-snapshot.spec.ts | **PORT** | none |
| run-checkpoint.spec.ts | **PORT** | none |
| telemetry-backend.spec.ts | **PORT** | inline `mock-adapter` |
| telemetry-gateway.integration.spec.ts | **PORT** | app server path; inline `mock-adapter` |
| telemetry-loop.integration.spec.ts | **PORT** | app server path; inline `mock-adapter` |
| telemetry-projection.spec.ts | **PORT** | none (type-only `dsh-session-telemetry`) |
| telemetry-queue.spec.ts | **PORT** | none |
| telemetry-reporter.spec.ts | **PORT** | none |
| telemetry-sanitize.spec.ts | **PORT** | none |
| telemetry-sensitive-scan.spec.ts | **PORT** | app server path |
| telemetry-settings.spec.ts | **PORT** | none |
| trust-card-parse.spec.ts | **PORT** | none |
| workspace-base-url.spec.ts | **PORT** | none |
| workspace-credentials.spec.ts | **PORT** | none |
| workspace-gateway-lifecycle.integration.spec.ts | **PORT** | app server path |
| workspace-gateway-seam.integration.spec.ts | **PORT** | app server path |
| workspace-gateway-seam2.integration.spec.ts | **PORT** | app server path |
| workspace-gateway.spec.ts | **PORT** | none |
| workspace-host-residual.integration.spec.ts | **PORT** | none |
| workspace-host.integration.spec.ts | **PORT** | app server path |
| workspace-http-gaps.spec.ts | **PORT** | none |
| workspace-http-gaps2.spec.ts | **PORT** | none |
| workspace-http-matrix.spec.ts | **PORT** | none |
| workspace-http-residual.spec.ts | **PORT** | none |
| workspace-http-sse-decoding.spec.ts | **PORT** | none |
| workspace-http-vocabulary.spec.ts | **PORT** | none |
| workspace-pagination.spec.ts | **PORT** | none |
| workspace-plan.spec.ts | **PORT** | none |
| workspace-provenance.spec.ts | **PORT** | app server path |
| workspace-stream-events.spec.ts | **PORT** | none |
| workspace-stream.spec.ts | **PORT** | none |
| workspace-strict-parsing.spec.ts | **PORT** | none |

Sub-totals: 61 PORT, of which 17 need the service-path rewrite and 7 need the inlined helper.

### 5.2 Browser half (43 files)

| File | Recommendation | Required rewrites |
| --- | --- | --- |
| agent-config-editor.client.spec.tsx | **PORT** | none |
| agent-config-editor.model.client.spec.ts | **PORT** | none |
| agent-config.client.spec.tsx | **PORT** | `@deepseek-ai/dsh-ai-coding-platform/workspace-host` → `../src/workspace-host.ts` |
| appearance.model.client.spec.ts | **PORT** | none |
| cloud-workspaces-checkpoint.client.spec.tsx | **PORT** | none |
| cloud-workspaces-code-source.spec.tsx | **PORT** | none |
| cloud-workspaces-isolation.spec.tsx | **PORT** | none |
| cloud-workspaces-layout.client.spec.tsx | **PORT** | none |
| cloud-workspaces-plan.client.spec.tsx | **PORT** | none |
| cloud-workspaces.client.spec.tsx | **PORT** | `@deepseek-ai/dsh-ai-coding-platform/workspace-host` → `../src/workspace-host.ts` |
| collector.client.spec.tsx | **PORT** | none |
| context-lens.client.spec.tsx | **PORT** | none |
| context-lens.model.client.spec.ts | **PORT** | none |
| controller.client.spec.ts | **PORT** | none |
| host-entry.client.spec.ts | **PORT** | `../src/index.ts` → `../src/client-node/index.ts` |
| knowledge-search-state.client.spec.ts | **PORT** | `/types` → `../src/types.ts` |
| layout-presets.model.client.spec.ts | **PORT** | none |
| locales.client.spec.ts | **PORT** | none |
| memory-recall.client.spec.ts | **PORT** | `/types` → `../src/types.ts` |
| operation-evidence.client.spec.ts | **PORT** | `/types` → `../src/types.ts` |
| platform-entry.client.spec.tsx | **PORT** | none |
| platform.client.spec.tsx | **PORT** | none at runtime (`dsh-client-runtime/client` is `import type`) |
| plugin-registration.client.spec.ts | **PORT** | none |
| preview-security.model.client.spec.ts | **PORT** | none |
| recovery-center-model.client.spec.ts | **PORT** | `/types` → `../src/types.ts` |
| recovery-center.client.spec.tsx | **PORT** | none |
| recovery-center.model.client.spec.ts | **PORT** | `/types` → `../src/types.ts` |
| run-approval-drawer.client.spec.tsx | **PORT** | none |
| run-asset-snapshot-model.client.spec.ts | **PORT** | `/types` → `../src/types.ts` |
| run-asset-snapshot.client.spec.tsx | **PORT** | none |
| run-asset-snapshot.model.client.spec.ts | **PORT** | none |
| run-pulse.client.spec.tsx | **PORT** | none |
| run-pulse.model.client.spec.ts | **PORT** | none |
| team-skills-installed-state.client.spec.tsx | **PORT** | none at runtime |
| team-skills-stages.client.spec.tsx | **PORT** | none at runtime |
| team-skills-trust-card.client.spec.tsx | **PORT** | none at runtime |
| team-skills.client.spec.tsx | **PORT** | none at runtime |
| trust-card.model.client.spec.ts | **PORT** | `/types` → `../src/types.ts` |
| ux-platform.client.spec.tsx | **PORT** | none at runtime |
| ux12-a11y.client.spec.tsx | **PORT** | none at runtime |
| workspace-markers.client.spec.ts | **PORT** | none |
| workspace-markers.model.client.spec.ts | **PORT** | none |
| workspace-tree-preview.client.spec.tsx | **PORT** | none |

Sub-totals: 43 PORT — 2 value-import rewrites, 7 type-import rewrites, 1 host-entry rewrite.

### 5.3 Summary

| Recommendation | Count |
| --- | --- |
| **PORT** | **104** |
| **PORT-WITH-EXEMPTION** | **0** |
| **EXEMPT** | **0** |

Residual (non-import) risks that could still turn a PORT into a failure — these are **not** import
obstacles and are outside what this survey could verify by reading:
- API drift of the target `src/**` against the `0.1.5-rc.2` baseline (task 3 of `docs/ADAPTATION-GOAL.md`).
  The 7 mock-adapter suites and the 17 service-integration suites mount real cordis contexts and a real
  HTTP fixture server, so they are the most drift-sensitive.
- `telemetry-queue.spec.ts` dynamically imports `node:sqlite`; host Node version must support it.
- The two 1000-line telemetry integration suites (`telemetry-gateway`, `telemetry-loop`) are the
  heaviest files (1011 / 922 lines) and will dominate wall time.

If any of these files must be held back for drift reasons rather than import reasons, they would be
`EXEMPT` on *drift*, not on npm availability — the npm-availability axis is clean.

---

## 6. Consolidated root `devDependencies`

Baseline: everything `@deepseek-ai/*` pinned to **`0.1.5-rc.2`** where that version exists.

### 6.1 Must ADD to `C:\Users\13588\dev\dsh-ai-coding\package.json#devDependencies`

| Package | Version | Why (which suites) |
| --- | --- | --- |
| `@deepseek-ai/dsh-agent-loop` | `0.1.5-rc.2` | value import `AgentLoop` — 7 mock-adapter suites (context-ledger, gateway-live-session, knowledge-loop, memory-loop, telemetry-backend, telemetry-gateway, telemetry-loop). Available on npm at `0.1.5-rc.2` (verified). |
| `@deepseek-ai/dsh-system-prompt` | `0.1.5-rc.2` | value import — same 7 suites. Available at `0.1.5-rc.2`. |
| `@deepseek-ai/dsh-tools` | `0.1.5-rc.2` | value import `ToolRuntime` — same 7 suites. Available at `0.1.5-rc.2`. |
| `@testing-library/react` | `^16.3.2` | 24 UI specs + 12 admin specs (npm latest verified `16.3.3`; `^16.3.2` is the range the reference monorepo pins) |
| `@testing-library/dom` | `^10.4.1` | peer dependency of `@testing-library/react@16`; pinned by the reference monorepo root (npm latest verified `10.4.2`) |
| `jsdom` | `^29.1.1` | required by the 24 `// @vitest-environment jsdom` UI specs and by `dev/team-skill-admin`'s `environment: 'jsdom'` config (npm latest verified `30.1.0`; `29.1.1` is the monorepo-pinned version) |

### 6.2 Already present — no change needed (verified against the current root manifest)

`@deepseek-ai/cordis ^4.0.2` · `@deepseek-ai/dsh-agent 0.1.5-rc.2` ·
`@deepseek-ai/dsh-api-remotes 0.1.5-rc.2` · `@deepseek-ai/dsh-invariants 0.1.5-rc.2` ·
`@deepseek-ai/dsh-llm 0.1.5-rc.2` · `@deepseek-ai/dsh-session 0.1.5-rc.2` ·
`@deepseek-ai/dsh-client-ui-primitives 0.1.5-rc.2` (transitively value-imported by `src/client/**`) ·
`@deepseek-ai/dsh-client-locale`, `dsh-client-ui-layout`, `dsh-client-ui-sidebar`, `dsh-client-modules`,
`dsh-invariants`, `dsh-skill`; and in `dependencies`: `@deepseek-ai/dsh-credentials 0.1.5-rc.2`,
`@deepseek-ai/dsh-session-telemetry 0.1.5-rc.2`, `@deepseek-ai/dsh-typert-protocol 0.1.5-rc.2`,
`@deepseek-ai/dsh-atomic-write 0.1.5-rc.2`, `@deepseek-ai/dsh-workspace 0.1.5-rc.2`,
`@deepseek-ai/schemastery ^3.18.2`, `fflate ^0.8.2`, `yaml ^2.4.2`; plus `react ^18.3.1`,
`react-dom ^18.3.1`, `vitest ^4.1.8`, `typescript ^6.0.3`, `tsx ^4.22.4`, `@types/node ^22.20.0`.

### 6.3 Deliberately NOT added (with reasons)

| Package | Reason |
| --- | --- |
| `@deepseek-ai/dsh-ai-coding-platform` | **404 on npm.** Only used by UI specs as a *value* import for `WorkspaceHost` (2 files) and as a *type* import for `/types` (7 files). Both are replaced by relative imports into `src/`. |
| `@deepseek-ai/dsh-client-ui-ai-coding-platform` | **404 on npm.** Used as a value import by `dev/team-skill-admin/tests/agent-config-chain.e2e.spec.tsx` — needs a local relative/alias fix, not a dependency. |
| `@deepseek-ai/dsh-client-runtime` | Exists on npm but **`0.1.5-rc.2` does not** (max `0.1.1-rc.2`; 11 versions). All 7 uses are `import type { WorkspaceListState }` / `SessionId`, erased at transform time, so `vitest run` passes without it. If `tests/` is ever added to a typechecked project, prefer a local `type` alias over installing a version two releases behind the baseline. |
| `@deepseek-ai/dsh-acp-snapshot` | Not used by any in-scope test; also lacks `0.1.5-rc.2` (max `0.1.1-rc.2`). |
| `@deepseek-ai/dsh-client-test-runtime`, `dsh-loader-smoke`, `dsh-agent-loop-testkit`, `dsh-llm-mock-server`, `dsh-llm-replay` | Not used by any in-scope test (all six exist and all but `acp-snapshot` do have `0.1.5-rc.2`). Add only if a later, wider port needs them. |
| `@testing-library/jest-dom` | Zero jest-dom matchers in all four directories. |
| `@types/jsdom` | Type-only convenience; not needed to run. |
| `@vitejs/plugin-react` | Not required by any monorepo suite (their configs use `vite-tsconfig-paths` + default esbuild TSX). It **is** required if a single root config reuses `dev/team-skill-admin`'s plugin chain — it is already declared in `dev/team-skill-admin/package.json` at `^4.7.0`. |

### 6.4 Secondary block — needed only if the two `dev/*` suites also run from the root `vitest run`

There is no `pnpm-workspace.yaml`, so `dev/team-skill-admin/tests/team-skill-proxy.spec.ts` (`next/server`)
and `admin-dashboard.spec.tsx` / `load-page-real-reads.spec.tsx` (`next-auth/react`) will only resolve
from the root `node_modules`:

`next ^15.5.0` · `next-auth 5.0.0-beta.32` · `@tanstack/react-query ^5.85.5` ·
`@tanstack/react-table ^8.21.3` · `lucide-react ^0.468.0` · `react-hook-form ^7.62.0` · `zod ^4.1.5` ·
`tailwindcss ^4.1.12` (and `@vitejs/plugin-react ^4.7.0` if the admin config is folded into the root config).

### 6.5 Applied diff for the monorepo suites (ready to paste)

```jsonc
// package.json → devDependencies  (ADD these six; all other imports are already satisfied)
"@deepseek-ai/dsh-agent-loop": "0.1.5-rc.2",
"@deepseek-ai/dsh-system-prompt": "0.1.5-rc.2",
"@deepseek-ai/dsh-tools": "0.1.5-rc.2",
"@testing-library/dom": "^10.4.1",
"@testing-library/react": "^16.3.2",
"jsdom": "^29.1.1"
```

---

## Appendix A — raw npm availability query results

Method: `Invoke-RestMethod 'https://registry.npmjs.org/@deepseek-ai%2F<name>' -TimeoutSec 90`,
up to 3 attempts, 4 s sleep between attempts; `404` short-circuits. Query timestamp: single survey run;
results cached to `%TEMP%\npm-probe.jsonl` and `%TEMP%\npm-probe2.jsonl`.

| Query (npm name) | Verdict | `dist-tags.latest` | # versions | Has `0.1.5-rc.2`? | Versions found |
| --- | --- | --- | --- | --- | --- |
| `@deepseek-ai/dsh-acp-snapshot` | OK | `0.0.1-rc.1` | 10 | **no** | 0.0.1-rc.1, 0.0.1-rc.2, 0.0.1-rc.5, 0.1.0-rc.2, 0.1.0-rc.3, 0.1.0-rc.6, 0.1.0-rc.7, 0.1.0-rc.8, 0.1.1-rc.1, 0.1.1-rc.2 |
| `@deepseek-ai/dsh-client-test-runtime` | OK | `0.0.1-rc.1` | 22 | yes | 0.0.1-rc.1, 0.0.1-rc.2, 0.0.1-rc.5, 0.1.0-rc.2, 0.1.0-rc.3, 0.1.0-rc.6, 0.1.0-rc.7, 0.1.0-rc.8, 0.1.1-rc.1, 0.1.1-rc.2, 0.1.2-alpha.2, 0.1.2-alpha.3, 0.1.2-alpha.4, 0.1.2-alpha.5, 0.1.2-rc.1, 0.1.3-alpha.2, 0.1.5-alpha.1, 0.1.5-alpha.2, 0.1.5-rc.1, 0.1.5-rc.2, 0.1.6-alpha.1, 0.1.6-alpha.2 |
| `@deepseek-ai/dsh-loader-smoke` | OK | `0.0.1-rc.1` | 22 | yes | (same list as above) |
| `@deepseek-ai/dsh-agent-loop-testkit` | OK | `0.0.1-rc.1` | 22 | yes | (same list as above) |
| `@deepseek-ai/dsh-llm-mock-server` | OK | `0.0.1-rc.1` | 22 | yes | (same list as above) |
| `@deepseek-ai/dsh-llm-replay` | OK | `0.0.1-rc.1` | 22 | yes | (same list as above) |
| `@deepseek-ai/dsh-ai-coding-platform` | **404 NOT FOUND** | — | 0 | no | — |
| `@deepseek-ai/dsh-client-ui-ai-coding-platform` | **404 NOT FOUND** | — | 0 | no | — |
| `@deepseek-ai/dsh-client-runtime` | OK | `0.0.1-rc.1` | 11 | **no** | 0.0.1-rc.1, 0.0.1-rc.2, 0.0.1-rc.3, 0.0.1-rc.5, 0.1.0-rc.2, 0.1.0-rc.3, 0.1.0-rc.6, 0.1.0-rc.7, 0.1.0-rc.8, 0.1.1-rc.1, 0.1.1-rc.2 |
| `@deepseek-ai/dsh-api-remotes` | OK | `0.0.1-rc.1` | 23 | yes | 0.0.1-rc.1, 0.0.1-rc.2, 0.0.1-rc.3, 0.0.1-rc.5, 0.1.0-rc.2, 0.1.0-rc.3, 0.1.0-rc.6, 0.1.0-rc.7, 0.1.0-rc.8, 0.1.1-rc.1, 0.1.1-rc.2, 0.1.2-alpha.2…0.1.2-rc.1, 0.1.3-alpha.2, 0.1.5-alpha.1, 0.1.5-alpha.2, 0.1.5-rc.1, 0.1.5-rc.2, 0.1.6-alpha.1, 0.1.6-alpha.2 |
| `@deepseek-ai/dsh-system-prompt` | OK | `0.0.1-rc.1` | 23 | yes | (same shape as `dsh-api-remotes`) |
| `@deepseek-ai/dsh-tools` | OK | `0.0.1-rc.1` | 23 | yes | (same shape) |
| `@deepseek-ai/dsh-agent-loop` | OK | `0.1.0-rc.6` | 23 | yes | (same shape) |
| `@deepseek-ai/dsh-agent` | OK | `0.1.0-rc.6` | 23 | yes | (same shape) |
| `@deepseek-ai/dsh-session` | OK | `0.0.1-rc.1` | 23 | yes | (same shape) |
| `@deepseek-ai/dsh-llm` | OK | `0.0.1-rc.1` | 23 | yes | (same shape) |
| `@deepseek-ai/dsh-invariants` | OK | `0.0.1-rc.1` | 22 | yes | (same shape, 22 entries) |
| `@deepseek-ai/dsh-session-telemetry` | OK | `0.0.1-rc.1` | 22 | yes | (same shape, 22 entries) |
| `@deepseek-ai/dsh-credentials` | OK | `0.0.1-rc.1` | 23 | yes | (same shape) |
| `@deepseek-ai/dsh-typert-protocol` | OK | `0.1.0-rc.6` | 21 | yes | 0.0.1-rc.3, 0.0.1-rc.5, 0.1.0-rc.2, 0.1.0-rc.3, 0.1.0-rc.6, 0.1.0-rc.7, 0.1.0-rc.8, 0.1.1-rc.1, 0.1.1-rc.2, 0.1.2-alpha.2…0.1.2-rc.1, 0.1.3-alpha.2, 0.1.5-alpha.1, 0.1.5-alpha.2, 0.1.5-rc.1, 0.1.5-rc.2, 0.1.6-alpha.1, 0.1.6-alpha.2 |
| `@deepseek-ai/dsh-workspace` | OK | `0.0.1-rc.1` | 23 | yes | (same shape) |
| `@deepseek-ai/dsh-atomic-write` | OK | `0.0.1-rc.1` | 22 | yes | (same shape, 22 entries) |
| `@deepseek-ai/dsh-client-ui-primitives` | OK | `0.0.1-rc.1` | 23 | yes | (same shape) |
| `@deepseek-ai/dsh-client-ui-slots` | OK | `0.0.1-rc.1` | 23 | yes | (same shape) |
| `@deepseek-ai/dsh-client-modules` | OK | `0.0.1-rc.1` | 23 | yes | (same shape) |
| `@deepseek-ai/dsh-client-locale` | OK | `0.0.1-rc.1` | 23 | yes | (same shape) |
| `@deepseek-ai/dsh-skill` | OK | `0.0.1-rc.1` | 23 | yes | (same shape) |
| `@deepseek-ai/dsh-client-ui-layout` | OK | `0.0.1-rc.1` | 23 | yes | (same shape) |
| `@deepseek-ai/dsh-client-ui-sidebar` | OK | `0.0.1-rc.1` | 23 | yes | (same shape) |
| `@deepseek-ai/dsh-client-connection` | OK | `0.0.1-rc.1` | 23 | yes | (same shape) |
| `@deepseek-ai/dsh-client-ui-workspace` | OK | `0.0.1-rc.1` | 23 | yes | (same shape) |
| `@testing-library/react` | OK | `16.3.3` | — | n/a | not an `@deepseek-ai` package; queried directly |
| `@testing-library/dom` | OK | `10.4.2` | — | n/a | queried directly |
| `jsdom` | OK | `30.1.0` | — | n/a | queried directly |

**Query failures: none.** No entry had to be recorded as "query failed / unverified"; every request
succeeded on the first attempt (no retries were needed).

Additional manifest-level evidence fetched from the registry:
- `GET /@deepseek-ai/dsh-agent-loop-testkit/0.1.5-rc.2` → `exports` = `{ ".": {types, default}, "./src/*": "./src/*", "./package.json": "./package.json" }` — **no mock-adapter export**.
- `GET /@deepseek-ai/dsh-llm-replay/0.1.5-rc.2` → `exports` = same shape.

---

## Appendix B — environment / configuration findings that gate §6

1. **No root `vitest.config.ts`** exists in `C:\Users\13588\dev\dsh-ai-coding` (root contains only
   `.gitignore`, `cordis.patch.yml`, `dsh.plugin.json`, `package.json`, `README.md`, `tsconfig.json`,
   plus the `build`, `dev`, `docs`, `src`, `tests` directories). `package.json#scripts.test` is
   `vitest run` with no config, and `test:fixture` points at `dev/team-skill-service/vitest.config.ts`.
2. **No `node_modules` is installed.** `node_modules\@deepseek-ai` does not exist at the root nor under
   either `dev/` package. Nothing was executed against a real install during this survey.
3. **`tsconfig.json` excludes `tests`** (`"exclude": ["dev", "tests", "lib"]`, `include` = `src/**`),
   so the ported tests are not typechecked by `pnpm typecheck` unless that is changed. Consequence:
   the type-only unresolvable imports (`@deepseek-ai/dsh-client-runtime/client`,
   `@deepseek-ai/dsh-ai-coding-platform/types` in the source-tree files under `src/client/**`) do not
   break the build today, but they will need local handling if `tests` is added to a project.
4. **`dev/team-skill-service/tsconfig.json` extends `../../tsconfig.base.json`, which does not exist**
   in the target root (only `tsconfig.json` does). Pre-existing breakage, unrelated to the port but it
   will surface the first time that project is built.
5. **The JSDOM split is already encoded per-file** via 24 `// @vitest-environment jsdom` pragmas, so a
   root config with `environment: 'node'` plus a `jsdom` devDep reproduces the monorepo behaviour
   exactly; a root config with `environment: 'jsdom'` globally would also work (the 61 host specs are
   environment-agnostic). No `setupFiles` are needed for the monorepo suites; the reference monorepo
   root uses `setupFiles: ['./scripts/test-invariants.ts']`, a harness-local file that must **not** be
   ported.
6. **`dsh.plugin.json`/`package.json` name the package `dsh-ai-coding`**, while
   `src/client-node/invariant.ts` still registers as `@deepseek-ai/dsh-client-ui-ai-coding-platform`
   (with an in-code comment that the rename is deferred). The `@deepseek-ai/dsh-*` self-referential
   specifiers inside `src/**` are all `import type` and therefore erased at runtime, so they do not
   block `vitest run` — but a future rename plus `exports` additions (`./types`, `./workspace-host`)
   would be the alternative to the relative rewrites recommended in §5.
