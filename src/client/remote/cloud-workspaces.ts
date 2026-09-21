/** Browser-provided `remote.cloudWorkspaces` service: the workspace backend called directly. */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import { WorkspaceHost } from '../../workspace-host.ts'
import type { WorkspaceSessionProvider } from '../../workspace-host.ts'
import { WorkspaceHttpError } from '../../workspace-http.ts'
import { failResult, failureOf, okResult } from './errors.ts'
import type { ResolvedPlatformClientConfig } from './config.ts'
import type { AccountGrant } from './team-skills.ts'
import { subscribeBrowserSettings } from './settings.ts'

/** The generated wire face this service satisfies; drift fails the build here. */
type CloudWorkspacesFace = ClientRemote['cloudWorkspaces']

/** The awaited face member type an async implementation returns. */
type FaceReturn<Face, M extends keyof Face> = Face[M] extends (...args: never[]) => Promise<infer R> ? Promise<R> : never

/** Reads the platform session grant the workspace face shares its account identity with. */
export type PlatformSessionReader = () => AccountGrant | undefined

/** Drops the platform session when it is still the one the caller observed. */
export type PlatformSessionClearer = (expected: AccountGrant) => void

/**
 * The full `remote.cloudWorkspaces` method face, answered by the browser from
 * the workspace backend through the same `WorkspaceHost` orchestrator the
 * host gateway delegates to — snapshots before streams, SSE watermark
 * resync, `if-match` revision guards, and per-write `idempotency-key`
 * generation all ride on it unchanged.
 *
 * The session is the deployment's: `static-token` uses the configured token
 * as the only identity; `account` shares the platform session the teamSkills
 * face signed in (the browser has no credential store), and a 401 clears
 * exactly that session. While the settings face carries no usable
 * configuration, the orchestrator is built unconfigured and every query
 * answers the host's own `not-ready` union.
 */
export class CloudWorkspacesRemoteService extends Service implements CloudWorkspacesFace {
  private hostCache: { readonly identity: string; readonly host: WorkspaceHost } | undefined

  constructor(
    ctx: Context,
    private readonly readConfig: () => ResolvedPlatformClientConfig | undefined,
    private readonly readPlatformSession: PlatformSessionReader,
    private readonly clearPlatformSession: PlatformSessionClearer,
  ) {
    super(ctx, 'remote.cloudWorkspaces')
    // A settings change switches the backend: streams and clients belong to
    // the previous deployment, so the cached orchestrator is dropped.
    ctx.effect(() => subscribeBrowserSettings(() => {
      const cached = this.hostCache
      this.hostCache = undefined
      if (cached !== undefined) void cached.host.dispose()
    }), 'dsh-ai-coding: browser cloudWorkspaces settings reset')
    // Unloading the plugin must release every live SSE connection, backoff
    // timer and replay window the host owns.
    ctx.effect(() => () => {
      void this.host().dispose()
    }, 'dsh-ai-coding: browser cloudWorkspaces stream release')
  }

  /**
   * The orchestrator for the current deployment, rebuilt when the resolved
   * settings change. Unconfigured deployments still get one: `WorkspaceHost`
   * answers its own explicit `not-ready` for every read without an endpoint.
   */
  private host(): WorkspaceHost {
    const config = this.readConfig()
    const identity = config === undefined ? '' : JSON.stringify(config)
    const cached = this.hostCache
    if (cached !== undefined && cached.identity === identity) return cached.host
    const host = new WorkspaceHost({
      ...(config === undefined ? {} : { apiBaseUrl: config.workspaceApiBaseUrl }),
      session: browserWorkspaceSession(config, this.readPlatformSession, this.clearPlatformSession),
    })
    this.hostCache = { identity, host }
    return host
  }

  async agentTypes(): FaceReturn<CloudWorkspacesFace, 'agentTypes'> {
    return this.call(() => this.host().agentTypes())
  }

  async agentProfiles(projectId: string): FaceReturn<CloudWorkspacesFace, 'agentProfiles'> {
    return this.call(() => this.host().agentProfiles(projectId))
  }

  async agentProfileVersion(versionId: string): FaceReturn<CloudWorkspacesFace, 'agentProfileVersion'> {
    return this.call(() => this.host().agentProfileVersion(versionId))
  }

  async agentTypeSchema(agentTypeId: string): FaceReturn<CloudWorkspacesFace, 'agentTypeSchema'> {
    return this.call(() => this.host().agentTypeSchema(agentTypeId))
  }

  async codeSources(projectId: string): FaceReturn<CloudWorkspacesFace, 'codeSources'> {
    return this.call(() => this.host().codeSources(projectId))
  }

  async workspaces(projectId: string): FaceReturn<CloudWorkspacesFace, 'workspaces'> {
    return this.call(() => this.host().workspaces(projectId))
  }

  async workspace(workspaceId: string): FaceReturn<CloudWorkspacesFace, 'workspace'> {
    return this.call(() => this.host().workspace(workspaceId))
  }

  async workspaceFiles(workspaceId: string, path: string): FaceReturn<CloudWorkspacesFace, 'workspaceFiles'> {
    return this.call(() => this.host().workspaceFiles(workspaceId, path))
  }

  async workspaceFileContent(workspaceId: string, path: string): FaceReturn<CloudWorkspacesFace, 'workspaceFileContent'> {
    return this.call(() => this.host().workspaceFileContent(workspaceId, path))
  }

  async workspaceChanges(workspaceId: string): FaceReturn<CloudWorkspacesFace, 'workspaceChanges'> {
    return this.call(() => this.host().workspaceChanges(workspaceId))
  }

  async workspacePreview(workspaceId: string, path: string): FaceReturn<CloudWorkspacesFace, 'workspacePreview'> {
    return this.call(() => this.host().workspacePreview(workspaceId, path))
  }

  async workspacePreviewUrl(workspaceId: string, appPort: number): FaceReturn<CloudWorkspacesFace, 'workspacePreviewUrl'> {
    return this.call(() => this.host().issuePreviewUrl(workspaceId, appPort))
  }

  async createWorkspace(input: {
    readonly projectId: string
    readonly repositoryId: string
    readonly branch: string
    readonly agentProfileVersionId: string
    readonly displayName?: string
  }): FaceReturn<CloudWorkspacesFace, 'createWorkspace'> {
    return this.call(() => this.host().createWorkspace(input))
  }

  async workspaceAction(
    workspaceId: string,
    action: 'start' | 'stop' | 'retry' | 'archive',
    expectedRevision?: number,
  ): FaceReturn<CloudWorkspacesFace, 'workspaceAction'> {
    return this.call(() => this.host().workspaceAction(workspaceId, action, expectedRevision))
  }

  async deleteWorkspace(workspaceId: string, expectedRevision: number): FaceReturn<CloudWorkspacesFace, 'deleteWorkspace'> {
    return this.call(() => this.host().deleteWorkspace(workspaceId, expectedRevision))
  }

  async createPullRequest(workspaceId: string, title: string, expectedRevision: number): FaceReturn<CloudWorkspacesFace, 'createPullRequest'> {
    return this.call(() => this.host().createPullRequest(workspaceId, title, expectedRevision))
  }

  async discardChanges(workspaceId: string, expectedRevision: number): FaceReturn<CloudWorkspacesFace, 'discardChanges'> {
    return this.call(() => this.host().discardChanges(workspaceId, expectedRevision))
  }

  async gitCommit(workspaceId: string, message: string, expectedRevision: number): FaceReturn<CloudWorkspacesFace, 'gitCommit'> {
    return this.call(() => this.host().gitCommit(workspaceId, message, expectedRevision))
  }

  async createRun(input: {
    readonly workspaceId: string
    readonly sessionId: string
    readonly writeMode: 'read_only' | 'write'
    readonly expectedWorkspaceRevision: number
    readonly agentProfileVersionId?: string
    readonly planId?: string
  }): FaceReturn<CloudWorkspacesFace, 'createRun'> {
    return this.call(() => this.host().createRun(input))
  }

  async workspacePlans(workspaceId: string): FaceReturn<CloudWorkspacesFace, 'workspacePlans'> {
    return this.call(() => this.host().workspacePlans(workspaceId))
  }

  async plan(workspaceId: string, planId: string): FaceReturn<CloudWorkspacesFace, 'plan'> {
    return this.call(() => this.host().plan(workspaceId, planId))
  }

  async createPlan(input: {
    readonly workspaceId: string
    readonly goal: string
    readonly steps: readonly { readonly title: string; readonly dependsOn?: readonly number[] }[]
    readonly agentProfileVersionId: string
    readonly assetVersionIds?: readonly string[]
  }): FaceReturn<CloudWorkspacesFace, 'createPlan'> {
    return this.call(() => this.host().createPlan(input))
  }

  async updatePlan(input: {
    readonly workspaceId: string
    readonly planId: string
    readonly goal?: string
    readonly steps?: readonly { readonly title: string; readonly dependsOn?: readonly number[] }[]
    readonly agentProfileVersionId?: string
    readonly assetVersionIds?: readonly string[]
    readonly expectedRevision: number
    readonly changeSummary: string
  }): FaceReturn<CloudWorkspacesFace, 'updatePlan'> {
    return this.call(() => this.host().updatePlan(input))
  }

  async confirmPlan(input: { readonly workspaceId: string; readonly planId: string }): FaceReturn<CloudWorkspacesFace, 'confirmPlan'> {
    return this.call(() => this.host().confirmPlan(input))
  }

  async pauseRun(input: {
    readonly runId: string
    readonly sessionSeq: number
    readonly toolResults?: readonly { readonly callId: string; readonly tool: string; readonly result: string }[]
    readonly pendingApproval?: { readonly action: string; readonly summary: string }
    readonly completedSteps?: readonly number[]
  }): FaceReturn<CloudWorkspacesFace, 'pauseRun'> {
    return this.call(() => this.host().pauseRun(input))
  }

  async resumeRun(input: { readonly runId: string; readonly mode: 'continue' | 'replay' }): FaceReturn<CloudWorkspacesFace, 'resumeRun'> {
    return this.call(() => this.host().resumeRun(input))
  }

  async runCheckpoint(runId: string, checkpointId?: string): FaceReturn<CloudWorkspacesFace, 'runCheckpoint'> {
    return this.call(() => this.host().runCheckpoint(runId, checkpointId))
  }

  async runPulse(runId: string): FaceReturn<CloudWorkspacesFace, 'runPulse'> {
    return this.call(() => this.host().runPulse(runId))
  }

  async contextLens(workspaceId: string, runId?: string): FaceReturn<CloudWorkspacesFace, 'contextLens'> {
    return this.call(() => this.host().contextLens(workspaceId, runId))
  }

  async suppressContextLensMemory(
    workspaceId: string,
    runId: string,
    memoryId: string,
    suppressed: boolean,
  ): FaceReturn<CloudWorkspacesFace, 'suppressContextLensMemory'> {
    return this.call(() => this.host().suppressContextLensMemory(workspaceId, runId, memoryId, suppressed))
  }

  async runAssetSnapshot(runId: string): FaceReturn<CloudWorkspacesFace, 'runAssetSnapshot'> {
    return this.call(() => this.host().runAssetSnapshot(runId))
  }

  async profileEditContext(profileId: string): FaceReturn<CloudWorkspacesFace, 'profileEditContext'> {
    return this.call(() => this.host().profileEditContext(profileId))
  }

  async assetCandidates(projectId: string): FaceReturn<CloudWorkspacesFace, 'assetCandidates'> {
    return this.call(() => this.host().assetCandidates(projectId))
  }

  async dryRunProfile(input: { readonly profileId: string; readonly versionId: string }): FaceReturn<CloudWorkspacesFace, 'dryRunProfile'> {
    return this.call(() => this.host().dryRunProfile(input))
  }

  async createProfileVersion(input: { readonly profileId: string; readonly expectedRevision: number }): FaceReturn<CloudWorkspacesFace, 'createProfileVersion'> {
    return this.call(() => this.host().createProfileVersion(input))
  }

  async updateProfileDraft(input: {
    readonly profileId: string
    readonly expectedRevision: number
    readonly patch: { readonly name?: string; readonly description?: string; readonly model?: string; readonly reasoning?: string }
  }): FaceReturn<CloudWorkspacesFace, 'updateProfileDraft'> {
    return this.call(() => this.host().updateProfileDraft(input))
  }

  async publishProfileVersion(input: {
    readonly profileId: string
    readonly versionId: string
    readonly expectedRevision: number
  }): FaceReturn<CloudWorkspacesFace, 'publishProfileVersion'> {
    return this.call(() => this.host().publishProfileVersion(input))
  }

  async workspaceRuns(workspaceId: string): FaceReturn<CloudWorkspacesFace, 'workspaceRuns'> {
    return this.call(() => this.host().workspaceRuns(workspaceId))
  }

  async run(runId: string): FaceReturn<CloudWorkspacesFace, 'run'> {
    return this.call(() => this.host().run(runId))
  }

  async runApproval(runId: string): FaceReturn<CloudWorkspacesFace, 'runApproval'> {
    return this.call(() => this.host().runApproval(runId))
  }

  async decideApproval(input: {
    readonly runId: string
    readonly decision: 'approve' | 'reject'
    readonly expectedRunRevision: number
  }): FaceReturn<CloudWorkspacesFace, 'decideApproval'> {
    return this.call(() => this.host().decideApproval(input))
  }

  async takeoverRun(input: { readonly runId: string; readonly expectedRunRevision: number }): FaceReturn<CloudWorkspacesFace, 'takeoverRun'> {
    return this.call(() => this.host().takeoverRun(input))
  }

  async cancelRun(runId: string): FaceReturn<CloudWorkspacesFace, 'cancelRun'> {
    return this.call(() => this.host().cancelRun(runId))
  }

  async retryRun(runId: string, expectedWorkspaceRevision: number): FaceReturn<CloudWorkspacesFace, 'retryRun'> {
    return this.call(() => this.host().retryRun(runId, expectedWorkspaceRevision))
  }

  async streamState(subscriptionId: string): FaceReturn<CloudWorkspacesFace, 'streamState'> {
    return this.call(() => this.host().streamState(subscriptionId))
  }

  async startStream(scope: {
    readonly projectId: string
    readonly workspaceId?: string
    readonly lastEventId?: string
  }): FaceReturn<CloudWorkspacesFace, 'startStream'> {
    return this.call(() => this.host().startStream({
      ...scope,
      // A resync is only complete once the authoritative snapshot has actually
      // been read; a failed read rejects so the stream stays `stale` instead of
      // resuming as if the replay window had no holes.
      resync: async () => {
        const results = await Promise.all([
          this.host().workspaces(scope.projectId),
          scope.workspaceId === undefined ? Promise.resolve(undefined) : this.host().workspace(scope.workspaceId),
        ])
        for (const result of results) {
          if (result === undefined || result.status === 'ready') continue
          throw new WorkspaceHttpError(
            result.status === 'failed' ? result.code : result.status.toUpperCase(),
            result.status === 'failed' ? result.message : `Cloud workspace resync could not read the snapshot (${result.status}).`,
          )
        }
      },
    }))
  }

  async stopStream(subscriptionId: string): FaceReturn<CloudWorkspacesFace, 'stopStream'> {
    return this.call(() => {
      this.host().stopStream(subscriptionId)
      return this.host().streamState(subscriptionId)
    })
  }

  async streamEventsAfter(subscriptionId: string, afterEventId: string): FaceReturn<CloudWorkspacesFace, 'streamEventsAfter'> {
    return this.call(() => this.host().streamEventsAfter(afterEventId, subscriptionId))
  }

  /** Wrap one host read into the face envelope; transport faults take the error branch. */
  private async call<T>(
    operation: () => T,
  ): Promise<{ readonly ok: true; readonly value: Awaited<T> } | { readonly ok: false; readonly error: ReturnType<typeof failureOf> }> {
    try {
      return okResult(await operation())
    } catch (error) {
      return failResult(failureOf(error))
    }
  }
}

/**
 * The workspace session over browser state: a `static-token` deployment's
 * only identity is its configured token; an `account` deployment borrows the
 * platform session (the browser has no credential store), and an
 * authorization failure clears exactly the session that failed.
 */
function browserWorkspaceSession(
  config: ResolvedPlatformClientConfig | undefined,
  readPlatformSession: PlatformSessionReader,
  clearPlatformSession: PlatformSessionClearer,
): WorkspaceSessionProvider {
  const staticDeployment = config?.authMode === 'static-token'
  return {
    read: async () => {
      if (config === undefined) return undefined
      if (staticDeployment) {
        const token = config.workspaceAccessToken as string
        return { accessToken: token, identity: await identityOf(token) }
      }
      const grant = readPlatformSession()
      if (grant === undefined) return undefined
      return { accessToken: grant.accessToken, identity: await identityOf(grant.accessToken) }
    },
    clear: async (identity: string): Promise<boolean> => {
      if (staticDeployment || config === undefined) return false
      const grant = readPlatformSession()
      if (grant === undefined) return false
      if (await identityOf(grant.accessToken) !== identity) return false
      clearPlatformSession(grant)
      return true
    },
  }
}

/**
 * The fixed-length identity digest the host's credential provider carries:
 * comparable across reads, never replayable, safe for diagnostics.
 */
async function identityOf(accessToken: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(accessToken))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 32)
}
