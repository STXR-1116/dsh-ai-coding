/** Cordis and Typert projection for Host-owned Team Skill operations. */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-skill'
import { STATIC_TOKEN_PARTITION, TeamSkillHost } from './host.ts'
import type {
  TeamSkillCatalogResult,
  TeamSkillAccessSummary,
  TeamSkillAccountResult,
  TeamSkillAccountState,
  TeamSkillChangePasswordRequest,
  TeamSkillInstallRequest,
  TeamSkillInstallResult,
  TeamSkillInstallationView,
  TeamSkillLoginRequest,
  TeamSkillNotReady,
  TeamSkillFailed,
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
import { TeamSkillKnowledgeLoop } from './knowledge-loop.ts'
import type { TeamSkillKnowledgeSelection } from './knowledge-loop.ts'
import { TeamSkillMemoryLoop } from './memory-loop.ts'
import { CollectorController, TeamSkillTelemetryBackend } from './telemetry/backend.ts'
import type { CollectorSnapshot } from './types.ts'
import { TelemetryQueue, TelemetryStorageError } from './telemetry/queue.ts'
import { TelemetryReporter } from './telemetry/reporter.ts'
import { resolveTelemetrySettings } from './telemetry/settings.ts'
import type { CollectorResult, TelemetryQueueSettings } from './types.ts'

/** Bounded window for confirming that the runtime catalog reflects a just-written copy. */
const SKILL_DISCOVERY_CONFIRM_TIMEOUT_MS = 5_000

/** Poll interval inside the discovery confirmation window. */
const SKILL_DISCOVERY_CONFIRM_INTERVAL_MS = 100

/** Deployment-owned collector queue settings for the AI Coding profile. */
export interface TelemetryCollectorConfig {
  readonly maxEvents?: number
  readonly maxBytes?: number
  readonly batchMaxEvents?: number
  readonly batchMaxBytes?: number
  readonly flushIntervalMs?: number
  readonly httpTimeoutMs?: number
  readonly maxAttempts?: number
  readonly retentionMs?: number
  readonly claimTimeoutMs?: number
}

/** Deployment-owned Team Skill Host configuration. */
export interface Config {
  /** AI Coding service API base URL including `/v1`; absent produces `not-ready`. */
  readonly apiBaseUrl?: string
  /** OIDC token kept in the Host configuration; absent produces `not-ready`. */
  readonly accessToken?: string
  /** Host-only data root for installation records and quarantined content. */
  readonly stateDirectory: string
  /** Native DSH global Skill discovery directory. */
  readonly globalSkillRoot: string
  /** Collector queue settings; every omitted field uses the validated default. */
  readonly telemetry?: TelemetryCollectorConfig
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host-owned Team Skill operations projected to browser clients through Typert. */
    teamSkills: TeamSkillGateway
  }
}

/** Host service that exposes Team Skill operations through the typed Remote gateway. */
export class TeamSkillGateway extends TypertRemoteService {
  static inject = ['skills', 'workspaceRegistry', 'agents', 'sessions']

  static Config: Schema<Config> = z.object({
    apiBaseUrl: z.string(),
    accessToken: z.string(),
    stateDirectory: z.string().required(),
    globalSkillRoot: z.string().required(),
    telemetry: z.object({
      maxEvents: z.number(),
      maxBytes: z.number(),
      batchMaxEvents: z.number(),
      batchMaxBytes: z.number(),
      flushIntervalMs: z.number(),
      httpTimeoutMs: z.number(),
      maxAttempts: z.number(),
      retentionMs: z.number(),
      claimTimeoutMs: z.number(),
    }),
  })

  private readonly host: TeamSkillHost
  private readonly knowledgeSelections = new WeakMap<Agent, TeamSkillKnowledgeSelection>()
  private readonly knowledgeLoop: TeamSkillKnowledgeLoop
  private readonly memoryProjects = new WeakMap<Agent, string>()
  private readonly memoryLoop: TeamSkillMemoryLoop
  private readonly collector: CollectorController
  private collectorBackend: TeamSkillTelemetryBackend | undefined
  private readonly collectorSettings: TelemetryQueueSettings
  private readonly collectorStaticPartition: string | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx, 'teamSkills')
    const credentials = ctx.get('credentials')
    this.host = new TeamSkillHost({
      ...(config.apiBaseUrl === undefined ? {} : { apiBaseUrl: config.apiBaseUrl }),
      ...(config.accessToken === undefined ? {} : { accessToken: config.accessToken }),
      stateDirectory: config.stateDirectory,
      globalSkillRoot: config.globalSkillRoot,
      ...(credentials === undefined ? {} : { credentials }),
      resolveWorkspace: workspaceId => ctx.workspaceRegistry.get(WorkspaceId(workspaceId))?.path,
      // Confirming discovery is a handshake with an asynchronously updated
      // on-disk catalog: the provider reads the installation root and the
      // registry caches its collected catalog by revision, so the first read
      // after the Host writes a copy can still miss it. Poll within a bounded
      // window instead of reading once; a root that never reports the expected
      // presence still fails.
      refreshSkillCatalog: async (_scope, workspacePath, runtimeName, expectedPresent = true) => {
        const deadline = Date.now() + SKILL_DISCOVERY_CONFIRM_TIMEOUT_MS
        for (;;) {
          const names = (
            await ctx.skills.list(...(workspacePath === undefined ? [] : [{ cwd: workspacePath }]))
          ).map(skill => skill.name)
          if (names.includes(runtimeName) === expectedPresent) return true
          if (Date.now() >= deadline) return false
          await new Promise(resolve => setTimeout(resolve, SKILL_DISCOVERY_CONFIRM_INTERVAL_MS))
        }
      },
    })
    this.collectorSettings = resolveTelemetrySettings(config.telemetry)
    this.collectorStaticPartition = config.accessToken !== undefined && config.accessToken.length > 0 ? STATIC_TOKEN_PARTITION : undefined
    this.collector = this.buildCollector(ctx, config)
    this.collectorBackend?.setAccount({ status: 'signed-out' })
    this.refreshCollectorAccount()
    this.knowledgeLoop = new TeamSkillKnowledgeLoop(ctx, {
      resolveSelection: agent => this.knowledgeSelections.get(agent),
      search: (request, signal) =>
        this.host.knowledgeSearch(request, signal).then((result) => {
          if (result.status === 'ready') return result
          return result
        }),
    })
    this.memoryLoop = new TeamSkillMemoryLoop(ctx, {
      resolveProject: agent => this.memoryProjects.get(agent),
      recall: (request, signal) =>
        this.host.memoryRecall(request, signal).then((result) => {
          if (isMemoryRecallResponse(result)) return result
          if ('status' in result && result.status === 'failed')
            return {
              status: 'UNAVAILABLE',
              items: [],
              contextText: '',
              strategy: 'unavailable',
              effectivePolicy: { topK: 0, relevanceThreshold: 1, tokenBudget: 0 },
            }
          return {
            status: 'PROJECT_REQUIRED',
            items: [],
            contextText: '',
            strategy: 'not-ready',
            effectivePolicy: { topK: 0, relevanceThreshold: 1, tokenBudget: 0 },
          }
        }),
      capture: (request, idempotencyKey) =>
        this.host.memoryCapture(request, idempotencyKey).then((result) => {
          if (isMemoryMutation(result)) return result
          return result
        }),
    })
    ctx.on('agent/disposed', ({ agent }) => {
      this.knowledgeSelections.delete(agent)
      this.memoryProjects.delete(agent)
      this.collectorBackend?.clearProject(String(agent.session.id))
    })
    ctx.effect(
      () => () => {
        this.knowledgeLoop.dispose()
        this.memoryLoop.dispose()
      },
      'ai-coding-platform: knowledge and memory loops',
    )
    // 构造期注册销毁 effect，并保留 Cordis 返回的 disposer：fiber 卸载或显式
    // 调用都会触发同一销毁路径（Cordis disposer 双调幂等）。
    this.collectorDisposeEffect = ctx.effect(
      () => async () => {
        await this.disposeCollector()
      },
      'ai-coding-platform: telemetry queue close',
    )
  }

  /**
   * Assemble the single collector pipeline: durable queue, background
   * reporter, and the one `sessionTelemetry` backend. A queue that cannot be
   * opened or validated leaves the collector in `storage-error` mode instead
   * of silently dropping the feature or rebuilding local state.
   */
  private buildCollector(ctx: Context, config: Config): CollectorController {
    try {
      const queue = TelemetryQueue.open(config.stateDirectory, this.collectorSettings)
      this.collectorQueueHandle = queue
      const reporter = new TelemetryReporter(queue, this.collectorSettings, {
        // Without an endpoint the reporter reports `not-ready`; with one, delivery
        // failures come back as explicit outcomes from the Host request layer.
        send:
          config.apiBaseUrl === undefined
            ? undefined
            : (batch, accountId) => this.host.telemetryDeliver(batch, this.collectorSettings.httpTimeoutMs, accountId),
        resolveAccount: async () => {
          const account = await this.host.telemetryAccount()
          if ('userId' in account) return account
          // 仅确认无登录态（signed-out）时才允许静态分区兜底；not-ready（凭据
          // 读取/刷新异常）必须停止并保留队列，绝不改用其他身份发送。
          if (account.status === 'signed-out' && this.collectorStaticPartition !== undefined) {
            return { userId: this.collectorStaticPartition }
          }
          return account
        },
      })
      reporter.start()
      this.collectorBackend = new TeamSkillTelemetryBackend(
        ctx,
        queue,
        reporter,
        (sessionId: string) => ctx.agents.get(SessionId(sessionId)) !== undefined,
      )
      return new CollectorController({ queue, reporter, backend: this.collectorBackend }, [], null)
    } catch (error) {
      const message = error instanceof TelemetryStorageError ? error.message : `telemetry queue unusable: ${String(error)}`
      return CollectorController.storageError(message, [])
    }
  }

  /** Close the telemetry queue after the reporter's final drain; idempotent. */
  async disposeCollector(): Promise<void> {
    if (this.collectorDisposed) return
    this.collectorDisposed = true
    await this.collectorBackend?.shutdown()
    this.collectorQueueHandle?.close()
    this.collectorQueueHandle = undefined
  }

  private collectorDisposed = false

  /** Cordis effect disposer registered at construction; idempotent, awaitable. */
  readonly collectorDisposeEffect: () => Promise<void> | void

  private collectorQueueHandle: import('./telemetry/queue.ts').TelemetryQueue | undefined

  /** Re-read the capture-time account partition and publish it to the collector. */
  private async refreshCollectorAccountAsync(): Promise<void> {
    const backend = this.collectorBackend
    if (backend === undefined) return
    // `telemetryAccount` answers an explicit state for every failure it can hit
    // (no credential service, no record, unreadable credential store), so this
    // path cannot reject and needs no catch.
    const account = await this.host.telemetryAccount()
    if ('userId' in account) {
      backend.setAccount(account)
      return
    }
    // 仅确认无登录态（signed-out）时静态 Token 部署回落到固定本地分区；
    // not-ready（凭据异常）保持停止状态并保留队列。
    backend.setAccount(
      account.status === 'signed-out' && this.collectorStaticPartition !== undefined
        ? { userId: this.collectorStaticPartition }
        : account,
    )
  }

  /** Fire-and-forget account refresh for construction paths that must not await. */
  private refreshCollectorAccount(): void {
    void this.refreshCollectorAccountAsync()
  }

  /**
   * Isolate capture while an authentication request is in flight: the backend
   * account is published as `not-ready` BEFORE the credentials/HTTP operation
   * starts, so events produced during the pending window are written to
   * neither the old partition (no stale-attribution) nor the new one (no
   * premature inheritance). The real state is published by
   * {@link refreshCollectorAccountAsync} once the operation settles.
   */
  private isolateCollectorDuringAuth(): void {
    this.collectorBackend?.setAccount({ status: 'not-ready' })
  }

  /**
   * Select project knowledge bases for one live native DSH session.
   *
   * The caller resolves the agent through the registry, so liveness is already
   * its precondition: a second lookup here can only answer the object it just
   * returned.
   * @param agent - The live agent whose recall selection changes.
   * @param selection - Project and knowledge bases, or an empty selection to clear.
   */
  private setKnowledgeSelection(agent: Agent, selection: TeamSkillKnowledgeSelection): void {
    if (selection.projectId.length === 0 || selection.knowledgeBaseIds.length === 0) {
      this.knowledgeSelections.delete(agent)
      return
    }
    this.knowledgeSelections.set(
      agent,
      Object.freeze({ projectId: selection.projectId, knowledgeBaseIds: Object.freeze([...new Set(selection.knowledgeBaseIds)]) }),
    )
  }

  /**
   * Clear the session-only knowledge selection without touching the Session log.
   * @param agent - The live agent whose selection is dropped; see {@link setKnowledgeSelection}.
   */
  private clearKnowledgeSelectionForAgent(agent: Agent): void {
    this.knowledgeSelections.delete(agent)
  }

  /** Authenticate through the service and persist the session in Host credentials.
   * @param request - Username and password submitted to the service.
   * @returns Browser-safe authenticated account state or an explicit failure.
   */
  @Remote('login')
  async login(request: TeamSkillLoginRequest): Promise<TeamSkillAccountResult<TeamSkillAccountState>> {
    // 挂起窗口先隔离采集：认证未完成前不写旧账号，也不预写新账号。
    this.isolateCollectorDuringAuth()
    const result = await this.host.login(request)
    // 登录/登出/刷新都必须同步发布采集账号变化，避免旧分区继续采集。
    await this.refreshCollectorAccountAsync()
    return result
  }

  /** Read the current browser-safe account state.
   * @returns Current account state or an explicit signed-out or failed state.
   */
  @Remote('account')
  account(): Promise<TeamSkillAccountResult<TeamSkillAccountState>> {
    return this.host.account()
  }

  /** Rotate the current service session.
   * @returns Replacement browser-safe account state or an explicit failure.
   */
  @Remote('refreshAccount')
  async refreshAccount(): Promise<TeamSkillAccountResult<TeamSkillAccountState>> {
    // 挂起窗口先隔离采集：刷新未完成前事件不归属任何账号分区。
    this.isolateCollectorDuringAuth()
    const result = await this.host.refreshAccount()
    await this.refreshCollectorAccountAsync()
    return result
  }

  /** Change the current account password.
   * @param request - Current and replacement password values.
   * @returns Replacement browser-safe account state or an explicit failure.
   */
  @Remote('changePassword')
  changePassword(request: TeamSkillChangePasswordRequest): Promise<TeamSkillAccountResult<TeamSkillAccountState>> {
    return this.host.changePassword(request)
  }

  /** Revoke the current service session and clear Host credentials.
   * @returns Signed-out account state.
   */
  @Remote('logout')
  async logout(): Promise<TeamSkillAccountResult<TeamSkillAccountState>> {
    // 挂起窗口先隔离采集：登出请求未完成前旧账号立即停止采集。
    this.isolateCollectorDuringAuth()
    const result = await this.host.logout()
    await this.refreshCollectorAccountAsync()
    return result
  }

  /** Read the aggregate access summary across all organizations.
   * @returns Server-filtered access or an explicit failure.
   */
  @Remote('accessSummary')
  accessSummary(): Promise<TeamSkillAccountResult<TeamSkillAccessSummary>> {
    return this.host.accessSummary()
  }

  /** Read active projects visible to the authenticated account.
   * @returns Service-authorized project summaries or an explicit failure.
   */
  @Remote('projects')
  projects(): Promise<TeamSkillAccountResult<readonly TeamSkillProject[]>> {
    return this.host.projects()
  }

  /** Read one active project and its authorized asset summaries.
   * @param projectId - Opaque project identity selected by the user.
   * @returns Service-authorized project detail or an explicit failure.
   */
  @Remote('project')
  project(projectId: string): Promise<TeamSkillAccountResult<TeamSkillProjectDetail>> {
    return this.host.project(projectId)
  }

  /** Return the current caller-visible server catalog or an explicit unavailable state.
   * @param projectId - Opaque project identity authorized by the service.
   * @returns Current caller-visible catalog or an explicit unavailable state.
   */
  @Remote('catalog')
  catalog(projectId: string): Promise<TeamSkillCatalogResult> {
    return this.host.catalog(projectId)
  }

  /** Read the current project's knowledge-base summaries.
   * @param projectId - Opaque project identity selected by the user.
   * @returns Server-authoritative knowledge-base summaries or an explicit failure.
   */
  @Remote('knowledgeBases')
  knowledgeBases(projectId: string): Promise<TeamSkillAccountResult<readonly TeamSkillKnowledgeBaseSummary[]>> {
    return this.host.knowledgeBases(projectId)
  }

  /** Search the explicitly selected knowledge bases for one conversation turn.
   * @param request - Project and knowledge-base search request.
   * @returns Server-authoritative search results or an explicit failure.
   */
  @Remote('knowledgeSearch')
  knowledgeSearch(
    request: TeamSkillKnowledgeSearchRequest,
  ): Promise<TeamSkillAccountResult<{ readonly status: 'ready'; readonly response: TeamSkillKnowledgeSearchResponse }>> {
    return this.host.knowledgeSearch(request)
  }

  /** Resolve an authorized knowledge document preview.
   * @param knowledgeBaseId - Opaque knowledge-base identity.
   * @param documentId - Opaque document identity.
   * @returns Server-authoritative preview or an explicit failure.
   */
  @Remote('knowledgePreview')
  knowledgePreview(knowledgeBaseId: string, documentId: string): Promise<TeamSkillAccountResult<TeamSkillKnowledgePreview>> {
    return this.host.knowledgePreview(knowledgeBaseId, documentId)
  }

  /** Recall server-authoritative project memories for one coding request.
   * @param request - Project and query sent to the service.
   * @returns Recall results with explicit service status.
   */
  @Remote('memoryRecall')
  memoryRecall(request: {
    readonly projectId: string
    readonly query: string
  }): Promise<TeamSkillAccountResult<TeamSkillMemoryRecallResponse>> {
    return this.host.memoryRecall(request)
  }

  /** Accept one automatic capture batch after a completed turn.
   * @param request - Project, session, and cleaned transcript messages.
   * @param idempotencyKey - Unique key for this capture attempt.
   * @returns Accepted mutation or an explicit failure.
   */
  @Remote('memoryCapture')
  memoryCapture(
    request: {
      readonly projectId: string
      readonly sessionId: string
      readonly taskId?: string
      readonly messages: readonly { readonly role: 'user' | 'assistant'; readonly content: string }[]
    },
    idempotencyKey: string,
  ): Promise<TeamSkillAccountResult<TeamSkillMemoryMutation>> {
    return this.host.memoryCapture(request, idempotencyKey)
  }

  /** List current project memories using the service cursor.
   * @param request - Project, optional search term, cursor, and page size.
   * @returns Server-authoritative memory page or an explicit failure.
   */
  @Remote('memoryList')
  memoryList(request: {
    readonly projectId: string
    readonly keyword?: string
    readonly cursor?: string
    readonly limit?: number
  }): Promise<TeamSkillAccountResult<TeamSkillMemoryPage>> {
    return this.host.memoryList(request)
  }

  /** Confirm one memory candidate so it joins the recalled, shared tiers (§11.16).
   * @param request - Candidate identity and expected revision.
   * @param idempotencyKey - Unique key for this confirm attempt; forwarded to the service.
   * @returns The updated memory or an explicit revision or authorization failure.
   */
  @Remote('memoryCandidatesConfirm')
  memoryCandidatesConfirm(
    request: { readonly memoryId: string; readonly expectedRevision: number },
    idempotencyKey: string,
  ): Promise<TeamSkillAccountResult<TeamSkillMemory>> {
    return this.host.memoryCandidatesConfirm(request, idempotencyKey)
  }

  /** Read one project-memory detail.
   * @param memoryId - Opaque memory identity.
   * @returns Server-authoritative memory detail or an explicit failure.
   */
  @Remote('memoryGet')
  memoryGet(memoryId: string): Promise<TeamSkillAccountResult<TeamSkillMemory>> {
    return this.host.memoryGet(memoryId)
  }

  /** Update one project-memory body with optimistic revision control.
   * @param request - Memory identity, replacement body, and expected revision.
   * @param idempotencyKey - Unique key for this update attempt; forwarded to the service.
   * @returns Accepted mutation or an explicit revision or authorization failure.
   */
  @Remote('memoryUpdate')
  memoryUpdate(
    request: {
      readonly memoryId: string
      readonly content: string
      readonly expectedRevision: number
    },
    idempotencyKey: string,
  ): Promise<TeamSkillAccountResult<TeamSkillMemoryMutation>> {
    return this.host.memoryUpdate(request, idempotencyKey)
  }

  /** Delete one project-memory record with an idempotency key.
   * @param request - Memory identity and expected revision.
   * @param idempotencyKey - Unique key for this delete attempt.
   * @returns Accepted deletion and cleanup job or an explicit failure.
   */
  @Remote('memoryDelete')
  memoryDelete(
    request: { readonly memoryId: string; readonly expectedRevision: number },
    idempotencyKey: string,
  ): Promise<TeamSkillAccountResult<TeamSkillMemoryMutation>> {
    return this.host.memoryDelete(request, idempotencyKey)
  }

  /** Read project-memory processing jobs.
   * @param projectId - Optional project filter.
   * @returns Server-authoritative jobs or an explicit failure.
   */
  @Remote('memoryJobs')
  memoryJobs(projectId?: string): Promise<TeamSkillAccountResult<readonly TeamSkillMemoryJob[]>> {
    return this.host.memoryJobs(projectId)
  }

  /** Read project-memory governance audit records.
   * @param projectId - Optional project filter.
   * @returns Server-authoritative audit records or an explicit failure.
   */
  @Remote('memoryAudit')
  memoryAudit(projectId?: string): Promise<TeamSkillAccountResult<readonly TeamSkillMemoryAudit[]>> {
    return this.host.memoryAudit(projectId)
  }

  /** Enable session-only knowledge recall for the live agent behind one session id.
   * @param sessionId - Live DSH session identity.
   * @param selection - Project and knowledge bases to use for recall.
   */
  @Remote('configureKnowledgeSelection')
  configureKnowledgeSelection(sessionId: string, selection: TeamSkillKnowledgeSelection): void {
    const agent = this.ctx.agents.get(SessionId(sessionId))
    if (agent === undefined) throw new Error(`session "${sessionId}" is not a live agent`)
    this.setKnowledgeSelection(agent, selection)
  }

  /** Clear session-only knowledge recall for the live agent behind one session id.
   * @param sessionId - Live DSH session identity.
   */
  @Remote('clearKnowledgeSelection')
  clearKnowledgeSelection(sessionId: string): void {
    const agent = this.ctx.agents.get(SessionId(sessionId))
    if (agent === undefined) throw new Error(`session "${sessionId}" is not a live agent`)
    this.clearKnowledgeSelectionForAgent(agent)
  }

  /** Bind automatic project-memory recall and capture to one live session.
   * @param sessionId - Live DSH session identity.
   * @param projectId - Opaque project identity used by automatic memory operations.
   */
  @Remote('configureProjectMemory')
  configureProjectMemory(sessionId: string, projectId: string): void {
    const agent = this.ctx.agents.get(SessionId(sessionId))
    if (agent === undefined) throw new Error(`session "${sessionId}" is not a live agent`)
    if (projectId.length === 0) this.memoryProjects.delete(agent)
    else this.memoryProjects.set(agent, projectId)
  }

  /** Clear automatic project-memory context for one live session.
   * @param sessionId - Live DSH session identity.
   */
  @Remote('clearProjectMemory')
  clearProjectMemory(sessionId: string): void {
    const agent = this.ctx.agents.get(SessionId(sessionId))
    if (agent === undefined) throw new Error(`session "${sessionId}" is not a live agent`)
    this.memoryProjects.delete(agent)
  }

  /** Read the collector pipeline status for the plugin page.
   * @returns Browser-safe pipeline state or an explicit not-ready or failed state.
   */
  @Remote('collectorStatus')
  async collectorStatus(): Promise<CollectorSnapshot> {
    await this.refreshCollectorAccountAsync()
    return this.collector.status()
  }

  /**
   * Bind one live session to its active project for collector capture.
   * Rebinding is authorized against the service before any local state moves:
   * a failed or signed-out check keeps the previous binding untouched, so the
   * A→B switch is atomic from the caller's perspective.
   * @param sessionId - Live DSH session identity.
   * @param projectId - Opaque authorized project identity.
   * @returns The bound project or an explicit not-ready or failed state.
   */
  @Remote('configureCollectorProject')
  async configureCollectorProject(sessionId: string, projectId: string): Promise<CollectorResult<{ readonly projectId: string }>> {
    const agent = this.ctx.agents.get(SessionId(sessionId))
    if (agent === undefined) return { status: 'failed', code: 'SESSION_NOT_LIVE', message: `会话 "${sessionId}" 不是存活的 Agent。` }
    const backend = this.collectorBackend
    if (backend === undefined) {
      // 没有后端只可能是构造期打不开队列。控制器的 status() 只有两种答案——
      // ready（含 storage-error 模式）与 not-ready——没有 failed 变体，所以这里
      // 如实报「缺遥测存储」，而不是把不可能出现的失败快照转出去。
      return { status: 'not-ready', missing: ['telemetryStorage'] }
    }
    await this.refreshCollectorAccountAsync()
    if (projectId.length === 0) {
      backend.clearProject(sessionId)
      return { status: 'ready', value: { projectId: '' } }
    }
    // 远程调用可绕过 UI 直接换绑：先经服务端确认当前账号对该项目仍然授权，
    // 确认失败时保持原绑定，A→B 换绑要么完整生效要么完全不动。
    const authorization = await this.host.project(projectId)
    if ('project' in authorization) {
      backend.configureProject(sessionId, projectId)
      return { status: 'ready', value: { projectId } }
    }
    if (authorization.status === 'not-ready') {
      return { status: 'not-ready', missing: authorization.missing }
    }
    if (authorization.status === 'signed-out') {
      return { status: 'failed', code: 'ACCOUNT_SIGNED_OUT', message: '当前没有登录态账号，无法换绑采集项目。' }
    }
    return {
      status: 'failed',
      code: 'PROJECT_NOT_AUTHORIZED',
      message: `当前账号未获项目 "${projectId}" 授权，采集绑定保持不变。`,
    }
  }

  /** Clear the collector project binding of one live session.
   * @param sessionId - Live DSH session identity.
   * @returns An explicit ready or failed state.
   */
  @Remote('clearCollectorProject')
  clearCollectorProject(sessionId: string): Promise<CollectorResult<{ readonly cleared: true }>> {
    const agent = this.ctx.agents.get(SessionId(sessionId))
    if (agent === undefined) {
      return Promise.resolve({ status: 'failed', code: 'SESSION_NOT_LIVE', message: `会话 "${sessionId}" 不是存活的 Agent。` })
    }
    this.collectorBackend?.clearProject(sessionId)
    return Promise.resolve({ status: 'ready', value: { cleared: true } })
  }

  /** Pause collector capture and delivery, keeping the queue.
   * @returns The paused pipeline state.
   */
  @Remote('pauseCollector')
  pauseCollector(): Promise<CollectorSnapshot> {
    return Promise.resolve(this.collector.pause())
  }

  /** Resume collector capture and delivery.
   * @returns The resumed pipeline state.
   */
  @Remote('resumeCollector')
  resumeCollector(): Promise<CollectorSnapshot> {
    return Promise.resolve(this.collector.resume())
  }

  /** Start an immediate asynchronous flush without waiting for the network.
   * @returns The pipeline state at flush start.
   */
  @Remote('flushCollector')
  flushCollector(): Promise<CollectorSnapshot> {
    return Promise.resolve(this.collector.flush())
  }

  /** Delete all unreported collector data after user confirmation, recording a manual-clear gap.
   * @returns The post-clear pipeline state or an explicit failure.
   */
  @Remote('clearPendingCollectorData')
  async clearPendingCollectorData(): Promise<CollectorSnapshot> {
    await this.refreshCollectorAccountAsync()
    return this.collector.clearPending()
  }

  /** Return local copies managed by this Host, or an explicit signed-out or local-state error.
   * @param projectId - Opaque project identity reauthorized by the service.
   * @returns Browser-safe local copies or an explicit signed-out or local-state error.
   */
  @Remote('installations')
  installations(
    projectId: string,
  ): Promise<readonly TeamSkillInstallationView[] | TeamSkillNotReady | TeamSkillFailed | { readonly status: 'signed-out' }> {
    return this.host.installations(projectId)
  }

  /** Synchronize local copies against server release state and isolate withdrawals.
   * @param projectId - Opaque project identity reauthorized by the service.
   * @returns Updated local copies or an explicit signed-out, unavailable, or failed state.
   */
  @Remote('syncReleaseStatus')
  syncReleaseStatus(
    projectId: string,
  ): Promise<readonly TeamSkillInstallationView[] | TeamSkillNotReady | TeamSkillFailed | { readonly status: 'signed-out' }> {
    return this.host.syncReleaseStatus(projectId)
  }

  /** Read one published release's trust card before the user installs it.
   * @param request - Skill identity, immutable version and the authorizing project.
   * @returns Trust card or an explicit signed-out, unavailable, or failed state.
   */
  @Remote('trustCard')
  trustCard(request: {
    readonly skillId: string
    readonly version: string
    readonly projectId: string
  }): Promise<TeamSkillTrustCard | TeamSkillNotReady | TeamSkillFailed | { readonly status: 'signed-out' }> {
    return this.host.trustCard(request)
  }

  /**
   * Authorize, download, verify, install and discover one Team Skill without
   * allowing the browser to write a local path.
   * @param request - Opaque Skill, scope and local dependency preflight data.
   * @returns Final explicit operation result.
   */
  @Remote('installSkill')
  install(request: TeamSkillInstallRequest): Promise<TeamSkillInstallResult> {
    return this.host.install(request)
  }

  /** Remove one Host-managed local copy and refresh native DSH discovery.
   * @param request - Opaque local installation identity and scope.
   * @returns Final explicit uninstall result.
   */
  @Remote('uninstallSkill')
  uninstall(request: TeamSkillUninstallRequest): Promise<TeamSkillUninstallResult> {
    return this.host.uninstall(request)
  }
}

export default TeamSkillGateway

function isMemoryRecallResponse(value: unknown): value is TeamSkillMemoryRecallResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    ['READY', 'PARTIAL', 'UNAVAILABLE', 'PROJECT_REQUIRED'].includes((value as { status?: unknown }).status as string)
  )
}

function isMemoryMutation(value: unknown): value is TeamSkillMemoryMutation {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    ['PENDING', 'INDEX_PENDING'].includes((value as { status?: unknown }).status as string)
  )
}
