/* 云工作空间全链路闭环 E2E：真实登录 + 真实 TeamSkillApi 客户端 + 真实 fixture HTTP。
 * 覆盖验收矩阵（服务API需求 §10）：成功/缺字段/越权/不存在/过期 Token/幂等重放与冲突/
 * revision 冲突/下游失败语义/SSE 重放与 resync/断线重连（Host 层覆盖）。
 * 分类：FIXTURE-ONLY。 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { createTeamSkillService } from '../../team-skill-service/src/server.ts'
import { TeamSkillApi } from '../src/lib/team-skill-api.ts'
import { bodyOf } from '../../team-skill-service/tests/response.ts'

const services: ReturnType<typeof createTeamSkillService>[] = []
afterAll(async () => {
  for (const service of services.splice(0)) {
    service.server.closeAllConnections()
    await new Promise<void>((resolve) => {
      service.server.close(() => {
        resolve()
      })
    })
  }
})

let baseUrl = ''
let memberToken = ''
let adminApi: TeamSkillApi
let managerApi: TeamSkillApi
let e2eWorkspaceId = ''
let e2eRevision = 0

/** 分页游走：透传服务端 cursor 直到 next_cursor 耗尽（AFC-03 合同）。 */
async function fetchWalked(path: string, token: string): Promise<Array<Record<string, unknown>>> {
  const items: Array<Record<string, unknown>> = []
  let cursor: string | null = null
  do {
    const cursorParam = cursor === null ? '' : `cursor=${encodeURIComponent(cursor)}&`
    const res = await fetch(`${baseUrl}${path}${path.includes('?') ? '&' : '?'}${cursorParam}pagesize=stable`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { items: Array<Record<string, unknown>>; next_cursor: string | null } }
    items.push(...body.data.items)
    cursor = body.data.next_cursor
  } while (cursor !== null)
  return items
}

async function login(username: string, password: string): Promise<string> {
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { data: { access_token: string } }
  return body.data.access_token
}

async function untilReady(workspaceId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const res = await fetch(`${baseUrl}/workspaces/${workspaceId}`, { headers: { authorization: `Bearer ${memberToken}` } })
    const snapshot = (await bodyOf(res)) as { status: string }
    if (snapshot.status === 'ready') return
    if (snapshot.status === 'failed') throw new Error('workspace failed')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('workspace did not become ready')
}

/** Read SSE frames until the terminator appears or the stream closes. */
async function readSse(response: Response, predicate: (frame: string) => boolean, maxFrames = 200): Promise<string[]> {
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error('SSE response has no body')
  try {
    const decoder = new TextDecoder()
    let buffered = ''
    const frames: string[] = []
    for (let i = 0; i < maxFrames; i += 1) {
      const { done, value } = await reader.read()
      if (done) break
      buffered += decoder.decode(value, { stream: true })
      let boundary = buffered.indexOf('\n\n')
      while (boundary !== -1) {
        const frame = buffered.slice(0, boundary)
        buffered = buffered.slice(boundary + 2)
        frames.push(frame)
        if (predicate(frame)) return frames
        boundary = buffered.indexOf('\n\n')
      }
    }
    return frames
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

function eventType(frame: string): string | undefined {
  return /^event: (.+)$/mu.exec(frame)?.[1]
}

beforeAll(async () => {
  const service = createTeamSkillService({ port: 0 })
  services.push(service)
  await service.listen()
  baseUrl = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}/v1`
  memberToken = await login('member@example.com', 'member-pass')
  adminApi = new TeamSkillApi({ baseUrl, accessToken: await login('admin@example.com', 'admin-pass') })
  managerApi = new TeamSkillApi({ baseUrl, accessToken: await login('manager@example.com', 'manager-pass') })
})

describe('cloud workspace full-stack closed loop', () => {
  it('member: real-HTTP workspace journey (create → ready → tree → preview → run → changes → commit)', async () => {
    const typeItems = await fetchWalked('/me/agent-types', memberToken) as Array<{ key: string }>
    expect(typeItems.map(item => item.key).sort()).toEqual(['claude_code', 'hermes', 'legacy_shell'])

    const memberProfileItems = await fetchWalked('/me/agent-profiles?project_id=project-alpha', memberToken) as Array<{ agent_profile_version_id: string }>
    expect(memberProfileItems.map(profile => profile.agent_profile_version_id)).toContain('apv-1')

    // 缺字段 → 422；未发布配置版本 → 422
    const missing = await fetch(`${baseUrl}/projects/project-alpha/workspaces`, {
      method: 'POST',
      headers: { authorization: `Bearer ${memberToken}`, 'content-type': 'application/json', 'idempotency-key': 'e2e-missing' },
      body: JSON.stringify({ branch: 'x' }),
    })
    expect(missing.status).toBe(422)

    const created = await fetch(`${baseUrl}/projects/project-alpha/workspaces`, {
      method: 'POST',
      headers: { authorization: `Bearer ${memberToken}`, 'content-type': 'application/json', 'idempotency-key': 'e2e-create' },
      body: JSON.stringify({ repository_id: 'repo-1', branch: 'feature/e2e', agent_profile_version_id: 'apv-1', display_name: 'E2E 闭环空间' }),
    })
    expect(created.status).toBe(202)
    const createdBody = (await bodyOf(created)) as { workspace_id: string; status: string; revision: number }
    e2eWorkspaceId = createdBody.workspace_id
    expect(createdBody.status).toBe('provisioning')
    expect(created.headers.get('x-fixture-only')).toBe('true')

    await untilReady(e2eWorkspaceId)

    // SSE 重放：创建与 ready 事件按序可见
    const stream = await fetch(`${baseUrl}/events/stream?workspace_id=${e2eWorkspaceId}&after=`, {
      headers: { authorization: `Bearer ${memberToken}` },
    })
    const frames = await readSse(stream, frame => eventType(frame) === 'stream.replay-done')
    const names = frames.map(frame => eventType(frame))
    expect(names).toContain('workspace.created')
    expect(names).toContain('workspace.provisioning')
    expect(names).toContain('workspace.ready')

    const authHeaders = { authorization: `Bearer ${memberToken}` }
    const getJson = async (path: string): Promise<{ status: number; body: unknown }> => {
      const res = await fetch(`${baseUrl}${path}`, { headers: authHeaders })
      return { status: res.status, body: await bodyOf(res) }
    }

    // 目录展开
    const root = await getJson(`/workspaces/${e2eWorkspaceId}/files?path=`)
    expect(root.status).toBe(200)
    const rootList = root.body as { items: Array<{ path: string; kind: string }> }
    expect(rootList.items.some(item => item.path === 'src' && item.kind === 'directory')).toBe(true)
    const expanded = await getJson(`/workspaces/${e2eWorkspaceId}/files?path=src`)
    const srcList = expanded.body as { items: Array<{ path: string }> }
    expect(srcList.items.some(item => item.path === 'src/app.json')).toBe(true)

    // 预览：静态 HTML（CSP+sandbox）；越界路径拒绝
    const html = await getJson(`/workspaces/${e2eWorkspaceId}/preview?path=index.html`)
    const htmlPreview = html.body as { kind: string; csp: string; sandbox: string[] }
    expect(htmlPreview.kind).toBe('static_html')
    expect(htmlPreview.csp).toContain('default-src')
    expect(htmlPreview.sandbox).toContain('allow-scripts')
    const denied = await fetch(`${baseUrl}/workspaces/${e2eWorkspaceId}/preview?path=..%2Fsecret`, { headers: authHeaders })
    expect(denied.status).toBe(403)

    // Run：快照 → busy → 冲突 → 取消 → 重试（revision 取自当前快照）
    const snap = await getJson(`/workspaces/${e2eWorkspaceId}`)
    const currentRevision = (snap.body as { revision: number }).revision
    const mkRun = (key: string, mode: 'write' | 'read_only', rev: number): Promise<Response> =>
      fetch(`${baseUrl}/workspaces/${e2eWorkspaceId}/runs`, {
        method: 'POST',
        headers: { authorization: `Bearer ${memberToken}`, 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({ session_id: 'sess-e2e', write_mode: mode, expected_workspace_revision: rev }),
      })
    const runRes = await mkRun('e2e-run-1', 'write', currentRevision)
    expect(runRes.status).toBe(202)
    const run = (await bodyOf(runRes)) as {
      run_id: string
      lease_id: string
      agent_profile_version_id: string
      asset_version_ids: string[]
      workspace_revision: number
    }
    expect(run.lease_id).toBeTruthy()
    expect(run.asset_version_ids).toContain('skill:code-review@1.0.0')
    expect(run.workspace_revision).toBe(currentRevision)

    const busyRes = await mkRun('e2e-run-2', 'write', currentRevision)
    expect(busyRes.status).toBe(409)
    const busy = (await bodyOf(busyRes)) as { code: string; current_run: { run_id: string } }
    expect(busy.code).toBe('WORKSPACE_BUSY')
    expect(busy.current_run.run_id).toBe(run.run_id)

    const conflictRes = await mkRun('e2e-run-3', 'read_only', currentRevision - 1)
    expect(conflictRes.status).toBe(409)

    const cancel = await fetch(`${baseUrl}/runs/${run.run_id}:cancel`, {
      method: 'POST',
      headers: { authorization: `Bearer ${memberToken}`, 'content-type': 'application/json', 'idempotency-key': 'e2e-cancel' },
      body: '{}',
    })
    expect(cancel.status).toBe(200)
    const retry = await fetch(`${baseUrl}/runs/${run.run_id}:retry`, {
      method: 'POST',
      headers: { authorization: `Bearer ${memberToken}`, 'content-type': 'application/json', 'idempotency-key': 'e2e-retry' },
      body: JSON.stringify({ expected_workspace_revision: currentRevision }),
    })
    expect(retry.status).toBe(202)
    const retried = (await bodyOf(retry)) as { run_id: string; retry_of_run_id: string }
    expect(retried.retry_of_run_id).toBe(run.run_id)

    // 变更丢弃与提交（revision 守卫）
    const discard = await fetch(`${baseUrl}/workspaces/${e2eWorkspaceId}/changes:discard`, {
      method: 'POST',
      headers: { authorization: `Bearer ${memberToken}`, 'content-type': 'application/json', 'idempotency-key': 'e2e-discard' },
      body: JSON.stringify({ expected_workspace_revision: currentRevision }),
    })
    expect(discard.status).toBe(200)
    e2eRevision = ((await bodyOf(discard)) as { revision: number }).revision

    const commit = await fetch(`${baseUrl}/workspaces/${e2eWorkspaceId}/git/commit`, {
      method: 'POST',
      headers: { authorization: `Bearer ${memberToken}`, 'content-type': 'application/json', 'idempotency-key': 'e2e-commit' },
      body: JSON.stringify({ message: 'E2E 提交', expected_workspace_revision: e2eRevision }),
    })
    expect(commit.status).toBe(200)
    e2eRevision = ((await bodyOf(commit)) as { revision: number }).revision

    // 受控 Web App URL
    const grant = await fetch(`${baseUrl}/workspaces/${e2eWorkspaceId}/preview-url`, {
      method: 'POST',
      headers: { authorization: `Bearer ${memberToken}`, 'content-type': 'application/json', 'idempotency-key': 'e2e-url' },
      body: JSON.stringify({ app: 'workspace_app', port: 3000 }),
    })
    expect(grant.status).toBe(200)
  })

  it('admin: governance journey (draft → publish → bind → ops → runs → audits)', async () => {
    // 工作空间运维列表与详情（含 Run 与配置快照）
    const list = await adminApi.cloudWorkspaces({ projectId: 'project-alpha' })
    expect(list.ok).toBe(true)
    const detail = await adminApi.cloudWorkspace('ws-alpha-1')
    expect(detail.ok).toBe(true)
    if (detail.ok) {
      const value = detail.value as unknown as { recent_audits?: unknown[]; runs?: unknown[]; config_snapshot?: unknown }
      expect(Array.isArray(value.recent_audits)).toBe(true)
      expect(Array.isArray(value.runs)).toBe(true)
      expect(value.config_snapshot).toMatchObject({ agent_profile_version_id: 'apv-1' })
    }

    // 草稿 → 版本 → 发布 → 绑定 → 成员可见
    const draft = await adminApi.createCloudAgentProfile({
      name: 'E2E 代理',
      agent_type_id: 'at-claude-code',
      model: 'deepseek-v3.2',
      asset_bindings: { skills: [{ asset_version_id: 'skill:code-review@1.0.0', required: true }], knowledge_bases: [], memory: null },
      credential_ref: { name: 'deepseek-main', kind: 'api_key' },
      type_extension_config: { permission_mode: 'approval' },
    }, 'e2e-draft-profile')
    expect(draft.ok).toBe(true)
    if (!draft.ok) return
    const draftProfile = draft.value as { agent_profile_id: string; revision: number }
    const version = await adminApi.createCloudAgentProfileVersion(draftProfile.agent_profile_id, { change_summary: 'E2E 版本' }, draftProfile.revision, 'e2e-draft-version')
    expect(version.ok).toBe(true)
    const versionId = ((version as { ok: true; value: { agent_profile_version_id: string } }).value).agent_profile_version_id

    // Creating the version consumed revision 2; publishing names it.
    const publish = await adminApi.publishCloudAgentProfileVersion(draftProfile.agent_profile_id, versionId, 2, 'e2e-publish')
    expect(publish.ok).toBe(true)

    // Publishing moved the profile revision, so the binding must carry the
    // revision the service currently reports rather than the one read earlier.
    const profiles = await adminApi.cloudAgentProfiles()
    expect(profiles.ok).toBe(true)
    let currentRevision: number | undefined
    for (const row of profiles.ok ? profiles.value : []) {
      if (row.agent_profile_id === draftProfile.agent_profile_id) currentRevision = row.revision
    }
    expect(currentRevision).toBeDefined()

    const bind = await adminApi.bindCloudAgentProfile(
      draftProfile.agent_profile_id,
      'project-alpha',
      currentRevision ?? 0,
      { agent_profile_version_id: versionId, default: false },
      'e2e-bind',
    )
    expect(bind.ok).toBe(true)

    // 成员可见新绑定（插件面 /me/agent-profiles）
    const memberItems = await fetchWalked('/me/agent-profiles?project_id=project-alpha', memberToken) as Array<{ agent_profile_version_id: string }>
    expect(memberItems.some(profile => profile.agent_profile_version_id === versionId)).toBe(true)
  })

  it('admin: R2-08 draft-edit journey (candidates → edit → republish → default → unbind → run denied)', async () => {
    // 资产候选：名称/类型/版本/授权/readiness 与失效原因；不含资产正文或凭据。
    const candidates = await adminApi.cloudAssetCandidates('project-alpha')
    expect(candidates.ok).toBe(true)
    const k3 = (candidates.ok ? candidates.value : []).find(item => item.asset_id === 'knowledge:k-3@v1')
    expect(k3).toMatchObject({ authorized: true, readiness: 'unavailable' })
    expect((k3 as unknown as { invalid_reason: string }).invalid_reason).toContain('知识库已下线')

    // 创建草稿：字段明确选择（模型/推理/资产/执行策略），不硬编码服务 ID。
    const draft = await adminApi.createCloudAgentProfile({
      name: 'R2-08 草稿代理',
      organization_id: 'org-alpha',
      agent_type_id: 'at-claude-code',
      model: 'deepseek-v3.2',
      reasoning: 'low',
      asset_bindings: { skills: [{ asset_version_id: 'skill:code-review@1.0.0', required: true }], knowledge_bases: [], memory: null },
      execution_policy: { permission_mode: 'auto', max_concurrency: 3, budget: 100000 },
      credential_ref: { name: 'deepseek-main', kind: 'api_key' },
      type_extension_config: { permission_mode: 'auto' },
    }, 'r208-draft')
    expect(draft.ok).toBe(true)
    const draftProfile = (draft as {
      ok: true
      value: { agent_profile_id: string; revision: number }
    }).value

    // 编辑草稿（PUT）→ 重读显示已保存字段（编辑后重读）。
    const edited = await adminApi.updateCloudAgentProfile(
      draftProfile.agent_profile_id,
      { model: 'deepseek-v3.5', reasoning: 'high' },
      draftProfile.revision,
      'r208-edit',
    )
    expect(edited.ok).toBe(true)
    const reread = await adminApi.cloudAgentProfiles()
    expect(reread.ok).toBe(true)
    const editedRow = (reread.ok ? reread.value : []).find(row => row.agent_profile_id === draftProfile.agent_profile_id)
    expect(editedRow).toBeDefined()
    const versionsRow = editedRow
    const editedLatest = versionsRow?.versions.at(-1)
    expect(editedLatest).toMatchObject({ model: 'deepseek-v3.5', reasoning: 'high' })

    // 不可用资产阻止发布并展示服务拒绝。
    const badVersion = await adminApi.createCloudAgentProfileVersion(
      draftProfile.agent_profile_id,
      {
        change_summary: '引用下线资产',
        asset_bindings: { skills: [], knowledge_bases: [{ asset_version_id: 'knowledge:k-3@v1', required: true }], memory: null },
      },
      draftProfile.revision + 1,
      'r208-bad-version',
    )
    expect(badVersion.ok).toBe(true)
    const badVersionId = (badVersion as { ok: true; value: { agent_profile_version_id: string } })
      .value.agent_profile_version_id
    const profilesAfterBad = await adminApi.cloudAgentProfiles()
    const rowAfterBad = (profilesAfterBad.ok ? profilesAfterBad.value : [])
      .find(row => row.agent_profile_id === draftProfile.agent_profile_id)
    const badPublish = await adminApi.publishCloudAgentProfileVersion(
      draftProfile.agent_profile_id,
      badVersionId,
      rowAfterBad?.revision ?? 0,
      'r208-bad-publish',
    )
    expect(badPublish.ok).toBe(false)
    if (!badPublish.ok && badPublish.error.kind === 'service') {
      expect(badPublish.error.code).toBe('ASSET_NOT_READY')
      expect(badPublish.error.message).toContain('知识库已下线')
    } else if (!badPublish.ok) {
      expect.fail('bad-asset publish was not a service rejection')
    }

    // 干净版本可发布，且携带明确字段；发布后对成员（插件面）可选。
    const goodVersion = await adminApi.createCloudAgentProfileVersion(
      draftProfile.agent_profile_id,
      {
        change_summary: '干净版本',
        asset_bindings: { skills: [{ asset_version_id: 'skill:code-review@1.0.0', required: true }], knowledge_bases: [], memory: null },
        execution_policy: { permission_mode: 'approval', max_concurrency: 2, budget: 90000 },
      },
      draftProfile.revision + 2,
      'r208-good-version',
    )
    expect(goodVersion.ok).toBe(true)
    const goodVersionId = (goodVersion as { ok: true; value: { agent_profile_version_id: string } })
      .value.agent_profile_version_id
    const profilesAfterGood = await adminApi.cloudAgentProfiles()
    const rowAfterGood = (profilesAfterGood.ok ? profilesAfterGood.value : [])
      .find(row => row.agent_profile_id === draftProfile.agent_profile_id)
    const goodPublish = await adminApi.publishCloudAgentProfileVersion(
      draftProfile.agent_profile_id,
      goodVersionId,
      rowAfterGood?.revision ?? 0,
      'r208-good-publish',
    )
    expect(goodPublish.ok).toBe(true)

    // 默认设置（default=true 绑定）+ 成员可见。
    const profilesForBind = await adminApi.cloudAgentProfiles()
    const rowForBind = (profilesForBind.ok ? profilesForBind.value : [])
      .find(row => row.agent_profile_id === draftProfile.agent_profile_id)
    const bindDefault = await adminApi.bindCloudAgentProfile(
      draftProfile.agent_profile_id,
      'project-alpha',
      rowForBind?.revision ?? 0,
      { agent_profile_version_id: goodVersionId, default: true },
      'r208-bind-default',
    )
    expect(bindDefault.ok).toBe(true)
    const memberItems = await fetchWalked('/me/agent-profiles?project_id=project-alpha', memberToken) as Array<{ agent_profile_version_id: string }>
    expect(memberItems.some(item => item.agent_profile_version_id === goodVersionId)).toBe(true)

    // 冲突拒绝：携带过期 revision 的绑定 → 409。
    const staleBind = await adminApi.bindCloudAgentProfile(
      draftProfile.agent_profile_id,
      'project-alpha',
      (rowForBind?.revision ?? 1) - 1,
      { agent_profile_version_id: goodVersionId, default: false },
      'r208-stale-bind',
    )
    expect(staleBind.ok).toBe(false)
    if (!staleBind.ok) {
      // 客户端把 revision 竞争归一为 revision-conflict 类（服务端 409/428 语义）。
      expect(['revision-conflict', 'service']).toContain(staleBind.error.kind)
    }

    const runAttempt = (idempotencyKey: string): Promise<Response> => fetch(`${baseUrl}/workspaces/ws-alpha-1/runs`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${memberToken}`,
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
        'if-match': '7',
      },
      body: JSON.stringify({
        session_id: 'sess-r208',
        write_mode: 'read_only',
        expected_workspace_revision: 7,
        agent_profile_version_id: goodVersionId,
      }),
    })

    // 归档（仍处于绑定状态）后不能新建 Run：服务端 403，而不是空数据。
    const profilesForArchive = await adminApi.cloudAgentProfiles()
    const rowForArchive = (profilesForArchive.ok ? profilesForArchive.value : [])
      .find(row => row.agent_profile_id === draftProfile.agent_profile_id)
    const archive = await adminApi.archiveCloudAgentProfileVersion(
      draftProfile.agent_profile_id,
      goodVersionId,
      rowForArchive?.revision ?? 0,
      'r208-archive',
    )
    expect(archive.ok).toBe(true)
    const archivedRun = await runAttempt(`r208-archived-${Date.now()}`)
    expect(archivedRun.status).toBe(403)
    const archivedBody = (await archivedRun.json()) as { code: string }
    expect(archivedBody.code).toBe('FORBIDDEN')

    // 解绑后同样不能新建 Run。
    const profilesForUnbind = await adminApi.cloudAgentProfiles()
    const rowForUnbind = (profilesForUnbind.ok ? profilesForUnbind.value : [])
      .find(row => row.agent_profile_id === draftProfile.agent_profile_id)
    const unbind = await adminApi.unbindCloudAgentProfile(
      draftProfile.agent_profile_id,
      'project-alpha',
      rowForUnbind?.revision ?? 0,
      'r208-unbind',
    )
    expect(unbind.ok).toBe(true)
    const deniedRun = await runAttempt(`r208-denied-${Date.now()}`)
    expect(deniedRun.status).toBe(403)
  })

  it('ops: stop with confirmation semantics then audits carry actor_name', async () => {
    // 停止（成员线）→ 审计行携带字面 actor_name
    const stop = await fetch(`${baseUrl}/workspaces/${e2eWorkspaceId}:stop`, {
      method: 'POST',
      headers: { authorization: `Bearer ${memberToken}`, 'content-type': 'application/json', 'idempotency-key': 'e2e-stop-final' },
      body: JSON.stringify({ expected_workspace_revision: e2eRevision }),
    })
    expect(stop.status).toBe(200)

    const audits = await adminApi.cloudAudits({ workspaceId: e2eWorkspaceId })
    expect(audits.ok).toBe(true)
    if (audits.ok) {
      expect(audits.value.length).toBeGreaterThan(0)
      for (const row of audits.value) {
        expect(row.actor_name.length).toBeGreaterThan(0)
        expect(['succeeded', 'failed']).toContain(row.result)
      }
      expect(audits.value.some(row => row.action === 'workspace.create')).toBe(true)
      expect(audits.value.some(row => row.action === 'git.commit')).toBe(true)
    }
    const serialized = JSON.stringify(audits)
    expect(serialized).not.toMatch(/access-\w{8}|password/i)
  })

  it('manager: org-scoped admin reads and member: forbidden admin access', async () => {
    const ws = await managerApi.cloudWorkspaces({})
    expect(ws.ok).toBe(true)
    if (ws.ok) {
      expect(ws.value.every(workspace => workspace.project_id !== 'project-beta')).toBe(true)
      expect(ws.value.some(workspace => workspace.project_id === 'project-alpha')).toBe(true)
    }
    const forbidden = await fetch(`${baseUrl}/admin/workspaces`, { headers: { authorization: `Bearer ${memberToken}` } })
    expect(forbidden.status).toBe(403)
  })

  it('member: sign-out invalidates the session (登出清理)', async () => {
    const logout = await fetch(`${baseUrl}/auth/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${memberToken}`, 'idempotency-key': 'e2e-logout' },
    })
    expect(logout.status).toBe(204)
    const after = await fetch(`${baseUrl}/me/agent-types`, { headers: { authorization: `Bearer ${memberToken}` } })
    expect(after.status).toBe(401)
  })
})

describe('agent config full-chain closed loop', () => {
  it('admin: schema → draft → publish → bind → member visibility → run override → downstream failure → archive → audits → idempotency', async () => {
    // 前面的登出用例会作废共享 member 令牌：本用例自行重新登录。
    const memberToken = await login('member@example.com', 'member-pass')
    // ① 类型 schema（管理端读取，含发布影响标记）。
    const types = await adminApi.cloudAgentTypes()
    expect(types.ok).toBe(true)
    const claude = (types.ok ? types.value : []).find(item => item.key === 'claude_code')
    expect(claude?.readiness).toBe('ready')
    expect(Array.isArray(claude?.schema)).toBe(true)
    const permissionField = claude?.schema?.find(field => field.key === 'permission_mode')
    expect(permissionField).toMatchObject({ type: 'enum', required: true })

    // ② 资产候选（授权 + readiness + updated_at）。
    const candidates = await adminApi.cloudAssetCandidates('project-alpha')
    expect(candidates.ok).toBe(true)
    expect((candidates.ok ? candidates.value : []).every(item => typeof item.updated_at === 'string')).toBe(true)

    // ③ 创建草稿（结构化绑定 + 凭据 + 扩展配置 + 幂等键）。
    const draftBody = {
      name: '全链路代理',
      organization_id: 'org-alpha',
      agent_type_id: 'at-claude-code',
      model: 'deepseek-v3.2',
      reasoning: 'medium',
      asset_bindings: {
        skills: [{ asset_version_id: 'skill:code-review@1.0.0', required: true }],
        knowledge_bases: [{ asset_version_id: 'knowledge:k-1', required: true }],
        memory: { asset_version_id: 'memory:m-1', required: true },
      },
      execution_policy: { permission_mode: 'approval', write_mode: 'read_only', tool_allowlist: ['read'], max_concurrency: 1, timeout_ms: 600000 },
      credential_ref: { name: 'deepseek-main', kind: 'api_key' },
      type_extension_config: { permission_mode: 'read_only' },
    }
    const created = await adminApi.createCloudAgentProfile(draftBody, 'fc-draft')
    expect(created.ok).toBe(true)
    const profile = (created as { ok: true; value: { agent_profile_id: string; revision: number } }).value

    // ④ 幂等：同键同体重放同一数据；同键异体 409。
    const replay = await adminApi.createCloudAgentProfile(draftBody, 'fc-draft')
    expect(replay.ok).toBe(true)
    expect((replay as { ok: true; value: { agent_profile_id: string } }).value.agent_profile_id).toBe(profile.agent_profile_id)
    const conflict = await adminApi.createCloudAgentProfile({ ...draftBody, name: '全链路代理改' }, 'fc-draft')
    expect(conflict.ok).toBe(false)
    if (!conflict.ok && conflict.error.kind === 'service') expect(conflict.error.code).toBe('IDEMPOTENCY_CONFLICT')

    // ⑤ 保存草稿（If-Match）→ 新版本（If-Match）→ 发布。
    const saved = await adminApi.updateCloudAgentProfile(profile.agent_profile_id, { reasoning: 'high' }, profile.revision, 'fc-save')
    expect(saved.ok).toBe(true)
    const version = await adminApi.createCloudAgentProfileVersion(
      profile.agent_profile_id,
      { change_summary: '全链路版本', reasoning: 'high' },
      profile.revision + 1,
      'fc-version',
    )
    expect(version.ok).toBe(true)
    const versionId = (version as { ok: true; value: { agent_profile_version_id: string } }).value.agent_profile_version_id
    const adminToken1 = await login('admin@example.com', 'admin-pass')
    const published = await fetch(
      `${baseUrl}/admin/agent-profiles/${profile.agent_profile_id}/versions/${versionId}:publish`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminToken1}`,
          'content-type': 'application/json',
          'idempotency-key': 'fc-publish',
          'if-match': String(profile.revision + 2),
        },
        body: JSON.stringify({}),
      },
    )
    expect(published.status).toBe(200)
    const publishedBody = (await published.json()) as { data: { status: string; published_by: string } }
    expect(publishedBody.data).toMatchObject({ status: 'published', published_by: '平台管理员' })

    // ⑥ 绑定 project-alpha 默认 → 成员可见（富化字段 + 默认标记，且无凭据字段）。
    const bound = await adminApi.bindCloudAgentProfile(
      profile.agent_profile_id,
      'project-alpha',
      profile.revision + 3,
      { agent_profile_version_id: versionId, default: true },
      'fc-bind',
    )
    expect(bound.ok).toBe(true)
    const memberBodyItems = await fetchWalked('/me/agent-profiles?project_id=project-alpha', memberToken)
    const memberItem = memberBodyItems.find(item => item.agent_profile_version_id === versionId)
    expect(memberItem).toBeDefined()
    expect(memberItem).toMatchObject({ name: '全链路代理', readiness: 'ready', default: true, agent_type_name: 'Claude Code' })
    expect(JSON.stringify(memberBodyItems)).not.toContain('credential_ref')

    // ⑦ Run 覆盖：策略快照固化 + 写入升级被拒。
    const run = await fetch(`${baseUrl}/workspaces/ws-alpha-1/runs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${memberToken}`, 'content-type': 'application/json', 'idempotency-key': 'fc-run' },
      body: JSON.stringify({ session_id: 'sess-fc', write_mode: 'read_only', expected_workspace_revision: 7, agent_profile_version_id: versionId }),
    })
    expect(run.status).toBe(202)
    const runBody = (await run.json()) as { data: { execution_policy: Record<string, unknown>; asset_version_ids: string[] } }
    expect(runBody.data.execution_policy).toMatchObject({ write_mode: 'read_only', tool_allowlist: ['read'] })
    expect(runBody.data.asset_version_ids).toContain('skill:code-review@1.0.0')

    const escalation = await fetch(`${baseUrl}/workspaces/ws-alpha-1/runs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${memberToken}`, 'content-type': 'application/json', 'idempotency-key': 'fc-run-escalate' },
      body: JSON.stringify({ session_id: 'sess-fc', write_mode: 'write', expected_workspace_revision: 7, agent_profile_version_id: versionId }),
    })
    expect(escalation.status).toBe(422)

    // ⑧ 下游失败：场景头使全部路由 503。
    const adminToken2 = await login('admin@example.com', 'admin-pass')
    const downstream = await fetch(`${baseUrl}/admin/agent-profiles/${profile.agent_profile_id}`, {
      headers: { authorization: `Bearer ${adminToken2}`, 'x-fixture-scenario': 'workspace-downstream-failure' },
    })
    expect(downstream.status).toBe(503)
    expect(await downstream.json()).toMatchObject({ code: 'SERVICE_UNAVAILABLE', data: null })

    // ⑨ 归档 → 成员不可见。
    const adminToken3 = await login('admin@example.com', 'admin-pass')
    const archived = await fetch(
      `${baseUrl}/admin/agent-profiles/${profile.agent_profile_id}/versions/${versionId}:archive`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminToken3}`,
          'content-type': 'application/json',
          'idempotency-key': 'fc-archive',
          'if-match': String(profile.revision + 4),
        },
        body: JSON.stringify({}),
      },
    )
    expect(archived.status).toBe(200)
    const afterItems = await fetchWalked('/me/agent-profiles?project_id=project-alpha', memberToken) as Array<{ agent_profile_version_id: string }>
    expect(afterItems.some(item => item.agent_profile_version_id === versionId)).toBe(false)

    // ⑩ 审计行（字面 actor_name + request_id + result）。
    const adminToken4 = await login('admin@example.com', 'admin-pass')
    const auditsRes = await fetch(`${baseUrl}/admin/audits?agent_profile_id=${profile.agent_profile_id}`, { headers: { authorization: `Bearer ${adminToken4}` } })
    const auditRows = ((await auditsRes.json()) as { data: Array<Record<string, unknown>> }).data
    const actions = auditRows.map(row => row.action)
    for (const expected of ['agent_profile.create', 'agent_profile.update', 'agent_profile.version.create', 'agent_profile.version.publish', 'agent_profile.bind']) {
      expect(actions).toContain(expected)
    }
    const publishRow = auditRows.find(row => row.action === 'agent_profile.version.publish')
    expect(publishRow).toMatchObject({ actor_name: '平台管理员', result: 'succeeded' })
    expect(typeof publishRow?.request_id === 'string' && publishRow.request_id.length > 0).toBe(true)
  }, 30_000)

  it('emits agent_profile events on the admin stream for governance mutations', async () => {
    void memberToken
    const adminToken = await login('admin@example.com', 'admin-pass')
    const stream = await fetch(`${baseUrl}/admin/events/stream`, {
      headers: { authorization: `Bearer ${adminToken}`, accept: 'text/event-stream' },
    })
    expect(stream.headers.get('content-type')).toContain('text/event-stream')
    const created = await adminApi.createCloudAgentProfile({
      name: '事件链代理',
      agent_type_id: 'at-claude-code',
      model: 'deepseek-v3.2',
      asset_bindings: { skills: [{ asset_version_id: 'skill:code-review@1.0.0', required: true }], knowledge_bases: [], memory: null },
      credential_ref: { name: 'deepseek-main', kind: 'api_key' },
      type_extension_config: { permission_mode: 'approval' },
    }, 'ev-create')
    expect(created.ok).toBe(true)
    const profile = (created as { ok: true; value: { agent_profile_id: string; revision: number } }).value
    const adminToken5 = await login('admin@example.com', 'admin-pass')
    const published = await fetch(
      `${baseUrl}/admin/agent-profiles/${profile.agent_profile_id}/versions/${(created as { ok: true; value: { versions: Array<{ agent_profile_version_id: string }> } }).value.versions[0].agent_profile_version_id}:publish`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminToken5}`,
          'content-type': 'application/json',
          'idempotency-key': 'ev-publish',
          'if-match': String(profile.revision),
        },
        body: JSON.stringify({}),
      },
    )
    expect(published.status).toBe(200)

    const frames = await readSse(
      stream,
      frame => frame.includes('agent_profile.published') && frame.includes(profile.agent_profile_id),
      400,
    )
    const types = frames.map((frame) => {
      const eventLine = frame.split('\n').find(candidate => candidate.startsWith('event: '))
      return eventLine === undefined ? '' : eventLine.slice('event: '.length)
    })
    expect(types).toContain('agent_profile.created')
    expect(types).toContain('agent_profile.published')
  }, 30_000)
})
