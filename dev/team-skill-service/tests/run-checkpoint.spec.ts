import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createTeamSkillService } from '../src/server.ts'

// 1-3「检查点与恢复」验收（契约：API 需求 §11.8，蓝图 §4.2）。
//
// 异常矩阵：
//   缺失     —— 暂停前读检查点 → 404 CHECKPOINT_NOT_FOUND；session_seq 缺失 → 422；
//   类型错误 —— tool_results 非数组 → 422；completed_steps 越界（引用计划时）→ 422；
//               resume mode 非法 → 422；
//   边界     —— preparing 运行不可暂停（409 INVALID_STATUS）；非 paused 不可恢复（409）；
//   并发     —— pause/resume 同键同体重放首次结果，不产生第二次状态变更或副作用；
//   审计     —— run.pause / run.resume 成功写审计行（字面 actor_name）。
// 完成判定：检查点承载六类状态（Agent 配置快照、资产版本、会话序号、工具结果、
// 工作区 revision、待审批动作）；恢复显式选择 continue | replay；恢复预览明确列出
// 将重用与将重新执行的步骤；断线重试（同键重放）不产生重复副作用。

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
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: apiHeaders(token, extra),
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

async function createConfirmedPlanAndRun(
  port: number,
  admin: string,
): Promise<{ readonly runId: string; readonly planId: string }> {
  const plan = await send(port, 'POST', '/v1/workspaces/ws-alpha-1/plans', admin, {
    goal: '检查点验收计划',
    steps: [{ title: '步骤一：梳理' }, { title: '步骤二：实现', depends_on: [0] }, { title: '步骤三：验证', depends_on: [1] }],
    agent_profile_version_id: 'apv-1',
  }, { 'idempotency-key': `cp-plan-${String(Date.now())}` })
  expect(plan.status).toBe(201)
  const planId = ((plan.body as { data: { plan_id: string; revision: number } }).data).plan_id
  const confirmed = await send(port, 'POST', `/v1/workspaces/ws-alpha-1/plans/${planId}:confirm`, admin, {}, {
    'idempotency-key': `cp-confirm-${planId}`,
  })
  expect(confirmed.status).toBe(200)

  const ws = await send(port, 'GET', '/v1/workspaces/ws-alpha-1', admin)
  const wsRevision = ((ws.body as { data: { revision: number } }).data).revision
  const run = await send(port, 'POST', '/v1/workspaces/ws-alpha-1/runs', admin, {
    session_id: 'sess-cp',
    write_mode: 'read_only',
    plan_id: planId,
    expected_workspace_revision: wsRevision,
  }, { 'idempotency-key': `cp-run-${planId}` })
  expect(run.status).toBe(202)
  const runId = ((run.body as { data: { run_id: string } }).data).run_id
  await new Promise(resolve => setTimeout(resolve, 120))
  const detail = await send(port, 'GET', `/v1/runs/${runId}`, admin)
  expect(((detail.body as { data: { status: string } }).data).status).toBe('running')
  return { runId, planId }
}

describe('1-3 检查点与恢复（§11.8）', () => {
  it('暂停落六类检查点；恢复预览列出将重用与将重新执行的步骤', async () => {
    const port = await start()
    const admin = await login(port, 'admin@example.com', 'admin-pass')
    const { runId } = await createConfirmedPlanAndRun(port, admin)

    // 暂停前：检查点不存在。
    const missing = await send(port, 'GET', `/v1/runs/${runId}/checkpoint`, admin)
    expect(missing.status).toBe(404)
    expect(missing.body.code).toBe('CHECKPOINT_NOT_FOUND')

    const paused = await send(port, 'POST', `/v1/runs/${runId}:pause`, admin, {
      session_seq: 7,
      tool_results: [{ call_id: 'call-1', tool: 'terminal', result: 'tests passed' }],
      completed_steps: [0],
    }, { 'idempotency-key': 'cp-pause-1' })
    expect(paused.status, JSON.stringify(paused.body)).toBe(200)
    expect(((paused.body as { data: { status: string } }).data).status).toBe('paused')

    const cp = await send(port, 'GET', `/v1/runs/${runId}/checkpoint`, admin)
    expect(cp.status).toBe(200)
    const data = (cp.body as { data: Record<string, unknown> }).data
    // 六类检查点状态。
    const config = data['agent_config'] as { agent_profile_version_id: string; execution_policy: Record<string, unknown> }
    expect(config.agent_profile_version_id).toBe('apv-1')
    expect(Object.keys(config.execution_policy).length).toBeGreaterThan(0)
    expect(Array.isArray(data['asset_version_ids'])).toBe(true)
    expect(data['session_seq']).toBe(7)
    expect(JSON.stringify(data['tool_results'])).toContain('tests passed')
    expect(typeof data['workspace_revision'], '工作区 revision 由服务端落账').toBe('number')
    // 恢复预览：将重用 = 已完成步骤 + 工具结果；将重新执行 = 剩余计划步骤。
    const preview = data['resume_preview'] as {
      readonly reuse: ReadonlyArray<Record<string, unknown>>
      readonly replay: ReadonlyArray<{ readonly title: string }>
    }
    const reuseTitles = preview.reuse.filter(item => typeof item['title'] === 'string').map(item => item['title'])
    expect(reuseTitles).toEqual(['步骤一：梳理'])
    expect(preview.replay.map(step => step.title)).toEqual(['步骤二：实现', '步骤三：验证'])
  })

  it('恢复显式选择 continue | replay；断线重试（同键重放）不产生重复副作用', async () => {
    const port = await start()
    const admin = await login(port, 'admin@example.com', 'admin-pass')
    const { runId } = await createConfirmedPlanAndRun(port, admin)
    await send(port, 'POST', `/v1/runs/${runId}:pause`, admin, {
      session_seq: 5,
      tool_results: [{ call_id: 'call-9', tool: 'terminal', result: 'ok' }],
      completed_steps: [0, 1],
    }, { 'idempotency-key': 'cp2-pause' })

    // resume mode 非法 → 422。
    const badMode = await send(port, 'POST', `/v1/runs/${runId}:resume`, admin, { mode: 'rewind' }, {
      'idempotency-key': 'cp2-bad-mode',
    })
    expect(badMode.status).toBe(422)

    // continue：保留工具结果与会话序号。
    const continued = await send(port, 'POST', `/v1/runs/${runId}:resume`, admin, { mode: 'continue' }, {
      'idempotency-key': 'cp2-resume-continue',
    })
    expect(continued.status, JSON.stringify(continued.body)).toBe(200)
    expect(((continued.body as { data: { status: string } }).data).status).toBe('preparing')

    // 断线重试：同键同体重放首次结果，不产生第二次状态变更。
    const retriedResume = await send(port, 'POST', `/v1/runs/${runId}:resume`, admin, { mode: 'continue' }, {
      'idempotency-key': 'cp2-resume-continue',
    })
    expect(retriedResume.status).toBe(200)
    expect(((retriedResume.body as { data: { status: string } }).data).status).toBe('preparing')
    // 重放不产生第二次状态变更：业务载荷逐字一致（request_id 每次响应各自生成）。
    expect((retriedResume.body as { data: unknown }).data).toEqual((continued.body as { data: unknown }).data)

    // 运行已不在 paused：再次 resume → 409（无重复副作用）。
    const again = await send(port, 'POST', `/v1/runs/${runId}:resume`, admin, { mode: 'continue' }, {
      'idempotency-key': 'cp2-resume-again',
    })
    expect(again.status).toBe(409)

    // continue 保留工具结果：检查点已消费但可查。
    const cp = await send(port, 'GET', `/v1/runs/${runId}/checkpoint`, admin)
    expect(cp.status).toBe(200)
    const data = (cp.body as { data: Record<string, unknown> }).data
    expect(data['consumed']).toBe(true)
    expect(JSON.stringify(data['tool_results'])).toContain('call-9')
    expect(data['session_seq']).toBe(5)

    // replay：清空工具结果并将 session_seq 归零。
    // 先观察自动推进（preparing → running），暂停只允许活跃状态。
    await new Promise(resolve => setTimeout(resolve, 120))
    const advanced2 = await send(port, 'GET', `/v1/runs/${runId}`, admin)
    expect(((advanced2.body as { data: { status: string } }).data).status).toBe('running')
    const pausedAgain = await send(port, 'POST', `/v1/runs/${runId}:pause`, admin, {
      session_seq: 9,
      tool_results: [{ call_id: 'call-10', tool: 'terminal', result: 'rerun' }],
    }, { 'idempotency-key': 'cp2-pause-2' })
    expect(pausedAgain.status).toBe(200)
    const replayed = await send(port, 'POST', `/v1/runs/${runId}:resume`, admin, { mode: 'replay' }, {
      'idempotency-key': 'cp2-resume-replay',
    })
    expect(replayed.status).toBe(200)
    const cp2 = await send(port, 'GET', `/v1/runs/${runId}/checkpoint`, admin)
    const data2 = (cp2.body as { data: Record<string, unknown> }).data
    expect(data2['session_seq']).toBe(0)
    expect(JSON.stringify(data2['tool_results'])).not.toContain('call-10')

    // 审计：run.pause / run.resume 成功行带字面 actor_name。
    const audits = await send(port, 'GET', '/v1/admin/audits?workspace_id=ws-alpha-1', admin)
    const rows = ((audits.body as { data: Array<Record<string, unknown>> }).data)
      .filter(row => String(row['action']).startsWith('run.pause') || String(row['action']).startsWith('run.resume'))
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect((row['actor_name'] as string).length).toBeGreaterThan(0)
    }
  })

  it('异常矩阵：preparing 不可暂停、resume 缺检查点 409、校验失败 422', async () => {
    const port = await start()
    const admin = await login(port, 'admin@example.com', 'admin-pass')
    const ws = await send(port, 'GET', '/v1/workspaces/ws-alpha-1', admin)
    const wsRevision = ((ws.body as { data: { revision: number } }).data).revision

    // preparing（尚未推进）不可暂停。
    const fresh = await send(port, 'POST', '/v1/workspaces/ws-alpha-1/runs', admin, {
      session_id: 'sess-cp-3',
      write_mode: 'read_only',
      expected_workspace_revision: wsRevision,
    }, { 'idempotency-key': 'cp3-create' })
    const freshId = ((fresh.body as { data: { run_id: string } }).data).run_id
    const pausePreparing = await send(port, 'POST', `/v1/runs/${freshId}:pause`, admin, {
      session_seq: 1,
    }, { 'idempotency-key': 'cp3-pause-preparing' })
    expect(pausePreparing.status).toBe(409)
    expect(pausePreparing.body.code).toBe('INVALID_STATUS')

    // resume 缺检查点 → 409。
    const resumeNoCp = await send(port, 'POST', `/v1/runs/${freshId}:resume`, admin, { mode: 'continue' }, {
      'idempotency-key': 'cp3-resume-no-cp',
    })
    expect(resumeNoCp.status).toBe(409)

    // session_seq 缺失 → 422。
    await new Promise(resolve => setTimeout(resolve, 120))
    await send(port, 'GET', `/v1/runs/${freshId}`, admin)
    const noSeq = await send(port, 'POST', `/v1/runs/${freshId}:pause`, admin, {}, {
      'idempotency-key': 'cp3-no-seq',
    })
    expect(noSeq.status).toBe(422)

    // tool_results 非数组 → 422。
    const badTools = await send(port, 'POST', `/v1/runs/${freshId}:pause`, admin, {
      session_seq: 1,
      tool_results: 'not-an-array',
    }, { 'idempotency-key': 'cp3-bad-tools' })
    expect(badTools.status).toBe(422)

    // completed_steps 越界（引用计划时）→ 422。
    const plan = await send(port, 'POST', '/v1/workspaces/ws-alpha-1/plans', admin, {
      goal: '越界校验计划',
      steps: [{ title: '唯一步骤' }],
      agent_profile_version_id: 'apv-1',
    }, { 'idempotency-key': 'cp3-plan' })
    const planId = ((plan.body as { data: { plan_id: string } }).data).plan_id
    await send(port, 'POST', `/v1/workspaces/ws-alpha-1/plans/${planId}:confirm`, admin, {}, {
      'idempotency-key': 'cp3-plan-confirm',
    })
    const run2 = await send(port, 'POST', '/v1/workspaces/ws-alpha-1/runs', admin, {
      session_id: 'sess-cp-4',
      write_mode: 'read_only',
      plan_id: planId,
      expected_workspace_revision: wsRevision,
    }, { 'idempotency-key': 'cp3-run2' })
    const run2Id = ((run2.body as { data: { run_id: string } }).data).run_id
    await new Promise(resolve => setTimeout(resolve, 120))
    await send(port, 'GET', `/v1/runs/${run2Id}`, admin)
    const oob = await send(port, 'POST', `/v1/runs/${run2Id}:pause`, admin, {
      session_seq: 1,
      completed_steps: [5],
    }, { 'idempotency-key': 'cp3-oob' })
    expect(oob.status).toBe(422)
  })
})
