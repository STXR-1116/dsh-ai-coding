/** Deterministic in-memory telemetry API used only for local plugin/Host/admin integration. */

import { createHash } from 'node:crypto'
import type { AccountPrincipal, AccountStore, ProjectView } from './account-store.ts'

export interface FixtureResult {
  readonly status: number
  readonly body: Record<string, unknown>
}

const EVENT_KINDS = [
  'session.started',
  'session.finished',
  'turn.started',
  'turn.finished',
  'step.started',
  'step.finished',
  'llm.request',
  'llm.response',
  'tool.call',
  'tool.result',
  'approval.requested',
  'approval.resolved',
  'compaction.completed',
  'agent.error',
  'delivery.gap',
] as const

const OUTCOMES = ['success', 'error', 'interrupted', 'cancelled', 'blocked', 'max_tokens'] as const

const TOP_LEVEL_FIELDS = [
  'schema_version',
  'event_id',
  'installation_id',
  'project_id',
  'session_id',
  'kind',
  'occurred_at',
  'source_type',
  'source_seq',
  'turn',
  'step',
  'duration_ms',
  'outcome',
  'provider',
  'model',
  'tool_name',
  'tool_category',
  'call_id',
  'approval_id',
  'compaction_id',
  'retryable',
  'retry_count',
  'token_usage',
  'error',
  'approval',
  'compaction',
  'gap',
] as const

const BATCH_FIELDS = ['schema_version', 'batch_id', 'project_id', 'client_sent_at', 'events'] as const

/** Raw events retained server-side; the API contract fixes 90 days. */
const RETENTION_DAYS = 90

interface StoredEvent {
  readonly event_id: string
  readonly installation_id: string
  readonly project_id: string
  readonly session_id: string | null
  readonly kind: string
  readonly occurred_at: string
  readonly source_type: string
  readonly source_seq: number | null
  readonly turn: number | null
  readonly step: number | null
  readonly duration_ms: number | null
  readonly outcome: string | null
  readonly provider: string | null
  readonly model: string | null
  readonly tool_name: string | null
  readonly tool_category: string | null
  readonly call_id: string | null
  readonly approval_id: string | null
  readonly compaction_id: string | null
  readonly retryable: boolean | null
  readonly retry_count: number | null
  readonly token_usage: {
    readonly input_tokens: number | null
    readonly output_tokens: number | null
    readonly total_tokens: number | null
  } | null
  readonly error: { readonly name: string; readonly code: string | null; readonly summary: string | null } | null
  readonly approval: { readonly decision: string | null } | null
  readonly compaction: { readonly kind: string | null } | null
  readonly gap: {
    readonly reason: TelemetryGapReason
    readonly count: number
    readonly first_event_id: string | null
    readonly last_event_id: string | null
  } | null
  readonly received_at: string
  readonly operator_user_id: string
}

type TelemetryGapReason = 'overflow' | 'expired' | 'rejected' | 'manual_clear' | 'authorization_revoked'

interface StoredBatchResult {
  readonly eventResults: readonly Record<string, unknown>[]
  readonly checkpoint: string
  readonly serverReceivedAt: string
}

function failure(status: number, code: string, message: string): FixtureResult {
  return { status, body: { code, message } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isIsoString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value))
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
}

/**
 * Server-side re-cleaning of an error summary: control characters dropped,
 * credential-looking substrings masked, hard length bound. A summary that
 * fails normalization keeps only name/code.
 */
function cleanServerSummary(value: string): string | undefined {
  const withoutControls = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim()
  const masked = withoutControls
    .replace(/(sk-[A-Za-z0-9]{4})[A-Za-z0-9-]+/gu, '$1***')
    .replace(/Bearer\s+[a-z0-9._~+=/-]+/gi, 'Bearer [REDACTED]')
    .replace(/(access[-_]?token|refresh[-_]?token|api[-_]?key|password|secret|cookie)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .replace(/([a-z]:)?(?:\\|\/)(?:users|home)(?:\\|\/)[^\s'"]+/gi, '[PATH]')
  const bounded = masked.length > 200 ? `${masked.slice(0, 200)}…` : masked
  return bounded.length > 0 ? bounded : undefined
}

/** Kind-specific required fields from the API contract; absent required fields are schema violations. */
function validateKindRequirements(kind: string, value: Record<string, unknown>): string | undefined {
  const needs = (fields: readonly (keyof Record<string, unknown>)[]): string | undefined => {
    for (const field of fields) {
      const present = value[field] !== undefined && value[field] !== null
      if (!present) return 'TELEMETRY_SCHEMA_INVALID'
    }
    return undefined
  }
  switch (kind) {
    case 'turn.started':
    case 'turn.finished':
      return needs(['turn'])
    case 'step.started':
    case 'step.finished':
    case 'llm.request':
    case 'llm.response':
      return needs(['turn', 'step'])
    case 'tool.call':
      return needs(['turn', 'step', 'call_id', 'tool_name'])
    case 'tool.result':
      return needs(['turn', 'step', 'call_id', 'outcome'])
    case 'approval.requested':
      return needs(['approval_id'])
    case 'approval.resolved':
      return needs(['approval_id', 'approval'])
    case 'compaction.completed':
      return needs(['compaction_id', 'compaction'])
    case 'agent.error':
      return needs(['error'])
    case 'delivery.gap':
      return needs(['gap'])
    default:
      return undefined
  }
}

/**
 * In-memory telemetry receiver and analytics fixture. It re-authorizes every
 * request against the current Bearer principal, enforces the strict
 * whitelist schema, dedupes events/batches/idempotency keys, classifies
 * per-event results, and answers admin overview/summary/events queries from
 * accepted events only. It proves the observable contract of the loop, not
 * production persistence, throughput, or cross-instance semantics.
 */
export class TelemetryFixture {
  private readonly events: StoredEvent[] = []
  private readonly idempotency = new Map<string, { readonly fingerprint: string; readonly result: FixtureResult }>()
  private readonly storedBatches = new Map<string, StoredBatchResult>()
  private readonly ackLedger = new Map<string, Array<{ received_at: string; status: 'accepted' | 'duplicate' | 'retryable' | 'rejected' }>>()

  constructor(private readonly accounts: AccountStore) {}

  /** Handle `POST /v1/telemetry/batches`. */
  batches(
    principal: AccountPrincipal,
    body: Record<string, unknown>,
    headers: { readonly 'idempotency-key': string | undefined; readonly 'x-fixture-scenario': string | undefined },
    requestId: string,
  ): FixtureResult {
    for (const field of Object.keys(body)) {
      if (!(BATCH_FIELDS as readonly string[]).includes(field)) {
        return failure(400, 'TELEMETRY_SCHEMA_INVALID', `批次包含未知字段 ${field}`)
      }
    }
    const schemaVersion = body.schema_version
    if (schemaVersion !== 1) return failure(400, 'TELEMETRY_SCHEMA_UNSUPPORTED', '不支持的遥测 schema 版本')
    const batchId = body.batch_id
    if (!isOpaqueId(batchId)) return failure(400, 'TELEMETRY_SCHEMA_INVALID', 'batch_id 缺失或无效')
    const projectId = body.project_id
    if (!isOpaqueId(projectId)) return failure(400, 'TELEMETRY_SCHEMA_INVALID', 'project_id 缺失或无效')
    if (!isIsoString(body.client_sent_at)) return failure(400, 'TELEMETRY_SCHEMA_INVALID', 'client_sent_at 必须是 ISO 时间')
    if (!Array.isArray(body.events)) return failure(400, 'TELEMETRY_SCHEMA_INVALID', 'events 必须是数组')
    if (body.events.length === 0) return failure(400, 'TELEMETRY_SCHEMA_INVALID', 'events 不能为空')
    if (body.events.length > 500) return failure(400, 'TELEMETRY_SCHEMA_INVALID', '批次事件数超出上限')
    const key = headers['idempotency-key']
    if (key === undefined || key.length === 0) return failure(400, 'IDEMPOTENCY_KEY_REQUIRED', '批次接收必须提供 Idempotency-Key')

    // Server re-authorization against the CURRENT project state; an earlier
    // access summary is never trusted. Revocation on the ingest path is
    // reported as PROJECT_ACCESS_REVOKED so the collector stops the partition.
    const project = this.accounts.authorizeProject(principal, projectId)
    if ('ok' in project) {
      return failure(403, 'PROJECT_ACCESS_REVOKED', '当前账号已无权上报该项目')
    }

    const fingerprint = hash(body)
    const replay = this.idempotency.get(this.idempotencyKey(principal, key))
    if (replay !== undefined) {
      if (replay.fingerprint !== fingerprint) return failure(409, 'IDEMPOTENCY_CONFLICT', '幂等键与不同请求复用')
      return replay.result
    }
    const previousBatch = this.storedBatches.get(`${principal.userId}:${batchId}`)
    if (previousBatch !== undefined) {
      const result = this.batchResult(batchId, previousBatch, requestId)
      this.remember(principal, key, fingerprint, result)
      return result
    }

    if (headers['x-fixture-scenario'] === 'telemetry-unavailable') {
      return failure(503, 'TELEMETRY_UNAVAILABLE', '遥测接收服务暂不可用')
    }
    const scenario = headers['x-fixture-scenario']

    const serverReceivedAt = new Date().toISOString()
    const checkpoint = `ckpt-${hash(`${principal.userId}:${batchId}:${serverReceivedAt}`).slice(0, 16)}`
    const results: Record<string, unknown>[] = []
    const accepted: StoredEvent[] = []
    for (const value of body.events) {
      if (!isRecord(value)) {
        results.push({ event_id: 'unknown', status: 'rejected', reason: 'TELEMETRY_SCHEMA_INVALID' })
        continue
      }
      const parsed = this.parseEvent(principal, value, projectId)
      if (typeof parsed === 'string') {
        results.push({ event_id: isOpaqueId(value.event_id) ? value.event_id : 'unknown', status: 'rejected', reason: parsed })
        continue
      }
      if (scenario === 'telemetry-retryable') {
        results.push({ event_id: parsed.event_id, status: 'retryable', retry_after_seconds: 1, reason: 'TELEMETRY_BUSY' })
        continue
      }
      if (scenario === 'telemetry-reject') {
        results.push({ event_id: parsed.event_id, status: 'rejected', reason: 'TELEMETRY_POLICY_REJECTED' })
        continue
      }
      if (this.events.some(event => event.event_id === parsed.event_id)) {
        results.push({ event_id: parsed.event_id, status: 'duplicate' })
        continue
      }
      accepted.push(parsed)
      results.push({ event_id: parsed.event_id, status: 'accepted' })
    }
    this.events.push(...accepted)
    const ledger = this.ackLedger.get(projectId) ?? []
    for (const item of results) {
      if (item.status === 'accepted' || item.status === 'duplicate' || item.status === 'retryable' || item.status === 'rejected') {
        ledger.push({ received_at: serverReceivedAt, status: item.status })
      }
    }
    this.ackLedger.set(projectId, ledger)
    const stored: StoredBatchResult = { eventResults: results, checkpoint, serverReceivedAt }
    this.storedBatches.set(`${principal.userId}:${batchId}`, stored)
    const result = this.batchResult(batchId, stored, requestId)
    this.remember(principal, key, fingerprint, result)
    return result
  }

  /** Handle `GET /v1/admin/telemetry/overview`. */
  overview(principal: AccountPrincipal, query: URLSearchParams, requestId: string): FixtureResult {
    const scope = this.adminScope(principal)
    if (scope !== undefined) return scope
    const window = this.parseWindow(query)
    if (window === undefined) return failure(422, 'INVALID_TIME_RANGE', '时间窗口无效')
    const listed = this.accounts.listProjects(principal)
    const visibleProjects: readonly ProjectView[] = Array.isArray(listed) ? listed : []
    const visible = visibleProjects.map(project => project.project_id)
    const requestedProject = query.get('project_id')
    const requestedOrganization = query.get('organization_id')
    const projectIds = visibleProjects
      .filter(project => requestedProject === null || project.project_id === requestedProject)
      .filter(project => requestedOrganization === null || project.organization_id === requestedOrganization)
      .map(project => project.project_id)
    if (requestedProject !== null && !visible.includes(requestedProject)) {
      return failure(404, 'RESOURCE_NOT_FOUND', '项目不存在或不可见')
    }
    const events = this.events.filter(
      event =>
        projectIds.includes(event.project_id) &&
        this.withinWindow(event.received_at, window.from, window.to),
    )
    const bucketMs = 24 * 60 * 60 * 1000
    const buckets = new Map<string, StoredEvent[]>()
    for (const event of events) {
      const bucket = new Date(Math.floor(Date.parse(event.received_at) / bucketMs) * bucketMs).toISOString()
      const list = buckets.get(bucket) ?? []
      list.push(event)
      buckets.set(bucket, list)
    }
    return {
      status: 200,
      body: {
        from: window.from,
        to: window.to,
        has_data: events.length > 0,
        summary: {
          ...summarize(events),
          delivery: this.foldDelivery(projectIds, window.from, window.to, events.filter(event => event.kind === 'delivery.gap').length),
        },
        buckets: [...buckets.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([bucket, bucketEvents]) => {
            const bucketEnd = new Date(Date.parse(bucket) + 24 * 60 * 60 * 1000 - 1).toISOString()
            const bucketDelivery = this.foldDelivery(
              projectIds,
              bucket,
              bucketEnd,
              bucketEvents.filter(event => event.kind === 'delivery.gap').length,
            )
            return { bucket_start: bucket, ...summarize(bucketEvents), delivery: bucketDelivery }
          }),
        retention_days: RETENTION_DAYS,
        request_id: requestId,
      },
    }
  }

  /** Handle `GET /v1/admin/projects/{project_id}/telemetry/summary`. */
  projectSummary(principal: AccountPrincipal, projectId: string, query: URLSearchParams, requestId: string): FixtureResult {
    const scope = this.adminScope(principal)
    if (scope !== undefined) return scope
    const project = this.accounts.authorizeProject(principal, projectId)
    if ('ok' in project) return failure(project.status, project.code, project.message)
    const window = this.parseWindow(query)
    if (window === undefined) return failure(422, 'INVALID_TIME_RANGE', '时间窗口无效')
    const events = this.events.filter(
      event => event.project_id === projectId && this.withinWindow(event.received_at, window.from, window.to),
    )
    interface ModelUsage {
      provider: string | null
      model: string | null
      requests: number
      input_tokens: number
      output_tokens: number
      total_tokens: number | null
    }
    interface ModelUsageAccumulator extends ModelUsage {
      input_samples: number
      output_samples: number
      total_samples: number
    }
    const byModel = new Map<string, ModelUsageAccumulator>()
    for (const event of events) {
      if (event.kind !== 'llm.request' && event.kind !== 'llm.response') continue
      const key = `${event.provider ?? 'unknown'}\u0000${event.model ?? 'unknown'}`
      const entry =
        byModel.get(key) ?? {
          provider: event.provider,
          model: event.model,
          requests: 0,
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: null,
          input_samples: 0,
          output_samples: 0,
          total_samples: 0,
        }
      // 一次 LLM 调用只计一次 request：请求数只由 llm.request 统计，
      // 未配对 response 与重复事件不得放大请求数。
      if (event.kind === 'llm.request') entry.requests += 1
      if (event.kind === 'llm.response' && event.token_usage !== null) {
        // 缺失字段保持缺失：只累计实际存在的非负值，不推导 total_tokens。
        if (event.token_usage.input_tokens !== null) {
          entry.input_tokens += event.token_usage.input_tokens
          entry.input_samples += 1
        }
        if (event.token_usage.output_tokens !== null) {
          entry.output_tokens += event.token_usage.output_tokens
          entry.output_samples += 1
        }
        if (event.token_usage.total_tokens !== null) {
          entry.total_tokens = (entry.total_tokens ?? 0) + event.token_usage.total_tokens
          entry.total_samples += 1
        }
      }
      byModel.set(key, entry)
    }
    const byTool = new Map<string, { tool_name: string; calls: number; errors: number; durations: number[] }>()
    for (const event of events) {
      if (event.kind !== 'tool.result') continue
      const name = event.tool_name ?? 'unknown'
      const entry = byTool.get(name) ?? { tool_name: name, calls: 0, errors: 0, durations: [] }
      entry.calls += 1
      if (event.outcome === 'error') entry.errors += 1
      if (event.duration_ms !== null) entry.durations.push(event.duration_ms)
      byTool.set(name, entry)
    }
    return {
      status: 200,
      body: {
        project_id: projectId,
        from: window.from,
        to: window.to,
        has_data: events.length > 0,
        // summary.delivery 与顶层 delivery 来自同一 foldDelivery 调用（同窗同参），
        // 两处逐字段一致——消费方读任一位置都得到同一 ACK 分类。
        summary: {
          ...summarize(events),
          delivery: this.foldDelivery([projectId], window.from, window.to, events.filter(event => event.kind === 'delivery.gap').length),
        },
        models: [...byModel.values()].map(entry => ({
          provider: entry.provider ?? 'unknown',
          model: entry.model ?? 'unknown',
          requests: entry.requests,
          input_tokens: entry.input_tokens,
          output_tokens: entry.output_tokens,
          total_tokens: entry.total_tokens,
          input_token_samples: entry.input_samples,
          output_token_samples: entry.output_samples,
          total_token_samples: entry.total_samples,
        })),
        tools: [...byTool.values()].map(entry => ({
          tool_name: entry.tool_name,
          calls: entry.calls,
          errors: entry.errors,
          p50_duration_ms: percentile(entry.durations, 50),
          p95_duration_ms: percentile(entry.durations, 95),
        })),
        delivery: this.foldDelivery([projectId], window.from, window.to, events.filter(event => event.kind === 'delivery.gap').length),
        retention_days: RETENTION_DAYS,
        request_id: requestId,
      },
    }
  }

  /** Handle `GET /v1/admin/projects/{project_id}/telemetry/events`. */
  projectEvents(principal: AccountPrincipal, projectId: string, query: URLSearchParams, requestId: string): FixtureResult {
    const scope = this.adminScope(principal)
    if (scope !== undefined) return scope
    const project = this.accounts.authorizeProject(principal, projectId)
    if ('ok' in project) return failure(project.status, project.code, project.message)
    const window = this.parseWindow(query)
    if (window === undefined) return failure(422, 'INVALID_TIME_RANGE', '时间窗口无效')
    const kind = query.get('kind')
    if (kind !== null && !(EVENT_KINDS as readonly string[]).includes(kind)) return failure(400, 'INVALID_KIND', '未知事件 kind')
    const outcome = query.get('outcome')
    const limitRaw = query.get('limit')
    const limit = limitRaw === null ? 50 : Number(limitRaw)
    if (!Number.isInteger(limit) || limit <= 0 || limit > 200) return failure(422, 'INVALID_LIMIT', 'limit 必须在 1..200 之间')
    const cursorRaw = query.get('cursor')
    let cursor: { readonly last_key: string } | undefined
    if (cursorRaw !== null) {
      const decoded = decodeCursor(cursorRaw)
      if (decoded === undefined) return failure(400, 'INVALID_CURSOR', '游标无效')
      const bound = { project_id: projectId, from: window.from, to: window.to, kind, outcome, limit }
      if (hash(bound) !== decoded.fingerprint) return failure(400, 'INVALID_CURSOR', '游标与筛选条件不匹配')
      cursor = { last_key: decoded.last_key }
    }
    const retentionFloor = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
    const matches = this.events
      .filter(
        event =>
          event.project_id === projectId &&
          event.received_at >= retentionFloor &&
          this.withinWindow(event.received_at, window.from, window.to) &&
          (kind === null || event.kind === kind) &&
          (outcome === null || event.outcome === outcome),
      )
      .sort((left, right) => left.received_at.localeCompare(right.received_at) || left.event_id.localeCompare(right.event_id))
    const start = cursor === undefined ? 0 : matches.findIndex(event => sortKey(event) > cursor.last_key)
    const page = start < 0 && cursor !== undefined ? [] : matches.slice(Math.max(start, 0), Math.max(start, 0) + limit)
    const hasMore = Math.max(start, 0) + limit < matches.length
    const last = page.length > 0 ? page[page.length - 1] : undefined
    const nextCursor =
      page.length > 0 && hasMore && last !== undefined
        ? encodeCursor({
          fingerprint: hash({ project_id: projectId, from: window.from, to: window.to, kind, outcome, limit }),
          last_key: sortKey(last),
        })
        : null
    return {
      status: 200,
      body: {
        project_id: projectId,
        items: page.map(eventView),
        next_cursor: nextCursor,
        has_more: hasMore,
        retention_days: RETENTION_DAYS,
        request_id: requestId,
      },
    }
  }

  /** Fold one window of ACK-ledger entries into the six-category delivery classification. */
  private foldDelivery(projectIds: readonly string[], from: string, to: string, gapCount: number): Record<string, unknown> {
    const fold = { accepted: 0, duplicate: 0, retryable: 0, rejected: 0 }
    for (const projectId of projectIds) {
      for (const entry of this.ackLedger.get(projectId) ?? []) {
        if (entry.received_at >= from && entry.received_at < to) fold[entry.status] += 1
      }
    }
    return { ...fold, queued: 0, gaps: gapCount }
  }

  private parseEvent(principal: AccountPrincipal, value: Record<string, unknown>, projectId: string): StoredEvent | string {
    for (const field of Object.keys(value)) {
      if (!(TOP_LEVEL_FIELDS as readonly string[]).includes(field)) return 'TELEMETRY_SCHEMA_INVALID'
    }
    if (value.schema_version !== 1) return 'TELEMETRY_SCHEMA_UNSUPPORTED'
    const eventId = value.event_id
    if (!isOpaqueId(eventId)) return 'TELEMETRY_SCHEMA_INVALID'
    const installationId = value.installation_id
    if (!isOpaqueId(installationId)) return 'TELEMETRY_SCHEMA_INVALID'
    if (value.project_id !== projectId) return 'TELEMETRY_SCHEMA_INVALID'
    const kind = value.kind
    if (typeof kind !== 'string' || !(EVENT_KINDS as readonly string[]).includes(kind)) return 'TELEMETRY_SCHEMA_INVALID'
    if (!isIsoString(value.occurred_at)) return 'TELEMETRY_SCHEMA_INVALID'
    const sourceType = value.source_type
    if (!isOpaqueId(sourceType)) return 'TELEMETRY_SCHEMA_INVALID'
    const sessionId = value.session_id
    if (sessionId !== null && !isOpaqueId(sessionId)) return 'TELEMETRY_SCHEMA_INVALID'
    if (sessionId === null && kind !== 'delivery.gap') {
      return 'TELEMETRY_SCHEMA_INVALID'
    }
    const kindError = validateKindRequirements(kind, value)
    if (kindError !== undefined) return kindError
    const outcome = value.outcome
    if (outcome !== undefined && outcome !== null && !(OUTCOMES as readonly string[]).includes(outcome as string)) {
      return 'TELEMETRY_SCHEMA_INVALID'
    }
    const durationMs = value.duration_ms
    if (durationMs !== undefined && durationMs !== null && !isNonNegativeInt(durationMs)) return 'TELEMETRY_SCHEMA_INVALID'
    for (const field of ['source_seq', 'turn', 'step', 'retry_count'] as const) {
      const number = value[field]
      if (number !== undefined && number !== null && !isNonNegativeInt(number)) return 'TELEMETRY_SCHEMA_INVALID'
    }
    for (const field of ['provider', 'model', 'tool_name', 'tool_category', 'call_id', 'approval_id', 'compaction_id'] as const) {
      const text = value[field]
      if (text !== undefined && text !== null && !isOpaqueId(text)) return 'TELEMETRY_SCHEMA_INVALID'
    }
    const retryable = value.retryable
    if (retryable !== undefined && retryable !== null && typeof retryable !== 'boolean') return 'TELEMETRY_SCHEMA_INVALID'
    let tokenUsage: StoredEvent['token_usage'] = null
    if (value.token_usage !== undefined && value.token_usage !== null) {
      const usage = value.token_usage
      if (!isRecord(usage)) return 'TELEMETRY_SCHEMA_INVALID'
      for (const field of Object.keys(usage)) {
        if (!['input_tokens', 'output_tokens', 'total_tokens'].includes(field)) return 'TELEMETRY_SCHEMA_INVALID'
      }
      const input = typeof usage.input_tokens === 'number' ? usage.input_tokens : null
      const output = typeof usage.output_tokens === 'number' ? usage.output_tokens : null
      const total = typeof usage.total_tokens === 'number' ? usage.total_tokens : null
      for (const number of [usage.input_tokens, usage.output_tokens, usage.total_tokens]) {
        if (number !== null && number !== undefined && !isNonNegativeInt(number)) return 'TELEMETRY_SCHEMA_INVALID'
      }
      tokenUsage = { input_tokens: input, output_tokens: output, total_tokens: total }
    }
    let error: StoredEvent['error'] = null
    if (value.error !== undefined && value.error !== null) {
      const detail = value.error
      if (!isRecord(detail)) return 'TELEMETRY_SCHEMA_INVALID'
      for (const field of Object.keys(detail)) {
        if (!['name', 'code', 'summary'].includes(field)) return 'TELEMETRY_SCHEMA_INVALID'
      }
      if (!isOpaqueId(detail.name)) return 'TELEMETRY_SCHEMA_INVALID'
      if (detail.code !== undefined && detail.code !== null && !isOpaqueId(detail.code)) return 'TELEMETRY_SCHEMA_INVALID'
      let summary: string | undefined
      if (detail.summary !== undefined && detail.summary !== null) {
        if (typeof detail.summary !== 'string') return 'TELEMETRY_SCHEMA_INVALID'
        summary = cleanServerSummary(detail.summary)
      }
      error = { name: detail.name, code: detail.code ?? null, summary: summary ?? null }
    }
    let approval: StoredEvent['approval'] = null
    if (value.approval !== undefined && value.approval !== null) {
      const detail = value.approval
      if (!isRecord(detail) || !(detail.decision === undefined || detail.decision === null || ['allowed_once', 'rejected', 'cancelled', 'unavailable'].includes(detail.decision as string))) {
        return 'TELEMETRY_SCHEMA_INVALID'
      }
      approval = { decision: (detail.decision ?? null) as StoredEvent['approval'] extends { readonly decision: infer D } ? D : never }
    }
    let compaction: StoredEvent['compaction'] = null
    if (value.compaction !== undefined && value.compaction !== null) {
      const detail = value.compaction
      if (!isRecord(detail) || (detail.kind !== undefined && detail.kind !== null && !isOpaqueId(detail.kind))) {
        return 'TELEMETRY_SCHEMA_INVALID'
      }
      compaction = { kind: typeof detail.kind === 'string' ? detail.kind : null }
    }
    let gap: StoredEvent['gap'] = null
    if (value.gap !== undefined && value.gap !== null) {
      const detail = value.gap
      if (!isRecord(detail) || !isOpaqueId(detail.reason) || !isNonNegativeInt(detail.count)) return 'TELEMETRY_SCHEMA_INVALID'
      for (const field of ['first_event_id', 'last_event_id'] as const) {
        const id = detail[field]
        if (id !== undefined && id !== null && !isOpaqueId(id)) return 'TELEMETRY_SCHEMA_INVALID'
      }
      gap = {
        reason: detail.reason as TelemetryGapReason,
        count: typeof detail.count === 'number' ? detail.count : 0,
        first_event_id: typeof detail.first_event_id === 'string' ? detail.first_event_id : null,
        last_event_id: typeof detail.last_event_id === 'string' ? detail.last_event_id : null,
      }
    }
    return {
      event_id: eventId,
      installation_id: installationId,
      project_id: projectId,
      session_id: sessionId ?? null,
      kind,
      occurred_at: value.occurred_at,
      source_type: sourceType,
      source_seq: typeof value.source_seq === 'number' ? value.source_seq : null,
      turn: typeof value.turn === 'number' ? value.turn : null,
      step: typeof value.step === 'number' ? value.step : null,
      duration_ms: durationMs ?? null,
      outcome: typeof outcome === 'string' ? outcome : null,
      provider: typeof value.provider === 'string' ? value.provider : null,
      model: typeof value.model === 'string' ? value.model : null,
      tool_name: typeof value.tool_name === 'string' ? value.tool_name : null,
      tool_category: typeof value.tool_category === 'string' ? value.tool_category : null,
      call_id: typeof value.call_id === 'string' ? value.call_id : null,
      approval_id: typeof value.approval_id === 'string' ? value.approval_id : null,
      compaction_id: typeof value.compaction_id === 'string' ? value.compaction_id : null,
      retryable: typeof retryable === 'boolean' ? retryable : null,
      retry_count: typeof value.retry_count === 'number' ? value.retry_count : null,
      token_usage: tokenUsage,
      error,
      approval,
      compaction,
      gap,
      received_at: new Date().toISOString(),
      operator_user_id: principal.userId,
    }
  }

  private batchResult(batchId: string, stored: StoredBatchResult, requestId: string): FixtureResult {
    return {
      status: 202,
      body: {
        batch_id: batchId,
        server_received_at: stored.serverReceivedAt,
        server_checkpoint: stored.checkpoint,
        results: stored.eventResults,
        request_id: requestId,
      },
    }
  }

  private remember(principal: AccountPrincipal, key: string, fingerprint: string, result: FixtureResult): void {
    this.idempotency.set(this.idempotencyKey(principal, key), { fingerprint, result })
  }

  private idempotencyKey(principal: AccountPrincipal, key: string): string {
    return `${principal.userId}:${key}`
  }

  private adminScope(principal: AccountPrincipal): FixtureResult | undefined {
    if (principal.role === 'member') return failure(403, 'ROLE_FORBIDDEN', 'member 角色不开放团队可观测页面')
    return undefined
  }

  private parseWindow(query: URLSearchParams): { readonly from: string; readonly to: string } | undefined {
    const from = query.get('from')
    const to = query.get('to')
    if (from === null || to === null || !isIsoString(from) || !isIsoString(to)) return undefined
    if (Date.parse(from) >= Date.parse(to)) return undefined
    return { from, to }
  }

  private withinWindow(receivedAt: string, from: string, to: string): boolean {
    return receivedAt >= from && receivedAt < to
  }
}

function summarize(events: readonly StoredEvent[]): Record<string, unknown> {
  const turnDurations: number[] = []
  const stepDurations: number[] = []
  const toolDurations: number[] = []
  let inputTokens = 0
  let outputTokens = 0
  let totalTokens: number | null = null
  let tokenSamples = 0
  let inputSamples = 0
  let outputSamples = 0
  let totalSamples = 0
  const outcomeBy = (kind: string): Record<string, number> => {
    const counts: Record<string, number> = {}
    for (const event of events) {
      if (event.kind !== kind || event.outcome === null) continue
      counts[event.outcome] = (counts[event.outcome] ?? 0) + 1
    }
    return counts
  }
  for (const event of events) {
    if (event.kind === 'turn.finished' && event.duration_ms !== null) turnDurations.push(event.duration_ms)
    if (event.kind === 'step.finished' && event.duration_ms !== null) stepDurations.push(event.duration_ms)
    if (event.kind === 'tool.result' && event.duration_ms !== null) toolDurations.push(event.duration_ms)
    if (event.kind === 'llm.response' && event.token_usage !== null) {
      // 样本量只统计至少一个字段真实存在的响应：空对象或全缺不伪装成样本。
      if (
        event.token_usage.input_tokens !== null ||
        event.token_usage.output_tokens !== null ||
        event.token_usage.total_tokens !== null
      ) {
        tokenSamples += 1
      }
      // 缺失字段保持缺失（不折算成 0），只累计实际存在的非负值。
      if (event.token_usage.input_tokens !== null) {
        inputTokens += event.token_usage.input_tokens
        inputSamples += 1
      }
      if (event.token_usage.output_tokens !== null) {
        outputTokens += event.token_usage.output_tokens
        outputSamples += 1
      }
      if (event.token_usage.total_tokens !== null) {
        totalTokens = (totalTokens ?? 0) + event.token_usage.total_tokens
        totalSamples += 1
      }
    }
  }
  const turns = outcomeBy('turn.finished')
  const sessions = outcomeBy('session.finished')
  const approvalDecisions = new Map<string, number>()
  for (const event of events) {
    if (event.kind !== 'approval.resolved' || event.approval?.decision === null) continue
    const decision = event.approval?.decision ?? 'unknown'
    approvalDecisions.set(decision, (approvalDecisions.get(decision) ?? 0) + 1)
  }
  const requests = events.filter(event => event.kind === 'llm.request').length
  return {
    sessions: {
      total: events.filter(event => event.kind === 'session.started').length,
      completed: sessions.success ?? 0,
      errors: sessions.error ?? 0,
      interrupted: sessions.interrupted ?? 0,
      cancelled: sessions.cancelled ?? 0,
    },
    turns: {
      total: events.filter(event => event.kind === 'turn.started').length,
      completed: turns.success ?? 0,
      errors: turns.error ?? 0,
      blocked: turns.blocked ?? 0,
      max_tokens: turns.max_tokens ?? 0,
      interrupted: turns.interrupted ?? 0,
      cancelled: turns.cancelled ?? 0,
      p50_duration_ms: percentile(turnDurations, 50),
      p95_duration_ms: percentile(turnDurations, 95),
    },
    steps: {
      started: events.filter(event => event.kind === 'step.started').length,
      finished: events.filter(event => event.kind === 'step.finished').length,
      p50_duration_ms: percentile(stepDurations, 50),
      p95_duration_ms: percentile(stepDurations, 95),
    },
    llm: {
      requests,
      retries: events.filter(event => event.kind === 'agent.error' && event.retryable === true).length,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
      token_sample_size: tokenSamples,
      input_token_samples: inputSamples,
      output_token_samples: outputSamples,
      total_token_samples: totalSamples,
    },
    tools: {
      calls: events.filter(event => event.kind === 'tool.call').length,
      errors: events.filter(event => event.kind === 'tool.result' && event.outcome === 'error').length,
      p50_duration_ms: percentile(toolDurations, 50),
      p95_duration_ms: percentile(toolDurations, 95),
    },
    approvals: {
      requested: events.filter(event => event.kind === 'approval.requested').length,
      allowed_once: approvalDecisions.get('allowed_once') ?? 0,
      rejected: approvalDecisions.get('rejected') ?? 0,
      cancelled: approvalDecisions.get('cancelled') ?? 0,
      unavailable: approvalDecisions.get('unavailable') ?? 0,
    },
    compactions: events.filter(event => event.kind === 'compaction.completed').length,
  }
}

function percentile(samples: readonly number[], p: number): number | null {
  if (samples.length === 0) return null
  const sorted = [...samples].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(index, 0)] ?? null
}

function sortKey(event: StoredEvent): string {
  return `${event.received_at}#${event.event_id}`
}

function eventView(event: StoredEvent): Record<string, unknown> {
  return {
    event_id: event.event_id,
    installation_id: event.installation_id,
    project_id: event.project_id,
    session_id: event.session_id,
    kind: event.kind,
    occurred_at: event.occurred_at,
    received_at: event.received_at,
    source_type: event.source_type,
    source_seq: event.source_seq,
    turn: event.turn,
    step: event.step,
    duration_ms: event.duration_ms,
    outcome: event.outcome,
    provider: event.provider,
    model: event.model,
    tool_name: event.tool_name,
    tool_category: event.tool_category,
    call_id: event.call_id,
    approval_id: event.approval_id,
    compaction_id: event.compaction_id,
    retryable: event.retryable,
    retry_count: event.retry_count,
    token_usage: event.token_usage,
    error: event.error,
    approval: event.approval,
    compaction: event.compaction,
    gap: event.gap,
  }
}

function encodeCursor(value: { readonly fingerprint: string; readonly last_key: string }): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function decodeCursor(value: string): { readonly fingerprint: string; readonly last_key: string } | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (!isRecord(parsed) || typeof parsed.fingerprint !== 'string' || typeof parsed.last_key !== 'string') return undefined
    return { fingerprint: parsed.fingerprint, last_key: parsed.last_key }
  } catch {
    return undefined
  }
}
