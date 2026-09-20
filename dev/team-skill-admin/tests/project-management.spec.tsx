// @vitest-environment jsdom
/* oxlint-disable typescript/no-base-to-string -- fetch spy URLs are RequestInfo values. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { AdminDashboard } from '../src/components/admin-dashboard.tsx'

// 4-4「项目管理」视图探针（蓝图 §6.4）。
//
// 异常矩阵：
//   页签   —— 详情六个页签齐备：概览/成员/资产关联/Agent/工作空间/审计；
//             Agent 与工作空间页签经服务端 project_id 过滤读取并渲染表格。
//   归档   —— 归档项目：名称输入禁用、保存按钮禁用并显示只读原因。
//   摘要   —— 概览页渲染安全与运行摘要（运行计数 + 授权拒绝）。
//   依赖   —— 点击归档：确认对话框携带依赖摘要（类别 数量 + 不可逆）。

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  window.history.replaceState({}, '', '/')
})

function response(value: unknown, status = 200): Response {
  const failed = status >= 400
  return new Response(JSON.stringify({
    code: failed ? `HTTP_${status}` : 0,
    message: failed ? '失败' : 'ok',
    request_id: 'test-request',
    data: failed ? null : value,
  }), { status, headers: { 'content-type': 'application/json' } })
}

const projectActive = {
  project_id: 'project-alpha', organization_id: 'org-alpha', organization_name: '星河 AI 平台',
  name: '协作台前端', description: '', status: 'active', created_by: 'admin-1',
  created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-09T00:00:00Z',
  revision: 3, member_count: 2, asset_count: 1,
}
const projectArchived = { ...projectActive, project_id: 'project-arch', name: '已归档项目', status: 'archived' }

function projectFetcher(overrides: { readonly archived?: boolean } = {}): ReturnType<typeof vi.fn> {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input)
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
    if (url.includes('/admin/organizations')) return response({ items: [{ organization_id: 'org-alpha', name: '星河组织', status: 'active', revision: 1 }], next_cursor: null })
    if (url.includes('/admin/projects/project-') && !url.includes('?')) {
      const detail = url.includes('project-arch') || overrides.archived === true ? projectArchived : projectActive
      return response({ ...detail, project_bindings: { project_id: detail.project_id, agent_profile_version_id: 'apv-1', default: true, revision: 1 } })
    }
    if (url.includes('/admin/projects?') || url.endsWith('/admin/projects')) return response({ items: overrides.archived === true ? [projectArchived] : [projectActive], next_cursor: null })
    if (url.includes('/admin/project-members')) return response({ items: [{ user_id: 'u-1', username: 'member@example.com', display_name: '演示成员', role: 'member', revision: 1 }], next_cursor: null })
    if (url.includes('/project-assets')) return response({ items: [], next_cursor: null })
    if (url.includes('/admin/workspaces')) return response({ items: [{ workspace_id: 'ws-1', project_id: 'project-alpha', owner_user_id: 'u-1', repository_id: 'r-1', branch: 'main', display_name: '主空间', default_agent_profile_version_id: 'apv-1', status: 'ready', revision: 2, last_error: null, created_at: '', updated_at: '' }] })
    if (url.includes('/admin/agent-profiles')) {
      return response({ items: [{ agent_profile_id: 'ap-1', organization_id: 'org-alpha', name: '默认研发代理', description: '', agent_type_id: 'at-1', agent_type_name: 'Claude Code', agent_type_readiness: 'ready', skill_count: 1, knowledge_count: 0, memory_name: null, project_count: 1, status: 'published', readiness: 'ready', unavailable_reason: null, created_by: 'admin-1', created_at: '', updated_at: '2026-09-10T00:00:00Z', revision: 1, versions: [], project_bindings: [] }] })
    }
    if (url.includes('/admin/runs')) {
      return response({ items: [
        { run_id: 'r1', project_id: 'project-alpha', workspace_id: 'ws-1', session_id: 's-1', agent_profile_version_id: 'apv-1', asset_version_ids: [], workspace_revision: 7, status: 'running', write_mode: 'write', lease_id: null, revision: 1, error_code: null, created_at: '', updated_at: '' },
        { run_id: 'r2', project_id: 'project-alpha', workspace_id: 'ws-1', session_id: 's-1', agent_profile_version_id: 'apv-1', asset_version_ids: [], workspace_revision: 7, status: 'succeeded', write_mode: 'read_only', lease_id: null, revision: 1, error_code: null, created_at: '', updated_at: '' },
      ] })
    }
    if (url.includes('/admin/authorization-audits')) {
      return response({ items: [
        { id: 'a1', occurred_at: '2026-09-10T00:00:00Z', actor_user_id: 'u9', actor_name: '其他人', action: 'workspace.write', result: 'failed', request_id: 'req-1' },
      ] })
    }
    if (body !== undefined && url.includes('/admin/runs')) return response({ items: [] })
    return response({ items: [] })
  })
}

async function openProjectDetail(archived: boolean, fetcher: ReturnType<typeof vi.fn>): Promise<void> {
  vi.stubGlobal('fetch', fetcher)
  render(React.createElement(AdminDashboard, {
    session: { user: { id: 'admin-1', name: '平台管理员' }, role: 'admin', mustChangePassword: false },
  }))
  fireEvent.click(await screen.findByRole('button', { name: /^项目管理/ }))
  const row = await screen.findByText(archived ? '已归档项目' : '协作台前端')
  fireEvent.click(row.closest('tr') ?? row)
  await screen.findByRole('heading', { name: archived ? '已归档项目' : '协作台前端' })
}

describe('4-4 项目管理', () => {
  it('详情六个页签齐备；Agent 与工作空间页签经 project_id 过滤读取', async () => {
    const fetcher = projectFetcher()
    await openProjectDetail(false, fetcher)

    for (const label of ['概览', '成员', '资产关联', 'Agent', '工作空间', '审计']) {
      expect(screen.getByRole('tab', { name: label })).toBeTruthy()
    }
    fireEvent.click(screen.getByRole('tab', { name: '工作空间' }))
    expect(await screen.findByText('主空间')).toBeTruthy()
    await waitFor(() => {
      expect(fetcher.mock.calls.some(call => String(call[0]).includes('/admin/workspaces?project_id=project-alpha'))).toBe(true)
    })
    fireEvent.click(screen.getByRole('tab', { name: 'Agent' }))
    expect(await screen.findByText('默认研发代理')).toBeTruthy()
  })

  it('概览渲染安全与运行摘要（运行计数 + 授权拒绝）', async () => {
    const fetcher = projectFetcher()
    await openProjectDetail(false, fetcher)

    const summary = await screen.findByRole('region', { name: '安全与运行摘要' })
    expect(summary.textContent).toContain('运行总数')
    expect(summary.textContent).toContain('2')
    expect(summary.textContent).toContain('授权拒绝')
    expect(summary.textContent).toContain('1')
  })

  it('归档项目：输入与保存禁用并显示原因；六页签仍可读', async () => {
    const fetcher = projectFetcher({ archived: true })
    await openProjectDetail(true, fetcher)

    const reason = await screen.findByRole('note', { name: '归档只读说明' })
    expect(reason.textContent).toContain('只读')
    expect(reason.textContent).toContain('禁用')
    const save = screen.getByRole('button', { name: '保存项目' })
    expect(save.disabled).toBe(true)
    expect((screen.getByLabelText('项目名称详情')).disabled).toBe(true)
    // 页签仍可读（只读不禁浏览）
    expect(screen.getByRole('tab', { name: '工作空间' })).toBeTruthy()
  })

  it('点击归档：确认对话框携带依赖摘要（类别 数量 + 不可逆）', async () => {
    const fetcher = projectFetcher()
    await openProjectDetail(false, fetcher)

    fireEvent.click(await screen.findByRole('button', { name: '归档项目' }))
    const dialog = await screen.findByRole('dialog', { name: '确认项目操作' })
    await waitFor(() => {
      expect(dialog.textContent).toContain('工作空间 1')
    })
    expect(dialog.textContent).toContain('不可逆')
    expect(dialog.textContent).toContain('确认归档')
  })
})
