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
  /**
   * The **remote** (cloud) workspace identity, used as the mapping key.
   *
   * Named `cloudWorkspaceId` on purpose. It is **not** a DSH workspace id and must
   * never be handed to `sessions.create`: the two live in different registries, and
   * passing this one produced
   *   `session create failed: workspace/not-found: workspace "ws-alpha-1" not found`
   * which the workbench rendered as 「本工作空间的会话不可用」 instead of opening a
   * conversation. The distinct names are what make that mistake unwritable.
   */
  readonly cloudWorkspaceId: string
  /**
   * 平台会话 id（`docs/backend-api-requirements.md` §3.1 的会话记录），可选。
   *
   * 给了它，映射键就是**「工作空间 + 平台会话」的复合键** —— 左栏点某条会话记录时走这条路，
   * 于是每条记录各有一条自己的 DSH 会话；不给则仍是工作空间级会话（原行为，向后兼容）。
   */
  readonly platformSessionId?: string
  /**
   * 建出来的会话**留在会话列表里**（不归档）。接管模式用它。
   *
   * 理由见下面归档处的注释：归档态的会话当"当前会话"用时，外壳过一会儿就不再认它，
   * 中央退回"新会话"空态（所有者实测：停留一段时间自动新开一个会话）。
   */
  readonly keepInList?: boolean
  /**
   * Local working directory for the session, when one is known.
   *
   * A **cloud** workspace contributes none: the plugin never learns its remote
   * physical path (design doc §4 — 「插件不显示或保存远程物理路径」), so the workbench
   * passes the workspace identity alone and the session takes the default location.
   */
  readonly cwd?: string
  readonly sessions: WorkspaceSessionService
  readonly workspaces: WorkspaceArchiveService
  readonly store: WorkspaceSessionStore
}): Promise<WorkspaceSessionOutcome> {
  // 映射键：默认就是工作空间 id（整个工作空间共用一条会话，原行为）；
  // 给了**平台会话 id** 时用复合键 —— 左栏每条会话记录因此各有一条自己的 DSH 会话
  // （所有者 T3：「点一条会话记录 ⇒ 中央切到该会话」）。
  // 用 `\u0000` 分隔：它在 id 里不可能出现，因此两段不会互相混淆。
  //
  // `keepInList`（接管模式）再加一段后缀：**它必须拿到"留着不归档"的会话**，
  // 而此前建的同类会话都是归档态的 —— 复用它们会立刻复现"过一会儿退回新会话"的问题。
  // 分开存键，老映射继续服务视图那条路（归档 ✓），接管这条路拿到全新的、留在列表里的会话。
  const mappingKey = [
    input.cloudWorkspaceId,
    ...(input.platformSessionId === undefined ? [] : [input.platformSessionId]),
    ...(input.keepInList === true ? ['live'] : []),
  ].join('\u0000')
  const stored = input.store.read(mappingKey)
  if (stored !== undefined && input.sessions.binding(stored) !== undefined) {
    return { ok: true, sessionId: stored, created: false }
  }

  let sessionId: string
  try {
    // No `workspaceId`: the session controller wants a **DSH local** workspace id,
    // and this workbench has none to give (see the field comment above). Omitted
    // rather than guessed — a wrong association is worse than none.
    sessionId = await input.sessions.create(input.cwd === undefined ? {} : { cwd: input.cwd })
  } catch (error) {
    return { ok: false, code: 'CREATE_FAILED', message: error instanceof Error ? error.message : String(error) }
  }

  // Persist before archiving: sessions cannot be deleted from the client, so a
  // failed archive must be retryable against this same session rather than
  // abandoning it and creating another on the next attempt.
  input.store.write(mappingKey, sessionId)

  // **接管模式的会话不归档**（`keepInList`）。
  //
  // 实测（所有者真机）：归档态的会话用作"当前会话"时，外壳过一会儿（列表刷新）就不再认它，
  // 中央于是退回"新会话"空态 —— 表现为"停留一段时间就自动新开一个会话"。
  // 接管时用户**正是在这条会话里工作**，它就该像一条普通会话那样留在列表里；
  // 而接管期间左栏由我们渲染（平台会话记录 + 文件列表），不会被它干扰。
  // 视图自己那条路（浮层里的会话列）仍按原样归档，避免污染外壳列表。
  if (input.keepInList === true) return { ok: true, sessionId, created: true }

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
