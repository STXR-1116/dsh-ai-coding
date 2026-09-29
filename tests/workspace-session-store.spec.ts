/**
 * Tests for the durable `workspaceId → sessionId` mapping.
 *
 * The mapping is the only thing that makes an archived session reachable again
 * (`dsh-workspace`'s archive has no undo, and the client cannot delete sessions),
 * so the cases that matter are the ones where it could silently lose a row or
 * hand one account another account's session.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  createWorkspaceSessionStore,
  workspaceSessionStorageKey,
  type StorageLike,
} from '../src/client/cloud-workspaces/workspace-session-store.ts'

/** Minimal Web Storage fake — the module only needs get/set. */
function makeStorage(initial: Record<string, string> = {}) {
  const rows = new Map(Object.entries(initial))
  const storage: StorageLike = {
    getItem: key => rows.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => { rows.set(key, value) }),
  }
  return { storage, rows }
}

describe('createWorkspaceSessionStore', () => {
  it('round-trips one workspace mapping', () => {
    const { storage } = makeStorage()
    const store = createWorkspaceSessionStore(storage, 'user-1')

    expect(store.read('ws-alpha-1')).toBeUndefined()
    store.write('ws-alpha-1', 'session-1')
    expect(store.read('ws-alpha-1')).toBe('session-1')
  })

  it('keeps several workspaces side by side', () => {
    const { storage } = makeStorage()
    const store = createWorkspaceSessionStore(storage, 'user-1')

    store.write('ws-alpha-1', 'session-1')
    store.write('ws-beta-1', 'session-2')

    expect(store.read('ws-alpha-1')).toBe('session-1')
    expect(store.read('ws-beta-1')).toBe('session-2')
  })

  it('does not let one account read another account\'s session', () => {
    const { storage } = makeStorage()
    createWorkspaceSessionStore(storage, 'user-1').write('ws-alpha-1', 'session-of-user-1')

    // Same workspace id, different account: must not resolve to the other's session.
    expect(createWorkspaceSessionStore(storage, 'user-2').read('ws-alpha-1')).toBeUndefined()
    expect(createWorkspaceSessionStore(storage, 'user-1').read('ws-alpha-1')).toBe('session-of-user-1')
  })

  it('namespaces the anonymous scope so it cannot collide with an account id', () => {
    expect(workspaceSessionStorageKey(undefined)).toBe('dsh-ai-coding:workspace-session:anonymous')
    expect(workspaceSessionStorageKey('anonymous')).toBe('dsh-ai-coding:workspace-session:anonymous')
    // Documented consequence: the literal account id "anonymous" shares the anon
    // bucket. That is acceptable — an unknown account and that id are both
    // unusable scopes — but it must be deliberate, not accidental.
  })

  it('discards an unreadable or foreign mapping instead of trusting it', () => {
    const broken = makeStorage({ [workspaceSessionStorageKey('user-1')]: '{not json' })
    expect(createWorkspaceSessionStore(broken.storage, 'user-1').read('ws-alpha-1')).toBeUndefined()

    const foreign = makeStorage({
      [workspaceSessionStorageKey('user-1')]: JSON.stringify({ 'ws-alpha-1': 42, 'ws-beta-1': '', 'ws-gamma-1': 'session-3' }),
    })
    const store = createWorkspaceSessionStore(foreign.storage, 'user-1')
    expect(store.read('ws-alpha-1')).toBeUndefined()  // number
    expect(store.read('ws-beta-1')).toBeUndefined()   // empty string
    expect(store.read('ws-gamma-1')).toBe('session-3')
  })

  it('preserves existing rows when writing a new one', () => {
    const { storage } = makeStorage()
    const store = createWorkspaceSessionStore(storage, 'user-1')

    store.write('ws-alpha-1', 'session-1')
    store.write('ws-beta-1', 'session-2')

    expect(store.read('ws-alpha-1')).toBe('session-1')
  })
})
