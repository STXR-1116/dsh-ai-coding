// @vitest-environment jsdom
/* oxlint-disable typescript/no-unnecessary-type-assertion -- 跨包装配真实 Host/视图。 */
/* oxlint-disable typescript/no-unsafe-assignment -- 跨包装配真实 Host/视图。 */
/* oxlint-disable typescript/no-unsafe-call -- 跨包装配真实 Host/视图。 */
/* oxlint-disable typescript/no-unsafe-member-access -- 跨包装配真实 Host/视图。 */
/* oxlint-disable typescript/no-unsafe-argument -- 跨包装配真实 Host/视图。 */
/* oxlint-disable typescript/no-unsafe-return -- 跨包装配真实 Host/视图。 */
/* AFC-01：Agent 配置跨应用全链路闭环。同一个真实 team-skill-service fixture 实例、
 * 同一测试窗口内完成：后台治理写入（真实 TeamSkillApi）→ 真实 fixture 状态变化 →
 * 插件 Host 读取（真实 WorkspaceHost，严格解析）→ 真实 AgentConfigView 渲染 →
 * 归档/解绑后插件刷新并证明配置消失。分类：FIXTURE-ONLY。
 *
 * AFC-07：把实际 Web 管理后台页面纳入同一链路。上面那条用例驱动的是后台 API 客户端；
 * 下面这条用例挂载真实 `CloudProfilesPage`，全程只用后台页面控件（表单、筛选、发布确认、
 * 绑定默认、归档、解绑），每一步都断言真实 HTTP 方法/路径/请求体/If-Match/Idempotency-Key
 * 与响应 envelope（request_id、x-fixture-only），再由同一 Host 与同一插件实例读回。
 * 分类：FIXTURE-ONLY。 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import React from 'react'
import { createTeamSkillService } from '../../team-skill-service/src/server.ts'
import { TeamSkillApi } from '../src/lib/team-skill-api.ts'
import { CloudProfilesPage } from '../src/components/cloud-workspace-pages.tsx'
import type { CapturedRequest } from './request-capture.ts'
import { captureRequests } from './request-capture.ts'
import { WorkspaceHost } from '../../../src/workspace-host.ts'
import type { WorkspaceSessionProvider } from '../../../src/workspace-host.ts'
import { AgentConfigView } from '../../../src/client/agent-config/AgentConfigView.tsx'

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
  cleanup()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

let baseUrl = ''
let adminApi: TeamSkillApi
let memberHost: WorkspaceHost

async function memberSession(): Promise<WorkspaceSessionProvider> {
  let current = 'demo-token'
  return {
    read: async () => (current.length === 0 ? undefined : { accessToken: current, identity: 'identity:demo-token' }),
    clear: async () => {
      current = ''
      return true
    },
  }
}

const projects = [
  { projectId: 'project-alpha', organizationId: 'org-alpha', organizationName: '星河 AI 平台', name: '协作台前端', description: '', status: 'active', createdBy: 'admin-1', createdAt: 'x', updatedAt: 'x', memberCount: 2, assetCount: 3, revision: 1 },
] as never

/** 后台页面写入的服务端 envelope：请求证据 + 响应 evidence 的单一取用面。 */
function lastWrite(captured: readonly CapturedRequest[], urlPart: string, method: string): CapturedRequest {
  const matches = captured.filter(item => item.url.includes(urlPart) && item.method === method)
  expect(matches.length, `${method} ${urlPart} 未捕获到请求`).toBeGreaterThan(0)
  return matches.at(-1) as CapturedRequest
}

function bodyOf(request: CapturedRequest): Record<string, unknown> {
  expect(request.body, `${request.method} ${request.url} 请求体缺失`).toBeTypeOf('object')
  return request.body as Record<string, unknown>
}

/** 服务端 envelope 的 data 段；缺失即协议错误，不得用空对象兜底。 */
function dataOf(request: CapturedRequest): Record<string, unknown> {
  const envelope = request.responseBody as { data?: unknown } | undefined
  expect(envelope, `${request.method} ${request.url} 响应不是 JSON envelope`).toBeDefined()
  expect(envelope?.data, `${request.method} ${request.url} 响应缺少 data`).toBeTypeOf('object')
  return envelope?.data as Record<string, unknown>
}

describe('AFC-01 cross-app agent config chain', () => {
  it('shares one fixture between admin governance, Host parsing and plugin rendering, then proves archival removal', async () => {
    // ─── 启动：一个真实 fixture 实例；后台治理 + 插件读取共用它。 ───
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    baseUrl = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}/v1`
    const captured: CapturedRequest[] = []
    adminApi = new TeamSkillApi({
      baseUrl,
      accessToken: 'admin-demo',
      fetcher: captureRequests(captured, 'admin-demo'),
    })
    memberHost = new WorkspaceHost({
      apiBaseUrl: baseUrl,
      session: await memberSession(),
    })

    // ─── 后台治理：schema / 候选 → 草稿 → 保存 → 新版本 → 发布。 ───
    const types = await adminApi.cloudAgentTypes()
    if (!types.ok) console.log('TYPES ERROR:', JSON.stringify(types.error), 'evidence:', JSON.stringify(types.evidence ?? null))
    expect(types.ok).toBe(true)
    expect(types.evidence.fixtureOnly).toBe(true)
    const claude = (types.ok ? types.value : []).find(item => item.key === 'claude_code')
    expect(claude?.readiness).toBe('ready')

    const candidates = await adminApi.cloudAssetCandidates('project-alpha')
    expect(candidates.ok).toBe(true)
    expect((candidates.ok ? candidates.value : []).some(item => item.asset_id === 'skill:code-review@1.0.0')).toBe(true)

    const created = await adminApi.createCloudAgentProfile({
      name: 'AFC-01 链路代理',
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
      type_extension_config: { permission_mode: 'approval' },
    }, 'afc01-draft')
    expect(created.ok).toBe(true)
    const profile = (created as { ok: true; value: { agent_profile_id: string; revision: number } }).value
    const createRequest = captured.find(item => item.url.endsWith('/admin/agent-profiles') && item.method === 'POST')
    expect(createRequest?.body).toMatchObject({ name: 'AFC-01 链路代理', agent_type_id: 'at-claude-code' })

    const saved = await adminApi.updateCloudAgentProfile(profile.agent_profile_id, { reasoning: 'high' }, profile.revision, 'afc01-save')
    expect(saved.ok).toBe(true)
    const version = await adminApi.createCloudAgentProfileVersion(
      profile.agent_profile_id,
      { change_summary: 'AFC-01 版本' },
      profile.revision + 1,
      'afc01-version',
    )
    expect(version.ok).toBe(true)
    const versionId = (version as { ok: true; value: { agent_profile_version_id: string } }).value.agent_profile_version_id
    const published = await adminApi.publishCloudAgentProfileVersion(profile.agent_profile_id, versionId, profile.revision + 2, 'afc01-publish')
    expect(published.ok).toBe(true)

    const bound = await adminApi.bindCloudAgentProfile(
      profile.agent_profile_id,
      'project-alpha',
      profile.revision + 3,
      { agent_profile_version_id: versionId, default: true },
      'afc01-bind',
    )
    expect(bound.ok).toBe(true)

    // ─── 插件 Host 读取（member 会话，同一 fixture）：严格解析富化载荷。 ───
    const memberProfiles = await memberHost.agentProfiles('project-alpha')
    expect(memberProfiles.status).toBe('ready')
    if (memberProfiles.status !== 'ready') return
    const chainCard = memberProfiles.value.find(item => item.agentProfileId === profile.agent_profile_id)
    expect(chainCard).toBeDefined()
    expect(chainCard).toMatchObject({
      name: 'AFC-01 链路代理',
      readiness: 'ready',
      default: true,
      status: 'published',
      model: 'deepseek-v3.2',
      reasoning: 'high',
    })
    expect(chainCard?.skills.map(skill => skill.assetVersionId)).toEqual(['skill:code-review@1.0.0'])
    expect(chainCard?.memory).toMatchObject({ assetVersionId: 'memory:m-1' })
    expect(chainCard?.executionPolicy.write_mode).toBe('read_only')

    // ─── 插件 AgentConfigView 渲染：卡片 + 只读详情来自同一真实状态。 ───
    const remote = {
      cloudWorkspaces: {
        agentProfiles: async (projectId: string) => ({ ok: true as const, value: await memberHost.agentProfiles(projectId) }),
        agentProfileVersion: async (versionId: string) => ({ ok: true as const, value: await memberHost.agentProfileVersion(versionId) }),
        agentTypeSchema: async (agentTypeId: string) => ({ ok: true as const, value: await memberHost.agentTypeSchema(agentTypeId) }),
      },
    } as unknown as import('@deepseek-ai/dsh-api-remotes/client').ClientRemote
    render(
      <AgentConfigView remote={remote} projectId="project-alpha" projects={projects as never} />,
    )
    await waitFor(() => {
      expect(screen.getByText('AFC-01 链路代理')).toBeTruthy()
    })
    // 每张卡片都有 data-profile-id；种子卡片与新链路卡片同屏。
    const cards = document.querySelectorAll('[data-profile-id]')
    const ids = [...cards].map(el => el.getAttribute('data-profile-id'))
    expect(ids).toContain(profile.agent_profile_id)
    expect(ids).toContain('ap-code-default')
    const chainCardEl = screen.getByText('AFC-01 链路代理').closest('[data-profile-id]') as HTMLElement
    fireEvent.click(within(chainCardEl).getByRole('button', { name: '查看只读详情' }))
    const dialog = await screen.findByRole('dialog', { name: '配置只读详情' })
    await waitFor(() => {
      expect(dialog.textContent).toContain('基本信息')
    })
    expect(dialog.textContent).toContain('deepseek-v3.2')
    expect(dialog.textContent).toContain('记忆库 m-1')
    expect(dialog.textContent).toContain('允许写入')

    // ─── 归档 + 解绑 → 同一插件实例刷新后配置从项目列表消失。 ───
    const adminTokenArchive = 'admin-demo'
    const archiveRes = await fetch(`${baseUrl}/admin/agent-profiles/${profile.agent_profile_id}/versions/${versionId}:archive`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${adminTokenArchive}`,
        'content-type': 'application/json',
        'idempotency-key': 'afc01-archive',
        'if-match': String(profile.revision + 4),
      },
      body: JSON.stringify({}),
    })
    expect(archiveRes.status).toBe(200)
    const unbindRes = await fetch(`${baseUrl}/admin/agent-profiles/${profile.agent_profile_id}/project-bindings/project-alpha`, {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${adminTokenArchive}`,
        'content-type': 'application/json',
        'idempotency-key': 'afc01-unbind',
        'if-match': String(profile.revision + 5),
      },
      body: JSON.stringify({}),
    })
    expect(unbindRes.status).toBe(200)

    // 同一插件实例（未重挂载）刷新：配置从项目列表消失，详情引用失效。
    fireEvent.click(screen.getByRole('button', { name: '刷新配置列表' }))
    await waitFor(() => {
      expect(screen.queryByText('AFC-01 链路代理')).toBeNull()
    })
    expect(screen.queryByRole('dialog', { name: '配置只读详情' })).toBeNull()
    const refreshedHost = await memberHost.agentProfiles('project-alpha')
    expect(refreshedHost.status).toBe('ready')
    if (refreshedHost.status === 'ready') {
      expect(refreshedHost.value.some(item => item.agentProfileId === profile.agent_profile_id)).toBe(false)
    }

    // ─── 证据完整性：治理请求体、x-fixture-only、request_id、revision 均已捕获。 ───
    const publishCaptured = captured.find(item => item.url.includes(':publish'))
    expect(publishCaptured).toBeDefined()
    // 发布响应的 fixture-only 溯源与 request_id 在证据链中同时可查。
    expect(publishCaptured?.fixtureOnly).toBe(true)
    expect(publishCaptured?.requestId.length).toBeGreaterThan(0)
    expect(publishCaptured?.body).toMatchObject({})
    void baseUrl
  }, 30_000)
})

describe('AFC-07 admin page inside the same fixture chain', () => {
  it('governs the profile through CloudProfilesPage controls and proves the same Host/plugin instance sees, then loses, it', async () => {
    // ─── 同一真实 fixture + 明确账号会话。 ───
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}/v1`
    const captured: CapturedRequest[] = []
    const pageApi = new TeamSkillApi({
      baseUrl: base,
      accessToken: 'admin-demo',
      fetcher: captureRequests(captured, 'admin-demo'),
    })
    const host = new WorkspaceHost({ apiBaseUrl: base, session: await memberSession() })

    // 后台页面的动作反馈全部留证：任何一次失败都会以 '' 成功文案出现在这里。
    const outcomes: { readonly success: string; readonly ok: boolean; readonly detail: string }[] = []
    const onAction = (result: { ok: boolean }, success: string): void => {
      outcomes.push({
        success,
        ok: result.ok,
        detail: JSON.stringify(result).slice(0, 2000),
      })
    }
    // 发布/归档/绑定/解绑都经 window.confirm 二次确认；真实浏览器里由操作者点击。
    const confirmSpy = vi.fn(() => true)
    vi.stubGlobal('confirm', confirmSpy)

    render(<CloudProfilesPage api={pageApi} onAction={onAction} />)

    // ─── 1. 页面自身的权威读取：列表 + schema + 资产候选。 ───
    await screen.findByLabelText('创建配置名称', undefined, { timeout: 20_000 })
    await waitFor(() => {
      expect(screen.getByLabelText('创建 Agent 类型').textContent).toContain('Claude Code')
    }, { timeout: 20_000 })
    const draftForm = (): ReturnType<typeof within> => within(screen.getByLabelText('创建配置草稿'))
    await waitFor(() => {
      expect(draftForm().getByRole('checkbox', { name: '资产-代码评审 Skill' })).toBeTruthy()
      expect(draftForm().getByRole('button', { name: '资产-知识库 k-1（平台架构）' })).toBeTruthy()
    }, { timeout: 20_000 })
    // 页面读的是真实 HTTP：列表、类型、候选三类请求都带 fixture 溯源。
    const listRead = lastWrite(captured, '/admin/agent-profiles', 'GET')
    expect(listRead.status).toBe(200)
    expect(listRead.fixtureOnly).toBe(true)
    expect(listRead.requestId.length).toBeGreaterThan(0)
    const candidateRead = lastWrite(captured, '/admin/asset-candidates', 'GET')
    expect(candidateRead.fixtureOnly).toBe(true)
    expect(candidateRead.requestId.length).toBeGreaterThan(0)

    // ─── 2. 只用页面控件新建草稿：名称、类型、模型/推理、策略、扩展、凭据、资产。 ───
    fireEvent.change(screen.getByLabelText('创建配置名称'), { target: { value: 'AFC-07 页面链路代理' } })
    fireEvent.change(screen.getByLabelText('创建 Agent 类型'), { target: { value: 'at-claude-code' } })
    fireEvent.change(draftForm().getByLabelText('配置模型'), { target: { value: 'deepseek-v3.2' } })
    fireEvent.change(draftForm().getByLabelText('配置推理'), { target: { value: 'high' } })
    fireEvent.change(draftForm().getByLabelText('配置权限模式'), { target: { value: 'approval' } })
    fireEvent.change(draftForm().getByLabelText('配置写入能力'), { target: { value: 'read_only' } })
    // 类型 schema 驱动的扩展字段（at-claude-code 的 permission_mode 必填且参与发布校验）。
    await waitFor(() => {
      expect(draftForm().getByLabelText('扩展-permission_mode')).toBeTruthy()
    })
    fireEvent.change(draftForm().getByLabelText('扩展-permission_mode'), { target: { value: 'approval' } })
    // 凭据引用：claude_code 声明 credential_required，页面必须能声明它才能发布。
    fireEvent.change(draftForm().getByLabelText('创建凭据名称'), { target: { value: 'deepseek-main' } })
    fireEvent.change(draftForm().getByLabelText('创建凭据类型'), { target: { value: 'api_key' } })
    fireEvent.click(draftForm().getByRole('checkbox', { name: '资产-代码评审 Skill' }))
    fireEvent.click(draftForm().getByRole('button', { name: '资产-知识库 k-1（平台架构）' }))
    fireEvent.change(draftForm().getByLabelText('资产-记忆库'), { target: { value: 'memory:m-1@v1' } })
    fireEvent.click(within(screen.getByLabelText('创建配置草稿')).getByRole('button', { name: '创建草稿' }))

    await waitFor(() => {
      expect(captured.some(item => item.url.endsWith('/admin/agent-profiles') && item.method === 'POST')).toBe(true)
    }, { timeout: 20_000 })
    const createWrite = lastWrite(captured, '/admin/agent-profiles', 'POST')
    expect(createWrite.url).toBe(`${base}/admin/agent-profiles`)
    expect(createWrite.headers['idempotency-key']).toBeTruthy()
    expect(createWrite.fixtureOnly).toBe(true)
    expect(createWrite.requestId.length).toBeGreaterThan(0)
    expect(createWrite.status).toBe(201)
    expect(bodyOf(createWrite)).toEqual({
      name: 'AFC-07 页面链路代理',
      agent_type_id: 'at-claude-code',
      model: 'deepseek-v3.2',
      reasoning: 'high',
      asset_bindings: {
        skills: [{ asset_version_id: 'skill:code-review@1.0.0', required: true, order: 1 }],
        knowledge_bases: [{ asset_version_id: 'knowledge:k-1@v1', required: true, order: 1 }],
        memory: { asset_version_id: 'memory:m-1@v1', required: true },
      },
      execution_policy: {
        permission_mode: 'approval',
        write_mode: 'read_only',
        tool_allowlist: [],
        max_concurrency: 2,
        budget: 200000,
        timeout_ms: 900000,
      },
      credential_ref: { name: 'deepseek-main', kind: 'api_key' },
      type_extension_config: { permission_mode: 'approval' },
    })
    const profileId = dataOf(createWrite).agent_profile_id as string
    expect(profileId.length).toBeGreaterThan(0)
    expect(dataOf(createWrite).status).toBe('draft')
    expect(dataOf(createWrite).revision).toBe(1)

    // 页面按服务端权威快照重读后，新草稿卡片出现在列表里。
    const sectionFor = (): HTMLElement => {
      const section = document.querySelector(`section[data-profile-id="${profileId}"]`)
      expect(section, `列表里没有 ${profileId} 的卡片`).toBeTruthy()
      return section as HTMLElement
    }
    await waitFor(() => {
      expect(sectionFor().textContent).toContain('AFC-07 页面链路代理')
    }, { timeout: 20_000 })
    expect(sectionFor().textContent).toContain('draft')

    // ─── 3. 页面控件保存草稿（PUT + If-Match）。 ───
    const editor = within(screen.getByLabelText(`编辑草稿-${profileId}`))
    fireEvent.change(editor.getByLabelText('配置推理'), { target: { value: 'medium' } })
    fireEvent.click(screen.getByLabelText(`保存草稿-${profileId}`))
    await waitFor(() => {
      expect(captured.some(item => item.url.endsWith(`/admin/agent-profiles/${profileId}`) && item.method === 'PUT')).toBe(true)
    }, { timeout: 20_000 })
    const saveWrite = lastWrite(captured, `/admin/agent-profiles/${profileId}`, 'PUT')
    expect(saveWrite.headers['if-match']).toBe('1')
    expect(saveWrite.headers['idempotency-key']).toBeTruthy()
    expect(saveWrite.fixtureOnly).toBe(true)
    expect(saveWrite.requestId.length).toBeGreaterThan(0)
    expect(bodyOf(saveWrite).reasoning).toBe('medium')
    expect(bodyOf(saveWrite)).toMatchObject({ credential_ref: { name: 'deepseek-main', kind: 'api_key' } })
    expect(dataOf(saveWrite).revision).toBe(2)
    // 页面按服务端快照重读后卡片显示 rev 2：操作者的下一步基于权威视图，而不是本地推测。
    const waitForRevision = async (revision: number): Promise<void> => {
      await waitFor(() => {
        expect(sectionFor().textContent).toContain(`rev ${String(revision)}`)
      }, { timeout: 20_000 })
    }
    await waitForRevision(2)

    // ─── 4. 页面控件创建新版本（POST /versions + If-Match），摘要与推理显式声明。 ───
    fireEvent.click(within(sectionFor()).getByRole('button', { name: '创建新版本' }))
    const versionForm = (): ReturnType<typeof within> => within(screen.getByLabelText(`新版本表单-${profileId}`))
    await waitFor(() => {
      expect(versionForm().getByLabelText(`新版本摘要-${profileId}`)).toBeTruthy()
    })
    fireEvent.change(versionForm().getByLabelText(`新版本摘要-${profileId}`), { target: { value: 'AFC-07 页面新版本' } })
    fireEvent.change(versionForm().getByLabelText('配置推理'), { target: { value: 'low' } })
    fireEvent.click(versionForm().getByRole('button', { name: '提交新版本' }))
    await waitFor(() => {
      expect(captured.some(item => item.url.endsWith(`/admin/agent-profiles/${profileId}/versions`) && item.method === 'POST')).toBe(true)
    }, { timeout: 20_000 })
    const versionWrite = lastWrite(captured, `/admin/agent-profiles/${profileId}/versions`, 'POST')
    expect(versionWrite.headers['if-match']).toBe('2')
    expect(versionWrite.headers['idempotency-key']).toBeTruthy()
    expect(versionWrite.fixtureOnly).toBe(true)
    expect(versionWrite.requestId.length).toBeGreaterThan(0)
    expect(bodyOf(versionWrite)).toMatchObject({
      change_summary: 'AFC-07 页面新版本',
      reasoning: 'low',
      model: 'deepseek-v3.2',
      credential_ref: { name: 'deepseek-main', kind: 'api_key' },
      type_extension_config: { permission_mode: 'approval' },
    })
    expect(bodyOf(versionWrite).asset_bindings).toMatchObject({
      skills: [{ asset_version_id: 'skill:code-review@1.0.0', required: true, order: 1 }],
      knowledge_bases: [{ asset_version_id: 'knowledge:k-1@v1', required: true, order: 1 }],
      memory: { asset_version_id: 'memory:m-1@v1', required: true },
    })
    expect(dataOf(versionWrite).status).toBe('draft')

    // ─── 5. 页面控件发布 v1 与 v2（POST :publish + If-Match + 确认框）。 ───
    await waitFor(() => {
      expect(sectionFor().querySelectorAll('button[data-version]').length).toBe(2)
    }, { timeout: 20_000 })
    const versionButtons = [...sectionFor().querySelectorAll('button[data-version]')] as HTMLElement[]
    const publishedVersionIds = versionButtons.map(button => button.getAttribute('data-version') as string)
    const [v1Id, v2Id] = publishedVersionIds
    expect(v1Id).not.toBe(v2Id)
    for (const versionId of [v1Id, v2Id]) {
      const button = sectionFor().querySelector(`button[data-version="${versionId}"]`) as HTMLElement
      expect(button, `草稿行缺失发布按钮：${versionId}`).toBeTruthy()
      fireEvent.click(button)
      await waitFor(() => {
        expect(captured.some(item => item.url.endsWith(`/versions/${versionId}:publish`))).toBe(true)
      }, { timeout: 20_000 })
      const publishWrite = lastWrite(captured, `/versions/${versionId}:publish`, 'POST')
      expect(publishWrite.headers['idempotency-key']).toBeTruthy()
      expect(publishWrite.fixtureOnly).toBe(true)
      expect(publishWrite.requestId.length).toBeGreaterThan(0)
      expect(publishWrite.status).toBe(200)
      expect(dataOf(publishWrite).status).toBe('published')
      // 页面重读到该版本已发布（草稿行的发布按钮消失）后才进行下一次点击：
      // 下一次发布携带的 If-Match 必须来自权威快照，而不是上一次渲染的旧 revision。
      await waitFor(() => {
        expect(sectionFor().querySelector(`button[data-version="${versionId}"]`)).toBeNull()
      }, { timeout: 20_000 })
    }
    expect(confirmSpy).toHaveBeenCalled()
    // v1 发布用 rev3（PUT 后 revision=2，创建版本后 =3），v2 发布用 rev4。
    expect(lastWrite(captured, `/versions/${v1Id}:publish`, 'POST').headers['if-match']).toBe('3')
    expect(lastWrite(captured, `/versions/${v2Id}:publish`, 'POST').headers['if-match']).toBe('4')

    // ─── 6. 页面控件把 v2 设为项目默认（PUT project-bindings + If-Match）。 ───
    await waitFor(() => {
      // 两个版本都已发布：草稿行（唯一带 data-version 的发布按钮）不再存在。
      expect(sectionFor().querySelectorAll('button[data-version]').length).toBe(0)
    }, { timeout: 20_000 })
    const rowOf = (versionId: string): HTMLElement => {
      const rows = [...sectionFor().querySelectorAll('tbody tr')] as HTMLElement[]
      const row = rows.find(candidate => candidate.textContent !== null && candidate.textContent.includes(versionId))
      expect(row, `版本行缺失：${versionId}`).toBeTruthy()
      return row as HTMLElement
    }
    fireEvent.click(within(rowOf(v2Id)).getByRole('button', { name: '设为默认-AFC-07 页面链路代理' }))
    await waitFor(() => {
      expect(captured.some(item => item.url.includes('/project-bindings/project-alpha') && item.method === 'PUT')).toBe(true)
    }, { timeout: 20_000 })
    const bindWrite = lastWrite(captured, '/project-bindings/project-alpha', 'PUT')
    // bind 前页面重读了权威 profile：两次发布把 revision 推到 5，绑定按 5 竞争。
    expect(bindWrite.headers['if-match']).toBe('5')
    expect(bindWrite.headers['idempotency-key']).toBeTruthy()
    expect(bindWrite.fixtureOnly).toBe(true)
    expect(bindWrite.requestId.length).toBeGreaterThan(0)
    expect(bodyOf(bindWrite)).toEqual({ agent_profile_version_id: v2Id, default: true })
    expect(dataOf(bindWrite).default).toBe(true)
    await waitFor(() => {
      expect(sectionFor().textContent).toContain('project-alpha→')
    }, { timeout: 20_000 })
    expect(sectionFor().textContent).toContain('（默认）')
    // 后台页面这一串动作没有任何失败反馈。
    expect(outcomes.filter(outcome => !outcome.ok)).toEqual([])

    // ─── 7. 同一 Host + 插件 AgentConfigView 读回页面写入的配置。 ───
    const hostProfiles = await host.agentProfiles('project-alpha')
    expect(hostProfiles.status).toBe('ready')
    if (hostProfiles.status !== 'ready') return
    const pageCard = hostProfiles.value.find(item => item.agentProfileId === profileId)
    expect(pageCard).toBeDefined()
    expect(pageCard).toMatchObject({
      name: 'AFC-07 页面链路代理',
      status: 'published',
      default: true,
      model: 'deepseek-v3.2',
      reasoning: 'low',
      readiness: 'ready',
    })
    expect(pageCard?.skills.map(skill => skill.assetVersionId)).toEqual(['skill:code-review@1.0.0'])
    expect(pageCard?.knowledgeBases.map(entry => entry.assetVersionId)).toEqual(['knowledge:k-1@v1'])
    expect(pageCard?.memory).toMatchObject({ assetVersionId: 'memory:m-1@v1' })
    expect(pageCard?.executionPolicy.write_mode).toBe('read_only')
    // 后台把 v2 设为默认后，服务端只保留这一个默认：种子配置的默认标记被取消。
    expect(hostProfiles.value.filter(item => item.default).map(item => item.agentProfileId)).toEqual([profileId])

    const remote = {
      cloudWorkspaces: {
        agentProfiles: async (projectId: string) => ({ ok: true as const, value: await host.agentProfiles(projectId) }),
        agentProfileVersion: async (versionId: string) => ({ ok: true as const, value: await host.agentProfileVersion(versionId) }),
        agentTypeSchema: async (agentTypeId: string) => ({ ok: true as const, value: await host.agentTypeSchema(agentTypeId) }),
      },
    } as unknown as import('@deepseek-ai/dsh-api-remotes/client').ClientRemote
    // 插件渲染到独立容器：后台页面此时仍挂在同一 document 上，
    // 只有按容器取节点才能证明断言的是插件视图而不是后台卡片。
    const pluginRoot = document.createElement('div')
    document.body.append(pluginRoot)
    render(<AgentConfigView remote={remote} projectId="project-alpha" projects={projects as never} />, { container: pluginRoot })
    const plugin = (): ReturnType<typeof within> => within(pluginRoot)
    await waitFor(() => {
      expect(plugin().getByText('AFC-07 页面链路代理')).toBeTruthy()
    })
    const pluginCardEl = plugin().getByText('AFC-07 页面链路代理').closest('[data-profile-id]') as HTMLElement
    expect(pluginCardEl.getAttribute('data-profile-id')).toBe(profileId)
    fireEvent.click(within(pluginCardEl).getByRole('button', { name: '查看只读详情' }))
    const pluginDialog = await plugin().findByRole('dialog', { name: '配置只读详情' })
    await waitFor(() => {
      expect(pluginDialog.textContent).toContain('基本信息')
    })
    expect(pluginDialog.textContent).toContain('deepseek-v3.2')
    expect(pluginDialog.textContent).toContain('记忆库 m-1')

    // ─── 8. 页面控件归档 v1 → 解绑 → 归档 v2。 ───
    const archiveInRow = async (versionId: string): Promise<void> => {
      fireEvent.click(within(rowOf(versionId)).getByRole('button', { name: '归档版本' }))
      await waitFor(() => {
        expect(captured.some(item => item.url.endsWith(`/versions/${versionId}:archive`) && item.method === 'POST')).toBe(true)
      }, { timeout: 20_000 })
      const archiveWrite = lastWrite(captured, `/versions/${versionId}:archive`, 'POST')
      expect(archiveWrite.headers['idempotency-key']).toBeTruthy()
      expect(archiveWrite.fixtureOnly).toBe(true)
      expect(archiveWrite.requestId.length).toBeGreaterThan(0)
      expect(dataOf(archiveWrite).status).toBe('archived')
      await waitFor(() => {
        expect(sectionFor().textContent).toContain('archived')
      }, { timeout: 20_000 })
    }
    await waitForRevision(6)
    await archiveInRow(v1Id)
    expect(lastWrite(captured, `/versions/${v1Id}:archive`, 'POST').headers['if-match']).toBe('6')

    await waitForRevision(7)
    fireEvent.click(within(sectionFor()).getByRole('button', { name: '解除绑定' }))
    await waitFor(() => {
      expect(captured.some(item => item.url.includes('/project-bindings/project-alpha') && item.method === 'DELETE')).toBe(true)
    }, { timeout: 20_000 })
    const unbindWrite = lastWrite(captured, '/project-bindings/project-alpha', 'DELETE')
    expect(unbindWrite.headers['if-match']).toBe('7')
    expect(unbindWrite.headers['idempotency-key']).toBeTruthy()
    expect(unbindWrite.fixtureOnly).toBe(true)
    expect(unbindWrite.requestId.length).toBeGreaterThan(0)
    // 解绑成功后页面重读的服务端状态里不再有项目绑定。
    await waitFor(() => {
      expect(sectionFor().textContent).toContain('项目绑定：无')
    }, { timeout: 20_000 })

    await waitForRevision(8)
    await archiveInRow(v2Id)
    expect(lastWrite(captured, `/versions/${v2Id}:archive`, 'POST').headers['if-match']).toBe('8')
    expect(outcomes.filter(outcome => !outcome.ok)).toEqual([])

    // ─── 9. 归档 + 解绑后：后台页面的权威状态与插件视图都必须移除该配置。 ───
    // 后台页面：卡片按服务端状态呈现「全部版本已归档、无项目绑定」，不再是可治理的配置。
    await waitFor(() => {
      const text = sectionFor().textContent ?? ''
      expect(text).toContain('archived')
      expect(text).toContain('绑定项目 0 个')
      expect(text).toContain('项目绑定：无')
    }, { timeout: 20_000 })
    expect(sectionFor().querySelectorAll('button[data-version]').length).toBe(0)
    // 后台页面的服务端筛选控件：按 published 过滤时该配置已不从权威列表返回。
    fireEvent.change(screen.getByLabelText('筛选-状态'), { target: { value: 'published' } })
    await waitFor(() => {
      // 服务端筛选：按 published 过滤时，这条已归档配置不再从权威列表返回。
      const filtered = lastWrite(captured, '/admin/agent-profiles?', 'GET')
      expect(filtered.url).toContain('status=published')
      expect(document.querySelector(`section[data-profile-id="${profileId}"]`)).toBeNull()
    }, { timeout: 20_000 })
    fireEvent.change(screen.getByLabelText('筛选-状态'), { target: { value: '' } })
    await waitFor(() => {
      expect(document.querySelector(`section[data-profile-id="${profileId}"]`)).toBeTruthy()
    }, { timeout: 20_000 })

    // 插件：同一实例（未重挂载）刷新后配置从项目列表消失，详情引用失效。
    // 后台卡片此时仍在（归档记录对管理员可见），所以断言必须限定在插件容器内。
    fireEvent.click(plugin().getByRole('button', { name: '刷新配置列表' }))
    await waitFor(() => {
      expect(plugin().queryByText('AFC-07 页面链路代理')).toBeNull()
    }, { timeout: 20_000 })
    expect(plugin().queryByRole('dialog', { name: '配置只读详情' })).toBeNull()
    const refreshed = await host.agentProfiles('project-alpha')
    expect(refreshed.status).toBe('ready')
    if (refreshed.status === 'ready') {
      expect(refreshed.value.some(item => item.agentProfileId === profileId)).toBe(false)
      // 唯一默认被解绑后，种子配置仍是项目可见配置——服务端只移除这一条。
      expect(refreshed.value.some(item => item.agentProfileId === 'ap-code-default')).toBe(true)
    }
    // 版本详情路由也不再返回归档版本。
    const archivedVersion = await host.agentProfileVersion(v2Id)
    expect(archivedVersion.status).not.toBe('ready')

    // ─── 10. 终态证据：页面写入的每个治理请求都带 fixture 溯源与唯一 request_id。 ───
    // :dry-run 是只读策略查询（§11.19 同族），无幂等键要求，不计入治理写序列。
    const governance = captured.filter(item => item.method !== 'GET' && !item.streaming && !item.url.includes(':dry-run'))
    const profilePath = `/admin/agent-profiles/${profileId}`
    expect(governance.map(write => `${write.method} ${write.url.slice(base.length)}`)).toEqual([
      'POST /admin/agent-profiles',
      `PUT ${profilePath}`,
      `POST ${profilePath}/versions`,
      `POST ${profilePath}/versions/${v1Id}:publish`,
      `POST ${profilePath}/versions/${v2Id}:publish`,
      `PUT ${profilePath}/project-bindings/project-alpha`,
      `POST ${profilePath}/versions/${v1Id}:archive`,
      `DELETE ${profilePath}/project-bindings/project-alpha`,
      `POST ${profilePath}/versions/${v2Id}:archive`,
    ])
    for (const write of governance) {
      expect(write.fixtureOnly, `${write.method} ${write.url} 缺少 x-fixture-only`).toBe(true)
      expect(write.requestId.length, `${write.method} ${write.url} 缺少 request_id`).toBeGreaterThan(0)
      expect(write.headers['idempotency-key'], `${write.method} ${write.url} 缺少 Idempotency-Key`).toBeTruthy()
    }
    // ─── 11. 审计：同一 fixture 为这 9 次页面动作各写一行，request_id 与浏览器侧一一对应。 ───
    const auditRes = await fetch(`${base}/admin/audits?agent_profile_id=${profileId}`, {
      headers: { authorization: 'Bearer admin-demo' },
    })
    expect(auditRes.status).toBe(200)
    // /admin/audits 的稳定 envelope 直接把数组放在 data 上（没有 items 包装）。
    const auditRows = ((await auditRes.json()) as {
      data: readonly { action: string; actor_name: string; request_id: string; result: string; agent_profile_id: string }[]
    }).data
    // 9 次页面治理动作 + 2 次发布前 dry-run 策略查询（每次恰好一行，§4-9）。
    expect(auditRows.length).toBe(11)
    expect(auditRows.every(row => row.agent_profile_id === profileId)).toBe(true)
    expect(auditRows.every(row => row.result === 'succeeded')).toBe(true)
    // actor_name 是服务端记录的字面量，不是客户端传来的身份。
    expect(auditRows.every(row => row.actor_name.length > 0)).toBe(true)
    expect([...auditRows].map(row => row.action).sort()).toEqual([
      'agent_profile.bind',
      'agent_profile.create',
      'agent_profile.dry_run',
      'agent_profile.dry_run',
      'agent_profile.unbind',
      'agent_profile.update',
      'agent_profile.version.archive',
      'agent_profile.version.archive',
      'agent_profile.version.create',
      'agent_profile.version.publish',
      'agent_profile.version.publish',
    ])
    // 审计的 request_id 集合与页面发出的 11 条非 GET 请求完全相同（9 治理 + 2 dry-run 查询）。
    const allWrites = captured.filter(item => item.method !== 'GET' && !item.streaming)
    expect([...auditRows].map(row => row.request_id).sort()).toEqual(allWrites.map(write => write.requestId).sort())
    expect(outcomes.every(outcome => outcome.ok)).toBe(true)
    // 页面打开的事件流没有被捕获器读走 body：订阅者持有 reader，且带 fixture 溯源。
    const streamOpens = captured.filter(item => item.streaming)
    expect(streamOpens.length).toBeGreaterThan(0)
    expect(streamOpens.every(item => item.url.includes('/admin/events/stream'))).toBe(true)
    // 事件到达后页面重读权威列表：列表 GET 不止首次那一次。
    expect(captured.filter(item => item.url.includes('/admin/agent-profiles')).length).toBeGreaterThan(1)
  }, 120_000)
})
