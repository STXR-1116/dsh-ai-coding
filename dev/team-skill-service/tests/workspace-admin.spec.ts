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

describe('cloud workspace admin API', () => {
  it('creates a draft agent profile, publishes a version and binds it to a project', async () => {
    const { port, adminHeaders, memberHeaders } = await boot()
    const draft = await fetch(`http://127.0.0.1:${port}/v1/admin/agent-profiles`, {
      method: 'POST',
      headers: { ...adminHeaders, 'idempotency-key': 'profile-draft-1' },
      body: JSON.stringify({
        name: '数据代理',
        description: '面向数据服务的执行配置',
        agent_type_id: 'at-claude-code',
        model: 'deepseek-v3',
        reasoning: 'medium',
        asset_bindings: {
          skills: [{ asset_version_id: 'skill:code-review@1.0.0', required: true }],
          knowledge_bases: [{ asset_version_id: 'knowledge:k-1', required: true }],
          memory: { asset_version_id: 'memory:m-1', required: true },
        },
        execution_policy: { permission_mode: 'approval', tool_allowlist: ['read', 'write'], max_concurrency: 2, token_budget: 100000, timeout_ms: 600000 },
        credential_ref: { name: 'deepseek-main', kind: 'api_key' },
        type_extension_config: { permission_mode: 'approval' },
      }),
    })
    expect(draft.status).toBe(201)
    const profile = (await bodyOf(draft)) as { agent_profile_id: string; status: string; revision: number }
    expect(profile.status).toBe('draft')

    const version = await fetch(`http://127.0.0.1:${port}/v1/admin/agent-profiles/${profile.agent_profile_id}/versions`, {
      method: 'POST',
      headers: { ...adminHeaders, 'idempotency-key': 'profile-version-1', 'if-match': String(profile.revision) },
      body: JSON.stringify({ change_summary: '首个版本' }),
    })
    expect(version.status).toBe(201)
    const versionRecord = (await bodyOf(version)) as { agent_profile_version_id: string; status: string; revision: number }
    expect(versionRecord.status).toBe('draft')

    const publish = await fetch(
      `http://127.0.0.1:${port}/v1/admin/agent-profiles/${profile.agent_profile_id}/versions/${versionRecord.agent_profile_version_id}:publish`,
      {
        method: 'POST',
        // Creating the version consumed revision 2; publishing names it.
        headers: { ...adminHeaders, 'idempotency-key': 'profile-publish-1', 'if-match': '2' },
        body: JSON.stringify({}),
      },
    )
    if (publish.status !== 200) console.log('PUBLISH DEBUG:', publish.status, await publish.text())
    expect(publish.status).toBe(200)
    expect(await bodyOf(publish)).toMatchObject({ status: 'published' })

    const bindWithoutRevision = await fetch(
      `http://127.0.0.1:${port}/v1/admin/agent-profiles/${profile.agent_profile_id}/project-bindings/project-alpha`,
      {
        method: 'PUT',
        headers: { ...adminHeaders, 'idempotency-key': 'profile-bind-no-revision' },
        body: JSON.stringify({ agent_profile_version_id: versionRecord.agent_profile_version_id, default: false }),
      },
    )
    expect(bindWithoutRevision.status).toBe(409)

    const bind = await fetch(
      `http://127.0.0.1:${port}/v1/admin/agent-profiles/${profile.agent_profile_id}/project-bindings/project-alpha`,
      {
        method: 'PUT',
        // Publishing moved the profile to revision 3; the binding names it.
        headers: { ...adminHeaders, 'idempotency-key': 'profile-bind-1', 'if-match': '3' },
        body: JSON.stringify({ agent_profile_version_id: versionRecord.agent_profile_version_id, default: false }),
      },
    )
    expect(bind.status).toBe(200)

    const items = { items: await walkList(port, memberHeaders, '/v1/me/agent-profiles?project_id=project-alpha') } as { items: Array<{ agent_profile_id: string; agent_profile_version_id: string }> }
    expect(items.items.some(item => item.agent_profile_id === profile.agent_profile_id)).toBe(true)
  })

  it('blocks publishing when asset versions are missing and archives published versions', async () => {
    const { port, adminHeaders, memberHeaders } = await boot()
    const draft = await fetch(`http://127.0.0.1:${port}/v1/admin/agent-profiles`, {
      method: 'POST',
      headers: { ...adminHeaders, 'idempotency-key': 'profile-draft-bad' },
      body: JSON.stringify({
        name: '缺资产代理',
        agent_type_id: 'at-claude-code',
        model: 'deepseek-v3',
        reasoning: 'medium',
        asset_bindings: {
          skills: [{ asset_version_id: 'skill:missing-skill@9.9.9', required: true }],
          knowledge_bases: [],
          memory: null,
        },
        execution_policy: { permission_mode: 'approval' },
        type_extension_config: { permission_mode: 'approval' },
      }),
    })
    const profile = (await bodyOf(draft)) as { agent_profile_id: string; revision: number }
    const version = await fetch(`http://127.0.0.1:${port}/v1/admin/agent-profiles/${profile.agent_profile_id}/versions`, {
      method: 'POST',
      headers: { ...adminHeaders, 'idempotency-key': 'profile-version-bad', 'if-match': String(profile.revision) },
      body: JSON.stringify({ change_summary: '缺失资产' }),
    })
    const versionRecord = (await bodyOf(version)) as { agent_profile_version_id: string }

    const blocked = await fetch(
      `http://127.0.0.1:${port}/v1/admin/agent-profiles/${profile.agent_profile_id}/versions/${versionRecord.agent_profile_version_id}:publish`,
      {
        method: 'POST',
        headers: { ...adminHeaders, 'idempotency-key': 'profile-publish-bad', 'if-match': '2' },
        body: JSON.stringify({}),
      },
    )
    expect(blocked.status).toBe(422)
    const failure = (await bodyOf(blocked)) as { code: string; details: { missing_assets: string[] } }
    expect(failure.code).toBe('ASSET_NOT_FOUND')
    expect(failure.details.missing_assets).toContain('skill:missing-skill@9.9.9')

    const publishedView = await fetch(`http://127.0.0.1:${port}/v1/me/agent-profiles?project_id=project-alpha`, { headers: memberHeaders })
    const items = (await bodyOf(publishedView)) as { items: Array<{ agent_profile_id: string }> }
    expect(items.items.some(item => item.agent_profile_id === profile.agent_profile_id)).toBe(false)

    const seededArchive = await fetch(
      `http://127.0.0.1:${port}/v1/admin/agent-profiles/ap-code-default/versions/apv-1:archive`,
      {
        method: 'POST',
        headers: { ...adminHeaders, 'idempotency-key': 'profile-archive-1', 'if-match': '4' },
        body: JSON.stringify({}),
      },
    )
    expect(seededArchive.status).toBe(200)
    expect(await bodyOf(seededArchive)).toMatchObject({ status: 'archived' })
    const afterArchive = await fetch(`http://127.0.0.1:${port}/v1/me/agent-profiles?project_id=project-alpha`, { headers: memberHeaders })
    const afterItems = (await bodyOf(afterArchive)) as { items: Array<{ agent_profile_id: string }> }
    expect(afterItems.items.some(item => item.agent_profile_id === 'ap-code-default')).toBe(false)
    // The archive only removes the archived profile's version; the project's other
    // published bindings stay visible.
    expect(afterItems.items.map(item => item.agent_profile_id).sort()).toEqual(['ap-legacy-shell', 'ap-review-lite'])
  })

  it('rejects non-admin callers on admin workspace and run routes', async () => {
    const { port, memberHeaders, adminHeaders } = await boot()
    const denied = await fetch(`http://127.0.0.1:${port}/v1/admin/workspaces`, { headers: memberHeaders })
    expect(denied.status).toBe(403)
    expect(await bodyOf(denied)).toMatchObject({ code: 'FORBIDDEN' })

    const allowed = await fetch(`http://127.0.0.1:${port}/v1/admin/workspaces?status=ready`, { headers: adminHeaders })
    expect(allowed.status).toBe(200)
    const workspaces = (await bodyOf(allowed)) as { items: Array<{ workspace_id: string; status: string }> }
    expect(workspaces.items.some(item => item.workspace_id === 'ws-alpha-1' && item.status === 'ready')).toBe(true)

    const detail = await fetch(`http://127.0.0.1:${port}/v1/admin/workspaces/ws-alpha-1`, { headers: adminHeaders })
    expect(detail.status).toBe(200)
    expect(await bodyOf(detail)).toMatchObject({ workspace_id: 'ws-alpha-1', branch: 'main' })
  })

  it('stops and restarts a workspace through the admin ops route', async () => {
    const { port, adminHeaders } = await boot()
    const stop = await fetch(`http://127.0.0.1:${port}/v1/admin/workspaces/ws-alpha-1:stop`, {
      method: 'POST',
      headers: { ...adminHeaders, 'idempotency-key': 'admin-stop-1' },
      body: JSON.stringify({ expected_workspace_revision: 7 }),
    })
    expect(stop.status).toBe(200)
    const stopped = (await bodyOf(stop)) as { status: string; revision: number }
    expect(stopped).toMatchObject({ status: 'stopped' })

    // A start without the revision it observed is refused, exactly like a stop.
    const startWithoutRevision = await fetch(`http://127.0.0.1:${port}/v1/admin/workspaces/ws-alpha-1:start`, {
      method: 'POST',
      headers: { ...adminHeaders, 'idempotency-key': 'admin-start-no-revision' },
      body: JSON.stringify({}),
    })
    expect(startWithoutRevision.status).toBe(409)

    const start = await fetch(`http://127.0.0.1:${port}/v1/admin/workspaces/ws-alpha-1:start`, {
      method: 'POST',
      headers: { ...adminHeaders, 'idempotency-key': 'admin-start-1' },
      body: JSON.stringify({ expected_workspace_revision: stopped.revision }),
    })
    expect(start.status).toBe(202)
    expect(await bodyOf(start)).toMatchObject({ status: 'starting' })
  })

  it('searches runs globally and returns run detail with the config snapshot', async () => {
    const { port, adminHeaders, memberHeaders } = await boot()
    const create = await fetch(`http://127.0.0.1:${port}/v1/workspaces/ws-alpha-1/runs`, {
      method: 'POST',
      headers: { ...memberHeaders, 'idempotency-key': 'admin-run-1' },
      body: JSON.stringify({ session_id: 'sess-admin-1', write_mode: 'read_only', expected_workspace_revision: 7 }),
    })
    const run = (await bodyOf(create)) as { run_id: string }

    const search = await fetch(`http://127.0.0.1:${port}/v1/admin/runs`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ project_id: 'project-alpha', workspace_id: 'ws-alpha-1' }),
    })
    expect(search.status).toBe(200)
    const runs = (await bodyOf(search)) as { items: Array<{ run_id: string; agent_profile_version_id: string }> }
    expect(runs.items.some(item => item.run_id === run.run_id)).toBe(true)

    const detail = await fetch(`http://127.0.0.1:${port}/v1/admin/runs/${run.run_id}`, { headers: adminHeaders })
    expect(detail.status).toBe(200)
    const snapshot = (await bodyOf(detail)) as {
      run_id: string
      agent_profile_version_id: string
      asset_version_ids: string[]
      workspace_revision: number
      events: unknown[]
    }
    expect(snapshot).toMatchObject({ run_id: run.run_id, agent_profile_version_id: 'apv-1', workspace_revision: 7 })
    expect(snapshot.asset_version_ids.length).toBeGreaterThan(0)
    expect(Array.isArray(snapshot.events)).toBe(true)
  })

  it('serves unified audit queries with the literal actor_name field', async () => {
    const { port, adminHeaders, memberHeaders } = await boot()
    await fetch(`http://127.0.0.1:${port}/v1/workspaces/ws-alpha-1:stop`, {
      method: 'POST',
      headers: { ...memberHeaders, 'idempotency-key': 'audit-stop-1' },
      body: JSON.stringify({ expected_workspace_revision: 7 }),
    })

    const audits = await fetch(`http://127.0.0.1:${port}/v1/admin/audits?workspace_id=ws-alpha-1`, { headers: adminHeaders })
    expect(audits.status).toBe(200)
    expect(audits.headers.get('x-fixture-only')).toBe('true')
    const items = (await bodyOf(audits)) as Array<Record<string, unknown>>
    expect(items.length).toBeGreaterThan(0)
    for (const item of items) {
      expect(typeof item.actor_name).toBe('string')
      expect((item.actor_name as string).length).toBeGreaterThan(0)
      expect(typeof item.request_id).toBe('string')
      expect(typeof item.action).toBe('string')
      expect(['succeeded', 'failed']).toContain(item.result)
      expect(typeof item.occurred_at).toBe('string')
      expect(item.actorName).toBeUndefined()
    }
    expect(items.some(item => item.action === 'workspace.stop')).toBe(true)
    const serialized = JSON.stringify(items)
    expect(serialized).not.toMatch(/Bearer |access_token|password/i)
  })

  it('scopes manager admin lists to their visible organizations', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const headers = { authorization: 'Bearer manager-demo' }

    const workspaces = await fetch(`http://127.0.0.1:${port}/v1/admin/workspaces`, { headers })
    expect(workspaces.status).toBe(200)
    const items = ((await bodyOf(workspaces)) as { items: Array<{ workspace_id: string; project_id: string }> }).items
    expect(items.some(item => item.workspace_id === 'ws-alpha-1')).toBe(true)
    expect(items.some(item => item.workspace_id === 'ws-beta-1')).toBe(false)

    // org-alpha operation (visible to the manager) and an org-beta one (hidden)
    await fetch(`http://127.0.0.1:${port}/v1/workspaces/ws-alpha-1:stop`, {
      method: 'POST',
      headers: { authorization: 'Bearer demo-token', 'content-type': 'application/json', 'idempotency-key': 'scope-stop-alpha' },
      body: JSON.stringify({ expected_workspace_revision: 7 }),
    })
    await fetch(`http://127.0.0.1:${port}/v1/admin/workspaces/ws-beta-1:stop`, {
      method: 'POST',
      headers: { authorization: 'Bearer admin-demo', 'content-type': 'application/json', 'idempotency-key': 'scope-stop-beta' },
      body: JSON.stringify({ expected_workspace_revision: 2 }),
    })
    const audits = await fetch(`http://127.0.0.1:${port}/v1/admin/audits`, { headers })
    const rows = (await bodyOf(audits)) as Array<{ organization_id: string | null }>
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.some(row => row.organization_id === 'org-alpha')).toBe(true)
    expect(rows.every(row => row.organization_id !== 'org-beta')).toBe(true)
  })

  it('guards admin writes with revision and idempotency semantics', async () => {
    const { port, adminHeaders } = await boot()
    const stale = await fetch(`http://127.0.0.1:${port}/v1/admin/workspaces/ws-alpha-1:stop`, {
      method: 'POST',
      headers: { ...adminHeaders, 'idempotency-key': 'admin-stop-stale' },
      body: JSON.stringify({ expected_workspace_revision: 6 }),
    })
    expect(stale.status).toBe(409)
    expect(await bodyOf(stale)).toMatchObject({ code: 'REVISION_CONFLICT' })

    const first = await fetch(`http://127.0.0.1:${port}/v1/admin/workspaces/ws-alpha-1:stop`, {
      method: 'POST',
      headers: { ...adminHeaders, 'idempotency-key': 'admin-stop-idem' },
      body: JSON.stringify({ expected_workspace_revision: 7 }),
    })
    expect(first.status).toBe(200)

    const replayDifferentBody = await fetch(`http://127.0.0.1:${port}/v1/admin/workspaces/ws-alpha-1:stop`, {
      method: 'POST',
      headers: { ...adminHeaders, 'idempotency-key': 'admin-stop-idem' },
      body: JSON.stringify({ expected_workspace_revision: 8 }),
    })
    expect(replayDifferentBody.status).toBe(409)
    expect(await bodyOf(replayDifferentBody)).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })

    // A same-key, same-body replay answers with the first result rather than
    // performing the write again.
    const replaySameBody = await fetch(`http://127.0.0.1:${port}/v1/admin/workspaces/ws-alpha-1:stop`, {
      method: 'POST',
      headers: { ...adminHeaders, 'idempotency-key': 'admin-stop-idem' },
      body: JSON.stringify({ expected_workspace_revision: 7 }),
    })
    expect(replaySameBody.status).toBe(200)
    expect(await bodyOf(replaySameBody)).toEqual(await bodyOf(first))
  })

  it('applies exactly one of two writes competing on the same revision', async () => {
    const { port, adminHeaders } = await boot()
    const snapshot = await fetch(`http://127.0.0.1:${port}/v1/admin/workspaces/ws-alpha-1`, { headers: adminHeaders })
    const current = (await bodyOf(snapshot)) as { revision: number }
    expect(current.revision).toBe(7)

    // Two operators act on the revision they both read. The service owns the
    // ordering, so one write advances the state and the other is refused.
    const writes = await Promise.all([
      fetch(`http://127.0.0.1:${port}/v1/admin/workspaces/ws-alpha-1:stop`, {
        method: 'POST',
        headers: { ...adminHeaders, 'idempotency-key': 'race-a' },
        body: JSON.stringify({ expected_workspace_revision: current.revision }),
      }),
      fetch(`http://127.0.0.1:${port}/v1/admin/workspaces/ws-alpha-1:stop`, {
        method: 'POST',
        headers: { ...adminHeaders, 'idempotency-key': 'race-b' },
        body: JSON.stringify({ expected_workspace_revision: current.revision }),
      }),
    ])
    const statuses = writes.map(response => response.status).sort()
    expect(statuses).toEqual([200, 409])
    const refused = writes.find(response => response.status === 409)
    expect(await bodyOf(refused!)).toMatchObject({ code: 'REVISION_CONFLICT' })

    const after = await fetch(`http://127.0.0.1:${port}/v1/admin/workspaces/ws-alpha-1`, { headers: adminHeaders })
    const settled = (await bodyOf(after)) as { status: string; revision: number }
    expect(settled.status).toBe('stopped')
    expect(settled.revision).toBeGreaterThan(current.revision)

    // The audit trail is the record of what actually ran: exactly one stop
    // succeeded, so the losing write left no trace on the resource.
    const audits = await fetch(
      `http://127.0.0.1:${port}/v1/admin/audits?workspace_id=ws-alpha-1&action=admin.workspace.stop`,
      { headers: adminHeaders },
    )
    const rows = (await bodyOf(audits)) as readonly { result: string; request_id: string }[]
    const succeeded = rows.filter(row => row.result === 'succeeded')
    const refusedAudits = rows.filter(row => row.result === 'failed')
    expect(succeeded).toHaveLength(1)
    expect(refusedAudits).toHaveLength(1)
    expect(refusedAudits[0]?.request_id).not.toBe(succeeded[0]?.request_id)
  })
})
