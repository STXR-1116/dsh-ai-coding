/**
 * Adapt DSH's per-session conversation source to the shape this pane consumes.
 *
 * ## What is known, and what is not
 *
 * Known: `ctx.uiConversation.binding(sessionId)` resolves a per-session
 * `ConversationBinding`, and `binding.target('chat')` resolves the chat target's
 * own snapshot source (both documented in `dsh-client-ui-conversation`'s README,
 * mirrored in `docs/cloud-workspace-redesign.md` §2). The README is also explicit
 * about subscription being what activates a target: 「target source 收到首个
 * subscriber 时，该 target 进入 active 状态」.
 *
 * Not known from any shipped artifact: the **declaration** of `ObservableSnapshot`.
 * It comes from `@deepseek-ai/dsh-client-store`, which this machine's DSH install
 * does not contain — only imports of it — and the official manual does not document
 * it (checked: no hit in `~/.dsh/dsh-manual/`). So the two method names below are
 * the React-external-store contract (`getSnapshot` / `subscribe`), which is what the
 * README's subscriber language and the rest of the client plane point at.
 *
 * The response to that uncertainty is **not** a hopeful cast: this adapter checks
 * for both methods and reports a stable, visible failure when they are absent. The
 * first real run then either works or says precisely which method was missing,
 * instead of rendering an empty conversation that looks like a working feature.
 *
 * @module dsh-ai-coding/client/cloud-workspaces/conversation-source
 */

import type { ChatSnapshotView } from './conversation-model.ts'

/** What the conversation pane needs from a snapshot source. */
export interface ConversationSource {
  /** Current value; may be `undefined` until the target has materialized. */
  getSnapshot(): ChatSnapshotView | undefined
  /**
   * Observe changes.
   * @param onChange - called after each change; subscribing also activates the target.
   * @returns the unsubscribe function.
   */
  subscribe(onChange: () => void): () => void
}

/** Either a usable source or the reason there is none. */
export type ConversationSourceResult =
  | { readonly ok: true; readonly source: ConversationSource }
  | { readonly ok: false; readonly message: string }

/**
 * Narrow an unknown snapshot source onto {@link ConversationSource}.
 * @param raw - the value `binding.target('chat')` returned.
 * @returns the source, or a message naming what was missing.
 */
export function readConversationSource(raw: unknown): ConversationSourceResult {
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, message: '会话快照源不可用：未取到 chat target（可能未注册）' }
  }
  const candidate = raw as { getSnapshot?: unknown; subscribe?: unknown }
  if (typeof candidate.getSnapshot !== 'function' || typeof candidate.subscribe !== 'function') {
    const present = Object.keys(raw as object).slice(0, 8).join(', ')
    return {
      ok: false,
      message: `会话快照 API 不匹配：期望 getSnapshot/subscribe，实际成员为 [${present}]`,
    }
  }
  const source = candidate as ConversationSource
  return {
    ok: true,
    source: {
      // Bound through wrappers rather than returned as-is: the underlying object may
      // rely on its receiver, and a detached method call is a classic source of
      // "cannot read properties of undefined" at the worst possible moment.
      getSnapshot: () => source.getSnapshot(),
      subscribe: onChange => source.subscribe(onChange),
    },
  }
}
