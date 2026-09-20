import { createHash } from 'node:crypto'
import type { AccountPrincipal, AccountStore, ProjectView } from './account-store.ts'

type MemoryStatus = 'ACTIVE' | 'DELETED'
type JobStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED'
type MemoryJobKind = 'CAPTURE' | 'INDEX_REFRESH' | 'DELETE_CLEANUP' | 'SCOPE_MOVED'

/** Governance tier of a memory (§11.16); `layer` is the unrelated storage layer. */
type MemoryTier = 'project_candidate' | 'project_confirmed' | 'team'

interface MemoryRecord {
  readonly memory_id: string
  team_id: string
  project_id: string
  content: string
  readonly layer: 'L1'
  /** Governance tier. Candidates are never recalled until a member confirms them. */
  tier: MemoryTier
  readonly captured_by_user_id: string
  readonly created_at: string
  updated_at: string
  revision: number
  status: MemoryStatus
  /** Session event that produced this record; opaque to clients (§11.16). */
  readonly source_event_id: string
  /** Candidate expiry, or null when the record never expires (§11.16). */
  expires_at: string | null
  /** Whether this memory may be promoted to a team memory (§11.16). */
  scope: 'project_only' | 'shared'
  readonly importance: number
  recall_count: number
  last_recalled_at: string | null
  readonly source_kind: 'agent_turn'
}

interface MemoryJob {
  readonly job_id: string
  readonly event_id: string
  readonly kind: MemoryJobKind
  readonly team_id: string
  readonly project_id: string
  readonly requested_by_user_id: string
  status: JobStatus
  readonly retryable: boolean
  retry_count: number
  readonly created_at: string
  finished_at: string | null
  readonly error_code: string | null
  revision: number
}

interface PolicyRecord {
  revision: number
  values: { top_k: number; relevance_threshold: number; token_budget: number }
}
interface IdempotentValue {
  readonly fingerprint: string
  readonly status: number
  readonly body: Record<string, unknown>
}

export interface ProjectMemoryFixtureResult {
  readonly status: number
  readonly body: Record<string, unknown>
}

const NOW = '2026-09-02T00:00:00.000Z'

/** Deterministic, in-memory project-memory API used only by local integration tests. */
export class ProjectMemoryFixture {
  private readonly memories = new Map<string, MemoryRecord>()
  private readonly jobs = new Map<string, MemoryJob>()
  private readonly policies = new Map<string, PolicyRecord>()
  private readonly idempotency = new Map<string, IdempotentValue>()
  private readonly audits: Array<Record<string, unknown>> = []
  private nextMemory = 1
  private nextJob = 1

  constructor(
    private readonly accounts: AccountStore,
    seed = true,
  ) {
    if (seed) this.seed()
  }

  /** Execute one authenticated project-memory operation. */
  execute(
    operation: string,
    principal: AccountPrincipal,
    body: Record<string, unknown>,
    headers: Record<string, string | undefined>,
    requestId: string,
  ): ProjectMemoryFixtureResult {
    if (operation === 'capture') return this.capture(principal, body, headers['idempotency-key'], requestId)
    if (operation === 'candidates/list') return this.candidatesList(principal, body)
    if (operation === 'candidates/merge') return this.candidatesMerge(principal, body, headers['idempotency-key'], requestId)
    if (operation.startsWith('candidates/') && operation.endsWith(':confirm')) {
      return this.candidateConfirm(
        principal,
        operation.slice('candidates/'.length, -':confirm'.length),
        body,
        headers['idempotency-key'],
        headers['if-match'],
        requestId,
      )
    }
    if (operation.startsWith('candidates/') && operation.endsWith(':retract')) {
      return this.candidateRetract(
        principal,
        operation.slice('candidates/'.length, -':retract'.length),
        body,
        headers['idempotency-key'],
        headers['if-match'],
        requestId,
      )
    }
    if (operation.endsWith(':expire')) {
      return this.memoryExpire(
        principal,
        operation.slice(0, -':expire'.length),
        body,
        headers['idempotency-key'],
        headers['if-match'],
        requestId,
      )
    }
    if (operation === 'recall') return this.recall(principal, body, headers['x-fixture-scenario'])
    if (operation === 'list' || operation === 'search') return this.list(principal, body)
    if (operation === 'get') return this.get(principal, body)
    if (operation === 'update') return this.update(principal, body, headers['idempotency-key'], headers['if-match'], requestId)
    if (operation === 'delete') return this.delete(principal, body, headers['idempotency-key'], headers['if-match'], requestId)
    if (operation === 'policy/get') return this.policyGet(principal, body)
    if (operation === 'policy/update') return this.policyUpdate(principal, body, headers['if-match'], headers['idempotency-key'], requestId)
    if (operation === 'jobs/list') return this.jobsList(principal, body)
    if (operation === 'jobs/get') return this.jobGet(principal, body)
    if (operation === 'jobs/retry') return this.jobRetry(principal, body, headers['idempotency-key'], headers['if-match'], requestId)
    if (operation === 'audit/list') return this.auditList(principal, body)
    return failure(404, 'NOT_FOUND', '项目记忆资源不存在')
  }

  private capture(
    principal: AccountPrincipal,
    body: Record<string, unknown>,
    key: string | undefined,
    requestId: string,
  ): ProjectMemoryFixtureResult {
    const project = this.project(principal, body.project_id)
    if (project === undefined) return failure(403, 'PROJECT_ACCESS_DENIED', '当前账号无权访问项目')
    if (key === undefined || key.length === 0) return failure(400, 'IDEMPOTENCY_KEY_REQUIRED', '捕获必须提供 Idempotency-Key')
    const fingerprint = hash(body)
    const replay = this.replay(key, fingerprint)
    if (replay !== undefined) return replay
    // Minted before the loop so every captured record can name the event that
    // produced it — §11.16 requires a non-empty `source_event_id`.
    const job = this.newJob('CAPTURE', project, principal.userId, false)
    const messages = Array.isArray(body.messages) ? body.messages : []
    let accepted = 0
    for (const value of messages) {
      if (!record(value) || (value.role !== 'user' && value.role !== 'assistant') || typeof value.content !== 'string') continue
      const content = sanitize(value.content)
      if (content.length === 0 || content.startsWith('/')) continue
      const memoryId = `memory-${project.project_id}-capture-${this.nextMemory++}`
      this.memories.set(memoryId, {
        memory_id: memoryId,
        team_id: teamFor(project),
        project_id: project.project_id,
        content,
        layer: 'L1',
        // §11.16: an automatic capture is a candidate. It is not recalled until a
        // member confirms it — the whole point of the tier is that auto-captured
        // content is never treated as shared fact on its own.
        tier: 'project_candidate',
        captured_by_user_id: principal.userId,
        created_at: NOW,
        updated_at: NOW,
        revision: 1,
        status: 'ACTIVE',
        source_event_id: job.event_id,
        expires_at: null,
        scope: 'shared',
        importance: 0.5,
        recall_count: 0,
        last_recalled_at: null,
        source_kind: 'agent_turn',
      })
      this.accounts.registerProjectAsset(project.project_id, 'memory', memoryId, 'context')
      accepted += 1
    }
    const result = this.remember(key, fingerprint, 202, {
      event_id: job.event_id,
      job_id: job.job_id,
      status: 'PENDING',
      accepted_count: accepted,
    })
    this.audit(principal, 'CAPTURE_ACCEPTED', project.project_id, job.event_id, undefined, requestId)
    return result
  }

  /** List the project's unconfirmed candidates (§11.16). */
  private candidatesList(principal: AccountPrincipal, body: Record<string, unknown>): ProjectMemoryFixtureResult {
    const project = this.project(principal, body.project_id)
    if (project === undefined) return failure(403, 'PROJECT_ACCESS_DENIED', '当前账号无权访问项目')
    const items = [...this.memories.values()]
      .filter(
        memory =>
          memory.status === 'ACTIVE' &&
          memory.tier === 'project_candidate' &&
          memory.project_id === project.project_id,
      )
      .sort(memoryOrder)
    return success({ items: items.map(memoryView) })
  }

  /**
   * Confirm one candidate so it stops being a candidate and starts being
   * recalled (§11.16). Requires an idempotency key and a revision guard like
   * every other memory write, and is a no-op state conflict when the record is
   * not actually a candidate.
   */
  private candidateConfirm(
    principal: AccountPrincipal,
    memoryId: string,
    body: Record<string, unknown>,
    key: string | undefined,
    headerRevision: string | undefined,
    requestId: string,
  ): ProjectMemoryFixtureResult {
    if (key === undefined || key.length === 0) return failure(400, 'IDEMPOTENCY_KEY_REQUIRED', '确认必须提供 Idempotency-Key')
    if (headerRevision === undefined) return failure(400, 'IF_MATCH_REQUIRED', '确认必须提供 If-Match')
    const fingerprint = hash({ memory_id: memoryId, body })
    const replay = this.replay(key, fingerprint)
    if (replay !== undefined) return replay
    const memory = this.visibleMemory(principal, memoryId)
    if (memory === undefined) return failure(404, 'MEMORY_NOT_FOUND', '记忆不存在')
    if (principal.role === 'member' && memory.captured_by_user_id !== principal.userId)
      return failure(403, 'MEMORY_EDIT_FORBIDDEN', '只能确认自己捕获的记忆')
    if (!revisionMatches(memory.revision, body.expected_revision, headerRevision))
      return failure(409, 'MEMORY_REVISION_CONFLICT', '记忆已更新，请刷新后重试')
    if (memory.tier !== 'project_candidate') return failure(409, 'INVALID_STATE', '只有候选记忆可以确认')
    memory.tier = 'project_confirmed'
    memory.revision += 1
    memory.updated_at = NOW
    this.audit(principal, 'CANDIDATE_CONFIRMED', memory.project_id, memoryId, memoryId, requestId)
    return this.remember(key, fingerprint, 200, { memory: memoryView(memory) })
  }

  /**
   * Return a confirmed memory to candidate (§11.16). The record is not deleted —
   * the effect is that it stops being recalled, because recall skips candidates.
   */
  private candidateRetract(
    principal: AccountPrincipal,
    memoryId: string,
    body: Record<string, unknown>,
    key: string | undefined,
    headerRevision: string | undefined,
    requestId: string,
  ): ProjectMemoryFixtureResult {
    if (key === undefined || key.length === 0) return failure(400, 'IDEMPOTENCY_KEY_REQUIRED', '撤回必须提供 Idempotency-Key')
    if (headerRevision === undefined) return failure(400, 'IF_MATCH_REQUIRED', '撤回必须提供 If-Match')
    const fingerprint = hash({ memory_id: memoryId, body })
    const replay = this.replay(key, fingerprint)
    if (replay !== undefined) return replay
    const memory = this.visibleMemory(principal, memoryId)
    if (memory === undefined) return failure(404, 'MEMORY_NOT_FOUND', '记忆不存在')
    if (principal.role === 'member' && memory.captured_by_user_id !== principal.userId)
      return failure(403, 'MEMORY_EDIT_FORBIDDEN', '只能撤回自己捕获的记忆')
    if (!revisionMatches(memory.revision, body.expected_revision, headerRevision))
      return failure(409, 'MEMORY_REVISION_CONFLICT', '记忆已更新，请刷新后重试')
    if (memory.tier !== 'project_confirmed') return failure(409, 'INVALID_STATE', '只有已确认的记忆可以撤回')
    memory.tier = 'project_candidate'
    memory.revision += 1
    memory.updated_at = NOW
    this.audit(principal, 'CANDIDATE_RETRACTED', memory.project_id, memoryId, memoryId, requestId)
    return this.remember(key, fingerprint, 200, { memory: memoryView(memory) })
  }

  /**
   * Set or clear one memory's expiry (§11.16). An expired candidate cannot be
   * confirmed; `null` clears the expiry rather than storing an empty string.
   */
  private memoryExpire(
    principal: AccountPrincipal,
    memoryId: string,
    body: Record<string, unknown>,
    key: string | undefined,
    headerRevision: string | undefined,
    requestId: string,
  ): ProjectMemoryFixtureResult {
    if (key === undefined || key.length === 0) return failure(400, 'IDEMPOTENCY_KEY_REQUIRED', '设置过期必须提供 Idempotency-Key')
    if (headerRevision === undefined) return failure(400, 'IF_MATCH_REQUIRED', '设置过期必须提供 If-Match')
    const expiresAt = body.expires_at
    if (expiresAt !== null && (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))))
      return failure(422, 'VALIDATION_ERROR', 'expires_at 必须是 ISO 时刻或 null')
    const fingerprint = hash({ memory_id: memoryId, body })
    const replay = this.replay(key, fingerprint)
    if (replay !== undefined) return replay
    const memory = this.visibleMemory(principal, memoryId)
    if (memory === undefined) return failure(404, 'MEMORY_NOT_FOUND', '记忆不存在')
    if (principal.role === 'member' && memory.captured_by_user_id !== principal.userId)
      return failure(403, 'MEMORY_EDIT_FORBIDDEN', '只能设置自己捕获的记忆')
    if (!revisionMatches(memory.revision, body.expected_revision, headerRevision))
      return failure(409, 'MEMORY_REVISION_CONFLICT', '记忆已更新，请刷新后重试')
    memory.expires_at = expiresAt
    memory.revision += 1
    memory.updated_at = NOW
    this.audit(principal, 'MEMORY_EXPIRY_SET', memory.project_id, memoryId, memoryId, requestId)
    return this.remember(key, fingerprint, 200, { memory: memoryView(memory) })
  }

  /**
   * Merge several candidates into one new candidate (§11.16).
   *
   * All-or-nothing: if any source is not an active candidate of the same project
   * the whole request is rejected. A partial merge would silently drop content
   * the caller believed had been folded in.
   */
  private candidatesMerge(
    principal: AccountPrincipal,
    body: Record<string, unknown>,
    key: string | undefined,
    requestId: string,
  ): ProjectMemoryFixtureResult {
    if (key === undefined || key.length === 0) return failure(400, 'IDEMPOTENCY_KEY_REQUIRED', '合并必须提供 Idempotency-Key')
    const memoryIds = Array.isArray(body.memory_ids)
      ? body.memory_ids.filter((value): value is string => typeof value === 'string' && value.length > 0)
      : []
    if (memoryIds.length < 2 || new Set(memoryIds).size !== memoryIds.length)
      return failure(422, 'VALIDATION_ERROR', '合并需要至少两条不重复的候选')
    const content = typeof body.content === 'string' ? body.content.trim() : ''
    if (content.length === 0) return failure(422, 'VALIDATION_ERROR', '合并后的正文不能为空')
    const fingerprint = hash(body)
    const replay = this.replay(key, fingerprint)
    if (replay !== undefined) return replay

    const sources: MemoryRecord[] = []
    for (const memoryId of memoryIds) {
      const memory = this.visibleMemory(principal, memoryId)
      if (memory === undefined || memory.status !== 'ACTIVE' || memory.tier !== 'project_candidate')
        return failure(422, 'VALIDATION_ERROR', '只能合并同一项目下处于候选状态的记忆')
      sources.push(memory)
    }
    const [first, ...rest] = sources
    if (first === undefined) return failure(422, 'VALIDATION_ERROR', '合并需要至少两条候选')
    const projectId = first.project_id
    if (rest.some(memory => memory.project_id !== projectId))
      return failure(422, 'VALIDATION_ERROR', '只能合并同一项目下处于候选状态的记忆')
    const project = this.projectById(projectId)
    if (project === undefined) return failure(404, 'PROJECT_ACCESS_DENIED', '项目不存在')

    const job = this.newJob('CAPTURE', project, principal.userId, false)
    const mergedId = `memory-${projectId}-merge-${this.nextMemory++}`
    const merged: MemoryRecord = {
      memory_id: mergedId,
      team_id: teamFor(project),
      project_id: projectId,
      content,
      layer: 'L1',
      // A merge of candidates is still a candidate: nothing here is confirmed.
      tier: 'project_candidate',
      source_event_id: job.event_id,
      expires_at: null,
      scope: 'shared',
      captured_by_user_id: principal.userId,
      created_at: NOW,
      updated_at: NOW,
      revision: 1,
      status: 'ACTIVE',
      importance: 0.5,
      recall_count: 0,
      last_recalled_at: null,
      source_kind: 'agent_turn',
    }
    this.memories.set(mergedId, merged)
    this.accounts.registerProjectAsset(projectId, 'memory', mergedId, 'context')
    for (const source of sources) {
      source.status = 'DELETED'
      source.revision += 1
      source.updated_at = NOW
      this.accounts.unregisterProjectAsset(projectId, 'memory', source.memory_id)
      const cleanup = this.newJob('DELETE_CLEANUP', project, principal.userId, false)
      this.audit(principal, 'CANDIDATE_MERGED', projectId, cleanup.event_id, source.memory_id, requestId)
    }
    return this.remember(key, fingerprint, 202, {
      memory: memoryView(merged),
      event_id: job.event_id,
      job_id: job.job_id,
      status: 'PENDING',
    })
  }

  private recall(principal: AccountPrincipal, body: Record<string, unknown>, scenario: string | undefined): ProjectMemoryFixtureResult {
    if (scenario === 'unavailable') return failure(503, 'MEMORY_SERVICE_UNAVAILABLE', '记忆服务暂不可用')
    const project = this.project(principal, body.project_id)
    if (project === undefined) return failure(403, 'PROJECT_ACCESS_DENIED', '当前账号无权访问项目')
    const query = typeof body.query === 'string' ? body.query.trim().toLocaleLowerCase() : ''
    const items = [...this.memories.values()]
      .filter(
        memory =>
          memory.status === 'ACTIVE' &&
          // §11.16: a candidate is not a shared fact yet, so it must never reach
          // a model context. Only confirmed and team memories are recalled.
          memory.tier !== 'project_candidate' &&
          memory.project_id === project.project_id &&
          (query.length === 0 || memory.content.toLocaleLowerCase().includes(query)),
      )
      .sort(memoryOrder)
    const now = NOW
    for (const memory of items) {
      memory.recall_count += 1
      memory.last_recalled_at = now
    }
    return success({
      status: 'READY',
      items: items.map(memory => recallView(memory, query)),
      context_text: items.map(memory => memory.content).join('\n'),
      strategy: 'server',
      effective_policy: this.policy(project.project_id).values,
    })
  }

  private list(principal: AccountPrincipal, body: Record<string, unknown>): ProjectMemoryFixtureResult {
    const projectIds = this.visibleProjectIds(principal, body)
    if (projectIds === undefined) return failure(422, 'PROJECT_CONTEXT_REQUIRED', '项目上下文不能为空')
    if (projectIds.length === 0) return failure(403, 'PROJECT_ACCESS_DENIED', '当前账号无权访问项目')
    const filter = {
      project_id: typeof body.project_id === 'string' ? body.project_id : null,
      keyword: typeof body.keyword === 'string' ? body.keyword : typeof body.query === 'string' ? body.query : '',
      status: typeof body.status === 'string' ? body.status : 'ACTIVE',
    }
    if (filter.status !== 'ACTIVE') return failure(400, 'INVALID_REQUEST', '普通列表只能查询 ACTIVE 记忆')
    const offset = readCursor(body.cursor, filter)
    if (offset === null) return failure(400, 'INVALID_CURSOR', '游标与当前筛选条件不匹配')
    const keyword = filter.keyword.toLocaleLowerCase()
    const limit = Math.min(Math.max(typeof body.limit === 'number' && Number.isFinite(body.limit) ? body.limit : 50, 1), 100)
    const items = [...this.memories.values()]
      .filter(
        memory =>
          projectIds.includes(memory.project_id) &&
          memory.status === filter.status &&
          (keyword.length === 0 || memory.content.toLocaleLowerCase().includes(keyword)),
      )
      .sort(memoryOrder)
    const page = items.slice(offset, offset + limit)
    return success({
      items: page.map(memoryView),
      next_cursor: offset + limit < items.length ? cursor(filter, offset + limit) : null,
      total_estimate: items.length,
    })
  }

  private get(principal: AccountPrincipal, body: Record<string, unknown>): ProjectMemoryFixtureResult {
    const memory = this.visibleMemory(principal, body.memory_id)
    return memory === undefined
      ? failure(404, 'MEMORY_NOT_FOUND', '记忆不存在')
      : success({ ...memoryView(memory), layers: { L2: null, L3: null }, source_summary: { kind: memory.source_kind } })
  }

  private update(
    principal: AccountPrincipal,
    body: Record<string, unknown>,
    key: string | undefined,
    headerRevision: string | undefined,
    requestId: string,
  ): ProjectMemoryFixtureResult {
    if (key === undefined || key.length === 0) return failure(400, 'IDEMPOTENCY_KEY_REQUIRED', '更新必须提供 Idempotency-Key')
    if (headerRevision === undefined) return failure(400, 'IF_MATCH_REQUIRED', '更新必须提供 If-Match')
    const fingerprint = hash(body)
    const replay = this.replay(key, fingerprint)
    if (replay !== undefined) return replay
    const memory = this.visibleMemory(principal, body.memory_id)
    if (memory === undefined) return failure(404, 'MEMORY_NOT_FOUND', '记忆不存在')
    if (principal.role === 'member' && memory.captured_by_user_id !== principal.userId)
      return failure(403, 'MEMORY_EDIT_FORBIDDEN', '只能编辑自己捕获的记忆')
    if (!revisionMatches(memory.revision, body.expected_revision, headerRevision))
      return failure(409, 'MEMORY_REVISION_CONFLICT', '记忆已更新，请刷新后重试')
    if (typeof body.content !== 'string' || body.content.trim().length === 0) return failure(400, 'INVALID_REQUEST', '正文不能为空')
    memory.content = body.content.trim()
    memory.revision += 1
    memory.updated_at = NOW
    const project = this.projectById(memory.project_id)
    if (project === undefined) return failure(404, 'PROJECT_ACCESS_DENIED', '项目不存在')
    const job = this.newJob('INDEX_REFRESH', project, principal.userId, false)
    this.audit(principal, 'MEMORY_UPDATED', project.project_id, job.event_id, memory.memory_id, requestId)
    return this.remember(key, fingerprint, 202, {
      memory: memoryView(memory),
      event_id: job.event_id,
      job_id: job.job_id,
      status: 'INDEX_PENDING',
    })
  }

  private delete(
    principal: AccountPrincipal,
    body: Record<string, unknown>,
    key: string | undefined,
    headerRevision: string | undefined,
    requestId: string,
  ): ProjectMemoryFixtureResult {
    if (key === undefined || key.length === 0) return failure(400, 'IDEMPOTENCY_KEY_REQUIRED', '删除必须提供 Idempotency-Key')
    if (headerRevision === undefined) return failure(400, 'IF_MATCH_REQUIRED', '删除必须提供 If-Match')
    const fingerprint = hash(body)
    const replay = this.replay(key, fingerprint)
    if (replay !== undefined) return replay
    const memory = this.visibleMemory(principal, body.memory_id)
    if (memory === undefined) return failure(404, 'MEMORY_NOT_FOUND', '记忆不存在')
    if (principal.role === 'member' && memory.captured_by_user_id !== principal.userId)
      return failure(403, 'MEMORY_DELETE_FORBIDDEN', '只能删除自己捕获的记忆')
    if (!revisionMatches(memory.revision, body.expected_revision, headerRevision))
      return failure(409, 'MEMORY_REVISION_CONFLICT', '记忆已更新，请刷新后重试')
    memory.status = 'DELETED'
    this.accounts.unregisterProjectAsset(memory.project_id, 'memory', memory.memory_id)
    const project = this.projectById(memory.project_id)
    if (project === undefined) return failure(404, 'PROJECT_ACCESS_DENIED', '项目不存在')
    const failed = body.fixture_cleanup_failed === true
    const job = this.newJob('DELETE_CLEANUP', project, principal.userId, failed)
    this.audit(principal, 'MEMORY_DELETED', project.project_id, job.event_id, memory.memory_id, requestId)
    return this.remember(key, fingerprint, 202, {
      event_id: job.event_id,
      job_id: job.job_id,
      status: 'PENDING',
      cleanup_status: failed ? 'FAILED' : 'PENDING',
    })
  }

  private policyGet(principal: AccountPrincipal, body: Record<string, unknown>): ProjectMemoryFixtureResult {
    const scope = scopeKey(body)
    if (
      scope.kind !== 'project' ||
      (principal.role === 'member' && this.project(principal, scope.id) === undefined) ||
      (principal.role === 'manager' && this.project(principal, scope.id) === undefined)
    )
      return failure(403, 'PROJECT_ACCESS_DENIED', '当前角色不能读取该策略')
    const policy = this.policy(scope.id)
    return success({
      scope_type: scope.kind,
      scope_id: scope.id,
      revision: policy.revision,
      values: policy.values,
      inherited_from: 'organization',
    })
  }

  private policyUpdate(
    principal: AccountPrincipal,
    body: Record<string, unknown>,
    headerRevision: string | undefined,
    key: string | undefined,
    requestId: string,
  ): ProjectMemoryFixtureResult {
    const scope = scopeKey(body)
    if (principal.role === 'member' || scope.kind !== 'project' || this.project(principal, scope.id) === undefined)
      return failure(403, 'PROJECT_ACCESS_DENIED', '当前角色不能修改该策略')
    if (key === undefined || key.length === 0) return failure(400, 'IDEMPOTENCY_KEY_REQUIRED', '策略更新必须提供 Idempotency-Key')
    if (headerRevision === undefined) return failure(400, 'IF_MATCH_REQUIRED', '策略更新必须提供 If-Match')
    const fingerprint = hash(body)
    const replay = this.replay(key, fingerprint)
    if (replay !== undefined) return replay
    const policy = this.policy(scope.id)
    if (!revisionMatches(policy.revision, body.expected_revision, headerRevision))
      return failure(409, 'MEMORY_REVISION_CONFLICT', '策略已更新，请刷新后重试')
    const patch = record(body.patch) ? body.patch : {}
    const topK = typeof patch.top_k === 'number' ? patch.top_k : policy.values.top_k
    const relevanceThreshold = typeof patch.relevance_threshold === 'number' ? patch.relevance_threshold : policy.values.relevance_threshold
    const tokenBudget = typeof patch.token_budget === 'number' ? patch.token_budget : policy.values.token_budget
    if (topK < 1 || topK > 8 || relevanceThreshold < 0 || relevanceThreshold > 1 || tokenBudget < 1)
      return failure(422, 'POLICY_LIMIT_EXCEEDED', '记忆策略参数超出范围')
    policy.values = { top_k: topK, relevance_threshold: relevanceThreshold, token_budget: tokenBudget }
    policy.revision += 1
    this.audit(principal, 'POLICY_UPDATED', scope.id, `memory-policy-${scope.id}-${policy.revision}`, undefined, requestId)
    return this.remember(key, fingerprint, 200, {
      scope_type: scope.kind,
      scope_id: scope.id,
      revision: policy.revision,
      values: policy.values,
    })
  }

  private jobsList(principal: AccountPrincipal, body: Record<string, unknown>): ProjectMemoryFixtureResult {
    const visible = this.visibleProjectIds(principal, body)
    if (visible === undefined) return failure(422, 'PROJECT_CONTEXT_REQUIRED', '项目上下文不能为空')
    const items = [...this.jobs.values()]
      .filter(job => visible.includes(job.project_id) && (principal.role !== 'member' || job.requested_by_user_id === principal.userId))
      .map(jobView)
    return success({ items, next_cursor: null })
  }

  private jobGet(principal: AccountPrincipal, body: Record<string, unknown>): ProjectMemoryFixtureResult {
    const job = typeof body.job_id === 'string' ? this.jobs.get(body.job_id) : undefined
    const visible =
      job !== undefined &&
      this.visibleProjectIds(principal, { project_id: job.project_id })?.includes(job.project_id) === true &&
      (principal.role !== 'member' || job.requested_by_user_id === principal.userId)
    return !visible ? failure(404, 'JOB_NOT_FOUND', '任务不存在') : success(jobView(job))
  }

  private jobRetry(
    principal: AccountPrincipal,
    body: Record<string, unknown>,
    key: string | undefined,
    headerRevision: string | undefined,
    requestId: string,
  ): ProjectMemoryFixtureResult {
    if (principal.role === 'member') return failure(403, 'PROJECT_ACCESS_DENIED', '任务重试需要管理权限')
    if (key === undefined || key.length === 0) return failure(400, 'IDEMPOTENCY_KEY_REQUIRED', '重试必须提供 Idempotency-Key')
    if (headerRevision === undefined) return failure(400, 'IF_MATCH_REQUIRED', '任务重试必须提供 If-Match')
    const job = typeof body.job_id === 'string' ? this.jobs.get(body.job_id) : undefined
    if (job === undefined || this.project(principal, job.project_id) === undefined) return failure(404, 'JOB_NOT_FOUND', '任务不存在')
    const fingerprint = hash(body)
    const replay = this.replay(key, fingerprint)
    if (replay !== undefined) return replay
    if (!revisionMatches(job.revision, body.expected_revision, headerRevision))
      return failure(409, 'MEMORY_REVISION_CONFLICT', '任务已更新，请刷新后重试')
    job.status = 'PENDING'
    job.retry_count += 1
    job.revision += 1
    job.finished_at = null
    this.audit(principal, 'JOB_RETRIED', job.project_id, job.event_id, undefined, requestId)
    return this.remember(key, fingerprint, 202, jobView(job))
  }

  private auditList(principal: AccountPrincipal, body: Record<string, unknown>): ProjectMemoryFixtureResult {
    if (principal.role === 'member') return failure(403, 'PROJECT_ACCESS_DENIED', '审计查询需要管理权限')
    const projectId = typeof body.project_id === 'string' ? body.project_id : undefined
    if (projectId !== undefined && this.project(principal, projectId) === undefined)
      return failure(403, 'PROJECT_ACCESS_DENIED', '当前账号无权访问项目')
    return success({ items: this.audits.filter(item => projectId === undefined || item.project_id === projectId), next_cursor: null })
  }

  private project(principal: AccountPrincipal, value: unknown): ProjectView | undefined {
    if (typeof value !== 'string' || value.length === 0) return undefined
    const result = this.accounts.authorizeProject(principal, value)
    return isProject(result) ? result : undefined
  }

  private projectById(value: string): ProjectView | undefined {
    const result = this.accounts.authorizeProject(
      { token: 'fixture', userId: 'admin-1', displayName: 'fixture', role: 'admin', groups: [], mustChangePassword: false },
      value,
    )
    return isProject(result) ? result : undefined
  }

  private visibleMemory(principal: AccountPrincipal, value: unknown): MemoryRecord | undefined {
    if (typeof value !== 'string') return undefined
    const memory = this.memories.get(value)
    return memory !== undefined && memory.status === 'ACTIVE' && this.project(principal, memory.project_id) !== undefined
      ? memory
      : undefined
  }

  private visibleProjectIds(principal: AccountPrincipal, body: Record<string, unknown>): string[] | undefined {
    const requested = typeof body.project_id === 'string' && body.project_id.length > 0 ? body.project_id : undefined
    if (principal.role === 'member' && requested === undefined) return undefined
    if (requested !== undefined) return this.project(principal, requested) === undefined ? [] : [requested]
    const projects = this.accounts.listMemberProjects(principal)
    return projects.map(project => project.project_id)
  }

  private policy(id: string): PolicyRecord {
    const existing = this.policies.get(id)
    if (existing !== undefined) return existing
    const value: PolicyRecord = { revision: 1, values: { top_k: 8, relevance_threshold: 0.4, token_budget: 1200 } }
    this.policies.set(id, value)
    return value
  }

  private newJob(kind: MemoryJobKind, project: ProjectView, userId: string, failed: boolean): MemoryJob {
    const number = this.nextJob++
    const job: MemoryJob = {
      job_id: `memory-job-${number}`,
      event_id: `memory-event-${number}`,
      kind,
      team_id: teamFor(project),
      project_id: project.project_id,
      requested_by_user_id: userId,
      status: failed ? 'FAILED' : 'PENDING',
      retryable: failed,
      retry_count: 0,
      created_at: NOW,
      finished_at: failed ? NOW : null,
      error_code: failed ? 'MEMORY_SERVICE_UNAVAILABLE' : null,
      revision: 0,
    }
    this.jobs.set(job.job_id, job)
    return job
  }

  private audit(
    principal: AccountPrincipal,
    operation: string,
    projectId: string,
    eventId: string,
    memoryId: string | undefined,
    requestId: string,
  ): void {
    this.audits.push({
      audit_id: `memory-audit-${this.audits.length + 1}`,
      operation,
      // 审计字段契约（API 需求 §7.3）：字面 actor_name，与授权/Skill/Workspace 审计一致。
      actor_name: principal.displayName,
      operated_by_user_id: principal.userId,
      role: principal.role,
      memory_id: memoryId ?? null,
      project_id: projectId,
      result: 'SUCCEEDED',
      event_id: eventId,
      request_id: requestId,
    })
  }

  private replay(key: string, fingerprint: string): ProjectMemoryFixtureResult | undefined {
    const previous = this.idempotency.get(key)
    if (previous === undefined) return undefined
    return previous.fingerprint === fingerprint
      ? { status: previous.status, body: previous.body }
      : failure(409, 'IDEMPOTENCY_CONFLICT', '幂等键已用于另一请求')
  }

  private remember(key: string, fingerprint: string, status: number, body: Record<string, unknown>): ProjectMemoryFixtureResult {
    this.idempotency.set(key, { fingerprint, status, body })
    return { status, body }
  }

  private seed(): void {
    this.memories.set('m-1', {
      memory_id: 'm-1',
      team_id: 'team-alpha',
      project_id: 'project-alpha',
      content: 'Alpha uses strict TypeScript checks.',
      layer: 'L1',
      tier: 'project_confirmed',
      source_event_id: 'seed-event-m-1',
      expires_at: null,
      scope: 'shared',
      captured_by_user_id: 'member-1',
      created_at: NOW,
      updated_at: NOW,
      revision: 1,
      status: 'ACTIVE',
      importance: 0.8,
      recall_count: 0,
      last_recalled_at: null,
      source_kind: 'agent_turn',
    })
    this.memories.set('m-2', {
      memory_id: 'm-2',
      team_id: 'team-alpha',
      project_id: 'project-alpha',
      content: 'Alpha deploys through the release pipeline.',
      layer: 'L1',
      tier: 'project_confirmed',
      source_event_id: 'seed-event-m-2',
      expires_at: null,
      scope: 'shared',
      captured_by_user_id: 'manager-1',
      created_at: NOW,
      updated_at: NOW,
      revision: 1,
      status: 'ACTIVE',
      importance: 0.7,
      recall_count: 0,
      last_recalled_at: null,
      source_kind: 'agent_turn',
    })
    this.memories.set('m-3', {
      memory_id: 'm-3',
      team_id: 'team-beta',
      project_id: 'project-beta',
      content: 'Beta owns platform reliability.',
      layer: 'L1',
      tier: 'project_confirmed',
      source_event_id: 'seed-event-m-3',
      expires_at: null,
      scope: 'shared',
      captured_by_user_id: 'admin-1',
      created_at: NOW,
      updated_at: NOW,
      revision: 1,
      status: 'ACTIVE',
      importance: 0.9,
      recall_count: 0,
      last_recalled_at: null,
      source_kind: 'agent_turn',
    })
  }
}

function success(data: Record<string, unknown>): ProjectMemoryFixtureResult {
  return { status: 200, body: { ...data } }
}
function failure(status: number, code: string, message: string): ProjectMemoryFixtureResult {
  return { status, body: { code, message } }
}
function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function isProject(value: unknown): value is ProjectView {
  return record(value) && typeof value.project_id === 'string' && typeof value.organization_id === 'string'
}
function teamFor(project: ProjectView): string {
  return `team-${project.organization_id}`
}
function sanitize(value: string): string {
  return value
    .replace(/<relevant-memories>[\s\S]*?<\/relevant-memories>/giu, '')
    .replace(/<project-memory-reference>[\s\S]*?<\/project-memory-reference>/giu, '')
    .replace(/```[\s\S]*?```/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
}
function memoryOrder(left: MemoryRecord, right: MemoryRecord): number {
  return right.updated_at.localeCompare(left.updated_at) || right.memory_id.localeCompare(left.memory_id)
}
function memoryView(memory: MemoryRecord): Record<string, unknown> {
  return { ...memory }
}

/**
 * Project one recall hit with its provenance (§11.16).
 *
 * `score` and `confidence` are deliberately different facts: `score` is how well
 * the query matched this memory's text, `confidence` is how corroborated the
 * memory itself is (how often it has been recalled). Neither is `importance`,
 * which weights content and must never stand in for confidence.
 *
 * A recall hit is its own shape, not the stored record: the record has no
 * `score`, so spreading it here would ship an item the Host's strict parser
 * must reject.
 * @param memory - recalled record, after this recall has been counted.
 * @param query - normalized query; empty means a project-scope listing.
 * @returns the wire item for one recall hit.
 */
function recallView(memory: MemoryRecord, query: string): Record<string, unknown> {
  const normalized = memory.content.toLocaleLowerCase()
  const prefixMatch = query.length > 0 && normalized.startsWith(query)
  return {
    memory_id: memory.memory_id,
    content: memory.content,
    score: query.length === 0 ? 0.5 : prefixMatch ? 1 : 0.8,
    layer: 'L1',
    recall_reason: query.length === 0 ? 'PROJECT_SCOPE' : prefixMatch ? 'PREFIX_MATCH' : 'CONTENT_MATCH',
    // Captures carry no run identity, so a non-run source is an explicit null.
    source_run_id: null,
    updated_at: memory.updated_at,
    confidence: Math.min(1, 0.5 + 0.1 * (memory.recall_count - 1)),
  }
}
function jobView(job: MemoryJob): Record<string, unknown> {
  return { ...job }
}
function revisionMatches(current: number, body: unknown, header: string | undefined): boolean {
  const expected = typeof body === 'number' ? body : Number(body)
  return Number.isFinite(expected) && expected === current && (header === undefined || Number(header.replaceAll('"', '')) === current)
}
function scopeKey(body: Record<string, unknown>): { kind: 'project' | 'organization' | 'global'; id: string } {
  const kind =
    body.scope_type === 'global' || body.scope_type === 'organization' || body.scope_type === 'project' ? body.scope_type : 'project'
  return { kind, id: typeof body.scope_id === 'string' ? body.scope_id : '' }
}
function cursor(filter: unknown, offset: number): string {
  return Buffer.from(JSON.stringify({ filter, offset }), 'utf8').toString('base64url')
}
function readCursor(value: unknown, filter: unknown): number | null {
  if (value === undefined || value === null || value === '') return 0
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { filter?: unknown; offset?: unknown }
    return JSON.stringify(parsed.filter) === JSON.stringify(filter) &&
      typeof parsed.offset === 'number' &&
      Number.isInteger(parsed.offset) &&
      parsed.offset >= 0
      ? parsed.offset
      : null
  } catch {
    return null
  }
}
