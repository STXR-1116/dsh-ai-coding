import { strToU8, zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { createTeamSkillService } from '../src/server.ts'
import { bodyOf } from './response.ts'

const services: ReturnType<typeof createTeamSkillService>[] = []
let nextKey = 1

/** ASCII-only unique idempotency key; header values cannot carry non-Latin1 characters. */
function uniqueKey(prefix: string): string {
  return `${prefix}-${nextKey++}`
}

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

interface PublishedSkill {
  readonly skillId: string
  readonly version: string
  readonly revision: number
}

async function projectRevision(port: number, token: string, projectId: string): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/admin/projects/${projectId}`, {
    headers: apiHeaders(token),
  })
  expect(response.status).toBe(200)
  return ((await bodyOf(response)) as { revision: number }).revision
}

/** Create, artifact, review, approve and publish one organization-scoped Skill over real HTTP. */
async function publishSkill(
  port: number,
  adminToken: string,
  input: { readonly name: string; readonly summary: string; readonly organizationId: string },
): Promise<PublishedSkill> {
  const created = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skills`, {
    method: 'POST',
    headers: { ...apiHeaders(adminToken), 'idempotency-key': uniqueKey('create') },
    body: JSON.stringify({
      display_name: input.name,
      summary: input.summary,
      visibility: 'organization',
      organization_id: input.organizationId,
    }),
  })
  expect(created.status).toBe(201)
  const skill = (await bodyOf(created)) as { skillId: string; revision: number }
  const versioned = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skills/${skill.skillId}/versions`, {
    method: 'POST',
    headers: {
      ...apiHeaders(adminToken),
      'if-match': String(skill.revision),
      'x-skill-revision': String(skill.revision),
      'idempotency-key': uniqueKey('version'),
    },
    body: JSON.stringify({ version: '1.0.0', release_notes: '测试版本' }),
  })
  expect(versioned.status).toBe(201)
  const version = (await bodyOf(versioned)) as { version: { revision: number }; skill: { revision: number } }
  const artifact = zipSync({
    'SKILL.md': strToU8(`---\nname: aicp-${skill.skillId}\ndescription: ${input.summary}\n---\n\n# ${input.name}\n`),
  })
  const uploaded = await fetch(
    `http://127.0.0.1:${port}/v1/admin/team-skills/${skill.skillId}/versions/1.0.0/artifact`,
    {
      method: 'PUT',
      headers: {
        ...apiHeaders(adminToken),
        'if-match': String(version.version.revision),
        'x-skill-revision': String(version.skill.revision),
        'idempotency-key': uniqueKey('artifact'),
        'content-type': 'application/zip',
      },
      body: new Uint8Array(artifact),
    },
  )
  expect(uploaded.status).toBe(200)
  const uploadedBody = (await bodyOf(uploaded)) as { version: { revision: number }; skill: { revision: number } }
  const submitted = await fetch(
    `http://127.0.0.1:${port}/v1/admin/team-skills/${skill.skillId}/versions/1.0.0/submit-review`,
    {
      method: 'POST',
      headers: {
        ...apiHeaders(adminToken),
        'if-match': String(uploadedBody.version.revision),
        'x-skill-revision': String(uploadedBody.skill.revision),
        'idempotency-key': uniqueKey('submit'),
      },
      body: '{}',
    },
  )
  expect(submitted.status).toBe(200)
  const submittedBody = (await bodyOf(submitted)) as { version: { revision: number }; skill: { revision: number } }
  const approved = await fetch(
    `http://127.0.0.1:${port}/v1/admin/team-skills/${skill.skillId}/versions/1.0.0/approve`,
    {
      method: 'POST',
      headers: {
        ...apiHeaders(adminToken),
        'if-match': String(submittedBody.version.revision),
        'x-skill-revision': String(submittedBody.skill.revision),
        'idempotency-key': uniqueKey('approve'),
      },
      body: JSON.stringify({ checks: { 'check-1': 'pass', 'check-2': 'pass', 'check-3': 'pass' } }),
    },
  )
  expect(approved.status).toBe(200)
  const approvedBody = (await bodyOf(approved)) as { version: { revision: number }; skill: { revision: number } }
  const published = await fetch(
    `http://127.0.0.1:${port}/v1/admin/team-skills/${skill.skillId}/versions/1.0.0/publish`,
    {
      method: 'POST',
      headers: {
        ...apiHeaders(adminToken),
        'if-match': String(approvedBody.version.revision),
        'x-skill-revision': String(approvedBody.skill.revision),
        'idempotency-key': uniqueKey('publish'),
      },
      body: '{}',
    },
  )
  expect(published.status).toBe(200)
  const publishedBody = (await bodyOf(published)) as { skill: { revision: number } }
  return { skillId: skill.skillId, version: '1.0.0', revision: publishedBody.skill.revision }
}

async function bindSkillAsset(
  port: number,
  token: string,
  projectId: string,
  skillId: string,
): Promise<void> {
  const revision = await projectRevision(port, token, projectId)
  const bound = await fetch(`http://127.0.0.1:${port}/v1/admin/projects/${projectId}/assets`, {
    method: 'POST',
    headers: { ...apiHeaders(token), 'if-match': String(revision), 'idempotency-key': `bind-${projectId}-${skillId}` },
    body: JSON.stringify({ asset_type: 'skill', asset_id: skillId, relation_kind: 'reference' }),
  })
  expect(bound.status).toBe(201)
}

async function installSkill(
  port: number,
  token: string,
  input: { readonly skillId: string; readonly version: string; readonly projectId: string },
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/team-skill-installations`, {
    method: 'POST',
    headers: { ...apiHeaders(token), 'idempotency-key': `install-${input.skillId}-${input.projectId}` },
    body: JSON.stringify({
      skill_id: input.skillId,
      version: input.version,
      project_id: input.projectId,
      scope: 'global',
      local_installation_id: `local-${input.skillId}-${input.projectId}`,
      environment: { dsh_version: '0.1.1', available_tools: [], available_mcp_servers: [], present_environment_variable_names: [] },
    }),
  })
}

describe('team skill organization and project authorization', () => {
  it('hides an unbound published skill from another project catalog and rejects its installation server-side', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const admin = await loginAs(port, 'admin@example.com', 'admin-pass')
    const member = await loginAs(port, 'member@example.com', 'member-pass')
    const published = await publishSkill(port, admin, {
      name: '未绑定技能',
      summary: '已发布但尚未绑定项目资产',
      organizationId: 'org-alpha',
    })

    const catalog = await fetch(`http://127.0.0.1:${port}/v1/team-skills?project_id=project-alpha`, {
      headers: apiHeaders(member),
    })
    expect(catalog.status).toBe(200)
    expect(((await bodyOf(catalog)) as { items: Array<{ skill_id: string }> }).items.map(item => item.skill_id)).not.toContain(
      published.skillId,
    )

    const detail = await fetch(
      `http://127.0.0.1:${port}/v1/team-skills/${published.skillId}?project_id=project-alpha`,
      { headers: apiHeaders(member) },
    )
    expect(detail.status).toBe(404)

    const releaseStatus = await fetch(`http://127.0.0.1:${port}/v1/team-skills/release-status`, {
      method: 'POST',
      headers: apiHeaders(member),
      body: JSON.stringify({
        items: [{ skill_id: published.skillId, version: published.version, project_id: 'project-alpha' }],
      }),
    })
    expect(releaseStatus.status).toBe(200)
    expect(
      ((await bodyOf(releaseStatus)) as { items: Array<{ skill_id: string }> }).items.map(item => item.skill_id),
    ).not.toContain(published.skillId)

    const install = await installSkill(port, member, {
      skillId: published.skillId,
      version: published.version,
      projectId: 'project-alpha',
    })
    expect(install.status).toBe(403)
    expect(await bodyOf(install)).toMatchObject({ code: 'SKILL_NOT_PROJECT_ASSET' })
  })

  it('blocks cross-organization skill reads and installs even when the caller has a project in another organization', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const admin = await loginAs(port, 'admin@example.com', 'admin-pass')
    const member = await loginAs(port, 'member@example.com', 'member-pass')
    const betaSkill = await publishSkill(port, admin, {
      name: '数据平台技能',
      summary: '属于 org-beta 的已发布技能',
      organizationId: 'org-beta',
    })

    const catalog = await fetch(`http://127.0.0.1:${port}/v1/team-skills?project_id=project-alpha`, {
      headers: apiHeaders(member),
    })
    expect(((await bodyOf(catalog)) as { items: Array<{ skill_id: string }> }).items.map(item => item.skill_id)).not.toContain(
      betaSkill.skillId,
    )
    const install = await installSkill(port, member, {
      skillId: betaSkill.skillId,
      version: betaSkill.version,
      projectId: 'project-alpha',
    })
    expect(install.status).toBe(403)
    expect(await bodyOf(install)).toMatchObject({ code: 'SKILL_ORGANIZATION_FORBIDDEN' })
  })

  it('rejects binding a skill to a project in another organization', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const admin = await loginAs(port, 'admin@example.com', 'admin-pass')
    const betaSkill = await publishSkill(port, admin, {
      name: '跨组织绑定技能',
      summary: '尝试绑定到 org-alpha 项目',
      organizationId: 'org-beta',
    })
    const revision = await projectRevision(port, admin, 'project-alpha')
    const bound = await fetch(`http://127.0.0.1:${port}/v1/admin/projects/project-alpha/assets`, {
      method: 'POST',
      headers: { ...apiHeaders(admin), 'if-match': String(revision), 'idempotency-key': 'bind-cross-org' },
      body: JSON.stringify({ asset_type: 'skill', asset_id: betaSkill.skillId, relation_kind: 'reference' }),
    })
    expect(bound.status).toBe(403)
    expect(await bodyOf(bound)).toMatchObject({ code: 'SKILL_ORGANIZATION_FORBIDDEN' })
  })

  it('restores discovery only after the skill becomes a project asset and revokes it after unbinding', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const admin = await loginAs(port, 'admin@example.com', 'admin-pass')
    const member = await loginAs(port, 'member@example.com', 'member-pass')
    const published = await publishSkill(port, admin, {
      name: '绑定闭环技能',
      summary: '发布后绑定、撤权验证',
      organizationId: 'org-alpha',
    })
    await bindSkillAsset(port, admin, 'project-alpha', published.skillId)

    const catalog = await fetch(`http://127.0.0.1:${port}/v1/team-skills?project_id=project-alpha`, {
      headers: apiHeaders(member),
    })
    expect(((await bodyOf(catalog)) as { items: Array<{ skill_id: string }> }).items.map(item => item.skill_id)).toContain(
      published.skillId,
    )
    const install = await installSkill(port, member, {
      skillId: published.skillId,
      version: published.version,
      projectId: 'project-alpha',
    })
    expect(install.status).toBe(201)
    const operation = (await bodyOf(install)) as { operation_id: string; artifact: { download_url: string } }

    const relation = await fetch(`http://127.0.0.1:${port}/v1/admin/projects/project-alpha/assets`, {
      headers: apiHeaders(admin),
    })
    const relations = ((await bodyOf(relation)) as { items: Array<{ asset_id: string; revision: number }> }).items
    const target = relations.find(item => item.asset_id === published.skillId)
    expect(target).toBeDefined()
    const removed = await fetch(
      `http://127.0.0.1:${port}/v1/admin/projects/project-alpha/assets/skill/${published.skillId}`,
      {
        method: 'DELETE',
        headers: { ...apiHeaders(admin), 'if-match': String(target?.revision), 'idempotency-key': 'unbind-closed-loop' },
      },
    )
    expect(removed.status).toBe(200)

    const revokedCatalog = await fetch(`http://127.0.0.1:${port}/v1/team-skills?project_id=project-alpha`, {
      headers: apiHeaders(member),
    })
    expect(
      ((await bodyOf(revokedCatalog)) as { items: Array<{ skill_id: string }> }).items.map(item => item.skill_id),
    ).not.toContain(published.skillId)
    const revokedInstall = await installSkill(port, member, {
      skillId: published.skillId,
      version: published.version,
      projectId: 'project-alpha',
    })
    expect(revokedInstall.status).toBe(403)
    const revokedDownload = await fetch(operation.artifact.download_url, { headers: apiHeaders(member) })
    expect(revokedDownload.status).toBe(403)
    const releaseStatus = await fetch(`http://127.0.0.1:${port}/v1/team-skills/release-status`, {
      method: 'POST',
      headers: apiHeaders(member),
      body: JSON.stringify({
        items: [{ skill_id: published.skillId, version: published.version, project_id: 'project-alpha' }],
      }),
    })
    expect(
      ((await bodyOf(releaseStatus)) as { items: Array<{ skill_id: string }> }).items.map(item => item.skill_id),
    ).not.toContain(published.skillId)
  })

  it('stops serving a suspended member immediately on catalog and installation routes', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const admin = await loginAs(port, 'admin@example.com', 'admin-pass')
    const member = await loginAs(port, 'member@example.com', 'member-pass')
    const me = await fetch(`http://127.0.0.1:${port}/v1/me`, { headers: apiHeaders(member) })
    const revision = ((await bodyOf(me)) as { user: { revision: number } }).user.revision
    const suspended = await fetch(`http://127.0.0.1:${port}/v1/admin/users/member-1`, {
      method: 'PATCH',
      headers: { ...apiHeaders(admin), 'if-match': String(revision), 'idempotency-key': 'suspend-member' },
      body: JSON.stringify({ status: 'suspended' }),
    })
    expect(suspended.status).toBe(200)

    const catalog = await fetch(`http://127.0.0.1:${port}/v1/team-skills?project_id=project-alpha`, {
      headers: apiHeaders(member),
    })
    expect(catalog.status).toBe(401)
    const install = await installSkill(port, member, {
      skillId: 'code-review',
      version: '1.0.0',
      projectId: 'project-alpha',
    })
    expect(install.status).toBe(401)
  })

  it('rejects catalog and installation after the member loses organization membership', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const admin = await loginAs(port, 'admin@example.com', 'admin-pass')
    const member = await loginAs(port, 'member@example.com', 'member-pass')
    const me = await fetch(`http://127.0.0.1:${port}/v1/me`, { headers: apiHeaders(member) })
    const memberships = ((await bodyOf(me)) as { memberships: Array<{ organization_id: string; revision: number }> })
      .memberships
    const alpha = memberships.find(item => item.organization_id === 'org-alpha')
    expect(alpha).toBeDefined()
    const removed = await fetch(
      `http://127.0.0.1:${port}/v1/admin/organizations/org-alpha/members/member-1`,
      {
        method: 'DELETE',
        headers: { ...apiHeaders(admin), 'if-match': String(alpha?.revision), 'idempotency-key': 'remove-member-org' },
      },
    )
    expect(removed.status).toBe(200)

    const catalog = await fetch(`http://127.0.0.1:${port}/v1/team-skills?project_id=project-alpha`, {
      headers: apiHeaders(member),
    })
    expect(catalog.status).toBe(404)
    expect(await bodyOf(catalog)).toMatchObject({ code: 'PROJECT_NOT_MEMBER' })
    const install = await installSkill(port, member, {
      skillId: 'code-review',
      version: '1.0.0',
      projectId: 'project-alpha',
    })
    expect(install.status).toBe(404)
  })

  it('returns only the minimal project-context fields in the user detail response', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const member = await loginAs(port, 'member@example.com', 'member-pass')
    const detail = await fetch(`http://127.0.0.1:${port}/v1/team-skills/code-review?project_id=project-alpha`, {
      headers: apiHeaders(member),
    })
    expect(detail.status).toBe(200)
    const body = (await bodyOf(detail)) as { skill: Record<string, unknown> }
    expect(body.skill).toMatchObject({ skillId: 'code-review', currentVersion: '1.0.0' })
    for (const managementField of ['organization_id', 'project_ids', 'groupId', 'peopleIds', 'revision', 'authorName', 'visibility']) {
      expect(Object.hasOwn(body.skill, managementField)).toBe(false)
    }
  })

  it('hides the second same-organization project binding from the user detail of the first project', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const admin = await loginAs(port, 'admin@example.com', 'admin-pass')
    const member = await loginAs(port, 'member@example.com', 'member-pass')

    const created = await fetch(`http://127.0.0.1:${port}/v1/admin/projects`, {
      method: 'POST',
      headers: { ...apiHeaders(admin), 'idempotency-key': 'second-alpha-project' },
      body: JSON.stringify({ organization_id: 'org-alpha', name: '第二项目' }),
    })
    expect(created.status).toBe(201)
    const secondProject = (await bodyOf(created)) as { project_id: string; revision: number }
    const activated = await fetch(`http://127.0.0.1:${port}/v1/admin/projects/${secondProject.project_id}:activate`, {
      method: 'POST',
      headers: { ...apiHeaders(admin), 'if-match': String(secondProject.revision), 'idempotency-key': 'second-alpha-activate' },
      body: '{}',
    })
    expect(activated.status).toBe(200)
    await bindSkillAsset(port, admin, secondProject.project_id, 'code-review')

    const detail = await fetch(
      `http://127.0.0.1:${port}/v1/team-skills/code-review?project_id=project-alpha`,
      { headers: apiHeaders(member) },
    )
    expect(detail.status).toBe(200)
    const text = JSON.stringify(await bodyOf(detail))
    expect(text).not.toContain(secondProject.project_id)
    expect(text).not.toContain('project_ids')
    expect(text).not.toContain('organization_id')

    const adminDetail = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skills/code-review`, {
      headers: apiHeaders(admin),
    })
    expect(adminDetail.status).toBe(200)
    expect([...((await bodyOf(adminDetail)) as { skill: { project_ids: readonly string[] } }).skill.project_ids].sort()).toEqual([
      'project-alpha',
      secondProject.project_id,
    ].sort())
  })
})

describe('team skill management organization scope', () => {
  it('lets a manager list and read every skill of the managed organization, not only authored ones', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const admin = await loginAs(port, 'admin@example.com', 'admin-pass')
    const manager = await loginAs(port, 'manager@example.com', 'manager-pass')
    const adminDraft = await publishSkill(port, admin, {
      name: '管理员组织草稿技能',
      summary: '由管理员创建的 org-alpha 技能',
      organizationId: 'org-alpha',
    })

    const list = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skills`, { headers: apiHeaders(manager) })
    expect(list.status).toBe(200)
    const items = (await bodyOf(list)) as Array<{ skillId: string }>
    expect(items.map(item => item.skillId)).toContain(adminDraft.skillId)
    expect(items.map(item => item.skillId)).toContain('code-review')

    const detail = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skills/${adminDraft.skillId}`, {
      headers: apiHeaders(manager),
    })
    expect(detail.status).toBe(200)
    expect(await bodyOf(detail)).toMatchObject({ skill: { skillId: adminDraft.skillId, organization_id: 'org-alpha' } })
  })

  it('keeps another organization out of the manager skill scope', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const admin = await loginAs(port, 'admin@example.com', 'admin-pass')
    const manager = await loginAs(port, 'manager@example.com', 'manager-pass')
    const betaSkill = await publishSkill(port, admin, {
      name: '其他组织技能',
      summary: '属于 org-beta',
      organizationId: 'org-beta',
    })

    const list = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skills`, { headers: apiHeaders(manager) })
    expect(((await bodyOf(list)) as Array<{ skillId: string }>).map(item => item.skillId)).not.toContain(betaSkill.skillId)
    const detail = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skills/${betaSkill.skillId}`, {
      headers: apiHeaders(manager),
    })
    expect(detail.status).toBe(404)
  })

  it('serves the people directory from the account store and drops suspended members immediately', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const admin = await loginAs(port, 'admin@example.com', 'admin-pass')
    const manager = await loginAs(port, 'manager@example.com', 'manager-pass')
    const created = await fetch(`http://127.0.0.1:${port}/v1/admin/users`, {
      method: 'POST',
      headers: { ...apiHeaders(admin), 'idempotency-key': 'create-second-member' },
      body: JSON.stringify({
        username: 'second@example.com',
        display_name: '第二成员',
        organization_ids: ['org-alpha'],
        global_role: 'member',
        project_ids: [],
      }),
    })
    expect(created.status).toBe(201)
    const newUser = ((await bodyOf(created)) as { user: { user_id: string } }).user.user_id

    const directory = await fetch(
      `http://127.0.0.1:${port}/v1/admin/directory/users?organization_id=org-alpha`,
      { headers: apiHeaders(manager) },
    )
    expect(directory.status).toBe(200)
    const users = (
      (await bodyOf(directory)) as { items: Array<{ user_id: string; display_name: string; groups: readonly string[] }> }
    ).items
    expect(users.map(user => user.user_id)).toContain(newUser)
    expect(users.map(user => user.user_id)).toContain('member-1')
    expect(users.find(user => user.user_id === 'member-1')?.groups).toContain('platform')

    const me = await fetch(`http://127.0.0.1:${port}/v1/admin/users/${newUser}`, { headers: apiHeaders(admin) })
    const revision = ((await bodyOf(me)) as { revision: number }).revision
    await fetch(`http://127.0.0.1:${port}/v1/admin/users/${newUser}`, {
      method: 'PATCH',
      headers: { ...apiHeaders(admin), 'if-match': String(revision), 'idempotency-key': 'suspend-second-member' },
      body: JSON.stringify({ status: 'suspended' }),
    })
    const afterSuspension = await fetch(
      `http://127.0.0.1:${port}/v1/admin/directory/users?organization_id=org-alpha`,
      { headers: apiHeaders(manager) },
    )
    expect(
      ((await bodyOf(afterSuspension)) as { items: Array<{ user_id: string }> }).items.map(user => user.user_id),
    ).not.toContain(newUser)
  })

  it('rejects people targets outside the active organization directory', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const admin = await loginAs(port, 'admin@example.com', 'admin-pass')
    const manager = await loginAs(port, 'manager@example.com', 'manager-pass')
    const missing = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skills`, {
      method: 'POST',
      headers: { ...apiHeaders(manager), 'idempotency-key': 'people-missing' },
      body: JSON.stringify({
        display_name: '特定人员技能',
        summary: '目标人员不存在',
        visibility: 'people',
        people_ids: ['user-does-not-exist'],
      }),
    })
    expect(missing.status).toBe(422)
    const created = await fetch(`http://127.0.0.1:${port}/v1/admin/users`, {
      method: 'POST',
      headers: { ...apiHeaders(admin), 'idempotency-key': 'create-people-member' },
      body: JSON.stringify({
        username: 'people-member@example.com',
        display_name: '人员目标成员',
        organization_ids: ['org-alpha'],
        global_role: 'member',
        project_ids: [],
      }),
    })
    const newUser = ((await bodyOf(created)) as { user: { user_id: string } }).user.user_id
    const me = await fetch(`http://127.0.0.1:${port}/v1/admin/users/${newUser}`, { headers: apiHeaders(admin) })
    const revision = ((await bodyOf(me)) as { revision: number }).revision
    await fetch(`http://127.0.0.1:${port}/v1/admin/users/${newUser}`, {
      method: 'PATCH',
      headers: { ...apiHeaders(admin), 'if-match': String(revision), 'idempotency-key': 'suspend-people-member' },
      body: JSON.stringify({ status: 'suspended' }),
    })
    const suspendedTarget = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skills`, {
      method: 'POST',
      headers: { ...apiHeaders(manager), 'idempotency-key': 'people-suspended' },
      body: JSON.stringify({
        display_name: '特定人员技能二',
        summary: '目标人员已停用',
        visibility: 'people',
        people_ids: [newUser],
      }),
    })
    expect(suspendedTarget.status).toBe(422)
    const valid = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skills`, {
      method: 'POST',
      headers: { ...apiHeaders(manager), 'idempotency-key': 'people-valid' },
      body: JSON.stringify({
        display_name: '特定人员技能三',
        summary: '目标人员有效',
        visibility: 'people',
        people_ids: ['member-1'],
      }),
    })
    expect(valid.status).toBe(201)
  })

  it('rejects a group outside the authoring organization instead of accepting any platform group id', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const admin = await loginAs(port, 'admin@example.com', 'admin-pass')
    const created = await fetch(`http://127.0.0.1:${port}/v1/admin/users`, {
      method: 'POST',
      headers: { ...apiHeaders(admin), 'idempotency-key': 'create-beta-manager' },
      body: JSON.stringify({
        username: 'beta-manager@example.com',
        display_name: '数据平台经理',
        organization_ids: ['org-beta'],
        global_role: 'manager',
        project_ids: [],
      }),
    })
    expect(created.status).toBe(201)
    const initialPassword = ((await bodyOf(created)) as { initial_password: string }).initial_password
    const betaManager = await loginAs(port, 'beta-manager@example.com', initialPassword)
    const changePassword = await fetch(`http://127.0.0.1:${port}/v1/auth/change-password`, {
      method: 'POST',
      headers: { ...apiHeaders(betaManager), 'idempotency-key': 'beta-manager-password' },
      body: JSON.stringify({ current_password: initialPassword, new_password: 'beta-manager-pass' }),
    })
    expect(changePassword.status).toBe(200)
    const betaManagerToken = ((await bodyOf(changePassword)) as { access_token: string }).access_token

    const rejected = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skills`, {
      method: 'POST',
      headers: { ...apiHeaders(betaManagerToken), 'idempotency-key': 'cross-org-group' },
      body: JSON.stringify({
        display_name: '跨组织组技能',
        summary: '组属于 org-alpha',
        visibility: 'group',
        group_id: 'platform',
      }),
    })
    expect(rejected.status).toBe(422)
  })

  it('records the authoring organization for manager-created skills without an explicit organization id', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const manager = await loginAs(port, 'manager@example.com', 'manager-pass')
    const created = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skills`, {
      method: 'POST',
      headers: { ...apiHeaders(manager), 'idempotency-key': 'manager-org-default' },
      body: JSON.stringify({ display_name: '经理组织技能', summary: '默认归属经理组织', visibility: 'organization' }),
    })
    expect(created.status).toBe(201)
    expect(await bodyOf(created)).toMatchObject({ organization_id: 'org-alpha' })
  })
})
