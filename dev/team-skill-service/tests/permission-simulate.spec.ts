import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createTeamSkillService } from '../src/server.ts'

// 4-3「账号与权限」权限模拟契约探针（§11.19，2026-09-17 冻结）。
//
// 异常矩阵：
//   角色边界  —— 成员携带 simulate_user_id → 403 FORBIDDEN。
//   缺失      —— 目标用户不存在/未激活 → 404 USER_NOT_FOUND。
//   评估身份  —— admin 模拟成员：project-alpha 读取 allowed 且
//                simulated_user.role=member；project-beta 拒绝
//                PROJECT_NOT_MEMBER（项目成员层）；admin.* 动作按成员角色
//                拒绝 ROLE_FORBIDDEN（组织角色层）。
//   审计      —— actor_name 为调用方（发起模拟者），denied 同样落审计。

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

async function simulate(
  port: number,
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/permission-check`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, json: (await response.json()) as Record<string, unknown> }
}

function dataOf(result: { json: Record<string, unknown> }): Record<string, unknown> {
  return result.json['data'] as Record<string, unknown>
}

// member@example.com 的用户 id 从用户列表解析（admin 视角）。
async function memberUserId(port: number, adminToken: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/admin/users?organization_id=org-alpha`, {
    headers: { authorization: `Bearer ${adminToken}` },
  })
  type UsersBody = { data?: { items?: Array<{ user_id: string; username: string }> } | Array<{ user_id: string; username: string }> }
  const body = (await response.json()) as UsersBody
  const rows: Array<{ user_id: string; username: string }> = Array.isArray(body.data) ? body.data : body.data?.items ?? []
  const member = rows.find(row => row.username === 'member@example.com' || row.username === 'member')
  expect(member).toBeTruthy()
  return member!.user_id
}

describe('4-3 权限模拟（§11.19）', () => {
  it('admin 以成员身份模拟：allowed 带模拟标识；未授权项目在项目成员层拒绝', async () => {
    const port = await start()
    const admin = await login(port, 'admin@example.com', 'admin-pass')
    const userId = await memberUserId(port, admin)

    const allowed = await simulate(port, admin, {
      simulate_user_id: userId, project_id: 'project-alpha', action: 'workspace.read',
    })
    expect(allowed.status).toBe(200)
    const data = dataOf(allowed)
    expect(data['decision']).toBe('allowed')
    expect(data['simulated']).toBe(true)
    const simulatedUser = data['simulated_user'] as Record<string, unknown>
    expect(simulatedUser['user_id']).toBe(userId)
    expect(simulatedUser['role']).toBe('member')
    expect(String(data['operator']).length).toBeGreaterThan(0)

    const denied = await simulate(port, admin, {
      simulate_user_id: userId, project_id: 'project-beta', action: 'workspace.read',
    })
    expect(denied.status).toBe(200)
    expect(dataOf(denied)['decision']).toBe('denied')
    expect(dataOf(denied)['code']).toBe('PROJECT_NOT_MEMBER')
  })

  it('组织角色层：成员被模拟执行治理动作 → ROLE_FORBIDDEN；非 staff 模拟 → 403', async () => {
    const port = await start()
    const admin = await login(port, 'admin@example.com', 'admin-pass')
    const member = await login(port, 'member@example.com', 'member-pass')
    const userId = await memberUserId(port, admin)

    const roleDenied = await simulate(port, admin, {
      simulate_user_id: userId, project_id: 'project-alpha', action: 'admin.skill.publish',
    })
    expect(roleDenied.status).toBe(200)
    expect(dataOf(roleDenied)['decision']).toBe('denied')
    expect(dataOf(roleDenied)['code']).toBe('ROLE_FORBIDDEN')

    const forbidden = await simulate(port, member, {
      simulate_user_id: userId, project_id: 'project-alpha', action: 'workspace.read',
    })
    expect(forbidden.status).toBe(403)
    expect(forbidden.json['code']).toBe('FORBIDDEN')
  })

  it('目标用户不存在 → 404；审计 actor_name 为调用方（发起模拟者）', async () => {
    const port = await start()
    const admin = await login(port, 'admin@example.com', 'admin-pass')
    const missing = await simulate(port, admin, {
      simulate_user_id: 'user-not-exist', project_id: 'project-alpha', action: 'workspace.read',
    })
    expect(missing.status).toBe(404)
    expect(missing.json['code']).toBe('USER_NOT_FOUND')

    const userId = await memberUserId(port, admin)
    await simulate(port, admin, {
      simulate_user_id: userId, project_id: 'project-beta', action: 'workspace.read',
    })
    const audits = await fetch(`http://127.0.0.1:${port}/v1/admin/audits?action=permission-check`, {
      headers: { authorization: `Bearer ${admin}` },
    })
    const rows = ((await audits.json()) as { data: Array<Record<string, unknown>> }).data
      .filter(row => row['result'] === 'failed')
    expect(rows.length).toBeGreaterThanOrEqual(1)
    expect(String(rows[0]['actor_name'])).toBe('平台管理员')
  })
})
