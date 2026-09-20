// @vitest-environment jsdom
/* oxlint-disable typescript/no-base-to-string -- Fetch spy assertions inspect RequestInfo and BodyInit wire values. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import React from 'react'
import { signOut } from 'next-auth/react'
import { AdminDashboard, AdminLoginPage } from '../src/components/admin-dashboard.tsx'

vi.mock('next-auth/react', () => ({ signIn: vi.fn(), signOut: vi.fn() }))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const skill = {
  skillId: 'skill-1',
  displayName: '代码评审',
  summary: '检查代码风险',
  runtimeName: 'aicp-code-review',
  category: '质量',
  tags: ['审核'],
  currentVersion: '1.0.0',
  status: 'published' as const,
  visibility: 'organization' as const,
  revision: 2,
  authorName: '申屠相镕',
  publishedAt: '2026-08-29T08:00:00Z',
}

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

function configure(fetcher: typeof fetch): void {
  vi.stubEnv('NEXT_PUBLIC_TEAM_SKILL_API_URL', 'http://service.test/v1')
  vi.stubEnv('NEXT_PUBLIC_TEAM_SKILL_ACCESS_TOKEN', 'admin-demo')
  vi.stubGlobal('fetch', fetcher)
}

describe('AdminDashboard', () => {
  it('clears a stale Auth.js session before accepting credentials', async () => {
    render(React.createElement(AdminLoginPage, { clearStaleSession: true }))

    await waitFor(() => {
      expect(signOut).toHaveBeenCalledWith({ redirect: false })
    })
  })

  it('renders Skill pages under a second-level module and reserves future modules', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response([]))
    configure(fetcher)
    render(React.createElement(AdminDashboard))

    const navigation = screen.getByRole('navigation', { name: '管理后台导航' })
    // 未登录壳层只暴露成员可见页面所在的模块（团队 Skill 与运行与审计中的审计日志）。
    expect(navigation.querySelectorAll('.module-link').length).toBe(2)
    expect(screen.getByRole('button', { name: /^团队 Skill/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^项目管理/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^账号与权限/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Skill 目录' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('button', { name: '我的草稿' }).getAttribute('aria-current')).toBeNull()
    expect(await screen.findByLabelText('团队 Skill子导航')).toBeTruthy()
    expect(await screen.findByText('当前没有可见的 Skill 资产')).toBeTruthy()
  })

  it('shows the knowledge-base management page for an authenticated administrator', async () => {
    const fetcher = vi.fn<typeof fetch>(async input =>
      String(input).includes('knowledge-bases')
        ? response({
          items: [
            {
              knowledge_base_id: 'k-1',
              organization_id: 'org-alpha',
              name: '发布流程',
              description: '发布规范',
              type: 'document',
              state: 'active',
              searchable: true,
              updated_at: '2026-09-02T00:00:00Z',
              revision: 1,
            },
          ],
        })
        : response([]),
    )
    configure(fetcher)
    render(
      React.createElement(AdminDashboard, {
        session: { user: { id: 'admin-1', name: '平台管理员' }, role: 'admin', mustChangePassword: false },
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /^知识库/ }))
    expect(await screen.findByRole('heading', { name: '知识库' })).toBeTruthy()
    expect(screen.getByText('发布流程')).toBeTruthy()
  })

  it('manages project memories with server filtering, revision editing, and governance tabs', async () => {
    const memory = {
      memory_id: 'm-1',
      team_id: 'team-alpha',
      project_id: 'project-alpha',
      content: 'Alpha uses strict TypeScript checks.',
      layer: 'L1',
      captured_by_user_id: 'member-1',
      created_at: '2026-09-02T00:00:00Z',
      updated_at: '2026-09-02T00:00:00Z',
      revision: 1,
      status: 'ACTIVE',
      importance: 0.8,
      recall_count: 0,
      last_recalled_at: null,
      source_kind: 'agent_turn',
    }
    const fetcher = vi.fn<typeof fetch>(async (input, _init) => {
      const url = String(input)
      if (url.endsWith('/admin/projects'))
        return response({
          items: [{ project_id: 'project-alpha', organization_id: 'org-alpha', name: '协作台前端', status: 'active', revision: 1 }],
        })
      if (url.endsWith('/project-memory/list')) return response({ data: { items: [memory], next_cursor: null, total_estimate: 1 } })
      if (url.endsWith('/project-memory/get')) return response({ data: memory })
      if (url.endsWith('/project-memory/update'))
        return response({
          data: {
            memory: { ...memory, content: '更新后的项目记忆。', revision: 2 },
            event_id: 'e-1',
            job_id: 'j-1',
            status: 'INDEX_PENDING',
          },
        })
      if (url.endsWith('/project-memory/delete'))
        return response({ data: { event_id: 'e-2', job_id: 'j-2', cleanup_status: 'PENDING' } }, 202)
      if (url.endsWith('/project-memory/policy/get'))
        return response({
          data: {
            scope_type: 'project',
            scope_id: 'project-alpha',
            revision: 1,
            values: { top_k: 8, relevance_threshold: 0.4, token_budget: 1200 },
            inherited_from: 'organization',
          },
        })
      if (url.endsWith('/project-memory/jobs/list')) return response({ data: { items: [] } })
      if (url.endsWith('/project-memory/audit/list')) return response({ data: { items: [] } })
      return response({ items: [] })
    })
    configure(fetcher)
    render(
      React.createElement(AdminDashboard, {
        session: { user: { id: 'admin-1', name: '平台管理员' }, role: 'admin', mustChangePassword: false },
      }),
    )
    fireEvent.click(await screen.findByRole('button', { name: /^记忆库/ }))
    expect(await screen.findByText('Alpha uses strict TypeScript checks.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Alpha uses strict TypeScript checks/ }))
    fireEvent.click(await screen.findByRole('button', { name: '编辑记忆' }))
    fireEvent.change(screen.getByRole('textbox', { name: '记忆正文' }), { target: { value: '更新后的项目记忆。' } })
    fireEvent.click(screen.getByRole('button', { name: '保存记忆' }))
    await waitFor(() => {
      expect(
        fetcher.mock.calls.some(
          ([url, init]) => String(url).endsWith('/project-memory/update') && String(init?.body).includes('更新后的项目记忆'),
        ),
      ).toBe(true)
    })
    fireEvent.click(screen.getByRole('button', { name: '策略' }))
    expect(await screen.findByText('记忆召回策略')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '任务' }))
    expect(await screen.findByText('记忆处理任务')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '审计' }))
    expect(await screen.findByText('记忆治理审计')).toBeTruthy()
  })

  it('shows a forbidden memory response instead of an empty list', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/admin/projects') || url.endsWith('/me/projects'))
        return response({
          items: [{ project_id: 'project-alpha', organization_id: 'org-alpha', name: 'Alpha 项目', status: 'active', revision: 1 }],
        })
      if (url.endsWith('/project-memory/list')) return response({ code: 'PROJECT_ACCESS_DENIED', message: '当前账号无权访问项目' }, 403)
      return response([])
    })
    configure(fetcher)
    render(
      React.createElement(AdminDashboard, {
        session: { user: { id: 'admin-1', name: '管理员' }, role: 'admin', mustChangePassword: false },
      }),
    )
    fireEvent.click(await screen.findByRole('button', { name: /^记忆库/ }))
    expect(await screen.findByText('PROJECT_ACCESS_DENIED：当前账号无权访问项目')).toBeTruthy()
    expect(screen.queryByText('当前项目没有可见记忆')).toBeNull()
  })

  it('shows an unavailable memory response from the service', async () => {
    const fetcher = vi.fn<typeof fetch>(async input =>
      String(input).endsWith('/project-memory/list')
        ? response({ code: 'MEMORY_SERVICE_UNAVAILABLE', message: '记忆服务暂不可用' }, 503)
        : response({
          items: [{ project_id: 'project-alpha', organization_id: 'org-alpha', name: 'Alpha 项目', status: 'active', revision: 1 }],
        }),
    )
    configure(fetcher)
    render(
      React.createElement(AdminDashboard, {
        session: { user: { id: 'admin-1', name: '管理员' }, role: 'admin', mustChangePassword: false },
      }),
    )
    fireEvent.click(await screen.findByRole('button', { name: /^记忆库/ }))
    expect(await screen.findByText('MEMORY_SERVICE_UNAVAILABLE：记忆服务暂不可用')).toBeTruthy()
  })

  it('keeps edited memory content visible after a revision conflict', async () => {
    const memory = {
      memory_id: 'm-1',
      team_id: 'team-alpha',
      project_id: 'project-alpha',
      content: '原始记忆',
      layer: 'L1',
      captured_by_user_id: 'member-1',
      created_at: '2026-09-02T00:00:00Z',
      updated_at: '2026-09-02T00:00:00Z',
      revision: 1,
      status: 'ACTIVE',
      importance: 0.8,
      recall_count: 0,
      last_recalled_at: null,
      source_kind: 'agent_turn',
    }
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/admin/projects') || url.endsWith('/me/projects'))
        return response({
          items: [{ project_id: 'project-alpha', organization_id: 'org-alpha', name: 'Alpha 项目', status: 'active', revision: 1 }],
        })
      if (url.endsWith('/project-memory/list') || url.endsWith('/project-memory/get'))
        return response({ data: url.endsWith('/project-memory/list') ? { items: [memory], next_cursor: null, total_estimate: 1 } : memory })
      if (url.endsWith('/project-memory/update'))
        return response({ code: 'MEMORY_REVISION_CONFLICT', message: '记忆已更新，请刷新后重试' }, 409)
      return response({ items: [] })
    })
    configure(fetcher)
    render(
      React.createElement(AdminDashboard, {
        session: { user: { id: 'admin-1', name: '管理员' }, role: 'admin', mustChangePassword: false },
      }),
    )
    fireEvent.click(await screen.findByRole('button', { name: /^记忆库/ }))
    fireEvent.click(await screen.findByRole('button', { name: /原始记忆/ }))
    fireEvent.click(await screen.findByRole('button', { name: '编辑记忆' }))
    fireEvent.change(screen.getByRole('textbox', { name: '记忆正文' }), { target: { value: '本地未提交修改' } })
    fireEvent.click(screen.getByRole('button', { name: '保存记忆' }))
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: '记忆正文' }).value).toBe('本地未提交修改')
    })
    expect(await screen.findByText('MEMORY_REVISION_CONFLICT：记忆已更新，请刷新后重试')).toBeTruthy()
  })

  it('resolves an authorized project before requesting memory records', async () => {
    const memory = {
      memory_id: 'm-1',
      team_id: 'team-alpha',
      project_id: 'project-alpha',
      content: '成员项目记忆',
      layer: 'L1',
      captured_by_user_id: 'member-1',
      created_at: '2026-09-02T00:00:00Z',
      updated_at: '2026-09-02T00:00:00Z',
      revision: 1,
      status: 'ACTIVE',
      importance: 0.8,
      recall_count: 0,
      last_recalled_at: null,
      source_kind: 'agent_turn',
    }
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/admin/projects'))
        return response({
          items: [{ project_id: 'project-alpha', organization_id: 'org-alpha', name: 'Alpha 项目', status: 'active', revision: 1 }],
        })
      if (url.endsWith('/project-memory/list')) return response({ data: { items: [memory], next_cursor: null, total_estimate: 1 } })
      if (url.endsWith('/project-memory/get')) return response({ data: memory })
      return response([])
    })
    configure(fetcher)
    render(
      React.createElement(AdminDashboard, {
        session: { user: { id: 'admin-1', name: '管理员' }, role: 'admin', mustChangePassword: false },
      }),
    )
    fireEvent.click(await screen.findByRole('button', { name: /^记忆库/ }))
    expect(await screen.findByText('成员项目记忆')).toBeTruthy()
    const listCall = [...fetcher.mock.calls].reverse().find(([input]) => String(input).endsWith('/project-memory/list'))
    expect(JSON.parse(String(listCall?.[1]?.body))).toMatchObject({ project_id: 'project-alpha' })
  })

  it('hides the memory-library navigation from member sessions', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response({ items: [] }))
    configure(fetcher)
    render(
      React.createElement(AdminDashboard, {
        session: { user: { id: 'member-1', name: '成员' }, role: 'member', mustChangePassword: false },
      }),
    )
    expect(screen.queryByRole('button', { name: /记忆库管理/ })).toBeNull()
    expect(fetcher.mock.calls.some(([input]) => String(input).includes('/project-memory/list'))).toBe(false)
  })

  it('expands only the selected primary navigation menu', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response([]))
    configure(fetcher)
    render(
      React.createElement(AdminDashboard, {
        session: { user: { id: 'admin-1', name: '平台管理员' }, role: 'admin', mustChangePassword: false },
      }),
    )

    // 固定导航没有可折叠分组：页面切换直接落在目标模块，页签随当前页高亮。
    const navigation = screen.getByRole('navigation', { name: '管理后台导航' })
    expect(navigation.querySelectorAll('.module-link').length).toBe(10)
    expect(await screen.findByLabelText('团队 Skill子导航')).toBeTruthy()
    expect(screen.queryByLabelText('账号与权限子导航')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /^账号与权限/ }))
    const permissionTabs = await screen.findByLabelText('账号与权限子导航')
    expect(screen.queryByLabelText('团队 Skill子导航')).toBeNull()
    expect(within(permissionTabs).getByRole('button', { name: '用户与成员' }).getAttribute('aria-current')).toBe('page')

    fireEvent.click(within(permissionTabs).getByRole('button', { name: '组织管理' }))
    await waitFor(() => {
      expect(within(permissionTabs).getByRole('button', { name: '组织管理' }).getAttribute('aria-current')).toBe('page')
    })
    expect(within(permissionTabs).getByRole('button', { name: '用户与成员' }).getAttribute('aria-current')).toBeNull()
  })

  it('shows an explicit not-ready state when the service is not configured', async () => {
    const fetcher = vi.fn<typeof fetch>()
    configure(fetcher)
    vi.stubEnv('NEXT_PUBLIC_TEAM_SKILL_API_URL', '')
    vi.stubEnv('NEXT_PUBLIC_TEAM_SKILL_ACCESS_TOKEN', '')
    render(React.createElement(AdminDashboard))
    expect(await screen.findByRole('heading', { name: 'Skill 服务尚未配置' })).toBeTruthy()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('renders the directory empty state from the authoritative response', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response([]))
    configure(fetcher)
    render(React.createElement(AdminDashboard))
    expect(await screen.findByText('当前没有可见的 Skill 资产')).toBeTruthy()
  })

  it('keeps approval disabled until every review check is complete', async () => {
    const review = {
      skill,
      version: {
        skillId: skill.skillId,
        version: '1.1.0',
        status: 'pending_review' as const,
        releaseNotes: '新增检查项',
        dependencies: [],
        permissions: ['read_file'],
        validation: [],
        revision: 1,
      },
      reviewChecks: [
        { id: 'check-1', label: '内容与文件' },
        { id: 'check-2', label: '依赖与权限' },
      ],
    }
    const fetcher = vi.fn<typeof fetch>(async input =>
      String(input).includes('team-skill-reviews') ? response([review]) : response([skill]),
    )
    configure(fetcher)
    render(React.createElement(AdminDashboard))
    fireEvent.click(await screen.findByRole('button', { name: /审核队列/ }))
    const approve = await screen.findByRole('button', { name: /批准版本/ })
    expect(approve).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByLabelText('内容与文件'))
    expect(approve).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByLabelText('依赖与权限'))
    expect(approve).toHaveProperty('disabled', false)
  })

  it('only enables publishing for an approved version', async () => {
    const approved = { ...skill, status: 'approved' as const, currentVersion: '1.0.0' }
    const published = { ...skill, status: 'published' as const }
    const fetcher = vi.fn<typeof fetch>(async () => response([approved, published]))
    configure(fetcher)
    render(React.createElement(AdminDashboard))
    fireEvent.click(await screen.findByRole('button', { name: /发布管理/ }))
    const publishButtons = await screen.findAllByRole('button', { name: /^发布$/ })
    expect(publishButtons[0]).toHaveProperty('disabled', false)
    expect(publishButtons[1]).toHaveProperty('disabled', true)
  })

  it('changes the review details when an administrator selects another pending version', async () => {
    const second = {
      skill: { ...skill, skillId: 'skill-2', displayName: 'API 可靠性检查', currentVersion: undefined, status: 'pending_review' as const },
      version: {
        skillId: 'skill-2',
        version: '0.2.0',
        status: 'pending_review' as const,
        releaseNotes: '覆盖超时与重试',
        dependencies: ['DSH >= 0.1.0'],
        permissions: ['read_file'],
        validation: [],
        revision: 1,
      },
      reviewChecks: [{ id: 'check-1', label: '内容与文件' }],
    }
    const first = {
      skill: { ...skill, displayName: '代码评审', status: 'pending_review' as const },
      version: {
        skillId: skill.skillId,
        version: '1.1.0',
        status: 'pending_review' as const,
        releaseNotes: '覆盖变更边界',
        dependencies: [],
        permissions: [],
        validation: [],
        revision: 1,
      },
      reviewChecks: [{ id: 'check-1', label: '内容与文件' }],
    }
    const fetcher = vi.fn<typeof fetch>(async input =>
      String(input).includes('team-skill-reviews') ? response([first, second]) : response([skill]),
    )
    configure(fetcher)
    render(React.createElement(AdminDashboard))
    fireEvent.click(await screen.findByRole('button', { name: /审核队列/ }))
    expect(await screen.findByRole('heading', { name: '代码评审 v1.1.0' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /API 可靠性检查/ }))
    expect(await screen.findByRole('heading', { name: 'API 可靠性检查 v0.2.0' })).toBeTruthy()
  })

  it('asks for a reason before a published version is withdrawn', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response([skill]))
    configure(fetcher)
    render(React.createElement(AdminDashboard))
    fireEvent.click(await screen.findByRole('button', { name: /发布管理/ }))
    fireEvent.click(await screen.findByRole('button', { name: /下线/ }))
    expect(screen.getByRole('dialog', { name: '下线版本' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '确认下线' })).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByLabelText('下线原因'), { target: { value: '发现权限范围异常' } })
    expect(screen.getByRole('button', { name: '确认下线' })).toHaveProperty('disabled', false)
  })

  it('sends a rejection reason for the selected review item', async () => {
    const review = {
      skill: { ...skill, status: 'pending_review' as const },
      version: {
        skillId: skill.skillId,
        version: '1.1.0',
        status: 'pending_review' as const,
        releaseNotes: '新增检查',
        dependencies: [],
        permissions: [],
        validation: [],
        revision: 1,
      },
      reviewChecks: [{ id: 'check-1', label: '内容与文件' }],
    }
    const fetcher = vi.fn<typeof fetch>(async input =>
      String(input).includes('team-skill-reviews') ? response([review]) : response([skill]),
    )
    configure(fetcher)
    render(React.createElement(AdminDashboard))
    fireEvent.click(await screen.findByRole('button', { name: /审核队列/ }))
    fireEvent.click(await screen.findByRole('button', { name: '驳回版本' }))
    fireEvent.change(screen.getByLabelText('驳回原因'), { target: { value: '权限声明需要收敛' } })
    fireEvent.click(screen.getByRole('button', { name: '确认驳回' }))
    await waitFor(() => {
      expect(fetcher.mock.calls.some(([, init]) => String(init?.body).includes('权限声明需要收敛'))).toBe(true)
    })
  })

  it('lets an author edit a draft, upload its ZIP, and submit it for review', async () => {
    const draft = {
      ...skill,
      status: 'draft' as const,
      currentVersion: undefined,
      latestVersion: '0.1.0',
      latestVersionRevision: 1,
      revision: 3,
      visibility: 'people' as const,
      peopleIds: ['manager-1'],
    }
    const version = {
      skillId: draft.skillId,
      version: '0.1.0',
      status: 'draft' as const,
      releaseNotes: '首个版本',
      artifactSha256: undefined,
      artifactSizeBytes: 0,
      dependencies: ['DSH >= 0.1.0'],
      permissions: ['read_file'],
      validation: [{ name: '制品上传', status: 'failed' as const }],
      revision: 1,
    }
    let currentVersion = version
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      if (url.includes('/directory/users'))
        return response({ items: [{ user_id: 'manager-1', display_name: '组织经理', email: 'manager@example.com', groups: ['platform'] }] })
      if (url.endsWith('/team-skills')) return response([draft])
      if (url.includes('/artifact') && init?.method === 'PUT') {
        currentVersion = {
          ...currentVersion,
          artifactSizeBytes: 100,
          validation: [{ name: 'DSH 单层目录', status: 'passed' as const }],
          revision: currentVersion.revision + 1,
        }
        return response({ skill: draft, version: currentVersion })
      }
      if (url.includes('/team-skills/skill-1') && (init?.method === undefined || init.method === 'GET'))
        return response({ skill: draft, versions: [currentVersion] })
      return response({ skill: draft, version: currentVersion })
    })
    configure(fetcher)
    render(React.createElement(AdminDashboard))
    fireEvent.click(await screen.findByRole('button', { name: /我的草稿/ }))
    fireEvent.click(await screen.findByRole('button', { name: /^代码评审/ }))
    expect(await screen.findByDisplayValue('质量')).toBeTruthy()
    fireEvent.change(screen.getAllByLabelText('分类')[1], { target: { value: '工程效率' } })
    fireEvent.change(screen.getAllByLabelText('标签')[1], { target: { value: '发布,审核' } })
    fireEvent.click(screen.getByRole('button', { name: '保存 Skill 信息' }))
    await waitFor(() => {
      expect(fetcher.mock.calls.some(([, init]) => init?.method === 'PATCH' && String(init.body).includes('工程效率'))).toBe(true)
    })
    fireEvent.change(screen.getByLabelText('版本说明'), { target: { value: '补充发布检查' } })
    fireEvent.change(screen.getByLabelText('依赖'), { target: { value: 'DSH >= 0.1.1\nnode >= 22' } })
    fireEvent.change(screen.getByLabelText('权限'), { target: { value: 'read_file\nwrite_file' } })
    fireEvent.click(screen.getByRole('button', { name: '保存版本信息' }))
    await waitFor(() => {
      expect(fetcher.mock.calls.some(([, init]) => init?.method === 'PATCH' && String(init.body).includes('补充发布检查'))).toBe(true)
    })
    fireEvent.change(screen.getByLabelText('Skill ZIP'), {
      target: { files: [new File(['zip'], 'skill.zip', { type: 'application/zip' })] },
    })
    fireEvent.click(screen.getByRole('button', { name: '上传 ZIP' }))
    await waitFor(() => {
      expect(
        fetcher.mock.calls.some(
          ([, init]) => init?.method === 'PUT' && new Headers(init.headers).get('Content-Type') === 'application/zip',
        ),
      ).toBe(true)
    })
    fireEvent.click(screen.getByRole('button', { name: '提交审核' }))
    await waitFor(() => {
      expect(fetcher.mock.calls.some(([input, init]) => String(input).includes('submit-review') && init?.method === 'POST')).toBe(true)
    })
  })

  it('sends the selected historical release and current Skill revision for rollback', async () => {
    const rollbackSkill = {
      ...skill,
      publishedVersions: ['1.0.0', '0.9.0'],
      currentVersion: '1.0.0',
      status: 'published' as const,
      revision: 8,
    }
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (init?.method === 'POST') return response({ skill: rollbackSkill })
      return response([rollbackSkill])
    })
    configure(fetcher)
    render(React.createElement(AdminDashboard))
    fireEvent.click(await screen.findByRole('button', { name: /发布管理/ }))
    fireEvent.click(await screen.findByRole('button', { name: '回滚' }))
    expect(screen.getByRole('dialog', { name: '回滚版本' })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: '回滚目标版本' })).toHaveProperty('value', '0.9.0')
    fireEvent.click(screen.getByRole('button', { name: '确认回滚' }))
    await waitFor(() => {
      expect(
        fetcher.mock.calls.some(
          ([input, init]) =>
            String(input).includes('/rollback') &&
            init?.method === 'POST' &&
            String(init.body).includes('0.9.0') &&
            new Headers(init.headers).get('If-Match') === '8',
        ),
      ).toBe(true)
    })
  })

  it('hides permission management for a member session and never sends a browser access token', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, _init) => response({ code: 'FORBIDDEN', message: '需要管理员权限' }, 403))
    vi.stubGlobal('fetch', fetcher)
    render(
      React.createElement(AdminDashboard, {
        session: { user: { id: 'member-1', name: '演示成员', email: 'member@example.com' }, role: 'member', mustChangePassword: false },
      }),
    )
    expect(screen.queryByText('权限管理', { exact: true })).toBeNull()
    await screen.findByRole('heading', { name: '服务请求失败' })
    expect(fetcher).toHaveBeenCalled()
    const [, init] = fetcher.mock.calls[0]
    expect(new Headers(init?.headers).get('Authorization')).toBeNull()
  })

  it('clears the Auth.js session when the service rejects the current token', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response({ code: 'AUTH_REQUIRED', message: '需要有效的后台 Session' }, 401))
    vi.stubGlobal('fetch', fetcher)
    render(
      React.createElement(AdminDashboard, {
        session: { user: { id: 'admin-1', name: '平台管理员', email: 'admin@example.com' }, role: 'admin', mustChangePassword: false },
      }),
    )
    await waitFor(() => {
      expect(signOut).toHaveBeenCalledWith({ redirect: true, redirectTo: '/' })
    })
  })

  it('clears the Auth.js session when a mutation reports token expiry', async () => {
    const project = {
      project_id: 'project-alpha',
      organization_id: 'org-alpha',
      organization_name: '星河 AI 平台',
      name: '协作台前端',
      description: '第一方项目',
      status: 'active' as const,
      created_by: 'admin-1',
      created_at: '2026-08-30T00:00:00Z',
      updated_at: '2026-08-30T00:00:00Z',
      member_count: 0,
      asset_count: 0,
      revision: 1,
    }
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.endsWith('/admin/projects/project-alpha') && method === 'PATCH') return response({ code: 'TOKEN_EXPIRED', message: '会话已失效' }, 401)
      if (url.endsWith('/admin/projects/project-alpha')) return response(project)
      if (url.endsWith('/admin/projects')) return response({ items: [project] })
      if (url.includes('/admin/organizations')) return response({ items: [{ organization_id: 'org-alpha', name: '星河 AI 平台', status: 'active', revision: 1 }] })
      if (url.includes('/admin/team-skills')) return response([])
      return response({ items: [] })
    })
    vi.stubGlobal('fetch', fetcher)
    render(
      React.createElement(AdminDashboard, {
        session: { user: { id: 'admin-1', name: '平台管理员', email: 'admin@example.com' }, role: 'admin', mustChangePassword: false },
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /^项目管理/ }))
    fireEvent.click(await screen.findByRole('button', { name: /协作台前端/ }))
    await screen.findByRole('heading', { name: '协作台前端' })
    fireEvent.change(screen.getByLabelText('项目名称详情'), { target: { value: '新名称' } })
    fireEvent.click(screen.getByRole('button', { name: '保存项目' }))
    await waitFor(() => {
      expect(signOut).toHaveBeenCalledWith({ redirect: true, redirectTo: '/' })
    })
  })

  it('shows archived projects in permission management as read-only', async () => {
    const active = { project_id: 'project-alpha', organization_id: 'org-alpha', name: '协作台前端', status: 'active' as const, revision: 1 }
    const archived = { project_id: 'project-archived', organization_id: 'org-alpha', name: '归档项目', status: 'archived' as const, revision: 2 }
    const user = {
      user_id: 'member-1',
      username: 'member@example.com',
      email: 'member@example.com',
      display_name: '演示成员',
      status: 'active' as const,
      global_role: 'member' as const,
      must_change_password: false,
      revision: 1,
      memberships: [{ organization_id: 'org-alpha', organization_name: '星河 AI 平台', status: 'active' as const, revision: 1 }],
    }
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.includes('/admin/projects?status=archived')) return response({ items: [archived] })
      if (url.endsWith('/admin/projects')) return response({ items: [active] })
      if (url.includes('/admin/projects/project-archived/members')) return response({ items: [{ project_id: 'project-archived', organization_id: 'org-alpha', user_id: 'member-1', display_name: '演示成员', status: 'active', revision: 1 }] })
      if (url.includes('/admin/users')) return response({ items: [user] })
      if (url.includes('/admin/organizations')) return response({ items: [{ organization_id: 'org-alpha', name: '星河 AI 平台', status: 'active', revision: 1 }] })
      if (url.includes('/admin/team-skills')) return response([])
      return response({ items: [] })
    })
    vi.stubGlobal('fetch', fetcher)
    render(
      React.createElement(AdminDashboard, {
        session: { user: { id: 'admin-1', name: '平台管理员', email: 'admin@example.com' }, role: 'admin', mustChangePassword: false },
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /^账号与权限/ }))
    fireEvent.click(await screen.findByRole('button', { name: '项目授权' }))
    expect(await screen.findByRole('button', { name: /归档项目/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /归档项目/ }))
    expect(await screen.findByText('归档项目只读，不能调整成员授权。')).toBeTruthy()
    expect(screen.getByRole('button', { name: '授权' }).hasAttribute('disabled')).toBe(true)
    expect(screen.queryByRole('button', { name: '移除' })).toBeNull()
    expect(fetcher.mock.calls.some(([input]) => String(input).includes('/admin/projects?status=archived'))).toBe(true)
  })

  it('fills role and scope labels when the service omits role descriptions', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.includes('/admin/roles')) return response({ items: [{ role: 'admin', scope: 'platform', description: '' }] })
      if (url.includes('/admin/permissions')) return response({ items: [{ key: 'project.manage', admin: true, manager: 'organization', member: false }] })
      if (url.includes('/admin/team-skills')) return response([])
      return response({ items: [] })
    })
    vi.stubGlobal('fetch', fetcher)
    render(
      React.createElement(AdminDashboard, {
        session: { user: { id: 'admin-1', name: '平台管理员', email: 'admin@example.com' }, role: 'admin', mustChangePassword: false },
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /^账号与权限/ }))
    fireEvent.click(await screen.findByRole('button', { name: '角色与权限' }))
    expect(await screen.findByText('平台管理员')).toBeTruthy()
    expect(screen.getAllByText('平台').length).toBeGreaterThan(0)
    expect(screen.getByText('管理平台全部组织、账号和项目')).toBeTruthy()
  })

  it('distinguishes an unavailable service from an authorization failure', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed')
    })
    vi.stubGlobal('fetch', fetcher)
    render(
      React.createElement(AdminDashboard, {
        session: { user: { id: 'admin-1', name: '平台管理员', email: 'admin@example.com' }, role: 'admin', mustChangePassword: false },
      }),
    )
    expect(await screen.findByRole('heading', { name: '服务不可达' })).toBeTruthy()
    expect(screen.getByText('后端服务未启动或当前不可达')).toBeTruthy()
  })

  it('opens an in-app confirmation dialog before project lifecycle changes', async () => {
    const project = {
      project_id: 'project-alpha',
      organization_id: 'org-alpha',
      organization_name: '星河 AI 平台',
      name: '协作台前端',
      description: '第一方项目',
      status: 'draft' as const,
      created_by: 'admin-1',
      created_at: '2026-08-30T00:00:00Z',
      updated_at: '2026-08-30T00:00:00Z',
      member_count: 0,
      asset_count: 0,
      revision: 1,
    }
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/admin/projects')) return response({ items: [project] })
      if (url.endsWith('/admin/projects/project-alpha')) return response(project)
      if (url.includes('/members') || url.includes('/assets') || url.includes('/authorization-audits')) return response({ items: [] })
      if (url.includes('/admin/organizations')) return response({ items: [{ organization_id: 'org-alpha', name: '星河 AI 平台', status: 'active', revision: 1 }] })
      return response([])
    })
    vi.stubGlobal('fetch', fetcher)
    render(
      React.createElement(AdminDashboard, {
        session: { user: { id: 'admin-1', name: '平台管理员', email: 'admin@example.com' }, role: 'admin', mustChangePassword: false },
      }),
    )
    fireEvent.click(await screen.findByRole('button', { name: /^项目管理/ }))
    fireEvent.click(await screen.findByRole('button', { name: /协作台前端/ }))
    await screen.findByRole('heading', { name: '协作台前端' })
    fireEvent.click(screen.getByRole('button', { name: '激活项目' }))
    expect(screen.getByRole('dialog', { name: '确认项目操作' })).toBeTruthy()
    expect(screen.getByText('确认激活该项目？')).toBeTruthy()
    expect(fetcher.mock.calls.some(([input, init]) => String(input).includes(':activate') && init?.method === 'POST')).toBe(false)
  })

  it('opens the account permission pages for an admin session and shows a one-time password', async () => {
    const user = {
      user_id: 'member-1',
      username: 'member@example.com',
      email: 'member@example.com',
      display_name: '演示成员',
      status: 'active' as const,
      global_role: 'member' as const,
      must_change_password: false,
      revision: 1,
      memberships: [{ organization_id: 'org-alpha', organization_name: '星河 AI 平台', status: 'active' as const, revision: 1 }],
    }
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      if (url.includes('/admin/users') && init?.method === 'POST') return response({ user, initial_password: 'one-time-password' }, 201)
      if (url.includes('/admin/users')) return response({ items: [user] })
      if (url.includes('/admin/organizations'))
        return response({ items: [{ organization_id: 'org-alpha', name: '星河 AI 平台', status: 'active', revision: 1 }] })
      if (url.includes('/admin/team-skills')) return response([])
      return response({ items: [] })
    })
    vi.stubGlobal('fetch', fetcher)
    render(
      React.createElement(AdminDashboard, {
        session: { user: { id: 'admin-1', name: '平台管理员', email: 'admin@example.com' }, role: 'admin', mustChangePassword: false },
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /^账号与权限/ }))
    fireEvent.click(await screen.findByRole('button', { name: /用户与成员/ }))
    expect(await screen.findByRole('heading', { name: '用户与成员' })).toBeTruthy()
    expect(await screen.findByText('演示成员')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('新账号用户名'), { target: { value: 'new.member@example.com' } })
    fireEvent.change(screen.getByLabelText('新账号显示名'), { target: { value: '新成员' } })
    fireEvent.click(screen.getByRole('button', { name: '创建账号' }))
    expect(await screen.findByText('one-time-password')).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: '角色与权限' }))
    expect(await screen.findByRole('heading', { name: '角色与权限' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '项目授权' }))
    expect(await screen.findByRole('heading', { name: '项目授权' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^运行与审计/ }))
    fireEvent.click(screen.getByRole('button', { name: /授权审计/ }))
    expect(await screen.findByRole('heading', { name: '授权审计' })).toBeTruthy()
  })

  it('batch-suspends selected users only after an explicit confirmation', async () => {
    const user = {
      user_id: 'user-batch-1',
      username: 'batch@example.com',
      email: 'batch@example.com',
      display_name: '批量成员',
      status: 'active' as const,
      global_role: 'member' as const,
      must_change_password: false,
      revision: 4,
      memberships: [{ organization_id: 'org-alpha', organization_name: '星河 AI 平台', status: 'active', revision: 1 }],
    }
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      if (url.includes('/admin/users/user-batch-1') && init?.method === 'PATCH') return response({ ...user, status: 'suspended', revision: 5 })
      if (url.includes('/admin/users')) return response({ items: [user] })
      // 其余列表端点同样返回 items 包络，避免后台重读失败覆盖批量结果消息。
      return response({ items: [] })
    })
    vi.stubGlobal('fetch', fetcher)
    render(
      React.createElement(AdminDashboard, {
        session: { user: { id: 'admin-1', name: '平台管理员', email: 'admin@example.com' }, role: 'admin', mustChangePassword: false },
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /^账号与权限/ }))
    // 批量栏仅在选中行后出现；未选中时不存在。
    expect(screen.queryByRole('toolbar', { name: '批量操作' })).toBeNull()
    fireEvent.click(await screen.findByRole('checkbox', { name: '选择 批量成员' }))
    const bar = screen.getByRole('toolbar', { name: '批量操作' })
    expect(within(bar).getByText('已选 1 项')).toBeTruthy()
    fireEvent.click(within(bar).getByRole('button', { name: '批量停用' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认批量停用' }))
    await waitFor(() => {
      const call = fetcher.mock.calls.find(([url, init]) => String(url).includes('/admin/users/user-batch-1') && init?.method === 'PATCH')
      expect(call).toBeDefined()
      expect(new Headers(call?.[1]?.headers).get('If-Match')).toBe('4')
      expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ status: 'suspended' })
    })
    expect(await screen.findByText(/批量停用完成：成功 1，失败 0/)).toBeTruthy()
    // 批量完成后清除选择，批量栏消失。
    await waitFor(() => {
      expect(screen.queryByRole('toolbar', { name: '批量操作' })).toBeNull()
    })
  })

  it('sends the removed project-member revision when restoring authorization', async () => {
    const project = {
      project_id: 'project-alpha',
      organization_id: 'org-alpha',
      name: '协作台前端',
      status: 'active' as const,
      revision: 5,
    }
    const removedMember = {
      project_id: 'project-alpha',
      organization_id: 'org-alpha',
      user_id: 'member-1',
      display_name: '演示成员',
      status: 'removed' as const,
      revision: 4,
    }
    const user = {
      user_id: 'member-1',
      username: 'member@example.com',
      email: 'member@example.com',
      display_name: '演示成员',
      status: 'active' as const,
      global_role: 'member' as const,
      must_change_password: false,
      revision: 1,
      memberships: [{ organization_id: 'org-alpha', organization_name: '星河 AI 平台', status: 'active' as const, revision: 1 }],
    }
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      if (url.includes('/admin/projects/project-alpha/members/member-1') && init?.method === 'PUT') return response(project)
      if (url.endsWith('/admin/projects/project-alpha/members')) return response({ items: [removedMember], revision: project.revision })
      if (url.includes('/admin/users')) return response({ items: [user] })
      if (url.includes('/admin/projects')) return response({ items: [project] })
      return response([])
    })
    vi.stubGlobal('fetch', fetcher)
    render(
      React.createElement(AdminDashboard, {
        session: { user: { id: 'admin-1', name: '平台管理员', email: 'admin@example.com' }, role: 'admin', mustChangePassword: false },
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /^账号与权限/ }))
    fireEvent.click(await screen.findByRole('button', { name: '项目授权' }))
    // 详情抽屉改为显式打开：先点项目行，再操作成员授权。
    fireEvent.click(await screen.findByRole('button', { name: /协作台前端/ }))
    const memberSelector = await screen.findByRole('combobox', { name: '选择组织成员' })
    await waitFor(() => {
      expect([...(memberSelector as HTMLSelectElement).options].some(option => option.value === 'member-1')).toBe(true)
    })
    fireEvent.change(memberSelector, { target: { value: 'member-1' } })
    fireEvent.click(screen.getByRole('button', { name: '授权' }))
    await waitFor(() => {
      expect(
        fetcher.mock.calls.some(
          ([input, init]) =>
            String(input).includes('/admin/projects/project-alpha/members/member-1') &&
            init?.method === 'PUT' &&
            new Headers(init.headers).get('If-Match') === '4',
        ),
      ).toBe(true)
    })
  })

  it('opens independent project management and renders lifecycle tabs', async () => {
    const project = {
      project_id: 'project-alpha',
      organization_id: 'org-alpha',
      organization_name: '星河 AI 平台',
      name: '协作台前端',
      description: '第一方项目',
      status: 'draft' as const,
      created_by: 'admin-1',
      created_at: '2026-08-30T00:00:00Z',
      updated_at: '2026-08-30T00:00:00Z',
      member_count: 0,
      asset_count: 0,
      revision: 1,
    }
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/admin/projects') && init?.method === 'POST') return response(project, 201)
      if (url.endsWith('/admin/projects')) return response({ items: [project] })
      if (url.endsWith('/admin/projects/project-alpha')) return response(project)
      if (url.includes('/members')) return response({ items: [] })
      if (url.includes('/assets')) return response({ items: [] })
      if (url.includes('/authorization-audits')) return response({ items: [] })
      if (url.includes('/admin/organizations'))
        return response({ items: [{ organization_id: 'org-alpha', name: '星河 AI 平台', status: 'active', revision: 1 }] })
      if (url.includes('/admin/team-skills')) return response([])
      return response({ items: [] })
    })
    vi.stubGlobal('fetch', fetcher)
    render(
      React.createElement(AdminDashboard, {
        session: { user: { id: 'admin-1', name: '平台管理员', email: 'admin@example.com' }, role: 'admin', mustChangePassword: false },
      }),
    )
    fireEvent.click(await screen.findByRole('button', { name: /^项目管理/ }))
    expect(await screen.findByRole('heading', { name: '项目列表' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: '新项目' } })
    fireEvent.click(screen.getByRole('button', { name: '创建项目' }))
    await waitFor(() => {
      expect(fetcher.mock.calls.some(([input, init]) => String(input).endsWith('/admin/projects') && init?.method === 'POST')).toBe(true)
    })
    fireEvent.click(screen.getByRole('button', { name: /协作台前端/ }))
    expect(await screen.findByRole('heading', { name: '协作台前端' })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: '项目状态筛选' }).value).toBe('')
    expect(screen.getAllByText('草稿').length).toBeGreaterThan(0)
    expect(screen.getByRole('tab', { name: '概览' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '成员' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '资产关联' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '审计' })).toBeTruthy()
  })

  it('keeps project management and detail tab state in stable URLs', async () => {
    window.history.replaceState({}, '', '/')
    const project = {
      project_id: 'project-alpha',
      organization_id: 'org-alpha',
      organization_name: '星河 AI 平台',
      name: '协作台前端',
      description: '第一方项目',
      status: 'active' as const,
      created_by: 'admin-1',
      created_at: '2026-08-30T00:00:00Z',
      updated_at: '2026-08-30T00:00:00Z',
      member_count: 0,
      asset_count: 0,
      revision: 1,
    }
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/admin/projects')) return response({ items: [project] })
      if (url.endsWith('/admin/projects/project-alpha')) return response(project)
      if (url.includes('/members')) return response({ items: [] })
      if (url.includes('/assets')) return response({ items: [] })
      if (url.includes('/authorization-audits')) return response({ items: [] })
      if (url.includes('/admin/organizations'))
        return response({ items: [{ organization_id: 'org-alpha', name: '星河 AI 平台', status: 'active', revision: 1 }] })
      if (url.includes('/admin/team-skills')) return response([])
      return response({ items: [] })
    })
    vi.stubGlobal('fetch', fetcher)
    render(
      React.createElement(AdminDashboard, {
        session: { user: { id: 'admin-1', name: '平台管理员', email: 'admin@example.com' }, role: 'admin', mustChangePassword: false },
      }),
    )
    fireEvent.click(await screen.findByRole('button', { name: /^项目管理/ }))
    fireEvent.click(await screen.findByRole('button', { name: /协作台前端/ }))
    await screen.findByRole('heading', { name: '协作台前端' })
    expect(window.location.pathname).toBe('/projects/project-alpha')
    fireEvent.click(screen.getByRole('tab', { name: '资产关联' }))
    expect(window.location.pathname).toBe('/projects/project-alpha')
    expect(window.location.search).toBe('?tab=assets')
  })

  it('surfaces the server-side project binding state for published skills', async () => {
    const unbound = {
      ...skill,
      skillId: 'skill-unbound',
      displayName: '未绑定技能',
      status: 'published' as const,
      organizationId: 'org-alpha',
      projectIds: [],
    }
    const bound = {
      ...skill,
      skillId: 'skill-bound',
      displayName: '已绑定技能',
      status: 'published' as const,
      organizationId: 'org-alpha',
      projectIds: ['project-alpha'],
    }
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input).includes('/admin/team-skills')) return response([unbound, bound])
      return response([])
    })
    configure(fetcher)
    // Earlier route tests leave a project URL behind; reset it so the skills nav group is expanded.
    window.history.replaceState(null, '', '/')
    render(
      React.createElement(AdminDashboard, {
        session: { user: { id: 'admin-1', name: '平台管理员' }, role: 'admin', mustChangePassword: false },
      }),
    )
    fireEvent.click(await screen.findByRole('button', { name: /Skill 目录/ }))
    expect(await screen.findByText('未绑定技能')).toBeTruthy()

    fireEvent.click(screen.getByText('未绑定技能'))
    expect(
      await screen.findByText('未绑定任何项目：发布后还需在项目资产中绑定，插件目录才会发现该 Skill'),
    ).toBeTruthy()

    fireEvent.click(screen.getByText('已绑定技能'))
    await waitFor(() => {
      const detail = screen.getAllByText('project-alpha')
      expect(detail.length).toBeGreaterThan(0)
    })
  })

  it('manages organization lifecycle and manager binding with revision and idempotency', async () => {
    const organization = { organization_id: 'org-alpha', name: '星河 AI 平台', status: 'active' as const, revision: 3 }
    const manager = {
      user_id: 'manager-2',
      username: 'manager2@example.com',
      email: 'manager2@example.com',
      display_name: '候选经理',
      status: 'active' as const,
      global_role: 'manager' as const,
      must_change_password: false,
      revision: 1,
      memberships: [],
    }
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.endsWith('/admin/organizations') && method === 'POST')
        return response({ organization_id: 'org-new', name: '新组织', status: 'active', revision: 1 }, 201)
      if (url.endsWith('/admin/organizations/org-alpha') && method === 'PATCH')
        return response({ ...organization, name: '改名后的组织', revision: 4 })
      if (url.includes('/admin/organizations/org-alpha/members/manager-2') && method === 'PUT')
        return response({ ...manager, memberships: [{ organization_id: 'org-alpha', organization_name: '星河 AI 平台', status: 'active', revision: 1 }] })
      if (url.includes('/admin/users') && method === 'GET') return response({ items: [manager] })
      if (url.includes('/admin/organizations')) return response({ items: [organization] })
      if (url.includes('/admin/team-skills')) return response([])
      return response({ items: [] })
    })
    configure(fetcher)
    vi.spyOn(window, 'prompt').mockReturnValue('改名后的组织')
    render(
      React.createElement(AdminDashboard, {
        session: { user: { id: 'admin-1', name: '平台管理员' }, role: 'admin', mustChangePassword: false },
      }),
    )
    fireEvent.click(await screen.findByRole('button', { name: /^账号与权限/ }))
    fireEvent.click(await screen.findByRole('button', { name: /组织管理/ }))
    expect(await screen.findByRole('heading', { name: '组织管理' })).toBeTruthy()

    fireEvent.change(screen.getByLabelText('新组织名称'), { target: { value: '新组织' } })
    fireEvent.click(screen.getByRole('button', { name: '创建组织' }))
    await waitFor(() => {
      const call = fetcher.mock.calls.find(([url, init]) => String(url).endsWith('/admin/organizations') && init?.method === 'POST')
      expect(call).toBeDefined()
      expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ name: '新组织' })
      expect(new Headers(call?.[1]?.headers).get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/u)
    })

    fireEvent.click(await screen.findByRole('button', { name: '重命名' }))
    await waitFor(() => {
      const call = fetcher.mock.calls.find(([url, init]) => String(url).endsWith('/admin/organizations/org-alpha') && init?.method === 'PATCH')
      expect(call).toBeDefined()
      expect(new Headers(call?.[1]?.headers).get('If-Match')).toBe('3')
      expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ name: '改名后的组织' })
    })

    fireEvent.change(screen.getByLabelText('为 星河 AI 平台 绑定经理'), { target: { value: 'manager-2' } })
    fireEvent.click(screen.getByRole('button', { name: '绑定经理' }))
    await waitFor(() => {
      const call = fetcher.mock.calls.find(([url, init]) => String(url).includes('/members/manager-2') && init?.method === 'PUT')
      expect(call).toBeDefined()
      expect(new Headers(call?.[1]?.headers).get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/u)
    })
  })

  it('edits a display name and adds an organization membership with revision and idempotency', async () => {
    const user = {
      user_id: 'user-7',
      username: 'user7@example.com',
      email: 'user7@example.com',
      display_name: '待改名成员',
      status: 'active' as const,
      global_role: 'member' as const,
      must_change_password: false,
      revision: 5,
      memberships: [{ organization_id: 'org-alpha', organization_name: '星河 AI 平台', status: 'active' as const, revision: 2 }],
    }
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.endsWith('/admin/users/user-7') && method === 'PATCH') return response({ ...user, display_name: '新显示名', revision: 6 })
      if (url.includes('/admin/organizations/org-beta/members/user-7') && method === 'PUT') return response(user)
      if (url.includes('/admin/users') && method === 'GET') return response({ items: [user] })
      if (url.includes('/admin/organizations'))
        return response({
          items: [
            { organization_id: 'org-alpha', name: '星河 AI 平台', status: 'active', revision: 1 },
            { organization_id: 'org-beta', name: '星河数据平台', status: 'active', revision: 1 },
          ],
        })
      if (url.includes('/admin/team-skills')) return response([])
      return response({ items: [] })
    })
    configure(fetcher)
    vi.spyOn(window, 'prompt').mockReturnValue('新显示名')
    render(
      React.createElement(AdminDashboard, {
        session: { user: { id: 'admin-1', name: '平台管理员' }, role: 'admin', mustChangePassword: false },
      }),
    )
    fireEvent.click(await screen.findByRole('button', { name: /^账号与权限/ }))
    fireEvent.click(await screen.findByRole('button', { name: /用户与成员/ }))
    expect(await screen.findByText('待改名成员')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '编辑显示名' }))
    await waitFor(() => {
      const call = fetcher.mock.calls.find(([url, init]) => String(url).endsWith('/admin/users/user-7') && init?.method === 'PATCH')
      expect(call).toBeDefined()
      expect(new Headers(call?.[1]?.headers).get('If-Match')).toBe('5')
      expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ display_name: '新显示名' })
    })

    fireEvent.change(screen.getByLabelText('为 待改名成员 新增组织'), { target: { value: 'org-beta' } })
    fireEvent.click(screen.getByRole('button', { name: '新增组织成员' }))
    await waitFor(() => {
      const call = fetcher.mock.calls.find(([url, init]) => String(url).includes('/members/user-7') && init?.method === 'PUT')
      expect(call).toBeDefined()
      expect(new Headers(call?.[1]?.headers).get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/u)
    })
  })
})


describe('UX-09 后台信息架构', () => {
  const adminResponse = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify({ code: 0, message: 'ok', request_id: 'ux9', data: value }), {
      status,
      headers: { 'content-type': 'application/json' },
    })

  function stubFetch(): void {
    vi.stubEnv('NEXT_PUBLIC_TEAM_SKILL_API_URL', 'http://service.test/v1')
    vi.stubEnv('NEXT_PUBLIC_TEAM_SKILL_ACCESS_TOKEN', 'admin-demo')
    vi.stubGlobal('fetch', vi.fn(async () => adminResponse([])))
  }

  it('renders exactly the ten fixed modules and keeps the current page tab visible', async () => {
    stubFetch()
    const { AdminDashboard } = await import('../src/components/admin-dashboard.tsx')
    render(React.createElement(AdminDashboard, { session: { user: { id: 'admin-1' }, role: 'admin', mustChangePassword: false } }))
    const nav = screen.getByRole('navigation', { name: '管理后台导航' })
    for (const label of ['工作台', '账号与权限', '项目管理', 'Agent 配置', '团队 Skill', '知识库', '记忆库', '云工作空间运维', '运行与审计', '系统设置']) {
      expect(within(nav).getByRole('button', { name: new RegExp(`^${label}`) })).toBeTruthy()
    }
    expect(within(nav).queryByRole('button', { name: /^资产治理/ })).toBeNull()
    expect(within(nav).queryByRole('button', { name: /^访问控制/ })).toBeNull()
    fireEvent.click(within(nav).getByRole('button', { name: /^运行与审计/ }))
    expect(await screen.findByLabelText('运行与审计子导航')).toBeTruthy()
  })

  it('toggles the mobile navigation drawer', async () => {
    stubFetch()
    const { AdminDashboard } = await import('../src/components/admin-dashboard.tsx')
    render(React.createElement(AdminDashboard, { session: { user: { id: 'admin-1' }, role: 'admin', mustChangePassword: false } }))
    const toggle = await screen.findByRole('button', { name: '切换导航' })
    const shell = toggle.closest('.admin-shell') as HTMLElement
    expect(shell.classList.contains('nav-open')).toBe(false)
    fireEvent.click(toggle)
    expect(shell.classList.contains('nav-open')).toBe(true)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(shell.classList.contains('nav-open')).toBe(false)
  })
})


describe('UX-10/11/12 后台治理、生命周期与状态标注', () => {
  const adminSession = { user: { id: 'admin-1', name: '平台管理员' }, role: 'admin' as const, mustChangePassword: false }

  function jsonResponse(value: unknown, status = 200): Response {
    return new Response(JSON.stringify({ code: 0, message: 'ok', request_id: 'ux10', data: value }), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }

  const user = {
    user_id: 'member-1',
    username: 'member@example.com',
    email: 'member@example.com',
    display_name: '演示成员',
    status: 'active' as const,
    global_role: 'member' as const,
    must_change_password: false,
    revision: 1,
    memberships: [
      { organization_id: 'org-a', organization_name: '组织甲', status: 'active' as const, revision: 1 },
      { organization_id: 'org-b', organization_name: '组织乙', status: 'active' as const, revision: 1 },
    ],
  }

  it('explains organization scope impact and requires 确认停用 when suspending a user', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.includes('/admin/organizations'))
        return jsonResponse({ items: [{ organization_id: 'org-a', name: '组织甲', status: 'active', revision: 1 }] })
      return jsonResponse({ items: [user] })
    })
    vi.stubGlobal('fetch', fetcher)
    render(React.createElement(AdminDashboard, { session: adminSession }))
    fireEvent.click(screen.getByRole('button', { name: /^账号与权限/ }))
    fireEvent.click(await screen.findByRole('button', { name: /用户与成员/ }))
    fireEvent.click(await screen.findByRole('button', { name: '停用' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/2 个组织的成员/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '确认停用' }))
    await waitFor(() => {
      expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('/admin/users'), expect.objectContaining({ method: 'PATCH' }))
    })
  })

  it('hides the one-time password after 复制并隐藏', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      if (url.includes('/admin/users') && init?.method === 'POST') return jsonResponse({ user, initial_password: 'one-time-password' }, 201)
      if (url.includes('/admin/users')) return jsonResponse({ items: [user] })
      if (url.includes('/admin/organizations'))
        return jsonResponse({ items: [{ organization_id: 'org-a', name: '组织甲', status: 'active', revision: 1 }] })
      return jsonResponse({ items: [] })
    })
    vi.stubGlobal('fetch', fetcher)
    render(React.createElement(AdminDashboard, { session: adminSession }))
    fireEvent.click(screen.getByRole('button', { name: /^账号与权限/ }))
    fireEvent.click(await screen.findByRole('button', { name: /用户与成员/ }))
    fireEvent.change(await screen.findByLabelText('新账号用户名'), { target: { value: 'new.member@example.com' } })
    fireEvent.change(screen.getByLabelText('新账号显示名'), { target: { value: '新成员' } })
    fireEvent.click(screen.getByRole('button', { name: '创建账号' }))
    expect(await screen.findByText('one-time-password')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '复制并隐藏' }))
    expect(screen.queryByText('one-time-password')).toBeNull()
  })

  it('shows the skill lifecycle stepper with the blocking step in the directory detail', async () => {
    const skill = {
      skillId: 'skill-review',
      runtimeName: 'code-review',
      displayName: '代码评审',
      summary: '评审 Skill',
      category: '质量',
      tags: ['质量'],
      visibility: 'organization' as const,
      status: 'pending_review' as const,
      revision: 3,
    }
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse([skill]))
    vi.stubGlobal('fetch', fetcher)
    render(React.createElement(AdminDashboard, { session: adminSession }))
    fireEvent.click(screen.getByRole('button', { name: /^团队 Skill/ }))
    expect(await screen.findByText('代码评审')).toBeTruthy()
    fireEvent.click(screen.getByText('代码评审'))
    const steps = await screen.findByRole('list', { name: 'Skill 生命周期' })
    const current = within(steps).getAllByRole('listitem').find(item => item.getAttribute('aria-current') === 'step')
    expect(current?.textContent).toContain('审核')
    expect(within(steps).getByText(/阻塞/)).toBeTruthy()
  })
})


describe('UX-11 二次核对：已下线阻塞文案', () => {
  it('labels a withdrawn skill lifecycle with the withdrawn blocker', async () => {
    const skill = {
      skillId: 'skill-old',
      runtimeName: 'legacy-shell',
      displayName: '已下线技能',
      summary: '已下线的 Skill',
      category: '历史',
      tags: [],
      visibility: 'organization' as const,
      status: 'withdrawn' as const,
      revision: 9,
    }
    vi.stubEnv('NEXT_PUBLIC_TEAM_SKILL_API_URL', 'http://service.test/v1')
    vi.stubEnv('NEXT_PUBLIC_TEAM_SKILL_ACCESS_TOKEN', 'admin-demo')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 0, message: 'ok', request_id: 'ux11b', data: [skill] }), { status: 200, headers: { 'content-type': 'application/json' } })))
    render(React.createElement(AdminDashboard, { session: { user: { id: 'admin-1' }, role: 'admin', mustChangePassword: false } }))
    fireEvent.click(screen.getByRole('button', { name: /^团队 Skill/ }))
    expect(await screen.findByText('已下线技能')).toBeTruthy()
    fireEvent.click(screen.getByText('已下线技能'))
    const steps = await screen.findByRole('list', { name: 'Skill 生命周期' })
    expect(within(steps).getByText(/已下线/)).toBeTruthy()
  })
})
