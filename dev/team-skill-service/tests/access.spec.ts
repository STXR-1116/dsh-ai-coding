import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
/* oxlint-disable typescript/no-unsafe-assignment -- Response.json() is narrowed at assertion boundaries. */
import { createTeamSkillService } from '../src/server.ts'
import { bodyOf } from './response.ts'

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

async function loginAt(port: number, username: string, password: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  return ((await bodyOf(response)) as { access_token: string }).access_token
}

describe('account and authorization API', () => {
  it('creates a draft project and activates it through explicit lifecycle actions', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const login = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin@example.com', password: 'admin-pass' }),
    })
    const token = ((await bodyOf(login)) as { access_token: string }).access_token
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': 'project-create-draft' }
    const created = await fetch(`http://127.0.0.1:${port}/v1/admin/projects`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ organization_id: 'org-alpha', name: '项目生命周期回归', description: 'draft description' }),
    })
    expect(created.status).toBe(201)
    const draft = (await bodyOf(created)) as { project_id: string; status: string; revision: number }
    expect(draft).toMatchObject({ status: 'draft', revision: 1 })
    const activated = await fetch(`http://127.0.0.1:${port}/v1/admin/projects/${draft.project_id}:activate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'if-match': String(draft.revision), 'idempotency-key': 'project-activate-draft' },
      body: '{}',
    })
    expect(activated.status).toBe(200)
    expect(await bodyOf(activated)).toMatchObject({ project_id: draft.project_id, status: 'active', revision: 2 })
    const archived = await fetch(`http://127.0.0.1:${port}/v1/admin/projects/${draft.project_id}:archive`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'if-match': '2', 'idempotency-key': 'project-archive-draft' },
      body: '{}',
    })
    expect(archived.status).toBe(200)
    expect(await bodyOf(archived)).toMatchObject({ project_id: draft.project_id, status: 'archived', revision: 3 })
  })

  it('returns only active member projects and explicitly related authorized assets', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const login = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'member@example.com', password: 'member-pass' }),
    })
    const token = ((await bodyOf(login)) as { access_token: string }).access_token
    const headers = { authorization: `Bearer ${token}` }
    const projects = await fetch(`http://127.0.0.1:${port}/v1/me/projects`, { headers })
    expect(projects.status).toBe(200)
    expect(await bodyOf(projects)).toMatchObject({ items: [{ project_id: 'project-alpha', status: 'active' }] })
    const detail = await fetch(`http://127.0.0.1:${port}/v1/me/projects/project-alpha`, { headers })
    expect(detail.status).toBe(200)
    const value = (await bodyOf(detail)) as {
      project: { status: string }
      assets: Array<{ asset_type: string; asset_id: string; relation_kind: string }>
    }
    expect(value.project.status).toBe('active')
    expect(value.assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ asset_type: 'skill', asset_id: 'code-review', relation_kind: 'reference' }),
        expect.objectContaining({ asset_type: 'knowledge', asset_id: 'k-1', relation_kind: 'context' }),
      ]),
    )
    expect(value.assets.some(item => item.asset_id === 'k-2')).toBe(false)
  })

  it('returns project membership organization context without project roles', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const login = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin@example.com', password: 'admin-pass' }),
    })
    const token = ((await bodyOf(login)) as { access_token: string }).access_token
    const response = await fetch(`http://127.0.0.1:${port}/v1/admin/projects/project-alpha/members`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.status).toBe(200)
    expect(await bodyOf(response)).toMatchObject({
      items: [{ project_id: 'project-alpha', organization_id: 'org-alpha', user_id: 'member-1', status: 'active' }],
    })
    expect(
      JSON.stringify(
        await (
          await fetch(`http://127.0.0.1:${port}/v1/admin/projects/project-alpha/members`, { headers: { authorization: `Bearer ${token}` } })
        ).json(),
      ),
    ).not.toContain('role')
  })

  it('enforces role scope and replays project creation idempotently over HTTP', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const login = (username: string, password: string): Promise<string> => loginAt(port, username, password)
    const managerToken = await login('manager@example.com', 'manager-pass')
    const managerOutsideScope = await fetch(`http://127.0.0.1:${port}/v1/admin/projects`, {
      method: 'POST',
      headers: { authorization: `Bearer ${managerToken}`, 'content-type': 'application/json', 'idempotency-key': 'manager-outside-scope' },
      body: JSON.stringify({ organization_id: 'org-beta', name: '越权项目' }),
    })
    expect(managerOutsideScope.status).toBe(403)
    const memberToken = await login('member@example.com', 'member-pass')
    const memberAdminList = await fetch(`http://127.0.0.1:${port}/v1/admin/projects`, {
      headers: { authorization: `Bearer ${memberToken}` },
    })
    expect(memberAdminList.status).toBe(403)
    const adminToken = await login('admin@example.com', 'admin-pass')
    const headers = {
      authorization: `Bearer ${adminToken}`,
      'content-type': 'application/json',
      'idempotency-key': 'project-create-replay',
    }
    const first = await fetch(`http://127.0.0.1:${port}/v1/admin/projects`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ organization_id: 'org-beta', name: '幂等项目' }),
    })
    const firstBody = (await bodyOf(first)) as { project_id: string }
    const replay = await fetch(`http://127.0.0.1:${port}/v1/admin/projects`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ organization_id: 'org-beta', name: '幂等项目' }),
    })
    expect(replay.status).toBe(201)
    expect(await bodyOf(replay)).toMatchObject({ project_id: firstBody.project_id })
    const conflict = await fetch(`http://127.0.0.1:${port}/v1/admin/projects`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ organization_id: 'org-beta', name: '另一项目' }),
    })
    expect(conflict.status).toBe(409)
    expect(await bodyOf(conflict)).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
  })

  it('requires an idempotency key before validating project asset write fields', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const login = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin@example.com', password: 'admin-pass' }),
    })
    const token = ((await bodyOf(login)) as { access_token: string }).access_token
    const response = await fetch(`http://127.0.0.1:${port}/v1/admin/projects/project-alpha/assets`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ asset_type: 'unsupported', asset_id: 'unknown', relation_kind: 'reference' }),
    })
    expect(response.status).toBe(400)
    expect(await bodyOf(response)).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' })
  })

  it('uses the project revision for a new member relation and advances it after the write', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const login = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin@example.com', password: 'admin-pass' }),
    })
    const token = ((await bodyOf(login)) as { access_token: string }).access_token
    const created = await fetch(`http://127.0.0.1:${port}/v1/admin/users`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': 'project-beta-member-create' },
      body: JSON.stringify({
        username: 'project.beta.member@example.com',
        display_name: '项目 Beta 成员',
        organization_ids: ['org-beta'],
        global_role: 'member',
      }),
    })
    const userId = ((await bodyOf(created)) as { user: { user_id: string } }).user.user_id
    const base = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const stale = await fetch(`http://127.0.0.1:${port}/v1/admin/projects/project-beta/members/${userId}`, {
      method: 'PUT',
      headers: { ...base, 'if-match': '0', 'idempotency-key': 'project-beta-member-stale' },
      body: '{}',
    })
    expect(stale.status).toBe(409)
    expect(await bodyOf(stale)).toMatchObject({ code: 'REVISION_CONFLICT' })
    const added = await fetch(`http://127.0.0.1:${port}/v1/admin/projects/project-beta/members/${userId}`, {
      method: 'PUT',
      headers: { ...base, 'if-match': '1', 'idempotency-key': 'project-beta-member-add' },
      body: '{}',
    })
    expect(added.status).toBe(200)
    expect(await bodyOf(added)).toMatchObject({ project_id: 'project-beta', revision: 2, member_count: 1 })
  })

  it('rejects a project asset write that omits the current project revision', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const login = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin@example.com', password: 'admin-pass' }),
    })
    const token = ((await bodyOf(login)) as { access_token: string }).access_token
    const response = await fetch(`http://127.0.0.1:${port}/v1/admin/projects/project-alpha/assets`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': 'asset-missing-revision' },
      body: JSON.stringify({ asset_type: 'skill', asset_id: 'api-reliability', relation_kind: 'reference' }),
    })
    expect(response.status).toBe(409)
    expect(await bodyOf(response)).toMatchObject({ code: 'REVISION_CONFLICT' })
  })

  it('manages project asset relations with independent revision and rejects archived writes', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const login = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin@example.com', password: 'admin-pass' }),
    })
    const token = ((await bodyOf(login)) as { access_token: string }).access_token
    const base = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const list = await fetch(`http://127.0.0.1:${port}/v1/admin/projects/project-alpha/assets`, { headers: base })
    expect(list.status).toBe(200)
    const relations = (await bodyOf(list)) as {
      items: Array<{ asset_type: string; asset_id: string; relation_kind: string; revision: number }>
    }
    const skill = relations.items.find(item => item.asset_type === 'skill' && item.asset_id === 'code-review')!
    const changed = await fetch(`http://127.0.0.1:${port}/v1/admin/projects/project-alpha/assets/skill/code-review`, {
      method: 'PATCH',
      headers: { ...base, 'if-match': String(skill.revision), 'idempotency-key': 'asset-relation-change' },
      body: JSON.stringify({ relation_kind: 'context' }),
    })
    expect(changed.status).toBe(200)
    expect(await bodyOf(changed)).toMatchObject({
      asset_type: 'skill',
      asset_id: 'code-review',
      relation_kind: 'context',
      revision: skill.revision + 1,
    })
    const stale = await fetch(`http://127.0.0.1:${port}/v1/admin/projects/project-alpha/assets/skill/code-review`, {
      method: 'PATCH',
      headers: { ...base, 'if-match': String(skill.revision), 'idempotency-key': 'asset-relation-stale' },
      body: JSON.stringify({ relation_kind: 'reference' }),
    })
    expect(stale.status).toBe(409)
    const archived = await fetch(`http://127.0.0.1:${port}/v1/admin/projects/project-alpha:archive`, {
      method: 'POST',
      headers: { ...base, 'if-match': '1', 'idempotency-key': 'archive-alpha-for-asset-test' },
      body: '{}',
    })
    expect(archived.status).toBe(200)
    const blocked = await fetch(`http://127.0.0.1:${port}/v1/admin/projects/project-alpha/assets/skill/code-review`, {
      method: 'DELETE',
      headers: { ...base, 'if-match': String(skill.revision + 1), 'idempotency-key': 'asset-relation-after-archive' },
    })
    expect(blocked.status).toBe(409)
  })
  it('keeps demo accounts available when the Skill seed is disabled', async () => {
    const service = createTeamSkillService({ port: 0, seed: false })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const login = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'manager@example.com', password: 'manager-pass' }),
    })
    expect(login.status).toBe(200)
  })

  it('logs in and exposes the aggregate access summary without a selected organization', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const login = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'member@example.com', password: 'member-pass' }),
    })
    expect(login.status).toBe(200)
    const session = (await bodyOf(login)) as { access_token: string; must_change_password: boolean }
    expect(session.must_change_password).toBe(false)
    const headers = { authorization: `Bearer ${session.access_token}` }
    expect((await fetch(`http://127.0.0.1:${port}/v1/me`, { headers })).status).toBe(200)
    const organizations = await fetch(`http://127.0.0.1:${port}/v1/me/organizations`, { headers })
    expect(await bodyOf(organizations)).toMatchObject({ items: [{ organization_id: 'org-alpha' }] })
    const access = await fetch(`http://127.0.0.1:${port}/v1/me/access-summary`, { headers })
    expect(access.status).toBe(200)
    const value = (await bodyOf(access)) as {
      organizations: Array<{ organization_id: string }>
      projects: Array<{ project_id: string }>
      assets: Array<{ asset_id: string; asset_type: string }>
    }
    expect(value.organizations.map(item => item.organization_id)).toEqual(['org-alpha'])
    expect(value.projects.map(item => item.project_id)).toEqual(['project-alpha'])
    expect(value.assets.some(item => item.asset_id === 'project-alpha' && item.asset_type === 'project')).toBe(true)
  })

  it('returns one account role and an aggregate access summary without organization selection', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const login = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin@example.com', password: 'admin-pass' }),
    })
    const session = (await bodyOf(login)) as {
      access_token: string
      user: { global_role?: string }
      memberships: Array<Record<string, unknown>>
    }
    expect(session.user.global_role).toBe('admin')
    expect(session.memberships[0]).not.toHaveProperty('role')
    const access = await fetch(`http://127.0.0.1:${port}/v1/me/access-summary`, {
      headers: { authorization: `Bearer ${session.access_token}` },
    })
    expect(access.status).toBe(200)
    const value = (await bodyOf(access)) as {
      organizations: Array<{ organization_id: string }>
      projects: Array<{ project_id: string }>
      assets: Array<{ asset_id: string; asset_type: string }>
    }
    expect(value.organizations.map(item => item.organization_id)).toEqual(['org-alpha', 'org-beta'])
    expect(value.projects.map(item => item.project_id)).toEqual(['project-alpha', 'project-beta'])
    expect(value.assets.some(item => item.asset_id === 'project-alpha' && item.asset_type === 'project')).toBe(true)
  })

  it('forces an initial-password account through password change and revokes the old token', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const admin = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin@example.com', password: 'admin-pass' }),
    })
    const adminSession = (await bodyOf(admin)) as { access_token: string }
    const created = await fetch(`http://127.0.0.1:${port}/v1/admin/users`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${adminSession.access_token}`,
        'content-type': 'application/json',
        'idempotency-key': 'create-member-1',
      },
      body: JSON.stringify({
        username: 'new.member@example.com',
        display_name: '新成员',
        organization_ids: ['org-alpha'],
        global_role: 'member',
        project_ids: ['project-alpha'],
      }),
    })
    expect(created.status).toBe(201)
    const createdBody = (await bodyOf(created)) as { initial_password: string; user: { must_change_password: boolean } }
    expect(createdBody.initial_password).toBeTruthy()
    expect(createdBody.user.must_change_password).toBe(true)
    const login = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'new.member@example.com', password: createdBody.initial_password }),
    })
    const limited = (await bodyOf(login)) as { access_token: string; must_change_password: boolean }
    expect(limited.must_change_password).toBe(true)
    const blocked = await fetch(`http://127.0.0.1:${port}/v1/me/organizations`, {
      headers: { authorization: `Bearer ${limited.access_token}` },
    })
    expect(blocked.status).toBe(403)
    expect(await bodyOf(blocked)).toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED' })
    const changed = await fetch(`http://127.0.0.1:${port}/v1/auth/change-password`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${limited.access_token}`,
        'content-type': 'application/json',
        'idempotency-key': 'change-password-1',
      },
      body: JSON.stringify({ current_password: createdBody.initial_password, new_password: 'new-member-pass' }),
    })
    expect(changed.status).toBe(200)
    expect((await fetch(`http://127.0.0.1:${port}/v1/me`, { headers: { authorization: `Bearer ${limited.access_token}` } })).status).toBe(
      401,
    )

    const replayedChange = await fetch(`http://127.0.0.1:${port}/v1/auth/change-password`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${limited.access_token}`,
        'content-type': 'application/json',
        'idempotency-key': 'change-password-1',
      },
      body: JSON.stringify({ current_password: createdBody.initial_password, new_password: 'new-member-pass' }),
    })
    expect(replayedChange.status).toBe(200)
    expect(await bodyOf(replayedChange)).toMatchObject({ access_token: expect.any(String), must_change_password: false })
  })

  it('replays an idempotent logout after the access token has been revoked', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const login = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'member@example.com', password: 'member-pass' }),
    })
    const token = ((await bodyOf(login)) as { access_token: string }).access_token
    const headers = { authorization: `Bearer ${token}`, 'idempotency-key': 'logout-replay-1' }
    expect((await fetch(`http://127.0.0.1:${port}/v1/auth/logout`, { method: 'POST', headers })).status).toBe(204)
    expect((await fetch(`http://127.0.0.1:${port}/v1/auth/logout`, { method: 'POST', headers })).status).toBe(204)
  })

  it('requires and replays an idempotent refresh-token rotation', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const login = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'member@example.com', password: 'member-pass' }),
    })
    const refreshToken = ((await bodyOf(login)) as { refresh_token: string }).refresh_token
    const missingKey = await fetch(`http://127.0.0.1:${port}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    })
    expect(missingKey.status).toBe(400)
    const headers = { 'content-type': 'application/json', 'idempotency-key': 'refresh-replay-1' }
    const first = await fetch(`http://127.0.0.1:${port}/v1/auth/refresh`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ refresh_token: refreshToken }),
    })
    expect(first.status).toBe(200)
    const firstBody = (await bodyOf(first)) as { access_token: string }
    const replayed = await fetch(`http://127.0.0.1:${port}/v1/auth/refresh`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ refresh_token: refreshToken }),
    })
    expect(replayed.status).toBe(200)
    expect(await bodyOf(replayed)).toMatchObject({ access_token: firstBody.access_token })
  })

  it('rejects a Skill installation outside the caller project scope', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const login = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'member@example.com', password: 'member-pass' }),
    })
    const token = ((await bodyOf(login)) as { access_token: string }).access_token
    const response = await fetch(`http://127.0.0.1:${port}/v1/team-skill-installations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': 'scope-denial-1' },
      body: JSON.stringify({ skill_id: 'code-review', version: '1.0.0', project_id: 'project-beta', scope: 'project', environment: {} }),
    })
    expect(response.status).toBe(404)
    expect(await bodyOf(response)).toMatchObject({ code: 'PROJECT_NOT_MEMBER' })
  })

  it('requires project scope before returning the Team Skill catalog', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const login = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'member@example.com', password: 'member-pass' }),
    })
    const token = ((await bodyOf(login)) as { access_token: string }).access_token
    const missingProject = await fetch(`http://127.0.0.1:${port}/v1/team-skills`, { headers: { authorization: `Bearer ${token}` } })
    expect(missingProject.status).toBe(422)
    expect(await bodyOf(missingProject)).toMatchObject({ code: 'VALIDATION_ERROR' })
    const otherProject = await fetch(`http://127.0.0.1:${port}/v1/team-skills?project_id=project-beta`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(otherProject.status).toBe(404)
    expect(await bodyOf(otherProject)).toMatchObject({ code: 'PROJECT_NOT_MEMBER' })
  })

  it('enforces admin and manager scope for account and project authorization changes', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const login = (username: string, password: string): Promise<string> => loginAt(port, username, password)
    const managerToken = await login('manager@example.com', 'manager-pass')
    const managerCreatesManager = await fetch(`http://127.0.0.1:${port}/v1/admin/users`, {
      method: 'POST',
      headers: { authorization: `Bearer ${managerToken}`, 'content-type': 'application/json', 'idempotency-key': 'manager-cannot-manager' },
      body: JSON.stringify({
        username: 'other.manager@example.com',
        display_name: '其他管理员',
        organization_ids: ['org-alpha'],
        global_role: 'manager',
      }),
    })
    expect(managerCreatesManager.status).toBe(403)
    const managerCreatesMember = await fetch(`http://127.0.0.1:${port}/v1/admin/users`, {
      method: 'POST',
      headers: { authorization: `Bearer ${managerToken}`, 'content-type': 'application/json', 'idempotency-key': 'manager-creates-member' },
      body: JSON.stringify({
        username: 'scoped.member@example.com',
        display_name: '范围成员',
        organization_ids: ['org-alpha'],
        global_role: 'member',
      }),
    })
    expect(managerCreatesMember.status).toBe(201)
    const memberToken = await login('member@example.com', 'member-pass')
    const forbidden = await fetch(`http://127.0.0.1:${port}/v1/admin/projects?organization_id=org-alpha`, {
      headers: { authorization: `Bearer ${memberToken}` },
    })
    expect(forbidden.status).toBe(403)
    const audit = await fetch(`http://127.0.0.1:${port}/v1/admin/authorization-audits`, {
      headers: { authorization: `Bearer ${managerToken}` },
    })
    expect(audit.status).toBe(200)
    expect(((await bodyOf(audit)) as { items: Array<{ action: string }> }).items.map(item => item.action)).toContain('账号创建')
  })

  it('rejects an unknown organization role instead of assigning a default role', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const login = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin@example.com', password: 'admin-pass' }),
    })
    const token = ((await bodyOf(login)) as { access_token: string }).access_token
    const created = await fetch(`http://127.0.0.1:${port}/v1/admin/users`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': 'reject-unknown-role' },
      body: JSON.stringify({
        username: 'unknown.role@example.com',
        display_name: '未知角色',
        organization_ids: ['org-alpha'],
        global_role: 'owner',
      }),
    })
    expect(created.status).toBe(422)
    expect(await bodyOf(created)).toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('rejects an unknown role when changing an organization membership', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const login = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin@example.com', password: 'admin-pass' }),
    })
    const token = ((await bodyOf(login)) as { access_token: string }).access_token
    const changed = await fetch(`http://127.0.0.1:${port}/v1/admin/organizations/org-alpha/members/member-1`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'if-match': '1',
        'idempotency-key': 'reject-unknown-membership-role',
      },
      body: JSON.stringify({ role: 'owner' }),
    })
    expect(changed.status).toBe(422)
    expect(await bodyOf(changed)).toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('rejects an unknown role when changing a project membership', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const login = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin@example.com', password: 'admin-pass' }),
    })
    const token = ((await bodyOf(login)) as { access_token: string }).access_token
    const changed = await fetch(`http://127.0.0.1:${port}/v1/admin/projects/project-alpha/members/member-1`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'if-match': '1',
        'idempotency-key': 'reject-unknown-project-role',
      },
      body: JSON.stringify({ role: 'owner' }),
    })
    expect(changed.status).toBe(422)
    expect(await bodyOf(changed)).toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('changes project membership and removes the project from the member access summary', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const login = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'manager@example.com', password: 'manager-pass' }),
    })
    const token = ((await bodyOf(login)) as { access_token: string }).access_token
    const remove = await fetch(`http://127.0.0.1:${port}/v1/admin/projects/project-alpha/members/member-1`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}`, 'if-match': '1', 'idempotency-key': 'remove-project-member' },
    })
    expect(remove.status).toBe(200)
    const memberLogin = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'member@example.com', password: 'member-pass' }),
    })
    const memberToken = ((await bodyOf(memberLogin)) as { access_token: string }).access_token
    const access = await fetch(`http://127.0.0.1:${port}/v1/me/access-summary`, { headers: { authorization: `Bearer ${memberToken}` } })
    expect(await bodyOf(access)).toMatchObject({ projects: [], assets: [] })
  })

  it('requires the current removed relation revision when restoring project access', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const login = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'manager@example.com', password: 'manager-pass' }),
    })
    const token = ((await bodyOf(login)) as { access_token: string }).access_token
    const baseHeaders = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const remove = await fetch(`http://127.0.0.1:${port}/v1/admin/projects/project-alpha/members/member-1`, {
      method: 'DELETE',
      headers: { ...baseHeaders, 'if-match': '1', 'idempotency-key': 'restore-revision-remove' },
    })
    expect(remove.status).toBe(200)
    const staleRestore = await fetch(`http://127.0.0.1:${port}/v1/admin/projects/project-alpha/members/member-1`, {
      method: 'PUT',
      headers: { ...baseHeaders, 'if-match': '1', 'idempotency-key': 'restore-revision-stale' },
      body: JSON.stringify({}),
    })
    expect(staleRestore.status).toBe(409)
    expect(await bodyOf(staleRestore)).toMatchObject({ code: 'REVISION_CONFLICT' })
    const currentRestore = await fetch(`http://127.0.0.1:${port}/v1/admin/projects/project-alpha/members/member-1`, {
      method: 'PUT',
      headers: { ...baseHeaders, 'if-match': '2', 'idempotency-key': 'restore-revision-current' },
      body: JSON.stringify({}),
    })
    expect(currentRestore.status).toBe(200)
    const memberLogin = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'member@example.com', password: 'member-pass' }),
    })
    const memberToken = ((await bodyOf(memberLogin)) as { access_token: string }).access_token
    const access = await fetch(`http://127.0.0.1:${port}/v1/me/access-summary`, { headers: { authorization: `Bearer ${memberToken}` } })
    expect(await bodyOf(access)).toMatchObject({ projects: [{ project_id: 'project-alpha' }] })
  })

  it('rejects idempotency-key reuse when the account request body changes', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const login = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin@example.com', password: 'admin-pass' }),
    })
    const token = ((await bodyOf(login)) as { access_token: string }).access_token
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': 'account-body-conflict' }
    const first = await fetch(`http://127.0.0.1:${port}/v1/admin/users`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        username: 'first@example.com',
        display_name: '第一个',
        organization_ids: ['org-alpha'],
        global_role: 'member',
      }),
    })
    expect(first.status).toBe(201)
    const second = await fetch(`http://127.0.0.1:${port}/v1/admin/users`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        username: 'second@example.com',
        display_name: '第二个',
        organization_ids: ['org-alpha'],
        global_role: 'member',
      }),
    })
    expect(second.status).toBe(409)
    expect(await bodyOf(second)).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
  })

  it('does not leave an organization after an invalid initial manager', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const login = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin@example.com', password: 'admin-pass' }),
    })
    const token = ((await bodyOf(login)) as { access_token: string }).access_token
    const failed = await fetch(`http://127.0.0.1:${port}/v1/admin/organizations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': 'organization-invalid-manager' },
      body: JSON.stringify({ name: '不应创建', manager_user_id: 'missing-user' }),
    })
    expect(failed.status).toBe(422)
    const organizations = await fetch(`http://127.0.0.1:${port}/v1/admin/organizations`, { headers: { authorization: `Bearer ${token}` } })
    expect(((await bodyOf(organizations)) as { items: Array<{ name: string }> }).items.some(item => item.name === '不应创建')).toBe(false)
  })

  it('limits an unfiltered manager project list to the manager organization', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const login = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'manager@example.com', password: 'manager-pass' }),
    })
    const token = ((await bodyOf(login)) as { access_token: string }).access_token
    const projects = await fetch(`http://127.0.0.1:${port}/v1/admin/projects`, { headers: { authorization: `Bearer ${token}` } })
    expect(await bodyOf(projects)).toMatchObject({ items: [{ project_id: 'project-alpha' }] })
  })

  it('does not expose organization-less platform audits to a manager', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const adminLogin = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin@example.com', password: 'admin-pass' }),
    })
    const managerLogin = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'manager@example.com', password: 'manager-pass' }),
    })
    expect(adminLogin.status).toBe(200)
    const managerToken = ((await bodyOf(managerLogin)) as { access_token: string }).access_token
    const audits = await fetch(`http://127.0.0.1:${port}/v1/admin/authorization-audits`, {
      headers: { authorization: `Bearer ${managerToken}` },
    })
    expect(
      ((await bodyOf(audits)) as { items: Array<{ action: string; organization_id?: string }> }).items.some(
        item => item.action === '登录成功' && item.organization_id === undefined,
      ),
    ).toBe(false)
  })

  it('filters manager user membership details to the manager organization', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const login = (username: string, password: string): Promise<string> => loginAt(port, username, password)
    const adminToken = await login('admin@example.com', 'admin-pass')
    const created = await fetch(`http://127.0.0.1:${port}/v1/admin/users`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', 'idempotency-key': 'cross-org-user-create' },
      body: JSON.stringify({
        username: 'cross-org@example.com',
        display_name: '跨组织成员',
        organization_ids: ['org-alpha'],
        global_role: 'member',
      }),
    })
    expect(created.status).toBe(201)
    const userId = ((await bodyOf(created)) as { user: { user_id: string } }).user.user_id
    const added = await fetch(`http://127.0.0.1:${port}/v1/admin/organizations/org-beta/members/${userId}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', 'idempotency-key': 'cross-org-membership-add' },
      body: JSON.stringify({}),
    })
    expect(added.status).toBe(200)

    const managerToken = await login('manager@example.com', 'manager-pass')
    const listed = await fetch(`http://127.0.0.1:${port}/v1/admin/users?organization_id=org-alpha`, {
      headers: { authorization: `Bearer ${managerToken}` },
    })
    expect(listed.status).toBe(200)
    const user = (
      (await bodyOf(listed)) as { items: Array<{ user_id: string; memberships?: Array<{ organization_id: string }> }> }
    ).items.find(item => item.user_id === userId)
    expect(user?.memberships).toEqual([{ organization_id: 'org-alpha', organization_name: '星河 AI 平台', status: 'active', revision: 1 }])
  })

  it('rejects membership and project authorization changes after organization archival', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const login = (username: string, password: string): Promise<string> => loginAt(port, username, password)
    const adminToken = await login('admin@example.com', 'admin-pass')
    const archived = await fetch(`http://127.0.0.1:${port}/v1/admin/organizations/org-alpha`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': 'application/json',
        'if-match': '1',
        'idempotency-key': 'archive-org-alpha',
      },
      body: JSON.stringify({ status: 'archived' }),
    })
    expect(archived.status).toBe(200)

    const managerToken = await login('manager@example.com', 'manager-pass')
    const membership = await fetch(`http://127.0.0.1:${port}/v1/admin/organizations/org-alpha/members/member-1`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${managerToken}`,
        'content-type': 'application/json',
        'if-match': '1',
        'idempotency-key': 'archived-membership',
      },
      body: JSON.stringify({}),
    })
    expect(membership.status).toBe(409)
    expect(await bodyOf(membership)).toMatchObject({ code: 'ORGANIZATION_ARCHIVED' })

    const project = await fetch(`http://127.0.0.1:${port}/v1/admin/projects/project-alpha/members/member-1`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': 'application/json',
        'if-match': '1',
        'idempotency-key': 'archived-project-membership',
      },
      body: JSON.stringify({}),
    })
    expect(project.status).toBe(409)
    expect(await bodyOf(project)).toMatchObject({ code: 'ORGANIZATION_ARCHIVED' })
  })

  it('rejects project authorization for a suspended account', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const login = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin@example.com', password: 'admin-pass' }),
    })
    const adminToken = ((await bodyOf(login)) as { access_token: string }).access_token
    const suspended = await fetch(`http://127.0.0.1:${port}/v1/admin/users/member-1`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': 'application/json',
        'if-match': '1',
        'idempotency-key': 'suspend-project-member',
      },
      body: JSON.stringify({ status: 'suspended' }),
    })
    expect(suspended.status).toBe(200)
    const project = await fetch(`http://127.0.0.1:${port}/v1/admin/projects/project-alpha/members/member-1`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': 'application/json',
        'if-match': '1',
        'idempotency-key': 'suspended-project-membership',
      },
      body: JSON.stringify({}),
    })
    expect(project.status).toBe(422)
    expect(await bodyOf(project)).toMatchObject({ code: 'ACCOUNT_SUSPENDED' })
  })

  it('does not authorize active projects whose organization is archived', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const login = (username: string, password: string): Promise<string> => loginAt(port, username, password)
    const adminToken = await login('admin@example.com', 'admin-pass')
    const archived = await fetch(`http://127.0.0.1:${port}/v1/admin/organizations/org-alpha`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': 'application/json',
        'if-match': '1',
        'idempotency-key': 'archive-project-org',
      },
      body: JSON.stringify({ status: 'archived' }),
    })
    expect(archived.status).toBe(200)

    const managerToken = await login('manager@example.com', 'manager-pass')
    const catalog = await fetch(`http://127.0.0.1:${port}/v1/team-skills?project_id=project-alpha`, {
      headers: { authorization: `Bearer ${managerToken}` },
    })
    expect(catalog.status).toBe(404)
    expect(await bodyOf(catalog)).toMatchObject({ code: 'RESOURCE_NOT_FOUND' })
  })
})
