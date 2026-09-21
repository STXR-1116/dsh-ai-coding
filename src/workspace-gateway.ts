/** Cordis and Typert projection for Host-owned cloud workspace operations. */

import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { credentialKey, type CredentialProvider, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { ACCOUNT_CREDENTIAL_KEY } from './host.ts'
import { WorkspaceHttpError, normalizePreviewOrigin } from './workspace-http.ts'
import { DEFAULT_EVENT_BUFFER_LIMIT, DEFAULT_PAGE_WALK_LIMIT, WorkspaceHost } from './workspace-host.ts'
import type { WorkspaceSessionHandle, WorkspaceSessionProvider, WorkspaceStreamScope } from './workspace-host.ts'
import type {
  AgentProfileSummary,
  AgentTypeSchema,
  AgentRunSnapshot,
  AgentTypeSummary,
  CloudWorkspace,
  WorkspaceChanges,
  WorkspaceCodeSource,
  WorkspaceDirectory,
  WorkspaceFileContent,
  WorkspacePlan,
  RunCheckpointSnapshot,
  WorkspacePreview,
  WorkspacePreviewUrlGrant,
  WorkspaceQueryResult,
  WorkspaceStreamEvents,
  WorkspaceStreamState,
  WorkspaceStreamSubscription,
  RunApprovalSnapshot,
  RunPulse,
  AssetCandidate,
  ProfileDryRun,
  ProfileEditContext,
  ContextLensSnapshot,
  RunAssetSnapshot,
} from './workspace-types.ts'

/**
 * Deployment identity mode for the cloud workspace gateway.
 * - `account` (default): the shared account credential record is the only identity.
 *   A missing, revoked, or 401-cleared grant is `signed-out` — never a second identity.
 * - `static-token`: an explicit no-login deployment whose only identity is `accessToken`.
 */
export type WorkspaceAuthMode = 'account' | 'static-token'

/** Deployment-owned cloud workspace Host configuration. */
export interface WorkspaceGatewayConfig {
  /**
   * Cloud workspace service endpoint; `/v1` and a trailing slash are optional and
   * normalized to exactly one `/v1`. Absent/blank produces `not-ready`.
   */
  readonly apiBaseUrl?: string
  /** Static OIDC token; only honored when `authMode` is explicitly `static-token`. */
  readonly accessToken?: string
  /** Explicit deployment identity mode; defaults to `account`. */
  readonly authMode?: WorkspaceAuthMode
  /**
   * Origins a preview URL grant may point at, as bare `http(s)://host[:port]`
   * origins. Omitted means default-deny: every grant is refused rather than
   * opening an arbitrary origin.
   */
  readonly previewOrigins?: string[]
  /**
   * How many consumed events one subscription keeps replayable for its consumer.
   * Defaults to {@link DEFAULT_EVENT_BUFFER_LIMIT}.
   */
  readonly eventBufferLimit?: number
  /**
   * Loss-of-control guard for the Host's paged walks. Defaults to
   * {@link DEFAULT_PAGE_WALK_LIMIT}; a service returning many short pages needs
   * a larger guard, since reaching it fails the walk rather than truncating it.
   */
  readonly pageWalkLimit?: number
}

/**
 * Enforces the mutual exclusion between account credentials and a static deployment token.
 *
 * A static token is a whole-deployment identity substitute, not a credential fallback: it is
 * only usable when the deployment declares `authMode: 'static-token'`, and declaring that mode
 * requires the token. An account deployment that also carries a token is ambiguous and rejects.
 * @param config - Raw deployment configuration.
 * @returns the configuration with `authMode` resolved.
 */
export function validateWorkspaceGatewayConfig(config: WorkspaceGatewayConfig): ResolvedWorkspaceGatewayConfig {
  const authMode = config.authMode ?? 'account'
  const hasToken = config.accessToken !== undefined && config.accessToken.length > 0
  if (authMode === 'static-token' && !hasToken) {
    throw new Error('cloudWorkspaces authMode "static-token" requires a non-empty accessToken.')
  }
  if (authMode !== 'static-token' && config.accessToken !== undefined) {
    throw new Error('cloudWorkspaces accessToken is only allowed together with authMode "static-token".')
  }
  // An allowlist entry that is not a bare http(s) origin is a deployment
  // mistake, and the safe moment to say so is load time: accepting it here and
  // failing on the first grant would look like a service problem.
  const previewOrigins = config.previewOrigins?.map(normalizePreviewOrigin)
  return {
    ...config,
    authMode,
    ...(previewOrigins === undefined ? {} : { previewOrigins }),
  }
}

/**
 * A deployment configuration whose identity mode has been resolved.
 *
 * {@link validateWorkspaceGatewayConfig} always answers with a mode, so every
 * consumer downstream of it reads a decided value rather than re-defaulting a
 * field the deployment already had resolved.
 */
export interface ResolvedWorkspaceGatewayConfig extends WorkspaceGatewayConfig {
  /** Resolved identity mode: `account` unless the deployment declared `static-token`. */
  readonly authMode: WorkspaceAuthMode
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host-owned cloud workspace operations projected to browser clients through Typert. */
    cloudWorkspaces: WorkspaceGateway
  }
}

/**
 * Stable, non-reversible identity for one stored credential.
 *
 * Identity has to be comparable across two reads, and the raw grant cannot be
 * that value: it would put a secret into comparison state that can reach a
 * diagnostic. A fixed-length digest compares identically and is not replayable.
 * @param accessToken - The stored access token.
 * @returns the credential's identity digest.
 */
function credentialIdentity(accessToken: string): string {
  return createHash('sha256').update(accessToken).digest('hex').slice(0, 32)
}

/** The access token a stored credential record carries, if any. */
function recordAccessToken(record: CredentialRecord | undefined): string | undefined {
  if (record === undefined || record.kind !== 'grant') return undefined
  const payload = record.payload as { accessToken?: unknown }
  return typeof payload.accessToken === 'string' && payload.accessToken.length > 0 ? payload.accessToken : undefined
}

/** Session adapter sharing the platform account credential record with the Team Skill Host. */
function accountSessionProvider(
  credentials: CredentialProvider | undefined,
  authMode: WorkspaceAuthMode,
  staticToken: string | undefined,
): WorkspaceSessionProvider {
  const staticDeployment = authMode === 'static-token'
  const key = credentialKey('dsh-ai-coding-platform', 'account')
  return {
    read: async (): Promise<WorkspaceSessionHandle | undefined> => {
      if (staticDeployment) {
        const token = staticToken as string
        return { accessToken: token, identity: credentialIdentity(token) }
      }
      let record: CredentialRecord | undefined
      try {
        record = await credentials?.readRecord(ACCOUNT_CREDENTIAL_KEY)
      } catch {
        // An unreadable credential store is not an identity: the account is signed out.
        return undefined
      }
      const accessToken = recordAccessToken(record)
      if (accessToken === undefined) {
        // Account deployments never fall back to a second identity: a missing, revoked,
        // unreadable, or 401-cleared grant is signed-out.
        return undefined
      }
      return { accessToken, identity: credentialIdentity(accessToken) }
    },
    clear: async (identity: string): Promise<boolean> => {
      if (staticDeployment || credentials === undefined) return false
      // The comparison runs inside the provider's serialized read-modify-write
      // window, against the record the store actually holds — not against a
      // snapshot the caller captured before its request went out. The decision
      // is then read from the record the store returned, so a 401 that belongs
      // to a credential the user has since replaced declines and the account
      // that replaced it stays signed in.
      const current = await credentials.modifyRecord(key, record => Promise.resolve(record))
      const currentToken = recordAccessToken(current)
      if (currentToken === undefined || credentialIdentity(currentToken) !== identity) return false
      await credentials.deleteRecord(key)
      return true
    },
  }
}

/** Host service that exposes cloud workspace operations through the typed Remote gateway. */
export class WorkspaceGateway extends TypertRemoteService {
  /**
   * No required services: the credential store is genuinely optional here.
   *
   * This row supports a `static-token` deployment precisely for hosts with no
   * login, so it reads the store with `ctx.get('credentials')` and every path
   * below tolerates `undefined` (`accountSessionProvider` takes
   * `CredentialProvider | undefined` and answers "signed out" without one).
   * Declaring it in `inject` would contradict that: it would make a hard
   * dependency out of an optional one, keep the row PENDING on a credential-less
   * host, and turn the signed-out branch into dead code.
   */
  static inject: string[] = []

  static Config: Schema<WorkspaceGatewayConfig> = z.object({
    apiBaseUrl: z.string(),
    accessToken: z.string(),
    authMode: z.union(['account', 'static-token']),
    previewOrigins: z.array(z.string()).default([]),
    eventBufferLimit: z.number().default(DEFAULT_EVENT_BUFFER_LIMIT),
    pageWalkLimit: z.number().default(DEFAULT_PAGE_WALK_LIMIT),
  })

  private readonly host: WorkspaceHost

  constructor(ctx: Context, config: WorkspaceGatewayConfig) {
    super(ctx, 'cloudWorkspaces')
    const resolved = validateWorkspaceGatewayConfig(config)
    const credentials: CredentialProvider | undefined = ctx.get('credentials')
    this.host = new WorkspaceHost({
      ...(resolved.apiBaseUrl === undefined ? {} : { apiBaseUrl: resolved.apiBaseUrl }),
      ...(resolved.previewOrigins === undefined ? {} : { previewOrigins: resolved.previewOrigins }),
      eventBufferLimit: config.eventBufferLimit ?? DEFAULT_EVENT_BUFFER_LIMIT,
      pageWalkLimit: config.pageWalkLimit ?? DEFAULT_PAGE_WALK_LIMIT,
      session: accountSessionProvider(credentials, resolved.authMode, resolved.accessToken),
    })
    // Unloading this row must release every live SSE connection, backoff timer
    // and replay window the Host owns; without the effect a reload of the
    // bundle would leave sockets behind.
    ctx.effect(() => () => {
      this.host.dispose()
    }, 'cloudWorkspaces.host')
  }

  /**
   * Lists the agent executor types with their server-declared readiness.
   * @returns the query result wrapping the domain outcome.
   */
  @Remote
  async agentTypes(): Promise<WorkspaceQueryResult<readonly AgentTypeSummary[]>> {
    return this.host.agentTypes()
  }

  /**
   * Lists published agent profile versions usable for one project. @param projectId - Operation input.
   * @param projectId - Operation input.
   * @returns the query result wrapping the domain outcome.
   */
  @Remote
  async agentProfiles(projectId: string): Promise<WorkspaceQueryResult<readonly AgentProfileSummary[]>> {
    return this.host.agentProfiles(projectId)
  }

  /**
   * Reads one published agent profile version. @param versionId - Operation input.
   * @param versionId - Operation input.
   * @returns the query result wrapping the domain outcome.
   */
  @Remote
  async agentProfileVersion(versionId: string): Promise<WorkspaceQueryResult<AgentProfileSummary>> {
    return this.host.agentProfileVersion(versionId)
  }

  /**
   * Reads the user-side schema of one agent type. @param agentTypeId - Opaque agent type id.
   * @param agentTypeId - Operation input.
   * @returns the query result wrapping the domain outcome.
   */
  @Remote
  async agentTypeSchema(agentTypeId: string): Promise<WorkspaceQueryResult<AgentTypeSchema>> {
    return this.host.agentTypeSchema(agentTypeId)
  }

  /**
   * Lists the project repositories the account may start a workspace from.
   * @param projectId - Operation input.
   * @returns the query result wrapping the domain outcome.
   */
  @Remote
  async codeSources(projectId: string): Promise<WorkspaceQueryResult<readonly WorkspaceCodeSource[]>> {
    return this.host.codeSources(projectId)
  }

  /**
   * Lists the project workspaces the account may use. @param projectId - Operation input.
   * @param projectId - Operation input.
   * @returns the query result wrapping the domain outcome.
   */
  @Remote
  async workspaces(projectId: string): Promise<WorkspaceQueryResult<readonly CloudWorkspace[]>> {
    return this.host.workspaces(projectId)
  }

  /**
   * Reads one workspace snapshot. @param workspaceId - Operation input.
   * @param workspaceId - Operation input.
   * @returns the query result wrapping the domain outcome.
   */
  @Remote
  async workspace(workspaceId: string): Promise<WorkspaceQueryResult<CloudWorkspace>> {
    return this.host.workspace(workspaceId)
  }

  /**
   * Lists one directory of the workspace tree. @param workspaceId - Operation input. @param path - Operation input.
   * @param workspaceId - Operation input.
   * @param path - Operation input.
   * @returns the query result wrapping the domain outcome.
   */
  @Remote
  async workspaceFiles(workspaceId: string, path: string): Promise<WorkspaceQueryResult<WorkspaceDirectory>> {
    return this.host.workspaceFiles(workspaceId, path)
  }

  /**
   * Reads one workspace-relative file's restricted content. @param workspaceId - Operation input. @param path - Operation input.
   * @param workspaceId - Operation input.
   * @param path - Operation input.
   * @returns the query result wrapping the domain outcome.
   */
  @Remote
  async workspaceFileContent(workspaceId: string, path: string): Promise<WorkspaceQueryResult<WorkspaceFileContent>> {
    return this.host.workspaceFileContent(workspaceId, path)
  }

  /**
   * Reads the workspace change set against its baseline. @param workspaceId - Operation input.
   * @param workspaceId - Operation input.
   * @returns the query result wrapping the domain outcome.
   */
  @Remote
  async workspaceChanges(workspaceId: string): Promise<WorkspaceQueryResult<WorkspaceChanges>> {
    return this.host.workspaceChanges(workspaceId)
  }

  /**
   * Reads one server-authorized preview. @param workspaceId - Operation input. @param path - Operation input.
   * @param workspaceId - Operation input.
   * @param path - Operation input.
   * @returns the query result wrapping the domain outcome.
   */
  @Remote
  async workspacePreview(workspaceId: string, path: string): Promise<WorkspaceQueryResult<WorkspacePreview>> {
    return this.host.workspacePreview(workspaceId, path)
  }

  /**
   * Issues a short-lived workspace web app URL. @param workspaceId - Operation input. @param appPort - Operation input.
   * @param workspaceId - Operation input.
   * @param appPort - Operation input.
   * @returns the query result wrapping the domain outcome.
   */
  @Remote
  async workspacePreviewUrl(workspaceId: string, appPort: number): Promise<WorkspaceQueryResult<WorkspacePreviewUrlGrant>> {
    return this.host.issuePreviewUrl(workspaceId, appPort)
  }

  /**
   * Creates a workspace and returns its asynchronous provisioning state.
   * @param input - Project, repository, branch, and published profile version.
   * @returns the query result wrapping the domain outcome.
   */
  @Remote
  async createWorkspace(input: {
    readonly projectId: string
    readonly repositoryId: string
    readonly branch: string
    readonly agentProfileVersionId: string
    readonly displayName?: string
  }): Promise<WorkspaceQueryResult<CloudWorkspace>> {
    return this.host.createWorkspace(input)
  }

  /**
   * Runs one lifecycle operation on a workspace.
   * @param workspaceId - Opaque workspace id.
   * @param action - Start, stop, retry, or archive.
   * @param expectedRevision - Optimistic revision guard.
   * @param workspaceId - Operation input.
   * @param action - Operation input.
   * @param expectedRevision - Operation input.
   * @returns the query result wrapping the domain outcome.
   */
  @Remote
  async workspaceAction(
    workspaceId: string,
    action: 'start' | 'stop' | 'retry' | 'archive',
    expectedRevision?: number,
  ): Promise<WorkspaceQueryResult<CloudWorkspace>> {
    return this.host.workspaceAction(workspaceId, action, expectedRevision)
  }

  /**
   * Deletes a stopped or archived workspace under its deletion policy.
   * @param workspaceId - Opaque workspace id.
   * @param expectedRevision - Optimistic revision guard.
   * @returns the query result wrapping the domain outcome.
   */
  @Remote
  async deleteWorkspace(workspaceId: string, expectedRevision: number): Promise<WorkspaceQueryResult<CloudWorkspace>> {
    return this.host.deleteWorkspace(workspaceId, expectedRevision)
  }

  /**
   * Requests a pull request for the workspace changes.
   * @param workspaceId - Opaque workspace id.
   * @param title - User-supplied PR title.
   * @param expectedRevision - Revision the caller observed.
   * @returns the query result wrapping the domain outcome.
   */
  @Remote
  async createPullRequest(
    workspaceId: string,
    title: string,
    expectedRevision: number,
  ): Promise<WorkspaceQueryResult<{ readonly pullRequestId: string }>> {
    return this.host.createPullRequest(workspaceId, title, expectedRevision)
  }

  /**
   * Discards the workspace change set at a revision. @param workspaceId - Operation input. @param expectedRevision - Operation input.
   * @param workspaceId - Operation input.
   * @param expectedRevision - Operation input.
   * @returns the query result wrapping the domain outcome.
   */
  @Remote
  async discardChanges(workspaceId: string, expectedRevision: number): Promise<WorkspaceQueryResult<{ readonly revision: number }>> {
    return this.host.discardChanges(workspaceId, expectedRevision)
  }

  /** Commits the workspace change set at a revision.
   * @param workspaceId - Opaque workspace id.
   * @param message - User-supplied commit message.
   * @param expectedRevision - Revision the caller observed.
   * @returns the query result with the new revision.
   */
  @Remote
  gitCommit(
    workspaceId: string,
    message: string,
    expectedRevision: number,
  ): Promise<WorkspaceQueryResult<{ readonly revision: number }>> {
    return this.host.gitCommit(workspaceId, message, expectedRevision)
  }

  /**
   * Creates a run that snapshots the profile version and workspace revision.
   * @param input - Workspace, Session binding, write mode, and revision guard.
   * @returns the query result wrapping the domain outcome.
   */
  @Remote
  async createRun(input: {
    readonly workspaceId: string
    readonly sessionId: string
    readonly writeMode: 'read_only' | 'write'
    readonly expectedWorkspaceRevision: number
    readonly agentProfileVersionId?: string
    readonly planId?: string
  }): Promise<WorkspaceQueryResult<AgentRunSnapshot>> {
    return this.host.createRun(input)
  }

  /**
   * Lists the workspace's editable plans.
   * @param workspaceId - Opaque workspace id.
   * @returns the query result wrapping the domain outcome.
   */
  @Remote
  async workspacePlans(workspaceId: string): Promise<WorkspaceQueryResult<readonly WorkspacePlan[]>> {
    return this.host.workspacePlans(workspaceId)
  }


  /**
   * Reads one plan snapshot.
   * @param workspaceId - Opaque workspace id.
   * @param planId - Opaque plan id.
   * @returns the query result wrapping the domain outcome.
   */
  @Remote
  async plan(workspaceId: string, planId: string): Promise<WorkspaceQueryResult<WorkspacePlan>> {
    return this.host.plan(workspaceId, planId)
  }

  /**
   * Creates a draft plan.
   * @param input - Goal, steps, agent profile version, and optional asset subset.
   * @returns the query result wrapping the domain outcome.
   */
  @Remote
  async createPlan(input: {
    readonly workspaceId: string
    readonly goal: string
    readonly steps: readonly { readonly title: string; readonly dependsOn?: readonly number[] }[]
    readonly agentProfileVersionId: string
    readonly assetVersionIds?: readonly string[]
  }): Promise<WorkspaceQueryResult<WorkspacePlan>> {
    return this.host.createPlan(input)
  }

  /**
   * Edits a draft plan; the server appends an edit record and keeps history.
   * @param input - Operation input.
   * @returns the query result wrapping the domain outcome.
   */
  @Remote
  async updatePlan(input: {
    readonly workspaceId: string
    readonly planId: string
    readonly goal?: string
    readonly steps?: readonly { readonly title: string; readonly dependsOn?: readonly number[] }[]
    readonly agentProfileVersionId?: string
    readonly assetVersionIds?: readonly string[]
    readonly expectedRevision: number
    readonly changeSummary: string
  }): Promise<WorkspaceQueryResult<WorkspacePlan>> {
    return this.host.updatePlan(input)
  }

  /**
   * Confirms a draft plan; a confirmed plan is frozen and runnable.
   * @param input - Operation input.
   * @returns the query result wrapping the domain outcome.
   */
  @Remote
  async confirmPlan(input: { readonly workspaceId: string; readonly planId: string }): Promise<WorkspaceQueryResult<WorkspacePlan>> {
    return this.host.confirmPlan(input)
  }

  /**
   * Pauses a run and saves the server-side checkpoint.
   * @param input - Run id, session sequence, preserved tool results, and completed plan steps.
   * @returns the query result wrapping the domain outcome.
   */
  @Remote
  async pauseRun(input: {
    readonly runId: string
    readonly sessionSeq: number
    readonly toolResults?: readonly { readonly callId: string; readonly tool: string; readonly result: string }[]
    readonly pendingApproval?: { readonly action: string; readonly summary: string }
    readonly completedSteps?: readonly number[]
  }): Promise<WorkspaceQueryResult<AgentRunSnapshot>> {
    return this.host.pauseRun(input)
  }

  /**
   * Resumes a paused run with an explicit continue-or-replay choice.
   * @param input - Run id and the resume mode.
   * @returns the query result wrapping the domain outcome.
   */
  @Remote
  async resumeRun(input: { readonly runId: string; readonly mode: 'continue' | 'replay' }): Promise<WorkspaceQueryResult<AgentRunSnapshot>> {
    return this.host.resumeRun(input)
  }

  /**
   * Reads the run checkpoint with its resume preview; a checkpoint id selects
   * a specific history entry (§11.11), defaulting to latest.
   * @param runId - Opaque run id.
   * @param checkpointId - Optional checkpoint id within the run's checkpoint history.
   * @returns the query result wrapping the domain outcome.
   */
  @Remote
  async runCheckpoint(runId: string, checkpointId?: string): Promise<WorkspaceQueryResult<RunCheckpointSnapshot>> {
    return this.host.runCheckpoint(runId, checkpointId)
  }

  /**
   * Reads the run pulse timeline (§11.11).
   * @param runId - Opaque run id.
   * @returns the query result wrapping the pulse snapshot.
   */
  @Remote
  async runPulse(runId: string): Promise<WorkspaceQueryResult<RunPulse>> {
    return this.host.runPulse(runId)
  }

  /**
   * Lists the project's asset candidates with selector fields (SS11.12).
   * @param projectId - Opaque project id.
   * @returns the query result wrapping the candidate list.
   */
  /**
   * Reads the profile edit context (SS11.12).
   * @param profileId - Opaque profile id.
   * @returns the query result wrapping the edit context.
   */
  /**
   * Reads the context lens snapshot for one workspace (SS11.13), optionally scoped
   * to one run (SS11.17).
   * @param workspaceId - Opaque workspace id.
   * @param runId - Run whose suppression record applies; omitted means the baseline snapshot.
   * @returns the query result wrapping the lens snapshot.
   */
  @Remote
  async contextLens(workspaceId: string, runId?: string): Promise<WorkspaceQueryResult<ContextLensSnapshot>> {
    return this.host.contextLens(workspaceId, runId)
  }

  /**
   * Suppresses or restores one memory for exactly one run (SS11.17).
   * @param workspaceId - Opaque workspace id.
   * @param runId - Run the decision belongs to.
   * @param memoryId - Memory identity the lens named.
   * @param suppressed - True switches the memory off for this run only.
   * @returns the query result wrapping the updated lens snapshot.
   */
  @Remote
  async suppressContextLensMemory(
    workspaceId: string,
    runId: string,
    memoryId: string,
    suppressed: boolean,
  ): Promise<WorkspaceQueryResult<ContextLensSnapshot>> {
    return this.host.suppressContextLensMemory(workspaceId, runId, memoryId, suppressed)
  }

  /**
   * Reads the run's frozen asset binding snapshot (SS11.18 A).
   * @param runId - Opaque run id.
   * @returns the query result wrapping the snapshot.
   */
  @Remote
  async runAssetSnapshot(runId: string): Promise<WorkspaceQueryResult<RunAssetSnapshot>> {
    return this.host.runAssetSnapshot(runId)
  }

  /**
   * Reads the profile edit context (SS11.12).
   * @param profileId - Opaque profile id.
   * @returns the query result wrapping the edit context.
   */
  @Remote
  async profileEditContext(profileId: string): Promise<WorkspaceQueryResult<ProfileEditContext>> {
    return this.host.profileEditContext(profileId)
  }

  /**
   * Lists the project's asset candidates with selector fields (SS11.12).
   * @param projectId - Opaque project id.
   * @returns the query result wrapping the candidate list.
   */
  @Remote
  async assetCandidates(projectId: string): Promise<WorkspaceQueryResult<readonly AssetCandidate[]>> {
    return this.host.assetCandidates(projectId)
  }

  /**
   * Runs the assembly-only dry run for one profile version (SS11.12).
   * @param input - The profile id and version id.
   * @returns the query result wrapping the dry-run snapshot.
   */
  @Remote
  async dryRunProfile(input: { readonly profileId: string; readonly versionId: string }): Promise<WorkspaceQueryResult<ProfileDryRun>> {
    return this.host.dryRunProfile(input)
  }

  /**
   * Creates a new draft version inheriting the latest (SS11.12 edit flow).
   * @param input - The profile id and the expected profile revision.
   * @returns the query result wrapping the updated edit context.
   */
  @Remote
  async createProfileVersion(input: {
    readonly profileId: string
    readonly expectedRevision: number
  }): Promise<WorkspaceQueryResult<ProfileEditContext>> {
    return this.host.createProfileVersion(input)
  }

  /**
   * Updates a draft profile version's mutable fields (SS11.4).
   * @param input - Profile id, revision guard and the mutable patch.
   * @returns the query result wrapping the updated edit context.
   */
  @Remote
  async updateProfileDraft(input: {
    readonly profileId: string
    readonly expectedRevision: number
    readonly patch: { readonly name?: string; readonly description?: string; readonly model?: string; readonly reasoning?: string }
  }): Promise<WorkspaceQueryResult<ProfileEditContext>> {
    return this.host.updateProfileDraft(input)
  }

  /**
   * Publishes a draft profile version (SS11.4).
   * @param input - Profile id, version id and the profile revision guard.
   * @returns the query result wrapping the updated edit context.
   */
  @Remote
  async publishProfileVersion(input: {
    readonly profileId: string
    readonly versionId: string
    readonly expectedRevision: number
  }): Promise<WorkspaceQueryResult<ProfileEditContext>> {
    return this.host.publishProfileVersion(input)
  }

  /**
   * Lists the workspace runs. @param workspaceId - Operation input.
   * @param workspaceId - Operation input.
   * @returns the query result wrapping the domain outcome.
   */
  @Remote
  async workspaceRuns(workspaceId: string): Promise<WorkspaceQueryResult<readonly AgentRunSnapshot[]>> {
    return this.host.workspaceRuns(workspaceId)
  }

  /**
   * Reads one run snapshot. @param runId - Operation input.
   * @param runId - Operation input.
   * @returns the query result wrapping the domain outcome.
   */
  @Remote
  async run(runId: string): Promise<WorkspaceQueryResult<AgentRunSnapshot>> {
    return this.host.run(runId)
  }

  /**
   * Reads the approval entity bound to an awaiting_approval run (§11.10).
   * @param runId - Opaque run id.
   * @returns the query result wrapping the approval snapshot.
   */
  @Remote
  async runApproval(runId: string): Promise<WorkspaceQueryResult<RunApprovalSnapshot>> {
    return this.host.runApproval(runId)
  }

  /**
   * Decides an approval; the server re-verifies assets and returns evidence (§11.10).
   * @param input - Run id, decision and expected run revision.
   * @returns the query result wrapping the updated run snapshot.
   */
  @Remote
  async decideApproval(input: {
    readonly runId: string
    readonly decision: 'approve' | 'reject'
    readonly expectedRunRevision: number
  }): Promise<WorkspaceQueryResult<AgentRunSnapshot>> {
    return this.host.decideApproval(input)
  }

  /**
   * Takes over a run without changing its status (§11.10).
   * @param input - Run id and expected run revision.
   * @returns the query result wrapping the updated run snapshot.
   */
  @Remote
  async takeoverRun(input: {
    readonly runId: string
    readonly expectedRunRevision: number
  }): Promise<WorkspaceQueryResult<AgentRunSnapshot>> {
    return this.host.takeoverRun(input)
  }

  /**
   * Cancels one active run; the record stays. @param runId - Operation input.
   * @param runId - Operation input.
   * @returns the query result wrapping the domain outcome.
   */
  @Remote
  async cancelRun(runId: string): Promise<WorkspaceQueryResult<AgentRunSnapshot>> {
    return this.host.cancelRun(runId)
  }

  /**
   * Creates a new run linked to the original. @param runId - Operation input. @param expectedWorkspaceRevision - Operation input.
   * @param runId - Operation input.
   * @param expectedWorkspaceRevision - Operation input.
   * @returns the query result wrapping the domain outcome.
   */
  @Remote
  async retryRun(runId: string, expectedWorkspaceRevision: number): Promise<WorkspaceQueryResult<AgentRunSnapshot>> {
    return this.host.retryRun(runId, expectedWorkspaceRevision)
  }

  /** Reports the live SSE connection state of one owned subscription.
   * @param subscriptionId - The handle returned by `startStream`.
   * @returns the current stream state for that subscription.
   */
  @Remote
  streamState(subscriptionId: string): Promise<WorkspaceStreamState> {
    return Promise.resolve(this.host.streamState(subscriptionId))
  }

  /**
   * Starts one owned SSE subscription and returns its opaque handle.
   *
   * The handle is the only way to read or release this subscription afterwards,
   * which is what keeps two workbenches from tearing down each other's stream.
   * @param scope - Project scope plus the snapshot watermark.
   * @returns the owned subscription handle and the state observed at start.
   */
  @Remote
  startStream(scope: {
    readonly projectId: string
    readonly workspaceId?: string
    readonly lastEventId?: string
  }): Promise<WorkspaceStreamSubscription> {
    const streamScope: WorkspaceStreamScope = {
      ...scope,
      // A resync is only complete once the authoritative snapshot has actually
      // been read; a failed read rejects so the Host keeps the stream `stale`
      // instead of resuming as if the replay window had no holes.
      resync: async () => {
        const results = await Promise.all([
          this.host.workspaces(scope.projectId),
          scope.workspaceId === undefined ? Promise.resolve(undefined) : this.host.workspace(scope.workspaceId),
        ])
        for (const result of results) {
          if (result === undefined || result.status === 'ready') continue
          throw new WorkspaceHttpError(
            result.status === 'failed' ? result.code : result.status.toUpperCase(),
            result.status === 'failed' ? result.message : `Cloud workspace resync could not read the snapshot (${result.status}).`,
          )
        }
      },
    }
    return Promise.resolve(this.host.startStream(streamScope))
  }

  /**
   * Releases one owned SSE subscription.
   * @param subscriptionId - The handle returned by `startStream`.
   * @returns the state after release.
   */
  @Remote
  stopStream(subscriptionId: string): Promise<WorkspaceStreamState> {
    this.host.stopStream(subscriptionId)
    return Promise.resolve(this.host.streamState(subscriptionId))
  }

  /**
   * Observes the SSE events one owned subscription consumed after a watermark.
   *
   * This is the event channel the workbench consumes: on a `workspace`, `run`,
   * `changes` or `file` event it refreshes the matching resource, rather than
   * inferring progress from the stream state alone.
   * @param subscriptionId - The handle returned by `startStream`; events from any other subscription are invisible.
   * @param afterEventId - Watermark the caller has already applied; `''` means none.
   * @returns the events after the watermark plus the out-of-window truncation flag.
   */
  @Remote
  streamEventsAfter(subscriptionId: string, afterEventId: string): Promise<WorkspaceStreamEvents> {
    return Promise.resolve(this.host.streamEventsAfter(afterEventId, subscriptionId))
  }
}

export default WorkspaceGateway
