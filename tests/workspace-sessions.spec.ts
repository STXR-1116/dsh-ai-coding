/**
 * Unit tests for the cloud-workspace session ownership rules.
 *
 * These pin the three decisions that acceptance depends on, each of which is a
 * silent failure if it regresses:
 *   1. reuse beats create — a second entry into the same Workspace must not
 *      create a second session (sessions cannot be deleted from the client, so a
 *      duplicate is permanent clutter for the user);
 *   2. create → persist → archive — the archive is what keeps the session out of
 *      the shell's session list, and the persist-before-archive order is what
 *      makes a failed archive retryable against the same session;
 *   3. a stale stored id is discarded — otherwise every later read fails with the
 *      controller's "unknown session".
 */

import { describe, expect, it, vi } from 'vitest'

import { ensureWorkspaceSession, type WorkspaceSessionStore } from '../src/client/cloud-workspaces/workspace-sessions.ts'

/** In-memory store; `read` is observed so a test can assert what was persisted when. */
function makeStore(initial?: Record<string, string>) {
  const rows = new Map(Object.entries(initial ?? {}))
  const write = vi.fn((workspaceId: string, sessionId: string) => { rows.set(workspaceId, sessionId) })
  const store: WorkspaceSessionStore = { read: id => rows.get(id), write }
  return { store, write, rows }
}

describe('ensureWorkspaceSession', () => {
  it('reuses a stored session that the controller still resolves, without creating', async () => {
    const { store } = makeStore({ 'ws-alpha-1': 'session-existing' })
    const create = vi.fn(async () => 'session-new')
    const archiveSession = vi.fn(async () => ({ ok: true as const }))

    const outcome = await ensureWorkspaceSession({
      cloudWorkspaceId: 'ws-alpha-1',
      cwd: 'C:/work/alpha',
      sessions: { create, binding: id => (id === 'session-existing' ? { sessionId: id } : undefined) },
      workspaces: { archiveSession },
      store,
    })

    expect(outcome).toEqual({ ok: true, sessionId: 'session-existing', created: false })
    expect(create).not.toHaveBeenCalled()
    // Re-archiving a live mapping would be pointless noise on every entry.
    expect(archiveSession).not.toHaveBeenCalled()
  })

  it('creates, persists, then archives when nothing is stored', async () => {
    const { store, write, rows } = makeStore()
    const order: string[] = []
    const archiveSession = vi.fn(async (sessionId: string) => {
      order.push(`archive:${sessionId}`)
      // The mapping must already be durable when the archive is attempted.
      expect(rows.get('ws-alpha-2')).toBe('session-fresh')
      return { ok: true as const }
    })

    const outcome = await ensureWorkspaceSession({
      cloudWorkspaceId: 'ws-alpha-2',
      cwd: 'C:/work/beta',
      sessions: {
        create: vi.fn(async () => { order.push('create'); return 'session-fresh' }),
        binding: () => undefined,
      },
      workspaces: { archiveSession },
      store,
    })

    expect(outcome).toEqual({ ok: true, sessionId: 'session-fresh', created: true })
    expect(order).toEqual(['create', 'archive:session-fresh'])
    expect(write).toHaveBeenCalledWith('ws-alpha-2', 'session-fresh')
  })

  it('reports an archive failure instead of handing back a session that would be listed', async () => {
    const { store, rows } = makeStore()
    const outcome = await ensureWorkspaceSession({
      cloudWorkspaceId: 'ws-alpha-3',
      cwd: 'C:/work/gamma',
      sessions: { create: vi.fn(async () => 'session-orphan'), binding: () => undefined },
      workspaces: { archiveSession: vi.fn(async () => ({ ok: false as const, error: { code: 'REVISION_CONFLICT', message: '冲突' } })) },
      store,
    })

    expect(outcome).toEqual({ ok: false, code: 'ARCHIVE_FAILED', message: 'REVISION_CONFLICT: 冲突' })
    // Kept, so the retry archives this session rather than leaking it and creating another.
    expect(rows.get('ws-alpha-3')).toBe('session-orphan')
  })

  it('treats a stored id the controller no longer resolves as absent', async () => {
    const { store, rows } = makeStore({ 'ws-alpha-1': 'session-gone' })
    const archiveSession = vi.fn(async () => ({ ok: true as const }))

    const outcome = await ensureWorkspaceSession({
      cloudWorkspaceId: 'ws-alpha-1',
      cwd: 'C:/work/alpha',
      sessions: { create: vi.fn(async () => 'session-replacement'), binding: () => undefined },
      workspaces: { archiveSession },
      store,
    })

    expect(outcome).toEqual({ ok: true, sessionId: 'session-replacement', created: true })
    expect(rows.get('ws-alpha-1')).toBe('session-replacement')
    // The vanished id is never re-archived: it is not ours to touch any more.
    expect(archiveSession).toHaveBeenCalledTimes(1)
    expect(archiveSession).toHaveBeenCalledWith('session-replacement')
  })

  it('surfaces a create rejection by its message', async () => {
    const { store } = makeStore()
    const outcome = await ensureWorkspaceSession({
      cloudWorkspaceId: 'ws-alpha-1',
      cwd: 'C:/work/alpha',
      sessions: { create: vi.fn(async () => { throw new Error('服务暂时不可用') }), binding: () => undefined },
      workspaces: { archiveSession: vi.fn(async () => ({ ok: true as const })) },
      store,
    })

    expect(outcome).toEqual({ ok: false, code: 'CREATE_FAILED', message: '服务暂时不可用' })
  })

  it('never hands the cloud workspace id to the session controller', async () => {
    // The two ids live in different registries: `cloudWorkspaceId` identifies the
    // remote workspace on the platform, while `sessions.create` wants a **DSH local**
    // workspace id. Passing the former produced, on a real machine,
    //   session create failed: workspace/not-found: workspace "ws-alpha-1" not found
    // which the workbench rendered as 「本工作空间的会话不可用」 instead of opening a
    // conversation. Asserting the *absence* is the point: a test that only checks
    // "create was called" passes for the broken version too.
    const { store } = makeStore()
    const create = vi.fn(async () => 'session-1')

    await ensureWorkspaceSession({
      cloudWorkspaceId: 'ws-alpha-1',
      sessions: { create, binding: () => undefined },
      workspaces: { archiveSession: vi.fn(async () => ({ ok: true as const })) },
      store,
    })

    expect(create).toHaveBeenCalledWith({})
    expect(JSON.stringify(create.mock.calls)).not.toContain('ws-alpha-1')
  })

  it('keeps workspaces independent', async () => {
    const { store } = makeStore()
    let counter = 0
    const sessions = { create: vi.fn(async () => `session-${++counter}`), binding: () => undefined }
    const workspaces = { archiveSession: vi.fn(async () => ({ ok: true as const })) }
    const bindings = { sessions, workspaces, store }

    const first = await ensureWorkspaceSession({ cloudWorkspaceId: 'ws-alpha-1', cwd: 'C:/a', ...bindings })
    const second = await ensureWorkspaceSession({ cloudWorkspaceId: 'ws-beta-1', cwd: 'C:/b', ...bindings })

    expect(first).toMatchObject({ ok: true, sessionId: 'session-1' })
    expect(second).toMatchObject({ ok: true, sessionId: 'session-2' })
    expect(workspaces.archiveSession).toHaveBeenCalledWith('session-1')
    expect(workspaces.archiveSession).toHaveBeenCalledWith('session-2')
  })
})
