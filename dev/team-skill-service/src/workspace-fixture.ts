import { createHash, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AccountPrincipal, AccountStore } from './account-store.ts'

/**
 * Deterministic cloud-workspace fixture for the plugin, Host and admin closed-loop
 * checks. It simulates the `/v1` cloud workspace surface over real HTTP: agent types
 * and profiles, workspace lifecycle, remote file reads, previews, changes, runs,
 * replayable SSE and unified audit rows. Every response carries `x-fixture-only`;
 * nothing here proves production behavior (no real container, runtime, Git provider,
 * agent execution or durable audit).
 */

export type WorkspaceStatus =
  | 'draft'
  | 'provisioning'
  | 'starting'
  | 'ready'
  | 'degraded'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'archived'
  | 'deleting'

export type RunStatus =
  | 'preparing'
  | 'awaiting_approval'
  | 'running'
  | 'paused'
  | 'awaiting_user'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'expired'

/** One server-declared type-extension field: the admin form renders from it, writes validate against it. */
interface AgentSchemaField {
  readonly key: string
  readonly label: string
  readonly type: 'string' | 'number' | 'boolean' | 'enum'
  readonly required: boolean
  readonly affectsPublish: boolean
  readonly description: string | null
  readonly enumValues: readonly string[]
  readonly minValue: number | null
  readonly maxValue: number | null
  readonly defaultValue: string | number | boolean | null
}

interface AgentTypeRecord {
  readonly agentTypeId: string
  readonly key: string
  readonly name: string
  readonly capabilities: readonly string[]
  readonly readiness: 'ready' | 'degraded' | 'unavailable'
  readonly schemaVersion: string
  readonly schema: readonly AgentSchemaField[]
  /** 该类型的版本发布是否必须携带已就绪的凭据引用（credential_ref 可为 null 的类型为 false）。 */
  readonly credentialRequired: boolean
}

/** One immutable team-asset reference on a version; `required` is always explicit. */
interface AgentBindingRecord {
  readonly reference: string
  readonly required: boolean
}

/** Provider credential reference summary; never carries secret material. */
interface AgentCredentialRefRecord {
  readonly name: string
  readonly kind: string
  readonly authorized: boolean
  readonly readiness: 'ready' | 'degraded' | 'unavailable'
}

interface AgentProfileVersionRecord {
  readonly agentProfileVersionId: string
  readonly version: string
  status: 'draft' | 'published' | 'archived'
  readonly model: string
  readonly reasoning: string
  skills: readonly AgentBindingRecord[]
  knowledgeBases: readonly AgentBindingRecord[]
  memory: AgentBindingRecord | null
  readonly executionPolicy: Record<string, unknown>
  readonly typeExtensionConfig: Record<string, unknown>
  readonly credentialRef: AgentCredentialRefRecord | null
  readonly changeSummary: string
  publishedAt?: string | undefined
  publishedBy?: string | undefined
}

/** Flat asset-version references of one version: skills, then knowledge, then memory. */
function assetVersionIdsOf(version: Pick<AgentProfileVersionRecord, 'skills' | 'knowledgeBases' | 'memory'>): string[] {
  return [
    ...version.skills.map(binding => binding.reference),
    ...version.knowledgeBases.map(binding => binding.reference),
    ...(version.memory === null ? [] : [version.memory.reference]),
  ]
}

interface ProjectBindingRecord {
  agentProfileVersionId: string
  default: boolean
  revision: number
}

interface AgentProfileRecord {
  readonly agentProfileId: string
  readonly organizationId: string
  name: string
  description: string
  readonly agentTypeId: string
  revision: number
  readonly createdBy: string
  readonly createdAt: string
  updatedAt: string
  readonly versions: AgentProfileVersionRecord[]
  readonly projectBindings: Map<string, ProjectBindingRecord>
}

/** One repository the fixture authorizes for a project. */
interface CodeSourceRecord {
  readonly repositoryId: string
  readonly name: string
  readonly provider: string
  readonly defaultBranch: string
  readonly branches: readonly string[]
}

interface WorkspaceRecord {
  readonly workspaceId: string
  readonly projectId: string
  readonly ownerUserId: string
  readonly repositoryId: string
  branch: string
  displayName: string
  defaultAgentProfileVersionId: string
  status: WorkspaceStatus
  revision: number
  lastError?: string | undefined
  readonly createdAt: string
  updatedAt: string
  /** Next lifecycle auto-transition instant; absent for states without one. */
  transitionAt?: number | undefined
  transitionTo?: WorkspaceStatus | undefined
}

interface FileRecord {
  readonly path: string
  readonly kind: 'directory' | 'file'
  readonly size: number
  readonly etag: string
  readonly contentType?: string
  readonly bytes?: Uint8Array
  diff?: string | undefined
  change?: 'added' | 'modified' | 'deleted' | undefined
}

interface RunRecord {
  readonly runId: string
  readonly projectId: string
  readonly workspaceId: string
  readonly sessionId: string
  readonly agentProfileVersionId: string
  /** 审批决策可剔除缺失资产（§11.10 partial_success）；其余路径只读使用。 */
  assetVersionIds: string[]
  readonly executionPolicy: Record<string, unknown>
  readonly workspaceRevision: number
  status: RunStatus
  readonly writeMode: 'read_only' | 'write'
  leaseId?: string | undefined
  /** 当前接管持有者（§11.10）：接管不改状态，只更新所有权元数据。 */
  operator?: string | undefined
  approval?: RunApprovalRecord | undefined
  revision: number
  readonly retryOfRunId?: string
  /** 引用的已确认计划（蓝图 §4.1：Run 对 Plan 做不可变引用；draft 归 Plan）。 */
  readonly planId?: string
  errorCode?: string | undefined
  readonly createdAt: string
  updatedAt: string
  transitionAt?: number | undefined
  readonly traceId: string
  readonly timeline: RunTimelineEntry[]
  checkpoint?: RunCheckpoint | undefined
  /** 检查点历史（§11.11）：只追加，恢复只消费最新一份，历史永久保留。 */
  checkpoints?: RunCheckpoint[] | undefined
  /** 脉搏附加条目（审批决策/测试结果）；status 与 tool_call/checkpoint 在读取时从时间线与检查点历史合成。 */
  pulseExtra?: Array<Record<string, unknown>> | undefined
  /**
   * 绑定时刻冻结的资产状态（§11.18 A）：按引用记下当时就绪度与原因，此后任何
   * 撤回都不得改写它。刻意设为必填——漏填要在编译期炸掉，而不是在读取时退化成
   * 一个「默认就绪」的假事实。
   */
  readonly assetSnapshot: Record<string, FrozenAssetBinding>
}

/** 一条资产引用在运行创建时刻的就绪事实。 */
interface FrozenAssetBinding {
  readonly readiness: 'ready' | 'unavailable'
  readonly reason: string | null
}

/** 暂停时保存的检查点（§11.8）：六类状态 + 恢复消费标记；§11.11 起携带 id 并只追加保留。 */
interface RunCheckpoint {
  readonly checkpointId: string
  readonly createdAt: string
  readonly traceId: string
  sessionSeq: number
  toolResults: Array<{ readonly call_id: string; readonly tool: string; readonly result: string }>
  readonly pendingApproval: Readonly<Record<string, unknown>> | null
  readonly completedSteps: readonly number[]
  readonly agentConfig: {
    readonly agentProfileVersionId: string
    readonly executionPolicy: Readonly<Record<string, unknown>>
  }
  readonly assetVersionIds: readonly string[]
  readonly workspaceRevision: number
  readonly planId: string | null
  /** 引用计划时的步骤标题快照（恢复预览据此列出将重用/将重新执行的步骤）。 */
  readonly steps: readonly string[] | undefined
  consumed: boolean
  consumedAt: string | null
}

/** 一次状态转移（§11.7）：原因、操作者、策略版本、事件序号与 trace 关联。 */
interface RunTimelineEntry {
  readonly status: RunStatus
  readonly at: string
  readonly reason: string
  readonly operator: string
  readonly policyVersion: string
  readonly revision: number
  readonly traceId: string
}

/** 审批实体上的一次资产复验结果（§11.10）：决策时刻逐项重判。 */
interface RunApprovalAsset {
  readonly assetVersionId: string
  readonly status: 'bound' | 'withdrawn' | 'missing'
  readonly detail: string
}

/**
 * 待审批动作实体（§11.10）：影响对象、权限、资产版本、风险、可撤销方式与
 * 有效期全部来自服务端，客户端不推断。决策（通过/拒绝）后实体消费移除。
 */
interface RunApprovalRecord {
  readonly approvalId: string
  readonly action: string
  readonly summary: string
  readonly affected: readonly string[]
  readonly permission: {
    readonly code: string
    readonly allowed: boolean
    readonly reason: string
    readonly policyVersion: string
  }
  readonly assets: readonly RunApprovalAsset[]
  readonly risk: { readonly level: 'low' | 'medium' | 'high'; readonly reason: string }
  readonly revocable: { readonly revocable: boolean; readonly how: string | null }
  readonly expiresAt: string
  readonly createdAt: string
}

/** 计划步骤：标题 + 依赖的步骤下标（蓝图 §4.1 Plan「步骤、依赖」）。 */
interface PlanStepRecord {
  readonly title: string
  readonly dependsOn: readonly number[]
}

/** 编辑记录：追加式历史，携带编辑前完整内容快照，历史只增不改（§11.6）。 */
interface PlanEditRecord {
  readonly editId: string
  readonly editorUserId: string
  readonly editor: string
  readonly editedAt: string
  readonly changeSummary: string
  readonly revisionBefore: number
  readonly revisionAfter: number
  readonly before: {
    readonly goal: string
    readonly steps: ReadonlyArray<PlanStepRecord>
    readonly agentProfileVersionId: string
    readonly assetVersionIds: readonly string[]
  }
}

/** 计划实体：draft 态归属 Plan；confirmed 后不可再编辑。 */
interface PlanRecord {
  readonly planId: string
  readonly workspaceId: string
  readonly projectId: string
  goal: string
  steps: PlanStepRecord[]
  agentProfileVersionId: string
  assetVersionIds: readonly string[]
  status: 'draft' | 'confirmed'
  revision: number
  readonly createdBy: string
  readonly createdAt: string
  updatedAt: string
  confirmedBy?: string | undefined
  confirmedAt?: string | undefined
  readonly edits: PlanEditRecord[]
}

export interface WorkspaceAuditRecord {
  readonly id: string
  readonly occurred_at: string
  readonly actor_user_id: string
  readonly actor_name: string
  readonly request_id: string
  readonly organization_id: string | null
  readonly project_id: string | null
  readonly workspace_id: string | null
  readonly session_id: string | null
  readonly run_id: string | null
  readonly agent_profile_id: string | null
  readonly agent_profile_version_id: string | null
  readonly asset_version_ids: readonly string[] | null
  readonly revision: number | null
  readonly action: string
  readonly result: 'succeeded' | 'failed'
  readonly error_code: string | null
}

interface StreamEvent {
  readonly eventId: string
  readonly resourceType: 'workspace' | 'run' | 'file' | 'changes' | 'agent_profile'
  readonly resourceId: string
  readonly revision: number
  readonly eventType: string
  readonly occurredAt: string
  readonly payload: Record<string, unknown>
  readonly projectIds: readonly string[]
}

interface SseSubscriber {
  readonly deliver: (chunk: string) => void
  /**
   * Ends this subscription from the server side.
   *
   * The `workspace-sever-stream` scenario uses it to model a service that drops
   * a live connection (a restart, a proxy cut, a lease expiry) — a state the
   * client must notice, not something a test can only hope to provoke by
   * destroying sockets underneath it.
   */
  readonly close?: () => void
}

interface MutationClaim {
  readonly kind: 'new'
  readonly key: string
  readonly fingerprint: string
}

/** Deterministic text/PNG payload base for the seeded workspace tree. */
const WORKSPACE_HTML = [
  '<!doctype html>',
  '<html lang="zh-CN">',
  '<head><meta charset="utf-8"><title>云工作空间示例</title></head>',
  '<body><h1>静态预览</h1><p>由 fixture 提供的受控 HTML。</p></body>',
  '</html>',
].join('\n')

/**
 * Attack-surface probe document served for `hostile.html`: the inline script
 * attempts the three escapes the isolation floor must stop (parent access,
 * storage and credential reads, network exfiltration) and reports each outcome
 * to the embedding page via postMessage — the only channel a sandboxed frame
 * without `allow-same-origin` has.
 */
const HOSTILE_HTML = [
  '<!doctype html>',
  '<html lang="zh-CN">',
  '<head><meta charset="utf-8"><title>hostile preview</title></head>',
  '<body><h1>hostile preview</h1><pre id="probe-result">running</pre>',
  '<script>',
  '(async () => {',
  '  const lines = [];',
  '  try {',
  "    lines.push('parent:LEAKED:' + String(parent.document.title).slice(0, 20));",
  '  } catch (error) {',
  "    lines.push('parent:' + (error instanceof DOMException ? error.name : 'blocked'));",
  '  }',
  '  try {',
  "    const read = window.localStorage.getItem('dsh-account');",
  "    lines.push('localStorage:' + (read === null ? 'empty' : 'READ'));",
  '  } catch (error) {',
  "    lines.push('localStorage:' + (error instanceof DOMException ? error.name : 'blocked'));",
  '  }',
  '  try {',
  "    await fetch('https://127.0.0.1:9/leak', { mode: 'no-cors' });",
  "    lines.push('fetch:SENT');",
  '  } catch (error) {',
  "    lines.push('fetch:blocked');",
  '  }',
  "  const text = lines.join('|');",
  "  document.getElementById('probe-result').textContent = text;",
  "  parent.postMessage('attempted', '*');",
  "  parent.postMessage(JSON.stringify(lines), '*');",
  '})();',
  '</script>',
  '</body>',
  '</html>',
].join('\n')

/** 1x1 transparent PNG so the image preview path carries real bytes. */
const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
])

const APP_JSON_DIFF = [
  '--- a/src/app.json',
  '+++ b/src/app.json',
  '@@ -1,4 +1,5 @@',
  ' {',
  '   "name": "cloud-workbench",',
  '+  "feature": "cloud-workspace",',
  '   "version": "0.3.0"',
  ' }',
].join('\n')

const NOTES_DIFF = [
  '--- /dev/null',
  '+++ b/docs/notes.txt',
  '@@ -0,0 +1,2 @@',
  '+联调记录：云工作空间状态序列。',
  '+第二条：变更面板 diff 展示。',
].join('\n')

const EVENT_RETENTION = 256
const PRUNED_EVENT_RETENTION = 2

export interface WorkspaceFixtureOptions {
  readonly seed?: boolean
  /** Server closure deciding whether one asset version reference may be bound. */
  readonly assetExists?: (kind: 'skill' | 'knowledge' | 'memory', id: string, version?: string) => boolean
  /**
   * Clock the **scheduled lifecycle transitions** read.
   *
   * Scheduled transitions (`provisioning -> starting -> ready`, a run leaving
   * `preparing`) are materialized lazily on read once their deadline passes, and
   * a transition bumps the record's `revision`. With the wall clock those
   * deadlines (`+40`/`+200` ms from creation) can elapse *between* a client's
   * revision read and its `If-Match` write, so the fixture correctly answers
   * `REVISION_CONFLICT` and a test that assumed nothing changed goes red — under
   * load only, which is the official "load-sensitive synchronization" signature
   * (`docs/testing`: a spec that passes alone is that spec's defect, and the
   * clock is one of the three boundaries that should be mocked).
   *
   * Tests therefore inject a **controllable** clock: with it frozen, a scheduled
   * transition happens only when the test advances time, which is the barrier
   * that replaces probabilistic waiting. Defaults to the wall clock, so the
   * standalone server and the browser smoke keep today's behaviour.
   *
   * Only deadline arithmetic reads this clock. Identity and audit timestamps
   * (`createdAt`, ids, event times) stay on the wall clock, so freezing time
   * cannot make two records collide.
   */
  readonly now?: (() => number) | undefined
}

/** Admin/manager predicate for organization-scoped cloud-workspace governance. */
function canAdministerWorkspace(accounts: AccountStore, principal: AccountPrincipal, organizationId: string): boolean {
  if (principal.role === 'admin') return true
  return principal.role === 'manager' && accounts.hasActiveMembership(principal.userId, organizationId)
}

/**
 * Organizations whose admin-surface rows the principal may see: admins see every
 * organization, managers and members only their active memberships. `undefined`
 * means unrestricted.
 */
function visibleOrganizationIds(accounts: AccountStore, principal: AccountPrincipal): ReadonlySet<string> | undefined {
  if (principal.role === 'admin') return undefined
  return new Set(accounts.organizations(principal).map(organization => organization.organization_id))
}

export class WorkspaceFixture {
  private readonly agentTypes: AgentTypeRecord[] = []
  private readonly agentProfiles: AgentProfileRecord[] = []
  private readonly codeSources = new Map<string, readonly CodeSourceRecord[]>()
  private readonly workspaces = new Map<string, WorkspaceRecord>()
  private readonly files = new Map<string, FileRecord[]>()
  private readonly runs = new Map<string, RunRecord>()
  private readonly plans = new Map<string, PlanRecord>()
  private readonly events: StreamEvent[] = []
  private readonly subscribers = new Set<SseSubscriber>()
  private readonly audits: WorkspaceAuditRecord[] = []
  private readonly idempotency = new Map<string, { readonly fingerprint: string; readonly data: unknown; readonly status: number }>()
  /**
   * 运行内的记忆抑制记录（§11.17）：`run_id → 被抑制的 memory_id`。它既不是
   * 审计也不是资产治理状态——不写 `audits`、不改任何资产的 revision/tier/status，
   * 且按运行归键，新运行默认不继承。
   */
  private readonly lensMemorySuppressions = new Map<string, Set<string>>()
  /**
   * 运行期资产版本撤回（§11.18）：目录行是服务声明的种子，撤回是运行期治理动作，
   * 记录覆盖在种子上而不改写它——撤回只影响新运行，已绑定过的运行读到的仍是当时的事实。
   */
  private readonly assetWithdrawals = new Map<
    string,
    { readonly reason: string; readonly at: string; readonly auditId: string; readonly revision: number }
  >()
  private eventCounter = 0
  /** Sticky prune flag from the `workspace-prune-events` fixture scenario header. */
  private pruneEvents = false

  constructor(
    private readonly accounts: AccountStore,
    private readonly options: WorkspaceFixtureOptions = {},
  ) {
    if (options.seed !== false) this.seed()
  }

  /**
   * Read the clock the scheduled transitions use.
   *
   * Every deadline that decides *when a state change becomes due* goes through
   * here, so a test can hold time still and make the fixture's progression a
   * decision it makes rather than a race it loses. See
   * {@link WorkspaceFixtureOptions.now}.
   * @returns the current time in milliseconds.
   */
  private clock(): number {
    return this.options.now?.() ?? Date.now()
  }

  /** Routes owned by this fixture; `parts` starts after the `/v1` prefix. */
  appliesTo(parts: readonly string[]): boolean {
    if (parts[1] === 'me' && (parts[2] === 'agent-types' || parts[2] === 'agent-profiles' || parts[2] === 'code-sources')) return true
    if (parts[1] === 'me' && parts[2] === 'agent-types' && parts.length >= 4) return true
    if (parts[1] === 'projects' && parts[3] === 'workspaces') return true
    if (parts[1] === 'workspaces' || parts[1] === 'runs') return true
    if (parts[1] === 'events' && parts[2] === 'stream') return true
    if (parts[1] === 'admin' && parts[2] === 'events' && parts[3] === 'stream') return true
    return parts[1] === 'admin' && ['agent-types', 'agent-profiles', 'asset-candidates', 'assets', 'workspaces', 'runs', 'audits'].includes(parts[2] ?? '')
  }

  async handle(
    parts: readonly string[],
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    principal: AccountPrincipal,
    requestId: string,
    scenario?: string,
  ): Promise<void> {
    if (scenario === 'workspace-prune-events') this.pruneEvents = true
    if (scenario === 'workspace-sever-stream') {
      // Drop every live event stream this fixture is holding; each client is
      // expected to notice and reconnect from its own watermark.
      for (const subscriber of [...this.subscribers]) subscriber.close?.()
      // `?sever_events=N` additionally moves the service on by N events. Both
      // happen inside this one request, so no reader can observe the events and
      // advance its cursor before the connection it must resume from is gone —
      // which is precisely the state that makes a resync necessary.
      const severed = Number(url.searchParams.get('sever_events') ?? '0')
      for (let index = 0; index < severed; index += 1) {
        this.appendEvent('workspace', `ws-severed-${Date.now()}-${index}`, 1, 'workspace.created', {
          project_id: 'project-alpha',
        })
      }
    }
    if (scenario === 'workspace-expired-token') {
      this.fail(response, 401, requestId, 'TOKEN_EXPIRED', '访问令牌已过期，请重新登录')
      return
    }
    if (scenario === 'workspace-downstream-failure') {
      this.fail(response, 503, requestId, 'SERVICE_UNAVAILABLE', '下游运行时暂不可用，请稍后重试')
      return
    }
    if (parts[1] === 'admin') {
      await this.handleAdmin(parts, request, response, url, principal, requestId)
      return
    }
    await this.handleUser(parts, request, response, url, principal, requestId)
  }

  // --- user surface -----------------------------------------------------------

  private async handleUser(
    parts: readonly string[],
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    principal: AccountPrincipal,
    requestId: string,
  ): Promise<void> {
    const method = request.method ?? 'GET'
    if (method === 'GET' && parts[1] === 'me' && parts[2] === 'agent-types' && parts.length === 3) {
      const page = this.paginate(this.agentTypes.map(toAgentTypeDto), url, this.pageFingerprint(url, []), 2, response, requestId)
      if (page === undefined) return
      this.sendJson(response, 200, requestId, page)
      return
    }
    // 用户侧类型 schema：账号需至少属于一个组织（插件在项目上下文内消费），
    // 无组织成员关系的账号 403；未知类型 404。
    if (method === 'GET' && parts[1] === 'me' && parts[2] === 'agent-types' && parts.length === 5 && parts[4] === 'schema') {
      if (this.accounts.organizations(principal).length === 0) {
        this.fail(response, 403, requestId, 'FORBIDDEN', '当前账号不属于任何组织，无法读取类型 schema')
        return
      }
      const schemaType = this.findAgentType(decodeURIComponent(parts[3] ?? ''))
      if (schemaType === undefined) {
        this.fail(response, 404, requestId, 'RESOURCE_NOT_FOUND', 'Agent 类型不存在')
        return
      }
      const userSchemaDto = toAgentTypeDto(schemaType)
      this.sendJson(response, 200, requestId, {
        agent_type_id: schemaType.agentTypeId,
        key: schemaType.key,
        credential_required: schemaType.credentialRequired,
        schema_version: schemaType.schemaVersion,
        schema: userSchemaDto.schema,
      })
      return
    }
    if (method === 'GET' && parts[1] === 'me' && parts[2] === 'code-sources' && parts.length === 3) {
      const projectId = url.searchParams.get('project_id')
      if (projectId === null || projectId.length === 0) {
        this.fail(response, 422, requestId, 'PROJECT_REQUIRED', 'project_id 必填')
        return
      }
      if (this.authorizeProjectOf(principal, projectId, requestId, response) === undefined) return
      // A project with no authorized repository answers with an empty list; the
      // workbench must render "no code source" rather than invent a repository id.
      const items = (this.codeSources.get(projectId) ?? []).map(toCodeSourceDto)
      this.sendJson(response, 200, requestId, { items })
      return
    }
    if (method === 'GET' && parts[1] === 'me' && parts[2] === 'agent-profiles' && parts.length === 3) {
      const projectId = url.searchParams.get('project_id')
      if (projectId === null || projectId.length === 0) {
        this.fail(response, 422, requestId, 'PROJECT_REQUIRED', 'project_id 必填')
        return
      }
      const project = this.accounts.authorizeProject(principal, projectId, requestId)
      if (isFailure(project)) {
        this.fail(response, project.status, requestId, project.code, project.message)
        return
      }
      const items = this.agentProfiles
        .map(profile => this.visibleVersion(profile, project.project_id))
        .filter((entry): entry is NonNullable<ReturnType<WorkspaceFixture['visibleVersion']>> => entry !== undefined)
        .map(([profile, version, binding]) => toUserVersionDto(profile, version, binding, this.findAgentType(profile.agentTypeId)))
      const page = this.paginate(items, url, this.pageFingerprint(url, ['project_id']), 2, response, requestId)
      if (page === undefined) return
      this.sendJson(response, 200, requestId, page)
      return
    }
    if (method === 'GET' && parts[1] === 'me' && parts[2] === 'agent-profiles' && parts.length === 4) {
      const found = this.findPublishedVersionForCaller(decodeURIComponent(parts[3] ?? ''), principal)
      if (found === undefined) {
        this.fail(response, 404, requestId, 'RESOURCE_NOT_FOUND', '资源不存在')
        return
      }
      // The detail route has no project context, so the default flag is the
      // neutral false; the project card list is the authority for that mark.
      const binding: ProjectBindingRecord = {
        agentProfileVersionId: found.version.agentProfileVersionId,
        default: false,
        revision: 0,
      }
      const agentType = this.findAgentType(found.profile.agentTypeId)
      this.sendJson(response, 200, requestId, toUserVersionDto(found.profile, found.version, binding, agentType))
      return
    }
    if (method === 'GET' && parts[1] === 'projects' && parts[3] === 'workspaces' && parts.length === 4) {
      const projectId = decodeURIComponent(parts[2] ?? '')
      if (this.authorizeProjectOf(principal, projectId, requestId, response) === undefined) return
      const items = [...this.workspaces.values()]
        .filter(workspace => workspace.projectId === projectId)
        .map(workspace => toWorkspaceDto(this.advanceWorkspace(workspace)))
      this.sendJson(response, 200, requestId, { items })
      return
    }
    if (method === 'POST' && parts[1] === 'projects' && parts[3] === 'workspaces' && parts.length === 4) {
      await this.createWorkspace(parts[2] ?? '', request, response, principal, requestId)
      return
    }
    if (parts[1] === 'workspaces' && parts.length >= 3) {
      await this.handleWorkspaceRoute(parts, request, response, url, principal, requestId)
      return
    }
    if (parts[1] === 'runs' && parts.length >= 3) {
      await this.handleRunRoute(parts, request, response, principal, requestId)
      return
    }
    if (method === 'GET' && parts[1] === 'events' && parts[2] === 'stream') {
      this.openEventStream(request, response, url, principal, requestId)
      return
    }
    this.fail(response, 404, requestId, 'RESOURCE_NOT_FOUND', '资源不存在')
  }

  private async handleWorkspaceRoute(
    parts: readonly string[],
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    principal: AccountPrincipal,
    requestId: string,
  ): Promise<void> {
    const method = request.method ?? 'GET'
    // The service convention puts `:action` in the id's own path segment (`ws-1:stop`).
    const rawSegment = parts[2] ?? ''
    const colon = rawSegment.indexOf(':')
    const workspaceId = decodeURIComponent(colon === -1 ? rawSegment : rawSegment.slice(0, colon))
    const action = colon === -1 ? parts[3] : rawSegment.slice(colon + 1)
    if (action === undefined) {
      if (method === 'GET') {
        const workspace = this.authorizeWorkspace(principal, workspaceId, requestId, response)
        if (workspace === undefined) return
        this.sendJson(response, 200, requestId, toWorkspaceDto(this.advanceWorkspace(workspace)))
        return
      }
      if (method === 'DELETE') {
        await this.lifecycleMutation(request, response, principal, requestId, workspaceId, 'delete')
        return
      }
      this.fail(response, 422, requestId, 'VALIDATION_ERROR', '不支持的工作空间请求')
      return
    }
    if (method === 'POST' && (['start', 'stop', 'retry', 'archive'] as readonly string[]).includes(action)) {
      await this.lifecycleMutation(request, response, principal, requestId, workspaceId, action as 'start' | 'stop' | 'retry' | 'archive')
      return
    }
    const workspace = this.authorizeWorkspace(principal, workspaceId, requestId, response)
    if (workspace === undefined) return
    const advanced = this.advanceWorkspace(workspace)
    switch (action) {
      case 'files':
        if (method === 'GET' && parts[4] === 'content') {
          this.sendFileContent(advanced, url, response, requestId)
          return
        }
        if (method === 'GET') {
          this.listDirectory(advanced, url, response, requestId)
          return
        }
        break
      case 'changes':
        if (method === 'GET') {
          this.sendChanges(advanced, response, requestId)
          return
        }
        break
      case 'preview':
        if (method === 'GET') {
          this.sendPreview(advanced, url, response, requestId, principal)
          return
        }
        break
      case 'runs':
        if (method === 'GET') {
          const items = [...this.runs.values()]
            .filter(run => run.workspaceId === advanced.workspaceId)
            .map(run => toRunDto(this.advanceRun(run)))
          this.sendJson(response, 200, requestId, { items })
          return
        }
        if (method === 'POST') {
          await this.createRun(request, response, principal, requestId, advanced)
          return
        }
        break
      case 'context-lens': {
        if (method === 'GET') {
          const runScope = url.searchParams.get('run_id')
          if (runScope === '') {
            // 空的运行作用域不等于「没有作用域」：拒绝，而不是退回基线快照。
            this.fail(response, 422, requestId, 'VALIDATION_ERROR', 'run_id 不能为空')
            return
          }
          if (runScope !== null) {
            const scoped = this.runs.get(runScope)
            if (scoped === undefined || scoped.workspaceId !== advanced.workspaceId) {
              this.fail(response, 404, requestId, 'RESOURCE_NOT_FOUND', '资源不存在')
              return
            }
            this.sendContextLens(advanced, response, requestId, scoped.runId)
            return
          }
          this.sendContextLens(advanced, response, requestId)
          return
        }
        if (method === 'POST' && parts[3] === 'memory-suppression') {
          await this.suppressLensMemory(request, response, principal, requestId, advanced)
          return
        }
        break
      }
      case 'preview-url':
        if (method === 'POST') {
          await this.issuePreviewUrl(request, response, principal, requestId, advanced)
          return
        }
        break
      case 'git':
        if (method === 'POST' && parts[4] === 'commit') {
          await this.gitCommit(request, response, principal, requestId, advanced)
          return
        }
        if (method === 'POST' && parts[4] === 'pull-request') {
          await this.gitPullRequest(request, response, principal, requestId, advanced)
          return
        }
        break
      case 'changes:discard':
        if (method === 'POST') {
          await this.discardChanges(request, response, principal, requestId, advanced)
          return
        }
        break
      case 'plans': {
        if (parts[4] === undefined) {
          if (method === 'GET') {
            const items = [...this.plans.values()]
              .filter(plan => plan.workspaceId === advanced.workspaceId)
              .map(plan => toPlanDto(plan))
            this.sendJson(response, 200, requestId, { items })
            return
          }
          if (method === 'POST') {
            await this.createPlan(request, response, principal, requestId, advanced)
            return
          }
          break
        }
        const planSegment = parts[4]
        const planColon = planSegment.indexOf(':')
        const planId = decodeURIComponent(planColon === -1 ? planSegment : planSegment.slice(0, planColon))
        const planAction = planColon === -1 ? undefined : planSegment.slice(planColon + 1)
        const plan = this.plans.get(planId)
        if (plan === undefined || plan.workspaceId !== advanced.workspaceId) {
          this.fail(response, 404, requestId, 'RESOURCE_NOT_FOUND', '计划不存在')
          return
        }
        if (planAction === 'confirm' && method === 'POST') {
          await this.confirmPlan(request, response, principal, requestId, advanced, plan)
          return
        }
        if (planAction === undefined && method === 'GET') {
          this.sendJson(response, 200, requestId, toPlanDto(plan))
          return
        }
        if (planAction === undefined && method === 'PUT') {
          await this.editPlan(request, response, principal, requestId, advanced, plan)
          return
        }
        break
      }
      default:
        break
    }
    this.fail(response, 404, requestId, 'RESOURCE_NOT_FOUND', '资源不存在')
  }

  /**
   * 上下文镜头快照（§11.13，§11.17）：账本条目按 §4.3 八层优先级排序，被抑制条目
   * （冲突/过期/未授权/用户本运行抑制）保留并携带原因；权限判定按时间倒序、≤8 条。
   *
   * `runId` 存在时叠加该运行的记忆抑制记录；不存在时是基线快照——运行内决定无法
   * 归属到「没有运行」，所以基线不应用任何抑制。
   */
  private contextLensSnapshot(workspace: WorkspaceRecord, runId?: string): Record<string, unknown> {
    const suppressions = runId === undefined ? undefined : this.lensMemorySuppressions.get(runId)
    const entry = (
      source: string,
      title: string,
      memoryId: string | null,
      permission: 'allowed' | 'suppressed',
      permissionReason: string | null,
      selectionReason: string,
      injected: boolean,
      updatedAt: string,
    ) => ({
      source,
      title,
      memory_id: memoryId,
      permission,
      permission_reason: permissionReason,
      selection_reason: selectionReason,
      injected,
      updated_at: updatedAt,
    })
    const baseline = [
      entry('safety', '安全与平台规则基线', null, 'allowed', null, '安全层始终注入', true, '2026-09-10T00:00:00.000Z'),
      entry('org-policy', '组织策略：禁止源码外发', null, 'allowed', null, '现行组织策略注入', true, '2026-09-10T00:00:00.000Z'),
      entry('org-policy', '组织策略：旧版外发规则 v1', null, 'suppressed', '与现行组织策略冲突，已抑制', '冲突条目不进入注入评估', false, '2026-08-15T00:00:00.000Z'),
      entry('project-policy', '项目规则：测试必须随代码提交', null, 'allowed', null, '项目策略注入', true, '2026-09-10T00:00:00.000Z'),
      entry('agent-config', `Agent 配置执行策略（${workspace.defaultAgentProfileVersionId}）`, null, 'allowed', null, '当前绑定版本的执行策略注入', true, '2026-09-10T00:00:00.000Z'),
      entry('skill', 'Skill：代码评审 1.0.0', null, 'allowed', null, '已发布且已授权，注入', true, '2026-09-01T00:00:00.000Z'),
      entry('skill', 'Skill：代码评审 0.9.0（旧版）', null, 'suppressed', '资产版本已过期，已抑制', '过期版本不进入注入评估', false, '2026-08-01T00:00:00.000Z'),
      entry('knowledge', '知识库 k-1（平台架构）', null, 'allowed', null, '已授权且索引正常，注入', true, '2026-09-01T00:00:00.000Z'),
      entry('knowledge', '知识库 k-3（旧版文档）', null, 'suppressed', '知识来源未授权，已抑制', '未授权来源不进入注入评估', false, '2026-07-01T00:00:00.000Z'),
      entry('memory', '记忆：协作偏好（2026-09）', 'mem-collab-pref', 'allowed', null, '在有效期内，注入', true, '2026-09-05T00:00:00.000Z'),
      entry('memory', '记忆：历史数据口径（2025-12）', 'mem-metrics-2025', 'suppressed', '记忆已过期，已抑制', '过期记忆不进入注入评估', false, '2025-12-01T00:00:00.000Z'),
      entry('user', '用户补充：优先处理登录模块', null, 'allowed', null, '用户临时补充，注入', true, '2026-09-10T00:05:00.000Z'),
    ]
    // 用户抑制是一次运行内的读时决定：条目仍然出现，只是换成用户自己的原因，
    // 且绝不改写记忆本身的 tier/status/revision。
    const entries = baseline.map((item) => {
      if (item.source !== 'memory' || item.memory_id === null) return item
      if (suppressions?.has(item.memory_id) !== true) return item
      return {
        ...item,
        permission: 'suppressed' as const,
        permission_reason: '用户已在本运行中关闭该记忆的影响',
        selection_reason: '用户在本运行中抑制该记忆，不进入注入评估',
        injected: false,
      }
    })
    const permissionDecisions = [
      { action: 'workspace.write', decision: 'allowed', code: 'OK', reason: '项目成员具备写入授权', policy_version: 'perm-policy@1', at: '2026-09-10T00:06:00.000Z' },
      { action: 'admin.audit.read', decision: 'denied', code: 'FORBIDDEN', reason: '成员无管理面权限', policy_version: 'perm-policy@1', at: '2026-09-10T00:04:00.000Z' },
    ]
    return {
      workspace_id: workspace.workspaceId,
      revision: workspace.revision,
      generated_at: new Date().toISOString(),
      entries,
      permission_decisions: permissionDecisions,
    }
  }

  private sendContextLens(
    workspace: WorkspaceRecord,
    response: ServerResponse,
    requestId: string,
    runId?: string,
  ): void {
    this.sendJson(response, 200, requestId, this.contextLensSnapshot(workspace, runId))
  }

  /**
   * 运行内的记忆抑制（§11.17）：只改该运行看到的内容——不删除记忆、不改它的
   * tier/status/revision、不影响其他运行或其他用户，也不写业务审计。
   */
  private async suppressLensMemory(
    request: IncomingMessage,
    response: ServerResponse,
    principal: AccountPrincipal,
    requestId: string,
    workspace: WorkspaceRecord,
  ): Promise<void> {
    const action = 'workspace.context_lens.memory_suppression'
    const body = await readJsonBody(request, response, requestId)
    if (body === undefined) return
    const claim = this.claimMutation(request, principal, response, requestId, action, body)
    if (claim === undefined) return
    const runId = body.run_id
    const memoryId = body.memory_id
    const suppressed = body.suppressed
    if (typeof runId !== 'string' || runId.length === 0
      || typeof memoryId !== 'string' || memoryId.length === 0
      || typeof suppressed !== 'boolean') {
      this.fail(response, 422, requestId, 'VALIDATION_ERROR', 'run_id、memory_id 与 suppressed 必填')
      return
    }
    // 运行必须属于该工作空间、记忆必须是该项目已授权的记忆：两种不成立都按 404
    // 回答，调用者无法用状态码区分「不存在」与「存在但无权」。
    const run = this.runs.get(runId)
    if (run === undefined || run.workspaceId !== workspace.workspaceId) {
      this.fail(response, 404, requestId, 'RESOURCE_NOT_FOUND', '资源不存在')
      return
    }
    if (this.authorizedLensMemory(memoryId, workspace.projectId) === undefined) {
      this.fail(response, 404, requestId, 'RESOURCE_NOT_FOUND', '资源不存在')
      return
    }
    const current = this.lensMemorySuppressions.get(runId) ?? new Set<string>()
    if (suppressed) current.add(memoryId)
    else current.delete(memoryId)
    this.lensMemorySuppressions.set(runId, current)
    const snapshot = this.contextLensSnapshot(workspace, runId)
    this.remember(claim, snapshot, 200)
    this.sendJson(response, 200, requestId, snapshot)
  }

  /** Resolves one authorized memory identity for a project; unknown or cross-project answers undefined. */
  private authorizedLensMemory(memoryId: string, projectId: string): { readonly memoryId: string; readonly library: string } | undefined {
    return LENS_MEMORY_CATALOG.find(entry => entry.memoryId === memoryId && entry.projectIds.includes(projectId))
  }

  // --- §11.18 资产版本快照、运行期撤回与跨模块审计 ------------------------------

  /**
   * 目录行的运行期有效状态：服务声明的种子就绪度，加上运行期撤回的覆盖。
   * 撤回不改写种子，因此「当时是什么」与「现在是什么」始终是两个可分别回答的问题。
   */
  private effectiveAsset(reference: string): {
    readonly entry: AssetCatalogEntry | undefined
    readonly readiness: 'ready' | 'unavailable'
    readonly invalidReason: string | null
    readonly withdrawnAt: string | null
    readonly withdrawalAuditId: string | null
    readonly revision: number
  } {
    const entry = assetCatalogEntryFor(reference)
    if (entry === undefined) {
      return { entry: undefined, readiness: 'unavailable', invalidReason: null, withdrawnAt: null, withdrawalAuditId: null, revision: 0 }
    }
    const withdrawal = this.assetWithdrawals.get(assetCatalogKey(entry))
    if (withdrawal === undefined) {
      return {
        entry,
        readiness: entry.readiness,
        invalidReason: entry.invalidReason,
        withdrawnAt: null,
        withdrawalAuditId: null,
        revision: 1,
      }
    }
    return {
      entry,
      readiness: 'unavailable',
      invalidReason: withdrawal.reason,
      withdrawnAt: withdrawal.at,
      withdrawalAuditId: withdrawal.auditId,
      revision: withdrawal.revision,
    }
  }

  /** 绑定项的 `required` 标记只存在于配置版本上；快照要照它区分必需与可选。 */
  private profileVersionRecord(versionId: string): AgentProfileVersionRecord | undefined {
    for (const profile of this.agentProfiles) {
      const version = profile.versions.find(candidate => candidate.agentProfileVersionId === versionId)
      if (version !== undefined) return version
    }
    return undefined
  }

  /**
   * 创建新运行前必须拒绝的资产引用（§11.18 B）。
   * 只有**必需**且当前不可用的资产才拦住新运行：可选资产不可用是降级，不是禁止
   * （与版本就绪度的既有语义一致）。
   */
  private unavailableRequiredAssets(version: AgentProfileVersionRecord): readonly string[] {
    const bindings = [...version.skills, ...version.knowledgeBases, ...(version.memory === null ? [] : [version.memory])]
    return bindings
      .filter(binding => binding.required && this.effectiveAsset(binding.reference).readiness !== 'ready')
      .map(binding => binding.reference)
  }

  /** 冻结一组资产引用的绑定时状态：运行创建那一刻的事实（§11.18 A）。 */
  private freezeAssets(references: readonly string[]): Record<string, FrozenAssetBinding> {
    return Object.fromEntries(references.map((reference) => {
      const effective = this.effectiveAsset(reference)
      return [reference, { readiness: effective.readiness, reason: effective.invalidReason }]
    }))
  }

  /**
   * 运行绑定快照（§11.18 A）：绑定时冻结的就绪事实与读取时刻的资产状态分开呈现，
   * 两者不同名、不同义，谁也不顶替谁。
   */
  private runAssetSnapshot(run: RunRecord): Record<string, unknown> {
    const version = this.profileVersionRecord(run.agentProfileVersionId)
    const bindings = version === undefined
      ? []
      : [...version.skills, ...version.knowledgeBases, ...(version.memory === null ? [] : [version.memory])]
    const assets = run.assetVersionIds.map((reference, index) => {
      const frozen = run.assetSnapshot[reference]
      const effective = this.effectiveAsset(reference)
      const match = /^(skill|knowledge|memory):([^@]+)(?:@(.+))?$/u.exec(reference)
      const currentState = effective.withdrawnAt !== null
        ? 'withdrawn'
        : effective.entry === undefined
          ? 'missing'
          : 'bound'
      return {
        asset_type: match?.[1] ?? 'unknown',
        asset_id: match === null ? reference : `${match[1]}:${match[2]}`,
        asset_version_id: reference,
        name: effective.entry?.name ?? reference,
        required: bindings.find(binding => binding.reference === reference)?.required ?? false,
        order: index + 1,
        // 绑定时事实缺失是服务端自身的不一致。此处如实说「没有记录」，绝不退化成一个
        // 看起来正常的「就绪」——那正是这条契约要禁止的事。判据必须是「记录在不在」，
        // 不能用 `??`：就绪资产的原因本来就合法地为 null，`??` 会把它读成「缺记录」。
        readiness_at_binding: frozen === undefined ? 'unavailable' : frozen.readiness,
        unavailable_reason_at_binding: frozen === undefined
          ? '绑定时刻的资产事实缺失：服务端未记录该引用'
          : frozen.reason,
        current_state: currentState,
        withdrawn_at: effective.withdrawnAt,
        withdrawal_audit_id: effective.withdrawalAuditId,
      }
    })
    // 跨模块审计（§11.18 A）：绑定过的资产版本的治理行，让「从运行追到资产治理」
    // 不需要调用方自己跨模块拼请求。
    const references = new Set(run.assetVersionIds)
    const governance = this.audits
      .filter(row => row.action.startsWith('asset.') && (row.asset_version_ids ?? []).some(reference => references.has(reference)))
      .flatMap(row => (row.asset_version_ids ?? [])
        .filter(reference => references.has(reference))
        .map(reference => ({
          audit_id: row.id,
          action: row.action,
          actor_name: row.actor_name,
          at: row.occurred_at,
          asset_version_id: reference,
        })))
      .sort((left, right) => (left.at < right.at ? 1 : -1))
    return {
      run_id: run.runId,
      captured_at: run.createdAt,
      run_revision: run.revision,
      assets,
      governance,
    }
  }

  /**
   * 运行期撤回一个资产版本（§11.18 B）。只影响新运行：已创建运行的绑定快照原样保留，
   * 运行状态机也不因撤回而改变——撤回改变的是「以后能不能绑定」，不是「已经绑定了什么」。
   */
  private async withdrawAssetVersion(
    request: IncomingMessage,
    response: ServerResponse,
    principal: AccountPrincipal,
    requestId: string,
    rawSegment: string,
  ): Promise<void> {
    const action = 'asset.version.withdraw'
    const body = await readJsonBody(request, response, requestId)
    if (body === undefined) return
    const claim = this.claimMutation(request, principal, response, requestId, action, body)
    if (claim === undefined) return
    const colon = rawSegment.lastIndexOf(':')
    const reference = colon === -1 ? '' : decodeURIComponent(rawSegment.slice(0, colon))
    const operation = colon === -1 ? '' : rawSegment.slice(colon + 1)
    if (operation !== 'withdraw' || reference.length === 0) {
      this.fail(response, 404, requestId, 'RESOURCE_NOT_FOUND', '资源不存在')
      return
    }
    const entry = assetCatalogEntryFor(reference)
    if (entry === undefined) {
      this.fail(response, 404, requestId, 'RESOURCE_NOT_FOUND', '资源不存在')
      this.recordAudit(principal, action, 'failed', requestId, { assetVersionIds: [reference], errorCode: 'RESOURCE_NOT_FOUND' })
      return
    }
    const key = assetCatalogKey(entry)
    if (this.assetWithdrawals.has(key)) {
      this.fail(response, 409, requestId, 'INVALID_STATE', '该资产版本已撤回')
      this.recordAudit(principal, action, 'failed', requestId, { assetVersionIds: [key], errorCode: 'INVALID_STATE' })
      return
    }
    const reason = body.reason
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      this.fail(response, 422, requestId, 'VALIDATION_ERROR', 'reason 必填且不能为空')
      return
    }
    const expected = expectedAssetRevision(request, body)
    if (expected === undefined) {
      this.fail(response, 428, requestId, 'CONCURRENT_CONDITION_REQUIRED', '撤回资产版本必须携带并发条件（If-Match 或 expected_asset_revision）')
      return
    }
    if (expected !== 1) {
      this.fail(response, 409, requestId, 'REVISION_CONFLICT', '资产目录行 revision 已变化')
      this.recordAudit(principal, action, 'failed', requestId, { assetVersionIds: [key], errorCode: 'REVISION_CONFLICT' })
      return
    }
    const withdrawnAt = new Date().toISOString()
    const auditId = this.recordAudit(principal, action, 'succeeded', requestId, { assetVersionIds: [key] })
    this.assetWithdrawals.set(key, { reason: reason.trim(), at: withdrawnAt, auditId, revision: 2 })
    const dto = {
      asset_id: `${entry.assetType}:${entry.baseId}`,
      asset_version_id: key,
      asset_type: entry.assetType,
      name: entry.name,
      readiness: 'unavailable',
      invalid_reason: reason.trim(),
      withdrawn_at: withdrawnAt,
      withdrawal_audit_id: auditId,
      revision: 2,
    }
    this.remember(claim, dto, 200)
    this.sendJson(response, 200, requestId, dto)
  }

  private async handleRunRoute(
    parts: readonly string[],
    request: IncomingMessage,
    response: ServerResponse,
    principal: AccountPrincipal,
    requestId: string,
  ): Promise<void> {
    const method = request.method ?? 'GET'
    // `:action` rides in the run id's own path segment (`run-1:cancel`).
    const rawSegment = parts[2] ?? ''
    const colon = rawSegment.indexOf(':')
    const runId = decodeURIComponent(colon === -1 ? rawSegment : rawSegment.slice(0, colon))
    const action = colon === -1 ? parts[3] : rawSegment.slice(colon + 1)
    if (action === undefined) {
      if (method !== 'GET') {
        this.fail(response, 422, requestId, 'VALIDATION_ERROR', '不支持的 Run 请求')
        return
      }
      const run = this.runs.get(runId)
      if (run === undefined) {
        this.fail(response, 404, requestId, 'RESOURCE_NOT_FOUND', '资源不存在')
        return
      }
      if (this.authorizeWorkspace(principal, run.workspaceId, requestId, response) === undefined) return
      this.sendJson(response, 200, requestId, toRunDto(this.advanceRun(run)))
      return
    }
    if (action === 'asset-snapshot' && method === 'GET') {
      const run = this.runs.get(runId)
      if (run === undefined) {
        this.fail(response, 404, requestId, 'RESOURCE_NOT_FOUND', '资源不存在')
        return
      }
      if (this.authorizeWorkspace(principal, run.workspaceId, requestId, response) === undefined) return
      // §11.18 A：绑定时事实与读取时刻状态分开呈现，快照本身只读。
      this.sendJson(response, 200, requestId, this.runAssetSnapshot(this.advanceRun(run)))
      return
    }
    if (action === 'pulse' && method === 'GET') {
      const run = this.runs.get(runId)
      if (run === undefined) {
        this.fail(response, 404, requestId, 'RESOURCE_NOT_FOUND', '资源不存在')
        return
      }
      if (this.authorizeWorkspace(principal, run.workspaceId, requestId, response) === undefined) return
      // §11.11：status 条目从 §11.7 时间线合成，tool_call/checkpoint 从检查点历史
      // 合成（consumed 实时），approval/test 来自 pulseExtra；按 at、revision 稳定排序。
      const statusEntries = run.timeline.map(entry => ({
        kind: 'status',
        at: entry.at,
        revision: entry.revision,
        trace_id: entry.traceId,
        summary: `${entry.status}：${entry.reason}`,
        status: entry.status,
        reason: entry.reason,
        operator: entry.operator,
        policy_version: entry.policyVersion,
      }))
      const checkpointEntries = (run.checkpoints ?? []).flatMap((checkpoint) => {
        const base = {
          kind: 'checkpoint',
          at: checkpoint.createdAt,
          revision: run.revision,
          trace_id: checkpoint.traceId,
          summary: checkpoint.consumed ? `检查点 ${checkpoint.checkpointId}（已消费）` : `检查点 ${checkpoint.checkpointId}`,
          checkpoint_id: checkpoint.checkpointId,
          consumed: checkpoint.consumed,
        }
        const toolEntries = checkpoint.toolResults.map(entry => ({
          kind: 'tool_call',
          at: checkpoint.createdAt,
          revision: run.revision,
          trace_id: checkpoint.traceId,
          summary: `${entry.tool}：${entry.call_id}`,
          call_id: entry.call_id,
          tool: entry.tool,
          result: entry.result,
        }))
        return [base, ...toolEntries]
      })
      const items = [...statusEntries, ...checkpointEntries, ...(run.pulseExtra ?? [])]
      items.sort((left, right) => {
        const byAt = String(left['at']).localeCompare(String(right['at']))
        return byAt !== 0 ? byAt : Number(left['revision']) - Number(right['revision'])
      })
      this.sendJson(response, 200, requestId, { run_id: run.runId, items })
      return
    }
    if (action === 'approval' && method === 'GET') {
      const run = this.runs.get(runId)
      if (run === undefined) {
        this.fail(response, 404, requestId, 'RESOURCE_NOT_FOUND', '资源不存在')
        return
      }
      if (this.authorizeWorkspace(principal, run.workspaceId, requestId, response) === undefined) return
      if (run.approval === undefined) {
        this.fail(response, 404, requestId, 'APPROVAL_NOT_FOUND', '审批不存在或已消费')
        return
      }
      this.sendJson(response, 200, requestId, this.approvalDto(run.approval, run.runId))
      return
    }
    if (action === 'checkpoint') {
      if (method !== 'GET') {
        this.fail(response, 404, requestId, 'RESOURCE_NOT_FOUND', '资源不存在')
        return
      }
      const run = this.runs.get(runId)
      if (run === undefined) {
        this.fail(response, 404, requestId, 'CHECKPOINT_NOT_FOUND', '检查点不存在')
        return
      }
      // §11.11：无查询返回最新；checkpoint_id 指向历史（含已消费），均只读。
      const query = request.url === undefined ? '' : request.url.split('?')[1] ?? ''
      const requestedId = new URLSearchParams(query).get('checkpoint_id')
      let checkpoint = run.checkpoint
      if (requestedId !== null && requestedId !== '') {
        checkpoint = (run.checkpoints ?? []).find(candidate => candidate.checkpointId === requestedId)
      }
      if (checkpoint === undefined) {
        this.fail(response, 404, requestId, 'CHECKPOINT_NOT_FOUND', '检查点不存在')
        return
      }
      if (this.authorizeWorkspace(principal, run.workspaceId, requestId, response) === undefined) return
      this.advanceRun(run)
      this.sendJson(response, 200, requestId, toCheckpointDto(checkpoint))
      return
    }
    if (method !== 'POST') {
      this.fail(response, 404, requestId, 'RESOURCE_NOT_FOUND', '资源不存在')
      return
    }
    const run = this.runs.get(runId)
    if (run === undefined) {
      this.fail(response, 404, requestId, 'RESOURCE_NOT_FOUND', '资源不存在')
      return
    }
    const workspace = this.authorizeWorkspace(principal, run.workspaceId, requestId, response)
    if (workspace === undefined) return
    if (action === 'pause') {
      await this.pauseRun(request, response, principal, requestId, workspace, this.advanceRun(run))
      return
    }
    if (action === 'resume') {
      await this.resumeRun(request, response, principal, requestId, workspace, run)
      return
    }
    if (action === 'cancel') {
      await this.cancelRun(request, response, principal, requestId, this.advanceRun(run))
      return
    }
    if (action === 'retry') {
      await this.retryRun(request, response, principal, requestId, this.advanceRun(run))
      return
    }
    if (action === 'approval') {
      await this.decideApproval(request, response, principal, requestId, runId)
      return
    }
    if (action === 'takeover') {
      await this.takeoverRun(request, response, principal, requestId, runId)
      return
    }
    this.fail(response, 404, requestId, 'RESOURCE_NOT_FOUND', '资源不存在')
  }

  /**
   * 不透明分页：cursor 为 base64url(JSON {f, o})，f 是"路径+筛选"指纹。语法非法
   * 或指纹不匹配（跨筛选复用旧 cursor）一律 400 INVALID_CURSOR；无下一页时
   * next_cursor 为稳定 null。
   */
  private paginate<T>(
    items: readonly T[],
    url: URL,
    fingerprint: string,
    pageSize: number,
    response: ServerResponse,
    requestId: string,
  ): { items: T[]; next_cursor: string | null } | undefined {
    const cursor = url.searchParams.get('cursor')
    let offset = 0
    if (cursor !== null) {
      let decoded: unknown
      try {
        const json = Buffer.from(cursor, 'base64url').toString('utf-8')
        decoded = JSON.parse(json)
      } catch {
        decoded = undefined
      }
      const record = decoded !== null && typeof decoded === 'object'
        ? decoded as { f?: unknown; o?: unknown }
        : undefined
      if (
        record === undefined ||
        typeof record.f !== 'string' || record.f !== fingerprint ||
        typeof record.o !== 'number' || !Number.isInteger(record.o) || record.o < 0
      ) {
        this.fail(response, 400, requestId, 'INVALID_CURSOR', 'cursor 无效或筛选条件已变化')
        return undefined
      }
      offset = record.o
    }
    const slice = items.slice(offset, offset + pageSize)
    const next = offset + pageSize < items.length
      ? Buffer.from(JSON.stringify({ f: fingerprint, o: offset + pageSize })).toString('base64url')
      : null
    return { items: slice, next_cursor: next }
  }

  /** 构造分页指纹：路径 + 参与筛选的参数原样值。 */
  private pageFingerprint(url: URL, filterKeys: readonly string[]): string {
    const parts = [url.pathname]
    for (const key of filterKeys) {
      const value = url.searchParams.get(key)
      if (value !== null) parts.push(`${key}=${value}`)
    }
    return parts.join('|')
  }

  // --- admin surface ----------------------------------------------------------

  private async handleAdmin(
    parts: readonly string[],
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    principal: AccountPrincipal,
    requestId: string,
  ): Promise<void> {
    if (!canAdministerWorkspace(this.accounts, principal, 'org-alpha') && !canAdministerWorkspace(this.accounts, principal, 'org-beta')) {
      this.fail(response, 403, requestId, 'FORBIDDEN', '当前账号无权访问管理接口')
      this.recordAudit(principal, '权限拒绝', 'failed', requestId, { errorCode: 'FORBIDDEN' })
      return
    }
    const method = request.method ?? 'GET'
    const resource = parts[2]
    if (method === 'GET' && resource === 'agent-types' && parts.length === 3) {
      const page = this.paginate(this.agentTypes.map(toAgentTypeDto), url, this.pageFingerprint(url, []), 2, response, requestId)
      if (page === undefined) return
      this.sendJson(response, 200, requestId, page)
      return
    }
    if (method === 'GET' && resource === 'agent-types' && parts.length === 5 && parts[4] === 'schema') {
      const schemaType = this.findAgentType(decodeURIComponent(parts[3] ?? ''))
      if (schemaType === undefined) {
        this.fail(response, 404, requestId, 'RESOURCE_NOT_FOUND', 'Agent 类型不存在')
        return
      }
      const schemaDto = toAgentTypeDto(schemaType)
      this.sendJson(response, 200, requestId, {
        agent_type_id: schemaType.agentTypeId,
        key: schemaType.key,
        schema_version: schemaType.schemaVersion,
        schema: schemaDto.schema,
      })
      return
    }
    if (method === 'GET' && resource === 'events' && parts[3] === 'stream') {
      this.openAdminEventStream(request, response, url, principal)
      return
    }
    // §11.18 B：运行期撤回资产版本（只影响新运行）。
    if (method === 'POST' && resource === 'assets' && parts.length === 4) {
      await this.withdrawAssetVersion(request, response, principal, requestId, decodeURIComponent(parts[3] ?? ''))
      return
    }
    if (resource === 'agent-profiles') {
      this.handleAdminProfiles(parts, request, response, url, principal, requestId)
      return
    }
    if (method === 'GET' && resource === 'asset-candidates') {
      this.handleAssetCandidates(response, url, principal, requestId)
      return
    }
    if (resource === 'workspaces') {
      await this.handleAdminWorkspaces(parts, request, response, url, principal, requestId)
      return
    }
    if (resource === 'runs') {
      this.handleAdminRuns(parts, request, response, principal, requestId)
      return
    }
    if (method === 'GET' && resource === 'audits') {
      const workspaceId = url.searchParams.get('workspace_id')
      const projectId = url.searchParams.get('project_id')
      const runId = url.searchParams.get('run_id')
      const agentProfileId = url.searchParams.get('agent_profile_id')
      const action = url.searchParams.get('action')
      const actorUserId = url.searchParams.get('actor_user_id')
      const visible = visibleOrganizationIds(this.accounts, principal)
      const items = this.audits
        .filter(audit => visible === undefined || audit.organization_id === null || visible.has(audit.organization_id))
        .filter(audit => workspaceId === null || audit.workspace_id === workspaceId)
        .filter(audit => projectId === null || audit.project_id === projectId)
        .filter(audit => runId === null || audit.run_id === runId)
        .filter(audit => agentProfileId === null || audit.agent_profile_id === agentProfileId)
        .filter(audit => action === null || audit.action === action)
        .filter(audit => actorUserId === null || audit.actor_user_id === actorUserId)
        .reverse()
      this.sendJson(response, 200, requestId, items)
      return
    }
    this.fail(response, 404, requestId, 'RESOURCE_NOT_FOUND', '资源不存在')
  }

  /**
   * Lists the service's asset candidates for a project: name, type, version,
   * authorization and readiness with the invalid reason — never asset content
   * or credentials.
   */
  private handleAssetCandidates(
    response: ServerResponse,
    url: URL,
    principal: AccountPrincipal,
    requestId: string,
  ): void {
    const projectId = url.searchParams.get('project_id')
    if (projectId === null || projectId.length === 0) {
      this.fail(response, 422, requestId, 'VALIDATION_ERROR', 'project_id 必填')
      return
    }
    const organizationId = this.accounts.projectOrganization(projectId)
    if (organizationId === undefined || !canAdministerWorkspace(this.accounts, principal, organizationId)) {
      this.fail(response, 403, requestId, 'FORBIDDEN', '当前账号无权读取该项目的资产候选')
      return
    }
    const authorizedKeys = new Set(this.accounts.projectAssetKeys(projectId) ?? [])
    const items = ASSET_CATALOG.map((entry) => {
      const authorized = authorizedKeys.has(`${entry.assetType}:${entry.baseId}`)
      const invalidReason = !authorized ? '资产未授权给该项目' : entry.invalidReason
      return {
        asset_id: `${entry.assetType}:${entry.baseId}@${entry.version}`,
        asset_type: entry.assetType,
        version: entry.version,
        name: entry.name,
        authorized,
        readiness: authorized && entry.readiness === 'ready' ? 'ready' : 'unavailable',
        invalid_reason: invalidReason,
        updated_at: entry.updatedAt,
        purpose: entry.purpose,
        source: entry.source,
      }
    })
    const page = this.paginate(items, url, this.pageFingerprint(url, ['project_id']), 4, response, requestId)
    if (page === undefined) return
    this.sendJson(response, 200, requestId, page)
  }

  /**
   * Resolves and validates the profile-facing members of one write body against
   * the agent type schema. Every present member is type-checked here; `required`
   * flags and schema fields are never defaulted.
   */
  private resolveProfileMutationFields(
    body: Record<string, unknown>,
    agentTypeId: string,
  ): { readonly error: string } | {
    name?: string
    description?: string
    model?: string
    reasoning?: string
    bindings?: { skills: AgentBindingRecord[]; knowledgeBases: AgentBindingRecord[]; memory: AgentBindingRecord | null }
    policy?: Record<string, unknown>
    credential?: AgentCredentialRefRecord | null
    extensions?: Record<string, unknown>
  } {
    if (body.name !== undefined && (typeof body.name !== 'string' || body.name.length === 0)) return { error: 'name 必须是非空字符串' }
    if (body.description !== undefined && typeof body.description !== 'string') return { error: 'description 必须是字符串' }
    if (body.model !== undefined && (typeof body.model !== 'string' || body.model.length === 0)) return { error: 'model 必须是非空字符串' }
    if (body.reasoning !== undefined && (typeof body.reasoning !== 'string' || body.reasoning.length === 0)) return { error: 'reasoning 必须是非空字符串' }
    if (body.execution_policy !== undefined) {
      if (!isRecordObject(body.execution_policy)) return { error: 'execution_policy 必须是对象' }
      const policyViolation = executionPolicyViolation(body.execution_policy)
      if (policyViolation !== null) return { error: policyViolation }
    }
    const bindings = parseAssetBindings(body.asset_bindings)
    if (typeof bindings === 'string') return { error: bindings }
    const credential = resolveCredentialRef(body.credential_ref)
    if (typeof credential === 'string') return { error: credential }
    let extensions: Record<string, unknown> | undefined
    if (body.type_extension_config !== undefined) {
      if (!isRecordObject(body.type_extension_config)) return { error: 'type_extension_config 必须是对象' }
      const agentType = this.findAgentType(agentTypeId)
      if (agentType === undefined) return { error: 'agent_type_id 无效' }
      const violation = typeExtensionViolation(agentType, body.type_extension_config)
      if (violation !== null) return { error: violation }
      extensions = body.type_extension_config
    }
    return {
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
      ...(typeof body.description === 'string' ? { description: body.description } : {}),
      ...(typeof body.model === 'string' ? { model: body.model } : {}),
      ...(typeof body.reasoning === 'string' ? { reasoning: body.reasoning } : {}),
      ...(body.asset_bindings === undefined ? {} : { bindings }),
      ...(body.execution_policy === undefined ? {} : { policy: body.execution_policy }),
      ...(body.credential_ref === undefined ? {} : { credential }),
      ...(extensions === undefined ? {} : { extensions }),
    }
  }

  /** Emits one `agent_profile` stream event for a governance mutation on this profile. */
  private emitProfileEvent(
    profile: AgentProfileRecord,
    eventType: string,
    extra: Record<string, unknown> = {},
  ): void {
    this.appendEvent('agent_profile', profile.agentProfileId, profile.revision, eventType, {
      organization_id: profile.organizationId,
      ...extra,
    })
  }

  /** Edits the latest DRAFT version of a profile; published content is immutable. */
  private async updateAdminProfile(
    request: IncomingMessage,
    response: ServerResponse,
    principal: AccountPrincipal,
    requestId: string,
    profile: AgentProfileRecord,
  ): Promise<void> {
    const action = 'agent_profile.update'
    const body = await readJsonBody(request, response, requestId)
    if (body === undefined) return
    const claim = this.claimMutation(request, principal, response, requestId, action, body)
    if (claim === undefined) return
    if (!canAdministerWorkspace(this.accounts, principal, profile.organizationId)) {
      this.fail(response, 403, requestId, 'FORBIDDEN', '当前账号无权修改该配置')
      this.recordAudit(principal, action, 'failed', requestId, { profile, errorCode: 'FORBIDDEN' })
      return
    }
    if (expectedRevision(request, body) !== profile.revision) {
      this.fail(response, 409, requestId, 'REVISION_CONFLICT', '配置已被其他修改更新')
      this.recordAudit(principal, action, 'failed', requestId, { profile, errorCode: 'REVISION_CONFLICT' })
      return
    }
    const latest = profile.versions.at(-1)
    if (latest === undefined || latest.status !== 'draft') {
      this.fail(response, 409, requestId, 'INVALID_STATE', '已发布内容不可原地修改，请创建新版本')
      this.recordAudit(principal, action, 'failed', requestId, { profile, errorCode: 'INVALID_STATE' })
      return
    }
    const fields = this.resolveProfileMutationFields(body, profile.agentTypeId)
    if ('error' in fields) {
      this.fail(response, 422, requestId, 'VALIDATION_ERROR', fields.error)
      this.recordAudit(principal, action, 'failed', requestId, { profile, errorCode: 'VALIDATION_ERROR' })
      return
    }
    const mutable = latest as { -readonly [K in keyof AgentProfileVersionRecord]: AgentProfileVersionRecord[K] }
    if (fields.model !== undefined) mutable.model = fields.model
    if (fields.reasoning !== undefined) mutable.reasoning = fields.reasoning
    if (fields.bindings !== undefined) {
      mutable.skills = fields.bindings.skills
      mutable.knowledgeBases = fields.bindings.knowledgeBases
      mutable.memory = fields.bindings.memory
    }
    if (fields.policy !== undefined) mutable.executionPolicy = fields.policy
    if (fields.credential !== undefined) mutable.credentialRef = fields.credential
    if (fields.extensions !== undefined) mutable.typeExtensionConfig = fields.extensions
    if (fields.name !== undefined) profile.name = fields.name
    if (fields.description !== undefined) profile.description = fields.description
    profile.revision += 1
    profile.updatedAt = new Date().toISOString()
    this.recordAudit(principal, action, 'succeeded', requestId, { profile, profileVersion: latest })
    this.emitProfileEvent(profile, 'agent_profile.updated')
    this.sendJson(response, 200, requestId, toAdminProfileDto(profile, this.agentTypes))
  }

  private handleAdminProfiles(
    parts: readonly string[],
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    principal: AccountPrincipal,
    requestId: string,
  ): void {
    const method = request.method ?? 'GET'
    if (parts.length === 3 && method === 'GET') {
      const status = url.searchParams.get('status')
      const agentTypeId = url.searchParams.get('agent_type_id')
      const projectId = url.searchParams.get('project_id')
      const organizationId = url.searchParams.get('organization_id')
      const readiness = url.searchParams.get('readiness')
      const createdBy = url.searchParams.get('created_by')
      const updatedAfter = url.searchParams.get('updated_after')
      const updatedAfterMs = updatedAfter === null ? null : Date.parse(updatedAfter)
      if (updatedAfter !== null && (updatedAfterMs === null || Number.isNaN(updatedAfterMs))) {
        this.fail(response, 422, requestId, 'VALIDATION_ERROR', 'updated_after 必须是 UTC RFC 3339 时间')
        return
      }
      const visible = visibleOrganizationIds(this.accounts, principal)
      const items = this.agentProfiles
        .filter(profile => visible === undefined || visible.has(profile.organizationId))
        .filter(profile => organizationId === null || profile.organizationId === organizationId)
        .filter(profile => agentTypeId === null || profile.agentTypeId === agentTypeId)
        .filter(profile => projectId === null || profile.projectBindings.has(projectId))
        .map(profile => toAdminProfileDto(profile, this.agentTypes))
        .filter(dto => status === null || dto.status === status)
        .filter(dto => readiness === null || dto.readiness === readiness)
        .filter(dto => createdBy === null || dto.created_by === createdBy)
        .filter(dto => updatedAfterMs === null || Date.parse(String(dto.updated_at)) > updatedAfterMs)
      const page = this.paginate(items, url, this.pageFingerprint(url, ['status', 'agent_type_id', 'project_id', 'organization_id', 'readiness', 'created_by', 'updated_after']), 2, response, requestId)
      if (page === undefined) return
      this.sendJson(response, 200, requestId, page)
      return
    }
    if (parts.length === 3 && method === 'POST') {
      void this.createAdminProfile(request, response, principal, requestId)
      return
    }
    const rawSegment = parts[3] ?? ''
    const colon = rawSegment.indexOf(':')
    const rawProfileId = colon === -1 ? rawSegment : rawSegment.slice(0, colon)
    const profile = this.agentProfiles.find(candidate => candidate.agentProfileId === decodeURIComponent(rawProfileId))
    if (profile === undefined) {
      this.fail(response, 404, requestId, 'RESOURCE_NOT_FOUND', '资源不存在')
      return
    }
    if (colon !== -1) {
      if (method === 'POST' && rawSegment.slice(colon + 1) === 'clone') {
        void this.cloneAdminProfile(request, response, principal, requestId, profile)
        return
      }
      this.fail(response, 404, requestId, 'RESOURCE_NOT_FOUND', '资源不存在')
      return
    }
    if (parts.length === 4 && method === 'GET') {
      this.sendJson(response, 200, requestId, toAdminProfileDto(profile, this.agentTypes))
      return
    }
    if (parts.length === 4 && method === 'PUT') {
      void this.updateAdminProfile(request, response, principal, requestId, profile)
      return
    }
    if (parts.length === 5 && parts[4] === 'versions' && method === 'POST') {
      void this.createAdminProfileVersion(request, response, principal, requestId, profile)
      return
    }
    if (parts.length === 6 && parts[4] === 'versions' && method === 'POST') {
      const rawSegment = parts[5] ?? ''
      const colon = rawSegment.indexOf(':')
      if (colon !== -1) {
        const versionId = decodeURIComponent(rawSegment.slice(0, colon))
        const operation = rawSegment.slice(colon + 1)
        if (operation === 'dry-run') {
          this.dryRunProfileVersion(response, principal, requestId, profile, versionId)
          return
        }
        void this.adminVersionTransition(request, response, principal, requestId, profile, operation, versionId)
        return
      }
    }
    if (parts.length === 6 && parts[4] === 'project-bindings' && (method === 'PUT' || method === 'DELETE')) {
      void this.adminProjectBinding(request, response, principal, requestId, profile, decodeURIComponent(parts[5] ?? ''), method)
      return
    }
    this.fail(response, 404, requestId, 'RESOURCE_NOT_FOUND', '资源不存在')
  }

  private async handleAdminWorkspaces(
    parts: readonly string[],
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    principal: AccountPrincipal,
    requestId: string,
  ): Promise<void> {
    const method = request.method ?? 'GET'
    if (parts.length === 3 && method === 'GET') {
      const status = url.searchParams.get('status')
      const projectId = url.searchParams.get('project_id')
      const ownerUserId = url.searchParams.get('owner_user_id')
      const branch = url.searchParams.get('branch')
      const visible = visibleOrganizationIds(this.accounts, principal)
      const items = [...this.workspaces.values()]
        .filter(workspace => visible === undefined || visible.has(this.organizationOfProject(workspace.projectId)))
        .map(workspace => toWorkspaceDto(this.advanceWorkspace(workspace)))
        .filter(dto => status === null || dto.status === status)
        .filter(dto => projectId === null || dto.project_id === projectId)
        .filter(dto => ownerUserId === null || dto.owner_user_id === ownerUserId)
        .filter(dto => branch === null || dto.branch === branch)
      this.sendJson(response, 200, requestId, { items })
      return
    }
    const colon = (parts[3] ?? '').indexOf(':')
    const workspace = this.workspaces.get(decodeURIComponent(colon === -1 ? parts[3] ?? '' : (parts[3] ?? '').slice(0, colon)))
    if (workspace === undefined) {
      this.fail(response, 404, requestId, 'RESOURCE_NOT_FOUND', '资源不存在')
      return
    }
    if (!canAdministerWorkspace(this.accounts, principal, this.organizationOfProject(workspace.projectId))) {
      this.fail(response, 403, requestId, 'FORBIDDEN', '当前账号无权执行该操作')
      this.recordAudit(principal, '权限拒绝', 'failed', requestId, { workspace, errorCode: 'FORBIDDEN' })
      return
    }
    if (parts.length === 4 && method === 'GET') {
      this.advanceWorkspace(workspace)
      const runs = [...this.runs.values()]
        .filter(run => run.workspaceId === workspace.workspaceId)
        .map(run => toRunDto(this.advanceRun(run)))
      const profile = this.agentProfiles.find(candidate =>
        candidate.versions.some(version => version.agentProfileVersionId === workspace.defaultAgentProfileVersionId),
      )
      const version = profile?.versions.find(item => item.agentProfileVersionId === workspace.defaultAgentProfileVersionId)
      const entries = this.files.get(workspace.workspaceId) ?? []
      const changedEntries = entries.filter(entry => entry.change !== undefined)
      this.sendJson(response, 200, requestId, {
        ...toWorkspaceDto(this.advanceWorkspace(workspace)),
        recent_audits: this.audits.filter(audit => audit.workspace_id === workspace.workspaceId).slice(-20).reverse(),
        runs: runs,
        files_summary: {
          total: entries.filter(entry => entry.kind === 'file').length,
          directories: entries.filter(entry => entry.kind === 'directory').map(entry => entry.path),
          changed: changedEntries.map(entry => ({ path: entry.path, change: entry.change })),
        },
        changes: {
          baseline_revision: baselineOf(workspace),
          revision: workspace.revision,
          files: changedEntries.map(entry => ({ path: entry.path, change: entry.change, diff: entry.diff ?? '' })),
        },
        runtime: { kind: 'container', state: workspace.status === 'ready' ? 'running' : workspace.status, note: 'fixture-simulated' },
        config_snapshot: profile === undefined || version === undefined ? null : {
          agent_profile_id: profile.agentProfileId,
          agent_profile_version_id: version.agentProfileVersionId,
          status: version.status,
          model: version.model,
          reasoning: version.reasoning,
          asset_version_ids: assetVersionIdsOf(version),
          execution_policy: version.executionPolicy,
        },
      })
      return
    }
    if (parts.length === 4 && method === 'POST' && colon !== -1) {
      const operation = (parts[3] ?? '').slice(colon + 1)
      if (operation === 'start' || operation === 'stop') {
        await this.adminWorkspaceOp(request, response, principal, requestId, workspace, operation)
        return
      }
    }
    this.fail(response, 404, requestId, 'RESOURCE_NOT_FOUND', '资源不存在')
  }

  private handleAdminRuns(
    parts: readonly string[],
    request: IncomingMessage,
    response: ServerResponse,
    principal: AccountPrincipal,
    requestId: string,
  ): void {
    const method = request.method ?? 'GET'
    if (parts.length === 3 && method === 'POST') {
      void (async () => {
        const body = await readJsonBody(request, response, requestId)
        if (body === undefined) return
        const visible = visibleOrganizationIds(this.accounts, principal)
        const items = [...this.runs.values()]
          .filter(run => visible === undefined || visible.has(this.organizationOfProject(run.projectId)))
          .map(run => toRunDto(this.advanceRun(run)))
          .filter(dto => typeof body.project_id !== 'string' || dto.project_id === body.project_id)
          .filter(dto => typeof body.workspace_id !== 'string' || dto.workspace_id === body.workspace_id)
          .filter(dto => typeof body.status !== 'string' || dto.status === body.status)
          .filter(dto => typeof body.session_id !== 'string' || dto.session_id === body.session_id)
        this.sendJson(response, 200, requestId, { items })
      })()
      return
    }
    if (parts.length === 4 && method === 'GET') {
      const run = this.runs.get(decodeURIComponent(parts[3] ?? ''))
      if (run === undefined) {
        this.fail(response, 404, requestId, 'RESOURCE_NOT_FOUND', '资源不存在')
        return
      }
      if (!canAdministerWorkspace(this.accounts, principal, this.organizationOfProject(run.projectId))) {
        this.fail(response, 403, requestId, 'FORBIDDEN', '当前账号无权执行该操作')
        return
      }
      this.sendJson(response, 200, requestId, { ...toRunDto(this.advanceRun(run)), events: [...run.timeline] })
      return
    }
    this.fail(response, 404, requestId, 'RESOURCE_NOT_FOUND', '资源不存在')
  }

  // --- workspace mutations ------------------------------------------------------

  private async lifecycleMutation(
    request: IncomingMessage,
    response: ServerResponse,
    principal: AccountPrincipal,
    requestId: string,
    workspaceId: string,
    operation: 'start' | 'stop' | 'retry' | 'archive' | 'delete',
  ): Promise<void> {
    const action = `workspace.${operation}`
    const body = await readJsonBody(request, response, requestId)
    if (body === undefined) return
    const claim = this.claimMutation(request, principal, response, requestId, action, body)
    if (claim === undefined) return
    const workspace = this.authorizeWorkspace(principal, workspaceId, requestId, response)
    if (workspace === undefined) return
    // Every competing lifecycle write carries the revision the caller observed,
    // start and retry included: without it two operators starting the same
    // stopped workspace would both "succeed" against different states.
    if (expectedRevision(request, body) !== workspace.revision) {
      this.fail(response, 409, requestId, 'REVISION_CONFLICT', '工作空间已被其他修改更新')
      this.recordAudit(principal, action, 'failed', requestId, { workspace, errorCode: 'REVISION_CONFLICT' })
      return
    }
    const transitions: Record<string, { readonly from: readonly WorkspaceStatus[]; readonly to: WorkspaceStatus }> = {
      start: { from: ['draft', 'stopped', 'failed'], to: 'starting' },
      stop: { from: ['provisioning', 'starting', 'ready', 'degraded'], to: 'stopped' },
      retry: { from: ['failed'], to: 'provisioning' },
      archive: { from: ['draft', 'provisioning', 'starting', 'ready', 'degraded', 'stopped', 'failed'], to: 'archived' },
      delete: { from: ['stopped', 'archived', 'failed', 'draft'], to: 'deleting' },
    }
    const transition = transitions[operation]
    if (transition === undefined || !transition.from.includes(workspace.status)) {
      this.fail(response, 409, requestId, 'INVALID_STATUS', `当前状态 ${workspace.status} 不允许 ${operation}`)
      this.recordAudit(principal, action, 'failed', requestId, { workspace, errorCode: 'INVALID_STATUS' })
      return
    }
    this.applyTransition(workspace, transition.to)
    const dto = toWorkspaceDto(workspace)
    if (operation === 'delete') this.workspaces.delete(workspaceId)
    this.recordAudit(principal, action, 'succeeded', requestId, { workspace })
    this.remember(claim, dto, operation === 'start' || operation === 'retry' ? 202 : 200)
    this.sendJson(response, operation === 'start' || operation === 'retry' ? 202 : 200, requestId, dto)
  }

  private async adminWorkspaceOp(
    request: IncomingMessage,
    response: ServerResponse,
    principal: AccountPrincipal,
    requestId: string,
    workspace: WorkspaceRecord,
    operation: 'start' | 'stop',
  ): Promise<void> {
    const action = `admin.workspace.${operation}`
    const body = await readJsonBody(request, response, requestId)
    if (body === undefined) return
    const claim = this.claimMutation(request, principal, response, requestId, action, body)
    if (claim === undefined) return
    // Both admin lifecycle operations are competing writes: start advances the
    // state exactly like stop does, so both name the revision they observed.
    if (expectedRevision(request, body) !== workspace.revision) {
      this.fail(response, 409, requestId, 'REVISION_CONFLICT', '工作空间已被其他修改更新')
      this.recordAudit(principal, action, 'failed', requestId, { workspace, errorCode: 'REVISION_CONFLICT' })
      return
    }
    const from: readonly WorkspaceStatus[] = operation === 'stop'
      ? ['provisioning', 'starting', 'ready', 'degraded']
      : ['draft', 'stopped', 'failed']
    if (!from.includes(workspace.status)) {
      this.fail(response, 409, requestId, 'INVALID_STATUS', `当前状态 ${workspace.status} 不允许 ${operation}`)
      this.recordAudit(principal, action, 'failed', requestId, { workspace, errorCode: 'INVALID_STATUS' })
      return
    }
    this.applyTransition(workspace, operation === 'stop' ? 'stopped' : 'starting')
    const dto = toWorkspaceDto(workspace)
    this.recordAudit(principal, action, 'succeeded', requestId, { workspace })
    this.remember(claim, dto, operation === 'stop' ? 200 : 202)
    this.sendJson(response, operation === 'stop' ? 200 : 202, requestId, dto)
  }

  private async createWorkspace(
    rawProjectId: string,
    request: IncomingMessage,
    response: ServerResponse,
    principal: AccountPrincipal,
    requestId: string,
  ): Promise<void> {
    const action = 'workspace.create'
    const body = await readJsonBody(request, response, requestId)
    if (body === undefined) return
    const claim = this.claimMutation(request, principal, response, requestId, action, body)
    if (claim === undefined) return
    const projectId = decodeURIComponent(rawProjectId)
    if (this.authorizeProjectOf(principal, projectId, requestId, response) === undefined) return
    const repositoryId = typeof body.repository_id === 'string' ? body.repository_id : ''
    const branch = typeof body.branch === 'string' ? body.branch : ''
    const profileVersionId = typeof body.agent_profile_version_id === 'string' ? body.agent_profile_version_id : ''
    if (repositoryId.length === 0 || branch.length === 0 || profileVersionId.length === 0) {
      this.fail(response, 422, requestId, 'VALIDATION_ERROR', 'repository_id、branch 和 agent_profile_version_id 必填')
      return
    }
    const authorized = this.codeSources.get(projectId) ?? []
    const codeSource = authorized.find(source => source.repositoryId === repositoryId)
    if (codeSource === undefined) {
      // The service, not the form, owns which repositories exist for a project.
      this.fail(response, 403, requestId, 'FORBIDDEN', '该仓库未授权用于此项目')
      this.recordAudit(principal, action, 'failed', requestId, { projectId, errorCode: 'FORBIDDEN' })
      return
    }
    if (!codeSource.branches.includes(branch)) {
      this.fail(response, 422, requestId, 'VALIDATION_ERROR', '分支不在该仓库的授权范围内')
      this.recordAudit(principal, action, 'failed', requestId, { projectId, errorCode: 'VALIDATION_ERROR' })
      return
    }
    const boundVersion = this.findBoundPublishedVersion(projectId, profileVersionId)
    if (boundVersion === undefined) {
      this.fail(response, 422, requestId, 'VALIDATION_ERROR', 'Agent 配置版本不可用')
      this.recordAudit(principal, action, 'failed', requestId, {
        projectId,
        errorCode: 'VALIDATION_ERROR',
        agentProfileVersionId: profileVersionId,
      })
      return
    }
    const owningProfile = this.agentProfiles.find(profile => profile.versions.includes(boundVersion))
    const workspaceType = owningProfile === undefined ? undefined : this.findAgentType(owningProfile.agentTypeId)
    if (workspaceType === undefined || workspaceType.readiness === 'unavailable') {
      this.fail(response, 422, requestId, 'AGENT_TYPE_UNAVAILABLE', `Agent 类型不可用，禁止创建工作空间：${workspaceType?.name ?? profileVersionId}`)
      this.recordAudit(principal, action, 'failed', requestId, {
        projectId,
        errorCode: 'AGENT_TYPE_UNAVAILABLE',
        agentProfileVersionId: profileVersionId,
      })
      return
    }
    const now = new Date().toISOString()
    const workspace: WorkspaceRecord = {
      workspaceId: `ws-${randomUUID().slice(0, 8)}`,
      projectId,
      ownerUserId: principal.userId,
      repositoryId,
      branch,
      displayName: typeof body.display_name === 'string' && body.display_name.length > 0 ? body.display_name : branch,
      defaultAgentProfileVersionId: profileVersionId,
      status: 'provisioning',
      revision: 1,
      createdAt: now,
      updatedAt: now,
      transitionAt: this.clock() + 200,
      transitionTo: 'starting',
    }
    this.workspaces.set(workspace.workspaceId, workspace)
    this.files.set(workspace.workspaceId, this.seedWorkspaceFiles())
    this.appendEvent('workspace', workspace.workspaceId, 1, 'workspace.created', { project_id: projectId })
    this.appendEvent('workspace', workspace.workspaceId, 1, 'workspace.provisioning', { project_id: projectId })
    this.recordAudit(principal, action, 'succeeded', requestId, { workspace, agentProfileVersionId: profileVersionId })
    const dto = toWorkspaceDto(workspace)
    this.remember(claim, dto, 202)
    this.sendJson(response, 202, requestId, dto)
  }

  private async createRun(
    request: IncomingMessage,
    response: ServerResponse,
    principal: AccountPrincipal,
    requestId: string,
    workspace: WorkspaceRecord,
  ): Promise<void> {
    const action = 'run.create'
    const body = await readJsonBody(request, response, requestId)
    if (body === undefined) return
    const claim = this.claimMutation(request, principal, response, requestId, action, body)
    if (claim === undefined) return
    const sessionId = typeof body.session_id === 'string' ? body.session_id : ''
    const writeMode = body.write_mode === 'write' ? 'write' as const : body.write_mode === 'read_only' ? 'read_only' as const : undefined
    if (sessionId.length === 0 || writeMode === undefined) {
      this.fail(response, 422, requestId, 'VALIDATION_ERROR', 'session_id 与 write_mode 必填')
      return
    }
    // 计划引用（§11.6）：Run 只能绑定同一工作空间内已确认的计划；draft 归 Plan。
    let referencedPlan: PlanRecord | undefined
    if (typeof body.plan_id === 'string' && body.plan_id.length > 0) {
      const candidate = this.plans.get(body.plan_id)
      if (candidate === undefined || candidate.workspaceId !== workspace.workspaceId) {
        this.fail(response, 404, requestId, 'RESOURCE_NOT_FOUND', '计划不存在')
        this.recordAudit(principal, action, 'failed', requestId, { workspace, errorCode: 'RESOURCE_NOT_FOUND' })
        return
      }
      if (candidate.status !== 'confirmed') {
        this.fail(response, 409, requestId, 'PLAN_NOT_CONFIRMED', '计划尚未确认，不能创建 Run')
        this.recordAudit(principal, action, 'failed', requestId, { workspace, errorCode: 'PLAN_NOT_CONFIRMED' })
        return
      }
      referencedPlan = candidate
    }
    if (workspace.status !== 'ready') {
      this.fail(response, 409, requestId, 'INVALID_STATUS', `工作空间状态 ${workspace.status} 不允许创建 Run`)
      this.recordAudit(principal, action, 'failed', requestId, { workspace, errorCode: 'INVALID_STATUS' })
      return
    }
    if (expectedRevision(request, body) !== workspace.revision) {
      this.fail(response, 409, requestId, 'REVISION_CONFLICT', '工作空间 revision 已变化')
      this.recordAudit(principal, action, 'failed', requestId, { workspace, errorCode: 'REVISION_CONFLICT' })
      return
    }
    const requestedVersion = typeof body.agent_profile_version_id === 'string' && body.agent_profile_version_id.length > 0
      ? body.agent_profile_version_id
      : workspace.defaultAgentProfileVersionId
    const profileVersion = this.findBoundPublishedVersion(workspace.projectId, requestedVersion)
    if (profileVersion === undefined) {
      this.fail(response, 403, requestId, 'FORBIDDEN', '当前项目无权使用该 Agent 配置版本')
      this.recordAudit(principal, action, 'failed', requestId, {
        workspace,
        errorCode: 'FORBIDDEN',
        agentProfileVersionId: requestedVersion,
      })
      return
    }
    const owningProfile = this.agentProfiles.find(profile => profile.versions.includes(profileVersion))
    const runType = owningProfile === undefined ? undefined : this.findAgentType(owningProfile.agentTypeId)
    if (runType === undefined || runType.readiness === 'unavailable') {
      this.fail(response, 422, requestId, 'AGENT_TYPE_UNAVAILABLE', `Agent 类型不可用，禁止创建 Run：${runType?.name ?? requestedVersion}`)
      this.recordAudit(principal, action, 'failed', requestId, {
        workspace,
        errorCode: 'AGENT_TYPE_UNAVAILABLE',
        agentProfileVersionId: requestedVersion,
      })
      return
    }
    // The run's write mode is a run parameter: it may tighten the profile's
    // declared write capability but never widen it. An absent policy member
    // means the server has not restricted writes for this version.
    if (writeMode === 'write' && profileVersion.executionPolicy['write_mode'] === 'read_only') {
      this.fail(response, 422, requestId, 'VALIDATION_ERROR', 'Profile 执行策略不允许写入，Run 不得扩大写入范围')
      this.recordAudit(principal, action, 'failed', requestId, { workspace, errorCode: 'VALIDATION_ERROR' })
      return
    }
    if (writeMode === 'write') {
      const activeWrite = this.activeWriteRun(workspace.workspaceId)
      if (activeWrite !== undefined) {
        this.failWithPayload(response, 409, requestId, 'WORKSPACE_BUSY', '同一工作空间已存在写入 Run', {
          current_run: toRunDto(this.advanceRun(activeWrite)),
        })
        this.recordAudit(principal, action, 'failed', requestId, { workspace, run: activeWrite, errorCode: 'WORKSPACE_BUSY' })
        return
      }
    }
    // §11.18 B：撤回只影响新运行——必需资产不可用时拒绝创建，已经创建过的运行不受影响。
    const blockedAssets = this.unavailableRequiredAssets(profileVersion)
    if (blockedAssets.length > 0) {
      this.failWithDetails(response, 422, requestId, 'ASSET_UNAVAILABLE', '必需资产不可用，禁止创建 Run', {
        asset_version_ids: blockedAssets,
      })
      this.recordAudit(principal, action, 'failed', requestId, {
        workspace,
        agentProfileVersionId: profileVersion.agentProfileVersionId,
        assetVersionIds: blockedAssets,
        errorCode: 'ASSET_UNAVAILABLE',
      })
      return
    }
    const now = new Date().toISOString()
    const traceId = `trace-${randomUUID().slice(0, 8)}`
    const assetVersionIds = assetVersionIdsOf(profileVersion)
    // §11.10：approval_required 时运行进入 awaiting_approval 并挂审批实体；
    // expires_at 可由调用方指定（缺省 +15 分钟），用于确定性的有效期判据。
    const approvalRequired = body.approval_required === true
    const expiresAt = typeof body.approval_expires_at === 'string' && !Number.isNaN(Date.parse(body.approval_expires_at))
      ? body.approval_expires_at
      : new Date(this.clock() + 15 * 60 * 1000).toISOString()
    const initialStatus: RunStatus = approvalRequired ? 'awaiting_approval' : 'preparing'
    const run: RunRecord = {
      runId: `run-${randomUUID().slice(0, 8)}`,
      projectId: workspace.projectId,
      workspaceId: workspace.workspaceId,
      sessionId,
      agentProfileVersionId: profileVersion.agentProfileVersionId,
      assetVersionIds,
      // 绑定时冻结（§11.18 A）：此后撤回不得改写这一份事实。
      assetSnapshot: this.freezeAssets(assetVersionIds),
      executionPolicy: { ...profileVersion.executionPolicy },
      workspaceRevision: workspace.revision,
      status: initialStatus,
      writeMode,
      ...(writeMode === 'write' ? { leaseId: `lease-${randomUUID().slice(0, 8)}` } : {}),
      revision: 1,
      ...(referencedPlan === undefined ? {} : { planId: referencedPlan.planId }),
      ...(approvalRequired
        ? { approval: this.buildApproval(this.runWorkspaceAffected(workspace), assetVersionIds, writeMode, expiresAt, now) }
        : {}),
      errorCode: undefined,
      createdAt: now,
      updatedAt: now,
      ...(approvalRequired ? {} : { transitionAt: this.clock() + 40 }),
      traceId,
      timeline: [{
        status: initialStatus,
        at: now,
        reason: approvalRequired ? '写入运行等待审批' : 'Run 已创建',
        operator: principal.displayName,
        policyVersion: profileVersion.agentProfileVersionId,
        revision: 1,
        traceId,
      }],
    }
    this.runs.set(run.runId, run)
    this.appendEvent('run', run.runId, 1, 'run.updated', {
      project_id: run.projectId,
      workspace_id: run.workspaceId,
      status: run.status,
    })
    this.recordAudit(principal, action, 'succeeded', requestId, { workspace, run })
    const dto = toRunDto(run)
    this.remember(claim, dto, 202)
    this.sendJson(response, 202, requestId, dto)
  }

  /**
   * 校验计划内容体（创建与编辑共用）：goal/steps/agent_profile_version_id 必填，
   * asset_version_ids 必须是所选版本的资产子集，depends_on 下标必须在范围内。
   * 校验失败直接写响应并返回 undefined。
   */
  private planContent(
    body: Record<string, unknown>,
    workspace: WorkspaceRecord,
    requestId: string,
    response: ServerResponse,
  ): {
    readonly goal: string
    readonly steps: PlanStepRecord[]
    readonly agentProfileVersionId: string
    readonly assetVersionIds: readonly string[]
  } | undefined {
    const rawGoal = body.goal
    if (typeof rawGoal !== 'string' || rawGoal.trim().length === 0 || rawGoal.length > 2000) {
      this.fail(response, 422, requestId, 'VALIDATION_ERROR', 'goal 必填且不超过 2000 字符')
      return undefined
    }
    const rawSteps = body.steps
    if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
      this.fail(response, 422, requestId, 'VALIDATION_ERROR', 'steps 必须是非空数组')
      return undefined
    }
    const steps: PlanStepRecord[] = []
    for (const rawStep of rawSteps) {
      if (typeof rawStep !== 'object' || rawStep === null) {
        this.fail(response, 422, requestId, 'VALIDATION_ERROR', 'steps 每项必须是对象')
        return undefined
      }
      const stepBody = rawStep as Record<string, unknown>
      const title = stepBody['title']
      if (typeof title !== 'string' || title.trim().length === 0 || title.length > 500) {
        this.fail(response, 422, requestId, 'VALIDATION_ERROR', '步骤 title 必填且不超过 500 字符')
        return undefined
      }
      let dependsOn: number[] = []
      const rawDepends = stepBody['depends_on']
      if (rawDepends !== undefined) {
        if (
          !Array.isArray(rawDepends) ||
          rawDepends.some(entry => typeof entry !== 'number' || !Number.isInteger(entry) || entry < 0 || entry >= rawSteps.length)
        ) {
          this.fail(response, 422, requestId, 'VALIDATION_ERROR', 'depends_on 必须是步骤下标数组且在范围内')
          return undefined
        }
        dependsOn = [...new Set(rawDepends as number[])]
      }
      steps.push({ title: title.trim(), dependsOn })
    }
    const rawVersionId = body.agent_profile_version_id
    if (typeof rawVersionId !== 'string' || rawVersionId.length === 0) {
      this.fail(response, 422, requestId, 'VALIDATION_ERROR', 'agent_profile_version_id 必填')
      return undefined
    }
    const profileVersion = this.findBoundPublishedVersion(workspace.projectId, rawVersionId)
    if (profileVersion === undefined) {
      this.fail(response, 403, requestId, 'FORBIDDEN', '当前项目无权使用该 Agent 配置版本')
      return undefined
    }
    const allowedAssets = new Set(assetVersionIdsOf(profileVersion))
    const rawAssets = body.asset_version_ids
    let assetVersionIds: readonly string[] = assetVersionIdsOf(profileVersion)
    if (rawAssets !== undefined) {
      if (!Array.isArray(rawAssets) || rawAssets.some(entry => typeof entry !== 'string')) {
        this.fail(response, 422, requestId, 'VALIDATION_ERROR', 'asset_version_ids 必须是字符串数组')
        return undefined
      }
      if ((rawAssets as string[]).some(entry => !allowedAssets.has(entry))) {
        this.fail(response, 422, requestId, 'VALIDATION_ERROR', 'asset_version_ids 必须是所选 Agent 配置版本自身的资产子集')
        return undefined
      }
      assetVersionIds = [...new Set(rawAssets as string[])]
    }
    return {
      goal: rawGoal.trim(),
      steps,
      agentProfileVersionId: profileVersion.agentProfileVersionId,
      assetVersionIds,
    }
  }

  private async createPlan(
    request: IncomingMessage,
    response: ServerResponse,
    principal: AccountPrincipal,
    requestId: string,
    workspace: WorkspaceRecord,
  ): Promise<void> {
    const action = 'plan.create'
    const body = await readJsonBody(request, response, requestId)
    if (body === undefined) return
    const claim = this.claimMutation(request, principal, response, requestId, action, body)
    if (claim === undefined) return
    const content = this.planContent(body, workspace, requestId, response)
    if (content === undefined) {
      this.recordAudit(principal, action, 'failed', requestId, { workspace, errorCode: 'VALIDATION_ERROR' })
      return
    }
    const now = new Date().toISOString()
    const plan: PlanRecord = {
      planId: `plan-${randomUUID().slice(0, 8)}`,
      workspaceId: workspace.workspaceId,
      projectId: workspace.projectId,
      goal: content.goal,
      steps: content.steps,
      agentProfileVersionId: content.agentProfileVersionId,
      assetVersionIds: content.assetVersionIds,
      status: 'draft',
      revision: 1,
      createdBy: principal.userId,
      createdAt: now,
      updatedAt: now,
      edits: [],
    }
    this.plans.set(plan.planId, plan)
    this.recordAudit(principal, action, 'succeeded', requestId, { workspace })
    const dto = toPlanDto(plan)
    this.remember(claim, dto, 201)
    this.sendJson(response, 201, requestId, dto)
  }

  private async editPlan(
    request: IncomingMessage,
    response: ServerResponse,
    principal: AccountPrincipal,
    requestId: string,
    workspace: WorkspaceRecord,
    plan: PlanRecord,
  ): Promise<void> {
    const action = 'plan.edit'
    const body = await readJsonBody(request, response, requestId)
    if (body === undefined) return
    const claim = this.claimMutation(request, principal, response, requestId, action, body)
    if (claim === undefined) return
    // 仅 draft 可编辑：确认即冻结，越权编辑失败同样写审计（§11.6）。
    if (plan.status !== 'draft') {
      this.fail(response, 409, requestId, 'INVALID_STATE', '已确认计划不可编辑')
      this.recordAudit(principal, action, 'failed', requestId, { workspace, errorCode: 'INVALID_STATE' })
      return
    }
    const header = headerValueOf(request, 'if-match')
    if (header === undefined || header.length === 0) {
      this.fail(response, 400, requestId, 'IF_MATCH_REQUIRED', '编辑计划必须提供 If-Match')
      this.recordAudit(principal, action, 'failed', requestId, { workspace, errorCode: 'IF_MATCH_REQUIRED' })
      return
    }
    if (Number(header) !== plan.revision) {
      this.fail(response, 409, requestId, 'REVISION_CONFLICT', '计划已被其他编辑更新')
      this.recordAudit(principal, action, 'failed', requestId, { workspace, errorCode: 'REVISION_CONFLICT' })
      return
    }
    const rawSummary = body.change_summary
    if (typeof rawSummary !== 'string' || rawSummary.trim().length === 0 || rawSummary.length > 500) {
      this.fail(response, 422, requestId, 'VALIDATION_ERROR', 'change_summary 必填且不超过 500 字符')
      this.recordAudit(principal, action, 'failed', requestId, { workspace, errorCode: 'VALIDATION_ERROR' })
      return
    }
    // 未提供的字段保留当前值（部分更新），提供的字段走同一套校验。
    const merged = {
      goal: body.goal === undefined ? plan.goal : body.goal,
      steps: body.steps === undefined ? plan.steps.map(step => ({ title: step.title, depends_on: [...step.dependsOn] })) : body.steps,
      agent_profile_version_id: body.agent_profile_version_id === undefined ? plan.agentProfileVersionId : body.agent_profile_version_id,
      asset_version_ids: body.asset_version_ids === undefined ? [...plan.assetVersionIds] : body.asset_version_ids,
    }
    const content = this.planContent(merged, workspace, requestId, response)
    if (content === undefined) {
      this.recordAudit(principal, action, 'failed', requestId, { workspace, errorCode: 'VALIDATION_ERROR' })
      return
    }
    const now = new Date().toISOString()
    // 追加式历史：编辑记录携带编辑前完整内容快照，历史只增不改（§11.6）。
    plan.edits.push({
      editId: `edit-${randomUUID().slice(0, 8)}`,
      editorUserId: principal.userId,
      editor: principal.displayName,
      editedAt: now,
      changeSummary: rawSummary.trim(),
      revisionBefore: plan.revision,
      revisionAfter: plan.revision + 1,
      before: {
        goal: plan.goal,
        steps: plan.steps.map(step => ({ title: step.title, dependsOn: [...step.dependsOn] })),
        agentProfileVersionId: plan.agentProfileVersionId,
        assetVersionIds: [...plan.assetVersionIds],
      },
    })
    plan.goal = content.goal
    plan.steps = content.steps
    plan.agentProfileVersionId = content.agentProfileVersionId
    plan.assetVersionIds = content.assetVersionIds
    plan.revision += 1
    plan.updatedAt = now
    this.recordAudit(principal, action, 'succeeded', requestId, { workspace })
    const dto = toPlanDto(plan)
    this.remember(claim, dto, 200)
    this.sendJson(response, 200, requestId, dto)
  }

  private async confirmPlan(
    request: IncomingMessage,
    response: ServerResponse,
    principal: AccountPrincipal,
    requestId: string,
    workspace: WorkspaceRecord,
    plan: PlanRecord,
  ): Promise<void> {
    const action = 'plan.confirm'
    const body = await readJsonBody(request, response, requestId)
    if (body === undefined) return
    const claim = this.claimMutation(request, principal, response, requestId, action, body)
    if (claim === undefined) return
    if (plan.status !== 'draft') {
      this.fail(response, 409, requestId, 'INVALID_STATE', '计划已确认，不能重复确认')
      this.recordAudit(principal, action, 'failed', requestId, { workspace, errorCode: 'INVALID_STATE' })
      return
    }
    const now = new Date().toISOString()
    plan.status = 'confirmed'
    plan.confirmedBy = principal.userId
    plan.confirmedAt = now
    plan.revision += 1
    plan.updatedAt = now
    this.recordAudit(principal, action, 'succeeded', requestId, { workspace })
    const dto = toPlanDto(plan)
    this.remember(claim, dto, 200)
    this.sendJson(response, 200, requestId, dto)
  }

  private async cancelRun(
    request: IncomingMessage,
    response: ServerResponse,
    principal: AccountPrincipal,
    requestId: string,
    run: RunRecord,
  ): Promise<void> {
    const action = 'run.cancel'
    const body = await readJsonBody(request, response, requestId)
    if (body === undefined) return
    const claim = this.claimMutation(request, principal, response, requestId, action, body)
    if (claim === undefined) return
    if (!['preparing', 'awaiting_approval', 'running', 'paused', 'awaiting_user'].includes(run.status)) {
      this.fail(response, 409, requestId, 'INVALID_STATUS', `当前状态 ${run.status} 不允许取消`)
      this.recordAudit(principal, action, 'failed', requestId, { run, errorCode: 'INVALID_STATUS' })
      return
    }
    this.applyRunTransition(run, 'cancelled', { reason: '调用方取消', operator: principal.displayName })
    this.recordAudit(principal, action, 'succeeded', requestId, { run })
    const dto = toRunDto(run)
    this.remember(claim, dto, 200)
    this.sendJson(response, 200, requestId, dto)
  }

  private async retryRun(
    request: IncomingMessage,
    response: ServerResponse,
    principal: AccountPrincipal,
    requestId: string,
    run: RunRecord,
  ): Promise<void> {
    const action = 'run.retry'
    const body = await readJsonBody(request, response, requestId)
    if (body === undefined) return
    const claim = this.claimMutation(request, principal, response, requestId, action, body)
    if (claim === undefined) return
    const workspace = this.workspaces.get(run.workspaceId)
    if (workspace === undefined || workspace.status !== 'ready') {
      this.fail(response, 409, requestId, 'INVALID_STATUS', '工作空间当前不允许重试 Run')
      this.recordAudit(principal, action, 'failed', requestId, { run, errorCode: 'INVALID_STATUS' })
      return
    }
    if (expectedRevision(request, body) !== workspace.revision) {
      this.fail(response, 409, requestId, 'REVISION_CONFLICT', '工作空间 revision 已变化')
      this.recordAudit(principal, action, 'failed', requestId, { run, workspace, errorCode: 'REVISION_CONFLICT' })
      return
    }
    if (!['failed', 'cancelled', 'expired'].includes(run.status)) {
      this.fail(response, 409, requestId, 'INVALID_STATUS', `当前状态 ${run.status} 不允许重试`)
      this.recordAudit(principal, action, 'failed', requestId, { run, errorCode: 'INVALID_STATUS' })
      return
    }
    if (run.writeMode === 'write') {
      const activeWrite = this.activeWriteRun(run.workspaceId)
      if (activeWrite !== undefined) {
        this.failWithPayload(response, 409, requestId, 'WORKSPACE_BUSY', '同一工作空间已存在写入 Run', {
          current_run: toRunDto(this.advanceRun(activeWrite)),
        })
        this.recordAudit(principal, action, 'failed', requestId, { run, workspace, errorCode: 'WORKSPACE_BUSY' })
        return
      }
    }
    const now = new Date().toISOString()
    const retried: RunRecord = {
      ...run,
      runId: `run-${randomUUID().slice(0, 8)}`,
      revision: 1,
      status: 'preparing',
      ...(run.writeMode === 'write' ? { leaseId: `lease-${randomUUID().slice(0, 8)}` } : {}),
      retryOfRunId: run.runId,
      workspaceRevision: workspace.revision,
      createdAt: now,
      updatedAt: now,
      transitionAt: this.clock() + 40,
      timeline: [{
        status: 'preparing',
        at: now,
        reason: `重试自 ${run.runId}`,
        operator: principal.displayName,
        policyVersion: run.agentProfileVersionId,
        revision: 1,
        traceId: `trace-${randomUUID().slice(0, 8)}`,
      }],
    }
    this.runs.set(retried.runId, retried)
    this.appendEvent('run', retried.runId, 1, 'run.updated', {
      project_id: retried.projectId,
      workspace_id: retried.workspaceId,
      status: 'preparing',
      retry_of: run.runId,
    })
    this.recordAudit(principal, action, 'succeeded', requestId, { run: retried, workspace })
    const dto = toRunDto(retried)
    this.remember(claim, dto, 202)
    this.sendJson(response, 202, requestId, dto)
  }

  /** 暂停运行并保存检查点（§11.8）：六类状态由服务端落账。 */
  private async pauseRun(
    request: IncomingMessage,
    response: ServerResponse,
    principal: AccountPrincipal,
    requestId: string,
    workspace: WorkspaceRecord,
    run: RunRecord,
  ): Promise<void> {
    const action = 'run.pause'
    const body = await readJsonBody(request, response, requestId)
    if (body === undefined) return
    const claim = this.claimMutation(request, principal, response, requestId, action, body)
    if (claim === undefined) return
    if (!['running', 'awaiting_approval'].includes(run.status)) {
      this.fail(response, 409, requestId, 'INVALID_STATUS', `当前状态 ${run.status} 不允许暂停`)
      this.recordAudit(principal, action, 'failed', requestId, { workspace, run, errorCode: 'INVALID_STATUS' })
      return
    }
    const sessionSeq = body.session_seq
    if (typeof sessionSeq !== 'number' || !Number.isInteger(sessionSeq) || sessionSeq < 0) {
      this.fail(response, 422, requestId, 'VALIDATION_ERROR', 'session_seq 必须是非负整数')
      this.recordAudit(principal, action, 'failed', requestId, { workspace, run, errorCode: 'VALIDATION_ERROR' })
      return
    }
    const rawTools = body.tool_results
    if (rawTools !== undefined && !Array.isArray(rawTools)) {
      this.fail(response, 422, requestId, 'VALIDATION_ERROR', 'tool_results 必须是数组')
      this.recordAudit(principal, action, 'failed', requestId, { workspace, run, errorCode: 'VALIDATION_ERROR' })
      return
    }
    const toolResults: Array<{ readonly call_id: string; readonly tool: string; readonly result: string }> = []
    for (const entry of (rawTools ?? []) as Array<unknown>) {
      if (typeof entry !== 'object' || entry === null) {
        this.fail(response, 422, requestId, 'VALIDATION_ERROR', 'tool_results 每项必须是对象')
        this.recordAudit(principal, action, 'failed', requestId, { workspace, run, errorCode: 'VALIDATION_ERROR' })
        return
      }
      const record = entry as Record<string, unknown>
      if (typeof record['call_id'] !== 'string' || typeof record['tool'] !== 'string' || typeof record['result'] !== 'string') {
        this.fail(response, 422, requestId, 'VALIDATION_ERROR', 'tool_results 每项必须携带 call_id/tool/result 字符串')
        this.recordAudit(principal, action, 'failed', requestId, { workspace, run, errorCode: 'VALIDATION_ERROR' })
        return
      }
      toolResults.push({ call_id: record['call_id'], tool: record['tool'], result: record['result'] })
    }
    let completedSteps: readonly number[] = []
    if (body.completed_steps !== undefined) {
      if (!Array.isArray(body.completed_steps)) {
        this.fail(response, 422, requestId, 'VALIDATION_ERROR', 'completed_steps 必须是下标数组')
        return
      }
      completedSteps = [...new Set(body.completed_steps as number[])]
    }
    if (run.planId !== undefined) {
      const plan = this.plans.get(run.planId)
      const stepCount = plan?.steps.length ?? 0
      if (completedSteps.some(index => index < 0 || index >= stepCount)) {
        this.fail(response, 422, requestId, 'VALIDATION_ERROR', 'completed_steps 下标必须落在引用计划的步骤范围内')
        this.recordAudit(principal, action, 'failed', requestId, { workspace, run, errorCode: 'VALIDATION_ERROR' })
        return
      }
    } else if (completedSteps.length > 0) {
      this.fail(response, 422, requestId, 'VALIDATION_ERROR', '运行未引用计划，不能声明已完成步骤')
      this.recordAudit(principal, action, 'failed', requestId, { workspace, run, errorCode: 'VALIDATION_ERROR' })
      return
    }
    const pendingApproval = typeof body.pending_approval === 'object' && body.pending_approval !== null
      ? body.pending_approval as Readonly<Record<string, unknown>>
      : null
    run.checkpoint = {
      checkpointId: `cp-${randomUUID().slice(0, 8)}`,
      createdAt: new Date().toISOString(),
      traceId: run.traceId,
      sessionSeq,
      toolResults,
      pendingApproval,
      completedSteps,
      agentConfig: {
        agentProfileVersionId: run.agentProfileVersionId,
        executionPolicy: { ...run.executionPolicy },
      },
      assetVersionIds: [...run.assetVersionIds],
      workspaceRevision: workspace.revision,
      planId: run.planId ?? null,
      steps: run.planId === undefined ? undefined : this.plans.get(run.planId)?.steps.map(step => step.title),
      consumed: false,
      consumedAt: null,
    }
    run.checkpoints = [...(run.checkpoints ?? []), run.checkpoint]
    this.applyRunTransition(run, 'paused', { reason: '暂停并保存检查点', operator: principal.displayName })
    this.recordAudit(principal, action, 'succeeded', requestId, { workspace, run })
    const dto = toRunDto(run)
    this.remember(claim, dto, 200)
    this.sendJson(response, 200, requestId, dto)
  }

  /** 恢复运行（§11.8）：continue 保留工具结果与会话序号，replay 清空重执行。 */
  private async resumeRun(
    request: IncomingMessage,
    response: ServerResponse,
    principal: AccountPrincipal,
    requestId: string,
    workspace: WorkspaceRecord,
    run: RunRecord,
  ): Promise<void> {
    const action = 'run.resume'
    const body = await readJsonBody(request, response, requestId)
    if (body === undefined) return
    const claim = this.claimMutation(request, principal, response, requestId, action, body)
    if (claim === undefined) return
    if (run.status !== 'paused') {
      this.fail(response, 409, requestId, 'INVALID_STATUS', run.checkpoint === undefined
        ? '运行没有检查点，不能恢复'
        : `当前状态 ${run.status} 不允许恢复`)
      this.recordAudit(principal, action, 'failed', requestId, { workspace, run, errorCode: 'INVALID_STATUS' })
      return
    }
    const mode = body.mode
    if (mode !== 'continue' && mode !== 'replay') {
      this.fail(response, 422, requestId, 'VALIDATION_ERROR', "mode 必须是 'continue' 或 'replay'")
      this.recordAudit(principal, action, 'failed', requestId, { workspace, run, errorCode: 'VALIDATION_ERROR' })
      return
    }
    if (run.checkpoint === undefined) {
      this.fail(response, 409, requestId, 'INVALID_STATUS', '运行没有检查点，不能恢复')
      return
    }
    const checkpoint = run.checkpoint
    if (mode === 'replay') {
      checkpoint.toolResults = []
      checkpoint.sessionSeq = 0
    }
    checkpoint.consumed = true
    checkpoint.consumedAt = new Date().toISOString()
    this.applyRunTransition(run, 'preparing', {
      reason: mode === 'continue' ? '从检查点继续：重用已保留的工具结果' : '从检查点重放：已执行结果清空，剩余工作重新执行',
      operator: principal.displayName,
    })
    run.transitionAt = this.clock() + 40
    this.recordAudit(principal, action, 'succeeded', requestId, { workspace, run })
    const dto = toRunDto(run)
    this.remember(claim, dto, 200)
    this.sendJson(response, 200, requestId, dto)
  }

  private async issuePreviewUrl(
    request: IncomingMessage,
    response: ServerResponse,
    principal: AccountPrincipal,
    requestId: string,
    workspace: WorkspaceRecord,
  ): Promise<void> {
    const action = 'preview.issue'
    const body = await readJsonBody(request, response, requestId)
    if (body === undefined) return
    const claim = this.claimMutation(request, principal, response, requestId, action, body)
    if (claim === undefined) return
    if (body.target_url !== undefined || typeof body.port !== 'number' || !Number.isFinite(body.port)) {
      this.fail(response, 422, requestId, 'VALIDATION_ERROR', '仅接受受控 workspace_app 端口，不接受目标 URL')
      this.recordAudit(principal, action, 'failed', requestId, { workspace, errorCode: 'VALIDATION_ERROR' })
      return
    }
    if (workspace.status !== 'ready' || body.app !== 'workspace_app' || body.port !== 3000) {
      this.fail(response, 403, requestId, 'PREVIEW_DENIED', '仅允许就绪工作空间的受控应用端口')
      this.recordAudit(principal, action, 'failed', requestId, { workspace, errorCode: 'PREVIEW_DENIED' })
      return
    }
    const grant = {
      url: `https://workspace-app.fixture.internal/${workspace.workspaceId}/p/${randomUUID().slice(0, 8)}`,
      expires_at: new Date(this.clock() + 300_000).toISOString(),
      workspace_id: workspace.workspaceId,
    }
    this.recordAudit(principal, action, 'succeeded', requestId, { workspace })
    this.remember(claim, grant, 200)
    this.sendJson(response, 200, requestId, grant)
  }

  private async gitCommit(
    request: IncomingMessage,
    response: ServerResponse,
    principal: AccountPrincipal,
    requestId: string,
    workspace: WorkspaceRecord,
  ): Promise<void> {
    const action = 'git.commit'
    const body = await readJsonBody(request, response, requestId)
    if (body === undefined) return
    const claim = this.claimMutation(request, principal, response, requestId, action, body)
    if (claim === undefined) return
    if (typeof body.message !== 'string' || (body.message).length === 0) {
      this.fail(response, 422, requestId, 'VALIDATION_ERROR', 'message 必填')
      return
    }
    if (expectedRevision(request, body) !== workspace.revision) {
      this.fail(response, 409, requestId, 'REVISION_CONFLICT', '工作空间已被其他修改更新')
      this.recordAudit(principal, action, 'failed', requestId, { workspace, errorCode: 'REVISION_CONFLICT' })
      return
    }
    this.clearChanges(workspace)
    const dto = { committed: true, revision: workspace.revision }
    this.recordAudit(principal, action, 'succeeded', requestId, { workspace })
    this.remember(claim, dto, 200)
    this.sendJson(response, 200, requestId, dto)
  }

  private async gitPullRequest(
    request: IncomingMessage,
    response: ServerResponse,
    principal: AccountPrincipal,
    requestId: string,
    workspace: WorkspaceRecord,
  ): Promise<void> {
    const action = 'git.pull_request'
    const body = await readJsonBody(request, response, requestId)
    if (body === undefined) return
    const claim = this.claimMutation(request, principal, response, requestId, action, body)
    if (claim === undefined) return
    if (typeof body.title !== 'string' || (body.title).length === 0) {
      this.fail(response, 422, requestId, 'VALIDATION_ERROR', 'title 必填')
      return
    }
    if (expectedRevision(request, body) !== workspace.revision) {
      this.fail(response, 409, requestId, 'REVISION_CONFLICT', '工作空间已被其他修改更新')
      this.recordAudit(principal, action, 'failed', requestId, { workspace, errorCode: 'REVISION_CONFLICT' })
      return
    }
    const dto = { pull_request_id: `pr-${randomUUID().slice(0, 8)}`, title: body.title }
    this.recordAudit(principal, action, 'succeeded', requestId, { workspace })
    this.remember(claim, dto, 200)
    this.sendJson(response, 200, requestId, dto)
  }

  private async discardChanges(
    request: IncomingMessage,
    response: ServerResponse,
    principal: AccountPrincipal,
    requestId: string,
    workspace: WorkspaceRecord,
  ): Promise<void> {
    const action = 'changes.discard'
    const body = await readJsonBody(request, response, requestId)
    if (body === undefined) return
    const claim = this.claimMutation(request, principal, response, requestId, action, body)
    if (claim === undefined) return
    if (expectedRevision(request, body) !== workspace.revision) {
      this.fail(response, 409, requestId, 'REVISION_CONFLICT', '工作空间已被其他修改更新')
      this.recordAudit(principal, action, 'failed', requestId, { workspace, errorCode: 'REVISION_CONFLICT' })
      return
    }
    this.clearChanges(workspace)
    const dto = { discarded: true, revision: workspace.revision }
    this.recordAudit(principal, action, 'succeeded', requestId, { workspace })
    this.remember(claim, dto, 200)
    this.sendJson(response, 200, requestId, dto)
  }

  // --- agent profile admin mutations --------------------------------------------

  private async createAdminProfile(
    request: IncomingMessage,
    response: ServerResponse,
    principal: AccountPrincipal,
    requestId: string,
  ): Promise<void> {
    const action = 'agent_profile.create'
    const body = await readJsonBody(request, response, requestId)
    if (body === undefined) return
    const claim = this.claimMutation(request, principal, response, requestId, action, body)
    if (claim === undefined) return
    const name = typeof body.name === 'string' ? body.name : ''
    const agentTypeId = typeof body.agent_type_id === 'string' ? body.agent_type_id : ''
    if (name.length === 0 || this.findAgentType(agentTypeId) === undefined) {
      this.fail(response, 422, requestId, 'VALIDATION_ERROR', 'name 与有效 agent_type_id 必填')
      return
    }
    const organizationId = typeof body.organization_id === 'string' && body.organization_id.length > 0
      ? body.organization_id
      : 'org-alpha'
    if (!canAdministerWorkspace(this.accounts, principal, organizationId)) {
      this.fail(response, 403, requestId, 'FORBIDDEN', '当前账号无权创建该组织的 Agent 配置')
      this.recordAudit(principal, action, 'failed', requestId, { errorCode: 'FORBIDDEN' })
      return
    }
    const fields = this.resolveProfileMutationFields(body, agentTypeId)
    if ('error' in fields) {
      this.fail(response, 422, requestId, 'VALIDATION_ERROR', fields.error)
      this.recordAudit(principal, action, 'failed', requestId, { errorCode: 'VALIDATION_ERROR' })
      return
    }
    const now = new Date().toISOString()
    const profile: AgentProfileRecord = {
      agentProfileId: `ap-${randomUUID().slice(0, 8)}`,
      organizationId,
      name,
      description: fields.description ?? '',
      agentTypeId,
      revision: 1,
      createdBy: principal.displayName,
      createdAt: now,
      updatedAt: now,
      versions: [{
        agentProfileVersionId: `apv-${randomUUID().slice(0, 8)}`,
        version: 'v1',
        status: 'draft',
        model: fields.model ?? '',
        reasoning: fields.reasoning ?? '',
        skills: fields.bindings?.skills ?? [],
        knowledgeBases: fields.bindings?.knowledgeBases ?? [],
        memory: fields.bindings?.memory ?? null,
        executionPolicy: fields.policy ?? {},
        typeExtensionConfig: fields.extensions ?? {},
        credentialRef: fields.credential ?? null,
        changeSummary: '初始草稿',
      }],
      projectBindings: new Map(),
    }
    this.agentProfiles.push(profile)
    this.recordAudit(principal, action, 'succeeded', requestId, { profile })
    this.emitProfileEvent(profile, 'agent_profile.created')
    const dto = toAdminProfileDto(profile, this.agentTypes)
    this.remember(claim, dto, 201)
    this.sendJson(response, 201, requestId, dto)
  }

  /** Creates a fresh draft version from the current config; the profile revision guards concurrent edits. */
  private async createAdminProfileVersion(
    request: IncomingMessage,
    response: ServerResponse,
    principal: AccountPrincipal,
    requestId: string,
    profile: AgentProfileRecord,
  ): Promise<void> {
    const action = 'agent_profile.version.create'
    const body = await readJsonBody(request, response, requestId)
    if (body === undefined) return
    const claim = this.claimMutation(request, principal, response, requestId, action, body)
    if (claim === undefined) return
    if (!canAdministerWorkspace(this.accounts, principal, profile.organizationId)) {
      this.fail(response, 403, requestId, 'FORBIDDEN', '当前账号无权修改该配置')
      this.recordAudit(principal, action, 'failed', requestId, { profile, errorCode: 'FORBIDDEN' })
      return
    }
    if (expectedRevision(request, body) !== profile.revision) {
      this.fail(response, 409, requestId, 'REVISION_CONFLICT', '配置已被其他修改更新')
      this.recordAudit(principal, action, 'failed', requestId, { profile, errorCode: 'REVISION_CONFLICT' })
      return
    }
    const latest = profile.versions.at(-1)
    if (latest === undefined) {
      this.fail(response, 409, requestId, 'INVALID_STATUS', '配置缺少基线版本')
      return
    }
    const fields = this.resolveProfileMutationFields(body, profile.agentTypeId)
    if ('error' in fields) {
      this.fail(response, 422, requestId, 'VALIDATION_ERROR', fields.error)
      this.recordAudit(principal, action, 'failed', requestId, { profile, errorCode: 'VALIDATION_ERROR' })
      return
    }
    const version: AgentProfileVersionRecord = {
      agentProfileVersionId: `apv-${randomUUID().slice(0, 8)}`,
      version: `v${profile.versions.length + 1}`,
      status: 'draft',
      model: fields.model ?? latest.model,
      reasoning: fields.reasoning ?? latest.reasoning,
      skills: fields.bindings?.skills ?? latest.skills,
      knowledgeBases: fields.bindings?.knowledgeBases ?? latest.knowledgeBases,
      memory: fields.bindings ? fields.bindings.memory : latest.memory,
      executionPolicy: fields.policy ?? latest.executionPolicy,
      typeExtensionConfig: fields.extensions ?? latest.typeExtensionConfig,
      credentialRef: fields.credential !== undefined ? fields.credential : latest.credentialRef,
      changeSummary: typeof body.change_summary === 'string' && body.change_summary.length > 0 ? body.change_summary : '新草稿版本',
    }
    profile.versions.push(version)
    profile.revision += 1
    profile.updatedAt = new Date().toISOString()
    this.recordAudit(principal, action, 'succeeded', requestId, { profile, profileVersion: version })
    this.emitProfileEvent(profile, 'agent_profile.version_created', { agent_profile_version_id: version.agentProfileVersionId })
    const dto = toVersionDto(version)
    this.remember(claim, dto, 201)
    this.sendJson(response, 201, requestId, dto)
  }

  /** Clones a profile into a brand-new draft: new opaque id, no bindings, no published state. */
  private async cloneAdminProfile(
    request: IncomingMessage,
    response: ServerResponse,
    principal: AccountPrincipal,
    requestId: string,
    profile: AgentProfileRecord,
  ): Promise<void> {
    const action = 'agent_profile.clone'
    const body = await readJsonBody(request, response, requestId)
    if (body === undefined) return
    const claim = this.claimMutation(request, principal, response, requestId, action, body)
    if (claim === undefined) return
    if (!canAdministerWorkspace(this.accounts, principal, profile.organizationId)) {
      this.fail(response, 403, requestId, 'FORBIDDEN', '当前账号无权复制该配置')
      this.recordAudit(principal, action, 'failed', requestId, { profile, errorCode: 'FORBIDDEN' })
      return
    }
    const source = profile.versions.at(-1)
    if (source === undefined) {
      this.fail(response, 409, requestId, 'INVALID_STATUS', '配置缺少可复制的版本')
      return
    }
    const now = new Date().toISOString()
    const clone: AgentProfileRecord = {
      agentProfileId: `ap-${randomUUID().slice(0, 8)}`,
      organizationId: profile.organizationId,
      name: `${profile.name} 副本`,
      description: profile.description,
      agentTypeId: profile.agentTypeId,
      revision: 1,
      createdBy: principal.displayName,
      createdAt: now,
      updatedAt: now,
      versions: [{
        agentProfileVersionId: `apv-${randomUUID().slice(0, 8)}`,
        version: 'v1',
        status: 'draft',
        model: source.model,
        reasoning: source.reasoning,
        skills: [...source.skills],
        knowledgeBases: [...source.knowledgeBases],
        memory: source.memory === null ? null : { ...source.memory },
        executionPolicy: { ...source.executionPolicy },
        typeExtensionConfig: { ...source.typeExtensionConfig },
        credentialRef: source.credentialRef === null ? null : { ...source.credentialRef },
        changeSummary: `复制自 ${profile.agentProfileId}`,
      }],
      projectBindings: new Map(),
    }
    this.agentProfiles.push(clone)
    this.recordAudit(principal, action, 'succeeded', requestId, { profile: clone })
    this.emitProfileEvent(clone, 'agent_profile.cloned')
    const dto = toAdminProfileDto(clone, this.agentTypes)
    this.remember(claim, dto, 201)
    this.sendJson(response, 201, requestId, dto)
  }

  /**
   * 配置试运行（§11.12）：只执行准备与上下文装配校验，不改状态、无外部副作用；
   * 检查闭集 asset_authorized/asset_ready/version_state/context_assembly。
   */
  private dryRunProfileVersion(
    response: ServerResponse,
    principal: AccountPrincipal,
    requestId: string,
    profile: AgentProfileRecord,
    versionId: string,
  ): void {
    const version = profile.versions.find(candidate => candidate.agentProfileVersionId === versionId)
    if (version === undefined) {
      this.fail(response, 404, requestId, 'RESOURCE_NOT_FOUND', '配置版本不存在')
      return
    }
    const unauthorized: string[] = []
    const notReady: string[] = []
    for (const reference of assetVersionIdsOf(version)) {
      const match = /^(skill|knowledge|memory):([^@]+)(?:@(.+))?$/u.exec(reference)
      const exists = match !== null && (this.options.assetExists?.(match[1] as 'skill' | 'knowledge' | 'memory', match[2] ?? '', match[3]) ?? true)
      if (!exists) unauthorized.push(reference)
      const catalog = assetCatalogEntryFor(reference)
      if (catalog !== undefined && catalog.readiness !== 'ready') notReady.push(reference)
    }
    const skillCount = version.skills.length
    const knowledgeCount = version.knowledgeBases.length
    const memoryCount = version.memory === null ? 0 : 1
    const checks = [
      {
        check: 'asset_authorized',
        result: unauthorized.length === 0 ? 'pass' : 'fail',
        detail: unauthorized.length === 0 ? '全部绑定资产已授权给项目' : `未授权资产：${unauthorized.join('、')}`,
      },
      {
        check: 'asset_ready',
        result: notReady.length === 0 ? 'pass' : 'fail',
        detail: notReady.length === 0 ? '全部绑定资产就绪' : `未就绪资产：${notReady.join('、')}`,
      },
      {
        check: 'version_state',
        result: version.status === 'published' ? 'pass' : version.status === 'draft' ? 'warn' : 'fail',
        detail: version.status === 'published'
          ? '已发布版本'
          : version.status === 'draft'
            ? '草稿版本，发布前需完成审核'
            : `版本状态 ${version.status} 不允许装配`,
      },
      {
        check: 'context_assembly',
        result: 'pass',
        detail: `上下文装配就绪：Skill ${skillCount} 层、知识 ${knowledgeCount} 层、记忆 ${memoryCount} 层`,
      },
    ]
    const outcome = checks.some(check => check.result === 'fail') ? 'blocked' : 'ready'
    this.recordAudit(principal, 'agent_profile.dry_run', 'succeeded', requestId, { profile, profileVersion: version })
    this.sendJson(response, 200, requestId, {
      dry_run_id: `dry-${randomUUID().slice(0, 8)}`,
      agent_profile_version_id: version.agentProfileVersionId,
      outcome,
      checks,
      created_at: new Date().toISOString(),
      fixture_only: true,
    })
  }

  private async adminVersionTransition(
    request: IncomingMessage,
    response: ServerResponse,
    principal: AccountPrincipal,
    requestId: string,
    profile: AgentProfileRecord,
    operation: string,
    versionId: string,
  ): Promise<void> {
    if (operation !== 'publish' && operation !== 'archive') {
      this.fail(response, 404, requestId, 'RESOURCE_NOT_FOUND', '资源不存在')
      return
    }
    const action = `agent_profile.version.${operation}`
    const body = await readJsonBody(request, response, requestId)
    if (body === undefined) return
    const claim = this.claimMutation(request, principal, response, requestId, action, body)
    if (claim === undefined) return
    if (!canAdministerWorkspace(this.accounts, principal, profile.organizationId)) {
      this.fail(response, 403, requestId, 'FORBIDDEN', '当前账号无权操作该配置')
      this.recordAudit(principal, action, 'failed', requestId, { profile, errorCode: 'FORBIDDEN' })
      return
    }
    if (expectedRevision(request, body) !== profile.revision) {
      this.fail(response, 409, requestId, 'REVISION_CONFLICT', '配置已被其他修改更新')
      this.recordAudit(principal, action, 'failed', requestId, { profile, errorCode: 'REVISION_CONFLICT' })
      return
    }
    const version = profile.versions.find(candidate => candidate.agentProfileVersionId === versionId)
    if (version === undefined) {
      this.fail(response, 404, requestId, 'RESOURCE_NOT_FOUND', '资源不存在')
      return
    }
    if (operation === 'publish') {
      if (version.status !== 'draft') {
        this.fail(response, 409, requestId, 'INVALID_STATUS', `版本状态 ${version.status} 不允许发布`)
        this.recordAudit(principal, action, 'failed', requestId, { profile, profileVersion: version, errorCode: 'INVALID_STATUS' })
        return
      }
      const agentType = this.findAgentType(profile.agentTypeId)
      if (agentType === undefined || agentType.readiness === 'unavailable') {
        this.fail(response, 422, requestId, 'AGENT_TYPE_UNAVAILABLE', `Agent 类型不可用，禁止发布：${profile.agentTypeId}`)
        this.recordAudit(principal, action, 'failed', requestId, { profile, profileVersion: version, errorCode: 'AGENT_TYPE_UNAVAILABLE' })
        return
      }
      // 模型能力匹配的 fixture 子集:发布版本必须声明非空模型,否则 Run 无从执行。
      if (version.model.length === 0) {
        this.fail(response, 422, requestId, 'VALIDATION_ERROR', '模型必填，禁止发布没有模型的版本')
        this.recordAudit(principal, action, 'failed', requestId, { profile, profileVersion: version, errorCode: 'VALIDATION_ERROR' })
        return
      }
      const missingExtensions = missingRequiredExtensions(agentType, version.typeExtensionConfig)
      if (missingExtensions.length > 0) {
        this.fail(response, 422, requestId, 'VALIDATION_ERROR', `缺少类型必填扩展字段：${missingExtensions.join('、')}`)
        this.recordAudit(principal, action, 'failed', requestId, { profile, profileVersion: version, errorCode: 'VALIDATION_ERROR' })
        return
      }
      const references = assetVersionIdsOf(version)
      const missing = this.missingAssets(references)
      if (missing.length > 0) {
        this.failWithDetails(response, 422, requestId, 'ASSET_NOT_FOUND', `资产版本不存在，禁止发布：${missing.join('、')}`, { missing_assets: missing })
        this.recordAudit(principal, action, 'failed', requestId, { profile, profileVersion: version, errorCode: 'ASSET_NOT_FOUND' })
        return
      }
      // Catalog readiness and per-project authorization: an unavailable or
      // unauthorized asset blocks the publish with its concrete reason.
      const block = assetPublishBlock(references, [...profile.projectBindings.keys()], (projectId, reference) => {
        const keys = this.accounts.projectAssetKeys(projectId) ?? []
        return keys.includes(assetAuthorizationKey(reference))
      })
      if (block !== null) {
        this.fail(response, 422, requestId, block.code, block.message)
        this.recordAudit(principal, action, 'failed', requestId, { profile, profileVersion: version, errorCode: block.code })
        return
      }
      // 凭据 readiness 语义：要求凭据的类型，缺失/未知/未授权/未就绪一律 CREDENTIAL_NOT_READY；
      // 类型声明 credential_required=false 时，缺失是受支持的合法选择。
      if (agentType.credentialRequired && version.credentialRef === null) {
        this.fail(response, 422, requestId, 'CREDENTIAL_NOT_READY', `${agentType.name} 要求凭据引用，禁止发布缺失凭据的版本`)
        this.recordAudit(principal, action, 'failed', requestId, { profile, profileVersion: version, errorCode: 'CREDENTIAL_NOT_READY' })
        return
      }
      if (version.credentialRef !== null && (!version.credentialRef.authorized || version.credentialRef.readiness !== 'ready')) {
        this.fail(response, 422, requestId, 'CREDENTIAL_NOT_READY', `凭据引用 ${version.credentialRef.name} 未授权或未就绪，禁止发布`)
        this.recordAudit(principal, action, 'failed', requestId, { profile, profileVersion: version, errorCode: 'CREDENTIAL_NOT_READY' })
        return
      }
      version.status = 'published'
      version.publishedAt = new Date().toISOString()
      version.publishedBy = principal.displayName
      profile.revision += 1
      profile.updatedAt = version.publishedAt
      this.emitProfileEvent(profile, 'agent_profile.published', { agent_profile_version_id: version.agentProfileVersionId })
    } else {
      if (version.status !== 'published') {
        this.fail(response, 409, requestId, 'INVALID_STATUS', `版本状态 ${version.status} 不允许归档`)
        this.recordAudit(principal, action, 'failed', requestId, { profile, profileVersion: version, errorCode: 'INVALID_STATUS' })
        return
      }
      version.status = 'archived'
      profile.revision += 1
      profile.updatedAt = new Date().toISOString()
      this.emitProfileEvent(profile, 'agent_profile.archived', { agent_profile_version_id: version.agentProfileVersionId })
    }
    this.recordAudit(principal, action, 'succeeded', requestId, { profile, profileVersion: version })
    const dto = toVersionDto(version)
    this.remember(claim, dto, 200)
    this.sendJson(response, 200, requestId, dto)
  }

  private async adminProjectBinding(
    request: IncomingMessage,
    response: ServerResponse,
    principal: AccountPrincipal,
    requestId: string,
    profile: AgentProfileRecord,
    projectId: string,
    method: string,
  ): Promise<void> {
    const action = method === 'PUT' ? 'agent_profile.bind' : 'agent_profile.unbind'
    const body = await readJsonBody(request, response, requestId)
    if (body === undefined) return
    const claim = this.claimMutation(request, principal, response, requestId, action, body)
    if (claim === undefined) return
    if (!canAdministerWorkspace(this.accounts, principal, profile.organizationId)) {
      this.fail(response, 403, requestId, 'FORBIDDEN', '当前账号无权操作该配置')
      this.recordAudit(principal, action, 'failed', requestId, { profile, projectId, errorCode: 'FORBIDDEN' })
      return
    }
    // Binding and unbinding are competing writes on the profile too, so both
    // carry the profile revision the caller read.
    if (expectedRevision(request, body) !== profile.revision) {
      this.fail(response, 409, requestId, 'REVISION_CONFLICT', '配置已被其他修改更新')
      this.recordAudit(principal, action, 'failed', requestId, { profile, projectId, errorCode: 'REVISION_CONFLICT' })
      return
    }
    if (method === 'DELETE') {
      if (!profile.projectBindings.delete(projectId)) {
        this.fail(response, 404, requestId, 'RESOURCE_NOT_FOUND', '绑定不存在')
        return
      }
      profile.revision += 1
      profile.updatedAt = new Date().toISOString()
      this.recordAudit(principal, action, 'succeeded', requestId, { profile, projectId })
      this.emitProfileEvent(profile, 'agent_profile.unbound', { project_id: projectId })
      this.remember(claim, { unbound: true }, 200)
      this.sendJson(response, 200, requestId, { unbound: true })
      return
    }
    if (this.accounts.projectOrganization(projectId) === undefined) {
      this.fail(response, 422, requestId, 'VALIDATION_ERROR', '项目不存在')
      this.recordAudit(principal, action, 'failed', requestId, { profile, projectId, errorCode: 'VALIDATION_ERROR' })
      return
    }
    if (this.accounts.projectOrganization(projectId) !== profile.organizationId) {
      this.fail(response, 422, requestId, 'VALIDATION_ERROR', '项目不属于该配置所在组织')
      this.recordAudit(principal, action, 'failed', requestId, { profile, projectId, errorCode: 'VALIDATION_ERROR' })
      return
    }
    // 仅可绑定 active 项目:draft / archived 项目不得成为授权锚点。
    if (this.accounts.projectStatus(projectId) !== 'active') {
      this.fail(response, 422, requestId, 'VALIDATION_ERROR', '项目未激活，仅可绑定 active 项目')
      this.recordAudit(principal, action, 'failed', requestId, { profile, projectId, errorCode: 'VALIDATION_ERROR' })
      return
    }
    const versionId = typeof body.agent_profile_version_id === 'string' ? body.agent_profile_version_id : ''
    const version = profile.versions.find(candidate => candidate.agentProfileVersionId === versionId)
    if (version === undefined || version.status !== 'published') {
      this.fail(response, 422, requestId, 'VALIDATION_ERROR', '仅可绑定 published 版本')
      this.recordAudit(principal, action, 'failed', requestId, { profile, projectId, errorCode: 'VALIDATION_ERROR' })
      return
    }
    // Every bound asset must already be authorized for the target project; the
    // binding must never widen what that project's runs may touch.
    const unauthorized = assetVersionIdsOf(version).find((reference) => {
      const keys = this.accounts.projectAssetKeys(projectId) ?? []
      return !keys.includes(assetAuthorizationKey(reference))
    })
    if (unauthorized !== undefined) {
      this.fail(response, 422, requestId, 'ASSET_NOT_AUTHORIZED', `资产 ${unauthorized} 未授权给项目 ${projectId}`)
      this.recordAudit(principal, action, 'failed', requestId, {
        profile,
        profileVersion: version,
        projectId,
        errorCode: 'ASSET_NOT_AUTHORIZED',
      })
      return
    }
    const claimDefault = body.default === true
    if (claimDefault) {
      // One default version per project across every profile: an older default
      // loses its flag at the same instant the new one gains it.
      for (const candidate of this.agentProfiles) {
        for (const [boundProjectId, binding] of candidate.projectBindings) {
          if (boundProjectId === projectId && binding.default) binding.default = false
        }
      }
    }
    profile.projectBindings.set(projectId, { agentProfileVersionId: versionId, default: claimDefault, revision: 1 })
    profile.revision += 1
    profile.updatedAt = new Date().toISOString()
    this.recordAudit(principal, action, 'succeeded', requestId, { profile, projectId, profileVersion: version })
    this.emitProfileEvent(profile, 'agent_profile.bound', { project_id: projectId, agent_profile_version_id: versionId })
    const dto = { project_id: projectId, agent_profile_version_id: versionId, default: claimDefault }
    this.remember(claim, dto, 200)
    this.sendJson(response, 200, requestId, dto)
  }

  // --- reads and projections ------------------------------------------------

  private listDirectory(workspace: WorkspaceRecord, url: URL, response: ServerResponse, requestId: string): void {
    const path = normalizeWorkspacePath(url.searchParams.get('path') ?? '')
    if (path === undefined) {
      this.fail(response, 404, requestId, 'RESOURCE_NOT_FOUND', '目录不存在')
      return
    }
    const entries = this.files.get(workspace.workspaceId) ?? []
    const prefix = path.length === 0 ? '' : `${path}/`
    const children = new Map<string, FileRecord>()
    for (const entry of entries) {
      if (!entry.path.startsWith(prefix)) continue
      const rest = entry.path.slice(prefix.length)
      if (rest.length === 0) continue
      const slash = rest.indexOf('/')
      const name = slash === -1 ? rest : rest.slice(0, slash)
      if (children.has(name)) continue
      children.set(
        name,
        slash === -1 ? entry : { path: `${prefix}${name}`, kind: 'directory', size: 0, etag: `dir-${name}` },
      )
    }
    const items = [...children.values()].map(entry => ({
      path: entry.path,
      kind: entry.kind,
      size: entry.size,
      etag: entry.etag,
    }))
    this.sendJson(response, 200, requestId, { path, revision: workspace.revision, items })
  }

  private sendFileContent(workspace: WorkspaceRecord, url: URL, response: ServerResponse, requestId: string): void {
    const path = normalizeWorkspacePath(url.searchParams.get('path') ?? '')
    const entry = path === undefined ? undefined : (this.files.get(workspace.workspaceId) ?? []).find(file => file.path === path)
    if (entry === undefined || entry.kind !== 'file') {
      this.fail(response, path === undefined ? 403 : 404, requestId, path === undefined ? 'PREVIEW_DENIED' : 'RESOURCE_NOT_FOUND',
        path === undefined ? '路径越出工作空间范围' : '文件不存在')
      return
    }
    const binary = entry.contentType?.startsWith('image/') === true
    const dto: Record<string, unknown> = {
      path: entry.path,
      content_type: entry.contentType ?? 'text/plain; charset=utf-8',
      size: entry.size,
      etag: entry.etag,
      revision: workspace.revision,
      ...(binary
        ? { content_base64: Buffer.from(entry.bytes ?? []).toString('base64') }
        : { content: new TextDecoder().decode(entry.bytes ?? new Uint8Array()) }),
    }
    this.sendJson(response, 200, requestId, dto)
  }

  private sendChanges(workspace: WorkspaceRecord, response: ServerResponse, requestId: string): void {
    const entries = (this.files.get(workspace.workspaceId) ?? []).filter(entry => entry.change !== undefined)
    this.sendJson(response, 200, requestId, {
      workspace_id: workspace.workspaceId,
      baseline_revision: baselineOf(workspace),
      revision: workspace.revision,
      files: entries.map(entry => ({ path: entry.path, change: entry.change, diff: entry.diff ?? '' })),
    })
  }

  private sendPreview(
    workspace: WorkspaceRecord,
    url: URL,
    response: ServerResponse,
    requestId: string,
    principal: AccountPrincipal,
  ): void {
    const path = normalizeWorkspacePath(url.searchParams.get('path') ?? '')
    if (path === undefined) {
      this.fail(response, 403, requestId, 'PREVIEW_DENIED', '路径越出工作空间范围')
      this.recordAudit(principal, 'preview.denied', 'failed', requestId, { workspace, errorCode: 'PREVIEW_DENIED' })
      return
    }
    const entry = (this.files.get(workspace.workspaceId) ?? []).find(candidate => candidate.path === path && candidate.kind === 'file')
    if (entry === undefined) {
      this.fail(response, 404, requestId, 'RESOURCE_NOT_FOUND', '文件不存在')
      return
    }
    const base = { path: entry.path, revision: workspace.revision, etag: entry.etag, content_type: entry.contentType ?? 'text/plain; charset=utf-8' }
    if (url.searchParams.get('mode') === 'diff') {
      this.sendJson(response, 200, requestId, { ...base, kind: 'diff', diff: entry.diff ?? '' })
      return
    }
    if (base.content_type.startsWith('image/')) {
      this.sendJson(response, 200, requestId, {
        ...base,
        kind: 'image',
        content_base64: Buffer.from(entry.bytes ?? []).toString('base64'),
        size: entry.size,
      })
      return
    }
    const content = new TextDecoder().decode(entry.bytes ?? new Uint8Array())
    if (base.content_type.includes('text/html')) {
      // hostile.html models a service that declares the dangerous pair itself:
      // the workbench must drop `allow-same-origin` and keep the frame unable
      // to reach out (its CSP allows inline scripts but no network at all).
      const hostile = entry.path === 'hostile.html'
      this.sendJson(response, 200, requestId, {
        ...base,
        kind: 'static_html',
        content,
        sha256: createHash('sha256').update(entry.bytes ?? new Uint8Array()).digest('hex'),
        ...(hostile
          ? {
            csp: "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:",
            sandbox: ['allow-scripts', 'allow-same-origin'],
          }
          : {
            csp: "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
            sandbox: ['allow-scripts'],
          }),
      })
      return
    }
    const kind = base.content_type.includes('json') ? 'json' : base.content_type.includes('markdown') ? 'markdown' : 'text'
    this.sendJson(response, 200, requestId, { ...base, kind, content })
  }

  /**
   * Admin-scoped event stream.
   *
   * The admin surface has no single project scope, so the scope is the
   * organizations the principal may administer: an event whose project belongs
   * to a visible organization is delivered, everything else stays invisible. The
   * frame contract is the user stream's — opaque ids, `after=` replay,
   * `resync_required` when the watermark left the window, and a closing
   * `stream.replay-done`.
   */
  private openAdminEventStream(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    principal: AccountPrincipal,
  ): void {
    const workspaceId = url.searchParams.get('workspace_id')
    const projectId = url.searchParams.get('project_id')
    const visible = visibleOrganizationIds(this.accounts, principal)
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-fixture-only': 'true',
    })
    const write = (chunk: string): void => {
      response.write(chunk)
    }
    const visibleEvents = this.visibleEvents().filter(event =>
      visible === undefined || event.projectIds.some(id => visible.has(this.organizationOfProject(id))))
    const inScope = (event: StreamEvent): boolean =>
      (projectId === null || event.projectIds.includes(projectId))
      && (workspaceId === null || event.resourceId === workspaceId || event.payload.workspace_id === workspaceId)
    const retained = visibleEvents.filter(inScope)
    const after = url.searchParams.get('after') ?? ''
    if (after.length > 0) {
      const watermark = visibleEvents.find(event => event.eventId === after)
      if (watermark === undefined) {
        write(sseFrame('resync_required', { code: 'RESYNC_REQUIRED', message: '事件已超出保留窗口，请重新读取快照' }, 'evt-resync'))
      } else {
        for (const event of retained.filter(candidate => candidate.eventId > watermark.eventId)) {
          write(sseFrame(event.eventType, toEventDto(event), event.eventId))
        }
        write(sseFrame('stream.replay-done', { last_event_id: watermark.eventId }, 'evt-replay-done'))
      }
    } else {
      for (const event of retained) write(sseFrame(event.eventType, toEventDto(event), event.eventId))
      write(sseFrame('stream.replay-done', { last_event_id: retained.at(-1)?.eventId ?? '' }, 'evt-replay-done'))
    }
    const subscriber: SseSubscriber = {
      deliver: write,
      close: () => {
        cleanup()
        // End the response rather than destroying the socket: a hard destroy
        // surfaces to the same-origin proxy as a failed pipe, which leaves the
        // browser's stream hanging instead of ended.
        response.end()
      },
    }
    this.subscribers.add(subscriber)
    const heartbeat = setInterval(() => {
      write(': ping\n\n')
    }, 15_000)
    const cleanup = (): void => {
      clearInterval(heartbeat)
      this.subscribers.delete(subscriber)
    }
    response.on('close', cleanup)
    request.on('close', cleanup)
  }

  private openEventStream(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    principal: AccountPrincipal,
    requestId: string,
  ): void {
    const projectId = url.searchParams.get('project_id')
    const workspaceId = url.searchParams.get('workspace_id')
    const runId = url.searchParams.get('run_id')
    if (projectId !== null && this.authorizeProjectOf(principal, projectId, requestId, response) === undefined) return
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-fixture-only': 'true',
    })
    const visibleEvents = this.visibleEvents()
    const write = (chunk: string): void => {
      response.write(chunk)
    }
    const after = url.searchParams.get('after') ?? ''
    const inScope = (event: StreamEvent): boolean =>
      (projectId === null || event.projectIds.includes(projectId)) &&
      (workspaceId === null || event.resourceId === workspaceId || event.payload.workspace_id === workspaceId) &&
      (runId === null || event.resourceId === runId)
    const retained = visibleEvents.filter(inScope)
    if (after.length > 0) {
      const watermark = visibleEvents.find(event => event.eventId === after)
      if (watermark === undefined) {
        write(sseFrame('resync_required', { code: 'RESYNC_REQUIRED', message: '事件已超出保留窗口，请重新读取快照' }, 'evt-resync'))
      } else {
        for (const event of retained.filter(candidate => candidate.eventId > watermark.eventId)) {
          write(sseFrame(event.eventType, toEventDto(event), event.eventId))
        }
        write(sseFrame('stream.replay-done', { last_event_id: watermark.eventId }, 'evt-replay-done'))
      }
    } else {
      for (const event of retained) write(sseFrame(event.eventType, toEventDto(event), event.eventId))
      write(sseFrame('stream.replay-done', { last_event_id: retained.at(-1)?.eventId ?? '' }, 'evt-replay-done'))
    }
    const subscriber: SseSubscriber = {
      deliver: write,
      close: () => {
        cleanup()
        // End the response rather than destroying the socket: a hard destroy
        // surfaces to the same-origin proxy as a failed pipe, which leaves the
        // browser's stream hanging instead of ended.
        response.end()
      },
    }
    this.subscribers.add(subscriber)
    const heartbeat = setInterval(() => {
      write(': ping\n\n')
    }, 15_000)
    const cleanup = (): void => {
      clearInterval(heartbeat)
      this.subscribers.delete(subscriber)
    }
    response.on('close', cleanup)
    request.on('close', cleanup)
  }

  // --- helpers ---------------------------------------------------------------

  private visibleEvents(): readonly StreamEvent[] {
    return this.pruneEvents ? this.events.slice(-PRUNED_EVENT_RETENTION) : this.events
  }

  private activeWriteRun(workspaceId: string): RunRecord | undefined {
    return [...this.runs.values()].find(candidate =>
      candidate.workspaceId === workspaceId &&
      candidate.writeMode === 'write' &&
      ['preparing', 'awaiting_approval', 'running', 'paused', 'awaiting_user'].includes(candidate.status),
    )
  }

  private authorizeProjectOf(
    principal: AccountPrincipal,
    projectId: string,
    requestId: string,
    response: ServerResponse,
  ): { readonly project_id: string; readonly organization_id: string } | undefined {
    const project = this.accounts.authorizeProject(principal, projectId, requestId)
    if (isFailure(project)) {
      this.fail(response, project.status, requestId, project.code, project.message)
      return undefined
    }
    return { project_id: project.project_id, organization_id: project.organization_id }
  }

  /**
   * 统一权限决策引用（§11.9）：只读决策端点。八维输入（组织由项目/工作空间推导、
   * 操作者由凭据服务端解析），返回 allowed/denied + 稳定码 + 原因 + 策略版本 +
   * request_id；denied 写授权审计行。不改变业务状态（仅审计追加）。
   */
  async handlePermissionCheck(
    request: IncomingMessage,
    response: ServerResponse,
    principal: AccountPrincipal,
    requestId: string,
  ): Promise<void> {
    const action = 'permission-check'
    const body = await readJsonBody(request, response, requestId)
    if (body === undefined) return
    const policyVersion = 'perm-policy@1'

    // —— §11.19 权限模拟：管理面操作者可指定目标用户，以目标身份评估 ——
    let evaluationPrincipal = principal
    let simulation: Record<string, unknown> = {}
    if (typeof body.simulate_user_id === 'string' && body.simulate_user_id.length > 0) {
      if (principal.role === 'member') {
        this.fail(response, 403, requestId, 'FORBIDDEN', '仅管理员或经理可模拟其他用户的权限')
        this.recordAudit(principal, action, 'failed', requestId, { errorCode: 'FORBIDDEN' })
        return
      }
      const target = this.accounts.principalForUser(body.simulate_user_id)
      if (target === undefined) {
        this.fail(response, 404, requestId, 'USER_NOT_FOUND', '被模拟用户不存在或未激活')
        return
      }
      evaluationPrincipal = target
      simulation = {
        simulated: true,
        simulated_user: { user_id: target.userId, display_name: target.displayName, role: target.role },
        simulate_note: `由 ${principal.displayName} 发起的模拟评估（非真实操作）`,
      }
    }

    const audit = (decision: 'allowed' | 'denied', code: string): void => {
      if (decision === 'denied') {
        // §11.9：denied 决策必须写授权审计（accounts 层），与工作空间审计双轨留痕。
        // §11.19：审计 actor_name 是发起模拟的调用方。
        this.accounts.recordGovernanceDenial(principal, 'permission-check', code, requestId)
        this.recordAudit(principal, action, 'failed', requestId, { errorCode: code })
      } else {
        this.recordAudit(principal, action, 'succeeded', requestId, {})
      }
    }
    const respond = (decision: 'allowed' | 'denied', code: string, reason: string, context: Record<string, unknown>): void => {
      audit(decision, code)
      this.sendJson(response, 200, requestId, {
        decision,
        code,
        reason,
        policy_version: policyVersion,
        request_id: requestId,
        operator: principal.displayName,
        context,
        ...simulation,
      })
    }

    const rawAction = body.action
    if (typeof rawAction !== 'string' || rawAction.trim().length === 0) {
      this.fail(response, 422, requestId, 'VALIDATION_ERROR', 'action 必填')
      return
    }
    const act = rawAction.trim()

    // —— 上下文解析与一致性 ——
    let workspaceId: string | undefined
    let projectId: string | undefined
    const context: Record<string, unknown> = {}
    if (typeof body.workspace_id === 'string' && body.workspace_id.length > 0) {
      const ws = this.workspaces.get(body.workspace_id)
      if (ws === undefined) {
        respond('denied', 'RESOURCE_NOT_FOUND', '工作空间不存在', {})
        return
      }
      workspaceId = ws.workspaceId
      projectId = ws.projectId
      context['workspace_id'] = ws.workspaceId
    }
    if (typeof body.run_id === 'string' && body.run_id.length > 0) {
      const run = this.runs.get(body.run_id)
      if (run === undefined) {
        respond('denied', 'RESOURCE_NOT_FOUND', '运行不存在', {})
        return
      }
      context['run_id'] = run.runId
      if (workspaceId !== undefined && run.workspaceId !== workspaceId) {
        respond('denied', 'PROJECT_CONTEXT_MISMATCH', '运行与提供的工作空间不一致', context)
        return
      }
      if (workspaceId === undefined) workspaceId = run.workspaceId
      if (projectId === undefined) projectId = run.projectId
      else if (run.projectId !== projectId) {
        respond('denied', 'PROJECT_CONTEXT_MISMATCH', '运行与提供的项目不一致', context)
        return
      }
    }
    if (typeof body.project_id === 'string' && body.project_id.length > 0) {
      if (projectId !== undefined && projectId !== body.project_id) {
        respond('denied', 'PROJECT_CONTEXT_MISMATCH', '项目与已解析上下文不一致', context)
        return
      }
      projectId = body.project_id
    }
    if (projectId === undefined) {
      respond('denied', 'PROJECT_CONTEXT_REQUIRED', '缺少项目上下文', {})
      return
    }
    context['project_id'] = projectId

    // 项目授权（组织随之推导）；模拟时以目标用户的身份评估。
    const project = this.accounts.authorizeProject(evaluationPrincipal, projectId, requestId)
    if (isFailure(project)) {
      respond('denied', project.code, project.message, context)
      return
    }
    context['organization_id'] = this.organizationOfProject(projectId)

    // 角色边界：治理动作要求 staff（模拟时按目标用户的角色判定）。
    if (act.startsWith('admin.') && evaluationPrincipal.role === 'member') {
      respond('denied', 'ROLE_FORBIDDEN', '成员角色不能执行治理动作', context)
      return
    }

    // Agent 维度：必须是该项目绑定的 published 版本。
    let assetAllowlist: Set<string> | undefined
    if (typeof body.agent_profile_version_id === 'string' && body.agent_profile_version_id.length > 0) {
      const version = this.findBoundPublishedVersion(projectId, body.agent_profile_version_id)
      if (version === undefined) {
        respond('denied', 'FORBIDDEN', '当前项目无权使用该 Agent 配置版本', context)
        return
      }
      context['agent_profile_version_id'] = version.agentProfileVersionId
      assetAllowlist = new Set(assetVersionIdsOf(version))
    }

    // 资产维度：必须是所选版本的自身资产子集。
    if (Array.isArray(body.asset_version_ids)) {
      const requested = body.asset_version_ids as unknown[]
      if (requested.some(entry => typeof entry !== 'string')) {
        this.fail(response, 422, requestId, 'VALIDATION_ERROR', 'asset_version_ids 必须是字符串数组')
        return
      }
      const allow = assetAllowlist ?? new Set<string>()
      if (requested.some(entry => !allow.has(entry as string))) {
        respond('denied', 'VALIDATION_ERROR', 'asset_version_ids 必须是所选 Agent 配置版本自身的资产子集', context)
        return
      }
      context['asset_version_ids'] = [...requested]
    }

    respond('allowed', 'OK', '授权通过', context)
  }

  private authorizeWorkspace(
    principal: AccountPrincipal,
    workspaceId: string,
    requestId: string,
    response: ServerResponse,
  ): WorkspaceRecord | undefined {
    const workspace = this.workspaces.get(workspaceId)
    if (workspace === undefined) {
      this.fail(response, 404, requestId, 'RESOURCE_NOT_FOUND', '资源不存在')
      return undefined
    }
    const project = this.accounts.authorizeProject(principal, workspace.projectId, requestId)
    if (isFailure(project)) {
      this.recordAudit(principal, 'workspace.access_denied', 'failed', requestId, { workspace, errorCode: project.code })
      this.fail(response, 404, requestId, 'RESOURCE_NOT_FOUND', '资源不存在')
      return undefined
    }
    return workspace
  }

  private organizationOfProject(projectId: string): string {
    if (projectId === 'project-beta') return 'org-beta'
    return 'org-alpha'
  }

  private findAgentType(agentTypeId: string): AgentTypeRecord | undefined {
    return this.agentTypes.find(agentType => agentType.agentTypeId === agentTypeId)
  }

  private visibleVersion(
    profile: AgentProfileRecord,
    projectId: string,
  ): readonly [AgentProfileRecord, AgentProfileVersionRecord, ProjectBindingRecord] | undefined {
    const binding = profile.projectBindings.get(projectId)
    if (binding === undefined) return undefined
    const version = profile.versions.find(candidate => candidate.agentProfileVersionId === binding.agentProfileVersionId)
    if (version === undefined || version.status !== 'published') return undefined
    return [profile, version, binding] as const
  }

  private findPublishedVersionForCaller(
    versionId: string,
    principal: AccountPrincipal,
  ): { readonly profile: AgentProfileRecord; readonly version: AgentProfileVersionRecord } | undefined {
    for (const profile of this.agentProfiles) {
      const version = profile.versions.find(candidate => candidate.agentProfileVersionId === versionId)
      if (version === undefined || version.status !== 'published') continue
      for (const projectId of profile.projectBindings.keys()) {
        if (!isFailure(this.accounts.authorizeProject(principal, projectId))) return { profile, version }
      }
    }
    return undefined
  }

  private findBoundPublishedVersion(projectId: string, versionId: string): AgentProfileVersionRecord | undefined {
    for (const profile of this.agentProfiles) {
      if (!profile.projectBindings.has(projectId)) continue
      const version = profile.versions.find(candidate => candidate.agentProfileVersionId === versionId)
      if (version !== undefined && version.status === 'published') return version
    }
    return undefined
  }

  private missingAssets(assetVersionIds: readonly string[]): string[] {
    if (this.options.assetExists === undefined) return []
    return assetVersionIds.filter((reference) => {
      const match = /^(skill|knowledge|memory):([^@]+)(?:@(.+))?$/u.exec(reference)
      if (match === null) return true
      return !this.options.assetExists?.(match[1] as 'skill' | 'knowledge' | 'memory', match[2] ?? '', match[3])
    })
  }

  private advanceWorkspace(workspace: WorkspaceRecord): WorkspaceRecord {
    if (workspace.transitionAt === undefined || workspace.transitionTo === undefined) return workspace
    if (this.clock() < workspace.transitionAt) return workspace
    this.applyTransition(workspace, workspace.transitionTo)
    return workspace
  }

  private applyTransition(workspace: WorkspaceRecord, to: WorkspaceStatus): void {
    workspace.status = to
    workspace.revision += 1
    workspace.updatedAt = new Date().toISOString()
    const followUp: Partial<Record<WorkspaceStatus, { readonly at: number; readonly to: WorkspaceStatus }>> = {
      provisioning: { at: this.clock() + 200, to: 'starting' },
      starting: { at: this.clock() + 200, to: 'ready' },
    }
    const next = followUp[to]
    if (next === undefined) {
      workspace.transitionAt = undefined
      workspace.transitionTo = undefined
    } else {
      workspace.transitionAt = next.at
      workspace.transitionTo = next.to
    }
    const eventType = to === 'ready' ? 'workspace.ready' : to === 'failed' ? 'workspace.failed' : 'workspace.updated'
    this.appendEvent('workspace', workspace.workspaceId, workspace.revision, eventType, {
      project_id: workspace.projectId,
      status: to,
    })
    if (to === 'stopped') {
      // Stopping the runtime revokes outstanding web app preview URLs. That is
      // a further observable change to the workspace, so it carries the next
      // revision rather than repeating the transition's: two different facts
      // about one resource never share a revision.
      workspace.revision += 1
      this.appendEvent('workspace', workspace.workspaceId, workspace.revision, 'preview.revoked', {
        project_id: workspace.projectId,
        reason: 'workspace-stopped',
      })
    }
  }

  // --- §11.10 审批决策与运行接管 ------------------------------------------------

  /** 工作空间当前未同步变更路径，作为审批卡的影响对象（服务端确认，非客户端推断）。 */
  private runWorkspaceAffected(workspace: WorkspaceRecord): string[] {
    return (this.files.get(workspace.workspaceId) ?? [])
      .filter(entry => entry.change !== undefined)
      .map(entry => entry.path)
  }

  /** 决策时刻逐项复验资产：解析失败或解析为假的引用判为 missing（§11.10）。 */
  private resolveApprovalAssets(assetVersionIds: readonly string[]): RunApprovalAsset[] {
    return assetVersionIds.map((reference) => {
      const match = /^(skill|knowledge|memory):([^@]+)(?:@(.+))?$/u.exec(reference)
      const exists = match !== null && (this.options.assetExists?.(match[1] as 'skill' | 'knowledge' | 'memory', match[2] ?? '', match[3]) ?? true)
      return exists
        ? { assetVersionId: reference, status: 'bound' as const, detail: '已绑定且可用' }
        : { assetVersionId: reference, status: 'missing' as const, detail: '资产解析失败：未发布、已撤销或未绑定' }
    })
  }

  private buildApproval(
    affected: readonly string[],
    assetVersionIds: readonly string[],
    writeMode: 'read_only' | 'write',
    expiresAt: string,
    now: string,
  ): RunApprovalRecord {
    const write = writeMode === 'write'
    return {
      approvalId: `appr-${randomUUID().slice(0, 8)}`,
      action: 'apply_workspace_changes',
      summary: write ? '写入运行将修改工作空间文件，需审批后执行' : '只读运行需要审批后执行',
      affected,
      permission: {
        code: write ? 'workspace.write' : 'workspace.read',
        allowed: true,
        reason: '项目成员具备操作授权',
        policyVersion: 'perm-policy@1',
      },
      assets: this.resolveApprovalAssets(assetVersionIds),
      risk: write
        ? { level: 'high' as const, reason: '写入运行将修改工作空间文件' }
        : { level: 'low' as const, reason: '只读运行不修改工作空间' },
      revocable: { revocable: true, how: '在运行完成前取消运行' },
      expiresAt,
      createdAt: now,
    }
  }

  private approvalDto(approval: RunApprovalRecord, runId: string): Record<string, unknown> {
    return {
      approval_id: approval.approvalId,
      run_id: runId,
      action: approval.action,
      summary: approval.summary,
      affected: [...approval.affected],
      permission: {
        code: approval.permission.code,
        allowed: approval.permission.allowed,
        reason: approval.permission.reason,
        policy_version: approval.permission.policyVersion,
      },
      asset_versions: approval.assets.map(asset => ({
        asset_version_id: asset.assetVersionId,
        status: asset.status,
        detail: asset.detail,
      })),
      risk: { level: approval.risk.level, reason: approval.risk.reason },
      revocable: { revocable: approval.revocable.revocable, how: approval.revocable.how },
      expires_at: approval.expiresAt,
      created_at: approval.createdAt,
    }
  }

  private async decideApproval(
    request: IncomingMessage,
    response: ServerResponse,
    principal: AccountPrincipal,
    requestId: string,
    runId: string,
  ): Promise<void> {
    const action = 'run.approval'
    const body = await readJsonBody(request, response, requestId)
    if (body === undefined) return
    const claim = this.claimMutation(request, principal, response, requestId, action, body)
    if (claim === undefined) return
    const run = this.runs.get(runId)
    if (run === undefined) {
      this.fail(response, 404, requestId, 'RESOURCE_NOT_FOUND', '资源不存在')
      return
    }
    const workspace = this.authorizeWorkspace(principal, run.workspaceId, requestId, response)
    if (workspace === undefined) return
    const decision = body.decision
    if (decision !== 'approve' && decision !== 'reject') {
      this.fail(response, 422, requestId, 'VALIDATION_ERROR', "decision 必须是 'approve' 或 'reject'")
      return
    }
    if (run.status !== 'awaiting_approval' || run.approval === undefined) {
      this.fail(response, 409, requestId, 'INVALID_STATUS', `当前状态 ${run.status} 不允许审批决策`)
      this.recordAudit(principal, action, 'failed', requestId, { workspace, run, errorCode: 'INVALID_STATUS' })
      return
    }
    if (expectedRunRevision(request, body) !== run.revision) {
      this.fail(response, 409, requestId, 'REVISION_CONFLICT', '运行 revision 已变化')
      this.recordAudit(principal, action, 'failed', requestId, { workspace, run, errorCode: 'REVISION_CONFLICT' })
      return
    }
    const approval = run.approval
    if (Date.parse(approval.expiresAt) < this.clock()) {
      this.fail(response, 409, requestId, 'APPROVAL_EXPIRED', '审批已过有效期，需重新发起')
      this.recordAudit(principal, action, 'failed', requestId, { workspace, run, errorCode: 'APPROVAL_EXPIRED' })
      return
    }
    const operator = principal.displayName
    let outcome: 'succeeded' | 'partial_success' = 'succeeded'
    let removed: string[] = []
    if (decision === 'reject') {
      this.applyRunTransition(run, 'cancelled', { reason: '审批拒绝', operator })
    } else {
      // 决策时刻逐项复验：缺失资产剔除出运行（撤回只影响未开始的执行）。
      const resolved = this.resolveApprovalAssets(run.assetVersionIds)
      removed = resolved.filter(asset => asset.status !== 'bound').map(asset => asset.assetVersionId)
      run.assetVersionIds = resolved.filter(asset => asset.status === 'bound').map(asset => asset.assetVersionId)
      outcome = removed.length > 0 ? 'partial_success' : 'succeeded'
      this.applyRunTransition(run, 'running', { reason: '审批通过', operator })
    }
    run.approval = undefined
    run.pulseExtra = [...(run.pulseExtra ?? []), {
      kind: 'approval',
      at: new Date().toISOString(),
      revision: run.revision,
      trace_id: run.traceId,
      summary: decision === 'approve' ? '审批通过' : '审批拒绝',
      decision,
      operator: principal.displayName,
    }]
    const auditId = this.recordAudit(principal, action, 'succeeded', requestId, { workspace, run })
    const dto = toRunDto(run)
    dto['evidence'] = {
      request_id: requestId,
      outcome,
      reason: decision === 'reject' ? '审批拒绝' : '审批通过',
      revision: run.revision,
      audit_id: auditId,
      affected: [run.runId, ...removed],
      next_action: decision === 'reject'
        ? '如需重新执行，请创建新运行'
        : removed.length > 0
          ? '检查被剔除的资产版本，运行继续推进'
          : '等待运行推进',
    }
    this.remember(claim, dto, 200)
    this.sendJson(response, 200, requestId, dto)
  }

  private async takeoverRun(
    request: IncomingMessage,
    response: ServerResponse,
    principal: AccountPrincipal,
    requestId: string,
    runId: string,
  ): Promise<void> {
    const action = 'run.takeover'
    const body = await readJsonBody(request, response, requestId)
    if (body === undefined) return
    const claim = this.claimMutation(request, principal, response, requestId, action, body)
    if (claim === undefined) return
    const run = this.runs.get(runId)
    if (run === undefined) {
      this.fail(response, 404, requestId, 'RESOURCE_NOT_FOUND', '资源不存在')
      return
    }
    const workspace = this.authorizeWorkspace(principal, run.workspaceId, requestId, response)
    if (workspace === undefined) return
    if (!['preparing', 'awaiting_approval', 'running', 'paused', 'awaiting_user'].includes(run.status)) {
      this.fail(response, 409, requestId, 'INVALID_STATUS', `当前状态 ${run.status} 不允许接管`)
      this.recordAudit(principal, action, 'failed', requestId, { workspace, run, errorCode: 'INVALID_STATUS' })
      return
    }
    if (expectedRunRevision(request, body) !== run.revision) {
      // 并发接管：携带过期 revision 的调用方拿到当前持有者证据。
      this.failWithPayload(response, 409, requestId, 'REVISION_CONFLICT', '运行已被其他操作者接管或已变化', {
        current_run: toRunDto(this.advanceRun(run)),
      })
      this.recordAudit(principal, action, 'failed', requestId, { workspace, run, errorCode: 'REVISION_CONFLICT' })
      return
    }
    const previousOperator = run.operator
    run.operator = principal.displayName
    run.revision += 1
    run.updatedAt = new Date().toISOString()
    this.appendEvent('run', run.runId, run.revision, 'run.updated', {
      project_id: run.projectId,
      workspace_id: run.workspaceId,
      status: run.status,
    })
    const auditId = this.recordAudit(principal, action, 'succeeded', requestId, { workspace, run })
    const dto = toRunDto(run)
    dto['evidence'] = {
      request_id: requestId,
      outcome: 'succeeded',
      reason: previousOperator === undefined ? '接管运行' : `接管运行（原持有者 ${previousOperator}）`,
      revision: run.revision,
      audit_id: auditId,
      affected: [run.runId],
      next_action: '继续监控运行',
    }
    this.remember(claim, dto, 200)
    this.sendJson(response, 200, requestId, dto)
  }

  private advanceRun(run: RunRecord): RunRecord {
    if (run.transitionAt === undefined || this.clock() < run.transitionAt) return run
    if (run.status === 'preparing') {
      this.applyRunTransition(run, 'running', { reason: '准备完成，开始执行', operator: 'system' })
    }
    return run
  }

  private applyRunTransition(
    run: RunRecord,
    to: RunStatus,
    meta: { readonly reason: string; readonly operator: string },
  ): void {
    run.status = to
    run.revision += 1
    run.updatedAt = new Date().toISOString()
    run.transitionAt = undefined
    const at = new Date().toISOString()
    run.timeline.push({
      status: to,
      at,
      reason: meta.reason,
      operator: meta.operator,
      policyVersion: run.agentProfileVersionId,
      revision: run.revision,
      traceId: run.traceId,
    })
    const eventType = to === 'paused'
      ? 'run.paused'
      : to === 'running'
        ? 'run.started'
        : to === 'cancelled'
          ? 'run.cancelled'
          : to === 'failed'
            ? 'run.failed'
            : to === 'succeeded'
              ? 'run.succeeded'
              : 'run.updated'
    this.appendEvent('run', run.runId, run.revision, eventType, {
      project_id: run.projectId,
      workspace_id: run.workspaceId,
      status: to,
    })
  }

  private clearChanges(workspace: WorkspaceRecord): void {
    for (const entry of this.files.get(workspace.workspaceId) ?? []) {
      entry.diff = undefined
      entry.change = undefined
    }
    workspace.revision += 1
    workspace.updatedAt = new Date().toISOString()
    this.appendEvent('changes', workspace.workspaceId, workspace.revision, 'changes.updated', {
      project_id: workspace.projectId,
      files: 0,
    })
  }

  private appendEvent(
    resourceType: StreamEvent['resourceType'],
    resourceId: string,
    revision: number,
    eventType: string,
    payload: Record<string, unknown>,
  ): void {
    this.eventCounter += 1
    const event: StreamEvent = {
      eventId: `evt-${String(this.eventCounter).padStart(6, '0')}`,
      resourceType,
      resourceId,
      revision,
      eventType,
      occurredAt: new Date().toISOString(),
      payload,
      projectIds: typeof payload.project_id === 'string' ? [payload.project_id] : [],
    }
    this.events.push(event)
    while (this.events.length > EVENT_RETENTION) this.events.shift()
    const frame = sseFrame(event.eventType, toEventDto(event), event.eventId)
    for (const subscriber of this.subscribers) subscriber.deliver(frame)
  }

  private recordAudit(
    principal: AccountPrincipal,
    action: string,
    result: 'succeeded' | 'failed',
    requestId: string,
    context: {
      readonly projectId?: string
      readonly workspace?: WorkspaceRecord
      readonly run?: RunRecord
      readonly profile?: AgentProfileRecord
      readonly profileVersion?: AgentProfileVersionRecord
      readonly agentProfileVersionId?: string
      /** 资产模块的治理行（§11.18）自带版本引用：目录行不属于任何运行或配置。 */
      readonly assetVersionIds?: readonly string[]
      readonly errorCode?: string
    } = {},
  ): string {
    const workspace = context.workspace
    const run = context.run
    const profile = context.profile
    const version = context.profileVersion
    const auditId = randomUUID()
    this.audits.push({
      id: auditId,
      occurred_at: new Date().toISOString(),
      actor_user_id: principal.userId,
      actor_name: principal.displayName,
      request_id: requestId,
      organization_id: profile?.organizationId ?? (workspace !== undefined ? this.organizationOfProject(workspace.projectId) : null),
      project_id: workspace?.projectId ?? run?.projectId ?? context.projectId ?? null,
      workspace_id: workspace?.workspaceId ?? run?.workspaceId ?? null,
      session_id: run?.sessionId ?? null,
      run_id: run?.runId ?? null,
      agent_profile_id: profile?.agentProfileId ?? null,
      agent_profile_version_id: version?.agentProfileVersionId ?? context.agentProfileVersionId ?? null,
      asset_version_ids: context.assetVersionIds
        ?? (version !== undefined
          ? assetVersionIdsOf(version)
          : run !== undefined
            ? [...run.assetVersionIds]
            : null),
      revision: workspace?.revision ?? run?.revision ?? profile?.revision ?? null,
      action,
      result,
      error_code: context.errorCode ?? null,
    })
    return auditId
  }

  private claimMutation(
    request: IncomingMessage,
    principal: AccountPrincipal,
    response: ServerResponse,
    requestId: string,
    action: string,
    body: Record<string, unknown>,
  ): MutationClaim | undefined {
    const key = headerValueOf(request, 'idempotency-key')
    if (key === undefined || key.length === 0) {
      this.fail(response, 400, requestId, 'IDEMPOTENCY_KEY_REQUIRED', '危险写操作必须提供 Idempotency-Key')
      return undefined
    }
    const fingerprint = `${request.method ?? 'GET'} ${new URL(request.url ?? '/', 'http://localhost').pathname} ${action} ${JSON.stringify(body)}`
    const previous = this.idempotency.get(key)
    if (previous !== undefined) {
      if (previous.fingerprint !== fingerprint) {
        this.fail(response, 409, requestId, 'IDEMPOTENCY_CONFLICT', '幂等键已用于另一请求')
        this.recordAudit(principal, action, 'failed', requestId, { errorCode: 'IDEMPOTENCY_CONFLICT' })
        return undefined
      }
      response.writeHead(previous.status, { 'content-type': 'application/json; charset=utf-8', 'x-fixture-only': 'true' })
      response.end(JSON.stringify({ code: 0, message: 'ok', request_id: requestId, data: previous.data }))
      return undefined
    }
    return { kind: 'new', key, fingerprint }
  }

  private remember(claim: MutationClaim, data: unknown, status: number): void {
    this.idempotency.set(claim.key, { fingerprint: claim.fingerprint, data, status })
  }

  private sendJson(response: ServerResponse, status: number, requestId: string, data: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-fixture-only': 'true' })
    response.end(JSON.stringify({ code: 0, message: 'ok', request_id: requestId, data }))
  }

  private fail(response: ServerResponse, status: number, requestId: string, code: string, message: string): void {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-fixture-only': 'true' })
    response.end(JSON.stringify({ code, message, request_id: requestId, data: null }))
  }

  private failWithDetails(
    response: ServerResponse,
    status: number,
    requestId: string,
    code: string,
    message: string,
    details: Record<string, unknown>,
  ): void {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-fixture-only': 'true' })
    response.end(JSON.stringify({ code, message, request_id: requestId, details, data: null }))
  }

  private failWithPayload(
    response: ServerResponse,
    status: number,
    requestId: string,
    code: string,
    message: string,
    payload: Record<string, unknown>,
  ): void {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-fixture-only': 'true' })
    response.end(JSON.stringify({ code, message, request_id: requestId, ...payload, data: null }))
  }

  // --- seed -------------------------------------------------------------------

  private seed(): void {
    this.agentTypes.push(
      {
        agentTypeId: 'at-claude-code',
        key: 'claude_code',
        name: 'Claude Code',
        capabilities: ['terminal', 'files', 'git'],
        readiness: 'ready',
        credentialRequired: true,
        schemaVersion: '1',
        schema: [
          {
            key: 'permission_mode',
            label: '权限模式',
            type: 'enum',
            required: true,
            affectsPublish: true,
            description: '类型扩展声明的执行权限模式',
            enumValues: ['approval', 'auto', 'read_only'],
            minValue: null,
            maxValue: null,
            defaultValue: 'approval',
          },
          {
            key: 'max_turns',
            label: '单轮上限',
            type: 'number',
            required: false,
            affectsPublish: false,
            description: '单次 Run 的最大轮数',
            enumValues: [],
            minValue: 1,
            maxValue: 200,
            defaultValue: null,
          },
          {
            key: 'sandbox_ref',
            label: '沙箱引用',
            type: 'string',
            required: false,
            affectsPublish: false,
            description: '沙箱环境引用名',
            enumValues: [],
            minValue: null,
            maxValue: null,
            defaultValue: null,
          },
        ],
      },
      {
        agentTypeId: 'at-hermes',
        key: 'hermes',
        name: 'Hermes',
        capabilities: ['terminal'],
        readiness: 'degraded',
        credentialRequired: false,
        schemaVersion: '1',
        schema: [
          {
            key: 'profile',
            label: '执行档案',
            type: 'enum',
            required: true,
            affectsPublish: true,
            description: 'Hermes 执行档案',
            enumValues: ['fast', 'balanced', 'thorough'],
            minValue: null,
            maxValue: null,
            defaultValue: 'balanced',
          },
          {
            key: 'endpoint_ref',
            label: '端点引用',
            type: 'string',
            required: false,
            affectsPublish: false,
            description: 'MCP 端点引用名',
            enumValues: [],
            minValue: null,
            maxValue: null,
            defaultValue: null,
          },
        ],
      },
      {
        agentTypeId: 'at-legacy-shell',
        key: 'legacy_shell',
        name: 'Legacy Shell（退役）',
        capabilities: ['terminal'],
        readiness: 'unavailable',
        credentialRequired: false,
        schemaVersion: '1',
        schema: [
          {
            key: 'shell_path_ref',
            label: 'Shell 引用',
            type: 'string',
            required: false,
            affectsPublish: false,
            description: '退役 Shell 路径引用',
            enumValues: [],
            minValue: null,
            maxValue: null,
            defaultValue: null,
          },
        ],
      },
    )
    const codeProfile: AgentProfileRecord = {
      agentProfileId: 'ap-code-default',
      organizationId: 'org-alpha',
      name: '默认研发代理',
      description: '面向研发工作空间的默认执行配置',
      agentTypeId: 'at-claude-code',
      revision: 4,
      createdBy: '平台管理员',
      createdAt: new Date(Date.now() - 7 * 86_400_000).toISOString(),
      updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
      versions: [
        {
          agentProfileVersionId: 'apv-1',
          version: 'v1',
          status: 'published',
          model: 'deepseek-v3.2',
          reasoning: 'medium',
          skills: [{ reference: 'skill:code-review@1.0.0', required: true }],
          knowledgeBases: [{ reference: 'knowledge:k-1', required: true }],
          memory: { reference: 'memory:m-1', required: true },
          executionPolicy: {
            permission_mode: 'approval',
            tool_allowlist: ['read', 'write', 'terminal'],
            max_concurrency: 2,
            budget: 200000,
            timeout_ms: 900000,
            write_mode: 'write',
          },
          typeExtensionConfig: { permission_mode: 'approval' },
          credentialRef: { name: 'deepseek-main', kind: 'api_key', authorized: true, readiness: 'ready' },
          changeSummary: '首个发布版本',
          publishedAt: new Date(Date.now() - 86_400_000).toISOString(),
          publishedBy: '平台管理员',
        },
        {
          agentProfileVersionId: 'apv-2',
          version: 'v2',
          status: 'draft',
          model: 'deepseek-v3.2',
          reasoning: 'high',
          skills: [{ reference: 'skill:code-review@1.0.0', required: true }],
          knowledgeBases: [{ reference: 'knowledge:k-3', required: true }],
          memory: { reference: 'memory:m-2', required: true },
          executionPolicy: { permission_mode: 'auto', tool_allowlist: ['read', 'write'] },
          typeExtensionConfig: { permission_mode: 'auto' },
          credentialRef: null,
          changeSummary: '提高推理档位（草稿）',
        },
      ],
      projectBindings: new Map([['project-alpha', { agentProfileVersionId: 'apv-1', default: true, revision: 1 }]]),
    }
    const liteProfile: AgentProfileRecord = {
      agentProfileId: 'ap-review-lite',
      organizationId: 'org-alpha',
      name: '轻量评审代理',
      description: '只读评审配置，携带一个可选的废弃 Skill 版本',
      agentTypeId: 'at-claude-code',
      revision: 2,
      createdBy: '平台管理员',
      createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      updatedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      versions: [
        {
          agentProfileVersionId: 'apv-lite-1',
          version: 'v1',
          status: 'published',
          model: 'deepseek-v3.2',
          reasoning: 'medium',
          skills: [{ reference: 'skill:code-review@0.9.0', required: false }],
          knowledgeBases: [],
          memory: null,
          executionPolicy: { permission_mode: 'read_only', tool_allowlist: ['read'], max_concurrency: 1, write_mode: 'read_only' },
          typeExtensionConfig: { permission_mode: 'read_only' },
          credentialRef: { name: 'deepseek-main', kind: 'api_key', authorized: true, readiness: 'ready' },
          changeSummary: '轻量只读首发',
          publishedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
          publishedBy: '平台管理员',
        },
      ],
      projectBindings: new Map([['project-alpha', { agentProfileVersionId: 'apv-lite-1', default: false, revision: 1 }]]),
    }
    const legacyProfile: AgentProfileRecord = {
      agentProfileId: 'ap-legacy-shell',
      organizationId: 'org-alpha',
      name: '退役 Shell 代理',
      description: '类型已退役的历史配置，验证不可用状态展示',
      agentTypeId: 'at-legacy-shell',
      revision: 3,
      createdBy: '平台管理员',
      createdAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      updatedAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
      versions: [
        {
          agentProfileVersionId: 'apv-legacy-1',
          version: 'v1',
          status: 'published',
          model: 'deepseek-legacy',
          reasoning: 'low',
          skills: [],
          knowledgeBases: [{ reference: 'knowledge:k-1', required: true }],
          memory: null,
          executionPolicy: { permission_mode: 'approval', write_mode: 'write' },
          typeExtensionConfig: {},
          credentialRef: null,
          changeSummary: '历史发布版本',
          publishedAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
          publishedBy: '平台管理员',
        },
      ],
      projectBindings: new Map([['project-alpha', { agentProfileVersionId: 'apv-legacy-1', default: false, revision: 1 }]]),
    }
    const hermesProfile: AgentProfileRecord = {
      agentProfileId: 'ap-hermes-trial',
      organizationId: 'org-alpha',
      name: '试验 Hermes 代理',
      description: '尚未发布的试验配置',
      agentTypeId: 'at-hermes',
      revision: 1,
      createdBy: '平台管理员',
      createdAt: new Date(Date.now() - 86_400_000).toISOString(),
      updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
      versions: [{
        agentProfileVersionId: 'apv-hermes-draft',
        version: 'v1',
        status: 'draft',
        model: 'deepseek-v3.2',
        reasoning: 'low',
        skills: [],
        knowledgeBases: [],
        memory: null,
        executionPolicy: { permission_mode: 'approval' },
        typeExtensionConfig: {},
        credentialRef: null,
        changeSummary: '试验草稿',
      }],
      projectBindings: new Map(),
    }
    this.agentProfiles.push(codeProfile, liteProfile, legacyProfile, hermesProfile)

    const seededCodeSources: ReadonlyArray<readonly [string, readonly CodeSourceRecord[]]> = [
      ['project-alpha', [
        { repositoryId: 'repo-1', name: 'harness-web', provider: 'gitlab', defaultBranch: 'main', branches: ['main', 'develop', 'feature/fix', 'feature/host-loop', 'feature/cloud', 'feature/e2e'] },
        { repositoryId: 'repo-3', name: 'harness-service', provider: 'gitlab', defaultBranch: 'trunk', branches: ['trunk', 'release/1.0'] },
      ]],
      ['project-beta', [
        { repositoryId: 'repo-2', name: 'data-service', provider: 'github', defaultBranch: 'main', branches: ['main'] },
      ]],
    ]
    for (const [projectId, sources] of seededCodeSources) this.codeSources.set(projectId, sources)

    const now = this.clock()
    const seedWorkspaces: readonly WorkspaceRecord[] = [
      {
        workspaceId: 'ws-alpha-1',
        projectId: 'project-alpha',
        ownerUserId: 'member-1',
        repositoryId: 'repo-1',
        branch: 'main',
        displayName: '云工作台主空间',
        defaultAgentProfileVersionId: 'apv-1',
        status: 'ready',
        revision: 7,
        createdAt: new Date(now - 3_600_000).toISOString(),
        updatedAt: new Date(now - 60_000).toISOString(),
      },
      {
        workspaceId: 'ws-alpha-2',
        projectId: 'project-alpha',
        ownerUserId: 'member-1',
        repositoryId: 'repo-1',
        branch: 'develop',
        displayName: '联调预置空间',
        defaultAgentProfileVersionId: 'apv-1',
        status: 'provisioning',
        revision: 1,
        createdAt: new Date(now - 1000).toISOString(),
        updatedAt: new Date(now - 1000).toISOString(),
        transitionAt: now + 60_000,
        transitionTo: 'starting',
      },
      {
        workspaceId: 'ws-alpha-3',
        projectId: 'project-alpha',
        ownerUserId: 'member-1',
        repositoryId: 'repo-1',
        branch: 'feature/fix',
        displayName: '失败待重试空间',
        defaultAgentProfileVersionId: 'apv-1',
        status: 'failed',
        revision: 3,
        lastError: '初始化失败：磁盘配额不足',
        createdAt: new Date(now - 7_200_000).toISOString(),
        updatedAt: new Date(now - 3_600_000).toISOString(),
      },
      {
        workspaceId: 'ws-beta-1',
        projectId: 'project-beta',
        ownerUserId: 'admin-1',
        repositoryId: 'repo-2',
        branch: 'main',
        displayName: '数据服务空间',
        defaultAgentProfileVersionId: 'apv-1',
        status: 'ready',
        revision: 2,
        createdAt: new Date(now - 86_400_000).toISOString(),
        updatedAt: new Date(now - 86_400_000).toISOString(),
      },
    ]
    for (const workspace of seedWorkspaces) {
      this.workspaces.set(workspace.workspaceId, { ...workspace })
      this.files.set(workspace.workspaceId, this.seedWorkspaceFiles())
    }
    const seededEvents: ReadonlyArray<readonly ['workspace' | 'changes', string, number, string, Record<string, unknown>]> = [
      ['workspace', 'ws-alpha-1', 1, 'workspace.created', { project_id: 'project-alpha' }],
      ['workspace', 'ws-alpha-1', 2, 'workspace.provisioning', { project_id: 'project-alpha' }],
      ['workspace', 'ws-alpha-1', 3, 'workspace.updated', { project_id: 'project-alpha', status: 'starting' }],
      ['workspace', 'ws-alpha-1', 4, 'workspace.ready', { project_id: 'project-alpha', status: 'ready' }],
      ['changes', 'ws-alpha-1', 7, 'changes.updated', { project_id: 'project-alpha', files: 2 }],
    ]
    for (const [resourceType, resourceId, revision, eventType, payload] of seededEvents) {
      this.appendEvent(resourceType, resourceId, revision, eventType, payload)
    }
    this.runs.set('run-seed-1', {
      runId: 'run-seed-1',
      projectId: 'project-alpha',
      workspaceId: 'ws-alpha-1',
      sessionId: 'sess-seed-1',
      agentProfileVersionId: 'apv-1',
      assetVersionIds: ['skill:code-review@1.0.0', 'knowledge:k-1', 'memory:m-1'],
      // 绑定时冻结：三条在种子目录里都是 ready，之后被撤回也不改写这里（§11.18 A）。
      assetSnapshot: {
        'skill:code-review@1.0.0': { readiness: 'ready', reason: null },
        'knowledge:k-1': { readiness: 'ready', reason: null },
        'memory:m-1': { readiness: 'ready', reason: null },
      },
      executionPolicy: {
        permission_mode: 'approval',
        tool_allowlist: ['read', 'write', 'terminal'],
        max_concurrency: 2,
        budget: 200000,
        timeout_ms: 900000,
        write_mode: 'write',
      },
      workspaceRevision: 6,
      status: 'succeeded',
      writeMode: 'read_only',
      revision: 4,
      createdAt: new Date(now - 1_800_000).toISOString(),
      updatedAt: new Date(now - 1_700_000).toISOString(),
      traceId: 'trace-seed-1',
      timeline: [
        { status: 'preparing', at: new Date(now - 1_800_000).toISOString(), reason: 'Run 已创建', operator: '演示成员', policyVersion: 'apv-1', revision: 1, traceId: 'trace-seed-1' },
        { status: 'running', at: new Date(now - 1_798_000).toISOString(), reason: '准备完成，开始执行', operator: 'system', policyVersion: 'apv-1', revision: 2, traceId: 'trace-seed-1' },
        { status: 'succeeded', at: new Date(now - 1_700_000).toISOString(), reason: '历史联调 Run', operator: 'system', policyVersion: 'apv-1', revision: 4, traceId: 'trace-seed-1' },
      ],
      pulseExtra: [{
        kind: 'test',
        at: new Date(now - 1_705_000).toISOString(),
        revision: 4,
        trace_id: 'trace-seed-1',
        summary: '工作空间测试全部通过',
        total: 12,
        passed: 12,
        failed: 0,
      }],
    })
  }

  private seedWorkspaceFiles(): FileRecord[] {
    const encoder = new TextEncoder()
    const file = (path: string, contentType: string, content: string, extra: Partial<FileRecord> = {}): FileRecord => {
      const bytes = encoder.encode(content)
      return {
        path,
        kind: 'file',
        size: bytes.byteLength,
        etag: createHash('sha256').update(bytes).digest('hex').slice(0, 16),
        contentType,
        bytes,
        ...extra,
      }
    }
    return [
      { path: 'src', kind: 'directory', size: 0, etag: 'dir-src' },
      { path: 'docs', kind: 'directory', size: 0, etag: 'dir-docs' },
      { path: 'assets', kind: 'directory', size: 0, etag: 'dir-assets' },
      file('README.md', 'text/markdown; charset=utf-8', '# 云工作空间\n\n示例说明文档。\n'),
      file('index.html', 'text/html; charset=utf-8', WORKSPACE_HTML),
      file('hostile.html', 'text/html; charset=utf-8', HOSTILE_HTML),
      file('src/app.json', 'application/json', '{\n  "name": "cloud-workbench",\n  "version": "0.3.0"\n}\n', {
        change: 'modified',
        diff: APP_JSON_DIFF,
      }),
      file('docs/notes.txt', 'text/plain; charset=utf-8', '联调记录：云工作空间状态序列。\n', {
        change: 'added',
        diff: NOTES_DIFF,
      }),
      {
        path: 'assets/logo.png',
        kind: 'file',
        size: PNG_BYTES.byteLength,
        etag: createHash('sha256').update(PNG_BYTES).digest('hex').slice(0, 16),
        contentType: 'image/png',
        bytes: PNG_BYTES,
      },
    ]
  }
}

// --- module-level helpers -----------------------------------------------------

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFailure(
  value: unknown,
): value is { readonly ok: false; readonly status: number; readonly code: string; readonly message: string } {
  return isRecordObject(value) && value.ok === false
}

/** Service-declared asset candidate metadata (never asset content or credentials). */
interface AssetCatalogEntry {
  readonly assetType: 'skill' | 'knowledge' | 'memory'
  readonly baseId: string
  readonly version: string
  readonly name: string
  readonly readiness: 'ready' | 'unavailable'
  readonly invalidReason: string | null
  readonly updatedAt: string
  /** 用途说明（§11.12）：资产选择器统一呈现。 */
  readonly purpose: string
  /** 来源（§11.12 闭集）：builtin | team | organization。 */
  readonly source: 'builtin' | 'team' | 'organization'
}

/** The asset catalog is the service's allowed range: the admin UI selects from it. */
const ASSET_CATALOG: readonly AssetCatalogEntry[] = [
  { assetType: 'skill', baseId: 'code-review', version: '1.0.0', name: '代码评审 Skill', readiness: 'ready', invalidReason: null, updatedAt: '2026-09-01T00:00:00.000Z', purpose: '对变更执行代码评审并输出结论', source: 'team' },
  { assetType: 'skill', baseId: 'code-review', version: '0.9.0', name: '代码评审 Skill（旧版）', readiness: 'unavailable', invalidReason: '版本已废弃，不再受支持', updatedAt: '2026-08-01T00:00:00.000Z', purpose: '对变更执行代码评审并输出结论', source: 'team' },
  { assetType: 'knowledge', baseId: 'k-1', version: 'v1', name: '知识库 k-1（平台架构）', readiness: 'ready', invalidReason: null, updatedAt: '2026-09-01T00:00:00.000Z', purpose: '检索平台架构决策与约定', source: 'organization' },
  { assetType: 'knowledge', baseId: 'k-2', version: 'v1', name: '知识库 k-2（数据服务）', readiness: 'ready', invalidReason: null, updatedAt: '2026-09-01T00:00:00.000Z', purpose: '检索数据服务接口与口径', source: 'team' },
  { assetType: 'knowledge', baseId: 'k-3', version: 'v1', name: '知识库 k-3（旧版文档）', readiness: 'unavailable', invalidReason: '知识库已下线', updatedAt: '2026-07-01T00:00:00.000Z', purpose: '检索旧版文档（已下线）', source: 'organization' },
  { assetType: 'knowledge', baseId: 'k-4', version: 'v1', name: '知识库 k-4（数据字典）', readiness: 'ready', invalidReason: null, updatedAt: '2026-09-01T00:00:00.000Z', purpose: '检索数据字典与字段口径', source: 'builtin' },
  { assetType: 'memory', baseId: 'm-1', version: 'v1', name: '记忆库 m-1（协作偏好）', readiness: 'ready', invalidReason: null, updatedAt: '2026-09-01T00:00:00.000Z', purpose: '召回团队协作偏好', source: 'team' },
  { assetType: 'memory', baseId: 'm-2', version: 'v1', name: '记忆库 m-2（项目约定）', readiness: 'ready', invalidReason: null, updatedAt: '2026-09-01T00:00:00.000Z', purpose: '召回项目工程约定', source: 'team' },
  { assetType: 'memory', baseId: 'm-3', version: 'v1', name: '记忆库 m-3（数据口径）', readiness: 'ready', invalidReason: null, updatedAt: '2026-09-01T00:00:00.000Z', purpose: '召回数据口径结论', source: 'organization' },
  { assetType: 'memory', baseId: 'm-4', version: 'v1', name: '记忆库 m-4（联调记录）', readiness: 'ready', invalidReason: null, updatedAt: '2026-09-01T00:00:00.000Z', purpose: '召回历史联调记录', source: 'builtin' },
]

/**
 * 镜头层可命名的记忆身份（§11.17）：每条记忆属于一个记忆库，且只在被授权的
 * 项目里可见。镜头条目与抑制端点都只认这里的身份——客户端无法命名一条服务端
 * 没有授权的记忆，也无法用记忆库 id 冒充记忆 id。
 */
const LENS_MEMORY_CATALOG: readonly { readonly memoryId: string; readonly library: string; readonly projectIds: readonly string[] }[] = [
  { memoryId: 'mem-collab-pref', library: 'memory:m-1', projectIds: ['project-alpha'] },
  { memoryId: 'mem-metrics-2025', library: 'memory:m-3', projectIds: ['project-alpha'] },
  // 只在别的项目里授权过的记忆：抑制端点必须按「未授权」拒绝，且与「不存在」同码。
  { memoryId: 'mem-beta-only', library: 'memory:m-2', projectIds: ['project-beta'] },
]

/** Resolves a versioned asset reference (`type:id@version` or `type:id`) to its catalog row. */
function assetCatalogEntryFor(reference: string): AssetCatalogEntry | undefined {
  const withoutVersion = reference.split('@')[0] ?? reference
  const separator = withoutVersion.indexOf(':')
  if (separator === -1) return undefined
  const assetType = withoutVersion.slice(0, separator)
  const baseId = withoutVersion.slice(separator + 1)
  const version = reference.includes('@') ? reference.slice(reference.indexOf('@') + 1) : undefined
  return ASSET_CATALOG.find(entry => entry.assetType === assetType && entry.baseId === baseId
    && (version === undefined || entry.version === version))
}

/** Splits an asset reference into its project-authorization key (`type:id`). */
function assetAuthorizationKey(reference: string): string {
  return reference.split('@')[0] ?? reference
}

/** 目录行的稳定键（`type:id@version`，§11.18 B）：撤回按它归键，与绑定引用是否带版本无关。 */
function assetCatalogKey(entry: AssetCatalogEntry): string {
  return `${entry.assetType}:${entry.baseId}@${entry.version}`
}

/**
 * The service's credential reference registry. Writes may only name a row here;
 * the server owns authorization and readiness — the request can never assert
 * them — and the summary carried on the wire is exactly these four fields.
 */
const CREDENTIAL_CATALOG: ReadonlyMap<string, Omit<AgentCredentialRefRecord, 'name'>> = new Map([
  ['deepseek-main', { kind: 'api_key', authorized: true, readiness: 'ready' }],
  ['deepseek-backup', { kind: 'api_key', authorized: false, readiness: 'unavailable' }],
  ['hermes-conn', { kind: 'connection', authorized: true, readiness: 'degraded' }],
])

/** Resolves a named credential reference to its server-owned summary; unknown names reject. */
function resolveCredentialRef(value: unknown): AgentCredentialRefRecord | null | string {
  if (value === undefined || value === null) return null
  if (!isRecordObject(value)) return 'credential_ref 必须是对象或 null'
  if (typeof value.name !== 'string' || value.name.length === 0) return 'credential_ref.name 必填'
  if (typeof value.kind !== 'string' || value.kind.length === 0) return 'credential_ref.kind 必填'
  const entry = CREDENTIAL_CATALOG.get(value.name)
  if (entry === undefined) return `未知凭据引用：${value.name}`
  return { name: value.name, kind: entry.kind, authorized: entry.authorized, readiness: entry.readiness }
}

/**
 * Validates a type-extension config against the agent type schema: unknown keys,
 * wrong value types, out-of-range numbers and non-member enum values all reject.
 * @returns the first violation message, or null when the config satisfies the schema.
 */
function typeExtensionViolation(
  agentType: AgentTypeRecord,
  config: Record<string, unknown>,
): string | null {
  for (const [key, value] of Object.entries(config)) {
    const field = agentType.schema.find(candidate => candidate.key === key)
    if (field === undefined) return `类型扩展字段 ${key} 不在 ${agentType.name} schema 中`
    if (value === null || value === undefined) continue
    if (field.type === 'enum') {
      if (typeof value !== 'string' || !field.enumValues.includes(value)) {
        return `类型扩展字段 ${key} 必须是 ${field.enumValues.join('|')}`
      }
      continue
    }
    if (field.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) return `类型扩展字段 ${key} 必须是数字`
      if (field.minValue !== null && value < field.minValue) return `类型扩展字段 ${key} 不能小于 ${field.minValue}`
      if (field.maxValue !== null && value > field.maxValue) return `类型扩展字段 ${key} 不能大于 ${field.maxValue}`
      continue
    }
    if (field.type === 'boolean' && typeof value !== 'boolean') return `类型扩展字段 ${key} 必须是布尔值`
    if (field.type === 'string' && typeof value !== 'string') return `类型扩展字段 ${key} 必须是字符串`
  }
  return null
}

/**
 * Validates execution-policy members: optional members that ARE present must
 * satisfy their declared type and range. Absent members stay absent.
 * @returns the first violation message, or null when the policy is well-formed.
 */
function executionPolicyViolation(policy: Record<string, unknown>): string | null {
  if (policy.permission_mode !== undefined && (typeof policy.permission_mode !== 'string' || policy.permission_mode.length === 0)) {
    return 'execution_policy.permission_mode 必须是非空字符串'
  }
  if (policy.write_mode !== undefined && policy.write_mode !== 'read_only' && policy.write_mode !== 'write') {
    return 'execution_policy.write_mode 必须是 read_only 或 write'
  }
  if (policy.tool_allowlist !== undefined) {
    if (!Array.isArray(policy.tool_allowlist) || policy.tool_allowlist.some(tool => typeof tool !== 'string' || tool.length === 0)) {
      return 'execution_policy.tool_allowlist 必须是非空字符串数组'
    }
  }
  for (const key of ['max_concurrency', 'budget', 'timeout_ms'] as const) {
    const value = policy[key]
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return `execution_policy.${key} 必须是正数`
    }
  }
  return null
}

/** Required type-extension fields the config must carry before the version may publish. */
function missingRequiredExtensions(agentType: AgentTypeRecord, config: Record<string, unknown>): string[] {
  return agentType.schema
    .filter(field => field.required && (config[field.key] === undefined || config[field.key] === null))
    .map(field => field.key)
}

/**
 * Parses one write-body `asset_bindings` value into structured bindings.
 * Every entry must name an explicit `asset_version_id` and carry an explicit
 * `required` boolean — a missing flag is never defaulted.
 * @returns the bindings, or the first violation message.
 */
function parseAssetBindings(value: unknown): {
  skills: AgentBindingRecord[]
  knowledgeBases: AgentBindingRecord[]
  memory: AgentBindingRecord | null
} | string {
  if (value === undefined) return { skills: [], knowledgeBases: [], memory: null }
  if (!isRecordObject(value)) return 'asset_bindings 必须是对象'
  const parseList = (raw: unknown, label: string): AgentBindingRecord[] | string => {
    if (raw === undefined) return []
    if (!Array.isArray(raw)) return `asset_bindings.${label} 必须是数组`
    const parsed: AgentBindingRecord[] = []
    for (const entry of raw) {
      if (!isRecordObject(entry)) return `asset_bindings.${label} 条目必须是对象`
      if (typeof entry.asset_version_id !== 'string' || entry.asset_version_id.length === 0) {
        return `asset_bindings.${label} 条目缺少 asset_version_id`
      }
      if (typeof entry.required !== 'boolean') return `asset_bindings.${label} 条目缺少 required 布尔标记`
      parsed.push({ reference: entry.asset_version_id, required: entry.required })
    }
    return parsed
  }
  const skills = parseList(value.skills, 'skills')
  if (typeof skills === 'string') return skills
  const knowledgeBases = parseList(value.knowledge_bases, 'knowledge_bases')
  if (typeof knowledgeBases === 'string') return knowledgeBases
  let memory: AgentBindingRecord | null = null
  if (value.memory !== undefined && value.memory !== null) {
    if (!isRecordObject(value.memory)) return 'asset_bindings.memory 必须是对象或 null'
    if (typeof value.memory.asset_version_id !== 'string' || value.memory.asset_version_id.length === 0) {
      return 'asset_bindings.memory 条目缺少 asset_version_id'
    }
    if (typeof value.memory.required !== 'boolean') return 'asset_bindings.memory 条目缺少 required 布尔标记'
    memory = { reference: value.memory.asset_version_id, required: value.memory.required }
  }
  return { skills, knowledgeBases, memory }
}

/** Resolves one asset reference to its display entry: catalog rows answer, absent rows surface as unavailable. */
function bindingWire(reference: string, required: boolean, order: number): Record<string, unknown> {
  const entry = assetCatalogEntryFor(reference)
  if (entry === undefined) {
    return {
      asset_id: assetAuthorizationKey(reference),
      asset_version_id: reference,
      name: reference,
      required,
      order,
      readiness: 'unavailable',
      unavailable_reason: '资产不在服务目录中',
    }
  }
  const ready = entry.readiness === 'ready'
  return {
    asset_id: `${entry.assetType}:${entry.baseId}`,
    asset_version_id: reference,
    name: entry.name,
    required,
    order,
    readiness: ready ? 'ready' : 'unavailable',
    unavailable_reason: ready ? null : entry.invalidReason,
  }
}

/**
 * Derives one version's readiness from the agent type and its bound assets.
 * An unavailable type or a required unavailable asset blocks execution;
 * an optional unavailable asset only degrades it.
 */
function versionReadiness(
  agentType: AgentTypeRecord | undefined,
  version: Pick<AgentProfileVersionRecord, 'skills' | 'knowledgeBases' | 'memory'>,
): { readonly readiness: 'ready' | 'degraded' | 'unavailable'; readonly reason: string | null } {
  if (agentType === undefined) return { readiness: 'unavailable', reason: 'Agent 类型不存在' }
  if (agentType.readiness === 'unavailable') return { readiness: 'unavailable', reason: `Agent 类型 ${agentType.name} 不可用` }
  if (agentType.readiness === 'degraded') return { readiness: 'degraded', reason: `Agent 类型 ${agentType.name} 处于降级状态` }
  const bindings = [...version.skills, ...version.knowledgeBases, ...(version.memory === null ? [] : [version.memory])]
  for (const binding of bindings) {
    const entry = assetCatalogEntryFor(binding.reference)
    if (entry === undefined) {
      return {
        readiness: binding.required ? 'unavailable' : 'degraded',
        reason: `${binding.required ? '必需' : '可选'}资产 ${binding.reference} 不在服务目录中`,
      }
    }
    if (entry.readiness !== 'ready') {
      const reason = `${binding.required ? '必需' : '可选'}资产 ${binding.reference} 不可用：${entry.invalidReason ?? '服务未提供该资产'}`
      return { readiness: binding.required ? 'unavailable' : 'degraded', reason }
    }
  }
  return { readiness: 'ready', reason: null }
}

/**
 * Validates a version's asset references for publishing: every reference must
 * exist in the catalog and be ready, and must be authorized for every project
 * the profile is bound to.
 * @returns the first failure reason, or null when the set is publishable.
 */
type AssetPublishBlock = { readonly code: 'ASSET_NOT_FOUND' | 'ASSET_NOT_READY' | 'ASSET_NOT_AUTHORIZED'; readonly message: string }

/**
 * Validates a version's asset references for publishing: every reference must
 * exist in the catalog, be ready, and be authorized for every project the
 * profile is bound to. Each failure mode carries its own stable error code.
 * @returns the first failure, or null when the set is publishable.
 */
function assetPublishBlock(
  references: readonly string[],
  boundProjectIds: readonly string[],
  projectAuthorized: (projectId: string, reference: string) => boolean,
): AssetPublishBlock | null {
  for (const reference of references) {
    const entry = assetCatalogEntryFor(reference)
    if (entry === undefined) return { code: 'ASSET_NOT_FOUND', message: `资产 ${reference} 不在服务目录中` }
    if (entry.readiness !== 'ready') {
      return { code: 'ASSET_NOT_READY', message: `资产 ${reference} 不可用：${entry.invalidReason ?? '服务未提供该资产'}` }
    }
    for (const projectId of boundProjectIds) {
      if (!projectAuthorized(projectId, reference)) {
        return { code: 'ASSET_NOT_AUTHORIZED', message: `资产 ${reference} 未授权给项目 ${projectId}` }
      }
    }
  }
  return null
}

function headerValueOf(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return typeof value === 'string' ? value : undefined
}

function expectedRevision(request: IncomingMessage, body: Record<string, unknown>): number | undefined {
  const header = headerValueOf(request, 'if-match')
  if (header !== undefined && header.length > 0) {
    const parsed = Number(header)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  const expected = body.expected_workspace_revision
  return typeof expected === 'number' && Number.isFinite(expected) ? expected : undefined
}

/** 运行级并发判据（§11.10）：If-Match 或 expected_run_revision。 */
function expectedRunRevision(request: IncomingMessage, body: Record<string, unknown>): number | undefined {
  const header = headerValueOf(request, 'if-match')
  if (header !== undefined && header.length > 0) {
    const parsed = Number(header)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  const expected = body.expected_run_revision
  return typeof expected === 'number' && Number.isFinite(expected) ? expected : undefined
}

/**
 * 资产目录行的并发判据（§11.18 B）：If-Match 或 expected_asset_revision。
 * 返回 `undefined` 时调用方必须回 428——缺并发条件不能当成「随便改」。
 */
function expectedAssetRevision(request: IncomingMessage, body: Record<string, unknown>): number | undefined {
  const header = headerValueOf(request, 'if-match')
  if (header !== undefined && header.length > 0) {
    const parsed = Number(header)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  const expected = body.expected_asset_revision
  return typeof expected === 'number' && Number.isFinite(expected) ? expected : undefined
}

/**
 * Reads one JSON write body. A body that is not valid JSON — or valid JSON that
 * is not an object — fails the request with `INVALID_RESPONSE` instead of
 * degrading into `{}`, which would turn a malformed request into a lying
 * "missing field" answer.
 * @returns the parsed body, or undefined after the failure response was written.
 */
async function readJsonBody(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<Record<string, unknown> | undefined> {
  const chunks: Uint8Array[] = []
  for await (const chunk of request as AsyncIterable<Uint8Array | string>) {
    chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk)
  }
  if (chunks.length === 0) return {}
  const total = chunks.reduce((size, chunk) => size + chunk.byteLength, 0)
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  const text = new TextDecoder().decode(merged)
  if (text.length === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    response.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'x-fixture-only': 'true' })
    response.end(JSON.stringify({ code: 'INVALID_RESPONSE', message: '请求体必须是合法 JSON', request_id: requestId, data: null }))
    return undefined
  }
  if (!isRecordObject(parsed)) {
    response.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'x-fixture-only': 'true' })
    response.end(JSON.stringify({ code: 'INVALID_RESPONSE', message: '请求体必须是 JSON 对象', request_id: requestId, data: null }))
    return undefined
  }
  return parsed
}

function normalizeWorkspacePath(raw: string): string | undefined {
  let path: string
  try {
    path = decodeURIComponent(raw)
  } catch {
    return undefined
  }
  path = path.replace(/\\/gu, '/').replace(/\/+$/u, '')
  if (path.startsWith('/')) return undefined
  if (path.split('/').some(part => part === '..' || part === '.')) return undefined
  return path
}

function baselineOf(workspace: WorkspaceRecord): number {
  return Math.max(1, workspace.revision - 2)
}

function sseFrame(eventType: string, data: unknown, eventId: string): string {
  return `event: ${eventType}\nid: ${eventId}\ndata: ${JSON.stringify(data)}\n\n`
}

function toEventDto(event: StreamEvent): Record<string, unknown> {
  return {
    event_id: event.eventId,
    resource_type: event.resourceType,
    resource_id: event.resourceId,
    revision: event.revision,
    event_type: event.eventType,
    occurred_at: event.occurredAt,
    payload: event.payload,
    fixture_only: true,
  }
}

function toAgentTypeDto(agentType: AgentTypeRecord): Record<string, unknown> {
  return {
    agent_type_id: agentType.agentTypeId,
    key: agentType.key,
    name: agentType.name,
    capabilities: [...agentType.capabilities],
    readiness: agentType.readiness,
    credential_required: agentType.credentialRequired,
    schema_version: agentType.schemaVersion,
    schema: agentType.schema.map(field => ({
      key: field.key,
      label: field.label,
      type: field.type,
      required: field.required,
      affects_publish: field.affectsPublish,
      description: field.description,
      ...(field.enumValues.length > 0 ? { enum: [...field.enumValues] } : {}),
      ...(field.minValue === null ? {} : { min: field.minValue }),
      ...(field.maxValue === null ? {} : { max: field.maxValue }),
      ...(field.defaultValue === null ? {} : { default: field.defaultValue }),
    })),
  }
}

/** Builds the enriched user-facing version DTO: card and read-only detail fields, never credentials. */
function toUserVersionDto(
  profile: AgentProfileRecord,
  version: AgentProfileVersionRecord,
  binding: ProjectBindingRecord,
  agentType: AgentTypeRecord | undefined,
): Record<string, unknown> {
  const readiness = versionReadiness(agentType, version)
  return {
    agent_profile_id: profile.agentProfileId,
    agent_profile_version_id: version.agentProfileVersionId,
    name: profile.name,
    description: profile.description,
    version_label: version.version,
    change_summary: version.changeSummary,
    agent_type_id: profile.agentTypeId,
    agent_type_name: agentType?.name ?? profile.agentTypeId,
    agent_type_key: agentType?.key ?? '',
    agent_type_readiness: agentType?.readiness ?? 'unavailable',
    agent_type_capabilities: [...(agentType?.capabilities ?? [])],
    model: version.model,
    reasoning: version.reasoning,
    skills: version.skills.map((entry, index) => bindingWire(entry.reference, entry.required, index + 1)),
    knowledge_bases: version.knowledgeBases.map((entry, index) => bindingWire(entry.reference, entry.required, index + 1)),
    memory: version.memory === null ? null : bindingWire(version.memory.reference, version.memory.required, 1),
    execution_policy: version.executionPolicy,
    type_extension_config: version.typeExtensionConfig,
    readiness: readiness.readiness,
    unavailable_reason: readiness.reason,
    default: binding.default,
    status: version.status,
    created_by: profile.createdBy,
    published_at: version.publishedAt ?? null,
    updated_at: profile.updatedAt,
    revision: profile.revision,
    fixture_only: true,
  }
}

function toVersionDto(version: AgentProfileVersionRecord): Record<string, unknown> {
  return {
    agent_profile_version_id: version.agentProfileVersionId,
    version: version.version,
    status: version.status,
    model: version.model,
    reasoning: version.reasoning,
    asset_bindings: {
      skills: version.skills.map((entry, index) => ({
        asset_id: assetAuthorizationKey(entry.reference),
        asset_version_id: entry.reference,
        required: entry.required,
        order: index + 1,
      })),
      knowledge_bases: version.knowledgeBases.map((entry, index) => ({
        asset_id: assetAuthorizationKey(entry.reference),
        asset_version_id: entry.reference,
        required: entry.required,
        order: index + 1,
      })),
      memory: version.memory === null
        ? null
        : {
          asset_id: assetAuthorizationKey(version.memory.reference),
          asset_version_id: version.memory.reference,
          required: version.memory.required,
        },
    },
    asset_version_ids: assetVersionIdsOf(version),
    execution_policy: version.executionPolicy,
    type_extension_config: version.typeExtensionConfig,
    credential_ref: version.credentialRef === null
      ? null
      : {
        name: version.credentialRef.name,
        kind: version.credentialRef.kind,
        authorized: version.credentialRef.authorized,
        readiness: version.credentialRef.readiness,
      },
    change_summary: version.changeSummary,
    ...(version.publishedAt === undefined ? {} : { published_at: version.publishedAt }),
    ...(version.publishedBy === undefined ? {} : { published_by: version.publishedBy }),
  }
}

function toAdminProfileDto(profile: AgentProfileRecord, agentTypes: readonly AgentTypeRecord[]): Record<string, unknown> {
  const published = profile.versions.find(version => version.status === 'published')
  const latest = profile.versions.at(-1)
  const cardVersion = published ?? latest
  const readiness = versionReadiness(
    agentTypes.find(candidate => candidate.agentTypeId === profile.agentTypeId),
    cardVersion ?? { skills: [], knowledgeBases: [], memory: null },
  )
  return {
    agent_profile_id: profile.agentProfileId,
    organization_id: profile.organizationId,
    name: profile.name,
    description: profile.description,
    agent_type_id: profile.agentTypeId,
    status: profile.versions.some(version => version.status === 'published')
      ? 'published'
      : profile.versions.length > 0 && profile.versions.every(version => version.status === 'archived')
        ? 'archived'
        : 'draft',
    agent_type_name: agentTypes.find(candidate => candidate.agentTypeId === profile.agentTypeId)?.name ?? profile.agentTypeId,
    agent_type_readiness: agentTypes.find(candidate => candidate.agentTypeId === profile.agentTypeId)?.readiness ?? 'unavailable',
    skill_count: cardVersion?.skills.length ?? 0,
    knowledge_count: cardVersion?.knowledgeBases.length ?? 0,
    memory_name: cardVersion !== undefined && cardVersion.memory !== null
      ? assetCatalogEntryFor(cardVersion.memory.reference)?.name ?? cardVersion.memory.reference
      : null,
    project_count: profile.projectBindings.size,
    readiness: readiness.readiness,
    unavailable_reason: readiness.reason,
    created_by: profile.createdBy,
    created_at: profile.createdAt,
    updated_at: profile.updatedAt,
    revision: profile.revision,
    versions: profile.versions.map(toVersionDto),
    project_bindings: [...profile.projectBindings.entries()].map(([projectId, binding]) => ({
      project_id: projectId,
      agent_profile_version_id: binding.agentProfileVersionId,
      default: binding.default,
      revision: binding.revision,
    })),
  }
}

function toCodeSourceDto(source: CodeSourceRecord): Record<string, unknown> {
  return {
    repository_id: source.repositoryId,
    name: source.name,
    provider: source.provider,
    default_branch: source.defaultBranch,
    branches: [...source.branches],
  }
}

function toWorkspaceDto(workspace: WorkspaceRecord): Record<string, unknown> {
  return {
    workspace_id: workspace.workspaceId,
    project_id: workspace.projectId,
    owner_user_id: workspace.ownerUserId,
    repository_id: workspace.repositoryId,
    branch: workspace.branch,
    display_name: workspace.displayName,
    default_agent_profile_version_id: workspace.defaultAgentProfileVersionId,
    status: workspace.status,
    revision: workspace.revision,
    last_error: workspace.lastError ?? null,
    created_at: workspace.createdAt,
    updated_at: workspace.updatedAt,
    fixture_only: true,
  }
}

function toRunDto(run: RunRecord): Record<string, unknown> {
  return {
    run_id: run.runId,
    trace_id: run.traceId,
    project_id: run.projectId,
    workspace_id: run.workspaceId,
    session_id: run.sessionId,
    agent_profile_version_id: run.agentProfileVersionId,
    asset_version_ids: [...run.assetVersionIds],
    execution_policy: run.executionPolicy,
    workspace_revision: run.workspaceRevision,
    status: run.status,
    write_mode: run.writeMode,
    lease_id: run.leaseId ?? null,
    operator: run.operator ?? null,
    revision: run.revision,
    ...(run.retryOfRunId === undefined ? {} : { retry_of_run_id: run.retryOfRunId }),
    ...(run.planId === undefined ? {} : { plan_id: run.planId }),
    error_code: run.errorCode ?? null,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
    checkpoint: run.checkpoint === undefined
      ? null
      : {
        created_at: run.checkpoint.createdAt,
        consumed: run.checkpoint.consumed,
        session_seq: run.checkpoint.sessionSeq,
        workspace_revision: run.checkpoint.workspaceRevision,
      },
    timeline: run.timeline.map(entry => ({
      status: entry.status,
      at: entry.at,
      reason: entry.reason,
      operator: entry.operator,
      policy_version: entry.policyVersion,
      revision: entry.revision,
      trace_id: entry.traceId,
    })),
    fixture_only: true,
  }
}

function toCheckpointDto(checkpoint: RunCheckpoint): Record<string, unknown> {
  // 恢复预览：将重用（已完成计划步骤标题 + 保留的工具结果）与将重新执行（剩余计划步骤）。
  let reuse: Array<Record<string, unknown>> = []
  let replay: Array<{ title: string }> = []
  let replayNote: string | undefined
  const stepTitles = checkpoint.steps
  if (stepTitles !== undefined) {
    reuse = stepTitles
      .map((title, index) => ({ title, index }))
      .filter(({ index }) => checkpoint.completedSteps.includes(index))
      .map(({ title }) => ({ kind: 'plan_step', title }))
    replay = stepTitles
      .map((title, index) => ({ title, index }))
      .filter(({ index }) => !checkpoint.completedSteps.includes(index))
      .map(({ title }) => ({ title }))
  } else {
    replayNote = '运行未引用计划：剩余工作以会话续跑为准，已保留的工具结果列在 reuse。'
  }
  reuse = [
    ...reuse,
    ...checkpoint.toolResults.map(entry => ({ kind: 'tool_result', call_id: entry.call_id, tool: entry.tool })),
  ]
  return {
    checkpoint_id: checkpoint.checkpointId,
    created_at: checkpoint.createdAt,
    trace_id: checkpoint.traceId,
    session_seq: checkpoint.sessionSeq,
    tool_results: checkpoint.toolResults.map(entry => ({ ...entry })),
    pending_approval: checkpoint.pendingApproval === null ? null : { ...checkpoint.pendingApproval },
    completed_steps: [...checkpoint.completedSteps],
    agent_config: {
      agent_profile_version_id: checkpoint.agentConfig.agentProfileVersionId,
      execution_policy: { ...checkpoint.agentConfig.executionPolicy },
    },
    asset_version_ids: [...checkpoint.assetVersionIds],
    workspace_revision: checkpoint.workspaceRevision,
    plan_id: checkpoint.planId,
    consumed: checkpoint.consumed,
    consumed_at: checkpoint.consumedAt,
    resume_preview: {
      reuse,
      replay,
      ...(replayNote === undefined ? {} : { replay_note: replayNote }),
    },
    fixture_only: true,
  }
}

function toPlanDto(plan: PlanRecord): Record<string, unknown> {
  return {
    plan_id: plan.planId,
    workspace_id: plan.workspaceId,
    project_id: plan.projectId,
    goal: plan.goal,
    steps: plan.steps.map(step => ({
      title: step.title,
      ...(step.dependsOn.length === 0 ? {} : { depends_on: [...step.dependsOn] }),
    })),
    agent_profile_version_id: plan.agentProfileVersionId,
    asset_version_ids: [...plan.assetVersionIds],
    status: plan.status,
    revision: plan.revision,
    created_by: plan.createdBy,
    created_at: plan.createdAt,
    updated_at: plan.updatedAt,
    ...(plan.confirmedBy === undefined ? {} : { confirmed_by: plan.confirmedBy }),
    ...(plan.confirmedAt === undefined ? {} : { confirmed_at: plan.confirmedAt }),
    edits: plan.edits.map(edit => ({
      edit_id: edit.editId,
      editor: edit.editor,
      edited_at: edit.editedAt,
      change_summary: edit.changeSummary,
      revision_before: edit.revisionBefore,
      revision_after: edit.revisionAfter,
      before: {
        goal: edit.before.goal,
        steps: edit.before.steps.map(step => ({
          title: step.title,
          ...(step.dependsOn.length === 0 ? {} : { depends_on: [...step.dependsOn] }),
        })),
        agent_profile_version_id: edit.before.agentProfileVersionId,
        asset_version_ids: [...edit.before.assetVersionIds],
      },
    })),
    fixture_only: true,
  }
}
