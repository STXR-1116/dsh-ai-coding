/**
 * Browser-side deployment settings for the remote client layer.
 *
 * The 0.1.5-rc.2 client runner delivers no mount-row configuration to browser
 * fragments (`apply(ctx, config)` receives `undefined`; the boot manifest
 * carries no config; no shipped client fragment exports `Config`) — the row
 * config the `!!js` patch expressions produce exists on the host side only.
 * The browser half therefore takes its deployment values from this settings
 * face: the workbench's own configuration form, persisted in `localStorage`
 * and applied live. An unconfigured browser answers every remote read with
 * the face's explicit `not-ready` union — never a silent fake-ready.
 */

import { resolvePlatformClientConfig } from './config.ts'
import type { PlatformClientConfig, ResolvedPlatformClientConfig } from './config.ts'

/** `localStorage` key the workbench settings persist under. */
const STORAGE_KEY = 'dsh-ai-coding/settings/v1'

/** The deployment values the browser face needs; same shape as the row config. */
export type BrowserRemoteSettings = PlatformClientConfig

/**
 * Read the persisted settings.
 * @returns the stored settings, or `undefined` when nothing usable is stored.
 */
export function readBrowserSettings(): BrowserRemoteSettings | undefined {
  if (typeof localStorage === 'undefined') return undefined
  let raw: string | null
  try {
    raw = localStorage.getItem(STORAGE_KEY)
  } catch {
    // Storage can be denied (private mode); that is the unconfigured state.
    return undefined
  }
  if (raw === null) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as Record<string, unknown>
    if (typeof record.apiBaseUrl !== 'string' || record.apiBaseUrl.length === 0) return undefined
    return {
      apiBaseUrl: record.apiBaseUrl,
      ...(typeof record.accessToken === 'string' ? { accessToken: record.accessToken } : {}),
      ...(typeof record.workspaceApiBaseUrl === 'string' ? { workspaceApiBaseUrl: record.workspaceApiBaseUrl } : {}),
      ...(typeof record.workspaceAccessToken === 'string' ? { workspaceAccessToken: record.workspaceAccessToken } : {}),
      ...(record.authMode === 'static-token' || record.authMode === 'account' ? { authMode: record.authMode } : {}),
    }
  } catch {
    // Unparseable stored settings are the unconfigured state, not a crash: the
    // settings form overwrites them on the next save.
    return undefined
  }
}

/**
 * Persist the settings and wake every subscriber.
 * @param settings - The deployment values to store.
 */
export function writeBrowserSettings(settings: BrowserRemoteSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  for (const listener of [...listeners]) listener()
}

const listeners = new Set<() => void>()

/**
 * Subscribe to settings changes.
 * @param listener - Invoked after every {@link writeBrowserSettings}.
 * @returns the disposer.
 */
export function subscribeBrowserSettings(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * Resolve the current settings into the decided config the services build on.
 * @returns the resolved configuration, or `undefined` while unconfigured.
 */
export function resolveBrowserSettings(): ResolvedPlatformClientConfig | undefined {
  const settings = readBrowserSettings()
  if (settings === undefined) return undefined
  return resolvePlatformClientConfig(settings)
}
