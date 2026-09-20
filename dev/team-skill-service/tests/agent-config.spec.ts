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

interface BootedService {
  readonly port: number
  memberHeaders: Record<string, string>
  adminHeaders: Record<string, string>
}

async function boot(): Promise<BootedService> {
  const service = createTeamSkillService({ port: 0 })
  services.push(service)
  await service.listen()
  const port = (service.server.address() as AddressInfo).port
  return {
    port,
    memberHeaders: { authorization: 'Bearer demo-token', 'content-type': 'application/json' },
    adminHeaders: { authorization: 'Bearer admin-demo', 'content-type': 'application/json' },
  }
}

type ProfileVersionsRef = { agent_profile_id: string; revision: number; versions: Array<{ agent_profile_version_id: string }> }


/** 分页游走：透传服务端 cursor 直到 next_cursor 为 null。 */
async function walkList(port: number, headers: Record<string, string>, path: string): Promise<Array<Record<string, unknown>>> {
  const items: Array<Record<string, unknown>> = []
  let cursor: string | null = null
  do {
    const cursorParam = cursor === null ? '' : `cursor=${encodeURIComponent(cursor)}&`
    const res = await fetch(`http://127.0.0.1:${port}${path}${path.includes('?') ? '&' : '?'}${cursorParam}pagesize=stable`, { headers })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { items: Array<Record<string, unknown>>; next_cursor: string | null } }
    items.push(...body.data.items)
    cursor = body.data.next_cursor
  } while (cursor !== null)
  return items
}

interface VersionVersionsWire {
  readonly agent_profile_id: string
  readonly revision: number
  readonly versions: Array<{ agent_profile_version_id: string }>
}

interface ProfileRevisionWire extends VersionVersionsWire {}

interface BindingWire {
  readonly asset_id: string
  readonly asset_version_id: string
  readonly name: string
  readonly required: boolean
  readonly order: number
  readonly readiness: string
  readonly unavailable_reason: string | null
}

interface UserVersionWire {
  readonly agent_profile_id: string
  readonly agent_profile_version_id: string
  readonly name: string
  readonly description: string
  readonly version_label: string
  readonly change_summary: string
  readonly agent_type_id: string
  readonly agent_type_name: string
  readonly agent_type_key: string
  readonly agent_type_readiness: string
  readonly agent_type_capabilities: readonly string[]
  readonly model: string
  readonly reasoning: string
  readonly skills: readonly BindingWire[]
  readonly knowledge_bases: readonly BindingWire[]
  readonly memory: BindingWire | null
  readonly execution_policy: Record<string, unknown>
  readonly type_extension_config: Record<string, unknown>
  readonly readiness: string
  readonly unavailable_reason: string | null
  readonly default: boolean
  readonly status: string
  readonly created_by: string
  readonly published_at: string | null
  readonly updated_at: string
}

async function adminCreateProfile(
  port: number,
  headers: Record<string, string>,
  key: string,
  body: Record<string, unknown>,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/admin/agent-profiles`, {
    method: 'POST',
    headers: { ...headers, 'idempotency-key': key },
    body: JSON.stringify(body),
  })
  return { status: response.status, payload: (await bodyOf(response)) as Record<string, unknown> }
}

async function publishVersion(
  port: number,
  headers: Record<string, string>,
  profileId: string,
  versionId: string,
  revision: number,
  key: string,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  const response = await fetch(
    `http://127.0.0.1:${port}/v1/admin/agent-profiles/${profileId}/versions/${versionId}:publish`,
    { method: 'POST', headers: { ...headers, 'idempotency-key': key, 'if-match': String(revision) }, body: JSON.stringify({}) },
  )
  return { status: response.status, payload: (await bodyOf(response)) as Record<string, unknown> }
}

async function bindVersion(
  port: number,
  headers: Record<string, string>,
  profileId: string,
  projectId: string,
  revision: number,
  key: string,
  versionId: string,
  claimDefault: boolean,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  const response = await fetch(
    `http://127.0.0.1:${port}/v1/admin/agent-profiles/${profileId}/project-bindings/${projectId}`,
    {
      method: 'PUT',
      headers: { ...headers, 'idempotency-key': key, 'if-match': String(revision) },
      body: JSON.stringify({ agent_profile_version_id: versionId, default: claimDefault }),
    },
  )
  return { status: response.status, payload: (await bodyOf(response)) as Record<string, unknown> }
}

describe('agent config user surface', () => {
  it('exposes enriched published project profiles with card and detail fields', async () => {
    const { port, memberHeaders } = await boot()

    const types = await fetch(`http://127.0.0.1:${port}/v1/me/agent-types`, { headers: memberHeaders })
    expect(types.status).toBe(200)
    const typeItems = (await bodyOf(types)) as { items: Array<Record<string, unknown>> }
    const claude = typeItems.items.find(item => item.key === 'claude_code') as Record<string, unknown>
    expect(claude).toMatchObject({ name: 'Claude Code', readiness: 'ready' })
    expect(Array.isArray(claude.capabilities)).toBe(true)

    const payload = { items: await walkList(port, memberHeaders, '/v1/me/agent-profiles?project_id=project-alpha') } as { items: UserVersionWire[] }
    const byProfile = new Map(payload.items.map(item => [item.agent_profile_id, item]))
    expect([...byProfile.keys()].sort()).toEqual(['ap-code-default', 'ap-legacy-shell', 'ap-review-lite'])

    const mainline = byProfile.get('ap-code-default') as UserVersionWire
    expect(mainline).toMatchObject({
      agent_profile_version_id: 'apv-1',
      name: '默认研发代理',
      description: '面向研发工作空间的默认执行配置',
      version_label: 'v1',
      agent_type_name: 'Claude Code',
      agent_type_key: 'claude_code',
      agent_type_readiness: 'ready',
      model: 'deepseek-v3.2',
      reasoning: 'medium',
      readiness: 'ready',
      unavailable_reason: null,
      default: true,
      status: 'published',
      created_by: '平台管理员',
    })
    expect(mainline.published_at).not.toBeNull()
    expect(mainline.updated_at).not.toBeNull()
    expect(mainline.change_summary.length).toBeGreaterThan(0)
    expect(mainline.skills).toHaveLength(1)
    expect(mainline.skills[0]).toMatchObject({
      asset_id: 'skill:code-review',
      asset_version_id: 'skill:code-review@1.0.0',
      name: '代码评审 Skill',
      required: true,
      order: 1,
      readiness: 'ready',
      unavailable_reason: null,
    })
    expect(mainline.knowledge_bases).toHaveLength(1)
    expect(mainline.knowledge_bases[0]).toMatchObject({ asset_id: 'knowledge:k-1', required: true, readiness: 'ready' })
    expect(mainline.memory).toMatchObject({ asset_id: 'memory:m-1', name: '记忆库 m-1（协作偏好）', required: true })
    expect(mainline.execution_policy).toMatchObject({ permission_mode: 'approval', write_mode: 'write' })
    expect(mainline.type_extension_config).toMatchObject({ permission_mode: 'approval' })

    const degraded = byProfile.get('ap-review-lite') as UserVersionWire
    expect(degraded.readiness).toBe('degraded')
    expect(degraded.unavailable_reason).toContain('废弃')
    expect(degraded.default).toBe(false)

    const unavailable = byProfile.get('ap-legacy-shell') as UserVersionWire
    expect(unavailable.readiness).toBe('unavailable')
    expect(unavailable.agent_type_readiness).toBe('unavailable')
    expect(unavailable.unavailable_reason).toContain('Agent 类型')

    const detail = await fetch(`http://127.0.0.1:${port}/v1/me/agent-profiles/apv-1`, { headers: memberHeaders })
    expect(detail.status).toBe(200)
    const detailBody = await detail.text()
    const parsedDetail = JSON.parse(detailBody) as { data: UserVersionWire }
    const profile = parsedDetail.data
    expect(profile.agent_profile_version_id).toBe('apv-1')
    expect(profile.skills.map(skill => skill.asset_version_id)).toEqual(['skill:code-review@1.0.0'])
    // The user surface never carries credential references — those stay on the admin surface.
    expect(detailBody).not.toContain('credential_ref')
    expect(detailBody).not.toMatch(/secret|password|api[_-]?key|access[_-]?token|prompt_text/i)

    const draft = await fetch(`http://127.0.0.1:${port}/v1/me/agent-profiles/apv-hermes-draft`, { headers: memberHeaders })
    expect(draft.status).toBe(404)
  })

  it('serves per-type schemas and rejects unauthorized schema reads', async () => {
    const { port, memberHeaders, adminHeaders } = await boot()
    const adminTypes = await fetch(`http://127.0.0.1:${port}/v1/admin/agent-types`, { headers: adminHeaders })
    expect(adminTypes.status).toBe(200)
    const typeItems = (await bodyOf(adminTypes)) as {
      items: Array<{
        agent_type_id: string
        key: string
        schema_version: string
        schema: Array<Record<string, unknown>>
      }>
    }
    const claude = typeItems.items.find(item => item.key === 'claude_code')
    const hermes = typeItems.items.find(item => item.key === 'hermes')
    expect(claude?.schema_version).toBe('1')
    expect(claude?.schema.map(field => field.key)).toContain('permission_mode')
    expect(hermes?.schema.map(field => field.key)).toContain('profile')
    expect(claude?.schema.map(field => field.key)).not.toContain('profile')

    const schema = await fetch(`http://127.0.0.1:${port}/v1/admin/agent-types/at-claude-code/schema`, { headers: adminHeaders })
    expect(schema.status).toBe(200)
    const schemaBody = (await bodyOf(schema)) as {
      agent_type_id: string
      schema_version: string
      schema: Array<{ key: string; type: string; required: boolean; affects_publish: boolean }>
    }
    expect(schemaBody.agent_type_id).toBe('at-claude-code')
    const permission = schemaBody.schema.find(field => field.key === 'permission_mode')
    expect(permission).toMatchObject({ type: 'enum', required: true, affects_publish: true })

    const denied = await fetch(`http://127.0.0.1:${port}/v1/admin/agent-types/at-claude-code/schema`, { headers: memberHeaders })
    expect(denied.status).toBe(403)
  })

  it('exposes asset candidates with authorization, readiness and invalid reasons', async () => {
    const { port, memberHeaders, adminHeaders } = await boot()
    const candidateRows = await walkList(port, adminHeaders, '/v1/admin/asset-candidates?project_id=project-alpha')
    expect(candidateRows.length).toBeGreaterThan(0)
    type CandidateRow = {
      asset_id: string
      asset_type: string
      version: string
      name: string
      authorized: boolean
      readiness: string
      invalid_reason: string | null
    }
    const payload = { items: candidateRows as CandidateRow[] }
    const codeReview = payload.items.find(item => item.asset_id === 'skill:code-review@1.0.0')
    expect(codeReview).toMatchObject({ asset_type: 'skill', authorized: true, readiness: 'ready', invalid_reason: null })
    const deprecated = payload.items.find(item => item.asset_id === 'skill:code-review@0.9.0')
    expect(deprecated).toMatchObject({ authorized: true, readiness: 'unavailable' })
    expect(deprecated?.invalid_reason).toContain('废弃')
    const offline = payload.items.find(item => item.asset_id === 'knowledge:k-3@v1')
    expect(offline?.readiness).toBe('unavailable')

    const missingProject = await fetch(`http://127.0.0.1:${port}/v1/admin/asset-candidates`, { headers: adminHeaders })
    expect(missingProject.status).toBe(422)
    const memberDenied = await fetch(`http://127.0.0.1:${port}/v1/admin/asset-candidates?project_id=project-alpha`, {
      headers: memberHeaders,
    })
    expect(memberDenied.status).toBe(403)
  })
})

describe('agent config governance lifecycle', () => {
  it('runs draft → version → publish → bind → default switch → unbind → archive with audit rows', async () => {
    const { port, adminHeaders, memberHeaders } = await boot()
    const created = await adminCreateProfile(port, adminHeaders, 'ac-create-1', {
      name: '生命周期代理',
      description: '全流程验收配置',
      agent_type_id: 'at-claude-code',
      model: 'deepseek-v3.2',
      credential_ref: { name: 'deepseek-main', kind: 'api_key' },
      reasoning: 'medium',
      asset_bindings: {
        skills: [{ asset_version_id: 'skill:code-review@1.0.0', required: true }],
        knowledge_bases: [{ asset_version_id: 'knowledge:k-1', required: true }],
        memory: { asset_version_id: 'memory:m-1', required: true },
      },
      execution_policy: { permission_mode: 'approval', write_mode: 'write', max_concurrency: 2 },
      credential_ref: { name: 'deepseek-main', kind: 'api_key' },
      type_extension_config: { permission_mode: 'approval' },
    })
    expect(created.status).toBe(201)
    const profile = created.payload as {
      agent_profile_id: string
      revision: number
      status: string
      created_by: string
      created_at: string
      updated_at: string
    }
    expect(profile.status).toBe('draft')
    expect(profile.created_by).toBe('平台管理员')
    expect(profile.created_at.length).toBeGreaterThan(0)

    const saved = await fetch(`http://127.0.0.1:${port}/v1/admin/agent-profiles/${profile.agent_profile_id}`, {
      method: 'PUT',
      headers: { ...adminHeaders, 'idempotency-key': 'ac-save-1', 'if-match': String(profile.revision) },
      body: JSON.stringify({ reasoning: 'high' }),
    })
    expect(saved.status).toBe(200)
    const savedBody = (await bodyOf(saved)) as { revision: number }

    const version = await fetch(`http://127.0.0.1:${port}/v1/admin/agent-profiles/${profile.agent_profile_id}/versions`, {
      method: 'POST',
      headers: { ...adminHeaders, 'idempotency-key': 'ac-version-1', 'if-match': String(savedBody.revision) },
      body: JSON.stringify({ change_summary: '提高推理档位' }),
    })
    expect(version.status).toBe(201)
    const versionRecord = (await bodyOf(version)) as { agent_profile_version_id: string }

    const published = await publishVersion(
      port,
      adminHeaders,
      profile.agent_profile_id,
      versionRecord.agent_profile_version_id,
      savedBody.revision + 1,
      'ac-publish-1',
    )
    expect(published.status).toBe(200)

    const bound = await bindVersion(
      port,
      adminHeaders,
      profile.agent_profile_id,
      'project-alpha',
      savedBody.revision + 2,
      'ac-bind-1',
      versionRecord.agent_profile_version_id,
      true,
    )
    expect(bound.status).toBe(200)
    expect(bound.payload).toMatchObject({ project_id: 'project-alpha', default: true })

    const second = await adminCreateProfile(port, adminHeaders, 'ac-create-2', {
      name: '默认切换代理',
      agent_type_id: 'at-claude-code',
      model: 'deepseek-v3.2',
      reasoning: 'low',
      credential_ref: { name: 'deepseek-main', kind: 'api_key' },
      asset_bindings: { skills: [{ asset_version_id: 'skill:code-review@1.0.0', required: true }], knowledge_bases: [], memory: null },
      type_extension_config: { permission_mode: 'read_only' },
    })
    expect(second.status).toBe(201)
    const secondVersions = (second.payload as VersionVersionsWire).versions
    const secondVersionId = secondVersions[0].agent_profile_version_id
    const secondProfile = second.payload as ProfileRevisionWire
    const secondPublished = await publishVersion(
      port,
      adminHeaders,
      secondProfile.agent_profile_id,
      secondVersionId,
      secondProfile.revision,
      'ac-publish-2',
    )
    expect(secondPublished.status).toBe(200)
    const secondBound = await bindVersion(
      port,
      adminHeaders,
      secondProfile.agent_profile_id,
      'project-alpha',
      secondProfile.revision + 1,
      'ac-bind-2',
      secondVersionId,
      true,
    )
    expect(secondBound.status).toBe(200)

    const firstDetailUrl = `http://127.0.0.1:${port}/v1/admin/agent-profiles/${profile.agent_profile_id}`
    const firstDetail = await fetch(firstDetailUrl, { headers: adminHeaders })
    const firstBody = (await bodyOf(firstDetail)) as {
      project_bindings: Array<{ project_id: string; default: boolean }>
    }
    expect(firstBody.project_bindings.find(binding => binding.project_id === 'project-alpha')?.default).toBe(false)

    const userItems = await walkList(port, memberHeaders, '/v1/me/agent-profiles?project_id=project-alpha')
    expect((userItems as unknown as UserVersionWire[]).filter(item => item.default)).toHaveLength(1)

    const unboundUrl = `http://127.0.0.1:${port}/v1/admin/agent-profiles/${secondProfile.agent_profile_id}/project-bindings/project-alpha`
    const unbound = await fetch(unboundUrl, {
      method: 'DELETE',
      headers: { ...adminHeaders, 'idempotency-key': 'ac-unbind-1', 'if-match': String(secondProfile.revision + 2) },
      body: JSON.stringify({}),
    })
    expect(unbound.status).toBe(200)

    const archived = await fetch(
      `http://127.0.0.1:${port}/v1/admin/agent-profiles/${secondProfile.agent_profile_id}/versions/${secondVersionId}:archive`,
      {
        method: 'POST',
        headers: { ...adminHeaders, 'idempotency-key': 'ac-archive-1', 'if-match': String(secondProfile.revision + 3) },
        body: JSON.stringify({}),
      },
    )
    expect(archived.status).toBe(200)
    const archivedBody = (await bodyOf(archived)) as { status: string }
    expect(archivedBody.status).toBe('archived')

    const auditsUrl = `http://127.0.0.1:${port}/v1/admin/audits?agent_profile_id=${profile.agent_profile_id}`
    const audits = await fetch(auditsUrl, { headers: adminHeaders })
    type LifecycleAuditRow = {
      action: string
      result: string
      actor_name: string
      request_id: string
      revision: number | null
      agent_profile_version_id: string | null
      asset_version_ids: readonly string[] | null
      error_code: string | null
    }
    const auditRows = (await bodyOf(audits)) as LifecycleAuditRow[]
    const actions = auditRows.map(row => row.action)
    expect(actions).toContain('agent_profile.create')
    expect(actions).toContain('agent_profile.update')
    expect(actions).toContain('agent_profile.version.create')
    expect(actions).toContain('agent_profile.version.publish')
    expect(actions).toContain('agent_profile.bind')
    for (const row of auditRows) {
      expect(row.actor_name).toBe('平台管理员')
      expect(row.request_id.length).toBeGreaterThan(0)
      expect(row.result).toBe('succeeded')
    }
    const publishRow = auditRows.find(row => row.action === 'agent_profile.version.publish')
    expect(publishRow?.agent_profile_version_id).toBe(versionRecord.agent_profile_version_id)
    expect(Array.isArray(publishRow?.asset_version_ids)).toBe(true)
  })

  it('clones a profile into a fresh draft without bindings or published state', async () => {
    const { port, adminHeaders } = await boot()
    const created = await adminCreateProfile(port, adminHeaders, 'ac-clone-src', {
      name: '克隆源代理',
      agent_type_id: 'at-claude-code',
      model: 'deepseek-v3.2',
      reasoning: 'medium',
      asset_bindings: { skills: [{ asset_version_id: 'skill:code-review@1.0.0', required: true }], knowledge_bases: [], memory: null },
      credential_ref: { name: 'deepseek-main', kind: 'api_key' },
      type_extension_config: { permission_mode: 'approval' },
    })
    const source = created.payload as { agent_profile_id: string; revision: number; versions: Array<{ agent_profile_version_id: string }> }
    const published = await publishVersion(
      port,
      adminHeaders,
      source.agent_profile_id,
      source.versions[0].agent_profile_version_id,
      source.revision,
      'ac-clone-publish',
    )
    expect(published.status).toBe(200)
    const bound = await bindVersion(
      port,
      adminHeaders,
      source.agent_profile_id,
      'project-alpha',
      source.revision + 1,
      'ac-clone-bind',
      source.versions[0].agent_profile_version_id,
      false,
    )
    expect(bound.status).toBe(200)

    const cloned = await fetch(`http://127.0.0.1:${port}/v1/admin/agent-profiles/${source.agent_profile_id}:clone`, {
      method: 'POST',
      headers: { ...adminHeaders, 'idempotency-key': 'ac-clone-1' },
      body: JSON.stringify({}),
    })
    expect(cloned.status).toBe(201)
    type CloneVersionWire = {
      status: string
      model: string
      asset_version_ids: readonly string[]
      credential_ref: Record<string, unknown> | null
    }
    const clone = (await bodyOf(cloned)) as {
      agent_profile_id: string
      name: string
      status: string
      project_bindings: unknown[]
      versions: CloneVersionWire[]
    }
    expect(clone.agent_profile_id).not.toBe(source.agent_profile_id)
    expect(clone.status).toBe('draft')
    expect(clone.name).toContain('克隆源代理')
    expect(clone.project_bindings).toHaveLength(0)
    expect(clone.versions).toHaveLength(1)
    expect(clone.versions[0]).toMatchObject({ status: 'draft', model: 'deepseek-v3.2' })
    expect(clone.versions[0].asset_version_ids).toEqual(['skill:code-review@1.0.0'])
    expect(clone.versions[0].credential_ref).toMatchObject({ name: 'deepseek-main' })

    const audits = await fetch(`http://127.0.0.1:${port}/v1/admin/audits?action=agent_profile.clone`, { headers: adminHeaders })
    const rows = (await bodyOf(audits)) as Array<{ action: string; agent_profile_id: string | null; actor_name: string }>
    expect(rows.some(row => row.action === 'agent_profile.clone' && row.agent_profile_id === clone.agent_profile_id
      && row.actor_name === '平台管理员')).toBe(true)
  })

  it('requires If-Match for version creation and rejects stale revisions', async () => {
    const { port, adminHeaders } = await boot()
    const created = await adminCreateProfile(port, adminHeaders, 'ac-ifmatch-src', {
      name: '乐观锁代理',
      agent_type_id: 'at-claude-code',
      model: 'deepseek-v3.2',
      reasoning: 'medium',
    })
    const profile = created.payload as { agent_profile_id: string; revision: number }

    const missing = await fetch(`http://127.0.0.1:${port}/v1/admin/agent-profiles/${profile.agent_profile_id}/versions`, {
      method: 'POST',
      headers: { ...adminHeaders, 'idempotency-key': 'ac-ifmatch-missing' },
      body: JSON.stringify({ change_summary: '缺少 If-Match' }),
    })
    expect(missing.status).toBe(409)
    expect(await bodyOf(missing)).toMatchObject({ code: 'REVISION_CONFLICT' })

    const stale = await fetch(`http://127.0.0.1:${port}/v1/admin/agent-profiles/${profile.agent_profile_id}/versions`, {
      method: 'POST',
      headers: { ...adminHeaders, 'idempotency-key': 'ac-ifmatch-stale', 'if-match': String(profile.revision + 5) },
      body: JSON.stringify({ change_summary: '过期 revision' }),
    })
    expect(stale.status).toBe(409)

    const current = await fetch(`http://127.0.0.1:${port}/v1/admin/agent-profiles/${profile.agent_profile_id}/versions`, {
      method: 'POST',
      headers: { ...adminHeaders, 'idempotency-key': 'ac-ifmatch-current', 'if-match': String(profile.revision) },
      body: JSON.stringify({ change_summary: '正确 revision' }),
    })
    expect(current.status).toBe(201)
  })

  it('validates write payloads: bad JSON, missing fields, wrong types, schema violations, unknown credentials', async () => {
    const { port, adminHeaders } = await boot()
    const badJson = await fetch(`http://127.0.0.1:${port}/v1/admin/agent-profiles`, {
      method: 'POST',
      headers: { ...adminHeaders, 'idempotency-key': 'ac-bad-json' },
      body: '{"name": "broken"',
    })
    expect(badJson.status).toBe(400)
    expect(await bodyOf(badJson)).toMatchObject({ code: 'INVALID_RESPONSE' })

    const missingName = await adminCreateProfile(port, adminHeaders, 'ac-missing-name', { agent_type_id: 'at-claude-code' })
    expect(missingName.status).toBe(422)
    expect(missingName.payload).toMatchObject({ code: 'VALIDATION_ERROR' })

    const wrongType = await adminCreateProfile(port, adminHeaders, 'ac-wrong-type', { name: 42, agent_type_id: 'at-claude-code' })
    expect(wrongType.status).toBe(422)

    const unknownType = await adminCreateProfile(port, adminHeaders, 'ac-unknown-type', { name: '未知类型', agent_type_id: 'at-nope' })
    expect(unknownType.status).toBe(422)

    const badBindings = await adminCreateProfile(port, adminHeaders, 'ac-bad-bindings', {
      name: '坏绑定',
      agent_type_id: 'at-claude-code',
      asset_bindings: { skills: [{ asset_version_id: 'skill:code-review@1.0.0' }] },
    })
    expect(badBindings.status).toBe(422)

    const badExtension = await adminCreateProfile(port, adminHeaders, 'ac-bad-extension', {
      name: '坏扩展',
      agent_type_id: 'at-claude-code',
      type_extension_config: { not_in_schema: true },
    })
    expect(badExtension.status).toBe(422)

    const badEnum = await adminCreateProfile(port, adminHeaders, 'ac-bad-enum', {
      name: '坏枚举',
      agent_type_id: 'at-claude-code',
      type_extension_config: { permission_mode: 'turbo' },
    })
    expect(badEnum.status).toBe(422)

    const unknownCredential = await adminCreateProfile(port, adminHeaders, 'ac-bad-credential', {
      name: '坏凭据',
      agent_type_id: 'at-claude-code',
      credential_ref: { name: 'no-such-credential', kind: 'api_key' },
    })
    expect(unknownCredential.status).toBe(422)
  })

  it('blocks publish on unavailable assets, unauthorized binding assets, credential not ready and unavailable agent types', async () => {
    const { port, adminHeaders } = await boot()

    const offlineAsset = await adminCreateProfile(port, adminHeaders, 'ac-block-asset', {
      name: '下线知识库代理',
      agent_type_id: 'at-claude-code',
      model: 'deepseek-v3.2',
      asset_bindings: { skills: [], knowledge_bases: [{ asset_version_id: 'knowledge:k-3', required: true }], memory: null },
      type_extension_config: { permission_mode: 'approval' },
    })
    const offlineProfile = offlineAsset.payload as ProfileVersionsRef
    const blockedAsset = await publishVersion(
      port,
      adminHeaders,
      offlineProfile.agent_profile_id,
      offlineProfile.versions[0].agent_profile_version_id,
      offlineProfile.revision,
      'ac-block-asset-publish',
    )
    expect(blockedAsset.status).toBe(422)
    expect(blockedAsset.payload).toMatchObject({ code: 'ASSET_NOT_READY' })
    expect(JSON.stringify(blockedAsset.payload)).toContain('下线')

    const notReadyCredential = await adminCreateProfile(port, adminHeaders, 'ac-block-credential', {
      name: '备用凭据代理',
      agent_type_id: 'at-claude-code',
      model: 'deepseek-v3.2',
      asset_bindings: { skills: [{ asset_version_id: 'skill:code-review@1.0.0', required: true }], knowledge_bases: [], memory: null },
      credential_ref: { name: 'deepseek-backup', kind: 'api_key' },
      type_extension_config: { permission_mode: 'approval' },
    })
    const credentialProfile = notReadyCredential.payload as ProfileVersionsRef
    const blockedCredential = await publishVersion(
      port,
      adminHeaders,
      credentialProfile.agent_profile_id,
      credentialProfile.versions[0].agent_profile_version_id,
      credentialProfile.revision,
      'ac-block-credential-publish',
    )
    expect(blockedCredential.status).toBe(422)
    expect(blockedCredential.payload).toMatchObject({ code: 'CREDENTIAL_NOT_READY' })

    const legacyType = await adminCreateProfile(port, adminHeaders, 'ac-block-type', {
      name: '退役类型代理',
      agent_type_id: 'at-legacy-shell',
      type_extension_config: {},
    })
    const legacyProfile = legacyType.payload as ProfileVersionsRef
    const blockedType = await publishVersion(
      port,
      adminHeaders,
      legacyProfile.agent_profile_id,
      legacyProfile.versions[0].agent_profile_version_id,
      legacyProfile.revision,
      'ac-block-type-publish',
    )
    expect(blockedType.status).toBe(422)
    expect(blockedType.payload).toMatchObject({ code: 'AGENT_TYPE_UNAVAILABLE' })

    const mainline = await fetch(`http://127.0.0.1:${port}/v1/admin/agent-profiles/ap-code-default`, { headers: adminHeaders })
    const mainlineBody = (await bodyOf(mainline)) as {
      revision: number
      versions: Array<{ agent_profile_version_id: string; status: string }>
    }
    const publishedVersion = mainlineBody.versions.find(version => version.status === 'published')
    // Cross-organization targets reject before assets are even considered.
    const crossOrg = await bindVersion(
      port,
      adminHeaders,
      'ap-code-default',
      'project-beta',
      mainlineBody.revision,
      'ac-block-bind-org',
      publishedVersion?.agent_profile_version_id ?? '',
      false,
    )
    expect(crossOrg.status).toBe(422)
    expect(crossOrg.payload).toMatchObject({ code: 'VALIDATION_ERROR' })
    // A same-organization project without the asset authorization rejects the binding.
    const newProject = await fetch(`http://127.0.0.1:${port}/v1/admin/projects`, {
      method: 'POST',
      headers: { ...adminHeaders, 'idempotency-key': 'ac-project-1' },
      body: JSON.stringify({ organization_id: 'org-alpha', name: '资产授权校验项目' }),
    })
    expect(newProject.status).toBe(201)
    const project = (await bodyOf(newProject)) as { project_id: string; revision: number }
    const activated = await fetch(`http://127.0.0.1:${port}/v1/admin/projects/${project.project_id}:activate`, {
      method: 'POST',
      headers: { ...adminHeaders, 'idempotency-key': 'ac-project-activate', 'if-match': String(project.revision) },
      body: '{}',
    })
    expect(activated.status).toBe(200)
    const crossProject = await bindVersion(
      port,
      adminHeaders,
      'ap-code-default',
      project.project_id,
      mainlineBody.revision,
      'ac-block-bind',
      publishedVersion?.agent_profile_version_id ?? '',
      false,
    )
    expect(crossProject.status).toBe(422)
    expect(crossProject.payload).toMatchObject({ code: 'ASSET_NOT_AUTHORIZED' })
  })

  it('records failed governance as audit rows with actor and error codes', async () => {
    const { port, memberHeaders, adminHeaders } = await boot()
    const memberDenied = await adminCreateProfile(
      port,
      memberHeaders,
      'ac-member-denied',
      { name: '越权代理', agent_type_id: 'at-claude-code' },
    )
    expect(memberDenied.status).toBe(403)
    expect(memberDenied.payload).toMatchObject({ code: 'FORBIDDEN' })

    const conflict = await fetch(`http://127.0.0.1:${port}/v1/admin/agent-profiles/ap-code-default`, {
      method: 'PUT',
      headers: { ...adminHeaders, 'idempotency-key': 'ac-conflict', 'if-match': '999' },
      body: JSON.stringify({ reasoning: 'low' }),
    })
    expect(conflict.status).toBe(409)
    expect(await bodyOf(conflict)).toMatchObject({ code: 'REVISION_CONFLICT' })

    const first = await adminCreateProfile(port, adminHeaders, 'ac-idem-key', { name: '幂等代理', agent_type_id: 'at-claude-code' })
    expect(first.status).toBe(201)
    const replay = await adminCreateProfile(port, adminHeaders, 'ac-idem-key', { name: '幂等代理', agent_type_id: 'at-claude-code' })
    expect(replay.status).toBe(201)
    expect(replay.payload).toEqual(first.payload)
    const conflictBody = await adminCreateProfile(port, adminHeaders, 'ac-idem-key', { name: '幂等代理改', agent_type_id: 'at-claude-code' })
    expect(conflictBody.status).toBe(409)
    expect(conflictBody.payload).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })

    const audits = await fetch(`http://127.0.0.1:${port}/v1/admin/audits?action=agent_profile.create`, { headers: adminHeaders })
    const rows = (await bodyOf(audits)) as Array<{
      result: string
      error_code: string | null
      actor_name: string
      agent_profile_id: string | null
    }>
    // A member is refused at the admin-surface gate; the refusal is audited with the caller's identity.
    const memberAudits = await fetch(`http://127.0.0.1:${port}/v1/admin/audits?actor_user_id=member-1`, { headers: adminHeaders })
    const memberRows = (await bodyOf(memberAudits)) as Array<{
      action: string
      result: string
      error_code: string | null
      actor_name: string
    }>
    expect(memberRows.some(row => row.result === 'failed' && row.error_code === 'FORBIDDEN' && row.actor_name === '演示成员')).toBe(true)
    expect(rows.some(row => row.result === 'failed' && row.error_code === 'IDEMPOTENCY_CONFLICT')).toBe(true)
    const conflictAudit = await fetch(`http://127.0.0.1:${port}/v1/admin/audits?action=agent_profile.update`, { headers: adminHeaders })
    const updateRows = (await bodyOf(conflictAudit)) as Array<{ result: string; error_code: string | null }>
    expect(updateRows.some(row => row.result === 'failed' && row.error_code === 'REVISION_CONFLICT')).toBe(true)
  })

  it('emits agent_profile stream events for governance mutations', async () => {
    const { port, adminHeaders } = await boot()
    const stream = await fetch(`http://127.0.0.1:${port}/v1/admin/events/stream`, {
      headers: { authorization: 'Bearer admin-demo', accept: 'text/event-stream' },
    })
    expect(stream.headers.get('content-type')).toContain('text/event-stream')

    const created = await adminCreateProfile(port, adminHeaders, 'ac-event-create', {
      name: '事件代理',
      agent_type_id: 'at-claude-code',
      model: 'deepseek-v3.2',
      credential_ref: { name: 'deepseek-main', kind: 'api_key' },
      type_extension_config: { permission_mode: 'approval' },
    })
    const profile = created.payload as { agent_profile_id: string; revision: number; versions: Array<{ agent_profile_version_id: string }> }
    const published = await publishVersion(
      port,
      adminHeaders,
      profile.agent_profile_id,
      profile.versions[0].agent_profile_version_id,
      profile.revision,
      'ac-event-publish',
    )
    expect(published.status).toBe(200)
    const bound = await bindVersion(
      port,
      adminHeaders,
      profile.agent_profile_id,
      'project-alpha',
      profile.revision + 1,
      'ac-event-bind',
      profile.versions[0].agent_profile_version_id,
      false,
    )
    expect(bound.status).toBe(200)

    const reader = stream.body?.getReader()
    if (reader === undefined) throw new Error('SSE response has no body')
    const decoder = new TextDecoder()
    let buffered = ''
    const eventTypes: string[] = []
    try {
      for (let i = 0; i < 400 && !eventTypes.includes('agent_profile.bound'); i += 1) {
        const { done, value } = await reader.read()
        if (done) break
        buffered += decoder.decode(value, { stream: true })
        let boundary = buffered.indexOf('\n\n')
        while (boundary !== -1) {
          const frame = buffered.slice(0, boundary)
          buffered = buffered.slice(boundary + 2)
          const eventLine = frame.split('\n').find(line => line.startsWith('event: '))
          const dataLine = frame.split('\n').find(line => line.startsWith('data: '))
          if (eventLine !== undefined && dataLine !== undefined) {
            const data = JSON.parse(dataLine.slice('data: '.length)) as { resource_type?: string; resource_id?: string }
            if (data.resource_type === 'agent_profile' && data.resource_id === profile.agent_profile_id) {
              eventTypes.push(eventLine.slice('event: '.length))
            }
          }
          boundary = buffered.indexOf('\n\n')
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
    expect(eventTypes).toContain('agent_profile.created')
    expect(eventTypes).toContain('agent_profile.published')
    expect(eventTypes).toContain('agent_profile.bound')
  })

  it('derives user readiness, filters unavailable run overrides and enforces policy write modes', async () => {
    const { port, memberHeaders, adminHeaders } = await boot()
    const ready = await fetch(`http://127.0.0.1:${port}/v1/workspaces/ws-alpha-1`, { headers: memberHeaders })
    expect(ready.status).toBe(200)

    const unavailableOverride = await fetch(`http://127.0.0.1:${port}/v1/workspaces/ws-alpha-1/runs`, {
      method: 'POST',
      headers: { ...memberHeaders, 'idempotency-key': 'ac-run-unavailable' },
      body: JSON.stringify({
        session_id: 'sess-agent-config',
        write_mode: 'read_only',
        expected_workspace_revision: 7,
        agent_profile_version_id: 'apv-legacy-1',
      }),
    })
    expect(unavailableOverride.status).toBe(422)
    expect(await bodyOf(unavailableOverride)).toMatchObject({ code: 'AGENT_TYPE_UNAVAILABLE' })

    const degradedOverride = await fetch(`http://127.0.0.1:${port}/v1/workspaces/ws-alpha-1/runs`, {
      method: 'POST',
      headers: { ...memberHeaders, 'idempotency-key': 'ac-run-degraded' },
      body: JSON.stringify({
        session_id: 'sess-agent-config',
        write_mode: 'read_only',
        expected_workspace_revision: 7,
        agent_profile_version_id: 'apv-lite-1',
      }),
    })
    expect(degradedOverride.status).toBe(202)
    const run = (await bodyOf(degradedOverride)) as { execution_policy: Record<string, unknown>; agent_profile_version_id: string }
    expect(run.agent_profile_version_id).toBe('apv-lite-1')
    expect(run.execution_policy).toMatchObject({ write_mode: 'read_only' })

    const writeEscalation = await fetch(`http://127.0.0.1:${port}/v1/workspaces/ws-alpha-1/runs`, {
      method: 'POST',
      headers: { ...memberHeaders, 'idempotency-key': 'ac-run-escalate' },
      body: JSON.stringify({
        session_id: 'sess-agent-config',
        write_mode: 'write',
        expected_workspace_revision: 7,
        agent_profile_version_id: 'apv-lite-1',
      }),
    })
    expect(writeEscalation.status).toBe(422)
    expect(await bodyOf(writeEscalation)).toMatchObject({ code: 'VALIDATION_ERROR' })

    const unavailableWorkspace = await fetch(`http://127.0.0.1:${port}/v1/projects/project-alpha/workspaces`, {
      method: 'POST',
      headers: { ...memberHeaders, 'idempotency-key': 'ac-ws-unavailable' },
      body: JSON.stringify({ repository_id: 'repo-1', branch: 'main', agent_profile_version_id: 'apv-legacy-1' }),
    })
    expect(unavailableWorkspace.status).toBe(422)
    expect(await bodyOf(unavailableWorkspace)).toMatchObject({ code: 'AGENT_TYPE_UNAVAILABLE' })

    const audits = await fetch(`http://127.0.0.1:${port}/v1/admin/audits?action=run.create`, { headers: adminHeaders })
    const rows = (await bodyOf(audits)) as Array<{ result: string; error_code: string | null }>
    expect(rows.some(row => row.result === 'failed' && row.error_code === 'AGENT_TYPE_UNAVAILABLE')).toBe(true)
    expect(rows.some(row => row.result === 'failed' && row.error_code === 'VALIDATION_ERROR')).toBe(true)
  })

  it('exposes admin card enrichment fields and structured asset ids', async () => {
    const { port, adminHeaders } = await boot()
    const list = await fetch(`http://127.0.0.1:${port}/v1/admin/agent-profiles`, { headers: adminHeaders })
    expect(list.status).toBe(200)
    const items = (await bodyOf(list)) as {
      items: Array<{
        agent_type_name: string
        agent_type_readiness: string
        description: string
        skill_count: number
        knowledge_count: number
        memory_name: string | null
        project_count: number
        versions: Array<{
          asset_bindings: {
            skills: Array<{ asset_id: string; asset_version_id: string; required: boolean }>
            knowledge_bases: Array<{ asset_id: string }>
            memory: { asset_id: string } | null
          }
        }>
      }>
    }
    const mainline = items.items.find(item => item.agent_profile_id === 'ap-code-default')
    expect(mainline).toBeDefined()
    expect(mainline?.agent_type_name).toBe('Claude Code')
    expect(mainline?.agent_type_readiness).toBe('ready')
    expect(mainline?.description).toContain('默认执行配置')
    expect(mainline?.skill_count).toBeGreaterThan(0)
    expect(mainline?.knowledge_count).toBeGreaterThan(0)
    expect(mainline?.memory_name).toContain('记忆库 m-1')
    expect(mainline?.project_count).toBe(1)
    const binding = mainline?.versions[0].asset_bindings.skills[0]
    expect(binding?.asset_id).toBe('skill:code-review')
    expect(binding?.asset_version_id).toBe('skill:code-review@1.0.0')
  })

  it('serves asset candidates with their update timestamps', async () => {
    const { port, adminHeaders } = await boot()
    const candidates = await fetch(`http://127.0.0.1:${port}/v1/admin/asset-candidates?project_id=project-alpha`, {
      headers: adminHeaders,
    })
    expect(candidates.status).toBe(200)
    const payload = (await bodyOf(candidates)) as { items: Array<{ updated_at: string }> }
    expect(payload.items.length).toBeGreaterThan(0)
    expect(payload.items.every(item => typeof item.updated_at === 'string' && item.updated_at.length > 0)).toBe(true)
  })

  it('validates execution policy members and requires a model before publish', async () => {
    const { port, adminHeaders } = await boot()
    const badPolicy = await adminCreateProfile(port, adminHeaders, 'ac-bad-policy', {
      name: '坏策略代理',
      agent_type_id: 'at-claude-code',
      model: 'deepseek-v3.2',
      reasoning: 'medium',
      execution_policy: { tool_allowlist: 'read,write' },
      type_extension_config: { permission_mode: 'approval' },
    })
    expect(badPolicy.status).toBe(422)
    expect(badPolicy.payload).toMatchObject({ code: 'VALIDATION_ERROR' })

    const badTimeout = await adminCreateProfile(port, adminHeaders, 'ac-bad-timeout', {
      name: '坏超时代理',
      agent_type_id: 'at-claude-code',
      model: 'deepseek-v3.2',
      reasoning: 'medium',
      execution_policy: { timeout_ms: -5 },
      type_extension_config: { permission_mode: 'approval' },
    })
    expect(badTimeout.status).toBe(422)

    const noModel = await adminCreateProfile(port, adminHeaders, 'ac-no-model', {
      name: '无模型代理',
      agent_type_id: 'at-claude-code',
      asset_bindings: { skills: [{ asset_version_id: 'skill:code-review@1.0.0', required: true }], knowledge_bases: [], memory: null },
      type_extension_config: { permission_mode: 'approval' },
    })
    expect(noModel.status).toBe(201)
    const noModelProfile = noModel.payload as ProfileVersionsRef
    const blocked = await publishVersion(
      port,
      adminHeaders,
      noModelProfile.agent_profile_id,
      noModelProfile.versions[0].agent_profile_version_id,
      noModelProfile.revision,
      'ac-no-model-publish',
    )
    expect(blocked.status).toBe(422)
    expect(JSON.stringify(blocked.payload)).toContain('模型')
  })

  it('rejects binding to projects that are not active', async () => {
    const { port, adminHeaders } = await boot()
    const mainline = await fetch(`http://127.0.0.1:${port}/v1/admin/agent-profiles/ap-code-default`, { headers: adminHeaders })
    const mainlineBody = (await bodyOf(mainline)) as {
      revision: number
      versions: Array<{ agent_profile_version_id: string; status: string }>
    }
    const publishedVersion = mainlineBody.versions.find(version => version.status === 'published')

    const draftProject = await fetch(`http://127.0.0.1:${port}/v1/admin/projects`, {
      method: 'POST',
      headers: { ...adminHeaders, 'idempotency-key': 'ac-draft-project' },
      body: JSON.stringify({ organization_id: 'org-alpha', name: '未激活项目' }),
    })
    expect(draftProject.status).toBe(201)
    const project = (await bodyOf(draftProject)) as { project_id: string }
    const bound = await bindVersion(
      port,
      adminHeaders,
      'ap-code-default',
      project.project_id,
      mainlineBody.revision,
      'ac-bind-draft-project',
      publishedVersion?.agent_profile_version_id ?? '',
      false,
    )
    expect(bound.status).toBe(422)
    expect(JSON.stringify(bound.payload)).toContain('未激活')
  })

  it('splits asset failures into ASSET_NOT_FOUND / ASSET_NOT_READY / ASSET_NOT_AUTHORIZED without state changes', async () => {
    const { port, adminHeaders } = await boot()

    // ① 不存在的资产版本 → ASSET_NOT_FOUND。
    const ghost = await adminCreateProfile(port, adminHeaders, 'afc-ghost', {
      name: '幽灵资产代理',
      agent_type_id: 'at-claude-code',
      model: 'deepseek-v3.2',
      asset_bindings: { skills: [{ asset_version_id: 'skill:ghost@9.9.9', required: true }], knowledge_bases: [], memory: null },
      credential_ref: { name: 'deepseek-main', kind: 'api_key' },
      type_extension_config: { permission_mode: 'approval' },
    })
    const ghostProfile = ghost.payload as ProfileVersionsRef
    const ghostPublish = await publishVersion(port, adminHeaders, ghostProfile.agent_profile_id, ghostProfile.versions[0].agent_profile_version_id, ghostProfile.revision, 'afc-ghost-publish')
    expect(ghostPublish.status).toBe(422)
    expect(ghostPublish.payload).toMatchObject({ code: 'ASSET_NOT_FOUND' })

    // ② 存在但 readiness 不满足 → ASSET_NOT_READY。
    const offline = await adminCreateProfile(port, adminHeaders, 'afc-offline', {
      name: '下线资产代理',
      agent_type_id: 'at-claude-code',
      model: 'deepseek-v3.2',
      asset_bindings: { skills: [], knowledge_bases: [{ asset_version_id: 'knowledge:k-3', required: true }], memory: null },
      credential_ref: { name: 'deepseek-main', kind: 'api_key' },
      type_extension_config: { permission_mode: 'approval' },
    })
    const offlineProfile = offline.payload as ProfileVersionsRef
    const offlinePublish = await publishVersion(port, adminHeaders, offlineProfile.agent_profile_id, offlineProfile.versions[0].agent_profile_version_id, offlineProfile.revision, 'afc-offline-publish')
    expect(offlinePublish.status).toBe(422)
    expect(offlinePublish.payload).toMatchObject({ code: 'ASSET_NOT_READY' })

    // ③ 存在且 ready 但绑定项目未授权 → ASSET_NOT_AUTHORIZED（在已绑定的 ap-code-default 上发新版本）。
    const mainlineBefore = await fetch(`http://127.0.0.1:${port}/v1/admin/agent-profiles/ap-code-default`, { headers: adminHeaders })
    const mainlineBody = (await bodyOf(mainlineBefore)) as { revision: number; project_bindings: Array<{ project_id: string }> }
    expect(mainlineBody.project_bindings.length).toBeGreaterThan(0)
    const newVersion = await fetch(`http://127.0.0.1:${port}/v1/admin/agent-profiles/ap-code-default/versions`, {
      method: 'POST',
      headers: { ...adminHeaders, 'idempotency-key': 'afc-unauth-version', 'if-match': String(mainlineBody.revision) },
      body: JSON.stringify({
        change_summary: '含未授权资产',
        asset_bindings: { skills: [], knowledge_bases: [{ asset_version_id: 'knowledge:k-4', required: true }], memory: null },
      }),
    })
    expect(newVersion.status).toBe(201)
    const unauthVersionId = ((await bodyOf(newVersion)) as { agent_profile_version_id: string }).agent_profile_version_id
    const unauthPublish = await publishVersion(port, adminHeaders, 'ap-code-default', unauthVersionId, mainlineBody.revision + 1, 'afc-unauth-publish')
    expect(unauthPublish.status).toBe(422)
    expect(unauthPublish.payload).toMatchObject({ code: 'ASSET_NOT_AUTHORIZED' })

    // 无副作用：三种失败后版本仍 draft、profile revision 不变、绑定不变，且审计错误码一一对应。
    const ghostDetail = await fetch(`http://127.0.0.1:${port}/v1/admin/agent-profiles/${ghostProfile.agent_profile_id}`, { headers: adminHeaders })
    const ghostState = (await bodyOf(ghostDetail)) as { versions: Array<{ status: string }>; revision: number }
    expect(ghostState.versions[0].status).toBe('draft')
    expect(ghostState.revision).toBe(ghostProfile.revision)
    const audits = await fetch(`http://127.0.0.1:${port}/v1/admin/audits?agent_profile_id=${ghostProfile.agent_profile_id}`, { headers: adminHeaders })
    const codes = ((await bodyOf(audits)) as Array<{ action: string; error_code: string | null }>)
      .filter(row => row.action === 'agent_profile.version.publish')
      .map(row => row.error_code)
    expect(codes).toContain('ASSET_NOT_FOUND')
  })

  it('enforces per-type credential requirements and records the allow-branch', async () => {
    const { port, adminHeaders } = await boot()

    // claude_code 要求凭据：缺失 → CREDENTIAL_NOT_READY，无副作用。
    const noCredential = await adminCreateProfile(port, adminHeaders, 'afc-no-credential', {
      name: '缺凭据代理',
      agent_type_id: 'at-claude-code',
      model: 'deepseek-v3.2',
      asset_bindings: { skills: [{ asset_version_id: 'skill:code-review@1.0.0', required: true }], knowledge_bases: [], memory: null },
      type_extension_config: { permission_mode: 'approval' },
    })
    const noCredentialProfile = noCredential.payload as ProfileVersionsRef
    const blocked = await publishVersion(port, adminHeaders, noCredentialProfile.agent_profile_id, noCredentialProfile.versions[0].agent_profile_version_id, noCredentialProfile.revision, 'afc-no-credential-publish')
    expect(blocked.status).toBe(422)
    expect(blocked.payload).toMatchObject({ code: 'CREDENTIAL_NOT_READY' })
    const detail = await fetch(`http://127.0.0.1:${port}/v1/admin/agent-profiles/${noCredentialProfile.agent_profile_id}`, { headers: adminHeaders })
    expect(((await bodyOf(detail)) as { versions: Array<{ status: string }>; revision: number }).versions[0].status).toBe('draft')

    // hermes 明确允许无凭据：同流程发布成功（allow-branch 证明）。
    const hermesAllowed = await adminCreateProfile(port, adminHeaders, 'afc-hermes-allowed', {
      name: 'Hermes 无凭据代理',
      agent_type_id: 'at-hermes',
      model: 'deepseek-v3.2',
      type_extension_config: { profile: 'fast' },
    })
    const hermesProfile = hermesAllowed.payload as ProfileVersionsRef
    const allowed = await publishVersion(port, adminHeaders, hermesProfile.agent_profile_id, hermesProfile.versions[0].agent_profile_version_id, hermesProfile.revision, 'afc-hermes-publish')
    expect(allowed.status).toBe(200)
    expect(allowed.payload).toMatchObject({ status: 'published' })
  })

  it('derives the admin status filter from the same lifecycle rule as the payload', async () => {
    const { port, adminHeaders } = await boot()
    // ap-code-default has [published, draft]. Archiving the published version must
    // move the payload status to `draft` (no published left, draft remains), and the
    // archived filter must then exclude it instead of matching the archived substring.
    const archivedVersion = await fetch(
      `http://127.0.0.1:${port}/v1/admin/agent-profiles/ap-code-default/versions/apv-1:archive`,
      { method: 'POST', headers: { ...adminHeaders, 'idempotency-key': 'ac-filter-archive', 'if-match': '4' }, body: JSON.stringify({}) },
    )
    expect(archivedVersion.status).toBe(200)
    const archived = await fetch(`http://127.0.0.1:${port}/v1/admin/agent-profiles?status=archived`, { headers: adminHeaders })
    expect(archived.status).toBe(200)
    const items = (await bodyOf(archived)) as { items: Array<{ agent_profile_id: string; status: string }> }
    expect(items.items.every(item => item.status === 'archived')).toBe(true)
    expect(items.items.some(item => item.agent_profile_id === 'ap-code-default')).toBe(false)
  })

  it('filters the admin profile list by status, type, project, readiness, creator and updated_after', async () => {
    const { port, adminHeaders } = await boot()
    const url = (query: string): string => `http://127.0.0.1:${port}/v1/admin/agent-profiles${query}`

    const drafts = await fetch(url('?status=draft'), { headers: adminHeaders })
    const draftItems = (await bodyOf(drafts)) as { items: Array<{ agent_profile_id: string; versions: Array<{ status: string }> }> }
    expect(draftItems.items.length).toBeGreaterThan(0)
    expect(draftItems.items.every(item => item.versions.some(version => version.status === 'draft'))).toBe(true)

    const byType = await fetch(url('?agent_type_id=at-hermes'), { headers: adminHeaders })
    const typeItems = (await bodyOf(byType)) as { items: Array<{ agent_type_id: string }> }
    expect(typeItems.items.every(item => item.agent_type_id === 'at-hermes')).toBe(true)
    expect(typeItems.items.some(item => item.agent_profile_id === 'ap-hermes-trial')).toBe(true)

    const byProject = await fetch(url('?project_id=project-alpha'), { headers: adminHeaders })
    const projectItems = (await bodyOf(byProject)) as { items: Array<{ agent_profile_id: string }> }
    expect(projectItems.items.some(item => item.agent_profile_id === 'ap-code-default')).toBe(true)
    expect(projectItems.items.some(item => item.agent_profile_id === 'ap-hermes-trial')).toBe(false)

    const readyOnly = await fetch(url('?readiness=unavailable'), { headers: adminHeaders })
    const readyItems = (await bodyOf(readyOnly)) as { items: Array<{ agent_profile_id: string; readiness: string }> }
    expect(readyItems.items.map(item => item.agent_profile_id)).toContain('ap-legacy-shell')
    expect(readyItems.items.every(item => item.readiness === 'unavailable')).toBe(true)

    const byCreator = await fetch(url('?created_by=平台管理员'), { headers: adminHeaders })
    const creatorItems = (await bodyOf(byCreator)) as { items: Array<{ created_by: string }> }
    expect(creatorItems.items.length).toBeGreaterThan(0)
    expect(creatorItems.items.every(item => item.created_by === '平台管理员')).toBe(true)

    const future = await fetch(url('?updated_after=2999-01-01T00:00:00.000Z'), { headers: adminHeaders })
    const futureItems = (await bodyOf(future)) as { items: unknown[] }
    expect(futureItems.items).toHaveLength(0)
  })
})
