/**
 * Wire vocabulary shared by both halves of the host bridge.
 *
 * This module exists so the browser half can name the channel without importing
 * the host half. It must stay import-free: `src/host-bridge.ts` pulls in the host
 * operation owner and Connection's zod envelope schema, and anything the browser
 * imports reaches the client bundle, where the purity gate rejects cross-plugin
 * `@deepseek-ai` value imports. Sharing a module that has no imports at all keeps
 * both halves on one source of truth without that coupling.
 *
 * @module dsh-ai-coding/bridge-contract
 */

/**
 * Absolute path prefix this plugin owns on the host web server.
 *
 * Separate from `/api` on purpose: the shared channel is claimed
 * endpoint-by-endpoint by `@deepseek-ai/dsh-api-gateway`, so a plugin-owned
 * prefix keeps these endpoints out of every other plugin's namespace.
 */
export const HOST_BRIDGE_CHANNEL = '/dsh-ai-coding'

/** Endpoint names on {@link HOST_BRIDGE_CHANNEL}, shared by both halves. */
export const HOST_BRIDGE_ENDPOINTS = {
  /** List the host's local installation records. Payload: `projectId`. */
  installations: 'teamSkills/installations',
  /** Reconcile local copies against server release state. Payload: `projectId`. */
  syncReleaseStatus: 'teamSkills/syncReleaseStatus',
  /** Download, verify and write one release into a host Skill root. */
  install: 'teamSkills/install',
  /** Remove one host-managed local copy. */
  uninstall: 'teamSkills/uninstall',
} as const

/** One endpoint name on this plugin's bridge channel. */
export type HostBridgeEndpoint = (typeof HOST_BRIDGE_ENDPOINTS)[keyof typeof HOST_BRIDGE_ENDPOINTS]

/** Why one bridge call failed before reaching its operation. */
export const HOST_BRIDGE_UNKNOWN_ENDPOINT = 'ai-coding/unknown-endpoint'

/** Why one bridge call could not be placed at all. */
export const HOST_BRIDGE_UNAVAILABLE = 'ai-coding/host-bridge-unavailable'

/** Carrier or programming failure on the way to a host operation. */
export const HOST_BRIDGE_INTERNAL = 'gateway/internal'
