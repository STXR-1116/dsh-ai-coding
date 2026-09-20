// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceListState } from './helpers/client-runtime-types.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-remotes/client'
import { TeamSkillsView } from '../src/client/team-skills/TeamSkillsView.tsx'

/**
 * 契约探针：《DSH-平台模块现状与后端API需求.md》§11.14（2026-09-16 冻结）。
 *
 * 异常矩阵：
 * - 缺失：目录里没有的已安装副本（撤回后服务端不再报告）必须仍然出现在列表中，
 *   并显示为「已撤销」——不得消失、也不得停在「已隔离」。
 * - 类型错误：本地版本与目录版本不一致时必须显示「需要更新」，不得两者都显示
 *   「已安装」。
 * - 边界：目录条目但未安装 → 「已发布」；目录版本未知 → 不谎报「需要更新」。
 * - 并发：无（单次渲染）。
 * - 下游失败：本探针不覆盖失败态（见 stages 规格）。
 * - 审计：无。
 */

afterEach(() => {
  cleanup()
})

const environment = {
  dshVersion: '0.1.1-rc.2',
  availableTools: ['read_file'],
  availableMcpServers: [],
  presentEnvironmentVariableNames: [],
} as const

function workspaceState(items: WorkspaceListState['items']): WorkspaceListState {
  return {
    items,
    archivedSessionIds: [],
    state: 'idle',
    phase: 'ready',
    error: null,
    baselinesReady: true,
    recentWorkspaceId: items[0]?.workspaceId,
  }
}

const withWorkspace = <S,>(selector: (state: WorkspaceListState) => S): S =>
  selector(
    workspaceState([
      {
        workspaceId: 'ws-1' as WorkspaceId,
        title: 'AI开放平台',
        path: 'hidden',
        sessionIds: [],
        createdAt: '2026-08-29T08:00:00Z',
        updatedAt: '2026-08-29T08:00:00Z',
      },
    ]),
  )

function catalogWith(version: string, skillId = 'skill-review'): unknown {
  return {
    status: 'ready',
    catalog: {
      items: [
        {
          skillId,
          displayName: '代码评审',
          runtimeName: 'code-review',
          summary: '按团队规范检查风险、测试和变更边界。',
          version,
          category: '质量',
          tags: ['质量'],
          publishedAt: '2026-08-29T08:00:00Z',
        },
      ],
    },
  }
}

function installation(overrides: Record<string, unknown> = {}): unknown {
  return {
    localInstallationId: 'local-1',
    skillId: 'skill-review',
    projectId: 'project-alpha',
    scope: 'project',
    workspaceId: 'ws-1',
    runtimeName: 'code-review',
    version: '2.4.0',
    artifactSha256: 'abc',
    state: 'normal',
    installedAt: '2026-08-29T08:10:00Z',
    ...overrides,
  }
}

function remoteFor(catalog: unknown, installations: unknown): ClientRemote {
  return {
    teamSkills: {
      catalog: async () => ({ ok: true, value: catalog }),
      installations: async () => ({ ok: true, value: installations }),
      syncReleaseStatus: async () => ({ ok: true, value: installations }),
      installSkill: async () => ({ ok: true, value: [] }),
      uninstallSkill: async () => ({ ok: true, value: [] }),
    },
  } as unknown as ClientRemote
}

async function renderWith(catalog: unknown, installations: unknown): Promise<void> {
  render(
    <TeamSkillsView
      remote={remoteFor(catalog, installations)}
      useWorkspaces={withWorkspace}
      environment={environment}
      projectId="project-alpha"
      projects={[]}
    />,
  )
  await waitFor(() => screen.getByRole('heading', { name: '代码评审' }))
}

function stateChip(): HTMLElement {
  const chip = document.querySelector('[data-installed-state]')
  if (chip === null) throw new Error('installed-state chip not rendered')
  return chip as HTMLElement
}

describe('§11.14 已安装状态（视图）', () => {
  it('本地版本落后于目录时显示需要更新', async () => {
    await renderWith(catalogWith('2.5.0'), [installation({ version: '2.4.0' })])

    expect(stateChip().getAttribute('data-installed-state')).toBe('需要更新')
    expect(screen.getByText('需要更新')).toBeTruthy()
    expect(screen.getByText(/本地 v2\.4\.0，需要更新/)).toBeTruthy()
  })

  it('版本一致时显示已安装', async () => {
    await renderWith(catalogWith('2.4.0'), [installation({ version: '2.4.0' })])

    expect(stateChip().getAttribute('data-installed-state')).toBe('已安装')
  })

  it('服务端已不报告的副本仍出现，并显示为已撤销', async () => {
    // 服务端已不再列出该 Skill（撤回/下线）：副本仍在磁盘上，必须仍然可见。
    await renderWith(catalogWith('2.4.0', 'skill-other'), [installation({ state: 'withdrawn' })])

    // 目录条目排在前面，因此按全部条目断言：撤回的副本必须自己带一个「已撤销」。
    await waitFor(() => {
      const states = [...document.querySelectorAll('[data-installed-state]')].map(node =>
        node.getAttribute('data-installed-state'),
      )
      expect(states).toContain('已撤销')
    })
    expect(screen.getByText('已撤销')).toBeTruthy()
  })

  it('目录条目但未安装时显示已发布', async () => {
    await renderWith(catalogWith('2.4.0'), [])

    expect(stateChip().getAttribute('data-installed-state')).toBe('已发布')
  })
})
