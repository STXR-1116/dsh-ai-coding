/** Browser-provided `remote.teamSkills` service: the platform backend called directly. */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { TeamSkillAccountHttpClient, TeamSkillHttpClient, type TeamSkillAccountSessionResponse } from '../../http.ts'
import { buildInstallStages, type TeamSkillInstallStage } from '../../install-stages.ts'
import type {
  TeamSkillAccountState,
  TeamSkillCatalogResult,
  TeamSkillChangePasswordRequest,
  TeamSkillFailed,
  TeamSkillInstallRequest,
  TeamSkillInstallResult,
  TeamSkillKnowledgeSearchRequest,
  TeamSkillLoginRequest,
  TeamSkillNotReady,
  TeamSkillTrustCard,
  TeamSkillUninstallRequest,
} from '../../types.ts'
import { failResult, failureOf, okResult } from './errors.ts'
import type { ResolvedPlatformClientConfig } from './config.ts'
import { subscribeBrowserSettings } from './settings.ts'

/** The generated wire face this service satisfies; drift fails the build here. */
type TeamSkillsFace = ClientRemote['teamSkills']

/** The awaited face member type an async implementation returns. */
type FaceReturn<Face, M extends keyof Face> = Face[M] extends (...args: never[]) => Promise<infer R> ? Promise<R> : never

/** The signed-in service session, held in memory only (a browser reload signs out). */
export interface AccountGrant {
  readonly userId: string
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiresAt: number
}

/** Terminal states the host face folds into its business unions. */
type TerminalFailure = TeamSkillNotReady | TeamSkillFailed | { readonly status: 'signed-out' }

/**
 * The full `remote.teamSkills` method face, answered by the browser from the
 * platform backend over `src/http.ts`'s fetch clients.
 *
 * Session state lives in memory (the host half persists grants in its
 * credential store; a browser cannot), so `account()` starts `signed-out`
 * after every reload and login is the panel's own form. Operations that need
 * the host's local filesystem (install, uninstall) answer with their explicit
 * business-failure shapes instead of pretending success, and the host-side
 * telemetry collector answers `not-ready` — the browser collects nothing.
 */
export class TeamSkillsRemoteService extends Service implements TeamSkillsFace {
  private readonly refreshInFlight = new Map<string, Promise<AccountGrant>>()
  private session: AccountGrant | undefined
  private accountClientCache: { readonly identity: string; readonly client: TeamSkillAccountHttpClient } | undefined
  /** Session-scoped knowledge selections, recorded for parity with the host face. */
  private readonly knowledgeSelections = new Map<string, { readonly projectId: string; readonly knowledgeBaseIds: readonly string[] }>()
  /** Session-scoped project-memory bindings, recorded for parity with the host face. */
  private readonly memoryBindings = new Map<string, string>()

  constructor(
    ctx: Context,
    private readonly readConfig: () => ResolvedPlatformClientConfig | undefined,
  ) {
    super(ctx, 'remote.teamSkills')
    // A settings change switches the backend: the cached clients and the
    // in-memory session belong to the previous deployment, never to the new one.
    ctx.effect(() => subscribeBrowserSettings(() => {
      this.accountClientCache = undefined
      this.session = undefined
    }), 'dsh-ai-coding: browser teamSkills settings reset')
  }

  /** The account client for the current deployment, rebuilt when settings change. */
  private accountClient(): TeamSkillAccountHttpClient | undefined {
    const config = this.readConfig()
    if (config === undefined) return undefined
    const cached = this.accountClientCache
    if (cached !== undefined && cached.identity === config.apiBaseUrl) return cached.client
    const client = new TeamSkillAccountHttpClient({ apiBaseUrl: config.apiBaseUrl })
    this.accountClientCache = { identity: config.apiBaseUrl, client }
    return client
  }

  /** The unconfigured answer: the face's explicit not-ready union, never a fake. */
  async login(request: TeamSkillLoginRequest): FaceReturn<TeamSkillsFace, 'login'> {
    const accountClient = this.accountClient()
    if (accountClient === undefined) return okResult(unconfigured())
    try {
      const session = await accountClient.login(request)
      this.writeSession(session)
      return okResult(accountState(session))
    } catch (error) {
      return failResult(failureOf(error))
    }
  }

  async account(): FaceReturn<TeamSkillsFace, 'account'> {
    const accountClient = this.accountClient()
    if (accountClient === undefined) return okResult(unconfigured())
    const session = this.session
    if (session === undefined) return okResult({ status: 'signed-out' })
    try {
      const me = await this.accountRequest(accountClient, session, accessToken => accountClient.me(accessToken))
      return okResult({
        status: 'authenticated',
        user: me.user,
        memberships: me.memberships,
        mustChangePassword: me.user.mustChangePassword,
      })
    } catch (error) {
      if (isExpiredTokenError(error)) {
        this.session = undefined
        return okResult({ status: 'signed-out' })
      }
      return failResult(failureOf(error))
    }
  }

  async refreshAccount(): FaceReturn<TeamSkillsFace, 'refreshAccount'> {
    const accountClient = this.accountClient()
    if (accountClient === undefined) return okResult(unconfigured())
    const session = this.session
    if (session === undefined) return okResult({ status: 'signed-out' })
    try {
      const next = await this.refreshSession(accountClient, session, true)
      const me = await accountClient.me(next.accessToken)
      return okResult({
        status: 'authenticated',
        user: me.user,
        memberships: me.memberships,
        mustChangePassword: me.user.mustChangePassword,
      })
    } catch (error) {
      return failResult(failureOf(error))
    }
  }

  async changePassword(request: TeamSkillChangePasswordRequest): FaceReturn<TeamSkillsFace, 'changePassword'> {
    const session = this.session
    if (session === undefined) return okResult({ status: 'signed-out' })
    const accountClient = this.accountClient()
    if (accountClient === undefined) return okResult(unconfigured())
    try {
      const next = await this.accountRequest(accountClient, session, accessToken => accountClient.changePassword(accessToken, request))
      this.writeSession(next)
      return okResult(accountState(next))
    } catch (error) {
      return failResult(failureOf(error))
    }
  }

  async logout(): FaceReturn<TeamSkillsFace, 'logout'> {
    const session = this.session
    if (session === undefined) return okResult({ status: 'signed-out' })
    const accountClient = this.accountClient()
    if (accountClient !== undefined) {
      try {
        await accountClient.logout(session.accessToken)
      } catch {
        // Dropping the local session below is required even when revocation fails.
      }
    }
    this.session = undefined
    return okResult({ status: 'signed-out' })
  }

  async accessSummary(): FaceReturn<TeamSkillsFace, 'accessSummary'> {
    return this.sessionRequest((client, accessToken) => client.accessSummary(accessToken))
  }

  async projects(): FaceReturn<TeamSkillsFace, 'projects'> {
    return this.sessionRequest((client, accessToken) => client.projects(accessToken))
  }

  async project(projectId: string): FaceReturn<TeamSkillsFace, 'project'> {
    return this.sessionRequest((client, accessToken) => client.project(accessToken, projectId))
  }

  async catalog(projectId: string): FaceReturn<TeamSkillsFace, 'catalog'> {
    const result = await this.authorizedRequest(client => client.catalog(projectId))
    if (!result.ok) return result
    if (isTerminalFailure(result.value)) return okResult(result.value)
    return okResult({ status: 'ready', catalog: result.value })
  }

  async knowledgeBases(projectId: string): FaceReturn<TeamSkillsFace, 'knowledgeBases'> {
    return this.authorizedRequest(client => client.knowledgeBases(projectId))
  }

  async knowledgeSearch(request: TeamSkillKnowledgeSearchRequest): FaceReturn<TeamSkillsFace, 'knowledgeSearch'> {
    const result = await this.authorizedRequest(client => client.knowledgeSearch(request))
    if (!result.ok) return result
    if (isTerminalFailure(result.value)) return okResult(result.value)
    return okResult({ status: 'ready', response: result.value })
  }

  async knowledgePreview(knowledgeBaseId: string, documentId: string): FaceReturn<TeamSkillsFace, 'knowledgePreview'> {
    return this.authorizedRequest(client => client.knowledgePreview(knowledgeBaseId, documentId))
  }

  async memoryRecall(request: { readonly projectId: string; readonly query: string }): FaceReturn<TeamSkillsFace, 'memoryRecall'> {
    return this.authorizedRequest(client => client.memoryRecall(request))
  }

  async memoryCapture(
    request: {
      readonly projectId: string
      readonly sessionId: string
      readonly taskId?: string
      readonly messages: readonly { readonly role: 'user' | 'assistant'; readonly content: string }[]
    },
    idempotencyKey: string,
  ): FaceReturn<TeamSkillsFace, 'memoryCapture'> {
    return this.authorizedRequest(client => client.memoryCapture(request, idempotencyKey))
  }

  async memoryList(request: {
    readonly projectId: string
    readonly keyword?: string
    readonly cursor?: string
    readonly limit?: number
  }): FaceReturn<TeamSkillsFace, 'memoryList'> {
    return this.authorizedRequest(client => client.memoryList(request))
  }

  async memoryCandidatesConfirm(
    request: { readonly memoryId: string; readonly expectedRevision: number },
    idempotencyKey: string,
  ): FaceReturn<TeamSkillsFace, 'memoryCandidatesConfirm'> {
    return this.authorizedRequest(client => client.memoryCandidatesConfirm(request, idempotencyKey))
  }

  async memoryGet(memoryId: string): FaceReturn<TeamSkillsFace, 'memoryGet'> {
    return this.authorizedRequest(client => client.memoryGet(memoryId))
  }

  async memoryUpdate(
    request: { readonly memoryId: string; readonly content: string; readonly expectedRevision: number },
    idempotencyKey: string,
  ): FaceReturn<TeamSkillsFace, 'memoryUpdate'> {
    return this.authorizedRequest(client => client.memoryUpdate(request, idempotencyKey))
  }

  async memoryDelete(
    request: { readonly memoryId: string; readonly expectedRevision: number },
    idempotencyKey: string,
  ): FaceReturn<TeamSkillsFace, 'memoryDelete'> {
    return this.authorizedRequest(client => client.memoryDelete(request, idempotencyKey))
  }

  async memoryJobs(projectId?: string): FaceReturn<TeamSkillsFace, 'memoryJobs'> {
    return this.authorizedRequest(client => client.memoryJobs(projectId))
  }

  async memoryAudit(projectId?: string): FaceReturn<TeamSkillsFace, 'memoryAudit'> {
    return this.authorizedRequest(client => client.memoryAudit(projectId))
  }

  /**
   * Record one session's knowledge selection. The native-session recall loop
   * is a host-half feature; the browser face keeps the binding in memory so
   * the panel's selection flow behaves identically.
   */
  async configureKnowledgeSelection(
    sessionId: string,
    selection: { readonly projectId: string; readonly knowledgeBaseIds: readonly string[] },
  ): FaceReturn<TeamSkillsFace, 'configureKnowledgeSelection'> {
    if (selection.projectId.length === 0 || selection.knowledgeBaseIds.length === 0) this.knowledgeSelections.delete(sessionId)
    else this.knowledgeSelections.set(sessionId, { projectId: selection.projectId, knowledgeBaseIds: [...new Set(selection.knowledgeBaseIds)] })
    return okResult(undefined)
  }

  /** Drop one session's knowledge selection. */
  async clearKnowledgeSelection(sessionId: string): FaceReturn<TeamSkillsFace, 'clearKnowledgeSelection'> {
    this.knowledgeSelections.delete(sessionId)
    return okResult(undefined)
  }

  /** Record one session's project-memory binding (browser-face parity, in memory). */
  async configureProjectMemory(sessionId: string, projectId: string): FaceReturn<TeamSkillsFace, 'configureProjectMemory'> {
    this.memoryBindings.set(sessionId, projectId)
    return okResult(undefined)
  }

  /** Drop one session's project-memory binding. */
  async clearProjectMemory(sessionId: string): FaceReturn<TeamSkillsFace, 'clearProjectMemory'> {
    this.memoryBindings.delete(sessionId)
    return okResult(undefined)
  }

  async collectorStatus(): FaceReturn<TeamSkillsFace, 'collectorStatus'> {
    return okResult(collectorNotReady())
  }

  async configureCollectorProject(_sessionId: string, _projectId: string): FaceReturn<TeamSkillsFace, 'configureCollectorProject'> {
    return okResult(collectorNotReady())
  }

  async clearCollectorProject(_sessionId: string): FaceReturn<TeamSkillsFace, 'clearCollectorProject'> {
    return okResult(collectorNotReady())
  }

  async pauseCollector(): FaceReturn<TeamSkillsFace, 'pauseCollector'> {
    return okResult(collectorNotReady())
  }

  async resumeCollector(): FaceReturn<TeamSkillsFace, 'resumeCollector'> {
    return okResult(collectorNotReady())
  }

  async flushCollector(): FaceReturn<TeamSkillsFace, 'flushCollector'> {
    return okResult(collectorNotReady())
  }

  async clearPendingCollectorData(): FaceReturn<TeamSkillsFace, 'clearPendingCollectorData'> {
    return okResult(collectorNotReady())
  }

  async installations(_projectId: string): FaceReturn<TeamSkillsFace, 'installations'> {
    return okResult(Object.freeze([]))
  }

  async syncReleaseStatus(_projectId: string): FaceReturn<TeamSkillsFace, 'syncReleaseStatus'> {
    return okResult(Object.freeze([]))
  }

  async trustCard(request: {
    readonly skillId: string
    readonly version: string
    readonly projectId: string
  }): FaceReturn<TeamSkillsFace, 'trustCard'> {
    return this.authorizedRequest(client => client.trustCard(request))
  }

  /**
   * Answers with the explicit stage-evidenced failure: installing writes the
   * host's local skill directories, which a browser client does not have.
   */
  async installSkill(_request: TeamSkillInstallRequest): FaceReturn<TeamSkillsFace, 'installSkill'> {
    return okResult(hostOnlyInstallFailure('authorization', '安装需要宿主本地技能目录，浏览器端不执行安装。'))
  }

  /** Answers with the explicit failure: uninstall removes host-local files. */
  async uninstallSkill(_request: TeamSkillUninstallRequest): FaceReturn<TeamSkillsFace, 'uninstallSkill'> {
    return okResult({
      status: 'failed',
      code: 'HOST_INSTALL_UNAVAILABLE',
      message: '卸载需要宿主本地文件系统，浏览器端不执行卸载。',
    })
  }

  /**
   * Run one account-client read under the in-memory session: `signed-out`
   * without one, the host's single in-request refresh across a 401, and the
   * explicit business failure for everything else. Static platform tokens do
   * not carry account reads — the same rule the host half applies.
   */
  private async sessionRequest<T>(
    operation: (client: TeamSkillAccountHttpClient, accessToken: string) => Promise<T>,
  ): Promise<RemoteResult<T | TerminalFailure>> {
    const accountClient = this.accountClient()
    if (accountClient === undefined) return okResult(unconfigured())
    const session = this.session
    if (session === undefined) return okResult({ status: 'signed-out' })
    try {
      return okResult(await this.accountRequest(accountClient, session, accessToken => operation(accountClient, accessToken)))
    } catch (error) {
      if (isExpiredTokenError(error)) {
        this.session = undefined
        return okResult({ status: 'signed-out' })
      }
      return failResult(failureOf(error))
    }
  }

  /**
   * Run one token-carrying read under the current identity: a static-token
   * deployment uses its token client directly; an account deployment uses the
   * in-memory session with the host's single in-request refresh.
   */
  private async authorizedRequest<T>(
    operation: (client: TeamSkillHttpClient) => Promise<T>,
  ): Promise<RemoteResult<T | TerminalFailure>> {
    const config = this.readConfig()
    if (config === undefined) return okResult(unconfigured())
    if (config.accessToken !== undefined && config.accessToken.length > 0) {
      const client = new TeamSkillHttpClient({ apiBaseUrl: config.apiBaseUrl, accessToken: config.accessToken })
      try {
        return okResult(await operation(client))
      } catch (error) {
        return failResult(failureOf(error))
      }
    }
    const accountClient = this.accountClient()
    if (accountClient === undefined) return okResult(unconfigured())
    const session = this.session
    if (session === undefined) return okResult({ status: 'signed-out' })
    try {
      return okResult(await this.accountRequest(accountClient, session, accessToken =>
        operation(new TeamSkillHttpClient({ apiBaseUrl: config.apiBaseUrl, accessToken }))))
    } catch (error) {
      if (isExpiredTokenError(error)) {
        this.session = undefined
        return okResult({ status: 'signed-out' })
      }
      return failResult(failureOf(error))
    }
  }

  /**
   * Run one account operation with the host's refresh semantics: refresh
   * ahead of an imminent expiry, once per request on an expired-token
   * rejection, and never retry after the refresh itself fails.
   */
  private async accountRequest<T>(
    accountClient: TeamSkillAccountHttpClient,
    session: AccountGrant,
    operation: (accessToken: string) => Promise<T>,
  ): Promise<T> {
    try {
      if (session.expiresAt <= Date.now() + 30_000) {
        const refreshed = await this.refreshSession(accountClient, session)
        return await operation(refreshed.accessToken)
      }
      return await operation(session.accessToken)
    } catch (error) {
      if (!isExpiredTokenError(error)) throw error
      const refreshed = await this.refreshSession(accountClient, session)
      return await operation(refreshed.accessToken)
    }
  }

  /**
   * Rotate the session at most once per refresh token (single flight), and
   * drop the stored session when that rotation fails, mirroring the host's
   * credential-clearing semantics without a credential store.
   */
  private async refreshSession(accountClient: TeamSkillAccountHttpClient, session: AccountGrant, force = false): Promise<AccountGrant> {
    if (!force) {
      const current = this.session
      if (current !== undefined && current.refreshToken !== session.refreshToken) return current
    }
    const existing = this.refreshInFlight.get(session.refreshToken)
    if (existing !== undefined) return existing
    const pending = (async (): Promise<AccountGrant> => {
      try {
        const current = this.session
        if (!force && current !== undefined && current.refreshToken !== session.refreshToken) return current
        const refreshed = await accountClient.refresh(session.refreshToken)
        const latest = this.session
        if (latest !== undefined && latest.refreshToken !== session.refreshToken) return latest
        this.writeSession(refreshed)
        return grantOf(refreshed)
      } catch (error) {
        if (this.session?.refreshToken === session.refreshToken) this.session = undefined
        throw error
      } finally {
        this.refreshInFlight.delete(session.refreshToken)
      }
    })()
    this.refreshInFlight.set(session.refreshToken, pending)
    return pending
  }

  /** Store the rotated session in memory. */
  private writeSession(session: TeamSkillAccountSessionResponse): void {
    this.session = grantOf(session)
  }

  /**
   * The in-memory session grant, for the workspace face's shared-identity
   * reads: an `account` workspace deployment's only browser identity is the
   * platform session this service signed in.
   */
  currentGrant(): AccountGrant | undefined {
    return this.session
  }

  /** Drop the stored session, but only while it is still the one the caller observed. */
  clearSessionIfCurrent(expected: AccountGrant): void {
    if (this.session?.accessToken === expected.accessToken && this.session.refreshToken === expected.refreshToken) {
      this.session = undefined
    }
  }
}

/**
 * One host-only install failure with the full seven-stage evidence the face
 * promises; the authorization stage is where the browser stops.
 * @param failedStage - The stage the browser face stops at.
 * @param detail - The operator-facing explanation.
 * @returns the install failure value.
 */
function hostOnlyInstallFailure(failedStage: TeamSkillInstallStage, detail: string): TeamSkillInstallResult {
  return {
    status: 'failed',
    code: 'HOST_INSTALL_UNAVAILABLE',
    message: detail,
    stages: buildInstallStages({
      succeeded: new Map(),
      failedStage,
      failedDetail: detail,
      rollback: 'skipped',
      rollbackDetail: '未开始写入，无需回滚。',
    }),
    failedStage,
    retryable: { retryable: false, how: '请在宿主端（DSH 客户端）执行安装。' },
  }
}

/**
 * The collector snapshot the browser face answers with: the telemetry
 * collector queues and delivers from the host process, so the browser client
 * runs none. The bare `not-ready` value matches the corresponding union
 * member of every `CollectorResult` in the face.
 */
function collectorNotReady(): { status: 'not-ready'; missing: readonly string[] } {
  return { status: 'not-ready', missing: ['host telemetry collector'] }
}

/**
 * The unconfigured answer for reads that carry a failure union: the face's
 * explicit `not-ready` naming what the settings face needs — never a silent
 * fake-ready, never a transport error.
 */
function unconfigured(): { status: 'not-ready'; missing: readonly string[] } {
  return { status: 'not-ready', missing: ['apiBaseUrl — 请在协作台「服务设置」里填写后端地址'] }
}

/** @returns The in-memory grant for one raw session response. */
function grantOf(session: TeamSkillAccountSessionResponse): AccountGrant {
  return {
    userId: session.user.userId,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresAt: Date.now() + session.expiresIn * 1000,
  }
}

/** @returns The browser-safe account state for one raw session response. */
function accountState(session: TeamSkillAccountSessionResponse): TeamSkillAccountState {
  return {
    status: 'authenticated',
    user: session.user,
    memberships: session.memberships,
    mustChangePassword: session.mustChangePassword,
  }
}

/** @returns Whether a caught value is a session-expiry rejection. */
function isExpiredTokenError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && isExpiredTokenCode(code)
}

/** The session-expiry codes the service reports. */
function isExpiredTokenCode(code: string): boolean {
  return code === 'AUTH_REQUIRED' || code === 'UNAUTHORIZED' || code === 'TOKEN_EXPIRED' || code === 'TOKEN_REVOKED'
}

/**
 * Whether an authorized read answered with one of the host face's terminal
 * states instead of a business value; those pass through unchanged.
 */
function isTerminalFailure(
  value: unknown,
): value is TeamSkillNotReady | TeamSkillFailed | { readonly status: 'signed-out' } {
  const status = typeof value === 'object' && value !== null ? (value as { status?: unknown }).status : undefined
  return status === 'not-ready' || status === 'failed' || status === 'signed-out'
}
