/**
 * The `shell.overlay` contribution: the workbench surface behind a boundary.
 *
 * Same reasoning as the sidebar entry (see `slot-boundary.tsx`): a render error
 * inside the surface would otherwise make the renderer retire this entry for the
 * rest of the page's life, leaving the launcher pointing at nothing. Here the
 * fallback is a visible, named panel — the operator learns the workbench failed
 * and that the console has the cause, instead of clicking a button that opens an
 * empty frame.
 *
 * @module dsh-ai-coding/client/PlatformSurfaceEntry
 */

import { SlotBoundary } from './slot-boundary.tsx'
import { PlatformSurface, type PlatformSurfaceProps } from './PlatformSurface.tsx'
import css from './PlatformSurface.module.css'

/**
 * Shown in place of the workbench when it cannot render.
 *
 * Deliberately minimal: no remote reads, no locale lookup, no icons — the same
 * restraint that keeps `PlainEntry` from failing for the same reason its sibling
 * did.
 */
function SurfaceFailure() {
  return (
    <div className={css.surfaceError} role="alert">
      <p><strong>协作台界面渲染失败 / The workbench failed to render.</strong></p>
      <p>
        浏览器控制台里有带 <code>[dsh-ai-coding]</code> 前缀的错误详情；重新加载页面即可恢复。
        <br />
        The browser console holds the cause under the <code>[dsh-ai-coding]</code> tag; reloading
        the page recovers.
      </p>
    </div>
  )
}

/** The workbench overlay with its own failure containment. */
export function PlatformSurfaceEntry(props: PlatformSurfaceProps) {
  return (
    <SlotBoundary slot="shell.overlay" fallback={<SurfaceFailure />}>
      <PlatformSurface {...props} />
    </SlotBoundary>
  )
}
