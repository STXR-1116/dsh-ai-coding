/**
 * Deployment declaration: the row configuration the browser half needs, carried
 * into the served page.
 *
 * ## Why this module exists
 *
 * The 0.1.5-rc.2 client runner delivers **no** mount-row configuration to
 * browser fragments: `apply(ctx, config)` receives `undefined`, and the boot
 * manifest carries no config keys (re-measured — the served page contains the
 * module roster record but none of `apiBaseUrl` / `accessToken` /
 * `stateDirectory`). The row config the `!!js` patch expressions produce exists
 * on the host side only.
 *
 * That is why the workbench used to open on a settings form: the browser had
 * nowhere else to learn its deployment values, so the operator typed them once
 * per browser. That is the wrong place for a deployment property — the manual's
 * rule is that anything a deployment may need to vary belongs in the **row
 * config**, which the host already holds.
 *
 * So each row declares its own slice into the served index through the
 * webserver's structured injection table (`{ kind: 'global', … }`, rendered as
 * `globalThis["<name>"] = <json>` in the head, ahead of every module script).
 * This is the same mechanism `@deepseek-ai/dsh-client-ui-theme` uses to publish
 * the boot theme for the browser's pre-plugin interval — the first-party pattern
 * for "a host value the page needs at plugin boot".
 *
 * Each row injects its **own** global, so the two rows stay independent: either
 * may be mounted alone, and neither waits on the other.
 *
 * ## What may cross to the browser
 *
 * | value | injected? | why |
 * |---|---|---|
 * | `apiBaseUrl` / `workspaceApiBaseUrl` | always | not a secret; the browser's whole job is to call these |
 * | platform `accessToken` | when the row config sets one | that key's documented meaning *is* "static token for a no-login deployment", and in one the browser cannot read anything without it |
 * | workspace `accessToken` | only with `authMode: 'static-token'` | the key is documented as honored only in that mode, and `account` deployments authenticate per user instead |
 *
 * `account` deployments therefore hand the page no secret at all: the operator
 * signs in and the browser uses that session. A no-login deployment hands over
 * the fixed token it already expects every reader of that deployment to use.
 * Both rows are gated behind the browser-session index authorization, so only an
 * authenticated page receives them.
 *
 * @module dsh-ai-coding/deployment-contract
 */

import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'

/** `globalThis` key the Team Skill row publishes its slice under. */
export const PLATFORM_DEPLOYMENT_GLOBAL = '__DSH_AI_CODING_PLATFORM_DEPLOYMENT__'

/** `globalThis` key the cloud workspace row publishes its slice under. */
export const WORKSPACE_DEPLOYMENT_GLOBAL = '__DSH_AI_CODING_WORKSPACE_DEPLOYMENT__'

/** Workspace identity mode as the row expresses it. */
export type DeploymentAuthMode = 'account' | 'static-token'

/** The Team Skill row's slice of the declaration. */
export interface PlatformDeploymentDeclaration {
  /** AI Coding platform endpoint including `/v1`. */
  readonly apiBaseUrl: string
  /** Static platform token; present only when the row config sets one. */
  readonly accessToken?: string
}

/** The cloud workspace row's slice of the declaration. */
export interface WorkspaceDeploymentDeclaration {
  /** Workspace endpoint; omitted means "follow the platform endpoint". */
  readonly apiBaseUrl?: string
  /** Fixed workspace token; present only for `static-token` deployments. */
  readonly accessToken?: string
  /** Workspace identity mode. */
  readonly authMode?: DeploymentAuthMode
}

/** The two slices merged into the values the browser client layer resolves. */
export interface DeploymentDeclaration {
  /** Decided platform endpoint. */
  readonly apiBaseUrl: string
  /** Static platform token, when the deployment declared one. */
  readonly accessToken?: string
  /** Decided workspace endpoint, when the workspace row declared one. */
  readonly workspaceApiBaseUrl?: string
  /** Fixed workspace token, when the deployment declared one. */
  readonly workspaceAccessToken?: string
  /** Workspace identity mode, when the workspace row declared one. */
  readonly authMode?: DeploymentAuthMode
}

/**
 * Build the Team Skill row's injection row.
 *
 * Emitted as `{ kind: 'global' }` so it lands in the head, before every module
 * script: the browser fragment reads it synchronously during boot and never has
 * to gate the workbench on a round trip.
 * @param value - the row's declaration, or `undefined` when it has nothing to
 * declare (no endpoint configured), in which case no row is produced and the
 * browser stays unconfigured — the settings form is then the config channel.
 * @returns the injection row, or `undefined` when there is nothing to declare.
 */
export function platformDeploymentInjection(value: PlatformDeploymentDeclaration | undefined): IndexInjection | undefined {
  if (value === undefined || value.apiBaseUrl.length === 0) return undefined
  return { kind: 'global', name: PLATFORM_DEPLOYMENT_GLOBAL, value }
}

/**
 * Build the cloud workspace row's injection row.
 *
 * The fixed token is included only for `static-token` deployments, which is the
 * only mode its own config allows it in; an `account` deployment authenticates
 * each user instead, so the host's token never reaches a page there.
 * @param value - the row's declaration, or `undefined` when it has nothing to
 * declare.
 * @returns the injection row, or `undefined` when there is nothing to declare.
 */
export function workspaceDeploymentInjection(value: WorkspaceDeploymentDeclaration | undefined): IndexInjection | undefined {
  if (value === undefined) return undefined
  const staticToken = value.authMode === 'static-token' ? value.accessToken : undefined
  const declaration: WorkspaceDeploymentDeclaration = {
    ...(value.apiBaseUrl === undefined || value.apiBaseUrl.length === 0 ? {} : { apiBaseUrl: value.apiBaseUrl }),
    ...(staticToken === undefined || staticToken.length === 0 ? {} : { accessToken: staticToken }),
    ...(value.authMode === undefined ? {} : { authMode: value.authMode }),
  }
  if (declaration.apiBaseUrl === undefined && declaration.accessToken === undefined && declaration.authMode === undefined) return undefined
  return { kind: 'global', name: WORKSPACE_DEPLOYMENT_GLOBAL, value: declaration }
}

/** Read one injected slice, tolerating anything a page might have tampered with. */
function slice(scope: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
  const value = scope[name]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** Read one optional non-empty string field. */
function text(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Read the deployment declaration the host injected into this page.
 *
 * Values are re-validated rather than trusted: they are ours, but they arrive
 * through a page global, and an unconfigured or tampered page must degrade to
 * "unconfigured" (the settings form) instead of building a client against a
 * malformed endpoint.
 * @param scope - the page global scope; injectable for tests.
 * @returns the decided declaration, or `undefined` when the page carries none.
 */
export function readDeploymentDeclaration(scope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): DeploymentDeclaration | undefined {
  const platform = slice(scope, PLATFORM_DEPLOYMENT_GLOBAL)
  const workspace = slice(scope, WORKSPACE_DEPLOYMENT_GLOBAL)
  const apiBaseUrl = platform === undefined ? undefined : text(platform, 'apiBaseUrl')
  // A declaration without a platform endpoint is unusable: every browser read
  // goes through that client first.
  if (apiBaseUrl === undefined) return undefined
  const accessToken = platform === undefined ? undefined : text(platform, 'accessToken')
  const workspaceApiBaseUrl = workspace === undefined ? undefined : text(workspace, 'apiBaseUrl')
  const workspaceAccessToken = workspace === undefined ? undefined : text(workspace, 'accessToken')
  const rawMode = workspace === undefined ? undefined : workspace['authMode']
  const authMode: DeploymentAuthMode | undefined =
    rawMode === 'account' || rawMode === 'static-token' ? rawMode : undefined
  return {
    apiBaseUrl,
    ...(accessToken === undefined ? {} : { accessToken }),
    ...(workspaceApiBaseUrl === undefined ? {} : { workspaceApiBaseUrl }),
    ...(workspaceAccessToken === undefined ? {} : { workspaceAccessToken }),
    ...(authMode === undefined ? {} : { authMode }),
  }
}
