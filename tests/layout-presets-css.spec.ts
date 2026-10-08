/**
 * Structural invariants for the workbench's layout presets.
 *
 * A layout preset hides panes with `display: none`, but the column template is
 * explicit (five tracks: pane, separator, pane, separator, pane). **Hiding an element
 * does not release its track** — so a preset that hides a pane without rewriting the
 * template leaves dead space and squeezes the survivors. That is exactly what shipped:
 * 「专注会话」 rendered its content one character per line between a 260px and a 320px
 * empty track.
 *
 * No layout engine runs in these tests, so the invariant is checked against the
 * stylesheet itself: every preset that hides panes must also declare a template with
 * five tracks, and it must hide whole panes (hiding a sub-panel releases nothing).
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const CSS_PATH = new URL('../src/client/cloud-workspaces/CloudWorkspacesView.module.css', import.meta.url)
const css = readFileSync(CSS_PATH, 'utf8')

/** Presets that hide at least one pane, and the panes they must therefore hide whole. */
const PRESETS = ['focus-session', 'review-diff', 'monitor-runs'] as const
/** The only selectors that may be hidden by a preset: whole columns. */
const HIDEABLE = ['.leftPane', '.centerPane', '.rightPane']
/** Sub-panels that live inside a column; hiding one releases no track. */
const NOT_HIDEABLE = ['.nativeSessionPane', '.lensSection']

/** Body of the rule whose selector is exactly `selector`. */
function ruleBody(selector: string): string | undefined {
  // Only `[`, `]` and `.` are escaped: under the `u` flag an escape such as `\=` or
  // `\'` is a *syntax error*, not a no-op, so quoting every punctuation character
  // made the whole expression invalid.
  const escaped = selector.replace(/[.[\]]/gu, character => `\\${character}`)
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'u').exec(css)
  return match?.[1]
}

/**
 * Count tracks in a `grid-template-columns` value.
 *
 * Function-valued tracks contain spaces (`var(--dsh-tree-w, 260px)`,
 * `minmax(0, 1fr)`), so every `name(...)` is collapsed to a single token first —
 * splitting the raw value reported eight tracks for a five-track template, and six
 * after only `var()` was handled.
 * @param tracks - the declaration's value.
 * @returns how many tracks it declares.
 */
function trackCount(tracks: string): number {
  return tracks.replace(/\w+\([^)]*\)/gu, 'TRACK').trim().split(/\s+/u).length
}

describe('layout preset CSS invariants', () => {
  it.each(PRESETS)('releases the tracks of everything %s hides', preset => {
    const body = ruleBody(`.columns[data-layout='${preset}']`)
    expect(body, `${preset} must rewrite the column template, or hidden panes keep their tracks`).toBeDefined()
    // Five tracks, so the declaration replaces the base template rather than leaving
    // any of its tracks in place.
    const tracks = (body ?? '').match(/grid-template-columns:\s*([^;]+);/u)?.[1]
    expect(tracks, `${preset} has no grid-template-columns`).toBeDefined()
    expect(trackCount(tracks ?? '')).toBe(5)
  })

  it('hides whole columns only, never a sub-panel', () => {
    for (const preset of PRESETS) {
      for (const selector of NOT_HIDEABLE) {
        expect(css).not.toContain(`.columns[data-layout='${preset}'] ${selector}`)
      }
    }
  })

  it('every preset hides at least one whole column', () => {
    for (const preset of PRESETS) {
      const hidden = HIDEABLE.filter(selector => css.includes(`.columns[data-layout='${preset}'] ${selector}`))
      expect(hidden.length, `${preset} hides nothing`).toBeGreaterThan(0)
    }
  })

  it('keeps the base template at five tracks', () => {
    // The preset templates above are written against this shape; if the base changes,
    // they all need revisiting rather than silently mismatching.
    const body = ruleBody('.columns')
    const tracks = (body ?? '').match(/grid-template-columns:\s*([\s\S]*?);/u)?.[1]
    expect(tracks, '.columns has no grid-template-columns').toBeDefined()
    expect(trackCount(tracks ?? '')).toBe(5)
  })
})
