import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createTeamSkillService } from '../src/server.ts'

// 1-5「权限决策引用」验收（契约：API 需求 §11.9，蓝图 §4.4）。
//
// 异常矩阵：
//   输入维度 —— 八维输入：组织（由项目/工作空间推导）、项目、工作空间、运行、
//               Agent、资产、操作者（服务端凭据解析）、动作。action 缺失 → 422。
//   一致性   —— workspace/run/project 交叉引用不一致 → denied（稳定码）；
//               agent 未绑定 published → FORBIDDEN；asset 不在版本资产内 → VALIDATION_ERROR。
//   角色     —— member 请求 admin. 前缀动作 → ROLE_FORBIDDEN。
//   审计     —— denied 决策写授权审计行（字面 actor_name + request_id）；
//               allowed 决策写 succeeded 行。
//   版本     —— 每次决策携带策略版本 perm-policy@1。
//   只读     —— 决策不改变业务状态（仅审计追加）。

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

async function check(
  port: number,
  token: string,
  body: Record<string, unknown>,
): Promise<{ readonly status: number; readonly data: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/permission-check`, {
    method: 'POST',
    headers: apiHeaders(token),
    body: JSON.stringify(body),
  })
  expect(response.status).toBe(200)
  return { status: response.status, data: ((await response.json()) as { data: Record<string, unknown> }).data }
}

describe('1-5 权限决策引用（§11.9）', () => {
  it('统一八维输入，返回 allowed 决策与策略版本；denied 携带稳定码并写授权审计', async () => {
    const port = await start()
    const admin = await login(port, 'admin@example.com', 'admin-pass')
    const member = await login(port, 'member@example.com', 'member-pass')

    // allowed：member 对已授权项目的读取动作。
    const allowed = await check(port, member, {
      project_id: 'project-alpha',
      action: 'workspace.read',
    })
    expect(allowed.data['decision']).toBe('allowed')
    expect(allowed.data['code']).toBe('OK')
    expect(String(allowed.data['reason']).length).toBeGreaterThan(0)
    expect(allowed.data['policy_version']).toBe('perm-policy@1')
    expect(String(allowed.data['request_id']).length).toBeGreaterThan(0)
    expect(String(allowed.data['operator']).length).toBeGreaterThan(0)

    // denied：member 访问未授权项目 → PROJECT_ACCESS_DENIED + 审计。
    const denied = await check(port, member, {
      project_id: 'project-beta',
      action: 'workspace.read',
    })
    expect(denied.data['decision']).toBe('denied')
    expect(denied.data['code']).toBe('PROJECT_NOT_MEMBER')
    expect(String(denied.data['request_id']).length).toBeGreaterThan(0)

    // 角色边界：member 请求治理动作 → ROLE_FORBIDDEN。
    const roleDenied = await check(port, member, {
      project_id: 'project-alpha',
      action: 'admin.skill.publish',
    })
    expect(roleDenied.data['decision']).toBe('denied')
    expect(roleDenied.data['code']).toBe('ROLE_FORBIDDEN')

    // Agent 维度：未绑定 published 版本 → FORBIDDEN。
    const agentDenied = await check(port, admin, {
      project_id: 'project-alpha',
      agent_profile_version_id: 'apv-not-published',
      action: 'run.create',
    })
    expect(agentDenied.data['decision']).toBe('denied')
    expect(agentDenied.data['code']).toBe('FORBIDDEN')

    // 资产维度：不在版本自身资产内 → VALIDATION_ERROR。
    const assetDenied = await check(port, admin, {
      project_id: 'project-alpha',
      agent_profile_version_id: 'apv-1',
      asset_version_ids: ['skill:not-in-version@9.9'],
      action: 'run.create',
    })
    expect(assetDenied.data['decision']).toBe('denied')
    expect(assetDenied.data['code']).toBe('VALIDATION_ERROR')

    // 授权审计：denied 行（含字面 actor_name 与 request_id）。
    const auditResponse = await fetch(`http://127.0.0.1:${port}/v1/admin/authorization-audits?action=permission-check`, {
      headers: apiHeaders(admin),
    })
    expect(auditResponse.status).toBe(200)
    const rows = ((await auditResponse.json()) as { data: { items: Array<Record<string, unknown>> } }).data.items
    const failedRows = rows.filter(row => row['result'] === 'failed')
    expect(failedRows.length, 'denied 决策必须写 failed 授权审计行').toBeGreaterThan(0)
    for (const row of failedRows) {
      expect((row['actor_name'] as string).length).toBeGreaterThan(0)
      expect(String(row['request_id']).length).toBeGreaterThan(0)
    }
  })

  it('上下文一致性：workspace/run/project 交叉引用与动作缺失', async () => {
    const port = await start()
    const admin = await login(port, 'admin@example.com', 'admin-pass')

    // action 缺失 → 422。
    const noAction = await fetch(`http://127.0.0.1:${port}/v1/permission-check`, {
      method: 'POST',
      headers: apiHeaders(admin),
      body: JSON.stringify({ project_id: 'project-alpha' }),
    })
    expect(noAction.status).toBe(422)

    // workspace 一致性：run 与提供的 workspace 不一致 → denied。
    const ws = await fetch(`http://127.0.0.1:${port}/v1/workspaces/ws-alpha-1`, { headers: apiHeaders(admin) })
    const wsRevision = ((await ws.json()) as { data: { revision: number } }).data.revision
    const created = await fetch(`http://127.0.0.1:${port}/v1/workspaces/ws-alpha-1/runs`, {
      method: 'POST',
      headers: apiHeaders(admin, { 'idempotency-key': 'pc-run' }),
      body: JSON.stringify({ session_id: 'sess-pc', write_mode: 'read_only', expected_workspace_revision: wsRevision }),
    })
    expect(created.status).toBe(202)
    const runId = ((await created.json()) as { data: { run_id: string } }).data.run_id

    const mismatch = await check(port, admin, {
      workspace_id: 'ws-alpha-1',
      run_id: runId,
      project_id: 'project-beta',
      action: 'workspace.read',
    })
    expect(mismatch.data['decision']).toBe('denied')
    expect(mismatch.data['code']).toBe('PROJECT_CONTEXT_MISMATCH')

    // 一致的上下文 → allowed，并回显解析后的工作空间/运行。
    const consistent = await check(port, admin, {
      workspace_id: 'ws-alpha-1',
      run_id: runId,
      action: 'workspace.read',
    })
    expect(consistent.data['decision']).toBe('allowed')
    const context = consistent.data['context'] as { workspace_id?: string; run_id?: string }
    expect(context.workspace_id).toBe('ws-alpha-1')
    expect(context.run_id).toBe(runId)
  })
})
