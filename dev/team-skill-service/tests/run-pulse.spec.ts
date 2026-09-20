import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createTeamSkillService } from '../src/server.ts'

// 2-5「运行脉搏与时间旅行」fixture 契约探针（§11.11，2026-09-16 冻结）。
//
// 异常矩阵：
//   缺失      —— 无检查点运行读 :checkpoint → 404 CHECKPOINT_NOT_FOUND；指定
//                checkpoint_id 不存在 → 404 CHECKPOINT_NOT_FOUND。
//   排序      —— 脉搏条目按 at 升序、revision 次序稳定排序。
//   闭环词表  —— kind 闭集 status|approval|tool_call|test|checkpoint；status 携带
//                §11.7 全部转移元数据；test 携带 total/passed/failed。
//   只追加    —— 两次暂停产生两个 checkpoint 条目（id 不同）；恢复只消费最新，
//                历史检查点（含已消费标记）继续可读。
//   无副作用  —— 脉搏与检查点历史读取不改变运行状态/revision。
//   审批      —— 拒绝决策落 approval 条目（decision=reject + operator）。

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
    headers: apiHeaders(token, extra),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, json: (await response.json()) as Record<string, unknown> }
}

function dataOf(result: { json: Record<string, unknown> }): Record<string, unknown> {
  return result.json['data'] as Record<string, unknown>
}

async function waitRunning(port: number, token: string, runId: string): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    const run = dataOf(await send(port, 'GET', `/v1/runs/${runId}`, token))
    if (run['status'] === 'running') return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('run 未进入 running')
}

describe('2-5 运行脉搏与检查点历史（§11.11）', () => {
  it('种子运行脉搏：status 条目带 §11.7 元数据，test 条目带 total/passed/failed，按 at 升序', async () => {
    const port = await start()
    const admin = await login(port, 'admin@example.com', 'admin-pass')
    const pulse = await send(port, 'GET', '/v1/runs/run-seed-1:pulse', admin)
    expect(pulse.status).toBe(200)
    const items = (dataOf(pulse)['items'] ?? []) as Array<Record<string, unknown>>
    expect(items.length).toBeGreaterThan(0)
    for (const entry of items) {
      expect(['status', 'approval', 'tool_call', 'test', 'checkpoint']).toContain(entry['kind'])
      expect(Object.hasOwn(entry, 'at')).toBe(true)
      expect(Object.hasOwn(entry, 'summary')).toBe(true)
    }
    const statuses = items.filter(entry => entry['kind'] === 'status')
    expect(statuses.length).toBeGreaterThanOrEqual(3)
    for (const entry of statuses) {
      for (const field of ['status', 'reason', 'operator', 'policy_version']) {
        expect(Object.hasOwn(entry, field), `status 条目必须携带 ${field}`).toBe(true)
      }
    }
    const tests = items.filter(entry => entry['kind'] === 'test')
    expect(tests.length).toBeGreaterThanOrEqual(1)
    const test = tests[0]
    expect(test['passed']).toBe(test['total'])
    const ats = items.map(entry => entry['at'] as string)
    expect([...ats].sort()).toEqual(ats)
    expect(dataOf(pulse)['run_id']).toBe('run-seed-1')
  })

  it('暂停追加 checkpoint 与 tool_call 条目；两次暂停两个检查点；恢复只消费最新、历史可读', async () => {
    const port = await start()
    const admin = await login(port, 'admin@example.com', 'admin-pass')
    const ws = await send(port, 'GET', '/v1/workspaces/ws-alpha-1', admin)
    const revision = dataOf(ws)['revision'] as number
    const created = await send(port, 'POST', '/v1/workspaces/ws-alpha-1/runs', admin, {
      session_id: 'sess-1', write_mode: 'write', expected_workspace_revision: revision,
    }, { 'idempotency-key': '25-pause' })
    const run = dataOf(created)
    const runId = run['run_id'] as string
    await waitRunning(port, admin, runId)

    const paused1 = await send(port, 'POST', `/v1/runs/${runId}:pause`, admin, {
      session_seq: 3,
      tool_results: [{ call_id: 'c1', tool: 'write_file', result: '已写入 README.md' }],
    }, { 'idempotency-key': '25-pause-1' })
    expect(paused1.status).toBe(200)
    const checkpoint1 = dataOf(await send(port, 'GET', `/v1/runs/${runId}:checkpoint`, admin))
    const cp1 = checkpoint1['checkpoint_id']
    expect(cp1).toBeTruthy()

    // 恢复（消费第一个检查点）→ 等待 running → 再次暂停产生第二个检查点
    await send(port, 'POST', `/v1/runs/${runId}:resume`, admin, { mode: 'continue' }, { 'idempotency-key': '25-resume-1' })
    await waitRunning(port, admin, runId)
    await send(port, 'POST', `/v1/runs/${runId}:pause`, admin, {
      session_seq: 5,
      tool_results: [{ call_id: 'c2', tool: 'terminal', result: '测试通过' }],
    }, { 'idempotency-key': '25-pause-2' })

    const pulse = dataOf(await send(port, 'GET', `/v1/runs/${runId}:pulse`, admin))
    const items = pulse['items'] as Array<Record<string, unknown>>
    const checkpoints = items.filter(entry => entry['kind'] === 'checkpoint')
    expect(checkpoints.length).toBe(2)
    expect(new Set(checkpoints.map(entry => entry['checkpoint_id'])).size).toBe(2)
    const toolCalls = items.filter(entry => entry['kind'] === 'tool_call')
    expect(toolCalls.map(entry => entry['call_id'])).toContain('c1')

    // 恢复只消费最新：最新 checkpoint consumed=true，第一个历史检查点仍可读
    await send(port, 'POST', `/v1/runs/${runId}:resume`, admin, { mode: 'continue' }, { 'idempotency-key': '25-resume-2' })
    const latest = dataOf(await send(port, 'GET', `/v1/runs/${runId}:checkpoint`, admin))
    expect(latest['checkpoint_id']).not.toBe(cp1)
    expect(latest['consumed']).toBe(true)
    const history = await send(port, 'GET', `/v1/runs/${runId}:checkpoint?checkpoint_id=${String(cp1)}`, admin)
    expect(history.status).toBe(200)
    expect(dataOf(history)['checkpoint_id']).toBe(cp1)
    expect(dataOf(history)['consumed']).toBe(true)
    // 读取脉搏与检查点历史不改变运行：revision 在前后两次读取间保持不变
    const before = dataOf(await send(port, 'GET', `/v1/runs/${runId}`, admin))
    await send(port, 'GET', `/v1/runs/${runId}:pulse`, admin)
    await send(port, 'GET', `/v1/runs/${runId}:checkpoint?checkpoint_id=${String(cp1)}`, admin)
    const after = dataOf(await send(port, 'GET', `/v1/runs/${runId}`, admin))
    expect(after['revision']).toBe(before['revision'])
  })

  it('审批拒绝落 approval 条目；无检查点/未知 checkpoint_id → 404 CHECKPOINT_NOT_FOUND', async () => {
    const port = await start()
    const admin = await login(port, 'admin@example.com', 'admin-pass')
    const ws = await send(port, 'GET', '/v1/workspaces/ws-alpha-1', admin)
    const revision = dataOf(ws)['revision'] as number
    const created = await send(port, 'POST', '/v1/workspaces/ws-alpha-1/runs', admin, {
      session_id: 'sess-1', write_mode: 'write', approval_required: true, expected_workspace_revision: revision,
    }, { 'idempotency-key': '25-approval' })
    const run = dataOf(created)
    const runId = run['run_id'] as string

    const noCheckpoint = await send(port, 'GET', `/v1/runs/${runId}:checkpoint`, admin)
    expect(noCheckpoint.status).toBe(404)
    expect(noCheckpoint.json['code']).toBe('CHECKPOINT_NOT_FOUND')
    const unknownId = await send(port, 'GET', `/v1/runs/${runId}:checkpoint?checkpoint_id=cp-not-exist`, admin)
    expect(unknownId.status).toBe(404)
    expect(unknownId.json['code']).toBe('CHECKPOINT_NOT_FOUND')

    await send(port, 'POST', `/v1/runs/${runId}:approval`, admin, {
      decision: 'reject', expected_run_revision: run['revision'],
    }, { 'idempotency-key': '25-reject' })
    const pulse = dataOf(await send(port, 'GET', `/v1/runs/${runId}:pulse`, admin))
    const approvals = (pulse['items'] as Array<Record<string, unknown>>).filter(entry => entry['kind'] === 'approval')
    expect(approvals.length).toBe(1)
    expect(approvals[0]['decision']).toBe('reject')
    expect(String(approvals[0]['operator']).length).toBeGreaterThan(0)

    const unknownRun = await send(port, 'GET', '/v1/runs/run-not-exist:pulse', admin)
    expect(unknownRun.status).toBe(404)
  })
})
