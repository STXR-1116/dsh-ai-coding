/** Host-only Team Skill workflow: authorized download, verified write and local record. */

import { randomUUID } from 'node:crypto'
import { cp, mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { credentialKey, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { TeamSkillInstallError, installTeamSkill, quarantineTeamSkill, uninstallTeamSkill } from './installer.ts'
import { TeamSkillAccountHttpClient, type TeamSkillAccountSessionResponse, TeamSkillHttpClient, TeamSkillHttpError } from './http.ts'
import { TeamSkillInstallationStore, type TeamSkillInstallationStoreLike } from './installation-store.ts'
import {
  buildInstallStages,
  classifyInstallFailure,
  type TeamSkillInstallStage,
  type TeamSkillInstallStageOutcome,
} from './install-stages.ts'
import type { TelemetryBatchRequest } from './types.ts'
import type { TelemetrySendOutcome } from './telemetry/reporter.ts'
import { sanitizeSensitiveSummary } from './telemetry/sanitize.ts'
import type {
  TeamSkillCatalogResult,
  TeamSkillAccessSummary,
  TeamSkillAccountResult,
  TeamSkillAccountState,
  TeamSkillChangePasswordRequest,
  TeamSkillLoginRequest,
  TeamSkillFailed,
  TeamSkillInstallRequest,
  TeamSkillInstallResult,
  TeamSkillInstallationRecord,
  TeamSkillInstallationView,
  TeamSkillNotReady,
  TeamSkillScope,
  TeamSkillTrustCard,
  TeamSkillUninstallRequest,
  TeamSkillUninstallResult,
  TeamSkillProject,
  TeamSkillProjectDetail,
  TeamSkillKnowledgeBaseSummary,
  TeamSkillKnowledgeSearchRequest,
  TeamSkillKnowledgeSearchResponse,
  TeamSkillKnowledgePreview,
  TeamSkillMemory,
  TeamSkillMemoryPage,
  TeamSkillMemoryRecallResponse,
  TeamSkillMemoryMutation,
  TeamSkillMemoryJob,
  TeamSkillMemoryAudit,
} from './types.ts'

/** Credential record shared by the Team Skill Host and the cloud workspace session provider. */
export const ACCOUNT_CREDENTIAL_KEY = credentialKey('dsh-ai-coding-platform', 'account')

/**
 * Local queue partition name for static-token deployments: only used while no
 * login-state account exists. The gateway's resolveAccount must publish the
 * same value so partition and `Authorization` identity stay comparable.
 */
export const STATIC_TOKEN_PARTITION = 'static-token'

interface AccountGrant {
  readonly userId: string
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiresAt: number
}

/** Private Host settings supplied by the Cordis plugin configuration. */
export interface TeamSkillHostOptions {
  /** AI Coding service endpoint including `/v1`; omitted means catalog is not ready. */
  readonly apiBaseUrl?: string
  /** OIDC access token kept in the Host plane; omitted means catalog is not ready. */
  readonly accessToken?: string
  /** DSH credential record provider used for the account session. */
  readonly credentials?: CredentialProvider
  /** Private platform state root; it is never sent to the service. */
  readonly stateDirectory?: string
  /** DSH global Skill discovery root. */
  readonly globalSkillRoot?: string
  /** Resolve an opaque DSH workspace id without exposing its path to the browser or service. */
  readonly resolveWorkspace?: (workspaceId: string) => string | undefined
  /** Confirm DSH's native Skill registry discovers a newly written copy. */
  readonly refreshSkillCatalog?: (
    scope: TeamSkillScope,
    workspacePath: string | undefined,
    runtimeName: string,
    expectedPresent?: boolean,
  ) => Promise<boolean>
  /** Injectable fetch implementation for focused Host tests. */
  readonly fetch?: typeof globalThis.fetch
  /** Injectable durable installation store for deterministic failure-path tests. */
  readonly installationStore?: TeamSkillInstallationStoreLike
}

/** Orchestrates a real local Team Skill operation from server authorization to DSH discovery. */
export class TeamSkillHost {
  private readonly refreshInFlight = new Map<string, Promise<AccountGrant>>()

  constructor(private readonly options: TeamSkillHostOptions) {}

  /** Authenticate and persist a service session in the Host credential store.
   * @param request - Username and password submitted to the service.
   * @returns Browser-safe account state or an explicit unavailable, signed-out, or failed state.
   */
  async login(request: TeamSkillLoginRequest): Promise<TeamSkillAccountResult<TeamSkillAccountState>> {
    const client = this.accountClient()
    if ('status' in client) return client
    if (this.options.credentials === undefined) return missing(['credentials'])
    try {
      const session = await client.login(request)
      await this.writeAccountSession(session)
      return accountState(session)
    } catch (error) {
      return failureOf(error)
    }
  }

  /** Read the current account from the service, refreshing one expired session when needed and deleting a rejected grant.
   * @returns Browser-safe account state or an explicit unavailable, signed-out, or failed state.
   */
  async account(): Promise<TeamSkillAccountResult<TeamSkillAccountState>> {
    const client = this.accountClient()
    if ('status' in client) return client
    const session = await this.readAccountSession()
    if (session === undefined) return { status: 'signed-out' }
    try {
      const me = await this.accountRequest(client, session, accessToken => client.me(accessToken))
      return { status: 'authenticated', user: me.user, memberships: me.memberships, mustChangePassword: me.user.mustChangePassword }
    } catch (error) {
      if (error instanceof TeamSkillHttpError && isExpiredTokenCode(error.code)) {
        await this.clearAccountSession()
        return { status: 'signed-out' }
      }
      return failureOf(error)
    }
  }

  /** Rotate the current service session without exposing replacement tokens.
   * @returns Browser-safe account state or an explicit unavailable, signed-out, or failed state.
   */
  async refreshAccount(): Promise<TeamSkillAccountResult<TeamSkillAccountState>> {
    const context = await this.accountMutationContext()
    if ('status' in context) return context
    try {
      const next = await this.refreshSession(context.client, context.session, true)
      const me = await context.client.me(next.accessToken)
      return { status: 'authenticated', user: me.user, memberships: me.memberships, mustChangePassword: me.user.mustChangePassword }
    } catch (error) {
      return failureOf(error)
    }
  }

  /** Change the current password and replace the service session.
   * @param request - Current and replacement password values.
   * @returns Browser-safe account state or an explicit unavailable, signed-out, or failed state.
   */
  async changePassword(request: TeamSkillChangePasswordRequest): Promise<TeamSkillAccountResult<TeamSkillAccountState>> {
    const context = await this.accountMutationContext()
    if ('status' in context) return context
    try {
      const next = await this.accountRequest(
        context.client,
        context.session,
        accessToken => context.client.changePassword(accessToken, request),
      )
      await this.writeAccountSession(next)
      return accountState(next)
    } catch (error) {
      return failureOf(error)
    }
  }

  /** Revoke the service session and clear Host credentials even when revocation fails.
   * @returns Signed-out account state or an explicit unavailable or failed state.
   */
  async logout(): Promise<TeamSkillAccountResult<TeamSkillAccountState>> {
    const client = this.accountClient()
    if ('status' in client) return client
    const session = await this.readAccountSession()
    if (session === undefined) return { status: 'signed-out' }
    try {
      await client.logout(session.accessToken)
    } catch {
      // Local credential removal is required even when the service is unavailable.
    }
    await this.clearAccountSession()
    return { status: 'signed-out' }
  }

  /** Read the aggregate access summary after confirming the current session.
   * @returns Server-filtered access summary or an explicit unavailable, signed-out, or failed state.
   */
  async accessSummary(): Promise<TeamSkillAccountResult<TeamSkillAccessSummary>> {
    const client = this.accountClient()
    if ('status' in client) return client
    const session = await this.readAccountSession()
    if (session === undefined) return { status: 'signed-out' }
    try {
      return await this.accountRequest(client, session, accessToken => client.accessSummary(accessToken))
    } catch (error) {
      return failureOf(error)
    }
  }

  /** Read the service-authoritative active project list for the signed-in account.
   * @returns Active project summaries or an explicit signed-out or failed state.
   */
  async projects(): Promise<TeamSkillAccountResult<readonly TeamSkillProject[]>> {
    const client = this.accountClient()
    if ('status' in client) return client
    const session = await this.readAccountSession()
    if (session === undefined) return { status: 'signed-out' }
    try {
      return await this.accountRequest(client, session, accessToken => client.projects(accessToken))
    } catch (error) {
      return failureOf(error)
    }
  }

  /** Read one authorized project and its asset relation summaries.
   * @param projectId - Opaque project identity selected by the user.
   * @returns Authorized project detail or an explicit failed state.
   */
  async project(projectId: string): Promise<TeamSkillAccountResult<TeamSkillProjectDetail>> {
    const client = this.accountClient()
    if ('status' in client) return client
    const session = await this.readAccountSession()
    if (session === undefined) return { status: 'signed-out' }
    try {
      return await this.accountRequest(client, session, accessToken => client.project(accessToken, projectId))
    } catch (error) {
      return failureOf(error)
    }
  }

  /** Read the visible catalog without returning a fake fallback when service configuration is incomplete.
   * @param projectId - Opaque project identity authorized by the service.
   * @returns Current catalog or an explicit signed-out, unavailable, or failed state.
   */
  async catalog(projectId: string): Promise<TeamSkillCatalogResult> {
    const result = await this.authorizedRequest(client => client.catalog(projectId))
    if (isTerminalResult(result)) return result
    return { status: 'ready', catalog: result }
  }

  /** Read one published release's trust card before the user installs it (§11.14).
   * @param request - Skill identity, immutable version and the authorizing project.
   * @returns Trust card or an explicit signed-out, unavailable, or failed state.
   */
  async trustCard(request: {
    readonly skillId: string
    readonly version: string
    readonly projectId: string
  }): Promise<TeamSkillTrustCard | TeamSkillNotReady | TeamSkillFailed | { readonly status: 'signed-out' }> {
    return this.authorizedRequest(client => client.trustCard(request))
  }

  /** Read current project knowledge-base summaries through the service.
   * @param projectId - Opaque project identity authorized by the service.
   * @returns Server-authoritative knowledge-base summaries or an explicit failure.
   */
  async knowledgeBases(projectId: string): Promise<TeamSkillAccountResult<readonly TeamSkillKnowledgeBaseSummary[]>> {
    return this.authorizedRequest(client => client.knowledgeBases(projectId))
  }

  /** Search explicitly selected knowledge bases for one conversation turn.
   * @param request - Project and knowledge-base search request.
   * @param signal - Optional cancellation signal for the service request.
   * @returns Server-authoritative search results or an explicit failure.
   */
  async knowledgeSearch(
    request: TeamSkillKnowledgeSearchRequest,
    signal?: AbortSignal,
  ): Promise<TeamSkillAccountResult<{ readonly status: 'ready'; readonly response: TeamSkillKnowledgeSearchResponse }>> {
    const result = await this.authorizedRequest(client => client.knowledgeSearch(request, signal), signal)
    if (isKnowledgeFailure(result)) return result
    return { status: 'ready', response: result }
  }

  /** Resolve an authorized document preview URL.
   * @param knowledgeBaseId - Opaque knowledge-base identity.
   * @param documentId - Opaque document identity.
   * @returns Server-authoritative preview or an explicit failure.
   */
  async knowledgePreview(knowledgeBaseId: string, documentId: string): Promise<TeamSkillAccountResult<TeamSkillKnowledgePreview>> {
    return this.authorizedRequest(client => client.knowledgePreview(knowledgeBaseId, documentId))
  }

  /** Recall project memories without blocking the native coding request.
   * @param request - Project and query sent to the service.
   * @param signal - Optional cancellation signal for the service request.
   * @returns Recall results or an explicit service failure.
   */
  async memoryRecall(
    request: { readonly projectId: string; readonly query: string },
    signal?: AbortSignal,
  ): Promise<TeamSkillAccountResult<TeamSkillMemoryRecallResponse>> {
    return this.authorizedRequest(client => client.memoryRecall(request, signal), signal)
  }

  /** Accept one asynchronous automatic-capture batch.
   * @param request - Project, session, and cleaned transcript messages.
   * @param idempotencyKey - Unique key for this capture attempt.
   * @returns Accepted mutation or an explicit service failure.
   */
  async memoryCapture(
    request: {
      readonly projectId: string
      readonly sessionId: string
      readonly taskId?: string
      readonly messages: readonly { readonly role: 'user' | 'assistant'; readonly content: string }[]
    },
    idempotencyKey: string,
  ): Promise<TeamSkillAccountResult<TeamSkillMemoryMutation>> {
    return this.authorizedRequest(client => client.memoryCapture(request, idempotencyKey))
  }

  /** List project memories from the server cursor.
   * @param request - Project, optional search term, cursor, and page size.
   * @returns Server-authoritative memory page or an explicit service failure.
   */
  async memoryList(request: {
    readonly projectId: string
    readonly keyword?: string
    readonly cursor?: string
    readonly limit?: number
  }): Promise<TeamSkillAccountResult<TeamSkillMemoryPage>> {
    return this.authorizedRequest(client => client.memoryList(request))
  }

  /** Confirm one memory candidate with an idempotency key and revision guard (§11.16).
   * @param request - Candidate identity and expected revision.
   * @param idempotencyKey - Unique key for this confirm attempt; forwarded to the service.
   * @returns The updated memory or an explicit revision or authorization failure.
   */
  async memoryCandidatesConfirm(
    request: { readonly memoryId: string; readonly expectedRevision: number },
    idempotencyKey: string,
  ): Promise<TeamSkillAccountResult<TeamSkillMemory>> {
    return this.authorizedRequest(client => client.memoryCandidatesConfirm(request, idempotencyKey))
  }

  /** Read one project-memory detail.
   * @param memoryId - Opaque memory identity.
   * @returns Server-authoritative memory detail or an explicit service failure.
   */
  async memoryGet(memoryId: string): Promise<TeamSkillAccountResult<TeamSkillMemory>> {
    return this.authorizedRequest(client => client.memoryGet(memoryId))
  }

  /** Update one project-memory body with server revision control.
   * @param request - Memory identity, replacement body, and expected revision.
   * @param idempotencyKey - Unique key for this update attempt; forwarded to the service.
   * @returns Accepted mutation or an explicit revision or authorization failure.
   */
  async memoryUpdate(
    request: {
      readonly memoryId: string
      readonly content: string
      readonly expectedRevision: number
    },
    idempotencyKey: string,
  ): Promise<TeamSkillAccountResult<TeamSkillMemoryMutation>> {
    return this.authorizedRequest(client => client.memoryUpdate(request, idempotencyKey))
  }

  /** Delete one project-memory record and return its cleanup job.
   * @param request - Memory identity and expected revision.
   * @param idempotencyKey - Unique key for this delete attempt.
   * @returns Accepted deletion or an explicit revision or authorization failure.
   */
  async memoryDelete(
    request: { readonly memoryId: string; readonly expectedRevision: number },
    idempotencyKey: string,
  ): Promise<TeamSkillAccountResult<TeamSkillMemoryMutation>> {
    return this.authorizedRequest(client => client.memoryDelete(request, idempotencyKey))
  }

  /** List capture, indexing, and cleanup jobs.
   * @param projectId - Optional project filter.
   * @returns Server-authoritative jobs or an explicit service failure.
   */
  async memoryJobs(projectId?: string): Promise<TeamSkillAccountResult<readonly TeamSkillMemoryJob[]>> {
    return this.authorizedRequest(client => client.memoryJobs(projectId))
  }

  /** List server memory governance audit records.
   * @param projectId - Optional project filter.
   * @returns Server-authoritative audit records or an explicit service failure.
   */
  async memoryAudit(projectId?: string): Promise<TeamSkillAccountResult<readonly TeamSkillMemoryAudit[]>> {
    return this.authorizedRequest(client => client.memoryAudit(projectId))
  }

  /** Resolve the capture-time account partition for the collector without exposing tokens.
   * @returns The account user id, or an explicit signed-out or not-ready state.
   */
  async telemetryAccount(): Promise<{ readonly userId: string } | { readonly status: 'signed-out' | 'not-ready' }> {
    // 未配置凭据服务 = 部署根本没有登录能力，确认无登录态（静态 Token 部署）。
    if (this.options.credentials === undefined) return { status: 'signed-out' }
    try {
      const session = await this.readAccountSession()
      // 记录不存在 = 明确登出，同样确认无登录态。
      if (session === undefined) return { status: 'signed-out' }
      return { userId: session.userId }
    } catch {
      // 凭据读取异常（存储损坏等）：无法确认登录状态，必须停止而非回落。
      return { status: 'not-ready' }
    }
  }

  /** Deliver one telemetry batch for the given account partition with the account request's single refresh.
   * @param batch - Marked single-project batch.
   * @param timeoutMs - Hard client-side delivery timeout.
   * @param expectedAccountId - Queue partition the reporter claimed the batch from; the freshly
   * resolved account must match it or nothing is sent, so partition and `Authorization` identity
   * cannot diverge across an await (login/logout between resolve and send).
   * @returns The explicit send outcome for the reporter's queue policy.
   * @remarks Send credentials are immutable within one delivery: the credential resolved at
   * partition-check time serves the whole request, and a 401 triggers at most one in-request
   * refresh inside `accountRequest` — a later account change is only observed by the next
   * delivery's partition check (regression: gateway spec R11, loop spec recovery).
   */
  async telemetryDeliver(batch: TelemetryBatchRequest, timeoutMs: number, expectedAccountId: string): Promise<TelemetrySendOutcome> {
    const apiBaseUrl = this.options.apiBaseUrl
    if (apiBaseUrl === undefined || apiBaseUrl.length === 0) {
      return { status: 'failed', code: 'API_BASE_URL_MISSING', summary: 'AI Coding service endpoint is not configured.' }
    }
    const deliver = (accessToken: string) => {
      const client = new TeamSkillHttpClient({
        apiBaseUrl,
        accessToken,
        ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
      })
      return client.telemetryBatches(batch, timeoutMs)
    }
    // 登录态账号优先：静态 Token 只在没有登录态账号时兜底，
    // 账号路径的 401 仍触发既有的一次刷新语义。
    // `accountClient()` answers not-ready only for a missing endpoint, which this
    // method already answered with API_BASE_URL_MISSING, so it is a client here.
    const accountClient = this.accountClient() as TeamSkillAccountHttpClient
    let session: AccountGrant | undefined
    try {
      session = await this.readAccountSession()
    } catch {
      // 凭据读取异常：无法确认登录状态，停止发送而非回落静态 Token。
      return { status: 'failed', code: 'CREDENTIALS_UNAVAILABLE', summary: '凭据存储读取失败，遥测发送已停止。' }
    }
    // 分区与发送身份原子一致：解析结果与 claim 分区不同（解析与发送之间发生了
    // 登录/登出/切换）时绝不发送，由 Reporter 下一次 drain 重新解析再投递。
    const resolvedPartition = session !== undefined
      ? session.userId
      : this.options.accessToken !== undefined && this.options.accessToken.length > 0 ? STATIC_TOKEN_PARTITION : undefined
    if (resolvedPartition === undefined || resolvedPartition !== expectedAccountId) {
      return {
        status: 'failed',
        code: 'TELEMETRY_ACCOUNT_CHANGED',
        summary: `queue partition ${expectedAccountId} no longer matches the resolved account; batch deferred.`,
      }
    }
    if (session !== undefined) {
      try {
        const result = await this.accountRequest(accountClient, session, async accessToken => deliver(accessToken))
        return { status: 'sent', result }
      } catch (error) {
        return this.mapDeliveryError(error)
      }
    }
    // The partition check passed without a session, which only a non-empty static
    // token can do: the contract proves one here, so no signed-out state is owed.
    const staticToken = this.options.accessToken as string
    try {
      return { status: 'sent', result: await deliver(staticToken) }
    } catch (error) {
      return this.mapDeliveryError(error)
    }
  }

  /** Map one delivery failure to the explicit reporter outcome. */
  private mapDeliveryError(error: unknown): TelemetrySendOutcome {
    return this.mapDeliveryErrorInner(error)
  }

  /** Strip credential-bearing substrings from a summary before exposing it to the reporter. */
  private sanitizeErrorSummary(value: string): string {
    return sanitizeSensitiveSummary(value)
  }

  private mapDeliveryErrorInner(error: unknown): TelemetrySendOutcome {
    if (error instanceof TeamSkillHttpError) {
      if (isExpiredTokenCode(error.code)) {
        // The refresh already ran and failed inside accountRequest; credentials are cleared.
        return { status: 'signed-out' }
      }
      if (error.code === 'PROJECT_ACCESS_REVOKED') return { status: 'revoked' }
      return { status: 'failed', code: error.code, summary: this.sanitizeErrorSummary(error.message).slice(0, 200) }
    }
    return {
      status: 'failed',
      code: 'NETWORK_ERROR',
      summary: sanitizeSensitiveSummary(error instanceof Error ? error.message : 'telemetry delivery failed').slice(0, 200),
    }
  }

  /** Return browser-safe, service-authorized installation summaries for one project.
   * @param projectId - Opaque project identity to reauthorize before returning local records.
   * @returns Browser-safe installation summaries or an explicit signed-out, local-state error.
   */
  async installations(
    projectId: string,
  ): Promise<readonly TeamSkillInstallationView[] | TeamSkillNotReady | TeamSkillFailed | { readonly status: 'signed-out' }> {
    const context = await this.installationContext(projectId)
    if ('status' in context) return context
    if (context.records.length === 0) return Object.freeze([])
    // The service only reports installable (published) releases. A record absent from
    // the authoritative response is withdrawn or unpublished: it stays visible with its
    // local copy state (`withdrawn`) so the browser can say 已撤销, rather than being
    // silently filtered out and orphaning a copy that still exists on disk (§11.14).
    const visibleKeys = new Set(context.statuses.map(item => `${item.projectId}:${item.skillId}:${item.version}`))
    return Object.freeze(
      context.records
        .filter(
          record =>
            record.installed.state !== 'normal' ||
            visibleKeys.has(`${record.projectId}:${record.skillId}:${record.installed.version}`),
        )
        .map(toInstallationView),
    )
  }

  /** Synchronize one project's local copies with server release state and quarantine unavailable versions.
   * @param projectId - Opaque project identity to reauthorize before synchronizing local records.
   * @returns Updated local copies or an explicit signed-out, unavailable, or failed state.
   */
  async syncReleaseStatus(
    projectId: string,
  ): Promise<readonly TeamSkillInstallationView[] | TeamSkillNotReady | TeamSkillFailed | { readonly status: 'signed-out' }> {
    const stateDirectory = this.options.stateDirectory
    if (stateDirectory === undefined) return missing(['stateDirectory'])
    const store = this.store(stateDirectory)
    const context = await this.installationContext(projectId)
    if ('status' in context) return context
    if (context.records.length === 0) return Object.freeze([])
    try {
      const statusByKey = new Map(context.statuses.map(item => [`${item.projectId}:${item.skillId}:${item.version}`, item.status]))
      const updated: TeamSkillInstallationRecord[] = []
      for (const record of context.records) {
        // The service only returns published installable releases: an absent record means
        // the installed version is unpublished or withdrawn and must be quarantined.
        const releaseStatus = statusByKey.get(`${record.projectId}:${record.skillId}:${record.installed.version}`)
        if (record.installed.state !== 'normal') {
          if (record.installed.state === 'withdrawn' && releaseStatus === undefined) {
            const root = this.localRoot(record.scope, record.workspaceId)
            if ('status' in root) throw new TeamSkillHttpError('LOCAL_WORKSPACE_UNAVAILABLE', '无法定位已隔离 Skill 的本地作用域。')
            const discovered =
              this.options.refreshSkillCatalog === undefined
                ? true
                : await this.options.refreshSkillCatalog(record.scope, root.workspacePath, record.installed.runtimeName, false)
            if (!discovered) throw new TeamSkillHttpError('LOCAL_REFRESH_FAILED', 'DSH 未能确认已隔离的 Team Skill。')
          }
          updated.push(record)
          continue
        }
        if (releaseStatus === 'published') {
          updated.push(record)
          continue
        }
        const root = this.localRoot(record.scope, record.workspaceId)
        if ('status' in root) throw new TeamSkillHttpError('LOCAL_WORKSPACE_UNAVAILABLE', '无法定位已下线 Skill 的本地作用域。')
        const withdrawn = await quarantineTeamSkill({
          installed: record.installed,
          quarantineRoot: join(stateDirectory, 'quarantine', record.localInstallationId),
        })
        // 隔离移动后立即落盘 withdrawn 记录：即使后续 discovery 刷新失败，重试也不会
        // 再指向已移动的旧路径，而是幂等地保持隔离状态。
        const next = Object.freeze({ ...record, installed: withdrawn })
        try {
          await store.upsert(next)
        } catch (error) {
          await restoreMovedCopy(withdrawn.directory, record.installed.directory)
          throw error
        }
        const discovered =
          this.options.refreshSkillCatalog === undefined
            ? true
            : await this.options.refreshSkillCatalog(record.scope, root.workspacePath, record.installed.runtimeName, false)
        if (!discovered) throw new TeamSkillHttpError('LOCAL_REFRESH_FAILED', 'DSH 未能移除已下线的 Team Skill。')
        // The quarantined record is user-visible as `withdrawn` even though the service
        // no longer reports the release: hiding it entirely would orphan the local copy.
        updated.push(next)
      }
      return Object.freeze(updated.map(toInstallationView))
    } catch (error) {
      return failureOf(error)
    }
  }

  /** Remove one managed copy and confirm that DSH no longer discovers it.
   * @param request - Opaque local installation identity and scope.
   * @returns Final explicit uninstall result.
   */
  async uninstall(request: TeamSkillUninstallRequest): Promise<TeamSkillUninstallResult> {
    if (this.options.stateDirectory === undefined) return missing(['stateDirectory'])
    const store = this.store(this.options.stateDirectory)
    if (this.options.refreshSkillCatalog === undefined) return missing(['refreshSkillCatalog'])
    try {
      const record = (await store.list()).find(item => item.localInstallationId === request.localInstallationId)
      if (record === undefined) throw new TeamSkillHttpError('LOCAL_INSTALLATION_NOT_FOUND', '找不到由本插件管理的 Team Skill 安装。')
      if (record.installed.state !== 'normal') return { status: 'succeeded', installation: toInstallationView(record) }
      const root = this.localRoot(record.scope, record.workspaceId)
      if ('status' in root) return root
      const removed = Object.freeze({ ...record.installed, state: 'uninstalled' as const })
      const next = Object.freeze({ ...record, installed: removed })
      // 先写入终态记录，删除失败时恢复 normal，避免记录与磁盘状态分离。
      await store.upsert(next)
      try {
        await uninstallTeamSkill({
          installed: record.installed,
          ...(request.confirmModifiedReplace === true ? { confirmModifiedReplace: true } : {}),
        })
      } catch (error) {
        await store.upsert(record)
        throw error
      }
      const discovered = await this.options.refreshSkillCatalog(record.scope, root.workspacePath, record.installed.runtimeName, false)
      if (!discovered) throw new TeamSkillHttpError('LOCAL_REFRESH_FAILED', 'DSH 未能移除本地 Team Skill。')
      return { status: 'succeeded', installation: toInstallationView(next) }
    } catch (error) {
      return failureOf(error)
    }
  }

  /** Install one server-authorized immutable Skill into a DSH root selected by scope.
   * @param request - Skill, scope and local dependency preflight data.
   * @returns Final explicit installation result.
   */
  async install(request: TeamSkillInstallRequest): Promise<TeamSkillInstallResult> {
    const localRoot = this.localRoot(request.scope, request.workspaceId)
    if ('status' in localRoot) return localRoot
    if (this.options.stateDirectory === undefined) return missing(['stateDirectory'])
    const stateDirectory = this.options.stateDirectory
    const store = this.store(stateDirectory)
    if (this.options.refreshSkillCatalog === undefined) return missing(['refreshSkillCatalog'])
    const refreshSkillCatalog = this.options.refreshSkillCatalog
    const localInstallationId = randomUUID()
    let eventSequence = 0
    // Stage evidence (§11.14): a stage is recorded only after it actually
    // completed, so an unrun stage is never reported as successful.
    const succeededStages = new Map<TeamSkillInstallStage, string>()
    let runningStage: Exclude<TeamSkillInstallStage, 'rollback'> = 'authorization'
    let rollbackAttempted = false
    let rollbackOutcome: TeamSkillInstallStageOutcome = 'skipped'
    let rollbackDetail = ''
    const result = await this.authorizedRequest(async (client): Promise<TeamSkillInstallResult> => {
      let operationId: string | undefined
      let rollbackDirectory: string | undefined
      try {
        const authorized = await client.createInstallation({
          skillId: request.skillId,
          version: request.version,
          projectId: request.projectId,
          scope: request.scope,
          localInstallationId,
          environment: request.environment,
        })
        operationId = authorized.operationId
        succeededStages.set('authorization', `服务端已授权 ${request.skillId}@${request.version} 的安装。`)
        succeededStages.set('precheck', '本地作用域与依赖预检已通过。')
        runningStage = 'download'
        await this.report(client, operationId, ++eventSequence, 'downloading')
        const archive = await client.download(authorized.artifact.downloadUrl)
        succeededStages.set('download', '制品已下载。')
        runningStage = 'verify'
        await this.report(client, operationId, ++eventSequence, 'verifying')

        const current = (await store.list()).find(record =>
          samePhysicalCopy(record, request.scope, request.workspaceId, request.skillId),
        )
        rollbackDirectory =
          current?.installed.state === 'normal'
            ? await snapshotManagedCopy(current.installed.directory, stateDirectory)
            : undefined
        await this.report(client, operationId, ++eventSequence, 'writing')
        const installed = await installTeamSkill({
          scopeRoot: localRoot.root,
          runtimeName: authorized.runtimeName,
          version: authorized.version,
          archive,
          expectedSha256: authorized.artifact.sha256,
          expectedFileDigests: authorized.artifact.files,
          ...(current === undefined ? {} : { current: current.installed }),
          ...(request.confirmModifiedReplace === true ? { confirmModifiedReplace: true } : {}),
        })
        succeededStages.set('verify', '制品 ZIP、文件清单与 SHA-256 校验通过。')
        runningStage = 'write'
        // A physical copy lives at one scope root. Keep the exact records changed by
        // ownership transfer so every later failure can restore the pre-install state.
        const superseded: TeamSkillInstallationRecord[] = []
        let installation: TeamSkillInstallationRecord
        try {
          for (const record of await store.list()) {
            if (record.installed.state !== 'normal' || !samePhysicalCopy(record, request.scope, request.workspaceId, request.skillId))
              continue
            superseded.push(record)
            await store.upsert(
              Object.freeze({ ...record, installed: Object.freeze({ ...record.installed, state: 'uninstalled' }) }),
            )
          }
          installation = Object.freeze({
            localInstallationId,
            skillId: authorized.skillId,
            projectId: request.projectId,
            scope: request.scope,
            ...(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }),
            installed,
            installedAt: new Date().toISOString(),
          })
          await store.upsert(installation)
          succeededStages.set('write', '制品已写入本地作用域并落盘安装记录。')
        } catch (error) {
          rollbackAttempted = true
          await uninstallTeamSkill({ installed })
          await restoreSnapshot(rollbackDirectory, installed.directory)
          for (const record of superseded)
            await store.upsert(record)
          rollbackOutcome = 'succeeded'
          rollbackDetail = '写入或记录落盘失败：已移除本次副本并恢复被取代的旧记录。'
          throw error
        }
        runningStage = 'discovery'
        await this.report(client, operationId, ++eventSequence, 'refreshing')
        let discovered: boolean
        try {
          discovered = await refreshSkillCatalog(request.scope, localRoot.workspacePath, authorized.runtimeName)
        } catch (error) {
          rollbackAttempted = true
          await uninstallTeamSkill({ installed })
          await restoreSnapshot(rollbackDirectory, installed.directory)
          await store.remove(localInstallationId)
          for (const record of superseded)
            await store.upsert(Object.freeze({ ...record, installed: Object.freeze({ ...record.installed, state: 'normal' }) }))
          rollbackOutcome = 'succeeded'
          rollbackDetail = '运行时发现阶段抛错：已移除本次副本、删除新记录并恢复被取代的旧记录。'
          throw error
        }
        if (!discovered) {
          // 可重入补偿：discovery 未确认时回滚本次安装——移除磁盘副本、删除新记录、
          // 恢复被取代的旧记录，重试安装会得到唯一确定的干净状态。
          rollbackAttempted = true
          await uninstallTeamSkill({ installed })
          await restoreSnapshot(rollbackDirectory, installed.directory)
          await store.remove(localInstallationId)
          for (const record of superseded) {
            await store.upsert(Object.freeze({ ...record, installed: Object.freeze({ ...record.installed, state: 'normal' }) }))
          }
          rollbackOutcome = 'succeeded'
          rollbackDetail = '运行时未发现本次安装：已移除副本、删除新记录并恢复被取代的旧记录。'
          throw new TeamSkillHttpError('LOCAL_REFRESH_FAILED', 'DSH did not discover the installed Team Skill.')
        }
        succeededStages.set('discovery', 'DSH 已确认发现并加载该 Skill。')
        await removeSnapshot(rollbackDirectory)
        await this.report(client, operationId, ++eventSequence, 'succeeded')
        return {
          status: 'succeeded',
          installation: toInstallationView(installation),
          stages: buildInstallStages({
            succeeded: succeededStages,
            failedStage: null,
            failedDetail: '',
            rollback: rollbackOutcome,
            rollbackDetail,
          }),
          failedStage: null,
          retryable: { retryable: false, how: '安装已完成，无需重试。' },
        }
      } catch (error) {
        await removeSnapshot(rollbackDirectory)
        const failure = failureOf(error)
        // A rollback that threw leaves the attempt recorded but not completed: the
        // stage is `failed`, never `skipped`, so a partial rollback is visible.
        if (rollbackAttempted && rollbackOutcome !== 'succeeded') {
          rollbackOutcome = 'failed'
        }
        if (operationId !== undefined) {
          try {
            await this.report(client, operationId, ++eventSequence, 'failed', failure.code)
          } catch {
            // The original operation failure remains the user-visible cause.
          }
        }
        const classified = classifyInstallFailure(failure.code, runningStage)
        return {
          ...failure,
          failedStage: classified.stage,
          retryable: classified.retryable,
          stages: buildInstallStages({
            succeeded: succeededStages,
            failedStage: classified.stage,
            failedDetail: failure.message,
            rollback: rollbackOutcome,
            rollbackDetail,
          }),
        }
      }
    })
    // The request layer answers session and transport failures without stage
    // evidence; attribute them to authorization so every failed install carries
    // the same seven-stage explanation (§11.14).
    if (result.status === 'failed' && !('stages' in result)) {
      const classified = classifyInstallFailure(result.code, 'authorization')
      return {
        ...result,
        failedStage: classified.stage,
        retryable: classified.retryable,
        stages: buildInstallStages({
          succeeded: succeededStages,
          failedStage: classified.stage,
          failedDetail: result.message,
          rollback: rollbackOutcome,
          rollbackDetail,
        }),
      }
    }
    return result
  }

  /**
   * Build the static-token service client.
   *
   * `authorizedRequest` - the only caller - enters here when the configured
   * access token exists or when no credential service is configured, so the
   * account-session resolution it owns (and the refresh-on-expiry it performs)
   * is never this method's job: a stored grant is resolved there, not here.
   */
  private client(): TeamSkillHttpClient | TeamSkillNotReady | TeamSkillFailed {
    const apiBaseUrl = this.options.apiBaseUrl
    const accessToken = this.options.accessToken
    if (apiBaseUrl === undefined || apiBaseUrl.length === 0 || accessToken === undefined || accessToken.length === 0) {
      return missing([
        ...(apiBaseUrl === undefined || apiBaseUrl.length === 0 ? ['apiBaseUrl'] : []),
        ...(accessToken === undefined || accessToken.length === 0 ? ['accessToken'] : []),
      ])
    }
    return new TeamSkillHttpClient({
      apiBaseUrl,
      accessToken,
      ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
    })
  }

  private accountClient(): TeamSkillAccountHttpClient | TeamSkillNotReady {
    if (this.options.apiBaseUrl === undefined || this.options.apiBaseUrl.length === 0) return missing(['apiBaseUrl'])
    return new TeamSkillAccountHttpClient({
      apiBaseUrl: this.options.apiBaseUrl,
      ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
    })
  }

  private async accountMutationContext(): Promise<
    { readonly client: TeamSkillAccountHttpClient; readonly session: AccountGrant }
    | TeamSkillNotReady
    | { readonly status: 'signed-out' }
  > {
    const client = this.accountClient()
    if ('status' in client) return client
    if (this.options.credentials === undefined) return missing(['credentials'])
    const session = await this.readAccountSession()
    if (session === undefined) return { status: 'signed-out' }
    return { client, session }
  }

  private async installationContext(projectId: string): Promise<
    {
      readonly records: readonly TeamSkillInstallationRecord[]
      readonly statuses: Awaited<ReturnType<TeamSkillHttpClient['releaseStatus']>>
    }
    | TeamSkillNotReady
    | TeamSkillFailed
    | { readonly status: 'signed-out' }
  > {
    if (this.options.stateDirectory === undefined) return missing(['stateDirectory'])
    const store = this.store(this.options.stateDirectory)
    try {
      const records = (await store.list()).filter(record => record.projectId === projectId)
      if (records.length === 0) return { records: Object.freeze([]), statuses: Object.freeze([]) }
      const statuses = await this.authorizedRequest(async client =>
        client.releaseStatus(
          records.map(record => ({ projectId: record.projectId, skillId: record.skillId, version: record.installed.version })),
        ),
      )
      if (isTerminalResult(statuses)) return statuses
      return { records, statuses }
    } catch (error) {
      return failureOf(error)
    }
  }

  private async readAccountSession(): Promise<AccountGrant | undefined> {
    const credentials = this.options.credentials
    if (credentials === undefined) return undefined
    const record = await credentials.readRecord(ACCOUNT_CREDENTIAL_KEY)
    if (record === undefined) return undefined
    if (record.kind !== 'grant' || !isAccountGrant(record.payload))
      throw new TeamSkillHttpError('CREDENTIALS_INVALID', 'DSH 账号授权记录无效。')
    return record.payload
  }

  private async writeAccountSession(session: TeamSkillAccountSessionResponse): Promise<void> {
    // Every caller reaches this method through a path that already required the
    // credential service - login, `accountMutationContext` and `refreshSession`'s
    // account path all prove it before they get here - so the contract, not a
    // runtime check that cannot fail, is what guarantees the provider exists.
    const credentials = this.options.credentials as CredentialProvider
    const payload: AccountGrant = {
      userId: session.user.userId,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresAt: Date.now() + session.expiresIn * 1000,
    }
    await credentials.modifyRecord(ACCOUNT_CREDENTIAL_KEY, () => Promise.resolve({ kind: 'grant', payload }))
  }

  private async clearAccountSession(): Promise<void> {
    await this.options.credentials?.deleteRecord(ACCOUNT_CREDENTIAL_KEY)
  }

  private async clearAccountSessionIfCurrent(expected: AccountGrant): Promise<void> {
    const current = await this.readAccountSession()
    if (current?.accessToken === expected.accessToken && current.refreshToken === expected.refreshToken)
      await this.clearAccountSession()
  }

  private async refreshSession(
    client: TeamSkillAccountHttpClient,
    session: AccountGrant,
    force = false,
  ): Promise<AccountGrant> {
    if (!force) {
      const current = await this.readAccountSession()
      if (current !== undefined && current.refreshToken !== session.refreshToken) return current
    }
    const existing = this.refreshInFlight.get(session.refreshToken)
    if (existing !== undefined) return existing
    const pending = (async (): Promise<AccountGrant> => {
      try {
        const current = await this.readAccountSession()
        if (!force && current !== undefined && current.refreshToken !== session.refreshToken) return current
        const refreshed = await client.refresh(session.refreshToken)
        const next: AccountGrant = {
          userId: refreshed.user.userId,
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          expiresAt: Date.now() + refreshed.expiresIn * 1000,
        }
        const latest = await this.readAccountSession()
        if (latest !== undefined && latest.refreshToken !== session.refreshToken) return latest
        await this.writeAccountSession(refreshed)
        return next
      } catch (error) {
        await this.clearAccountSessionIfCurrent(session)
        throw error
      } finally {
        this.refreshInFlight.delete(session.refreshToken)
      }
    })()
    this.refreshInFlight.set(session.refreshToken, pending)
    return pending
  }

  private async accountRequest<T>(
    client: TeamSkillAccountHttpClient,
    session: AccountGrant,
    operation: (accessToken: string) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted()
    try {
      if (session.expiresAt <= Date.now() + 30_000) {
        const refreshed = await this.refreshSession(client, session)
        signal?.throwIfAborted()
        return await operation(refreshed.accessToken)
      }
      return await operation(session.accessToken)
    } catch (error) {
      if (!(error instanceof TeamSkillHttpError) || !isExpiredTokenCode(error.code)) throw error
      signal?.throwIfAborted()
      const refreshed = await this.refreshSession(client, session)
      signal?.throwIfAborted()
      return await operation(refreshed.accessToken)
    }
  }

  private async authorizedRequest<T>(
    operation: (client: TeamSkillHttpClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T | TeamSkillNotReady | TeamSkillFailed | { readonly status: 'signed-out' }> {
    signal?.throwIfAborted()
    if (this.options.accessToken !== undefined || this.options.credentials === undefined) {
      const client = this.client()
      if ('status' in client) return client
      try {
        return await operation(client)
      } catch (error) {
        return failureOf(error)
      }
    }
    const accountClient = this.accountClient()
    if ('status' in accountClient) return accountClient
    // `accountClient()` answers a missing endpoint with not-ready, so the base URL
    // the token-carrying client below needs is already proven by the line above.
    const apiBaseUrl = this.options.apiBaseUrl as string
    const session = await this.readAccountSession()
    if (session === undefined) return { status: 'signed-out' }
    try {
      return await this.accountRequest(
        accountClient,
        session,
        accessToken =>
          operation(
            new TeamSkillHttpClient({
              apiBaseUrl,
              accessToken,
              ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
            }),
          ),
        signal,
      )
    } catch (error) {
      if (error instanceof TeamSkillHttpError && isExpiredTokenCode(error.code)) {
        await this.clearAccountSession()
        return { status: 'signed-out' }
      }
      return failureOf(error)
    }
  }

  /**
   * The durable installation store for one state root.
   *
   * The directory is a parameter rather than a re-read of the configuration:
   * every caller resolves it (and answers `not-ready` without it) before it
   * reaches the store, so the type carries the requirement instead of a runtime
   * check that can never fire.
   */
  private store(stateDirectory: string): TeamSkillInstallationStoreLike {
    return this.options.installationStore ?? new TeamSkillInstallationStore(stateDirectory)
  }

  private localRoot(
    scope: TeamSkillScope,
    workspaceId: string | undefined,
  ): { readonly root: string; readonly workspacePath?: string } | TeamSkillNotReady {
    if (scope === 'global') {
      if (this.options.globalSkillRoot === undefined) return missing(['globalSkillRoot'])
      return { root: this.options.globalSkillRoot }
    }
    if (workspaceId === undefined || this.options.resolveWorkspace === undefined) return missing(['workspaceId'])
    const workspacePath = this.options.resolveWorkspace(workspaceId)
    if (workspacePath === undefined) return missing(['workspaceId'])
    return { root: join(workspacePath, '.dsh', 'skills'), workspacePath }
  }

  private async report(
    client: TeamSkillHttpClient,
    operationId: string,
    eventSequence: number,
    status: Parameters<TeamSkillHttpClient['reportOperationEvent']>[2],
    errorCode?: string,
  ): Promise<void> {
    await client.reportOperationEvent(operationId, eventSequence, status, errorCode)
  }
}

async function restoreMovedCopy(sourceDirectory: string, destinationDirectory: string): Promise<void> {
  await mkdir(dirname(destinationDirectory), { recursive: true, mode: 0o700 })
  await rename(sourceDirectory, destinationDirectory)
}

async function snapshotManagedCopy(sourceDirectory: string, stateDirectory: string): Promise<string> {
  const destination = join(stateDirectory, 'rollback', randomUUID())
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  await cp(sourceDirectory, destination, { recursive: true, force: false, errorOnExist: true })
  return destination
}

async function restoreSnapshot(snapshot: string | undefined, destination: string): Promise<void> {
  if (snapshot === undefined) return
  await rm(destination, { recursive: true, force: true })
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  await rename(snapshot, destination)
}

async function removeSnapshot(snapshot: string | undefined): Promise<void> {
  if (snapshot !== undefined) await rm(snapshot, { recursive: true, force: true })
}

function missing(fields: readonly string[]): TeamSkillNotReady {
  return Object.freeze({ status: 'not-ready', missing: Object.freeze([...fields]) })
}

function accountState(session: TeamSkillAccountSessionResponse): TeamSkillAccountState {
  return { status: 'authenticated', user: session.user, memberships: session.memberships, mustChangePassword: session.mustChangePassword }
}

function isAccountGrant(value: unknown): value is AccountGrant {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.userId === 'string' &&
    record.userId.length > 0 &&
    typeof record.accessToken === 'string' &&
    record.accessToken.length > 0 &&
    typeof record.refreshToken === 'string' &&
    record.refreshToken.length > 0 &&
    typeof record.expiresAt === 'number' &&
    Number.isFinite(record.expiresAt)
  )
}

function isExpiredTokenCode(code: string): boolean {
  return code === 'AUTH_REQUIRED' || code === 'UNAUTHORIZED' || code === 'TOKEN_EXPIRED' || code === 'TOKEN_REVOKED'
}

function failureOf(error: unknown): TeamSkillFailed {
  // The service request id is the operator's handle for evidence lookup, so a
  // service-reported failure carries it instead of dropping it at the boundary.
  if (error instanceof TeamSkillHttpError) {
    return Object.freeze({
      status: 'failed',
      code: error.code,
      message: error.message,
      ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
    })
  }
  if (error instanceof TeamSkillInstallError) {
    return Object.freeze({ status: 'failed', code: error.code, message: error.message })
  }
  return Object.freeze({
    status: 'failed',
    code: 'LOCAL_OPERATION_FAILED',
    message: error instanceof Error ? error.message : 'Team Skill local operation failed.',
  })
}

function isKnowledgeFailure(
  value: unknown,
): value is TeamSkillNotReady | TeamSkillFailed | { readonly status: 'signed-out' } {
  if (typeof value !== 'object' || value === null || !('status' in value)) return false
  const status = (value as { readonly status?: unknown }).status
  return status === 'not-ready' || status === 'failed' || status === 'signed-out'
}

/** Narrow an authorized-request outcome to its explicit failure, unconfigured, or signed-out states. */
function isTerminalResult(value: unknown): value is TeamSkillNotReady | TeamSkillFailed | { readonly status: 'signed-out' } {
  return isKnowledgeFailure(value)
}

/** One managed physical copy per scope root; the record is whichever project's authorization last wrote it. */
function samePhysicalCopy(
  record: TeamSkillInstallationRecord,
  scope: TeamSkillScope,
  workspaceId: string | undefined,
  skillId: string,
): boolean {
  return record.skillId === skillId && record.scope === scope && record.workspaceId === workspaceId
}

/** Remove Host-private filesystem metadata before crossing the typed Remote. */
function toInstallationView(record: TeamSkillInstallationRecord): TeamSkillInstallationView {
  return Object.freeze({
    localInstallationId: record.localInstallationId,
    skillId: record.skillId,
    projectId: record.projectId,
    scope: record.scope,
    ...(record.workspaceId === undefined ? {} : { workspaceId: record.workspaceId }),
    runtimeName: record.installed.runtimeName,
    version: record.installed.version,
    artifactSha256: record.installed.artifactSha256,
    state: record.installed.state,
    installedAt: record.installedAt,
  })
}
