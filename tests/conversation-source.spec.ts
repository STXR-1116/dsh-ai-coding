/**
 * Tests for the snapshot-source adapter.
 *
 * The adapter exists because `ObservableSnapshot`'s declaration is not available on
 * this machine (its package is not shipped in the DSH install), so the two method
 * names are inferred. What these tests protect is the **response** to that
 * uncertainty: a source that does not match must produce a message naming what was
 * actually there, never a silently empty conversation.
 */

import { describe, expect, it, vi } from 'vitest'

import { readConversationSource } from '../src/client/cloud-workspaces/conversation-source.ts'

describe('readConversationSource', () => {
  it('rejects a non-object with a message that says what was missing', () => {
    const result = readConversationSource(undefined)
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.message).toContain('chat target')
  })

  it('names the members it found when the shape does not match', () => {
    const result = readConversationSource({ value: 1, onChange: () => {}, extra: true })

    expect(result.ok).toBe(false)
    // The message is the diagnostic: it is what tells us the real API on the first
    // run instead of leaving an empty pane.
    expect(result.ok ? '' : result.message).toContain('getSnapshot/subscribe')
    expect(result.ok ? '' : result.message).toContain('value')
    expect(result.ok ? '' : result.message).toContain('onChange')
  })

  it('accepts a matching source and forwards calls through the wrapper', () => {
    const snapshot = { order: [], nodes: { get: () => undefined } }
    const unsubscribe = vi.fn()
    const inner = {
      getSnapshot: vi.fn(() => snapshot),
      subscribe: vi.fn(() => unsubscribe),
    }

    const result = readConversationSource(inner)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.source.getSnapshot()).toBe(snapshot)
    const listener = (): void => {}
    expect(result.source.subscribe(listener)).toBe(unsubscribe)
    expect(inner.subscribe).toHaveBeenCalledWith(listener)
  })

  it('calls the underlying methods with their own receiver', () => {
    // A detached call (`const fn = obj.getSnapshot; fn()`) loses `this`, which is a
    // classic late failure — so the wrapper must not hand the raw function out.
    const inner = {
      seen: 0,
      getSnapshot(): unknown {
        this.seen += 1
        return undefined
      },
      subscribe(): () => void {
        this.seen += 1
        return () => {}
      },
    }

    const result = readConversationSource(inner)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    result.source.getSnapshot()
    result.source.subscribe(() => {})

    expect(inner.seen).toBe(2)
  })
})
