/**
 * Keeps this plugin's slot contributions alive when their content fails.
 *
 * The renderer gives every slot entry its own React error boundary, and on a
 * caught error it does two things: logs
 * `slot entry crashed in '<slot>': <error>` and calls `onEntryError`, which the
 * slot core turns into an **abdication** — the entry is excluded from that
 * slot's projection "for the rest of its registration's life"
 * (`dsh-client-ui-slots`, `abdicated` ledger). The registration stays on the
 * ledger, so nothing re-renders it and nothing tells the user why the launcher
 * went away; only a page reload brings it back.
 *
 * That is the wrong outcome for a launcher: a transient fault inside a label
 * lookup or an icon must not remove the only way into the workbench for the rest
 * of the session. Wrapping our contributions in our own boundary means the
 * framework sees a successful render, so the entry stays mounted and can still
 * do its job — degraded, named, and recoverable — instead of disappearing.
 *
 * This does **not** hide failures: the boundary reports to the console with this
 * plugin's own tag, and each caller supplies a fallback that is still useful
 * (see the two call sites). It is deliberately not a substitute for fixing the
 * underlying fault — it is what keeps the fault from escalating a small render
 * error into a vanished feature.
 *
 * @module dsh-ai-coding/client/slot-boundary
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'

/** Props for {@link SlotBoundary}. */
export interface SlotBoundaryProps {
  /** Slot the wrapped contribution renders into; used in the console report. */
  readonly slot: string
  /** What to render instead of the children once they have failed. */
  readonly fallback: ReactNode
  readonly children: ReactNode
}

interface SlotBoundaryState {
  readonly failed: boolean
}

/**
 * React error boundary for one slot contribution.
 *
 * A class component because React has no hook form of
 * `getDerivedStateFromError`/`componentDidCatch`.
 */
export class SlotBoundary extends Component<SlotBoundaryProps, SlotBoundaryState> {
  override state: SlotBoundaryState = { failed: false }

  /** Switch to the fallback instead of letting the failure reach the slot. */
  static getDerivedStateFromError(): SlotBoundaryState {
    return { failed: true }
  }

  /** Report once, tagged with this plugin, so the cause stays findable. */
  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(
      `[dsh-ai-coding] slot contribution for '${this.props.slot}' failed to render; showing its fallback so the entry is not retired:`,
      error,
      info.componentStack,
    )
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}
