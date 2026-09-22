/**
 * Browser-side deployment settings for the remote client layer.
 *
 * Two sources:
 *
 * 1. **The deployment declaration** the host rows inject into the served page
 *    (`src/deployment-contract.ts`). The 0.1.5-rc.2 client runner delivers no
 *    mount-row configuration to browser fragments, so the rows publish their own
 *    slice through the webserver's structured injection table instead. This is
 *    the default: the operator configures the row once and every browser picks it
 *    up without being told anything.
 * 2. **This settings face**, persisted in `localStorage`: the config channel for
 *    a deployment that declared nothing, and an explicit **override** on one that
 *    did.
 *
 * An explicitly saved value wins over the declaration, because that is what
 * saving the form means. The opposite rule (declaration always wins) silently
 * voided the operator's deliberate choice, which is the worse failure: a browser
 * whose effective settings cannot be explained cannot be repaired either. What
 * actually prevented a stranded operator before was not precedence but the fact
 * that the form was unreachable once anything was configured — so the form is now
 * openable from the workbench's failure state, and an override can be dropped
 * again with {@link clearBrowserSettings}.
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

/**
 * Drop this browser's override so the deployment declaration applies again.
 *
 * The escape hatch that makes "a saved value wins" safe: without it an operator
 * who once pointed the workbench at a service that has since moved would have no
 * way back to the deployment's own value, and no way to reach the form to fix it.
 */
export function clearBrowserSettings(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Storage can be denied (private mode); nothing was persisted to begin with.
  }
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
 * A value saved in this browser is an explicit override and wins; otherwise the
 * deployment's declaration applies. Both sources are shaped like the row config,
 * so the same resolver validates them and applies the "workspace endpoint follows
 * the platform endpoint unless declared" rule.
 * @returns the resolved configuration, or `undefined` while unconfigured.
 */
export function resolveBrowserSettings(): ResolvedPlatformClientConfig | undefined {
  const settings = readBrowserSettings() ?? readDeploymentSettings()
  if (settings === undefined) return undefined
  return resolvePlatformClientConfig(settings)
}
