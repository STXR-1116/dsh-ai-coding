/* oxlint-disable typescript/no-base-to-string -- fetch spy URLs are RequestInfo values. */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { AdminDashboard } from '../src/components/admin-dashboard.tsx'

// 4-2「命令面板」视图探针（蓝图 §6.2）。
//
// 异常矩阵：
//   打开  —— Ctrl+K 与头部按钮都可打开面板。
//   搜索  —— 输入关键词后按类别呈现结果，每条带执行前披露（权限+只读影响）。
//   跳转  —— 选中结果进入对应页面（运行 → 云工作空间运行页）。

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
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

function paletteFetcher(): ReturnType<typeof vi.fn> {
  return vi.fn<typeof fetch>(async (input, _init) => {
    const url = String(input)
    if (url.includes('/admin/telemetry/overview')) {
      return response({
        from: '2026-09-09T00:00:00.000Z', to: '2026-09-16T00:00:00.000Z', has_data: false,
        summary: {
          sessions: { total: 0, completed: 0, errors: 0, interrupted: 0, cancelled: 0 },
          turns: {
            total: 0, completed: 0, errors: 0, blocked: 0, max_tokens: 0,
            interrupted: 0, cancelled: 0, p50_duration_ms: 0, p95_duration_ms: 0,
          },
          steps: { started: 0, finished: 0, p50_duration_ms: 0, p95_duration_ms: 0 },
          llm: {
            requests: 0, retries: 0, input_tokens: 0, output_tokens: 0, total_tokens: null,
            token_sample_size: 0, input_token_samples: 0, output_token_samples: 0, total_token_samples: 0,
          },
          tools: { calls: 0, errors: 0, p50_duration_ms: 0, p95_duration_ms: 0 },
          approvals: { requested: 0, allowed_once: 0, rejected: 0, cancelled: 0, unavailable: 0 },
          compactions: 0,
          delivery: { accepted: 0, duplicate: 0, retryable: 0, rejected: 0, queued: 0, gaps: 0 },
        },
        buckets: [], retention_days: 90,
      })
    }
    if (url.includes('/admin/organizations')) return response({ items: [{ organization_id: 'org-alpha', name: '星河组织', status: 'active', revision: 1 }], next_cursor: null })
    if (url.includes('/admin/team-skills')) return response([{ skillId: 'sk-1', displayName: '代码评审 Skill', status: 'published', revision: 1 }])
    if (url.includes('/admin/team-skill-reviews')) return response([])
    if (url.includes('/admin/projects')) return response({ items: [{ project_id: 'project-alpha', organization_id: 'org-alpha', organization_name: '星河 AI 平台', name: '协作台前端', description: '', status: 'active', created_by: 'admin-1', created_at: '', updated_at: '', revision: 1, member_count: 2, asset_count: 0 }], next_cursor: null })
    if (url.includes('/admin/workspaces')) return response([])
    if (url.includes('/admin/runs')) {
      return response({ items: [{
        run_id: 'run-alpha-9', project_id: 'project-alpha', workspace_id: 'ws-1', session_id: 's-1',
        agent_profile_version_id: 'apv-1', asset_version_ids: [], workspace_revision: 7,
        status: 'running', write_mode: 'write', lease_id: null, revision: 2, error_code: null,
        created_at: '2026-09-10T00:00:00Z', updated_at: '2026-09-10T00:01:00Z',
      }] })
    }
    if (url.includes('/admin/agent-profiles')) {
      return response([{
        agent_profile_id: 'ap-alpha-1', organization_id: 'org-alpha', name: '默认研发代理', description: '',
        agent_type_id: 'at-1', agent_type_name: 'Claude Code', agent_type_readiness: 'ready',
        skill_count: 0, knowledge_count: 0, memory_name: null, project_count: 0,
        status: 'published', readiness: 'ready', unavailable_reason: null,
        created_by: 'admin-1', created_at: '', updated_at: '', revision: 1, versions: [], project_bindings: [],
      }])
    }
    if (url.includes('/admin/authorization-audits')) {
      return response({ items: [
        { id: 'a1', occurred_at: '2026-09-10T00:00:00Z', actor_user_id: 'member-1', actor_name: '演示成员', action: 'workspace.write', result: 'succeeded', request_id: 'req-alpha-1' },
      ] })
    }
    return response({ items: [] })
  })
}

function renderDashboard(fetcher: ReturnType<typeof vi.fn>): void {
  vi.stubGlobal('fetch', fetcher)
  render(React.createElement(AdminDashboard, {
    session: { user: { id: 'admin-1', name: '平台管理员' }, role: 'admin', mustChangePassword: false },
  }))
}

describe('4-2 命令面板', () => {
  it('Ctrl+K 与头部按钮都可打开；输入关键词按类别呈现结果并披露权限与影响', async () => {
    const fetcher = paletteFetcher()
    renderDashboard(fetcher)
    await screen.findByRole('navigation', { name: '管理后台导航' })

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(await screen.findByRole('dialog', { name: '命令面板' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '关闭命令面板' }))
    expect(screen.queryByRole('dialog', { name: '命令面板' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '打开命令面板' }))
    const dialog = await screen.findByRole('dialog', { name: '命令面板' })
    fireEvent.change(screen.getByRole('textbox', { name: '命令面板搜索' }), { target: { value: 'alpha' } })

    await waitFor(() => {
      expect(dialog.textContent).toContain('协作台前端')
    })
    expect(dialog.textContent).toContain('run-alpha-9')
    expect(dialog.textContent).toContain('req-alpha-1')
    expect(dialog.textContent).toContain('只读导航')
  })

  it('选中运行结果进入云工作空间运行页', async () => {
    const fetcher = paletteFetcher()
    renderDashboard(fetcher)
    await screen.findByRole('navigation', { name: '管理后台导航' })

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    fireEvent.change(await screen.findByRole('textbox', { name: '命令面板搜索' }), { target: { value: 'run-alpha-9' } })
    const row = await screen.findByRole('button', { name: /运行 run-alpha-9/ })
    fireEvent.click(row)
    await waitFor(() => {
      expect(window.location.search).toContain('page=cloud-runs')
    })
  })
})
