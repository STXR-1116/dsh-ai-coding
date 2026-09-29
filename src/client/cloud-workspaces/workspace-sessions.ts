/**
 * One conversation session per cloud Workspace.
 *
 * ## Why this exists
 *
 * The redesign gives each cloud Workspace **its own** session, so the user's own
 * DSH conversations stay untouched (`docs/cloud-workspace-redesign.md` §3.3). The
 * session is a real Host session — that is what makes the DSH conversation
 * assembly usable at all, because `UiConversation` resolves bindings through the
 * session controller and rejects ids it does not know.
 *
 * ## Why it is archived the moment it is created
 *
 * A Host session normally shows up in the shell's session list, and the owner
 * rejected that. The workspace registry keeps a **registry-global archive set**:
 * an archived session is hidden from every grouping surface while its log and
 * accounting slot are retained, and — verified against the shipped contracts —
 * the session controller never sees the archive set at all, so `binding(id)`
 * still resolves and the conversation assembly still works.
 *
 * `dsh-workspace`: "The registry-global archive set: sessions hidden from every
 * grouping surface. Archiving never touches workspace accounting."
 *
 * So the order that matters is: **create → persist → archive**. Persisting before
 * archiving is deliberate — sessions cannot be deleted from the client, so if
 * archiving fails we must be able to retry against the *same* session instead of
 * leaving an orphan and creating another one.
 *
 * ## What this module deliberately does not do
 *
 * It never calls `sessions.open()`. Opening a session makes it the shell's
 * current session, which is exactly the "use the native conversation" behaviour
 * the owner ruled out. Rendering happens through `UiConversation.binding(id)`.
 *
 * @module dsh-ai-coding/client/cloud-workspaces/workspace-sessions
 */

/** The slice of the client session controller this module needs. */
export interface WorkspaceSessionService {
  /**
   * Create or adopt a session on the Host.
   * @param opts - session creation options; `cwd` scopes it to the workspace.
   * @returns the session identity once its local binding is addressable.
   */
  create(opts?: { readonly workspaceId?: string; readonly cwd?: string; readonly sessionId?: string }): Promise<string>
  /**
   * Resolve a session's binding.
   * @param sessionId - candidate session identity.
   * @returns the binding, or `undefined` when the controller does not know the id.
   */
  binding(sessionId: string): unknown
}

/** The slice of the client workspace controller this module needs. */
export interface WorkspaceArchiveService {
  /**
   * Archive a session into the registry-global archive set.
   * @param sessionId - session to hide from grouping surfaces.
   * @returns the remote result; `ok: false` carries a stable code.
   */
  archiveSession(sessionId: string): Promise<{ readonly ok: boolean; readonly error?: { readonly code: string; readonly message: string } }>
}

/** Durable `workspaceId → sessionId` mapping. */
export interface WorkspaceSessionStore {
  /**
   * Read the persisted session for one workspace.
   * @param workspaceId - cloud workspace identity.
   * @returns the stored session id, or `undefined` when none is recorded.
   */
  read(workspaceId: string): string | undefined
  /**
   * Persist the session for one workspace.
   * @param workspaceId - cloud workspace identity.
   * @param sessionId - session to record.
   */
  write(workspaceId: string, sessionId: string): void
}

/** Outcome of {@link ensureWorkspaceSession}. */
export type WorkspaceSessionOutcome =
  | { readonly ok: true; readonly sessionId: string; readonly created: boolean }
  | { readonly ok: false; readonly code: 'CREATE_FAILED' | 'ARCHIVE_FAILED'; readonly message: string }

/**
 * Resolve the conversation session for one cloud workspace, creating and hiding
 * it on first use.
 *
 * Reuse is checked with `binding()` rather than trusting the stored id: a session
 * can disappear (the user may have archived or deleted it through the shell's own
 * UI), and a stale id would otherwise fail every later read with "unknown
 * session".
 * @param input - injected services, the target workspace, and its working directory.
 * @returns the session to render, or a stable failure the caller must show.
 */
export async function ensureWorkspaceSession(input: {
  readonly workspaceId: string
  /**
   * Local working directory for the session, when one is known.
   *
   * A **cloud** workspace contributes none: the plugin never learns its remote
   * physical path (design doc §4 — 「插件不显示或保存远程物理路径」), so the workbench
   * passes `workspaceId` alone and the session takes the default location. The
   * field stays because a local association may legitimately become known later,
   * and because the tests exercise both shapes.
   */
  readonly cwd?: string
  readonly sessions: WorkspaceSessionService
  readonly workspaces: WorkspaceArchiveService
  readonly store: WorkspaceSessionStore
}): Promise<WorkspaceSessionOutcome> {
  const stored = input.store.read(input.workspaceId)
  if (stored !== undefined && input.sessions.binding(stored) !== undefined) {
    return { ok: true, sessionId: stored, created: false }
  }

  let sessionId: string
  try {
    sessionId = await input.sessions.create(
      input.cwd === undefined
        ? { workspaceId: input.workspaceId }
        : { workspaceId: input.workspaceId, cwd: input.cwd },
    )
  } catch (error) {
    return { ok: false, code: 'CREATE_FAILED', message: error instanceof Error ? error.message : String(error) }
  }

  // Persist before archiving: sessions cannot be deleted from the client, so a
  // failed archive must be retryable against this same session rather than
  // abandoning it and creating another on the next attempt.
  input.store.write(input.workspaceId, sessionId)

  let archived: Awaited<ReturnType<WorkspaceArchiveService['archiveSession']>>
  try {
    archived = await input.workspaces.archiveSession(sessionId)
  } catch (error) {
    return { ok: false, code: 'ARCHIVE_FAILED', message: error instanceof Error ? error.message : String(error) }
  }
  if (!archived.ok) {
    const detail = archived.error === undefined ? 'unknown' : `${archived.error.code}: ${archived.error.message}`
    return { ok: false, code: 'ARCHIVE_FAILED', message: detail }
  }

  return { ok: true, sessionId, created: true }
}
