/**
 * 3-3「上下文镜头按运行抑制单条记忆」平台面契约探针（§11.17，2026-09-16 冻结）。
 *
 * 异常矩阵：
 *   缺失      —— `source='memory'` 缺 `memory_id`（或空字符串）→
 *                `SERVICE_PROTOCOL_ERROR`，不得当成「没有身份」继续。
 *   词表外    —— 非记忆层携带 `memory_id` → 协议漂移拒绝：有身份就意味着这条
 *                可以被「抑制这一条」，别的层不该有这个能力。
 *   类型错    —— `memory_id` 既不是字符串也不是 null → 拒绝，不用空串或哨兵顶替。
 *   运行作用域—— `contextLens(runId)` 才带 `run_id`；不带时不得凭空加上，
 *                否则基线快照会被读成某次运行的快照。
 *   抑制请求  —— 抑制走 `:context-lens/memory-suppression`、带 `Idempotency-Key`、
 *                请求体恰为 `{run_id, memory_id, suppressed}`；响应按同一严格解析器
 *                解析，漂移同样 fail-closed（不能只信「HTTP 200」）。
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceHttpError, parseContextLens } from '../src/workspace-http.ts'
import { WorkspaceHost } from '../src/workspace-host.ts'
import type { WorkspaceSessionProvider } from '../src/workspace-host.ts'

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => { resolve() }))
  }
})

interface Recorded {
  readonly method: string
  readonly url: string
  readonly idempotencyKey: string | undefined
  readonly body: string
}

/** Serves one canned envelope for every request and records what arrived. */
async function serve(data: unknown): Promise<{ readonly baseUrl: string; readonly requests: Recorded[] }> {
  const requests: Recorded[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      requests.push({
        method: request.method ?? '',
        url: request.url ?? '',
        idempotencyKey: request.headers['idempotency-key'] as string | undefined,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ code: 0, message: 'ok', request_id: 'req-lens-1', data }))
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => { resolve() }))
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests }
}

function session(): WorkspaceSessionProvider {
  return {
    read: async () => ({ accessToken: 'test-account-token', identity: 'identity:test-account-token' }),
    clear: async () => false,
  }
}

function hostFor(baseUrl: string): WorkspaceHost {
  return new WorkspaceHost({ apiBaseUrl: baseUrl, session: session(), idempotencyKey: () => 'idem-lens-1' })
}

/** Copies a record without one key, so "missing field" cases stay honest. */
function without(record: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key))
}

const memoryEntry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  source: 'memory',
  title: '记忆：协作偏好（2026-09）',
  memory_id: 'mem-collab-pref',
  permission: 'allowed',
  permission_reason: null,
  selection_reason: '在有效期内，注入',
  injected: true,
  updated_at: '2026-09-05T00:00:00.000Z',
  ...overrides,
})

const safetyEntry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  source: 'safety',
  title: '安全与平台规则基线',
  memory_id: null,
  permission: 'allowed',
  permission_reason: null,
  selection_reason: '安全层始终注入',
  injected: true,
  updated_at: '2026-09-10T00:00:00.000Z',
  ...overrides,
})

const lens = (entries: readonly Record<string, unknown>[]): Record<string, unknown> => ({
  workspace_id: 'ws-1',
  revision: 7,
  generated_at: '2026-09-10T00:10:00.000Z',
  entries,
  permission_decisions: [
    { action: 'workspace.write', decision: 'allowed', code: 'OK', reason: '项目成员具备写入授权', policy_version: 'perm-policy@1', at: '2026-09-10T00:06:00.000Z' },
  ],
})

describe('§11.17 镜头条目的记忆身份解析是 fail-closed 的', () => {
  it('接受完整快照：记忆条目携带身份，其他层显式为 null', () => {
    const snapshot = parseContextLens(lens([safetyEntry(), memoryEntry()]))
    expect(snapshot.entries[0]?.memoryId).toBeNull()
    expect(snapshot.entries[1]?.memoryId).toBe('mem-collab-pref')
  })

  it('记忆条目缺 memory_id 或为空字符串 → 协议错误，而不是「没有身份」', () => {
    // 缺字段与空串由字段读取器拒绝，显式 null 由记忆身份规则拒绝：三者都是
    // SERVICE_PROTOCOL_ERROR，没有一条会退化成「这条没有身份，跳过」。
    expect(() => parseContextLens(lens([without(memoryEntry(), 'memory_id')]))).toThrow(/memory_id/u)
    expect(() => parseContextLens(lens([memoryEntry({ memory_id: '' })]))).toThrow(/memory_id/u)
    expect(() => parseContextLens(lens([memoryEntry({ memory_id: null })]))).toThrow(/memory identity/u)
    let failure: unknown
    try {
      parseContextLens(lens([without(memoryEntry(), 'memory_id')]))
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(WorkspaceHttpError)
    expect(failure).toMatchObject({ code: 'SERVICE_PROTOCOL_ERROR' })
  })

  it('非记忆层携带 memory_id → 协议漂移拒绝', () => {
    expect(() => parseContextLens(lens([safetyEntry({ memory_id: 'mem-collab-pref' })]))).toThrow(/must not carry a memory identity/u)
  })

  it('memory_id 类型错误 → 拒绝，不用空串或哨兵顶替', () => {
    expect(() => parseContextLens(lens([memoryEntry({ memory_id: 7 })]))).toThrow(/memory_id/u)
    expect(() => parseContextLens(lens([memoryEntry({ memory_id: false })]))).toThrow(/memory_id/u)
  })
})

describe('§11.17 Host 的运行作用域与抑制请求', () => {
  it('contextLens 只在给定运行时携带 run_id，基线读取不得凭空加上作用域', async () => {
    const { baseUrl, requests } = await serve(lens([memoryEntry()]))
    const host = hostFor(baseUrl)

    expect((await host.contextLens('ws-1')).status).toBe('ready')
    expect((await host.contextLens('ws-1', 'run-seed-1')).status).toBe('ready')
    expect(requests.map(request => request.url)).toEqual([
      '/v1/workspaces/ws-1:context-lens',
      '/v1/workspaces/ws-1:context-lens?run_id=run-seed-1',
    ])
  })

  it('抑制请求走同一工作空间的抑制端点、带幂等键，并按同一严格解析器解析返回快照', async () => {
    const { baseUrl, requests } = await serve(lens([memoryEntry({
      permission: 'suppressed',
      permission_reason: '用户已在本运行中关闭该记忆的影响',
      selection_reason: '用户在本运行中抑制该记忆，不进入注入评估',
      injected: false,
    })]))
    const result = await hostFor(baseUrl).suppressContextLensMemory('ws-1', 'run-seed-1', 'mem-collab-pref', true)

    expect(result.status).toBe('ready')
    expect(result.status === 'ready' ? result.value.entries[0]?.permission : undefined).toBe('suppressed')
    const request = requests[0]
    expect(request?.method).toBe('POST')
    expect(request?.url).toBe('/v1/workspaces/ws-1:context-lens/memory-suppression')
    expect(request?.idempotencyKey).toBe('idem-lens-1')
    expect(JSON.parse(request?.body ?? '{}')).toEqual({ run_id: 'run-seed-1', memory_id: 'mem-collab-pref', suppressed: true })
  })

  it('抑制响应缺记忆身份时 fail-closed，不返回半份快照', async () => {
    const { baseUrl } = await serve(lens([without(memoryEntry(), 'memory_id')]))
    const result = await hostFor(baseUrl).suppressContextLensMemory('ws-1', 'run-seed-1', 'mem-collab-pref', false)
    expect(result).toMatchObject({ status: 'failed', code: 'SERVICE_PROTOCOL_ERROR' })
    expect('value' in result).toBe(false)
  })
})
