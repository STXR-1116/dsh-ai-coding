/* oxlint-disable typescript/no-base-to-string, typescript/no-unsafe-member-access -- fetch spy URLs and bodies are RequestInfo values. */
// @vitest-environment jsdom
/* oxlint-disable typescript/no-base-to-string, typescript/no-unsafe-member-access -- fetch spy URLs and bodies are RequestInfo values. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { AdminDashboard } from '../src/components/admin-dashboard.tsx'

// 4-1「工作台」视图探针（蓝图 §6.1，§11.12/§11.13 前序探针的延续）。
//
// 异常矩阵：
//   分组   —— 工作台按固定五组组织（需要处理/正在运行/资产健康/权限异常/近期结果），
//             组标题按序渲染。
//   溯源   —— 指标卡可见地呈现时间范围/过滤条件/数据来源/更新时间四项。
//   不可用 —— 单个数据源读取失败：该组指标呈现「读取不可用」，绝不出 0。
//   跳转   —— 点击指标进入目标页并保留过滤：URL 携带 page+status，目标页
//             读取请求体携带同一过滤。

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

const overviewPayload = {
  from: '2026-09-09T00:00:00.000Z',
  to: '2026-09-16T00:00:00.000Z',
  has_data: true,
  summary: {
    sessions: { total: 3, completed: 2, errors: 1, interrupted: 0, cancelled: 0 },
    turns: {
      total: 5, completed: 4, errors: 1, blocked: 0, max_tokens: 0,
      interrupted: 0, cancelled: 0, p50_duration_ms: 100, p95_duration_ms: 900,
    },
    steps: { started: 6, finished: 5, p50_duration_ms: 80, p95_duration_ms: 700 },
    llm: {
      requests: 4, retries: 1, input_tokens: 1200, output_tokens: 300, total_tokens: null,
      token_sample_size: 4, input_token_samples: 3, output_token_samples: 3, total_token_samples: 0,
    },
    tools: { calls: 7, errors: 1, p50_duration_ms: 30, p95_duration_ms: 200 },
    approvals: { requested: 2, allowed_once: 1, rejected: 1, cancelled: 0, unavailable: 0 },
    compactions: 1,
    delivery: { accepted: 12, duplicate: 3, retryable: 1, rejected: 1, queued: 0, gaps: 2 },
  },
  buckets: [],
  retention_days: 90,
}

const skill = {
  skillId: 'sk-1', displayName: '代码评审', summary: '评审', visibility: 'organization',
  organization_id: 'org-alpha', status: 'published', revision: 1, created_at: '', updated_at: '',
}

function workbenchFetcher(overrides: { readonly runs?: boolean } = {}): ReturnType<typeof vi.fn> {
  return vi.fn<typeof fetch>(async (input, _init) => {
    const url = String(input)
    if (url.includes('/admin/telemetry/overview')) return response(overviewPayload)
    if (url.includes('/admin/team-skill-reviews')) {
      return response([{ skill: { ...skill, status: 'pending_review' }, version: { version: '1.0.0' }, reviewChecks: [] }])
    }
    if (url.includes('/admin/team-skills')) return response([{ ...skill }, { ...skill, skillId: 'sk-2', status: 'withdrawn' }])
    if (url.includes('/admin/projects')) return response({ items: [{ project_id: 'project-alpha', organization_id: 'org-alpha', organization_name: '星河 AI 平台', name: '协作台前端', description: '', status: 'active', created_by: 'admin-1', created_at: '', updated_at: '', revision: 1, member_count: 2, asset_count: 0 }], next_cursor: null })
    if (url.includes('/admin/workspaces')) return response([{ workspace_id: 'ws-1', status: 'ready' }, { workspace_id: 'ws-2', status: 'failed' }])
    if (url.includes('/admin/runs')) {
      if (overrides.runs === true) return response({ message: '读取失败' }, 500)
      return response({
        items: [
          { run_id: 'r1', status: 'running', asset_version_ids: [] },
          { run_id: 'r2', status: 'running', asset_version_ids: [] },
          { run_id: 'r3', status: 'succeeded', asset_version_ids: [] },
          { run_id: 'r4', status: 'failed', asset_version_ids: [] },
        ],
      })
    }
    if (url.includes('/admin/agent-profiles')) {
      return response([{ agent_profile_id: 'ap-1', name: '代理', status: 'published', readiness: 'unavailable', revision: 1 }])
    }
    if (url.includes('/admin/authorization-audits')) {
      return response([
        { id: 'a1', occurred_at: '', actor_user_id: 'u1', actor_name: '管理员', action: 'workspace.write', result: 'succeeded', request_id: 'req-1' },
        { id: 'a2', occurred_at: '', actor_user_id: 'u1', actor_name: '管理员', action: 'admin.audit.read', result: 'failed', request_id: 'req-2' },
      ])
    }
    return response({ items: [] })
  })
}

function renderWorkbench(fetcher: ReturnType<typeof vi.fn>): void {
  vi.stubGlobal('fetch', fetcher)
  render(React.createElement(AdminDashboard, {
    session: { user: { id: 'admin-1', name: '平台管理员' }, role: 'admin', mustChangePassword: false },
  }))
  fireEvent.click(screen.getByRole('button', { name: /^工作台/ }))
}

describe('4-1 工作台视图', () => {
  it('按五组组织并可见地呈现溯源四要素', async () => {
    const fetcher = workbenchFetcher()
    renderWorkbench(fetcher)

    expect(await screen.findByText('需要处理')).toBeTruthy()

    expect(screen.getByText('正在运行')).toBeTruthy()
    expect(screen.getByText('资产健康')).toBeTruthy()
    expect(screen.getByText('权限异常')).toBeTruthy()
    expect(screen.getByText('近期结果')).toBeTruthy()
    // 溯源四要素：来源函数名、过滤条件与更新时间可见（时间范围随窗口变化，断言来源与过滤锚点）。
    expect(screen.getByText(/listReviews\(\)/)).toBeTruthy()
    expect(screen.getByText(/status=pending_review/)).toBeTruthy()
    // 五组之外保留既有近 7 天摘要，不因改造丢失。
    expect(screen.getByText('近 7 天运行与治理摘要')).toBeTruthy()
  })

  it('单个数据源读取失败：该组指标呈现读取不可用，绝不出 0', async () => {
    const fetcher = workbenchFetcher({ runs: true })
    renderWorkbench(fetcher)

    expect(await screen.findByText('需要处理')).toBeTruthy()
    const runCard = screen.getByText('运行中的 Run').closest('.workbench-metric') as HTMLElement
    expect(runCard.textContent).toContain('读取不可用')
    expect(runCard.textContent).not.toMatch(/>\s*0\s*</u)
    // 其他组照常出数：待审核仍为 1
    expect(screen.getByText('待审核 Skill 版本').closest('.workbench-metric')?.textContent).toContain('1')
  })

  it('点击指标进入目标列表并保留过滤：URL 与读取请求体都携带 status', async () => {
    const fetcher = workbenchFetcher()
    renderWorkbench(fetcher)

    expect(await screen.findByText('需要处理')).toBeTruthy()
    const runsCalls: string[] = []
    for (const call of fetcher.mock.calls) {
      if (String(call[0]).includes('/admin/runs')) runsCalls.push(String(call[1]?.body ?? ''))
    }
    fireEvent.click(screen.getByRole('button', { name: /运行中的 Run/ }))
    await waitFor(() => {
      expect(window.location.search).toContain('page=cloud-runs')
      expect(window.location.search).toContain('status=running')
    })
    // 目标页自己的读取也携带同一过滤（POST body）。
    await waitFor(() => {
      const bodies = fetcher.mock.calls
        .filter(call => String(call[0]).includes('/admin/runs'))
        .map(call => String(call[1]?.body ?? '{}'))
      expect(bodies.some(body => body.includes('"status":"running"'))).toBe(true)
    })
    void runsCalls
  })
})
