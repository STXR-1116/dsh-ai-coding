import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createTeamSkillService } from '../src/server.ts'

// 2-0「契约先行」审计探针（契约：§11.2 项目代码源目录、§11.4 Agent 草稿编辑与
// 资产候选，2026-09-11 冻结 / 本轮审计固化）。
//
// 异常矩阵 → 子句映射：
//   2-0a  code-sources：字段集 + default_branch ⊆ branches 不变式；
//         无可授权仓库 → 空 items（不造假仓库）；
//         创建 Workspace 时未知仓库 → 403 + 审计、branch 不在授权列表 → 422 + 审计。
//   2-0b  草稿编辑：PUT 带 If-Match + Idempotency-Key 可编辑 name/model/reasoning/
//         asset_bindings/execution_policy；最新版本 published → 409 INVALID_STATE
//         且不产生新版本对象（versions 数不变）；POST versions 缺省继承最新版本。
//   2-0c  资产候选：每项含 asset_id/asset_type/version/name/authorized/readiness/
//         invalid_reason；未授权 → authorized=false + unavailable + 非空原因；
//         发布校验：引用未授权/未就绪资产 → 422 且 message 携带具体资产；
//         project-bindings 只接受 published 版本。

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

async function send(
  port: number,
  method: string,
  path: string,
  token: string,
  body?: unknown,
  extra: Record<string, string> = {},
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: apiHeaders(token, extra),
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

describe('2-0a 项目代码源目录（§11.2）', () => {
  it('default_branch ⊆ branches；无授权仓库返回空 items；创建拒绝带审计', async () => {
    const port = await start()
    const admin = await login(port, 'admin@example.com', 'admin-pass')

    // 字段集与不变式：default_branch 必须属于 branches。
    const list = await send(port, 'GET', '/v1/me/code-sources?project_id=project-alpha', admin)
    expect(list.status).toBe(200)
    const items = ((list.body as { data: { items: Array<Record<string, unknown>> } }).data).items
    expect(items.length).toBeGreaterThan(0)
    for (const item of items) {
      for (const field of ['repository_id', 'name', 'provider', 'default_branch', 'branches']) {
        expect(Object.hasOwn(item, field), `code-source 必须携带 ${field}`).toBe(true)
      }
      const branches = item['branches'] as string[]
      expect(branches).toContain(item['default_branch'])
    }

    // 无可授权仓库 → 空 items（不是占位仓库）：新建项目无任何代码源授权。
    const createdProject = await send(port, 'POST', '/v1/admin/projects', admin, {
      organization_id: 'org-alpha',
      name: '2-0 无代码源项目',
      description: '审计空代码源',
    }, { 'idempotency-key': 'pc20-empty-project' })
    expect(createdProject.status).toBe(201)
    const emptyProjectId = ((createdProject.body as { data: { project_id: string } }).data).project_id
    // 新项目为 draft：激活后才进入授权可见范围（激活带 If-Match 与幂等键）。
    const draftDetail = await send(port, 'GET', `/v1/admin/projects/${emptyProjectId}`, admin)
    const draftRevision = ((draftDetail.body as { data: { revision: number } }).data).revision
    const activated = await send(port, 'POST', `/v1/admin/projects/${emptyProjectId}:activate`, admin, {}, {
      'idempotency-key': 'pc20-activate',
      'if-match': String(draftRevision),
    })
    expect(activated.status).toBe(200)
    const empty = await send(port, 'GET', `/v1/me/code-sources?project_id=${emptyProjectId}`, admin)
    expect(empty.status).toBe(200)
    expect(((empty.body as { data: { items: unknown[] } }).data).items).toHaveLength(0)

    // 创建 Workspace：未知仓库 → 403 FORBIDDEN + workspace.create failed 审计。
    const ws = await send(port, 'GET', '/v1/workspaces/ws-alpha-1', admin)
    const wsRevision = ((ws.body as { data: { revision: number } }).data).revision
    const deniedRepo = await send(port, 'POST', '/v1/projects/project-alpha/workspaces', admin, {
      repository_id: 'repo-unknown',
      branch: 'main',
      agent_profile_version_id: 'apv-1',
      expected_workspace_revision: wsRevision,
    }, { 'idempotency-key': 'pc-repo-denied' })
    expect(deniedRepo.status).toBe(403)
    const auditAfterDeny = await send(port, 'GET', '/v1/admin/audits?action=workspace.create', admin)
    const denyRows = ((auditAfterDeny.body as { data: Array<Record<string, unknown>> }).data)
      .filter(row => row['result'] === 'failed')
    expect(denyRows.length).toBeGreaterThan(0)

    // branch 不在仓库授权列表 → 422。
    const source = items[0] as { repository_id: string; branches: string[] }
    const outsideBranch = source.branches[0] === 'main' ? 'feature/outside' : 'main'
    const deniedBranch = await send(port, 'POST', '/v1/projects/project-alpha/workspaces', admin, {
      repository_id: source.repository_id,
      branch: outsideBranch,
      agent_profile_version_id: 'apv-1',
      expected_workspace_revision: wsRevision,
    }, { 'idempotency-key': 'pc-branch-denied' })
    expect(deniedBranch.status).toBe(422)
  })
})

describe('2-0b Agent 草稿编辑（§11.4）', () => {
  it('编辑草稿带 If-Match/幂等键；published 后原地修改被拒；新版本缺省继承', async () => {
    const port = await start()
    const admin = await login(port, 'admin@example.com', 'admin-pass')

    const created = await send(port, 'POST', '/v1/admin/agent-profiles', admin, {
      name: '2-0 审计配置',
      agent_type_id: 'at-claude-code',
      organization_id: 'org-alpha',
      model: 'deepseek-v3.2',
      reasoning: 'medium',
      asset_bindings: {
        skills: [{ asset_version_id: 'skill:code-review@1.0.0', required: true }],
        knowledge_bases: [],
        memory: null,
      },
      execution_policy: { permission_mode: 'approval', write_mode: 'write' },
      credential_ref: { name: 'deepseek-main', kind: 'api_key' },
      type_extension_config: { permission_mode: 'approval' },
    }, { 'idempotency-key': 'pc20-create' })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const profile = ((created.body as { data: { agent_profile_id: string; revision: number } }).data)

    // 编辑草稿：PUT + If-Match + Idempotency-Key → 200，revision+1。
    const edited = await send(port, 'PUT', `/v1/admin/agent-profiles/${profile.agent_profile_id}`, admin, {
      model: 'deepseek-chat',
      reasoning: 'high',
      execution_policy: { permission_mode: 'auto', write_mode: 'write' },
    }, { 'idempotency-key': 'pc20-edit', 'if-match': String(profile.revision) })
    console.log('PROBE-PUT', JSON.stringify(edited.body), 'IFM', String(profile.revision))
    expect(edited.status, JSON.stringify(edited.body)).toBe(200)
    expect(((edited.body as { data: { revision: number } }).data).revision).toBe(profile.revision + 1)

    // 新版本（缺省继承 model/reasoning）。
    const version = await send(port, 'POST', `/v1/admin/agent-profiles/${profile.agent_profile_id}/versions`, admin, {
      change_summary: '2-0 审计新版本',
    }, { 'idempotency-key': 'pc20-version', 'if-match': String(profile.revision + 1) })
    expect(version.status, await (await fetch(`http://127.0.0.1:${port}/v1/admin/agent-profiles/${profile.agent_profile_id}/versions`, { method: 'POST', headers: apiHeaders(admin, { 'idempotency-key': 'pc20-version-dbg', 'if-match': String(profile.revision + 1) }), body: JSON.stringify({ change_summary: 'dbg' }) })).text()).toBe(201)
    const versionData = (version.body as { data: { agent_profile_version_id: string; model: string; status: string } }).data
    expect(versionData.model).toBe('deepseek-chat')
    expect(versionData.status).toBe('draft')

    // 发布后原地修改 → 409 INVALID_STATE。
    // 版本创建会推进 profile revision：发布 If-Match 以当前值为准。
    const detailAfterVersion = await send(port, 'GET', `/v1/admin/agent-profiles/${profile.agent_profile_id}`, admin)
    const currentRevision = ((detailAfterVersion.body as { data: { revision: number } }).data).revision
    const published = await send(port, 'POST', `/v1/admin/agent-profiles/${profile.agent_profile_id}/versions/${versionData.agent_profile_version_id}:publish`, admin, {}, {
      'idempotency-key': 'pc20-publish',
      'if-match': String(currentRevision),
    })
    expect(published.status, JSON.stringify(published.body)).toBe(200)
    // 当前 profile revision 以服务端为准（发布/版本创建都会推进）。
    const detailNow = await send(port, 'GET', `/v1/admin/agent-profiles/${profile.agent_profile_id}`, admin)
    const reeditRevision = ((detailNow.body as { data: { revision: number } }).data).revision
    const reEdit = await send(port, 'PUT', `/v1/admin/agent-profiles/${profile.agent_profile_id}`, admin, {
      model: 'deepseek-reasoner',
    }, { 'idempotency-key': 'pc20-reedit', 'if-match': String(reeditRevision) })
    expect(reEdit.status).toBe(409)
    expect(reEdit.body.code).toBe('INVALID_STATE')

    // 已发布内容不可原地修改：发布动作不产生新版本对象。
    const detail = await send(port, 'GET', `/v1/admin/agent-profiles/${profile.agent_profile_id}`, admin)
    const versions = ((detail.body as { data: { versions: unknown[] } }).data).versions
    expect(versions.length).toBe(2)
  })
})

describe('2-0c 资产候选与发布校验（§11.4）', () => {
  it('候选字段集完整；发布引用未授权资产 → 422 且 message 携带具体资产', async () => {
    const port = await start()
    const admin = await login(port, 'admin@example.com', 'admin-pass')

    // 候选字段集。
    const candidates = await send(port, 'GET', '/v1/admin/asset-candidates?project_id=project-alpha', admin)
    expect(candidates.status).toBe(200)
    const items = ((candidates.body as { data: { items: Array<Record<string, unknown>> } }).data).items
    expect(items.length).toBeGreaterThan(0)
    for (const item of items) {
      for (const field of ['asset_id', 'asset_type', 'version', 'name', 'authorized', 'readiness', 'invalid_reason']) {
        expect(Object.hasOwn(item, field), `资产候选必须携带 ${field}`).toBe(true)
      }
      if (item['authorized'] === false) {
        expect(item['readiness']).toBe('unavailable')
        expect(String(item['invalid_reason']).length).toBeGreaterThan(0)
      }
    }
    // 同时存在已授权可用与未授权两类，证明过滤是数据驱动的。
    expect(items.some(item => item['authorized'] === true)).toBe(true)
    expect(items.some(item => item['authorized'] === false)).toBe(true)

    // 发布校验：版本引用未授权资产 → 422，message 携带具体资产 id。
    const created = await send(port, 'POST', '/v1/admin/agent-profiles', admin, {
      name: '2-0c 发布校验配置',
      agent_type_id: 'at-claude-code',
      organization_id: 'org-alpha',
      model: 'deepseek-v3.2',
      reasoning: 'medium',
      asset_bindings: {
        skills: [{ asset_version_id: 'skill:unauthorized@1.0.0', required: true }],
        knowledge_bases: [],
        memory: null,
      },
      execution_policy: { permission_mode: 'approval', write_mode: 'read_only' },
      type_extension_config: { permission_mode: 'approval' },
    }, { 'idempotency-key': 'pc20-create-unauth' })
    expect(created.status).toBe(201)
    const createdProfile = (created.body as {
      data: {
        agent_profile_id: string
        revision: number
        versions: Array<{ agent_profile_version_id: string }>
      }
    }).data
    const publish = await send(
      port,
      'POST',
      `/v1/admin/agent-profiles/${createdProfile.agent_profile_id}/versions/${createdProfile.versions[0]?.agent_profile_version_id ?? ''}:publish`,
      admin,
      {},
      { 'idempotency-key': 'pc20-publish-unauthorized', 'if-match': String(createdProfile.revision) },
    )
    expect(publish.status).toBe(422)
    expect(JSON.stringify(publish.body)).toContain('skill:unauthorized@1.0.0')
  })
})
