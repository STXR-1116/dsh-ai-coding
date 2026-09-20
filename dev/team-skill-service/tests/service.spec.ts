import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { createTeamSkillService } from '../src/server.ts'
import { bodyOf } from './response.ts'

const services: ReturnType<typeof createTeamSkillService>[] = []
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

describe('team skill service', () => {
  it('rejects unauthenticated catalog access', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const response = await fetch(`http://127.0.0.1:${port}/v1/team-skills`)
    expect(response.status).toBe(401)
    expect(await bodyOf(response)).toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('authorizes a published artifact and accepts host lifecycle events', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const headers = { authorization: 'Bearer demo-token', 'content-type': 'application/json' }
    const catalog = await fetch(`http://127.0.0.1:${port}/v1/team-skills?project_id=project-alpha`, { headers })
    const item = ((await bodyOf(catalog)) as { items: Array<{ skill_id: string; version: string }> }).items[0]
    const authorization = await fetch(`http://127.0.0.1:${port}/v1/team-skill-installations`, {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': 'install-1' },
      body: JSON.stringify({
        skill_id: item.skill_id,
        version: item.version,
        project_id: 'project-alpha',
        scope: 'global',
        local_installation_id: 'local-1',
        environment: { dsh_version: '0.1.1', available_tools: [], available_mcp_servers: [], present_environment_variable_names: [] },
      }),
    })
    expect(authorization.status).toBe(201)
    const operation = (await bodyOf(authorization)) as { operation_id: string; artifact: { download_url: string; sha256: string } }
    const artifact = await fetch(operation.artifact.download_url, { headers: { authorization: 'Bearer demo-token' } })
    expect(artifact.status).toBe(200)
    expect((await artifact.arrayBuffer()).byteLength).toBeGreaterThan(30)
    for (const [sequence, status] of [
      [1, 'downloading'],
      [2, 'verifying'],
      [3, 'writing'],
      [4, 'refreshing'],
      [5, 'succeeded'],
    ] as const) {
      const event = await fetch(`http://127.0.0.1:${port}/v1/team-skill-installations/${operation.operation_id}/events`, {
        method: 'POST',
        headers: { ...headers, 'idempotency-key': `${operation.operation_id}:${sequence}` },
        body: JSON.stringify({ event_sequence: sequence, status }),
      })
      expect(event.status).toBe(202)
    }
    const completed = service.audits.filter(audit => audit.action === '本地安装完成')
    expect(completed).toHaveLength(1)
    expect(JSON.stringify(completed)).not.toContain('local-1')

    const auditResponse = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skill-audit-logs`, { headers: { authorization: 'Bearer admin-demo' } })
    expect(auditResponse.status).toBe(200)
    const auditRows = await bodyOf(auditResponse) as Array<{ actor_name?: string; actorName?: string }>
    expect(auditRows.some(item => item.actor_name === '演示成员')).toBe(true)
    expect(auditRows.every(item => item.actorName === undefined)).toBe(true)
  })

  it('moves a pending version through approval and publication', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const headers = { authorization: 'Bearer admin-demo', 'content-type': 'application/json' }
    const reviews = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skill-reviews`, { headers })
    const review = (
      (await bodyOf(reviews)) as Array<{ skill: { skillId: string; revision: number }; version: { version: string; revision: number } }>
    )[0]
    const checks = { 'check-1': 'pass', 'check-2': 'pass', 'check-3': 'pass' }
    const approve = await fetch(
      `http://127.0.0.1:${port}/v1/admin/team-skills/${review.skill.skillId}/versions/${review.version.version}/approve`,
      {
        method: 'POST',
        headers: {
          ...headers,
          'if-match': String(review.version.revision),
          'x-skill-revision': String(review.skill.revision),
          'idempotency-key': 'approve-1',
        },
        body: JSON.stringify({ checks }),
      },
    )
    expect(approve.status).toBe(200)
    const approved = (await bodyOf(approve)) as { skill: { revision: number }; version: { revision: number } }
    const publish = await fetch(
      `http://127.0.0.1:${port}/v1/admin/team-skills/${review.skill.skillId}/versions/${review.version.version}/publish`,
      {
        method: 'POST',
        headers: {
          ...headers,
          'if-match': String(approved.version.revision),
          'x-skill-revision': String(approved.skill.revision),
          'idempotency-key': 'publish-1',
        },
        body: '{}',
      },
    )
    expect(publish.status).toBe(200)
    const adminSkills = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skills`, { headers })
    expect(
      ((await bodyOf(adminSkills)) as Array<{ skillId: string; publishedVersions?: string[] }>).find(
        item => item.skillId === review.skill.skillId,
      )?.publishedVersions,
    ).toContain(review.version.version)
    const unboundCatalog = await fetch(`http://127.0.0.1:${port}/v1/team-skills?project_id=project-alpha`, { headers })
    expect(
      ((await bodyOf(unboundCatalog)) as { items: Array<{ skill_id: string }> }).items.map(item => item.skill_id),
    ).not.toContain(review.skill.skillId)
    const project = await fetch(`http://127.0.0.1:${port}/v1/admin/projects/project-alpha`, { headers })
    const projectRevision = ((await bodyOf(project)) as { revision: number }).revision
    const bound = await fetch(`http://127.0.0.1:${port}/v1/admin/projects/project-alpha/assets`, {
      method: 'POST',
      headers: { ...headers, 'if-match': String(projectRevision), 'idempotency-key': 'bind-review-skill' },
      body: JSON.stringify({ asset_type: 'skill', asset_id: review.skill.skillId, relation_kind: 'reference' }),
    })
    expect(bound.status).toBe(201)
    const catalog = await fetch(`http://127.0.0.1:${port}/v1/team-skills?project_id=project-alpha`, { headers })
    expect(((await bodyOf(catalog)) as { items: Array<{ skill_id: string }> }).items.map(item => item.skill_id)).toContain(
      review.skill.skillId,
    )
  })

  it('allows a manager to create a new draft version after publication', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const headers = { authorization: 'Bearer manager-demo', 'content-type': 'application/json' }
    const skills = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skills`, { headers })
    const skill = ((await bodyOf(skills)) as Array<{ skillId: string; revision: number; status: string }>).find(
      value => value.status === 'published',
    )!
    const created = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skills/${skill.skillId}/versions`, {
      method: 'POST',
      headers: { ...headers, 'if-match': String(skill.revision), 'idempotency-key': 'new-version-1' },
      body: JSON.stringify({ version: '1.1.0', release_notes: '新增检查' }),
    })
    expect(created.status).toBe(201)
    expect(await bodyOf(created)).toMatchObject({ version: { version: '1.1.0', status: 'draft' }, skill: { status: 'draft' } })
  })

  it('keeps manager and administrator operations separate', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const memberHeaders = { authorization: 'Bearer demo-token' }
    const forbidden = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skills`, { headers: memberHeaders })
    expect(forbidden.status).toBe(403)
    expect(await bodyOf(forbidden)).toMatchObject({ code: 'FORBIDDEN' })

    const authorHeaders = { authorization: 'Bearer manager-demo', 'content-type': 'application/json' }
    const created = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skills`, {
      method: 'POST',
      headers: { ...authorHeaders, 'idempotency-key': 'draft-1' },
      body: JSON.stringify({ display_name: '发布质量检查', summary: '检查发布前置条件', visibility: 'people' }),
    })
    expect(created.status).toBe(201)
    const draft = (await bodyOf(created)) as { skillId: string; revision: number; visibility: string }
    expect(draft.visibility).toBe('people')
    expect(service.skills.find(skill => skill.skillId === draft.skillId)?.peopleIds).toEqual(['manager-1'])
    const detail = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skills/${draft.skillId}`, { headers: authorHeaders })
    const detailBody = (await bodyOf(detail)) as { versions: Array<{ version: string; revision: number }> }
    const version = detailBody.versions[0]
    const submitted = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skills/${draft.skillId}/versions/${version.version}/submit-review`, {
      method: 'POST',
      headers: {
        ...authorHeaders,
        'if-match': String(version.revision),
        'x-skill-revision': String(draft.revision),
        'idempotency-key': 'submit-1',
      },
      body: '{}',
    })
    expect(submitted.status).toBe(200)
    const reviewAsAuthor = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skill-reviews`, { headers: authorHeaders })
    expect(reviewAsAuthor.status).toBe(403)
  })

  it('rejects an idempotency key reused with a different installation request', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const headers = { authorization: 'Bearer demo-token', 'content-type': 'application/json', 'idempotency-key': 'install-conflict' }
    const first = await fetch(`http://127.0.0.1:${port}/v1/team-skill-installations`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        skill_id: 'code-review',
        version: '1.0.0',
        project_id: 'project-alpha',
        scope: 'global',
        local_installation_id: 'local-1',
        environment: {},
      }),
    })
    expect(first.status).toBe(201)
    const second = await fetch(`http://127.0.0.1:${port}/v1/team-skill-installations`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        skill_id: 'code-review',
        version: '1.0.0',
        project_id: 'project-alpha',
        scope: 'project',
        local_installation_id: 'local-2',
        environment: {},
      }),
    })
    expect(second.status).toBe(409)
    expect(await bodyOf(second)).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
  })

  it('requires idempotency and revision headers for governance writes', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const headers = { authorization: 'Bearer admin-demo', 'content-type': 'application/json' }
    const skills = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skills`, { headers })
    const skill = ((await bodyOf(skills)) as Array<{ skillId: string; revision: number; currentVersion?: string }>).find(
      value => value.currentVersion === '1.0.0',
    )!
    const missingKey = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skills/${skill.skillId}/versions/1.0.0/withdraw`, {
      method: 'POST',
      headers: { ...headers, 'if-match': '1', 'x-skill-revision': String(skill.revision) },
      body: JSON.stringify({ reason: '撤回测试' }),
    })
    expect(missingKey.status).toBe(400)
    expect(await bodyOf(missingKey)).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' })
    const stale = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skills/${skill.skillId}/versions/1.0.0/withdraw`, {
      method: 'POST',
      headers: {
        ...headers,
        'if-match': String(skill.revision - 1),
        'x-skill-revision': String(skill.revision),
        'idempotency-key': 'withdraw-stale',
      },
      body: JSON.stringify({ reason: '撤回测试' }),
    })
    expect(stale.status).toBe(409)
    expect(await bodyOf(stale)).toMatchObject({ code: 'REVISION_CONFLICT' })
  })

  it('rejects lifecycle events after cancellation and records the cancellation audit', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const headers = { authorization: 'Bearer demo-token', 'content-type': 'application/json' }
    const authorization = await fetch(`http://127.0.0.1:${port}/v1/team-skill-installations`, {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': 'cancel-1' },
      body: JSON.stringify({
        skill_id: 'code-review',
        version: '1.0.0',
        project_id: 'project-alpha',
        scope: 'global',
        local_installation_id: 'local-cancel',
        environment: {},
      }),
    })
    const operation = (await bodyOf(authorization)) as { operation_id: string }
    const cancel = await fetch(`http://127.0.0.1:${port}/v1/team-skill-installations/${operation.operation_id}/cancel`, {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': 'cancel-op-1' },
      body: '{}',
    })
    expect(cancel.status).toBe(200)
    const event = await fetch(`http://127.0.0.1:${port}/v1/team-skill-installations/${operation.operation_id}/events`, {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': 'cancel-event-1' },
      body: JSON.stringify({ event_sequence: 1, status: 'downloading' }),
    })
    expect(event.status).toBe(409)
    expect(await bodyOf(event)).toMatchObject({ code: 'INVALID_STATUS' })
    expect(service.audits).toHaveLength(1)
    expect(service.audits[0]).toMatchObject({ result: 'cancelled', action: '本地安装已取消' })
  })

  it('reports only published installable releases and omits every non-published state', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const headers = { authorization: 'Bearer demo-token', 'content-type': 'application/json' }
    const review = service.skills.find(skill => skill.skillId === 'api-reliability')!
    const version = review.versions[0]
    const adminHeaders = { authorization: 'Bearer admin-demo', 'content-type': 'application/json' }
    const project = await fetch(`http://127.0.0.1:${port}/v1/admin/projects/project-alpha`, { headers: adminHeaders })
    const projectRevision = ((await bodyOf(project)) as { revision: number }).revision
    const bound = await fetch(`http://127.0.0.1:${port}/v1/admin/projects/project-alpha/assets`, {
      method: 'POST',
      headers: { ...adminHeaders, 'if-match': String(projectRevision), 'idempotency-key': 'bind-release-status' },
      body: JSON.stringify({ asset_type: 'skill', asset_id: 'api-reliability', relation_kind: 'reference' }),
    })
    expect(bound.status).toBe(201)
    const request = (items: readonly { skill_id: string; version: string }[]) =>
      fetch(`http://127.0.0.1:${port}/v1/team-skills/release-status`, {
        method: 'POST',
        headers: { ...headers, 'idempotency-key': `release-status-${items.map(item => item.version).join('-')}` },
        body: JSON.stringify({ items: items.map(item => ({ ...item, project_id: 'project-alpha' })) }),
      })

    // Non-published versions return no record at all: the response must not confirm
    // the resource's existence with a forged `withdrawn` entry.
    version.status = 'draft'
    const draft = await request([
      { skill_id: 'api-reliability', version: version.version },
      { skill_id: 'missing', version: '1.0.0' },
    ])
    expect(draft.status).toBe(200)
    expect(await bodyOf(draft)).toMatchObject({ items: [] })

    version.status = 'approved'
    const approved = await request([{ skill_id: 'api-reliability', version: version.version }])
    expect(await bodyOf(approved)).toMatchObject({ items: [] })

    // Skill status must be published too, not only the version record.
    version.status = 'published'
    const stillUnpublishedSkill = await request([{ skill_id: 'api-reliability', version: version.version }])
    expect(await bodyOf(stillUnpublishedSkill)).toMatchObject({ items: [] })

    review.status = 'published'
    review.currentVersion = version.version
    const published = await request([
      { skill_id: 'code-review', version: '1.0.0' },
      { skill_id: 'api-reliability', version: version.version },
    ])
    expect(await bodyOf(published)).toMatchObject({
      items: [
        { skill_id: 'code-review', version: '1.0.0', project_id: 'project-alpha', status: 'published' },
        { skill_id: 'api-reliability', version: '0.1.0', project_id: 'project-alpha', status: 'published' },
      ],
    })
  })

  it('requires project authorization before returning release status', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const response = await fetch(`http://127.0.0.1:${port}/v1/team-skills/release-status`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer demo-token',
        'content-type': 'application/json',
        'idempotency-key': 'release-status-cross-project',
      },
      body: JSON.stringify({ items: [{ skill_id: 'code-review', version: '1.0.0', project_id: 'project-beta' }] }),
    })
    expect(response.status).toBe(404)
    expect(await bodyOf(response)).toMatchObject({ code: 'PROJECT_NOT_MEMBER' })
  })
})
