/* oxlint-disable typescript/no-unsafe-member-access, typescript/no-unsafe-assignment -- parsed-JSON assertions mirror sibling suites */
/* oxlint-disable typescript/no-unsafe-call */
import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { createTeamSkillService } from '../src/server.ts'
import { bodyOf } from './response.ts'

const services: Array<{ server: { close: () => void } }> = []
afterEach(async () => {
  for (const service of services.splice(0)) {
    service.server.closeAllConnections()
    await new Promise<void>((resolve) => {
      service.server.close(() => {
        resolve()
      })
    })
  }
})

async function start(): Promise<string> {
  const service = createTeamSkillService({ port: 0, seed: true })
  services.push(service)
  await service.listen()
  const address = service.server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}/v1`
}

function eventOverrides(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    event_id: `event-${Math.random().toString(36).slice(2, 10)}`,
    installation_id: 'installation-1',
    project_id: 'project-alpha',
    session_id: 'session-1',
    kind: 'turn.finished',
    occurred_at: new Date().toISOString(),
    source_type: 'turn/end',
    source_seq: 7,
    turn: 1,
    outcome: 'success',
    ...overrides,
  }
}

function batchBody(events: unknown[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    batch_id: `batch-${Math.random().toString(36).slice(2, 10)}`,
    project_id: 'project-alpha',
    client_sent_at: new Date().toISOString(),
    events,
    ...overrides,
  }
}

function memberHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: 'Bearer demo-token', 'content-type': 'application/json', ...extra }
}

interface BatchResponse {
  readonly status: number
  readonly body: Record<string, unknown>
}

async function postBatch(base: string, body: unknown, headers: Record<string, string>): Promise<BatchResponse> {
  const response = await fetch(`${base}/telemetry/batches`, { method: 'POST', headers, body: JSON.stringify(body) })
  return { status: response.status, body: await bodyOf(response) }
}

describe('telemetry fixture', () => {
  it('accepts a whitelisted batch, dedupes events, and replays idempotent keys and batch ids', async () => {
    const base = await start()
    const key = 'idem-1'
    const event = eventOverrides()
    const first = await postBatch(base, batchBody([event]), memberHeaders({ 'Idempotency-Key': key }))
    expect(first.status).toBe(202)
    expect(first.body.results).toEqual([{ event_id: event.event_id, status: 'accepted' }])

    // Same event id in a new batch classifies as duplicate, never double-counted.
    const duplicateEvent = eventOverrides({ event_id: event.event_id })
    const second = await postBatch(base, batchBody([duplicateEvent]), memberHeaders({ 'Idempotency-Key': 'idem-2' }))
    expect(second.status).toBe(202)
    expect(second.body.results).toEqual([{ event_id: duplicateEvent.event_id, status: 'duplicate' }])

    // The same batch id replays the first per-event results for a new key.
    const batch = batchBody([eventOverrides({ event_id: 'replay-event' })])
    const firstSend = await postBatch(base, batch, memberHeaders({ 'Idempotency-Key': 'idem-3' }))
    expect(firstSend.status).toBe(202)
    const replaySend = await postBatch(base, batch, memberHeaders({ 'Idempotency-Key': 'idem-4' }))
    expect(replaySend.status).toBe(202)
    expect(replaySend.body.results).toEqual(firstSend.body.results)
    expect(replaySend.body.server_checkpoint).toEqual(firstSend.body.server_checkpoint)
  })

  it('rejects schema violations explicitly and never stores sensitive content', async () => {
    const base = await start()
    const url = `${base}/telemetry/batches`
    const post = (body: unknown, key: string): Promise<{ status: number; body: Record<string, unknown> }> =>
      postBatch(base, body, memberHeaders({ 'Idempotency-Key': key }))

    // Unknown event top-level field carrying a prompt is a per-event rejection.
    const prompt = await post(batchBody([eventOverrides({ prompt: 'top secret user prompt' })]), 's1')
    expect(prompt.status).toBe(202)
    expect(prompt.body.results).toEqual([
      { event_id: expect.any(String), status: 'rejected', reason: 'TELEMETRY_SCHEMA_INVALID' },
    ])

    // Unknown batch-level field fails the whole batch with 400.
    const batchField = await post(batchBody([], { rogue_field: true, events: [] }), 's2')
    expect(batchField.status).toBe(400)
    expect(batchField.body.code).toBe('TELEMETRY_SCHEMA_INVALID')

    // Unsupported schema version.
    const version = await post(batchBody([eventOverrides()], { schema_version: 2 }), 's3')
    expect(version.status).toBe(400)
    expect(version.body.code).toBe('TELEMETRY_SCHEMA_UNSUPPORTED')

    // Unknown kind.
    const kind = await post(batchBody([eventOverrides({ kind: 'productivity.score' })]), 's4')
    expect(kind.status).toBe(202)
    expect((kind.body.results as Array<{ reason?: string }>)[0]?.reason).toBe('TELEMETRY_SCHEMA_INVALID')

    // Missing kind-required fields.
    const missingCallId = await post(batchBody([eventOverrides({ kind: 'tool.call', turn: 1, step: 1, tool_name: 'bash' })]), 's5')
    expect((missingCallId.body.results as Array<{ status: string }>)[0]?.status).toBe('rejected')

    // Wrong token_usage shape.
    const tokens = await post(
      batchBody([eventOverrides({ kind: 'llm.response', turn: 1, step: 1, token_usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3, pricing_version: 'v1' } })]),
      's6',
    )
    expect((tokens.body.results as Array<{ status: string }>)[0]?.status).toBe('rejected')

    // Missing Idempotency-Key.
    const noKey = await fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer demo-token', 'content-type': 'application/json' },
      body: JSON.stringify(batchBody([eventOverrides()])),
    })
    expect(noKey.status).toBe(400)

    // Missing bearer.
    const noAuth = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(batchBody([eventOverrides()])) })
    expect(noAuth.status).toBe(401)
  })

  it('classifies retryable, rejected, and unavailable scenario responses deterministically', async () => {
    const base = await start()
    const retryable = await postBatch(
      base,
      batchBody([eventOverrides()]),
      memberHeaders({ 'Idempotency-Key': 'scn-1', 'x-fixture-scenario': 'telemetry-retryable' }),
    )
    expect(retryable.status).toBe(202)
    expect(retryable.body.results).toEqual([{ event_id: expect.any(String), status: 'retryable', retry_after_seconds: 1, reason: 'TELEMETRY_BUSY' }])

    const rejected = await postBatch(
      base,
      batchBody([eventOverrides()]),
      memberHeaders({ 'Idempotency-Key': 'scn-2', 'x-fixture-scenario': 'telemetry-reject' }),
    )
    expect((rejected.body.results as Array<{ status: string }>)[0]?.status).toBe('rejected')

    const unavailable = await postBatch(
      base,
      batchBody([eventOverrides()]),
      memberHeaders({ 'Idempotency-Key': 'scn-3', 'x-fixture-scenario': 'telemetry-unavailable' }),
    )
    expect(unavailable.status).toBe(503)
    expect(unavailable.body.code).toBe('TELEMETRY_UNAVAILABLE')

    // The 503 batch was not remembered: after recovery the same key succeeds.
    const recovered = await postBatch(base, batchBody([eventOverrides()]), memberHeaders({ 'Idempotency-Key': 'scn-3' }))
    expect(recovered.status).toBe(202)
  })

  it('keeps missing token fields distinct from zero and counts model requests once per llm.request', async () => {
    const base = await start()
    const window = 'from=2000-01-01T00:00:00.000Z&to=2100-01-01T00:00:00.000Z'
    const seeded = await postBatch(
      base,
      batchBody([
        eventOverrides({ event_id: 'tok-1', kind: 'llm.request', session_id: 'tok-session', turn: 1, step: 1, provider: 'deepseek', model: 'deepseek-chat' }),
        eventOverrides({ event_id: 'tok-2', kind: 'llm.response', session_id: 'tok-session', turn: 1, step: 1, provider: 'deepseek', model: 'deepseek-chat', token_usage: { input_tokens: 100, output_tokens: null, total_tokens: null } }),
        eventOverrides({ event_id: 'tok-3', kind: 'llm.response', session_id: 'tok-session', turn: 2, step: 1, provider: 'deepseek', model: 'deepseek-chat', token_usage: { input_tokens: null, output_tokens: 50, total_tokens: null } }),
        eventOverrides({ event_id: 'tok-4', kind: 'llm.response', session_id: 'tok-session', turn: 3, step: 1, provider: 'openai', model: 'gpt-x', token_usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }),
        eventOverrides({ event_id: 'tok-5', kind: 'llm.response', session_id: 'tok-session', turn: 4, step: 1, provider: 'openai', model: 'gpt-x', token_usage: { input_tokens: 0, output_tokens: 0, total_tokens: null } }),
      ]),
      memberHeaders({ 'Idempotency-Key': 'tok-0' }),
    )
    expect(seeded.status).toBe(202)
    expect((seeded.body.results as Array<{ status: string }>).every(item => item.status === 'accepted')).toBe(true)

    const overview = await fetch(`${base}/admin/telemetry/overview?${window}`, { headers: { authorization: 'Bearer admin-demo' } })
    const body = await bodyOf(overview)
    const llm = body.summary.llm
    // 一次调用只计一次 request；未配对 response 不增加请求数。
    expect(llm.requests).toBe(1)
    // 缺失字段不折算成 0：只有真实存在的 100 + 10 进入输入累计。
    expect(llm.input_tokens).toBe(110)
    expect(llm.output_tokens).toBe(55)
    // total 只来自 provider 明确提供的 15；真实零值（tok-5）按 0 计入。
    expect(llm.total_tokens).toBe(15)
    // 质量标记：可计算样本量可见。
    expect(llm.token_sample_size).toBe(4)
    expect(llm.input_token_samples).toBe(3)
    expect(llm.output_token_samples).toBe(3)

    const summary = await fetch(`${base}/admin/projects/project-alpha/telemetry/summary?${window}`, { headers: { authorization: 'Bearer admin-demo' } })
    const summaryBody = await bodyOf(summary)
    const deepseek = summaryBody.models.find((model: { model: string }) => model.model === 'deepseek-chat')
    const gpt = summaryBody.models.find((model: { model: string }) => model.model === 'gpt-x')
    // 模型分布一次调用只计一次 request（request+response 不得算两次）；
    // 未配对 response 的 gpt 不凭空获得请求数。
    expect(deepseek.requests).toBe(1)
    expect(gpt.requests).toBe(0)
    expect(deepseek.input_tokens).toBe(100)
    expect(deepseek.output_tokens).toBe(50)
    expect(deepseek.total_tokens).toBeNull()
    expect(gpt.input_tokens).toBe(10)
    expect(gpt.output_tokens).toBe(5)
    expect(gpt.total_tokens).toBe(15)
  })

  it('reports the same ACK-based delivery classification in overview, buckets, and project summary', async () => {
    const base = await start()
    const window = 'from=2000-01-01T00:00:00.000Z&to=2100-01-01T00:00:00.000Z'
    const first = eventOverrides({ event_id: 'ack-dup-source' })
    const seeded = await postBatch(base, batchBody([first]), memberHeaders({ 'Idempotency-Key': 'ack-1' }))
    expect(seeded.status).toBe(202)

    // 重复批次：新 batch/key 携带已存在 event ID → duplicate ACK。
    const duplicate = await postBatch(base, batchBody([eventOverrides({ event_id: 'ack-dup-source' })]), memberHeaders({ 'Idempotency-Key': 'ack-2' }))
    expect((duplicate.body.results as Array<{ status: string }>)[0]?.status).toBe('duplicate')

    // retryable 与 rejected 各产生一条对应分类的 ACK。
    const retryable = await postBatch(
      base,
      batchBody([eventOverrides({ event_id: 'ack-retryable' })]),
      memberHeaders({ 'Idempotency-Key': 'ack-3', 'x-fixture-scenario': 'telemetry-retryable' }),
    )
    expect((retryable.body.results as Array<{ status: string }>)[0]?.status).toBe('retryable')
    const rejected = await postBatch(
      base,
      batchBody([eventOverrides({ event_id: 'ack-rejected', prompt: '敏感' })]),
      memberHeaders({ 'Idempotency-Key': 'ack-4' }),
    )
    expect((rejected.body.results as Array<{ status: string }>)[0]?.status).toBe('rejected')

    const overview = await fetch(`${base}/admin/telemetry/overview?${window}`, { headers: { authorization: 'Bearer admin-demo' } })
    const body = await bodyOf(overview)
    const delivery = body.summary.delivery as Record<string, number>
    expect(delivery).toEqual({ accepted: 1, duplicate: 1, retryable: 1, rejected: 1, queued: 0, gaps: 0 })
    for (const bucket of body.buckets as Array<{ delivery: Record<string, number> }>) {
      expect(bucket.delivery, 'bucket delivery must use the same ACK classification').toEqual(delivery)
    }

    const summary = await fetch(`${base}/admin/projects/project-alpha/telemetry/summary?${window}`, { headers: { authorization: 'Bearer admin-demo' } })
    const summaryBody = await bodyOf(summary)
    expect(summaryBody.delivery).toEqual(delivery)
    // R10：项目摘要的 summary.delivery 与顶层 delivery 同源同参，逐字段一致。
    expect(summaryBody.summary.delivery).toEqual(delivery)

    // 空窗口：三处 delivery 同为全零，不冒充任何分类计数。
    const emptyWindow = 'from=2101-01-01T00:00:00.000Z&to=2102-01-01T00:00:00.000Z'
    const emptyOverview = await bodyOf(await fetch(`${base}/admin/telemetry/overview?${emptyWindow}`, { headers: { authorization: 'Bearer admin-demo' } }))
    const emptySummary = await bodyOf(await fetch(`${base}/admin/projects/project-alpha/telemetry/summary?${emptyWindow}`, { headers: { authorization: 'Bearer admin-demo' } }))
    const zeros = { accepted: 0, duplicate: 0, retryable: 0, rejected: 0, queued: 0, gaps: 0 }
    expect(emptyOverview.summary.delivery).toEqual(zeros)
    expect(emptySummary.delivery).toEqual(zeros)
    expect(emptySummary.summary.delivery).toEqual(zeros)
  })

  it('does not treat missing token_usage as zero samples (待优化2)', async () => {
    const base = await start()
    const window = 'from=2000-01-01T00:00:00.000Z&to=2100-01-01T00:00:00.000Z'
    const seeded = await postBatch(
      base,
      batchBody([
        // token_usage 整体缺失。
        eventOverrides({ event_id: 'q-1', kind: 'llm.response', session_id: 's', turn: 1, step: 1, provider: 'p1', model: 'm1' }),
        // token_usage 空对象。
        eventOverrides({ event_id: 'q-2', kind: 'llm.response', session_id: 's', turn: 2, step: 1, provider: 'p1', model: 'm1', token_usage: {} }),
        // 多条 response：一条有 input，一条有 output，一条全缺。
        eventOverrides({ event_id: 'q-3', kind: 'llm.response', session_id: 's', turn: 3, step: 1, provider: 'p2', model: 'm2', token_usage: { input_tokens: 7, output_tokens: null, total_tokens: null } }),
        eventOverrides({ event_id: 'q-4', kind: 'llm.response', session_id: 's', turn: 4, step: 1, provider: 'p2', model: 'm2', token_usage: { input_tokens: null, output_tokens: 3, total_tokens: null } }),
        eventOverrides({ event_id: 'q-5', kind: 'llm.response', session_id: 's', turn: 5, step: 1, provider: 'p2', model: 'm2' }),
      ]),
      memberHeaders({ 'Idempotency-Key': 'q-0' }),
    )
    expect(seeded.status).toBe(202)

    const overview = await fetch(`${base}/admin/telemetry/overview?${window}`, { headers: { authorization: 'Bearer admin-demo' } })
    const llm = (await bodyOf(overview)).summary.llm
    // 样本量只统计真实存在的字段；缺失不会伪装成零。
    // token_sample_size 只计至少一个字段真实存在的响应（空对象不计）。
    expect(llm.token_sample_size).toBe(2)
    expect(llm.input_token_samples).toBe(1)
    expect(llm.output_token_samples).toBe(1)
    expect(llm.total_token_samples).toBe(0)
    expect(llm.input_tokens).toBe(7)
    expect(llm.output_tokens).toBe(3)
    expect(llm.total_tokens).toBeNull()

    const summary = await fetch(`${base}/admin/projects/project-alpha/telemetry/summary?${window}`, { headers: { authorization: 'Bearer admin-demo' } })
    const models = (await bodyOf(summary)).models as Array<{
      model: string
      input_token_samples: number
      output_token_samples: number
      total_token_samples: number
    }>
    const m1 = models.find(model => model.model === 'm1')
    const m2 = models.find(model => model.model === 'm2')
    expect(m1?.input_token_samples ?? 0).toBe(0)
    expect(m1?.output_token_samples ?? 0).toBe(0)
    expect(m2?.input_token_samples).toBe(1)
    expect(m2?.output_token_samples).toBe(1)
    expect(m2?.total_token_samples).toBe(0)
  })

  it('O2: token samples count only real values (zero counts, null/missing do not)', async () => {
    const base = await start()
    const window = 'from=2000-01-01T00:00:00.000Z&to=2100-01-01T00:00:00.000Z'
    const seeded = await postBatch(
      base,
      batchBody([
        // 真实零值 input+output：计入样本和累计。
        eventOverrides({ event_id: 'oz-1', kind: 'llm.response', session_id: 's', turn: 1, step: 1, provider: 'px', model: 'mx', token_usage: { input_tokens: 0, output_tokens: 0, total_tokens: null } }),
        // 只有 input。
        eventOverrides({ event_id: 'oz-2', kind: 'llm.response', session_id: 's', turn: 2, step: 1, provider: 'px', model: 'mx', token_usage: { input_tokens: 20, output_tokens: null, total_tokens: null } }),
        // 只有 output。
        eventOverrides({ event_id: 'oz-3', kind: 'llm.response', session_id: 's', turn: 3, step: 1, provider: 'px', model: 'mx', token_usage: { input_tokens: null, output_tokens: 8, total_tokens: null } }),
        // 全缺（token_usage 对象不存在）。
        eventOverrides({ event_id: 'oz-4', kind: 'llm.response', session_id: 's', turn: 4, step: 1, provider: 'py', model: 'my' }),
        // 空 token_usage 对象（等价于全缺）。
        eventOverrides({ event_id: 'oz-5', kind: 'llm.response', session_id: 's', turn: 5, step: 1, provider: 'py', model: 'my', token_usage: {} }),
      ]),
      memberHeaders({ 'Idempotency-Key': 'oz-0' }),
    )
    expect(seeded.status).toBe(202)

    const overview = await fetch(`${base}/admin/telemetry/overview?${window}`, { headers: { authorization: 'Bearer admin-demo' } })
    const llm = (await bodyOf(overview)).summary.llm as Record<string, number | null>
    expect(llm.input_tokens).toBe(20)
    expect(llm.output_tokens).toBe(8)
    expect(llm.total_tokens).toBeNull()
    expect(llm.input_token_samples).toBe(2)
    expect(llm.output_token_samples).toBe(2)
    expect(llm.total_token_samples).toBe(0)
  })

  it('recomputes authorization per request: revocation returns 403 and member reads are forbidden', async () => {
    const base = await start()
    const admin = { authorization: 'Bearer admin-demo', 'content-type': 'application/json' }

    // member-1 is a project member and may deliver.
    const before = await postBatch(base, batchBody([eventOverrides()]), memberHeaders({ 'Idempotency-Key': 'revoke-0' }))
    expect(before.status).toBe(202)

    const revoke = await fetch(`${base}/admin/projects/project-alpha/members/member-1`, {
      method: 'DELETE',
      headers: { ...admin, 'Idempotency-Key': `revoke-${Date.now()}`, 'If-Match': '1' },
    })
    expect(revoke.status).toBe(200)

    // Delivery after revocation returns the revocation code, not a fake success.
    const after = await postBatch(base, batchBody([eventOverrides()]), memberHeaders({ 'Idempotency-Key': 'revoke-1' }))
    expect(after.status).toBe(403)
    expect(after.body.code).toBe('PROJECT_ACCESS_REVOKED')

    // member-1 cannot read team analytics even for a formerly authorized project.
    const memberOverview = await fetch(`${base}/admin/telemetry/overview?from=2000-01-01T00:00:00.000Z&to=2100-01-01T00:00:00.000Z`, { headers: memberHeaders() })
    expect(memberOverview.status).toBe(403)
    const memberEvents = await fetch(`${base}/admin/projects/project-alpha/telemetry/events?from=2000-01-01T00:00:00.000Z&to=2100-01-01T00:00:00.000Z`, { headers: memberHeaders() })
    expect(memberEvents.status).toBe(403)
  })

  it('serves overview, project summary, and cursor-paged events from accepted events only', async () => {
    const base = await start()
    const window = 'from=2000-01-01T00:00:00.000Z&to=2100-01-01T00:00:00.000Z'

    // Empty window first: has_data=false with empty buckets, no demo values.
    const empty = await fetch(`${base}/admin/telemetry/overview?${window}`, { headers: { authorization: 'Bearer admin-demo' } })
    expect(empty.status).toBe(200)
    const emptyBody = await bodyOf(empty)
    expect(emptyBody.has_data).toBe(false)
    expect(emptyBody.buckets).toEqual([])

    // Seed through the real ingest path: accept one, reject one, ignore one duplicate.
    const seeded = await postBatch(
      base,
      batchBody([
        eventOverrides({ event_id: 'seed-1', kind: 'session.started', session_id: 'seed-session' }),
        eventOverrides({ event_id: 'seed-2', kind: 'turn.finished', session_id: 'seed-session', outcome: 'error', duration_ms: 1200 }),
        eventOverrides({ event_id: 'seed-3', kind: 'llm.response', session_id: 'seed-session', turn: 1, step: 1, token_usage: { input_tokens: 100, output_tokens: 40, total_tokens: null } }),
        eventOverrides({ event_id: 'seed-4', prompt: 'sensitive' }),
      ]),
      memberHeaders({ 'Idempotency-Key': 'seed-0' }),
    )
    expect(seeded.status).toBe(202)

    const overview = await fetch(`${base}/admin/telemetry/overview?${window}`, { headers: { authorization: 'Bearer admin-demo' } })
    const overviewBody = await bodyOf(overview)
    expect(overviewBody.has_data).toBe(true)
    expect(overviewBody.summary.sessions.total).toBe(1)
    expect(overviewBody.summary.turns.errors).toBe(1)
    expect(overviewBody.summary.llm.input_tokens).toBe(100)
    expect(overviewBody.summary.llm.output_tokens).toBe(40)
    // No provider total was reported: the aggregate stays null instead of summing.
    expect(overviewBody.summary.llm.total_tokens).toBeNull()
    expect(JSON.stringify(overviewBody)).not.toContain('sensitive')

    const summary = await fetch(`${base}/admin/projects/project-alpha/telemetry/summary?${window}`, { headers: { authorization: 'Bearer admin-demo' } })
    const summaryBody = await bodyOf(summary)
    expect(summaryBody.project_id).toBe('project-alpha')
    expect(summaryBody.delivery.accepted).toBe(3)

    // Events page: strict whitelist fields only.
    const events = await fetch(`${base}/admin/projects/project-alpha/telemetry/events?${window}&limit=2`, { headers: { authorization: 'Bearer admin-demo' } })
    const eventsBody = await bodyOf(events)
    expect(eventsBody.items).toHaveLength(2)
    expect(eventsBody.has_more).toBe(true)
    expect(typeof eventsBody.next_cursor).toBe('string')
    expect(JSON.stringify(eventsBody)).not.toContain('sensitive')

    // Cursor pagination walks to the second page.
    const page2 = await fetch(`${base}/admin/projects/project-alpha/telemetry/events?${window}&limit=2&cursor=${encodeURIComponent(eventsBody.next_cursor as string)}`, {
      headers: { authorization: 'Bearer admin-demo' },
    })
    const page2Body = await bodyOf(page2)
    expect(page2Body.items).toHaveLength(1)
    expect(page2Body.has_more).toBe(false)

    // Filter changes invalidate the old cursor.
    const stale = await fetch(`${base}/admin/projects/project-alpha/telemetry/events?${window}&kind=tool.result&cursor=${encodeURIComponent(eventsBody.next_cursor as string)}`, {
      headers: { authorization: 'Bearer admin-demo' },
    })
    expect(stale.status).toBe(400)
    expect((await bodyOf(stale)).code).toBe('INVALID_CURSOR')

    // Garbage cursors are invalid too.
    const garbage = await fetch(`${base}/admin/projects/project-alpha/telemetry/events?${window}&cursor=not-a-cursor`, {
      headers: { authorization: 'Bearer admin-demo' },
    })
    expect(garbage.status).toBe(400)

    // Invalid time range.
    const badWindow = await fetch(`${base}/admin/telemetry/overview?from=2100-01-01T00:00:00.000Z&to=2000-01-01T00:00:00.000Z`, { headers: { authorization: 'Bearer admin-demo' } })
    expect(badWindow.status).toBe(422)

    // A project outside the manager's organization is invisible.
    const managerSummary = await fetch(`${base}/admin/projects/project-beta/telemetry/summary?${window}`, { headers: { authorization: 'Bearer manager-demo' } })
    expect([403, 404]).toContain(managerSummary.status)
  })
})
