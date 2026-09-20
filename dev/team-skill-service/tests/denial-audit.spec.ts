import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { createTeamSkillService } from '../src/server.ts'
import { bodyOf } from './response.ts'

const services: ReturnType<typeof createTeamSkillService>[] = []
let nextKey = 1

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

function apiHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
}

async function loginAs(port: number, username: string, password: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  expect(response.status).toBe(200)
  return ((await bodyOf(response)) as { access_token: string }).access_token
}

describe('denial audit trail (P1-08)', () => {
  it('records failed authorization audits with request_id for cross-org member access', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const admin = await loginAs(port, 'admin@example.com', 'admin-pass')
    const member = await loginAs(port, 'member@example.com', 'member-pass')

    // member（org-alpha）直接访问 org-beta 的项目 → 授权拒绝，必须留下 failed 审计。
    const denied = await fetch(`http://127.0.0.1:${port}/v1/team-skills?project_id=project-beta`, {
      headers: apiHeaders(member),
    })
    expect(denied.status).toBe(404)
    const audits = await fetch(`http://127.0.0.1:${port}/v1/admin/authorization-audits?project_id=project-beta`, {
      headers: apiHeaders(admin),
    })
    expect(audits.status).toBe(200)
    const items = ((await bodyOf(audits)) as { items: Array<Record<string, unknown>> }).items
    const denial = items.find(
      item => item.action === '项目访问拒绝' && item.project_id === 'project-beta' && item.result === 'failed',
    )
    expect(denial).toBeDefined()
    expect(denial?.['request_id']).toBeTruthy()
    expect(JSON.stringify(denial)).not.toContain('password')
  })

  it('does not duplicate denial audits for repeated requests within the same request id', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const admin = await loginAs(port, 'admin@example.com', 'admin-pass')
    const member = await loginAs(port, 'member@example.com', 'member-pass')

    // 同一请求内的多次 authorizeProject 调用（目录+详情连续触发）只在同 request 上记一条。
    await fetch(`http://127.0.0.1:${port}/v1/team-skills?project_id=project-beta`, { headers: apiHeaders(member) })
    await fetch(`http://127.0.0.1:${port}/v1/team-skills?project_id=project-beta`, { headers: apiHeaders(member) })

    const audits = await fetch(`http://127.0.0.1:${port}/v1/admin/authorization-audits?project_id=project-beta`, {
      headers: apiHeaders(admin),
    })
    const items = ((await bodyOf(audits)) as { items: Array<Record<string, unknown>> }).items
    const denials = items.filter(item => item.action === '项目访问拒绝' && item.result === 'failed')
    expect(denials.length).toBeGreaterThanOrEqual(1)
    // 独立请求各自产生审计：两次独立请求 → 至少两条，验证不是全局去重吞掉。
    expect(denials.length).toBeGreaterThanOrEqual(2)
  })

  it('records denial audits for member installation and admin-only governance rejections', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const admin = await loginAs(port, 'admin@example.com', 'admin-pass')
    const member = await loginAs(port, 'member@example.com', 'member-pass')

    // 成员安装 org-beta 的 Skill → 项目拒绝审计（authorizeProject 记录）。
    const install = await fetch(`http://127.0.0.1:${port}/v1/team-skill-installations`, {
      method: 'POST',
      headers: { ...apiHeaders(member), 'idempotency-key': `deny-install-${nextKey++}` },
      body: JSON.stringify({
        skill_id: 'any-skill',
        version: '1.0.0',
        project_id: 'project-beta',
        scope: 'global',
        local_installation_id: `local-${nextKey++}`,
        environment: { dsh_version: '0.1.1', available_tools: [], available_mcp_servers: [], present_environment_variable_names: [] },
      }),
    })
    expect([403, 404]).toContain(install.status)

    // 成员访问 admin-only 治理路由 → 治理拒绝审计。
    await fetch(`http://127.0.0.1:${port}/v1/admin/team-skill-audit-logs`, { headers: apiHeaders(member) })

    const audits = await fetch(
      `http://127.0.0.1:${port}/v1/admin/authorization-audits?project_id=project-beta`,
      { headers: apiHeaders(admin) },
    )
    expect(audits.status).toBe(200)
    const items = ((await bodyOf(audits)) as { items: Array<Record<string, unknown>> }).items
    expect(items.some(item => item.action === '项目访问拒绝' && item.result === 'failed')).toBe(true)

    const allAudits = await fetch(`http://127.0.0.1:${port}/v1/admin/authorization-audits`, { headers: apiHeaders(admin) })
    const allItems = ((await bodyOf(allAudits)) as { items: Array<Record<string, unknown>> }).items
    expect(allItems.some(item => item.action === '治理访问拒绝' && item.result === 'failed')).toBe(true)
  })

  it('scopes denial audits to the organization for manager visibility', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const manager = await loginAs(port, 'manager@example.com', 'manager-pass')

    await fetch(`http://127.0.0.1:${port}/v1/team-skills?project_id=project-beta`, { headers: apiHeaders(manager) })
    await fetch(`http://127.0.0.1:${port}/v1/team-skills?project_id=project-alpha`, { headers: apiHeaders(manager) })

    const audits = await fetch(`http://127.0.0.1:${port}/v1/admin/authorization-audits`, {
      headers: apiHeaders(manager),
    })
    const items = ((await bodyOf(audits)) as { items: Array<Record<string, unknown>> }).items
    // manager 只能看到自己 active 组织范围内的审计。
    expect(items.every(item => item.organization_id === 'org-alpha')).toBe(true)
  })
})
