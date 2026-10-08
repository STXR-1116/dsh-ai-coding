/**
 * Tests for the Chat-snapshot → row projection.
 *
 * The contract this file exists to protect is **nothing disappears silently**: the
 * chat target registers far more node kinds than this slice renders, so an
 * unmapped kind must surface as a labelled `unhandled` row rather than be skipped.
 * A pane that quietly dropped half a conversation would look like a working
 * feature.
 */

import { describe, expect, it } from 'vitest'

import { toConversationRows, type ChatNodeView } from '../src/client/cloud-workspaces/conversation-model.ts'

/** Build a snapshot from `[key, node]` pairs, in the given order. */
function snapshot(entries: readonly (readonly [string, ChatNodeView | undefined])[]) {
  const byKey = new Map(entries.filter(([, node]) => node !== undefined) as (readonly [string, ChatNodeView])[])
  return { order: entries.map(([key]) => key), nodes: { get: (key: string) => byKey.get(key) } }
}

describe('toConversationRows', () => {
  it('is empty for an unavailable snapshot', () => {
    expect(toConversationRows(undefined)).toEqual([])
  })

  it('follows the snapshot order and skips keys with no node', () => {
    const rows = toConversationRows(snapshot([
      ['b', { kind: 'user', data: { content: [{ type: 'text', text: '第二' }] } }],
      ['missing', undefined],
      ['a', { kind: 'user', data: { content: [{ type: 'text', text: '第一' }] } }],
    ]))

    expect(rows.map(row => (row.kind === 'user' ? row.text : row.kind))).toEqual(['第二', '第一'])
  })

  it('joins an assistant step\'s text blocks and counts the ones it does not render', () => {
    const rows = toConversationRows(snapshot([['a1', {
      kind: 'assistant-step',
      data: {
        status: 'settled',
        turn: 2,
        step: 1,
        blocks: [
          { kind: 'reasoning', text: '思考中' },
          { kind: 'text', text: '第一段' },
          { kind: 'text', text: '第二段' },
          { kind: 'image', attachment: { id: 'x' } },
        ],
      },
    }]]))

    expect(rows).toEqual([{
      kind: 'assistant',
      key: 'a1',
      status: 'settled',
      turn: 2,
      step: 1,
      text: '第一段\n第二段',
      // Reasoning and the image are not inlined here, but they are visible as a count
      // — "2 blocks not shown" beats a conversation that looks complete and is not.
      skippedBlocks: 2,
    }])
  })

  it('omits an assistant step that rendered nothing at all', () => {
    const rows = toConversationRows(snapshot([['a1', { kind: 'assistant-step', data: { blocks: [] } }]]))
    expect(rows).toEqual([])
  })

  it('keeps an assistant step that has only unrenderable blocks, so it is not invisible', () => {
    const rows = toConversationRows(snapshot([['a1', {
      kind: 'assistant-step',
      data: { blocks: [{ kind: 'reasoning', text: '只有推理' }] },
    }]]))

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'assistant', text: '', skippedBlocks: 1 })
  })

  it('renders user and steering messages, and drops an empty one', () => {
    const rows = toConversationRows(snapshot([
      ['u1', { kind: 'user', data: { content: [{ type: 'text', text: '你好' }] } }],
      ['u2', { kind: 'user', data: { content: [] } }],
      ['s1', { kind: 'steering', data: { content: [{ type: 'text', text: '补充一句' }] } }],
    ]))

    expect(rows).toEqual([
      { kind: 'user', key: 'u1', text: '你好' },
      { kind: 'user', key: 's1', text: '补充一句' },
    ])
  })

  it('renders a tool call by its root name, with a labelled fallback', () => {
    const rows = toConversationRows(snapshot([
      ['t1', { kind: 'tool-call', data: { root: { name: 'read_file' } } }],
      ['t2', { kind: 'tool-call', data: { root: {} } }],
    ]))

    expect(rows).toEqual([
      { kind: 'tool', key: 't1', name: 'read_file' },
      { kind: 'tool', key: 't2', name: '未知工具' },
    ])
  })

  it('renders a turn error with and without a provider code', () => {
    const rows = toConversationRows(snapshot([
      ['e1', { kind: 'turn-error', data: { message: '模型无响应', code: 'PROVIDER_TIMEOUT' } }],
      ['e2', { kind: 'turn-error', data: { message: '' } }],
    ]))

    expect(rows).toEqual([
      { kind: 'error', key: 'e1', message: '模型无响应', code: 'PROVIDER_TIMEOUT' },
      { kind: 'error', key: 'e2', message: '本轮以错误结束' },
    ])
  })

  it('surfaces every unmapped kind by name instead of dropping it', () => {
    // These kinds are registered by the chat target today; the list is the work
    // queue for the next slice, and each must be visible until then.
    const kinds = ['turn-process', 'compaction', 'request-prompt', 'retry', 'turn-max-tokens', 'turn-tail', 'command', 'fallback']

    const rows = toConversationRows(snapshot(kinds.map((kind, index) => [`k${index}`, { kind, data: {} }])))

    expect(rows).toEqual(kinds.map((kind, index) => ({ kind: 'unhandled', key: `k${index}`, nodeKind: kind })))
  })
})
