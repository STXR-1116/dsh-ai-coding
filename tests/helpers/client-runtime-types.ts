/**
 * Compatibility shim for `@deepseek-ai/dsh-client-runtime/client`.
 *
 * The withdrawn client-runtime package was the 0.1.1-rc.2 home of the browser
 * session/workspace projections. It has no `0.1.5-rc.2` release on npm (its
 * last published version is `0.1.1-rc.2`), so the ported suites cannot name it
 * any more. Every ported use was `import type`, so the specifier is erased at
 * transform time and the suites ran either way — but a named, typechecked shim
 * is honest about the drift instead of leaving a dead specifier in the tree.
 *
 * Drift record (0.1.1-rc.2 → 0.1.5-rc.2):
 * - `SessionId` now arrives through the API-remotes facade, which re-exports it
 *   from `@deepseek-ai/dsh-client-connection/client`.
 * - `WorkspaceListState` became the Workspace Controller's own `WorkspaceSnapshot`
 *   (same `items: readonly WorkspaceView[]` shape the suites consume, plus the
 *   list lifecycle fields), declared by `@deepseek-ai/dsh-api-workspace-controller/client`
 *   and re-exported by `ui-workspace` as the global `useWorkspaces` hook.
 *
 * @module tests/helpers/client-runtime-types
 */

export type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
export type { WorkspaceSnapshot as WorkspaceListState } from '@deepseek-ai/dsh-api-workspace-controller/client'
