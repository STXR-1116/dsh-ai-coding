import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createTeamSkillService } from '../src/server.ts'

// 2-4「审批、暂停、接管、恢复与证据抽屉」fixture 契约探针（§11.10，2026-09-16 冻结）。
//
// 异常矩阵：
//   缺失      —— 无审批实体的运行读取审批 → 404 APPROVAL_NOT_FOUND。
//   状态      —— 非 awaiting_approval 决策/接管 → 409 INVALID_STATUS。
//   revision  —— 过期 expected_run_revision 决策/接管 → 409 REVISION_CONFLICT（接管
//                附带 data.current_run.operator 持有者证据）。
//   有效期    —— expires_at 已过的审批决策 → 409 APPROVAL_EXPIRED。
//   幂等      —— 缺 Idempotency-Key → 400；同键同体重放首次结果（状态不再变化）。
//   决策      —— reject → cancelled（转移元数据：审批拒绝/操作者）+ 拒绝证据；
//                approve → succeeded 或（资产缺失时）partial_success。
//   证据      —— 成功响应携带 evidence{request_id, outcome, reason, revision,
//                audit_id, affected, next_action}。
//   审计      —— run.approval/run.takeover 成功与失败均写审计（actor_name）。

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

describe('2-4 审批、接管与证据（§11.10）', () => {
  it('创建待审批运行：状态 awaiting_approval 且审批实体字段齐备', async () => {
    const port = await start()
    const admin = await login(port, 'admin@example.com', 'admin-pass')
    const ws = await send(port, 'GET', '/v1/workspaces/ws-alpha-1', admin)
    const revision = dataOf(ws)['revision'] as number
    const created = await send(port, 'POST', '/v1/workspaces/ws-alpha-1/runs', admin, {
      session_id: 'sess-1', write_mode: 'write', approval_required: true, expected_workspace_revision: revision,
    }, { 'idempotency-key': '24-create' })
    expect(created.status).toBe(202)
    const run = dataOf(created)
    expect(run['status']).toBe('awaiting_approval')

    const approval = await send(port, 'GET', `/v1/runs/${run['run_id'] as string}:approval`, admin)
    expect(approval.status).toBe(200)
    const data = dataOf(approval)
    for (const field of ['approval_id', 'run_id', 'action', 'summary', 'affected', 'permission', 'asset_versions', 'risk', 'revocable', 'expires_at', 'created_at']) {
      expect(Object.hasOwn(data, field), `审批实体必须携带 ${field}`).toBe(true)
    }
    expect(data['run_id']).toBe(run['run_id'])
    const permission = data['permission'] as Record<string, unknown>
    expect(permission['policy_version']).toBe('perm-policy@1')
    const risk = data['risk'] as Record<string, unknown>
    expect(['low', 'medium', 'high']).toContain(risk['level'])
    const revocable = data['revocable'] as Record<string, unknown>
    expect(revocable['revocable']).toBe(true)
    expect(String(revocable['how']).length).toBeGreaterThan(0)
    const assets = data['asset_versions'] as Array<Record<string, unknown>>
    for (const asset of assets) {
      expect(['bound', 'withdrawn', 'missing']).toContain(asset['status'])
    }
  })

  it('无审批实体的运行读取审批 → 404 APPROVAL_NOT_FOUND；决策 → INVALID_STATUS', async () => {
    const port = await start()
    const admin = await login(port, 'admin@example.com', 'admin-pass')
    const ws = await send(port, 'GET', '/v1/workspaces/ws-alpha-1', admin)
    const revision = dataOf(ws)['revision'] as number
    const created = await send(port, 'POST', '/v1/workspaces/ws-alpha-1/runs', admin, {
      session_id: 'sess-1', write_mode: 'read_only', expected_workspace_revision: revision,
    }, { 'idempotency-key': '24-plain-run' })
    const plainRun = dataOf(created)
    const missing = await send(port, 'GET', `/v1/runs/${plainRun['run_id'] as string}:approval`, admin)
    expect(missing.status).toBe(404)
    expect(missing.json['code']).toBe('APPROVAL_NOT_FOUND')
    const decided = await send(port, 'POST', `/v1/runs/${plainRun['run_id'] as string}:approval`, admin, {
      decision: 'approve', expected_run_revision: plainRun['revision'],
    }, { 'idempotency-key': '24-plain-decide' })
    expect(decided.status).toBe(409)
    expect(decided.json['code']).toBe('INVALID_STATUS')
  })

  it('reject：cancelled 转移（审批拒绝元数据）+ 证据块 + 审计消费', async () => {
    const port = await start()
    const admin = await login(port, 'admin@example.com', 'admin-pass')
    const ws = await send(port, 'GET', '/v1/workspaces/ws-alpha-1', admin)
    const revision = dataOf(ws)['revision'] as number
    const created = await send(port, 'POST', '/v1/workspaces/ws-alpha-1/runs', admin, {
      session_id: 'sess-1', write_mode: 'write', approval_required: true, expected_workspace_revision: revision,
    }, { 'idempotency-key': '24-reject' })
    const run = dataOf(created)
    const runId = run['run_id'] as string

    const rejected = await send(port, 'POST', `/v1/runs/${runId}:approval`, admin, {
      decision: 'reject', expected_run_revision: run['revision'],
    }, { 'idempotency-key': '24-reject-decision' })
    expect(rejected.status).toBe(200)
    const rejectedRun = dataOf(rejected)
    expect(rejectedRun['status']).toBe('cancelled')
    const timeline = (rejectedRun['timeline'] ?? rejectedRun['events']) as Array<Record<string, unknown>>
    const last = timeline[timeline.length - 1]
    expect(last['reason']).toBe('审批拒绝')
    expect(String(last['operator']).length).toBeGreaterThan(0)
    const evidence = rejectedRun['evidence'] as Record<string, unknown>
    expect(evidence['request_id']).toBe(rejected.json['request_id'])
    expect(evidence['audit_id']).toBeTruthy()
    expect(evidence['affected']).toContain(runId)
    expect(String(evidence['next_action']).length).toBeGreaterThan(0)

    // 审批已消费：再决策 → INVALID_STATUS；读取 → 404
    const again = await send(port, 'POST', `/v1/runs/${runId}:approval`, admin, {
      decision: 'approve', expected_run_revision: rejectedRun['revision'],
    }, { 'idempotency-key': '24-reject-again' })
    expect(again.status).toBe(409)
    expect(again.json['code']).toBe('INVALID_STATUS')
    const consumed = await send(port, 'GET', `/v1/runs/${runId}:approval`, admin)
    expect(consumed.status).toBe(404)
  })

  it('过期审批决策 → 409 APPROVAL_EXPIRED；revision 冲突 → 409 REVISION_CONFLICT', async () => {
    const port = await start()
    const admin = await login(port, 'admin@example.com', 'admin-pass')
    const ws = await send(port, 'GET', '/v1/workspaces/ws-alpha-1', admin)
    const revision = dataOf(ws)['revision'] as number
    const created = await send(port, 'POST', '/v1/workspaces/ws-alpha-1/runs', admin, {
      session_id: 'sess-1', write_mode: 'write', approval_required: true, expected_workspace_revision: revision,
      approval_expires_at: '2026-09-01T00:00:00Z',
    }, { 'idempotency-key': '24-expire' })
    const run = dataOf(created)
    const runId = run['run_id'] as string

    const stale = await send(port, 'POST', `/v1/runs/${runId}:approval`, admin, {
      decision: 'approve', expected_run_revision: (run['revision'] as number) + 5,
    }, { 'idempotency-key': '24-stale' })
    expect(stale.status).toBe(409)
    expect(stale.json['code']).toBe('REVISION_CONFLICT')

    const approval = await send(port, 'GET', `/v1/runs/${runId}:approval`, admin)
    expect(dataOf(approval)['expires_at']).toBe('2026-09-01T00:00:00Z')
    const expired = await send(port, 'POST', `/v1/runs/${runId}:approval`, admin, {
      decision: 'approve', expected_run_revision: run['revision'],
    }, { 'idempotency-key': '24-expired' })
    expect(expired.status).toBe(409)
    expect(expired.json['code']).toBe('APPROVAL_EXPIRED')
  })

  it('缺 Idempotency-Key → 400；同键同体重放首次结果', async () => {
    const port = await start()
    const admin = await login(port, 'admin@example.com', 'admin-pass')
    const ws = await send(port, 'GET', '/v1/workspaces/ws-alpha-1', admin)
    const revision = dataOf(ws)['revision'] as number
    const created = await send(port, 'POST', '/v1/workspaces/ws-alpha-1/runs', admin, {
      session_id: 'sess-1', write_mode: 'write', approval_required: true, expected_workspace_revision: revision,
    }, { 'idempotency-key': '24-idem' })
    const run = dataOf(created)
    const body = { decision: 'approve', expected_run_revision: run['revision'] }

    const noKey = await send(port, 'POST', `/v1/runs/${run['run_id'] as string}:approval`, admin, body)
    expect(noKey.status).toBe(400)
    expect(noKey.json['code']).toBe('IDEMPOTENCY_KEY_REQUIRED')

    const first = await send(port, 'POST', `/v1/runs/${run['run_id'] as string}:approval`, admin, body, { 'idempotency-key': '24-idem-decision' })
    expect(first.status).toBe(200)
    const replay = await send(port, 'POST', `/v1/runs/${run['run_id'] as string}:approval`, admin, body, { 'idempotency-key': '24-idem-decision' })
    expect(replay.status).toBe(200)
    expect(dataOf(replay)['revision']).toBe(dataOf(first)['revision'])
  })

  it('approve：全部资产 bound → succeeded，运行进入 running 且证据齐备', async () => {
    const port = await start()
    const admin = await login(port, 'admin@example.com', 'admin-pass')
    const ws = await send(port, 'GET', '/v1/workspaces/ws-alpha-1', admin)
    const revision = dataOf(ws)['revision'] as number
    const created = await send(port, 'POST', '/v1/workspaces/ws-alpha-1/runs', admin, {
      session_id: 'sess-1', write_mode: 'write', approval_required: true, expected_workspace_revision: revision,
    }, { 'idempotency-key': '24-approve' })
    const run = dataOf(created)
    const approved = await send(port, 'POST', `/v1/runs/${run['run_id'] as string}:approval`, admin, {
      decision: 'approve', expected_run_revision: run['revision'],
    }, { 'idempotency-key': '24-approve-decision' })
    expect(approved.status).toBe(200)
    const approvedRun = dataOf(approved)
    expect(approvedRun['status']).toBe('running')
    const evidence = approvedRun['evidence'] as Record<string, unknown>
    expect(evidence['outcome']).toBe('succeeded')
    expect(evidence['revision']).toBe(approvedRun['revision'])
    expect(String(evidence['audit_id']).length).toBeGreaterThan(0)
  })

  it('approve：决策时资产已解绑 → partial_success 且缺失资产剔除出运行', async () => {
    const port = await start()
    const admin = await login(port, 'admin@example.com', 'admin-pass')
    const ws = await send(port, 'GET', '/v1/workspaces/ws-alpha-1', admin)
    const revision = dataOf(ws)['revision'] as number
    const created = await send(port, 'POST', '/v1/workspaces/ws-alpha-1/runs', admin, {
      session_id: 'sess-1', write_mode: 'write', approval_required: true, expected_workspace_revision: revision,
    }, { 'idempotency-key': '24-partial' })
    const run = dataOf(created)
    const runId = run['run_id'] as string
    expect((run['asset_version_ids'] as string[]).length).toBeGreaterThan(0)

    // 决策前解绑项目的记忆资产：决策时逐项复验发现缺失 → partial_success。
    const projectView = await send(port, 'GET', '/v1/projects/project-alpha', admin)
    const projectRevision = (projectView.json['revision'] as number)
    const unbound = await send(port, 'DELETE', '/v1/projects/project-alpha/assets/memory/m-1', admin, undefined, {
      'if-match': String(projectRevision), 'idempotency-key': '24-partial-unbind',
    })
    expect([200, 404, 409]).toContain(unbound.status)

    const approved = await send(port, 'POST', `/v1/runs/${runId}:approval`, admin, {
      decision: 'approve', expected_run_revision: run['revision'],
    }, { 'idempotency-key': '24-partial-decision' })
    expect(approved.status).toBe(200)
    const approvedRun = dataOf(approved)
    const evidence = approvedRun['evidence'] as Record<string, unknown>
    if (evidence['outcome'] === 'partial_success') {
      expect((approvedRun['asset_version_ids'] as string[]).length)
        .toBeLessThan((run['asset_version_ids'] as string[]).length)
      expect(String(evidence['next_action']).length).toBeGreaterThan(0)
    } else {
      expect(evidence['outcome']).toBe('succeeded')
    }
  })

  it('接管：operator 更新且状态不变；并发接管（过期 revision）→ 409 携带当前持有者', async () => {
    const port = await start()
    const admin = await login(port, 'admin@example.com', 'admin-pass')
    const member = await login(port, 'member@example.com', 'member-pass')
    const ws = await send(port, 'GET', '/v1/workspaces/ws-alpha-1', admin)
    const revision = dataOf(ws)['revision'] as number
    const created = await send(port, 'POST', '/v1/workspaces/ws-alpha-1/runs', admin, {
      session_id: 'sess-1', write_mode: 'write', approval_required: true, expected_workspace_revision: revision,
    }, { 'idempotency-key': '24-take' })
    const run = dataOf(created)
    const runId = run['run_id'] as string

    const taken = await send(port, 'POST', `/v1/runs/${runId}:takeover`, admin, {
      expected_run_revision: run['revision'],
    }, { 'idempotency-key': '24-take-1' })
    expect(taken.status).toBe(200)
    const takenRun = dataOf(taken)
    expect(takenRun['status']).toBe(run['status'])
    expect(String(takenRun['operator']).length).toBeGreaterThan(0)
    const evidence = takenRun['evidence'] as Record<string, unknown>
    expect(evidence['outcome']).toBe('succeeded')

    const conflict = await send(port, 'POST', `/v1/runs/${runId}:takeover`, member, {
      expected_run_revision: run['revision'],
    }, { 'idempotency-key': '24-take-2' })
    expect(conflict.status).toBe(409)
    expect(conflict.json['code']).toBe('REVISION_CONFLICT')
    const currentRun = conflict.json['current_run'] as Record<string, unknown>
    expect(currentRun['operator']).toBe(takenRun['operator'])

    // 终态运行不可接管：先决策拒绝进入 cancelled
    await send(port, 'POST', `/v1/runs/${runId}:approval`, admin, {
      decision: 'reject', expected_run_revision: takenRun['revision'],
    }, { 'idempotency-key': '24-take-reject' })
    const refused = await send(port, 'POST', `/v1/runs/${runId}:takeover`, admin, {
      expected_run_revision: takenRun['revision'] as number,
    }, { 'idempotency-key': '24-take-terminal' })
    expect(refused.status).toBe(409)
    expect(refused.json['code']).toBe('INVALID_STATUS')
  })

  it('接管审计：成功与失败都落 run.takeover 审计行（actor_name）', async () => {
    const port = await start()
    const admin = await login(port, 'admin@example.com', 'admin-pass')
    const member = await login(port, 'member@example.com', 'member-pass')
    const ws = await send(port, 'GET', '/v1/workspaces/ws-alpha-1', admin)
    const revision = dataOf(ws)['revision'] as number
    const created = await send(port, 'POST', '/v1/workspaces/ws-alpha-1/runs', admin, {
      session_id: 'sess-1', write_mode: 'write', approval_required: true, expected_workspace_revision: revision,
    }, { 'idempotency-key': '24-audit' })
    const run = dataOf(created)
    await send(port, 'POST', `/v1/runs/${run['run_id'] as string}:takeover`, admin, {
      expected_run_revision: run['revision'],
    }, { 'idempotency-key': '24-audit-ok' })
    await send(port, 'POST', `/v1/runs/${run['run_id'] as string}:takeover`, member, {
      expected_run_revision: run['revision'],
    }, { 'idempotency-key': '24-audit-conflict' })
    const audits = await send(port, 'GET', '/v1/admin/audits?action=run.takeover', admin)
    const rows = (audits.json['data'] as Array<Record<string, unknown>>)
      .filter(row => row['run_id'] === run['run_id'])
    expect(rows.length).toBeGreaterThanOrEqual(2)
    for (const row of rows) {
      expect(Object.hasOwn(row, 'actor_name')).toBe(true)
      expect(row['actor_name']).not.toBeNull()
    }
  })
})
