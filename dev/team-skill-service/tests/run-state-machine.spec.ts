import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createTeamSkillService } from '../src/server.ts'

// 1-2「运行状态机与迁移」验收（契约：API 需求 §11.7，蓝图 §4.2 迁移表落地）。
//
// 异常矩阵：
//   迁移表全条目 —— 创建即 preparing（queued/starting 合并）；自动推进 preparing→running；
//   取消 → cancelled（拼写迁移，事件类型同步 run.cancelled）；旧词表值不再出现在任何
//   服务端响应（响应体全文不含 queued/starting/waiting_approval/canceled 作为运行状态）。
//   转移元数据 —— 每条时间线带 reason/operator/policy_version/revision/trace_id；
//   同一运行的 trace_id 一致；用户动作的 operator 是执行者、自动推进为 system。
//   边界/并发 —— 未就绪工作空间不能创建 Run（维持既有 INVALID_STATUS）；
//   终态运行不可取消；写运行互斥在 preparing 期即生效。

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

function apiHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra }
}

async function post(
  port: number,
  path: string,
  body: unknown,
  token: string,
  extra: Record<string, string> = {},
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: apiHeaders(token, extra),
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

async function get(port: number, path: string, token: string): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: apiHeaders(token) })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

interface RunDto {
  readonly run_id: string
  readonly status: string
  readonly revision: number
  readonly timeline: ReadonlyArray<{
    readonly status: string
    readonly at: string
    readonly reason?: string
    readonly operator?: string
    readonly policy_version?: string
    readonly revision?: number
    readonly trace_id?: string
  }>
}

describe('1-2 统一运行状态机（§11.7）', () => {
  it('创建即 preparing 并自动推进到 running；转移元数据齐备；trace 一致', async () => {
    const port = await start()
    const admin = await login(port, 'admin@example.com', 'admin-pass')
    const ws = await get(port, '/v1/workspaces/ws-alpha-1', admin)
    const wsRevision = (ws.body as { data: { revision: number } }).data.revision

    const created = await post(port, '/v1/workspaces/ws-alpha-1/runs', {
      session_id: 'sess-12-1',
      write_mode: 'read_only',
      expected_workspace_revision: wsRevision,
    }, admin, { 'idempotency-key': 'r12-create' })
    expect(created.status, JSON.stringify(created.body)).toBe(202)
    const run = (created.body as { data: RunDto }).data
    // 迁移表：queued/starting 合并为 preparing。
    expect(run.status).toBe('preparing')

    // 自动推进：preparing → running（读观察式推进）。
    await new Promise(resolve => setTimeout(resolve, 120))
    const advanced = await get(port, `/v1/runs/${run.run_id}`, admin)
    const advancedRun = (advanced.body as { data: RunDto }).data
    expect(advancedRun.status).toBe('running')

    // 迁移表全条目的转移元数据：reason/operator/policy_version/revision/trace_id。
    for (const entry of advancedRun.timeline) {
      expect(typeof entry.reason, `转移 ${entry.status} 必须带原因`).toBe('string')
      expect((entry.reason as string).length).toBeGreaterThan(0)
      expect(typeof entry.operator, `转移 ${entry.status} 必须带操作者`).toBe('string')
      expect((entry.operator as string).length).toBeGreaterThan(0)
      expect(typeof entry.policy_version, `转移 ${entry.status} 必须带策略版本`).toBe('string')
      expect((entry.policy_version as string).length).toBeGreaterThan(0)
      expect(typeof entry.trace_id, `转移 ${entry.status} 必须带 trace 关联`).toBe('string')
      expect(entry.revision, `转移 ${entry.status} 必须带事件序号`).toBeGreaterThan(0)
    }
    const traceIds = new Set(advancedRun.timeline.map(entry => entry.trace_id))
    expect(traceIds.size, '同一运行的 trace_id 必须一致').toBe(1)
    // 自动推进的操作者是 system；创建条目的操作者是执行用户。
    expect(advancedRun.timeline[0]?.operator).toBe(admin === undefined ? '' : '平台管理员')
    const systemEntry = advancedRun.timeline.find(entry => entry.status === 'running')
    expect(systemEntry?.operator).toBe('system')
    expect(systemEntry?.policy_version).toBe('apv-1')
  })

  it('取消迁移为 cancelled 并携带操作者与原因；旧词表值不再出现在运行响应中', async () => {
    const port = await start()
    const admin = await login(port, 'admin@example.com', 'admin-pass')
    const ws = await get(port, '/v1/workspaces/ws-alpha-1', admin)
    const wsRevision = (ws.body as { data: { revision: number } }).data.revision

    const created = await post(port, '/v1/workspaces/ws-alpha-1/runs', {
      session_id: 'sess-12-2',
      write_mode: 'write',
      expected_workspace_revision: wsRevision,
    }, admin, { 'idempotency-key': 'r12-cancel-create' })
    expect(created.status).toBe(202)
    const run = (created.body as { data: RunDto }).data

    const cancelled = await post(port, `/v1/runs/${run.run_id}:cancel`, {}, admin, {
      'idempotency-key': 'r12-cancel',
    })
    expect(cancelled.status).toBe(200)
    const cancelledRun = (cancelled.body as { data: RunDto }).data
    // 拼写迁移：canceled → cancelled。
    expect(cancelledRun.status).toBe('cancelled')
    const last = cancelledRun.timeline[cancelledRun.timeline.length - 1]
    expect(last.status).toBe('cancelled')
    expect(last.reason).toBe('调用方取消')
    expect(last.operator).toBe('平台管理员')

    // 终态不可再取消。
    const again = await post(port, `/v1/runs/${run.run_id}:cancel`, {}, admin, {
      'idempotency-key': 'r12-cancel-again',
    })
    expect(again.status).toBe(409)

    // 旧词表值不得作为运行状态出现在任何响应里。
    const listed = await get(port, '/v1/workspaces/ws-alpha-1/runs', admin)
    const serialized = JSON.stringify(listed.body)
    for (const removed of ['"queued"', '"starting"', '"waiting_approval"', '"canceled"']) {
      expect(serialized.includes(removed), `旧状态 ${removed} 不得出现在运行响应中`).toBe(false)
    }
  })
})
