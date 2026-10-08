/**
 * Tests for the browser-facing session resolver.
 *
 * Two things matter here and neither is about the happy path (that logic is
 * covered by `workspace-sessions.spec.ts` and `workspace-session-store.spec.ts`):
 *
 *   1. a fragment loaded where the services or `localStorage` are missing must
 *      report a stable failure rather than invent a session id — a workbench that
 *      quietly pretended to have a conversation would be worse than one that says
 *      it cannot;
 *   2. the readers are consulted **at call time**, so a service that appears after
 *      `apply()` is picked up instead of leaving the feature permanently degraded;
 *   3. the account scope really does reach the storage layer, since a shared
 *      mapping across accounts would hand one user another's session.
 */

import { describe, expect, it, vi } from 'vitest'

import { WorkspaceSessionsRemote } from '../src/client/remote/workspace-sessions.ts'
import { workspaceSessionStorageKey, type StorageLike } from '../src/client/cloud-workspaces/workspace-session-store.ts'

function makeStorage(initial: Record<string, string> = {}) {
  const rows = new Map(Object.entries(initial))
  const storage: StorageLike = {
    getItem: key => rows.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => { rows.set(key, value) }),
  }
  return { storage, rows }
}

/** Services fake: `binding` resolves nothing, so every call creates. */
function makeServices(create: () => Promise<string>) {
  const archiveSession = vi.fn(async () => ({ ok: true as const }))
  return {
    services: { sessions: { create: vi.fn(create), binding: () => undefined }, workspaces: { archiveSession } },
    archiveSession,
  }
}

describe('WorkspaceSessionsRemote', () => {
  it('reports a stable failure when the client services are missing', async () => {
    const remote = new WorkspaceSessionsRemote({ services: () => undefined, storage: () => makeStorage().storage })
    const outcome = await remote.ensure({ accountId: 'user-1', cloudWorkspaceId: 'ws-alpha-1' })

    expect(outcome).toMatchObject({ ok: false, code: 'CREATE_FAILED' })
  })

  it('reports a stable failure when the mapping cannot be persisted', async () => {
    const { services } = makeServices(async () => 'session-1')
    const remote = new WorkspaceSessionsRemote({ services: () => services, storage: () => undefined })
    const outcome = await remote.ensure({ accountId: 'user-1', cloudWorkspaceId: 'ws-alpha-1' })

    // Deliberately refuses rather than creating a session it could never find again:
    // an archived session with no mapping is unreachable (archive has no undo).
    expect(outcome).toMatchObject({ ok: false, code: 'CREATE_FAILED' })
    expect(services.sessions.create).not.toHaveBeenCalled()
  })

  it('reads the services at call time, so a late provider is not missed', async () => {
    let available: ReturnType<typeof makeServices>['services'] | undefined
    const remote = new WorkspaceSessionsRemote({
      services: () => available,
      storage: () => makeStorage().storage,
    })

    // Applied before the provider exists: a stable failure, not a permanent verdict.
    expect(await remote.ensure({ accountId: 'user-1', cloudWorkspaceId: 'ws-alpha-1' })).toMatchObject({ ok: false })

    available = makeServices(async () => 'session-late').services
    expect(await remote.ensure({ accountId: 'user-1', cloudWorkspaceId: 'ws-alpha-1' })).toEqual({
      ok: true, sessionId: 'session-late', created: true,
    })
  })

  it('creates, archives and records the session for the signed-in account', async () => {
    const { storage, rows } = makeStorage()
    const { services, archiveSession } = makeServices(async () => 'session-9')
    const remote = new WorkspaceSessionsRemote({ services: () => services, storage: () => storage })

    const outcome = await remote.ensure({ accountId: 'user-1', cloudWorkspaceId: 'ws-alpha-1' })

    expect(outcome).toEqual({ ok: true, sessionId: 'session-9', created: true })
    expect(archiveSession).toHaveBeenCalledWith('session-9')
    const persisted = rows.get(workspaceSessionStorageKey('user-1'))
    expect(persisted).toBeDefined()
    expect(JSON.parse(persisted ?? '{}')).toEqual({ 'ws-alpha-1': 'session-9' })
  })

  it('reuses the recorded session for the same account and workspace', async () => {
    const { storage } = makeStorage({ [workspaceSessionStorageKey('user-1')]: JSON.stringify({ 'ws-alpha-1': 'session-9' }) })
    const create = vi.fn(async () => 'session-new')
    const remote = new WorkspaceSessionsRemote({
      services: () => ({
        sessions: { create, binding: id => (id === 'session-9' ? {} : undefined) },
        workspaces: { archiveSession: vi.fn(async () => ({ ok: true as const })) },
      }),
      storage: () => storage,
    })

    const outcome = await remote.ensure({ accountId: 'user-1', cloudWorkspaceId: 'ws-alpha-1' })

    expect(outcome).toEqual({ ok: true, sessionId: 'session-9', created: false })
    expect(create).not.toHaveBeenCalled()
  })

  it('does not reuse another account\'s recorded session', async () => {
    const { storage } = makeStorage({ [workspaceSessionStorageKey('user-1')]: JSON.stringify({ 'ws-alpha-1': 'session-9' }) })
    const { services } = makeServices(async () => 'session-other')
    const remote = new WorkspaceSessionsRemote({ services: () => services, storage: () => storage })

    const outcome = await remote.ensure({ accountId: 'user-2', cloudWorkspaceId: 'ws-alpha-1' })

    expect(outcome).toEqual({ ok: true, sessionId: 'session-other', created: true })
  })
})
