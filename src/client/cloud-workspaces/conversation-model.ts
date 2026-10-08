/**
 * Project a Chat snapshot into the rows the workbench's conversation pane renders.
 *
 * ## Why a separate pure module
 *
 * The snapshot comes from DSH's conversation assembly, which is a large
 * declaration-merged type system living in packages this repository does not
 * depend on (and cannot install — the npm registry is unreachable here). So the
 * bridge is kept to the smallest possible surface: this module takes a
 * **structurally typed** snapshot and returns plain rows, which makes the mapping
 * testable without any DSH runtime, and keeps the one place that must track those
 * contracts obvious.
 *
 * Shapes below were read from the shipped contracts, never guessed:
 *
 * | fact | source (under `@deepseek-ai/dsh/node_modules/`) |
 * | --- | --- |
 * | `ChatSnapshot { order, nodes }` | `dsh-client-ui-chat/lib/types/client/contract/snapshot.d.ts` |
 * | `ChatNode = ChatConversationViewNode & { kind, data }`, kinds from `ChatNodeDataMap` | `…/contract/chat-nodes.d.ts` + `…/conversation-nodes/*.d.ts` |
 * | `AssistantChatData { status, turn, step, blocks, time }` | `…/contract/chat-nodes.d.ts` |
 * | `AssistantBlock` = `text \| reasoning \| image \| tool-call \| other` | `dsh-client-ui-conversation/lib/types/client/contract/records.d.ts` |
 * | `TurnErrorNode { kind: 'turn-error', message, code?, seq, time, turn, step }` | same file |
 * | `ToolChatData { root: ToolCallBlock { name, … } }` | `…/contract/chat-nodes.d.ts` |
 * | `UserMessageNode { kind: 'user', content: ContentBlock[], seq, time }` | same file |
 *
 * ## Unknown kinds are rows, not omissions
 *
 * The chat target registers far more kinds than this slice renders (command,
 * compaction, request-prompt, retry, turn-max-tokens, turn-process, turn-tail,
 * fallback, steering, context…). Anything unmapped becomes an `unhandled` row
 * carrying its kind name: a conversation that silently dropped half its content
 * would look like a working feature, and the kind names are exactly the list that
 * says what to implement next.
 *
 * @module dsh-ai-coding/client/cloud-workspaces/conversation-model
 */

/** One node as this pane reads it: a discriminant plus an opaque payload. */
export interface ChatNodeView {
  /** Registered renderer kind (`ChatNode.kind`). */
  readonly kind: string
  /** Kind-specific payload (`ChatNode.data`). */
  readonly data?: unknown
}

/** The slice of `ChatSnapshot` this pane consumes. */
export interface ChatSnapshotView {
  /** Render order of node keys (`ChatSnapshot.order`). */
  readonly order: readonly string[]
  /** Node accessor (`ChatNodeStore`): `get(key)`. */
  readonly nodes: { get(key: string): ChatNodeView | undefined }
}

/** One renderable line of the conversation. */
export type ConversationRow =
  | {
    readonly kind: 'assistant'
    readonly key: string
    readonly status: string
    readonly turn: number
    readonly step: number
    readonly text: string
    /** Blocks this slice does not render (reasoning, images, `other`), counted so they are not invisible. */
    readonly skippedBlocks: number
  }
  | { readonly kind: 'user'; readonly key: string; readonly text: string }
  | { readonly kind: 'tool'; readonly key: string; readonly name: string }
  | { readonly kind: 'error'; readonly key: string; readonly message: string; readonly code?: string }
  | { readonly kind: 'unhandled'; readonly key: string; readonly nodeKind: string }

/** Narrow an unknown payload to a record, or `undefined` when it is not one. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/**
 * Concatenate the text of one assistant step's blocks.
 * @param blocks - `AssistantChatData.blocks`, if present.
 * @returns the joined text and how many blocks were not text.
 */
function readAssistantBlocks(blocks: unknown): { text: string; skipped: number } {
  if (!Array.isArray(blocks)) return { text: '', skipped: 0 }
  const parts: string[] = []
  let skipped = 0
  for (const block of blocks) {
    const record = asRecord(block)
    // `AssistantBlock` is a union over `kind`; only `text` is prose. `reasoning`
    // and images are deliberately not inlined here — the shell's own renderer has
    // dedicated affordances for them — but they are counted, not dropped.
    if (record !== undefined && record.kind === 'text' && typeof record.text === 'string') {
      parts.push(record.text)
    } else {
      skipped += 1
    }
  }
  return { text: parts.join('\n').trim(), skipped }
}

/**
 * Read one user message's text.
 * @param content - `UserMessageNode.content`, if present.
 * @returns the joined text of its text blocks.
 */
function readUserContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (record !== undefined && record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
  }
  return parts.join('\n').trim()
}

/**
 * Map one node to a row.
 * @param key - the node's key, kept for React identity and diagnostics.
 * @param node - the node itself.
 * @returns the row, or `undefined` when the node carries nothing to show.
 */
function toRow(key: string, node: ChatNodeView): ConversationRow | undefined {
  const data = asRecord(node.data)
  switch (node.kind) {
    case 'assistant-step': {
      const { text, skipped } = readAssistantBlocks(data?.blocks)
      if (text.length === 0 && skipped === 0) return undefined
      return {
        kind: 'assistant',
        key,
        status: typeof data?.status === 'string' ? data.status : 'unknown',
        turn: typeof data?.turn === 'number' ? data.turn : 0,
        step: typeof data?.step === 'number' ? data.step : 0,
        text,
        skippedBlocks: skipped,
      }
    }
    case 'user':
    case 'steering': {
      // `steering` shares the user-message payload shape (middle-of-turn input).
      const text = readUserContent(data?.content)
      return text.length === 0 ? undefined : { kind: 'user', key, text }
    }
    case 'tool-call': {
      const root = asRecord(data?.root)
      const name = typeof root?.name === 'string' ? root.name : '未知工具'
      return { kind: 'tool', key, name }
    }
    case 'turn-error': {
      // The node's payload *is* the record (`ChatNodeDataMap['turn-error']`).
      const source = asRecord(node.data)
      const message = typeof source?.message === 'string' && source.message.length > 0
        ? source.message
        : '本轮以错误结束'
      const code = typeof source?.code === 'string' ? source.code : undefined
      return code === undefined
        ? { kind: 'error', key, message }
        : { kind: 'error', key, message, code }
    }
    default:
      return { kind: 'unhandled', key, nodeKind: node.kind }
  }
}

/**
 * Project a Chat snapshot into render rows, in the snapshot's own order.
 * @param snapshot - the chat target's snapshot, or `undefined` while unavailable.
 * @returns the rows; empty when the conversation has no rendered content yet.
 */
export function toConversationRows(snapshot: ChatSnapshotView | undefined): readonly ConversationRow[] {
  if (snapshot === undefined) return []
  const rows: ConversationRow[] = []
  for (const key of snapshot.order) {
    const node = snapshot.nodes.get(key)
    // A key in `order` with no node is a real state (the store drops nodes the
    // assembler no longer materializes), so it is skipped rather than rendered as
    // an empty row.
    if (node === undefined) continue
    const row = toRow(key, node)
    if (row !== undefined) rows.push(row)
  }
  return rows
}
