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

/** Archive org-alpha through the admin governance route. */
async function archiveOrgAlpha(port: number, admin: string): Promise<void> {
  const detail = await fetch(`http://127.0.0.1:${port}/v1/admin/organizations/org-alpha`, { headers: apiHeaders(admin) })
  const org = (await bodyOf(detail)) as { revision: number }
  const archived = await fetch(`http://127.0.0.1:${port}/v1/admin/organizations/org-alpha`, {
    method: 'PATCH',
    headers: { ...apiHeaders(admin), 'if-match': String(org.revision), 'idempotency-key': `archive-${nextKey++}` },
    body: JSON.stringify({ status: 'archived' }),
  })
  expect(archived.status).toBe(200)
}

describe('archived organization visibility and authorization (P1-02)', () => {
  it('hides the archived organization and its active projects from manager aggregation and management reads', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const admin = await loginAs(port, 'admin@example.com', 'admin-pass')
    const manager = await loginAs(port, 'manager@example.com', 'manager-pass')

    await archiveOrgAlpha(port, admin)

    // 聚合读取：archived 组织与其 active 项目不再出现在 summary。
    const summary = await fetch(`http://127.0.0.1:${port}/v1/me/access-summary`, { headers: apiHeaders(manager) })
    expect(summary.status).toBe(200)
    const summaryBody = (await bodyOf(summary)) as {
      organizations: Array<{ organization_id: string }>
      projects: Array<{ project_id: string; organization_id: string }>
      management_organization_ids: string[]
      management_project_ids: string[]
    }
    expect(summaryBody.organizations.map(item => item.organization_id)).not.toContain('org-alpha')
    expect(summaryBody.projects.map(item => item.organization_id)).not.toContain('org-alpha')
    expect(summaryBody.management_organization_ids).not.toContain('org-alpha')
    expect(summaryBody.management_project_ids).not.toContain('project-alpha')

    // 管理读取：项目列表与详情对 archived 组织统一拒绝。
    const list = await fetch(`http://127.0.0.1:${port}/v1/admin/projects`, { headers: apiHeaders(manager) })
    expect(list.status).toBe(200)
    expect(((await bodyOf(list)) as { items: Array<{ organization_id: string }> }).items.map(i => i.organization_id)).not.toContain(
      'org-alpha',
    )
    const detail = await fetch(`http://127.0.0.1:${port}/v1/admin/projects/project-alpha`, { headers: apiHeaders(manager) })
    expect(detail.status).toBe(404)
  })

  it('rejects member catalog and project reads after the organization is archived', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const admin = await loginAs(port, 'admin@example.com', 'admin-pass')
    const member = await loginAs(port, 'member@example.com', 'member-pass')

    await archiveOrgAlpha(port, admin)

    const orgs = await fetch(`http://127.0.0.1:${port}/v1/me/organizations`, { headers: apiHeaders(member) })
    expect(orgs.status).toBe(200)
    expect(((await bodyOf(orgs)) as { items: Array<{ organization_id: string }> }).items.map(i => i.organization_id)).not.toContain(
      'org-alpha',
    )

    const projects = await fetch(`http://127.0.0.1:${port}/v1/me/projects`, { headers: apiHeaders(member) })
    expect(projects.status).toBe(200)
    expect(((await bodyOf(projects)) as { items: Array<{ project_id: string }> }).items.map(i => i.project_id)).not.toContain(
      'project-alpha',
    )

    const catalog = await fetch(`http://127.0.0.1:${port}/v1/team-skills?project_id=project-alpha`, { headers: apiHeaders(member) })
    expect(catalog.status).toBe(404)
  })

  it('keeps admin governance reads able to see and restore the archived organization', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const admin = await loginAs(port, 'admin@example.com', 'admin-pass')

    await archiveOrgAlpha(port, admin)

    // 管理路由仍能看到 archived 组织（供恢复）。
    const adminOrgs = await fetch(`http://127.0.0.1:${port}/v1/admin/organizations`, { headers: apiHeaders(admin) })
    expect(adminOrgs.status).toBe(200)
    expect(
      ((await bodyOf(adminOrgs)) as { items: Array<{ organization_id: string; status: string }> }).items.some(
        item => item.organization_id === 'org-alpha' && item.status === 'archived',
      ),
    ).toBe(true)

    // 恢复组织：成员关系与项目按当前 active 成员关系重新可见。
    const detail = await fetch(`http://127.0.0.1:${port}/v1/admin/organizations/org-alpha`, { headers: apiHeaders(admin) })
    const org = (await bodyOf(detail)) as { revision: number }
    const restored = await fetch(`http://127.0.0.1:${port}/v1/admin/organizations/org-alpha`, {
      method: 'PATCH',
      headers: { ...apiHeaders(admin), 'if-match': String(org.revision), 'idempotency-key': `restore-${nextKey++}` },
      body: JSON.stringify({ status: 'active' }),
    })
    expect(restored.status).toBe(200)

    const member = await loginAs(port, 'member@example.com', 'member-pass')
    const catalog = await fetch(`http://127.0.0.1:${port}/v1/team-skills?project_id=project-alpha`, { headers: apiHeaders(member) })
    expect(catalog.status).toBe(200)
    expect(((await bodyOf(catalog)) as { items: Array<{ skill_id: string }> }).items.map(i => i.skill_id)).toContain('code-review')
  })
})

describe('manager scope cannot cross organization boundaries (P1-03)', () => {
  it('prevents a manager from renaming or suspending a member shared with another organization', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const admin = await loginAs(port, 'admin@example.com', 'admin-pass')
    const manager = await loginAs(port, 'manager@example.com', 'manager-pass')

    // 构造跨组织 member：属于 org-alpha（manager 的组织）和 org-beta（非 manager 组织）。
    const created = await fetch(`http://127.0.0.1:${port}/v1/admin/users`, {
      method: 'POST',
      headers: { ...apiHeaders(admin), 'idempotency-key': `cross-${nextKey++}` },
      body: JSON.stringify({
        username: `cross-member-${nextKey}@example.com`,
        display_name: '跨组织成员',
        organization_ids: ['org-alpha', 'org-beta'],
        global_role: 'member',
        project_ids: [],
      }),
    })
    expect(created.status).toBe(201)
    const member = (await bodyOf(created)) as { user: { user_id: string; display_name: string; revision: number; status: string } }

    // manager 改名：影响该账号的全局显示名 → 必须拒绝。
    const renamed = await fetch(`http://127.0.0.1:${port}/v1/admin/users/${member.user.user_id}`, {
      method: 'PATCH',
      headers: { ...apiHeaders(manager), 'if-match': String(member.user.revision), 'idempotency-key': `rename-${nextKey++}` },
      body: JSON.stringify({ display_name: '经理改的名字' }),
    })
    expect(renamed.status).toBe(403)

    // manager 停用：影响账号全局状态与其他组织 → 必须拒绝。
    const suspended = await fetch(`http://127.0.0.1:${port}/v1/admin/users/${member.user.user_id}`, {
      method: 'PATCH',
      headers: { ...apiHeaders(manager), 'if-match': String(member.user.revision), 'idempotency-key': `suspend-${nextKey++}` },
      body: JSON.stringify({ status: 'suspended' }),
    })
    expect(suspended.status).toBe(403)

    const audits = await fetch(`http://127.0.0.1:${port}/v1/admin/authorization-audits?organization_id=org-alpha`, {
      headers: apiHeaders(admin),
    })
    expect(audits.status).toBe(200)
    const denial = ((await bodyOf(audits)) as { items: Array<Record<string, unknown>> }).items.find(
      item => item.action === '账号更新拒绝' && item.target_user_id === member.user.user_id && item.result === 'failed',
    )
    expect(denial).toMatchObject({ error_code: 'FORBIDDEN', organization_id: 'org-alpha' })
    expect(denial?.request_id).toBeTruthy()

    // admin 不受限：全局改名成功。
    const adminRenamed = await fetch(`http://127.0.0.1:${port}/v1/admin/users/${member.user.user_id}`, {
      method: 'PATCH',
      headers: { ...apiHeaders(admin), 'if-match': String(member.user.revision), 'idempotency-key': `admin-rename-${nextKey++}` },
      body: JSON.stringify({ display_name: '管理员改的名' }),
    })
    expect(adminRenamed.status).toBe(200)
  })
})

describe('organization rename projects into project views (P1-04)', () => {
  it('reflects the new organization name in project list, detail and access summary in the same cycle', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const admin = await loginAs(port, 'admin@example.com', 'admin-pass')
    const manager = await loginAs(port, 'manager@example.com', 'manager-pass')

    const renamed = await fetch(`http://127.0.0.1:${port}/v1/admin/organizations/org-alpha`, {
      method: 'PATCH',
      headers: { ...apiHeaders(admin), 'if-match': '1', 'idempotency-key': `rename-org-${nextKey++}` },
      body: JSON.stringify({ name: '星河 AI 平台（已更名）' }),
    })
    expect(renamed.status).toBe(200)

    const list = await fetch(`http://127.0.0.1:${port}/v1/admin/projects`, { headers: apiHeaders(manager) })
    expect(list.status).toBe(200)
    const items = ((await bodyOf(list)) as { items: Array<{ organization_id: string; organization_name: string }> }).items
    expect(items.find(item => item.project_id === 'project-alpha')?.organization_name).toBe('星河 AI 平台（已更名）')

    const summary = await fetch(`http://127.0.0.1:${port}/v1/me/access-summary`, { headers: apiHeaders(manager) })
    expect(summary.status).toBe(200)
    const summaryBody = (await bodyOf(summary)) as { organizations: Array<{ organization_id: string; name: string }> }
    expect(summaryBody.organizations.find(item => item.organization_id === 'org-alpha')?.name).toBe('星河 AI 平台（已更名）')
  })
})
