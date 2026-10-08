/**
 * The workbench's way to reach a cloud Workspace's own conversation session.
 *
 * ## Why it is a remote face rather than a prop
 *
 * Resolving a session needs two client services (`sessions` for create/resolve,
 * `workspaces` for the archive that hides it). The surface already receives this
 * plugin's self-hosted `remote` object, so hanging the capability off that object
 * keeps the two service faces at the single boundary that already owns them —
 * `src/client/index.ts` — instead of threading another prop through
 * `PlatformSurface` into `CloudWorkspacesView`.
 *
 * The decision logic and the durable mapping live in the two modules this one
 * composes; this file only supplies the live services and the storage.
 *
 * @module dsh-ai-coding/client/remote/workspace-sessions
 */

import { ensureWorkspaceSession, type WorkspaceArchiveService, type WorkspaceSessionOutcome, type WorkspaceSessionService } from '../cloud-workspaces/workspace-sessions.ts'
import { createWorkspaceSessionStore, type StorageLike } from '../cloud-workspaces/workspace-session-store.ts'

/** Browser-facing face of {@link WorkspaceSessionsRemote}. */
export interface WorkspaceSessionsFace {
  /**
   * Resolve the conversation session for one cloud Workspace, creating and hiding
   * it on first use.
   * @param input - the signed-in account (scopes the mapping) and the **remote**
   *   workspace identity. That is the platform's workspace, not a DSH local
   *   workspace id — the two are not interchangeable (see `ensureWorkspaceSession`).
   * @returns the session to render, or a stable failure the caller must show.
   */
  ensure(input: { readonly accountId?: string; readonly cloudWorkspaceId: string }): Promise<WorkspaceSessionOutcome>
}

/** Supplies the two client service faces; injected so this class stays testable. */
export interface WorkspaceSessionsServices {
  /** Client session controller face (`ctx.sessions`). */
  readonly sessions: WorkspaceSessionService
  /** Client workspace controller face (`ctx.workspaces`). */
  readonly workspaces: WorkspaceArchiveService
}

/** Read-only view of one account's durable mapping, for diagnostics and tests. */
export interface WorkspaceSessionsRemoteDeps {
  /**
   * Read the client services **at call time**.
   *
   * Deliberately a thunk, not a value: this fragment is applied while the browser
   * app is still assembling, so a service read during `apply` can legitimately be
   * absent yet become available moments later. Capturing it eagerly would pin this
   * face to "unavailable" for the whole session — a silent failure of exactly the
   * kind the workbench must not have.
   * @returns the services, or `undefined` when the app provides none.
   */
  readonly services: () => WorkspaceSessionsServices | undefined
  /**
   * Read Web Storage at call time (access can throw in some browser modes).
   * @returns the storage, or `undefined` where there is none.
   */
  readonly storage: () => StorageLike | undefined
}

/**
 * Resolve cloud-Workspace conversation sessions in the browser.
 *
 * Every dependency is optional on purpose: the fragment must load even where the
 * services or `localStorage` are missing (a mount elsewhere, or a degraded
 * browser). In that case `ensure` reports a stable failure — it never invents a
 * session id and never pretends the conversation is available.
 */
export class WorkspaceSessionsRemote implements WorkspaceSessionsFace {
  /**
   * @param deps - call-time readers for the client services and the storage.
   */
  constructor(private readonly deps: WorkspaceSessionsRemoteDeps) {}

  /**
   * @param input - the signed-in account and the cloud Workspace.
   * @returns the session to render, or a stable failure.
   */
  async ensure(input: { readonly accountId?: string; readonly cloudWorkspaceId: string }): Promise<WorkspaceSessionOutcome> {
    const services = this.deps.services()
    if (services === undefined) {
      return { ok: false, code: 'CREATE_FAILED', message: '会话服务不可用：客户端未提供 sessions/workspaces 服务' }
    }
    const storage = this.deps.storage()
    if (storage === undefined) {
      // Refuse rather than create a session whose mapping could not be recorded:
      // archiving has no undo, so an unrecorded session is unreachable forever and
      // one would leak per visit.
      return { ok: false, code: 'CREATE_FAILED', message: '会话映射无法持久化：当前环境没有 localStorage' }
    }
    return ensureWorkspaceSession({
      cloudWorkspaceId: input.cloudWorkspaceId,
      sessions: services.sessions,
      workspaces: services.workspaces,
      store: createWorkspaceSessionStore(storage, input.accountId),
    }).catch(error => ({
      // `ensureWorkspaceSession` handles create/archive rejections itself; what can
      // still throw is the storage write (Web Storage raises on quota). Reported as
      // a stable failure so the caller shows a reason instead of an unhandled
      // rejection, and — importantly — so no session is created without a mapping.
      ok: false as const,
      code: 'CREATE_FAILED' as const,
      message: error instanceof Error ? error.message : String(error),
    }))
  }
}
