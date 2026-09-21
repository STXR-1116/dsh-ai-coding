/**
 * Browser-side deployment settings for the remote client layer.
 *
 * Two sources, in this order:
 *
 * 1. **The deployment declaration** the host rows inject into the served page
 *    (`src/deployment-contract.ts`). The 0.1.5-rc.2 client runner delivers no
 *    mount-row configuration to browser fragments, so the rows publish their own
 *    slice through the webserver's structured injection table instead. This is
 *    the normal case: the operator configures the row once and every browser
 *    picks it up.
 * 2. **This settings face**, persisted in `localStorage`, used when the
 *    deployment declared nothing (a bare mount with no endpoint configured).
 *    That is the case the form exists for, and the workbench then opens on it
 *    rather than pretending to be configured.
 *
 * The declaration deliberately wins: it is the deployment's own statement, and
 * letting a value typed in a browser shadow it would strand an operator on a
 * stale endpoint with no way back to the form (the form only shows when nothing
 * is configured).
 *
 * An unconfigured browser answers every remote read with the face's explicit
 * `not-ready` union — never a silent fake-ready.
 */

import { readDeploymentDeclaration } from '../../deployment-contract.ts'
import { resolvePlatformClientConfig } from './config.ts'
import type { PlatformClientConfig, ResolvedPlatformClientConfig } from './config.ts'

/** `localStorage` key the workbench settings persist under. */
const STORAGE_KEY = 'dsh-ai-coding/settings/v1'

/** The deployment values the browser face needs; same shape as the row config. */
export type BrowserRemoteSettings = PlatformClientConfig

/**
 * Read the deployment declaration the host injected into this page.
 * @returns the declared settings, or `undefined` when the page carries none.
 */
export function readDeploymentSettings(): BrowserRemoteSettings | undefined {
  const declaration = readDeploymentDeclaration()
  if (declaration === undefined) return undefined
  return declaration
}

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
 *
 * The deployment declaration wins over anything stored in this browser; see the
 * module header for why. Both sources are shaped like the row config, so the
 * same resolver validates them and applies the "workspace endpoint follows the
 * platform endpoint unless declared" rule.
 * @returns the resolved configuration, or `undefined` while unconfigured.
 */
export function resolveBrowserSettings(): ResolvedPlatformClientConfig | undefined {
  const settings = readDeploymentSettings() ?? readBrowserSettings()
  if (settings === undefined) return undefined
  return resolvePlatformClientConfig(settings)
}
