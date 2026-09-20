/** Local open-state controller shared by the sidebar action and overlay. */
export class PlatformDemoController {
  private openState = false
  private readonly listeners = new Set<() => void>()

  /** Read whether the demo surface is currently visible. */
  getSnapshot = (): boolean => this.openState

  /** Subscribe to visibility changes. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Show the demo surface. */
  open = (): void => {
    if (this.openState) return
    this.openState = true
    this.emit()
  }

  /** Hide the demo surface. */
  close = (): void => {
    if (!this.openState) return
    this.openState = false
    this.emit()
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}
