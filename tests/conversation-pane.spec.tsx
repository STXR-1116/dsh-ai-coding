// @vitest-environment jsdom
/**
 * Tests for the conversation column.
 *
 * The behaviour worth pinning is the subscription's lifetime: subscribing is what
 * activates DSH's chat target, so a pane that resubscribed on every render would
 * churn it, and one that never unsubscribed would keep it active for the rest of the
 * app session. Everything else here is rendering.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

import { ConversationPane } from '../src/client/cloud-workspaces/ConversationPane.tsx'
import type { ChatSnapshotView } from '../src/client/cloud-workspaces/conversation-model.ts'
import type { ConversationSourceResult } from '../src/client/cloud-workspaces/conversation-source.ts'

/** A source whose subscribers can be driven from the test. */
function makeSource(initial: ChatSnapshotView | undefined) {
  let value = initial
  const listeners = new Set<() => void>()
  const source = {
    getSnapshot: (): ChatSnapshotView | undefined => value,
    subscribe: (onChange: () => void): (() => void) => {
      listeners.add(onChange)
      return () => { listeners.delete(onChange) }
    },
  }
  return {
    result: { ok: true as const, source } satisfies ConversationSourceResult,
    emit(next: ChatSnapshotView | undefined) {
      value = next
      for (const listener of [...listeners]) listener()
    },
    listenerCount: () => listeners.size,
  }
}

/** A snapshot holding one node of the given kind. */
function snapshotWith(key: string, kind: string, data: unknown): ChatSnapshotView {
  return { order: [key], nodes: { get: id => (id === key ? { kind, data } : undefined) } }
}

afterEach(() => { cleanup() })

describe('ConversationPane', () => {
  it('shows the empty state when the conversation has no content yet', async () => {
    const { result } = makeSource(undefined)
    render(<ConversationPane sessionId="session-1" source={result} />)

    expect(await screen.findByText('这个工作空间还没有对话内容')).toBeTruthy()
  })

  it('renders assistant text and a labelled row for kinds it does not render yet', async () => {
    const { result, emit } = makeSource(undefined)
    render(<ConversationPane sessionId="session-1" source={result} />)

    emit({
      order: ['a1', 'x1'],
      nodes: {
        get: id => (id === 'a1'
          ? { kind: 'assistant-step', data: { status: 'settled', turn: 1, step: 1, blocks: [{ kind: 'text', text: '你好，这是回复' }] } }
          : { kind: 'turn-process', data: {} }),
      },
    })

    expect(await screen.findByText('你好，这是回复')).toBeTruthy()
    // Not rendered yet, but present and named — never silently dropped.
    expect(screen.getByText('turn-process')).toBeTruthy()
  })

  it('renders a turn error as an alert', async () => {
    const source = makeSource(snapshotWith('e1', 'turn-error', { message: '模型无响应', code: 'PROVIDER_TIMEOUT' }))
    render(<ConversationPane sessionId="session-1" source={source.result} />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('模型无响应')
    expect(alert.textContent).toContain('PROVIDER_TIMEOUT')
  })

  it('reports an unusable source instead of pretending the conversation is empty', async () => {
    const result: ConversationSourceResult = { ok: false, message: '会话快照 API 不匹配：期望 getSnapshot/subscribe' }
    render(<ConversationPane sessionId="session-1" source={result} />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('getSnapshot/subscribe')
    // The empty state must not appear: "no content" and "cannot read content" are
    // different facts about the world.
    expect(screen.queryByText('这个工作空间还没有对话内容')).toBeNull()
  })

  it('subscribes once per session and releases on unmount', async () => {
    const source = makeSource(undefined)
    const subscribe = vi.spyOn(source.result.source, 'subscribe')
    const { unmount, rerender } = render(<ConversationPane sessionId="session-1" source={source.result} />)

    await waitFor(() => { expect(source.listenerCount()).toBe(1) })
    // A re-render with the same session must not resubscribe (each subscribe
    // activates the target).
    rerender(<ConversationPane sessionId="session-1" source={source.result} />)
    expect(subscribe).toHaveBeenCalledTimes(1)

    unmount()
    expect(source.listenerCount()).toBe(0)
  })
})
