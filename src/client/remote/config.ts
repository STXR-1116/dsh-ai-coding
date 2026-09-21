/** Browser fragment configuration: the deployment values the remote client layer needs. */

import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import type { WorkspaceAuthMode } from '../../workspace-gateway.ts'

/**
 * Deployment configuration reaching the browser fragment.
 *
 * The loader validates the mount row's `config` against {@link PlatformClientConfigSchema}
 * (Standard Schema) before `apply` runs, so a missing required value fails the
 * fragment at load instead of degrading into a silent `not-ready` face. The
 * keys mirror the two backends the browser client talks to directly:
 *
 * - `apiBaseUrl` / `accessToken` — the AI Coding platform backend (`teamSkills`).
 * - `workspaceApiBaseUrl` / `workspaceAccessToken` / `authMode` — the cloud
 *   workspace backend (`cloudWorkspaces`); an omitted base URL falls back to
 *   `apiBaseUrl` at resolve time.
 */
export interface PlatformClientConfig {
  /** AI Coding platform service endpoint including `/v1`; required. */
  readonly apiBaseUrl: string
  /** Static platform token for no-login deployments; optional. */
  readonly accessToken?: string
  /** Cloud workspace service endpoint; omitted follows `apiBaseUrl`. */
  readonly workspaceApiBaseUrl?: string
  /** Static workspace token; only honored with `authMode: 'static-token'`. */
  readonly workspaceAccessToken?: string
  /** Workspace identity mode; defaults to `account`. */
  readonly authMode?: WorkspaceAuthMode
}

/**
 * The fragment's Schemastery schema. `apiBaseUrl` is `.required()` on purpose:
 * the one deployment value every browser read depends on must fail the row at
 * load with a validation issue instead of waiting silently (P0-2).
 */
export const PlatformClientConfigSchema: Schema<PlatformClientConfig> = z.object({
  apiBaseUrl: z.string().required(),
  accessToken: z.string(),
  workspaceApiBaseUrl: z.string(),
  workspaceAccessToken: z.string(),
  authMode: z.union(['account', 'static-token']),
})

/** A {@link PlatformClientConfig} whose defaults and identity rules are decided. */
export interface ResolvedPlatformClientConfig {
  /** Platform endpoint, blank-rejected. */
  readonly apiBaseUrl: string
  /** Static platform token, when the deployment declared one. */
  readonly accessToken?: string
  /** Workspace endpoint: the declared value, else the platform endpoint. */
  readonly workspaceApiBaseUrl: string
  /** Static workspace token, when the deployment declared `static-token`. */
  readonly workspaceAccessToken?: string
  /** Workspace identity mode, `account` unless declared otherwise. */
  readonly authMode: WorkspaceAuthMode
}

/**
 * Decide every derived config value once, at load.
 *
 * A blank `apiBaseUrl` fails loudly with the missing-deployment fix (schemastery
 * `required` cannot see an empty string), and the workspace identity rules are
 * the gateway's own: `static-token` demands a token, and a token without that
 * mode is ambiguous and rejected.
 * @param config - Raw row configuration after schema validation.
 * @returns the resolved configuration every service reads.
 * @throws when `apiBaseUrl` is blank, or the workspace token and mode disagree.
 */
export function resolvePlatformClientConfig(config: PlatformClientConfig): ResolvedPlatformClientConfig {
  const apiBaseUrl = config.apiBaseUrl.trim()
  if (apiBaseUrl.length === 0) {
    throw new Error(
      'dsh-ai-coding: apiBaseUrl is required but the deployment left it blank — '
      + 'set DSH_AI_CODING_PLATFORM_API_URL (including the /v1 prefix) in the mount row environment.',
    )
  }
  const authMode = config.authMode ?? 'account'
  const hasWorkspaceToken = config.workspaceAccessToken !== undefined && config.workspaceAccessToken.length > 0
  if (authMode === 'static-token' && !hasWorkspaceToken) {
    throw new Error('cloudWorkspaces authMode "static-token" requires a non-empty accessToken.')
  }
  if (authMode !== 'static-token' && config.workspaceAccessToken !== undefined) {
    throw new Error('cloudWorkspaces accessToken is only allowed together with authMode "static-token".')
  }
  return {
    apiBaseUrl,
    ...(config.accessToken === undefined || config.accessToken.length === 0 ? {} : { accessToken: config.accessToken }),
    workspaceApiBaseUrl: config.workspaceApiBaseUrl === undefined || config.workspaceApiBaseUrl.trim().length === 0
      ? apiBaseUrl
      : config.workspaceApiBaseUrl.trim(),
    ...(hasWorkspaceToken ? { workspaceAccessToken: config.workspaceAccessToken as string } : {}),
    authMode,
  }
}
