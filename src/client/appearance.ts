/** User appearance preferences shared by the plugin surface (spec §8: theme
 * + density are token switches only; they never reorder content or change
 * business behavior). Persisted in localStorage; a failed read or write keeps
 * the current preference instead of crashing the surface. */
/** Where the surface takes its theme from: a fixed choice or the OS setting. */
export type ThemePreference = 'system' | 'dark' | 'light'
/** How dense lists and controls render; token-driven, never reorders content. */
export type DensityPreference = 'compact' | 'comfortable'

/** The persisted visual preferences of the surface. */
export interface Appearance {
  readonly theme: ThemePreference
  readonly density: DensityPreference
}

const THEME_KEY = 'dsh.appearance.theme'
const DENSITY_KEY = 'dsh.appearance.density'
const THEMES: readonly ThemePreference[] = ['system', 'dark', 'light']
const DENSITIES: readonly DensityPreference[] = ['compact', 'comfortable']

/** The plugin surface defaults to dark + compact (design spec §2/§8). */
export const DEFAULT_APPEARANCE: Appearance = { theme: 'dark', density: 'compact' }

/**
 * Read the persisted preferences, falling back to the surface defaults when
 * nothing is stored or storage is unavailable.
 * @returns the stored preferences, or {@link DEFAULT_APPEARANCE}.
 */
export function loadAppearance(): Appearance {
  try {
    const theme = window.localStorage.getItem(THEME_KEY)
    const density = window.localStorage.getItem(DENSITY_KEY)
    return {
      theme: THEMES.find(value => value === theme) ?? DEFAULT_APPEARANCE.theme,
      density: DENSITIES.find(value => value === density) ?? DEFAULT_APPEARANCE.density,
    }
  } catch {
    // localStorage can be unavailable (storage disabled): keep defaults.
    return DEFAULT_APPEARANCE
  }
}

/**
 * Persist the preferences. Best-effort: storage failures keep the in-memory
 * preference without surfacing an error to the surface.
 * @param appearance the preferences to persist.
 */
export function saveAppearance(appearance: Appearance): void {
  try {
    window.localStorage.setItem(THEME_KEY, appearance.theme)
    window.localStorage.setItem(DENSITY_KEY, appearance.density)
  } catch {
    // Persisting is best-effort; the in-memory preference still applies.
  }
}

/**
 * Resolve a theme preference against the OS setting (`system` follows it).
 * @param theme the stored preference.
 * @param prefersDark whether the OS currently prefers a dark scheme.
 * @returns the concrete theme the surface must render.
 */
export function resolveTheme(theme: ThemePreference, prefersDark: boolean): 'dark' | 'light' {
  if (theme !== 'system') return theme
  return prefersDark ? 'dark' : 'light'
}
