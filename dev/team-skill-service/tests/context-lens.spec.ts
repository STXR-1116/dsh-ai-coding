import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createTeamSkillService } from '../src/server.ts'

// 2-7「上下文镜头」fixture 契约探针（§11.13，2026-09-16 冻结）；
// 3-3 追加按运行抑制单条记忆（§11.17，2026-09-16 冻结）。
//
// 异常矩阵：
//   缺失      —— 未知工作空间 → 404；条目必须携带完整字段集。
//   优先级    —— entries 按 §4.3 八层优先级排序（词表顺序）。
//   被抑制    —— 冲突/过期/未授权条目必须保留且携带 permission_reason，
//                不得悄悄消失；suppressed 条目 injected=false。
//   判定引用  —— permission_decisions 携带 action/decision/code/reason/
//                policy_version/at，按时间倒序且 ≤8 条。
//   只读      —— 两次读取之间 revision 与条目集不变，不写业务审计。
//   记忆身份  —— source='memory' 必带非空 memory_id，其他来源必须显式 null。
//   运行作用域—— 抑制按 run_id 归键：只改该运行看到的快照，基线与其他运行不受
//                影响；被抑制条目仍在且写明是本运行的抑制。
//   缺失/越权 —— 未知运行、未知记忆、跨项目记忆一律 404 且 data=null；
//                缺 Idempotency-Key 400；同键重放 200 同体，同键不同体 409；
//                空 run_id= 是 422（不等于「不抑制」）。

const services: Array<{ readonly server: Server }> = []

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

async function start(): Promise<number> {
  const service = createTeamSkillService({ port: 0 })
  services.push(service)
  await service.listen()
  return (service.server.address() as AddressInfo).port
}

async function login(port: number, username: string, password: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  expect(response.status).toBe(200)
  return ((await response.json()) as { data: { access_token: string } }).data.access_token
}

async function send(
  port: number,
  method: string,
  path: string,
  token: string,
  body?: unknown,
  extra: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, json: (await response.json()) as Record<string, unknown> }
}

async function entriesOf(port: number, token: string, query = ''): Promise<Array<Record<string, unknown>>> {
  return (dataOf(await send(port, 'GET', `/v1/workspaces/ws-alpha-1:context-lens${query}`, token))['entries'] ?? []) as Array<Record<string, unknown>>
}

/** Creates one extra run on `ws-alpha-1` so run-scoped decisions can be told apart. */
async function createRun(port: number, token: string, key: string): Promise<string> {
  const revision = dataOf(await send(port, 'GET', '/v1/workspaces/ws-alpha-1', token))['revision'] as number
  const created = await send(port, 'POST', '/v1/workspaces/ws-alpha-1/runs', token, {
    session_id: `sess-${key}`, write_mode: 'read_only', expected_workspace_revision: revision,
  }, { 'idempotency-key': key })
  expect(created.status).toBe(202)
  return dataOf(created)['run_id'] as string
}

function dataOf(result: { json: Record<string, unknown> }): Record<string, unknown> {
  return result.json['data'] as Record<string, unknown>
}

/** Picks one memory entry the run still injects — the only kind a user can switch off. */
function allowedMemoryId(entries: readonly Record<string, unknown>[]): string {
  const allowed = entries.find(entry => entry['source'] === 'memory' && entry['permission'] === 'allowed')
  expect(allowed, '夹具必须有一条未被抑制的记忆条目').toBeDefined()
  return String(allowed?.['memory_id'])
}

function permissionOf(entries: readonly Record<string, unknown>[], memoryId: string): unknown {
  return entries.find(entry => entry['memory_id'] === memoryId)?.['permission']
}

const LAYER_ORDER = ['safety', 'org-policy', 'project-policy', 'agent-config', 'skill', 'knowledge', 'memory', 'user']

describe('2-7 上下文镜头（§11.13）', () => {
  it('快照字段齐备，entries 按八层优先级排序且覆盖六类来源', async () => {
    const port = await start()
    const admin = await login(port, 'admin@example.com', 'admin-pass')
    const lens = await send(port, 'GET', '/v1/workspaces/ws-alpha-1:context-lens', admin)
    expect(lens.status).toBe(200)
    const data = dataOf(lens)
    for (const field of ['workspace_id', 'revision', 'generated_at', 'entries', 'permission_decisions']) {
      expect(Object.hasOwn(data, field), `镜头快照必须携带 ${field}`).toBe(true)
    }
    expect(data['workspace_id']).toBe('ws-alpha-1')
    const entries = (data['entries'] ?? []) as Array<Record<string, unknown>>
    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) {
      for (const field of ['source', 'title', 'permission', 'permission_reason', 'selection_reason', 'injected', 'updated_at']) {
        expect(Object.hasOwn(entry, field), `账本条目必须携带 ${field}`).toBe(true)
      }
    }
    // 八层优先级：条目 source 的词表下标沿排序不下降
    const ranks = entries.map(entry => LAYER_ORDER.indexOf(entry['source'] as string))
    for (let i = 1; i < ranks.length; i += 1) {
      expect(ranks[i] ?? -1).toBeGreaterThanOrEqual(ranks[i - 1] ?? -1)
    }
    // 六类来源覆盖：规则四层、skill、knowledge、memory 至少各一条
    for (const source of ['safety', 'org-policy', 'project-policy', 'agent-config', 'skill', 'knowledge', 'memory']) {
      expect(entries.some(entry => entry['source'] === source), `必须包含 ${source} 层条目`).toBe(true)
    }
  })

  it('冲突/过期/未授权条目被抑制且携带原因，不悄悄消失', async () => {
    const port = await start()
    const admin = await login(port, 'admin@example.com', 'admin-pass')
    const entries = (dataOf(await send(port, 'GET', '/v1/workspaces/ws-alpha-1:context-lens', admin))['entries'] ?? []) as Array<Record<string, unknown>>
    const suppressed = entries.filter(entry => entry['permission'] === 'suppressed')
    expect(suppressed.length).toBeGreaterThanOrEqual(3)
    for (const entry of suppressed) {
      expect(String(entry['permission_reason']).length).toBeGreaterThan(0)
      expect(entry['injected']).toBe(false)
    }
    // 三类抑制原因各至少一条：冲突、过期、未授权
    const reasons = suppressed.map(entry => String(entry['permission_reason'])).join('\n')
    expect(reasons).toContain('冲突')
    expect(reasons).toContain('过期')
    expect(reasons).toContain('未授权')
  })

  it('权限判定引用：字段齐备、时间倒序、≤8 条；两次读取无漂移；未知工作空间 404', async () => {
    const port = await start()
    const admin = await login(port, 'admin@example.com', 'admin-pass')
    const data = dataOf(await send(port, 'GET', '/v1/workspaces/ws-alpha-1:context-lens', admin))
    const decisions = (data['permission_decisions'] ?? []) as Array<Record<string, unknown>>
    expect(decisions.length).toBeGreaterThanOrEqual(1)
    expect(decisions.length).toBeLessThanOrEqual(8)
    for (const decision of decisions) {
      for (const field of ['action', 'decision', 'code', 'reason', 'policy_version', 'at']) {
        expect(Object.hasOwn(decision, field), `权限判定必须携带 ${field}`).toBe(true)
      }
    }
    const ats = decisions.map(decision => decision['at'] as string)
    expect([...ats].reverse()).toEqual([...ats].sort())
    // 只读：两次读取一致
    const again = dataOf(await send(port, 'GET', '/v1/workspaces/ws-alpha-1:context-lens', admin))
    expect(again['revision']).toBe(data['revision'])
    expect(again['entries']).toEqual(data['entries'])
    const missing = await send(port, 'GET', '/v1/workspaces/ws-not-exist:context-lens', admin)
    expect(missing.status).toBe(404)
  })
})

describe('3-3 上下文镜头按运行抑制单条记忆（§11.17）', () => {
  it('记忆条目携带记忆身份：memory 层必有非空 memory_id，其他层显式为 null', async () => {
    const port = await start()
    const admin = await login(port, 'admin@example.com', 'admin-pass')
    const entries = await entriesOf(port, admin)
    expect(entries.length).toBeGreaterThan(0)
    let memories = 0
    for (const entry of entries) {
      expect(Object.hasOwn(entry, 'memory_id'), '账本条目必须携带 memory_id').toBe(true)
      if (entry['source'] === 'memory') {
        memories += 1
        expect(typeof entry['memory_id'], '记忆条目必须携带记忆身份').toBe('string')
        expect(String(entry['memory_id']).length).toBeGreaterThan(0)
        continue
      }
      // 非记忆层不得借道记忆身份：有身份就意味着它可以被「抑制这一条」。
      expect(entry['memory_id']).toBeNull()
    }
    expect(memories).toBeGreaterThanOrEqual(2)
  })

  it('抑制端点返回更新后的同形快照：条目不消失、写明是本运行的抑制、不写业务审计', async () => {
    const port = await start()
    const admin = await login(port, 'admin@example.com', 'admin-pass')
    const before = await entriesOf(port, admin)
    const target = allowedMemoryId(before)

    const suppressed = await send(port, 'POST', '/v1/workspaces/ws-alpha-1:context-lens/memory-suppression', admin,
      { run_id: 'run-seed-1', memory_id: target, suppressed: true }, { 'idempotency-key': '317-suppress-1' })
    expect(suppressed.status).toBe(200)
    const data = dataOf(suppressed)
    for (const field of ['workspace_id', 'revision', 'generated_at', 'entries', 'permission_decisions']) {
      expect(Object.hasOwn(data, field), `抑制响应必须与 GET 同形，缺 ${field}`).toBe(true)
    }
    const after = data['entries'] as Array<Record<string, unknown>>
    expect(after).toHaveLength(before.length)
    const hit = after.find(entry => entry['memory_id'] === target)
    expect(hit, '被抑制的记忆必须仍然出现在镜头里，不得消失').toBeDefined()
    expect(hit?.['permission']).toBe('suppressed')
    expect(hit?.['injected']).toBe(false)
    expect(String(hit?.['permission_reason'])).toContain('本运行')
    expect(String(hit?.['selection_reason'])).toContain('本运行')
    // 镜头对共享资产仍然只读：运行内的读时决定不是治理动作，不写业务审计。
    // 先造一条同窗口的对照行，否则「0 行」也可能只是审计通道读不到东西。
    await createRun(port, admin, '317-audit-probe')
    const control = await send(port, 'GET', '/v1/admin/audits?action=run.create', admin)
    expect((dataOf(control) as unknown as unknown[]).length).toBeGreaterThan(0)
    const audits = await send(port, 'GET', '/v1/admin/audits?action=workspace.context_lens.memory_suppression', admin)
    expect(dataOf(audits)).toEqual([])
  })

  it('抑制只属于该运行：基线与其他运行不受影响，恢复后回到原状', async () => {
    const port = await start()
    const admin = await login(port, 'admin@example.com', 'admin-pass')
    const baseline = await entriesOf(port, admin)
    const target = allowedMemoryId(baseline)
    const otherRun = await createRun(port, admin, '317-other-run')

    await send(port, 'POST', '/v1/workspaces/ws-alpha-1:context-lens/memory-suppression', admin,
      { run_id: 'run-seed-1', memory_id: target, suppressed: true }, { 'idempotency-key': '317-scope-in' })

    // 基线快照（没有运行可归属）与其他运行都不继承这条决定。
    expect(permissionOf(await entriesOf(port, admin), target)).toBe('allowed')
    expect(permissionOf(await entriesOf(port, admin, `?run_id=${otherRun}`), target)).toBe('allowed')
    expect(permissionOf(await entriesOf(port, admin, '?run_id=run-seed-1'), target)).toBe('suppressed')

    const restored = await send(port, 'POST', '/v1/workspaces/ws-alpha-1:context-lens/memory-suppression', admin,
      { run_id: 'run-seed-1', memory_id: target, suppressed: false }, { 'idempotency-key': '317-scope-out' })
    expect(restored.status).toBe(200)
    expect(permissionOf(dataOf(restored)['entries'] as Array<Record<string, unknown>>, target)).toBe('allowed')
  })

  it('未知运行/未知记忆/跨项目记忆 → 404；缺幂等键 400；同键重放 200 且状态不变，同键不同体 409', async () => {
    const port = await start()
    const admin = await login(port, 'admin@example.com', 'admin-pass')
    const target = allowedMemoryId(await entriesOf(port, admin))
    const path = '/v1/workspaces/ws-alpha-1:context-lens/memory-suppression'
    const body = { run_id: 'run-seed-1', memory_id: target, suppressed: true }

    const unknownRun = await send(port, 'POST', path, admin, { ...body, run_id: 'run-not-exist' }, { 'idempotency-key': '317-404-run' })
    expect(unknownRun.status).toBe(404)
    const unknownMemory = await send(port, 'POST', path, admin, { ...body, memory_id: 'mem-not-exist' }, { 'idempotency-key': '317-404-memory' })
    expect(unknownMemory.status).toBe(404)
    // 别的项目授权过的记忆与「不存在」同码同形：状态码不泄露存在性。
    const crossProject = await send(port, 'POST', path, admin, { ...body, memory_id: 'mem-beta-only' }, { 'idempotency-key': '317-404-cross' })
    expect(crossProject.status).toBe(404)
    expect(dataOf(crossProject)).toBeNull()

    const noKey = await send(port, 'POST', path, admin, body)
    expect(noKey.status).toBe(400)
    expect(noKey.json['code']).toBe('IDEMPOTENCY_KEY_REQUIRED')

    const malformed = await send(port, 'POST', path, admin, { ...body, suppressed: 'yes' }, { 'idempotency-key': '317-malformed' })
    expect(malformed.status).toBe(422)

    const first = await send(port, 'POST', path, admin, body, { 'idempotency-key': '317-replay' })
    expect(first.status).toBe(200)
    const replay = await send(port, 'POST', path, admin, body, { 'idempotency-key': '317-replay' })
    expect(replay.status).toBe(200)
    expect(dataOf(replay)).toEqual(dataOf(first))
    const conflict = await send(port, 'POST', path, admin, { ...body, suppressed: false }, { 'idempotency-key': '317-replay' })
    expect(conflict.status).toBe(409)
    expect(conflict.json['code']).toBe('IDEMPOTENCY_CONFLICT')

    // 作用域参数本身也要严格：空的 run_id 不等于「没有作用域」。
    const emptyScope = await send(port, 'GET', '/v1/workspaces/ws-alpha-1:context-lens?run_id=', admin)
    expect(emptyScope.status).toBe(422)
  })
})
