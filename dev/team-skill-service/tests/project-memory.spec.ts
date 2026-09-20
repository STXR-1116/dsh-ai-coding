import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createTeamSkillService } from '../src/server.ts'

interface TestService {
  readonly server: Server
}

const services: TestService[] = []

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

async function start() {
  const service = createTeamSkillService({ port: 0 })
  services.push(service)
  await service.listen()
  const address = service.server.address() as AddressInfo
  return { service, base: `http://127.0.0.1:${address.port}/v3` }
}

interface ProjectMemoryBody {
  readonly code?: string
  readonly request_id?: string
  readonly data: Record<string, unknown>
}

function headers(token = 'demo-token', extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra }
}

async function post(
  base: string,
  path: string,
  body: unknown,
  token = 'demo-token',
  extra: Record<string, string> = {},
): Promise<{ readonly response: Response; readonly body: ProjectMemoryBody }> {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers: headers(token, extra), body: JSON.stringify(body) })
  const value: unknown = await response.json()
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected JSON object response.')
  return { response, body: value as ProjectMemoryBody }
}

describe('project memory fixture', () => {
  it('requires Idempotency-Key for update, replays the same key, and reports concurrency conflicts (0-3)', async () => {
    const { base } = await start()
    await post(
      base,
      '/project-memory/capture',
      { project_id: 'project-alpha', session_id: 'session-1', messages: [{ role: 'user', content: 'Update idempotency probe' }] },
      'demo-token',
      { 'idempotency-key': 'capture-0-3' },
    )
    const list = await post(base, '/project-memory/list', { project_id: 'project-alpha', keyword: 'idempotency probe' })
    const captured = (list.body.data.items as Array<{ memory_id: string; revision: number }>)[0]
    expect(captured).toBeDefined()

    // 缺键 400：真实 MemoryService 会拒绝无幂等键的更新（API 需求 §9.2）。
    const missingKey = await post(
      base,
      '/project-memory/update',
      { memory_id: captured.memory_id, content: 'v2', expected_revision: captured.revision },
      'demo-token',
      { 'if-match': String(captured.revision) },
    )
    expect(missingKey.response.status).toBe(400)
    expect(missingKey.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED')

    // 带键 202。
    const updateRequest = { memory_id: captured.memory_id, content: 'v2 body', expected_revision: captured.revision }
    const keyed = await post(base, '/project-memory/update', updateRequest, 'demo-token', {
      'idempotency-key': 'update-0-3',
      'if-match': String(captured.revision),
    })
    expect(keyed.response.status).toBe(202)

    // 同键同体重放：重放首次结果（同一 event_id），不产生第二次状态变更。
    const replay = await post(base, '/project-memory/update', updateRequest, 'demo-token', {
      'idempotency-key': 'update-0-3',
      'if-match': String(captured.revision),
    })
    expect(replay.response.status).toBe(202)
    expect(replay.body.data.event_id).toBe(keyed.body.data.event_id)

    // 同键不同请求 409 IDEMPOTENCY_CONFLICT。
    const conflict = await post(base, '/project-memory/update', { ...updateRequest, content: 'different body' }, 'demo-token', {
      'idempotency-key': 'update-0-3',
      'if-match': String(captured.revision),
    })
    expect(conflict.response.status).toBe(409)
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT')

    // 并发：第二个新键在已推进的 revision 上更新 → 409 MEMORY_REVISION_CONFLICT。
    const concurrent = await post(
      base,
      '/project-memory/update',
      { memory_id: captured.memory_id, content: 'v3', expected_revision: captured.revision },
      'demo-token',
      { 'idempotency-key': 'update-0-3-b', 'if-match': String(captured.revision) },
    )
    expect(concurrent.response.status).toBe(409)
    expect(concurrent.body.code).toBe('MEMORY_REVISION_CONFLICT')
  })

  it('captures idempotently, recalls by project, updates with revision, and deletes immediately', async () => {
    const { base } = await start()
    const request = {
      project_id: 'project-alpha',
      session_id: 'session-1',
      messages: [{ role: 'user', content: 'Use strict project checks' }],
    }
    const first = await post(base, '/project-memory/capture', request, 'demo-token', { 'idempotency-key': 'capture-1' })
    const replay = await post(base, '/project-memory/capture', request, 'demo-token', { 'idempotency-key': 'capture-1' })
    expect(first.response.status).toBe(202)
    expect(replay.body.data.job_id).toBe(first.body.data.job_id)
    const list = await post(base, '/project-memory/list', { project_id: 'project-alpha', keyword: 'strict project' })
    const captured = (list.body.data.items as Array<{ memory_id: string; revision: number }>).find(item =>
      item.memory_id.includes('capture'),
    )
    expect(captured).toBeDefined()
    const updated = await post(
      base,
      '/project-memory/update',
      { memory_id: captured!.memory_id, content: 'Use strict project checks everywhere', expected_revision: captured!.revision },
      'demo-token',
      { 'idempotency-key': 'update-1', 'if-match': String(captured!.revision) },
    )
    expect(updated.response.status).toBe(202)
    const updatedMemory = updated.body.data.memory as { readonly revision: number }
    // §11.16：捕获进来的是候选，**不被召回**；成员确认后才进入召回。
    // 这是契约驱动的语义变更，不是放宽断言。
    const notYetRecalled = await post(base, '/project-memory/recall', { project_id: 'project-alpha', query: 'everywhere' })
    expect(notYetRecalled.body.data.items).toEqual([])
    const confirmed = await post(
      base,
      `/project-memory/candidates/${captured!.memory_id}:confirm`,
      { expected_revision: updatedMemory.revision },
      'demo-token',
      { 'idempotency-key': 'confirm-1', 'if-match': String(updatedMemory.revision) },
    )
    expect(confirmed.response.status).toBe(200)
    const confirmedMemory = confirmed.body.data.memory as { readonly revision: number }
    await expect(post(base, '/project-memory/recall', { project_id: 'project-alpha', query: 'everywhere' })).resolves.toMatchObject({
      body: { data: { items: [{ content: 'Use strict project checks everywhere' }] } },
    })
    const deleted = await post(
      base,
      '/project-memory/delete',
      { memory_id: captured!.memory_id, expected_revision: confirmedMemory.revision },
      'demo-token',
      { 'idempotency-key': 'delete-1', 'if-match': String(confirmedMemory.revision) },
    )
    expect(deleted.response.status).toBe(202)
    expect(deleted.body.data.status).toBe('PENDING')
    const deleteReplay = await post(
      base,
      '/project-memory/delete',
      { memory_id: captured!.memory_id, expected_revision: confirmedMemory.revision },
      'demo-token',
      { 'idempotency-key': 'delete-1', 'if-match': String(confirmedMemory.revision) },
    )
    expect(deleteReplay.response.status).toBe(202)
    expect(deleteReplay.body.data).toEqual(deleted.body.data)
    await expect(post(base, '/project-memory/recall', { project_id: 'project-alpha', query: 'everywhere' })).resolves.toMatchObject({
      body: { data: { items: [] } },
    })
  })

  it('enforces project isolation, owner writes, conflicts, and unavailable status', async () => {
    const { base } = await start()
    const denied = await post(base, '/project-memory/list', { project_id: 'project-beta' })
    expect(denied.response.status).toBe(403)
    expect(denied.body.code).toBe('PROJECT_ACCESS_DENIED')
    const forbidden = await post(base, '/project-memory/update', { memory_id: 'm-2', content: 'nope', expected_revision: 1 }, 'demo-token', {
      'idempotency-key': 'update-forbidden-1',
      'if-match': '1',
    })
    expect(forbidden.response.status).toBe(403)
    expect(forbidden.body.code).toBe('MEMORY_EDIT_FORBIDDEN')
    const conflict = await post(
      base,
      '/project-memory/update',
      { memory_id: 'm-1', content: 'stale', expected_revision: 99 },
      'demo-token',
      { 'idempotency-key': 'update-conflict-1', 'if-match': '99' },
    )
    expect(conflict.response.status).toBe(409)
    expect(conflict.body.code).toBe('MEMORY_REVISION_CONFLICT')
    const unavailable = await post(base, '/project-memory/recall', { project_id: 'project-alpha', query: 'strict' }, 'demo-token', {
      'x-fixture-scenario': 'unavailable',
    })
    expect(unavailable.response.status).toBe(503)
    expect(unavailable.body.code).toBe('MEMORY_SERVICE_UNAVAILABLE')
  })

  it('updates every supported policy value without dropping sibling fields', async () => {
    const { base } = await start()
    const response = await post(
      base,
      '/project-memory/policy/update',
      {
        scope_type: 'project',
        scope_id: 'project-alpha',
        patch: { top_k: 5, relevance_threshold: 0.7, token_budget: 900 },
        expected_revision: 1,
      },
      'admin-demo',
      { 'if-match': '1', 'idempotency-key': 'policy-1' },
    )
    expect(response.response.status).toBe(200)
    expect(response.body.data.values).toEqual({ top_k: 5, relevance_threshold: 0.7, token_budget: 900 })
  })

  it('no longer serves scope/update (cross-project migration is forbidden)', async () => {
    const { base } = await start()
    const moved = await post(
      base,
      '/project-memory/scope/update',
      { memory_id: 'm-1', target_project_id: 'project-beta', expected_revision: 1 },
      'admin-demo',
      { 'if-match': '1', 'idempotency-key': 'scope-removed-1' },
    )
    expect(moved.response.status).toBe(404)
  })
  it('requires If-Match for retrying a memory job and audits accepted governance changes', async () => {
    const { base } = await start()
    const policy = await post(
      base,
      '/project-memory/policy/update',
      { scope_type: 'project', scope_id: 'project-alpha', patch: { top_k: 5 }, expected_revision: 1 },
      'admin-demo',
      { 'if-match': '1', 'idempotency-key': 'policy-audit-1' },
    )
    expect(policy.response.status).toBe(200)
    const deleted = await post(base, '/project-memory/delete', { memory_id: 'm-1', expected_revision: 1 }, 'admin-demo', {
      'if-match': '1',
      'idempotency-key': 'retry-source-delete',
      'x-fixture-scenario': 'cleanup-failed',
    })
    expect(deleted.response.status).toBe(202)
    const jobs = await post(base, '/project-memory/jobs/list', { project_id: 'project-alpha' }, 'admin-demo')
    const job = (jobs.body.data.items as Array<{ job_id: string; revision: number }>)[0]
    const missingHeader = await post(base, '/project-memory/jobs/retry', { job_id: job.job_id, expected_revision: job.revision }, 'admin-demo', {
      'idempotency-key': 'retry-missing-match',
    })
    expect(missingHeader.response.status).toBe(400)
    expect(missingHeader.body.code).toBe('IF_MATCH_REQUIRED')
    const retry = await post(base, '/project-memory/jobs/retry', { job_id: job.job_id, expected_revision: job.revision }, 'admin-demo', {
      'if-match': String(job.revision),
      'idempotency-key': 'retry-with-match',
    })
    expect(retry.response.status).toBe(202)
    const audit = await post(base, '/project-memory/audit/list', { project_id: 'project-alpha' }, 'admin-demo')
    expect(audit.body.data.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ operation: 'POLICY_UPDATED' }), expect.objectContaining({ operation: 'JOB_RETRIED' })]),
    )
  })

  it('keeps a deleted memory out of recall when cleanup reports failure', async () => {
    const { base } = await start()
    const deleted = await post(base, '/project-memory/delete', { memory_id: 'm-1', expected_revision: 1 }, 'manager-demo', {
      'if-match': '1',
      'idempotency-key': 'delete-failed-1',
      'x-fixture-scenario': 'cleanup-failed',
    })
    expect(deleted.response.status).toBe(202)
    expect(deleted.body.data.cleanup_status).toBe('FAILED')
    const recalled = await post(base, '/project-memory/recall', { project_id: 'project-alpha', query: 'strict' })
    expect(recalled.body.data.items).toEqual([])
    const jobs = await post(base, '/project-memory/jobs/list', { project_id: 'project-alpha' }, 'manager-demo')
    expect(jobs.body.data.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'DELETE_CLEANUP', status: 'FAILED', error_code: 'MEMORY_SERVICE_UNAVAILABLE' }),
      ]),
    )
  })

  it('does not expose deleted records through the ordinary list endpoint', async () => {
    const { base } = await start()
    const response = await post(base, '/project-memory/list', { project_id: 'project-alpha', status: 'DELETED' }, 'manager-demo')
    expect(response.response.status).toBe(400)
    expect(response.body.code).toBe('INVALID_REQUEST')
  })

  it('returns a client error for malformed project-memory JSON', async () => {
    const { base } = await start()
    const response = await fetch(`${base}/project-memory/list`, {
      method: 'POST',
      headers: headers(),
      body: '{"project_id":',
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'INVALID_JSON' })
  })

  // §11.16（2026-09-16 冻结）：召回命中必须带来源信息，且命中形状是**独立投影**，
  // 不是存储记录本身——存储记录没有 score，直接展开会让 Host 的严格解析必然拒绝
  // （这正是本次修复的真实缺陷：插件的召回链路此前拿不到可解析的响应）。
  it('每条召回命中都带 score/recall_reason/source_run_id/updated_at/confidence', async () => {
    const { base } = await start()
    const recall = await post(base, '/project-memory/recall', { project_id: 'project-alpha', query: '' })
    expect(recall.response.status).toBe(200)
    const items = (recall.body.data as { items: Array<Record<string, unknown>> }).items
    expect(items.length).toBeGreaterThan(0)

    for (const item of items) {
      expect(typeof item.score).toBe('number')
      expect(typeof item.recall_reason).toBe('string')
      expect(String(item.recall_reason).length).toBeGreaterThan(0)
      // 捕获不带运行标识：非运行来源必须显式为 null，不得用空串。
      expect(item.source_run_id).toBeNull()
      expect(Number.isNaN(Date.parse(String(item.updated_at)))).toBe(false)
      const confidence = Number(item.confidence)
      expect(confidence).toBeGreaterThanOrEqual(0)
      expect(confidence).toBeLessThanOrEqual(1)
    }
    // 独立投影：存储记录字段不得原样渗透。
    expect(items[0]).not.toHaveProperty('importance')
    expect(items[0]).not.toHaveProperty('status')
  })

  it('confidence 由服务端计算并随佐证次数变化，不是常量', async () => {
    const { base } = await start()
    const confidenceOf = async (): Promise<number> => {
      const body = await post(base, '/project-memory/recall', { project_id: 'project-alpha', query: '' })
      const confidence = (body.body.data.items as Array<{ confidence: number }>)[0]?.confidence
      if (confidence === undefined) throw new Error('recall returned no items')
      return confidence
    }
    const first = await confidenceOf()
    const second = await confidenceOf()

    expect(second).toBeGreaterThan(first)
  })

  // §11.16（2026-09-16 冻结）：自动捕获进候选，**候选不参与召回**；成员确认后才进入召回。
  // 这是本阶段最关键的语义变更：候选绝不能进入模型上下文。
  it('captured memories are candidates and are not recalled until confirmed', async () => {
    const { base } = await start()
    const content = 'candidate probe content token'
    const captured = await post(
      base,
      '/project-memory/capture',
      { project_id: 'project-alpha', session_id: 'session-candidate', messages: [{ role: 'user', content }] },
      'demo-token',
      { 'idempotency-key': 'capture-candidate-1' },
    )
    expect(captured.response.status).toBe(202)

    const list = await post(base, '/project-memory/candidates/list', { project_id: 'project-alpha' })
    expect(list.response.status).toBe(200)
    const candidate = (list.body.data.items as Array<Record<string, unknown>>).find(item =>
      String(item.memory_id).includes('-capture-'),
    )
    expect(candidate).toBeDefined()
    expect(candidate?.tier).toBe('project_candidate')
    const memoryId = String(candidate?.memory_id)
    const revision = Number(candidate?.revision)

    // 候选不进召回。
    const before = await post(base, '/project-memory/recall', { project_id: 'project-alpha', query: content })
    expect((before.body.data as { items: unknown[] }).items).toEqual([])

    // 确认后进召回。
    const confirmed = await post(
      base,
      `/project-memory/candidates/${memoryId}:confirm`,
      { expected_revision: revision },
      'demo-token',
      { 'idempotency-key': 'confirm-candidate-1', 'if-match': String(revision) },
    )
    expect(confirmed.response.status).toBe(200)
    expect((confirmed.body.data.memory as Record<string, unknown>).tier).toBe('project_confirmed')

    const after = await post(base, '/project-memory/recall', { project_id: 'project-alpha', query: content })
    expect((after.body.data.items as Array<{ memory_id: string }>).map(item => item.memory_id)).toContain(memoryId)
  })

  it('confirm requires idempotency, revision guard, and an actual candidate', async () => {
    const { base } = await start()
    const content = 'candidate guard token'
    await post(
      base,
      '/project-memory/capture',
      { project_id: 'project-alpha', session_id: 'session-guard', messages: [{ role: 'user', content }] },
      'demo-token',
      { 'idempotency-key': 'capture-guard-1' },
    )
    const list = await post(base, '/project-memory/candidates/list', { project_id: 'project-alpha' })
    const candidate = (list.body.data.items as Array<Record<string, unknown>>).find(item =>
      String(item.memory_id).includes('-capture-'),
    )
    const memoryId = String(candidate?.memory_id)
    const revision = Number(candidate?.revision)
    const path = `/project-memory/candidates/${memoryId}:confirm`

    const noKey = await post(base, path, { expected_revision: revision }, 'demo-token', { 'if-match': String(revision) })
    expect(noKey.response.status).toBe(400)
    expect(noKey.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED')

    const noRevision = await post(base, path, { expected_revision: revision }, 'demo-token', { 'idempotency-key': 'confirm-guard-1' })
    expect(noRevision.response.status).toBe(400)
    expect(noRevision.body.code).toBe('IF_MATCH_REQUIRED')

    const stale = await post(
      base,
      path,
      { expected_revision: revision + 99 },
      'demo-token',
      { 'idempotency-key': 'confirm-guard-2', 'if-match': String(revision + 99) },
    )
    expect(stale.response.status).toBe(409)
    expect(stale.body.code).toBe('MEMORY_REVISION_CONFLICT')

    // 确认一次成功，再确认同一条必须 INVALID_STATE（它已不是候选）。
    const ok = await post(
      base,
      path,
      { expected_revision: revision },
      'demo-token',
      { 'idempotency-key': 'confirm-guard-3', 'if-match': String(revision) },
    )
    expect(ok.response.status).toBe(200)
    const again = await post(
      base,
      path,
      { expected_revision: revision + 1 },
      'demo-token',
      { 'idempotency-key': 'confirm-guard-4', 'if-match': String(revision + 1) },
    )
    expect(again.response.status).toBe(409)
    expect(again.body.code).toBe('INVALID_STATE')
  })

  // §11.16：候选必须能回答「由哪个事件产生、何时过期、能否提升为团队记忆」。
  it('every memory record carries source_event_id, expires_at and scope', async () => {
    const { base } = await start()
    const list = await post(base, '/project-memory/list', { project_id: 'project-alpha' })
    const items = (list.body.data as { items: Array<Record<string, unknown>> }).items
    expect(items.length).toBeGreaterThan(0)

    for (const item of items) {
      // 非空字符串：来源事件的稳定标识，对客户端不透明。
      expect(typeof item.source_event_id).toBe('string')
      expect(String(item.source_event_id).length).toBeGreaterThan(0)
      // 未设过期时间时必须显式为 null，不能用空串。
      expect(item.expires_at).toBeNull()
      expect(['project_only', 'shared']).toContain(item.scope)
    }
  })

  // §11.16：撤回把已确认记忆退回候选——效果是**立刻退出召回**，内容不删除。
  it('retract returns a confirmed memory to candidate and takes it out of recall', async () => {
    const { base } = await start()
    const content = 'retract probe content'
    await post(
      base,
      '/project-memory/capture',
      { project_id: 'project-alpha', session_id: 's-retract', messages: [{ role: 'user', content }] },
      'demo-token',
      { 'idempotency-key': 'capture-retract-1' },
    )
    const candidates = await post(base, '/project-memory/candidates/list', { project_id: 'project-alpha' })
    const candidate = (candidates.body.data.items as Array<Record<string, unknown>>).find(item =>
      String(item.memory_id).includes('-capture-'),
    )
    const memoryId = String(candidate?.memory_id)
    const revision = Number(candidate?.revision)

    const confirmed = await post(
      base,
      `/project-memory/candidates/${memoryId}:confirm`,
      { expected_revision: revision },
      'demo-token',
      { 'idempotency-key': 'confirm-retract-1', 'if-match': String(revision) },
    )
    expect(confirmed.response.status).toBe(200)
    const confirmedRevision = (confirmed.body.data.memory as { revision: number }).revision

    const inRecall = await post(base, '/project-memory/recall', { project_id: 'project-alpha', query: content })
    expect((inRecall.body.data.items as Array<unknown>)).toHaveLength(1)

    const retracted = await post(
      base,
      `/project-memory/candidates/${memoryId}:retract`,
      { expected_revision: confirmedRevision },
      'demo-token',
      { 'idempotency-key': 'retract-1', 'if-match': String(confirmedRevision) },
    )
    expect(retracted.response.status).toBe(200)
    expect((retracted.body.data.memory as Record<string, unknown>).tier).toBe('project_candidate')

    const outRecall = await post(base, '/project-memory/recall', { project_id: 'project-alpha', query: content })
    expect((outRecall.body.data.items as Array<unknown>)).toEqual([])
    // 内容不删除：仍在列表中。
    const list = await post(base, '/project-memory/list', { project_id: 'project-alpha', keyword: content })
    expect((list.body.data.items as Array<Record<string, unknown>>).map(item => item.memory_id)).toContain(memoryId)
  })

  it('expire sets and clears a memory expiry and rejects a non-ISO value', async () => {
    const { base } = await start()
    const content = 'expire probe content'
    await post(
      base,
      '/project-memory/capture',
      { project_id: 'project-alpha', session_id: 's-expire', messages: [{ role: 'user', content }] },
      'demo-token',
      { 'idempotency-key': 'capture-expire-1' },
    )
    const list = await post(base, '/project-memory/list', { project_id: 'project-alpha', keyword: content })
    const memory = (list.body.data.items as Array<Record<string, unknown>>)[0]
    const memoryId = String(memory?.memory_id)
    const revision = Number(memory?.revision)

    const bad = await post(
      base,
      `/project-memory/${memoryId}:expire`,
      { expected_revision: revision, expires_at: 'not-a-date' },
      'demo-token',
      { 'idempotency-key': 'expire-bad-1', 'if-match': String(revision) },
    )
    expect(bad.response.status).toBe(422)
    expect(bad.body.code).toBe('VALIDATION_ERROR')

    const set = await post(
      base,
      `/project-memory/${memoryId}:expire`,
      { expected_revision: revision, expires_at: '2026-12-31T00:00:00.000Z' },
      'demo-token',
      { 'idempotency-key': 'expire-1', 'if-match': String(revision) },
    )
    expect(set.response.status).toBe(200)
    expect((set.body.data.memory as Record<string, unknown>).expires_at).toBe('2026-12-31T00:00:00.000Z')
    const setRevision = (set.body.data.memory as { revision: number }).revision

    const clear = await post(
      base,
      `/project-memory/${memoryId}:expire`,
      { expected_revision: setRevision, expires_at: null },
      'demo-token',
      { 'idempotency-key': 'expire-2', 'if-match': String(setRevision) },
    )
    expect(clear.response.status).toBe(200)
    expect((clear.body.data.memory as Record<string, unknown>).expires_at).toBeNull()
  })

  // §11.16：合并是**全有或全无**——任一条不满足前置条件即整体 422，
  // 因为部分合并会静默丢掉调用者以为已经折进去的内容。
  it('merges candidates into one new candidate, all-or-nothing', async () => {
    const { base } = await start()
    for (const [content, key] of [
      ['merge candidate alpha', 'capture-merge-a'],
      ['merge candidate beta', 'capture-merge-b'],
    ] as const) {
      await post(
        base,
        '/project-memory/capture',
        { project_id: 'project-alpha', session_id: 's-merge', messages: [{ role: 'user', content }] },
        'demo-token',
        { 'idempotency-key': key },
      )
    }
    const candidates = await post(base, '/project-memory/candidates/list', { project_id: 'project-alpha' })
    const ids = (candidates.body.data.items as Array<Record<string, unknown>>)
      .filter(item => String(item.memory_id).includes('-capture-'))
      .map(item => String(item.memory_id))
    const first = ids[0]
    const second = ids[1]
    if (first === undefined || second === undefined) throw new Error('expected two candidates')

    // 其中一条不存在 → 整体 422，不得部分合并。
    const partial = await post(
      base,
      '/project-memory/candidates/merge',
      { memory_ids: [first, 'memory-does-not-exist'], content: 'merged' },
      'demo-token',
      { 'idempotency-key': 'merge-partial-1' },
    )
    expect(partial.response.status).toBe(422)
    expect(partial.body.code).toBe('VALIDATION_ERROR')

    const merged = await post(
      base,
      '/project-memory/candidates/merge',
      { memory_ids: [first, second], content: 'merged content' },
      'demo-token',
      { 'idempotency-key': 'merge-1' },
    )
    expect(merged.response.status).toBe(202)
    const mergedMemory = merged.body.data.memory as Record<string, unknown>
    // 候选合并出来的仍然是候选：没有任何一条被确认过。
    expect(mergedMemory.tier).toBe('project_candidate')

    const list = await post(base, '/project-memory/list', { project_id: 'project-alpha' })
    const activeIds = (list.body.data.items as Array<Record<string, unknown>>).map(item => String(item.memory_id))
    expect(activeIds).not.toContain(first)
    expect(activeIds).not.toContain(second)
    const after = await post(base, '/project-memory/candidates/list', { project_id: 'project-alpha' })
    expect(
      (after.body.data.items as Array<Record<string, unknown>>).map(item => String(item.memory_id)),
    ).toContain(String(mergedMemory.memory_id))
  })
})
