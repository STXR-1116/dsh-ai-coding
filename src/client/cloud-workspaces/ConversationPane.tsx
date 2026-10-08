/**
 * The Workspace's own conversation, rendered in the session column.
 *
 * Subscription is keyed on the **session**, not on the source object: the view may
 * hand down a fresh result object on any render, and re-subscribing per render
 * would churn the target (each subscribe activates it) and lose the previous
 * snapshot. The source is therefore read through a ref, and the effect depends on
 * the session id plus whether a source is currently usable.
 *
 * @module dsh-ai-coding/client/cloud-workspaces/ConversationPane
 */

import { useEffect, useRef, useState } from 'react'

import { toConversationRows, type ChatSnapshotView, type ConversationRow } from './conversation-model.ts'
import type { ConversationSourceResult } from './conversation-source.ts'
import css from './ConversationPane.module.css'

/** Props for {@link ConversationPane}. */
export interface ConversationPaneProps {
  /** Session the conversation belongs to; changing it re-subscribes. */
  readonly sessionId?: string
  /** The chat snapshot source, or why it is unavailable. */
  readonly source: ConversationSourceResult | undefined
}

/**
 * Render one row.
 * @param row - projection produced by {@link toConversationRows}.
 * @returns the row's element.
 */
function renderRow(row: ConversationRow) {
  switch (row.kind) {
    case 'assistant':
      return (
        <>
          <p className={css.assistant}>{row.text}</p>
          {row.skippedBlocks > 0 && (
            // Counted rather than hidden: reasoning, images and unknown blocks are
            // all real content, and a conversation that looks complete without them
            // is worse than one that says what it is not showing yet.
            <p className={css.skipped}>另有 {row.skippedBlocks} 个内容块暂未渲染（推理/图片等）</p>
          )}
        </>
      )
    case 'user':
      return <p className={css.user}>{row.text}</p>
    case 'tool':
      return <p className={css.tool}>工具调用：<code>{row.name}</code></p>
    case 'error':
      return (
        <p className={css.error} role="alert">
          {row.message}
          {row.code === undefined ? '' : `（${row.code}）`}
        </p>
      )
    case 'unhandled':
      return <p className={css.unhandled}>暂未渲染的节点类型：<code>{row.nodeKind}</code></p>
  }
}

/**
 * The conversation column.
 * @param props - the session identity and its resolved snapshot source.
 * @returns the pane, its empty state, or the reason the source is unusable.
 */
export function ConversationPane({ sessionId, source }: ConversationPaneProps) {
  const [snapshot, setSnapshot] = useState<ChatSnapshotView | undefined>()
  const sourceRef = useRef(source)
  sourceRef.current = source
  const availability = source === undefined ? 'none' : source.ok ? 'ok' : 'error'
  useEffect(() => {
    const current = sourceRef.current
    const usable = current !== undefined && current.ok ? current.source : undefined
    if (usable === undefined) {
      setSnapshot(undefined)
      return
    }
    // Read once before subscribing: the target may already have materialized, and
    // waiting for the next change would show an empty pane on a loaded session.
    setSnapshot(usable.getSnapshot() ?? undefined)
    return usable.subscribe(() => { setSnapshot(usable.getSnapshot() ?? undefined) })
  }, [sessionId, availability])

  if (source !== undefined && !source.ok) {
    return (
      <div className={css.pane}>
        {/* Labelled as well as `role="alert"`: the view renders other alert panels
            (detail and knowledge reads fail independently), so a screen reader and a
            test both need to know *which* alert this is. */}
        <p className={css.failure} role="alert" aria-label="工作空间会话状态">{source.message}</p>
      </div>
    )
  }

  const rows = toConversationRows(snapshot)
  if (rows.length === 0) {
    return (
      <div className={css.pane}>
        <div className={css.empty}>
          <p className={css.emptyTitle}>这个工作空间还没有对话内容</p>
          <p className={css.emptyHint}>本工作空间的会话已就绪。</p>
        </div>
      </div>
    )
  }

  return (
    <div className={css.pane}>
      <ol className={css.flow} aria-label="工作空间会话内容">
        {rows.map(row => (
          <li key={row.key} className={css.row} data-row-kind={row.kind}>{renderRow(row)}</li>
        ))}
      </ol>
    </div>
  )
}
