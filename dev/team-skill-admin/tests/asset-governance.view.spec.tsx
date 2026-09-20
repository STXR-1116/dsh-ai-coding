// @vitest-environment jsdom
/* oxlint-disable typescript/no-base-to-string -- Fetch spy assertions inspect RequestInfo wire values. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import React from 'react'
import { AdminDashboard } from '../src/components/admin-dashboard.tsx'

// 4-5「Agent 与资产治理」视图探针（蓝图 §6.5）。
//
// 异常矩阵：
//   发布校验 —— 点击发布先跑 dry-run；blocked 时逐项列出未授权/未就绪资产
//              （检查面板 + 阻断原因）且不发起发布；ready 时发布继续。
//   健康表  —— Skill/知识库/记忆库候选归一为同一套健康表（类型/名称/版本/
//              授权/readiness/健康/原因），unhealthy 行保留服务端原因。
//   diff    —— 版本差异包含 工具 与 权限策略（permission_mode/write_mode）
//              拆分维度。

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function response(value: unknown, status = 200): Response {
  const record = typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  const data = status < 400 && record !== undefined && Object.hasOwn(record, 'data') ? record.data : value
  return new Response(JSON.stringify({
    code: status >= 400 ? (typeof record?.code === 'string' ? record.code : `HTTP_${status}`) : 0,
    message: status >= 400 ? (typeof record?.message === 'string' ? record.message : 'failed') : 'ok',
    request_id: 'test-request',
    data: status >= 400 ? null : data,
  }), { status, headers: { 'content-type': 'application/json' } })
}

const profile = {
  agent_profile_id: 'ap-1', organization_id: 'org-alpha', name: '治理代理', description: '',
  agent_type_id: 'at-claude-code', agent_type_name: 'Claude Code', agent_type_readiness: 'ready',
  skill_count: 1, knowledge_count: 0, memory_name: null, project_count: 0,
  status: 'draft', readiness: 'ready', unavailable_reason: null,
  created_by: 'admin-1', created_at: '', updated_at: '2026-09-10T00:00:00Z', revision: 2,
  versions: [
    {
      agent_profile_version_id: 'apv-1', version: 'v1', status: 'published', model: 'deepseek-v3.2', reasoning: 'medium',
      asset_bindings: { skills: [{ asset_version_id: 'skill:code-review@1.0.0', required: true, order: 1 }], knowledge_bases: [], memory: null },
      asset_version_ids: ['skill:code-review@1.0.0'],
      execution_policy: { permission_mode: 'auto', write_mode: 'write', tool_allowlist: ['read'] },
      type_extension_config: {}, credential_ref: null, change_summary: 'v1',
      published_at: '2026-09-09T00:00:00Z', published_by: '平台管理员',
    },
    {
      agent_profile_version_id: 'apv-2', version: 'v2', status: 'draft', model: 'deepseek-v3.2', reasoning: 'high',
      asset_bindings: { skills: [{ asset_version_id: 'skill:code-review@1.0.0', required: true, order: 1 }], knowledge_bases: [], memory: null },
      asset_version_ids: ['skill:code-review@1.0.0'],
      execution_policy: { permission_mode: 'approval', write_mode: 'read_only', tool_allowlist: ['read', 'write'] },
      type_extension_config: {}, credential_ref: null, change_summary: 'v2',
    },
  ],
  project_bindings: [],
}

const candidates = { items: [
  { asset_id: 'skill:code-review@1.0.0', asset_type: 'skill', version: '1.0.0', name: '代码评审', authorized: true, readiness: 'ready', invalid_reason: null, updated_at: '', purpose: '评审', source: 'team' },
  { asset_id: 'knowledge:k-9', asset_type: 'knowledge', version: 'v1', name: '未授权知识', authorized: false, readiness: 'unavailable', invalid_reason: '资产未授权给该项目', updated_at: '', purpose: '检索', source: 'organization' },
  { asset_id: 'memory:m-1', asset_type: 'memory', version: 'v1', name: '协作偏好', authorized: true, readiness: 'ready', invalid_reason: null, updated_at: '', purpose: '召回', source: 'builtin' },
], next_cursor: null }

const SESSION = { user: { id: 'admin-1', name: '平台管理员' }, role: 'admin' as const, mustChangePassword: false }

async function openProfilesPage(fetcher: ReturnType<typeof vi.fn>): Promise<void> {
  vi.stubEnv('NEXT_PUBLIC_TEAM_SKILL_API_URL', 'http://service.test/v1')
  vi.stubEnv('NEXT_PUBLIC_TEAM_SKILL_ACCESS_TOKEN', 'admin-demo')
  vi.stubGlobal('fetch', fetcher)
  render(React.createElement(AdminDashboard, { session: SESSION }))
  fireEvent.click(screen.getByRole('button', { name: /^Agent 配置/ }))
  const nav = await screen.findByLabelText('Agent 配置子导航')
  fireEvent.click(within(nav).getByRole('button', { name: /^Agent 配置/u }))
  await screen.findByText('治理代理')
}

describe('4-5 Agent 与资产治理', () => {
  it('资产健康表：三类候选归一渲染，不健康行带原因', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.includes('/admin/asset-candidates')) return response(candidates)
      return response({ items: [profile] })
    })
    await openProfilesPage(fetcher)

    const table = await screen.findByRole('table', { name: '资产健康表' })
    expect(table.textContent).toContain('代码评审')
    expect(table.textContent).toContain('未授权知识')
    expect(table.textContent).toContain('协作偏好')
    expect(table.textContent).toContain('不健康')
    expect(table.textContent).toContain('资产未授权给该项目')
  })

  it('发布被校验阻断：逐项列出未授权资产，不发起发布', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.includes(':dry-run')) {
        return response({
          dry_run_id: 'dry-1', agent_profile_version_id: 'apv-2', outcome: 'blocked',
          checks: [
            { check: 'asset_authorized', result: 'fail', detail: '未授权资产：knowledge:k-9' },
            { check: 'version_state', result: 'warn', detail: '草稿版本' },
          ],
          created_at: '2026-09-17T00:00:00Z',
        })
      }
      if (url.includes(':publish')) return response({ agent_profile_id: 'ap-1', status: 'published', revision: 3 })
      if (url.includes('/admin/asset-candidates')) return response(candidates)
      return response({ items: [profile] })
    })
    await openProfilesPage(fetcher)

    fireEvent.click(await screen.findByRole('button', { name: '发布版本' }))
    await waitFor(() => {
      expect(screen.getByLabelText(/发布校验 apv-2/)).toBeTruthy()
    })
    const checks = screen.getByLabelText(/发布校验 apv-2/)
    expect(checks.textContent).toContain('未授权资产：knowledge:k-9')
    await waitFor(() => {
      expect(screen.getByText(/发布被校验阻断/)).toBeTruthy()
    })
    // blocked 不发起发布
    expect(fetcher.mock.calls.some(call => String(call[0]).includes(':publish'))).toBe(false)
  })

  it('试运行就绪后发布继续；版本差异含工具与权限策略维度', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.includes(':dry-run')) {
        return response({
          dry_run_id: 'dry-2', agent_profile_version_id: 'apv-2', outcome: 'ready',
          checks: [
            { check: 'asset_authorized', result: 'pass', detail: '全部已授权' },
            { check: 'asset_ready', result: 'pass', detail: '全部就绪' },
            { check: 'version_state', result: 'warn', detail: '草稿版本' },
            { check: 'context_assembly', result: 'pass', detail: '装配就绪' },
          ],
          created_at: '2026-09-17T00:00:00Z',
        })
      }
      if (url.includes(':publish')) return response({ agent_profile_id: 'ap-1', status: 'published', revision: 3 })
      if (url.includes('/admin/asset-candidates')) return response(candidates)
      return response({ items: [profile] })
    })
    await openProfilesPage(fetcher)

    fireEvent.click(await screen.findByRole('button', { name: '发布版本' }))
    await waitFor(() => {
      expect(fetcher.mock.calls.some(call => String(call[0]).includes(':publish'))).toBe(true)
    })
    expect(confirmSpy).toHaveBeenCalled()
    // 版本差异维度：工具与权限策略在版本差异表中可见
    expect(screen.getByText('工具')).toBeTruthy()
    expect(screen.getByText('权限策略 · permission_mode')).toBeTruthy()
    expect(screen.getByText('权限策略 · write_mode')).toBeTruthy()
  })
})
