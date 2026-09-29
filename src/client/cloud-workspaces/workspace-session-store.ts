/**
 * Durable `workspaceId → sessionId` mapping for cloud-workspace conversations.
 *
 * ## Why it must be durable
 *
 * Archiving is what keeps a workspace's session out of the shell's session list,
 * and archiving has **no undo**: `dsh-client-ui-workspace`'s own known limits say
 * 「已归档会话没有查看或取消归档入口」. So if this mapping is lost, the session is
 * still on the Host but nothing in the UI can reach it — the cloud workbench is
 * the only entry point it has. Losing the mapping therefore leaks a session per
 * workspace visit, and sessions cannot be deleted from the client either.
 *
 * ## Why it is scoped by account
 *
 * The workbench already scopes every retained selection by account ("a workbench
 * that signed out and back in as someone else must not reopen the previous
 * account's workspace"). A session id is account-scoped state for the same
 * reason: reusing another account's id would fail the controller's resolution and
 * re-create on every entry.
 *
 * The `Storage` object is injected rather than reached for, so this stays a plain
 * module: no DOM, no globals, testable with a three-method fake.
 *
 * @module dsh-ai-coding/client/cloud-workspaces/workspace-session-store
 */

import type { WorkspaceSessionStore } from './workspace-sessions.ts'

/** The slice of Web Storage this module needs. */
export interface StorageLike {
  /** Read one key. */
  getItem(key: string): string | null
  /** Write one key. */
  setItem(key: string, value: string): void
}

/** Key prefix; the account id is appended so accounts never share a mapping. */
export const WORKSPACE_SESSION_STORAGE_PREFIX = 'dsh-ai-coding:workspace-session'

/**
 * Read the browser's own storage, or `undefined` where it is unavailable.
 *
 * Access can **throw** rather than return null (privacy modes, sandboxed frames),
 * and the caller must then report that it cannot persist the mapping — creating a
 * session it could never find again would leak one per visit, because an archived
 * session has no way back into the UI.
 * @returns Web Storage, or `undefined` when the environment has none.
 */
export function resolveBrowserStorage(): StorageLike | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

/**
 * Build the key one account's mapping lives under.
 * @param accountId - signed-in account, or `undefined` while it is unknown.
 * @returns the storage key.
 */
export function workspaceSessionStorageKey(accountId: string | undefined): string {
  return `${WORKSPACE_SESSION_STORAGE_PREFIX}:${accountId ?? 'anonymous'}`
}

/**
 * Read one account's `workspaceId → sessionId` map.
 * @param storage - Web Storage (or a fake).
 * @param accountId - signed-in account, or `undefined` while it is unknown.
 * @returns the parsed map; empty when absent or unreadable.
 */
function readAll(storage: StorageLike, accountId: string | undefined): Record<string, string> {
  const raw = storage.getItem(workspaceSessionStorageKey(accountId))
  if (raw === null) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    // Only string→string rows are meaningful; anything else is dropped rather
    // than trusted, so a hand-edited or foreign value cannot inject behaviour.
    const rows: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && value.length > 0) rows[key] = value
    }
    return rows
  } catch {
    return {}
  }
}

/**
 * Create a durable store for one account.
 * @param storage - Web Storage (or a fake).
 * @param accountId - signed-in account, or `undefined` while it is unknown.
 * @returns the store `ensureWorkspaceSession` writes through.
 */
export function createWorkspaceSessionStore(storage: StorageLike, accountId: string | undefined): WorkspaceSessionStore {
  const key = workspaceSessionStorageKey(accountId)
  return {
    read: workspaceId => readAll(storage, accountId)[workspaceId],
    write: (workspaceId, sessionId) => {
      const rows = readAll(storage, accountId)
      rows[workspaceId] = sessionId
      storage.setItem(key, JSON.stringify(rows))
    },
  }
}
