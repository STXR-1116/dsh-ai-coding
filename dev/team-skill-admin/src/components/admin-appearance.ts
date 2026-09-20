/** Admin appearance preferences (spec §8): theme + density are token switches
 * only. The admin defaults to light + comfortable; the same localStorage keys
 * serve the plugin surface so both ends agree on the user's choice. */
export type AdminThemePreference = 'system' | 'dark' | 'light'
export type AdminDensityPreference = 'compact' | 'comfortable'

export interface AdminAppearance {
  readonly theme: AdminThemePreference
  readonly density: AdminDensityPreference
}

const THEME_KEY = 'dsh.appearance.theme'
const DENSITY_KEY = 'dsh.appearance.density'
const THEMES: readonly AdminThemePreference[] = ['system', 'dark', 'light']
const DENSITIES: readonly AdminDensityPreference[] = ['compact', 'comfortable']

export const DEFAULT_ADMIN_APPEARANCE: AdminAppearance = { theme: 'light', density: 'comfortable' }

export function loadAdminAppearance(): AdminAppearance {
  try {
    const theme = window.localStorage.getItem(THEME_KEY)
    const density = window.localStorage.getItem(DENSITY_KEY)
    return {
      theme: THEMES.find(value => value === theme) ?? DEFAULT_ADMIN_APPEARANCE.theme,
      density: DENSITIES.find(value => value === density) ?? DEFAULT_ADMIN_APPEARANCE.density,
    }
  } catch {
    // Storage unavailable (privacy mode): keep defaults in memory.
    return DEFAULT_ADMIN_APPEARANCE
  }
}

/** Persist and verify by read-back. Returns a failure message when the write
 * cannot be confirmed; never reports success without verification. */
export function saveAdminAppearance(appearance: AdminAppearance): string | undefined {
  try {
    window.localStorage.setItem(THEME_KEY, appearance.theme)
    window.localStorage.setItem(DENSITY_KEY, appearance.density)
    const theme = window.localStorage.getItem(THEME_KEY)
    const density = window.localStorage.getItem(DENSITY_KEY)
    if (theme !== appearance.theme || density !== appearance.density) {
      return '浏览器存储写入校验未通过'
    }
    return undefined
  } catch {
    return '浏览器拒绝了本地存储写入'
  }
}

/** Resolve a theme preference against the OS setting (`system` follows it). */
export function resolveAdminTheme(theme: AdminThemePreference, prefersDark: boolean): 'dark' | 'light' {
  if (theme !== 'system') return theme
  return prefersDark ? 'dark' : 'light'
}
