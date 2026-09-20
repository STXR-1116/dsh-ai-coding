// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceListState } from './helpers/client-runtime-types.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-remotes/client'
import { TeamSkillsView } from '../src/client/team-skills/TeamSkillsView.tsx'

/**
 * 契约探针：《DSH-平台模块现状与后端API需求.md》§11.14（2026-09-16 冻结）。
 *
 * 异常矩阵：
 * - 缺失：未签名版本必须报错，绝不能渲染出一个没有签名的「信任卡」。
 * - 类型错误：信任卡的闭集字段已由平台严格解析拒绝，视图只负责呈现，不改写。
 * - 边界：信任卡按需拉取，关闭详情后不得残留上一个 Skill 的卡片。
 * - 并发：无（单次交互）。
 * - 下游失败：读取失败（403/404）显示错误并保留详情，不伪造分区。
 * - 审计：信任卡的最近审计行必须带操作者与 request_id。
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

const catalog = {
  status: 'ready' as const,
  catalog: {
    items: [
      {
        skillId: 'skill-review',
        displayName: '代码评审',
        runtimeName: 'code-review',
        summary: '按团队规范检查风险、测试和变更边界。',
        version: '2.4.0',
        category: '质量',
        tags: ['质量'],
        publishedAt: '2026-08-29T08:00:00Z',
      },
    ],
  },
}

const TRUST_CARD = {
  skillId: 'skill-review',
  version: '2.4.0',
  displayName: '代码评审',
  publisher: { name: '平台团队', organizationId: 'org-alpha' },
  signature: {
    algorithm: 'sha256-ecdsa',
    keyId: 'fixture-release-key',
    fingerprint: 'f'.repeat(64),
    signedAt: '2026-09-16T00:00:00.000Z',
  },
  toolPermissions: ['read_file'],
  fileScope: { roots: ['.'], maxFiles: 64, maxBytes: 8388608 },
  externalAccess: { network: false, hosts: [] },
  recentAudits: [
    {
      at: '2026-09-16T00:00:00.000Z',
      action: '发布版本',
      outcome: 'succeeded',
      actorName: '管理员',
      requestId: 'r-1',
    },
  ],
}

function remoteFor(trustCard: (request: unknown) => Promise<unknown>): ClientRemote {
  return {
    teamSkills: {
      catalog: async () => ({ ok: true, value: catalog }),
      installations: async () => ({ ok: true, value: [] }),
      syncReleaseStatus: async () => ({ ok: true, value: [] }),
      installSkill: async () => ({ ok: true, value: [] }),
      uninstallSkill: async () => ({ ok: true, value: [] }),
      trustCard,
    },
  } as unknown as ClientRemote
}

async function openDetail(trustCard: (request: unknown) => Promise<unknown>): Promise<void> {
  render(
    <TeamSkillsView
      remote={remoteFor(trustCard)}
      useWorkspaces={withWorkspace}
      environment={environment}
      projectId="project-alpha"
      projects={[]}
    />,
  )
  await waitFor(() => screen.getByRole('heading', { name: '代码评审' }))
  fireEvent.click(screen.getByRole('button', { name: '查看代码评审' }))
}

describe('§11.14 信任卡（视图）', () => {
  it('按需拉取信任卡，带上 Skill、版本与项目上下文，并渲染四个分区', async () => {
    const trustCardCall = vi.fn(async () => ({ ok: true, value: TRUST_CARD }))
    await openDetail(trustCardCall)

    // 详情打开时不得预先拉取：信任卡是按需读取的。
    expect(trustCardCall).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '查看信任卡' }))

    const region = await screen.findByRole('region', { name: 'Skill 信任卡' })
    expect(trustCardCall).toHaveBeenCalledWith({
      skillId: 'skill-review',
      version: '2.4.0',
      projectId: 'project-alpha',
    })
    expect([...region.querySelectorAll('[data-section]')].map(node => node.getAttribute('data-section'))).toEqual([
      'publisher',
      'signature',
      'scope',
      'audits',
    ])
    expect(within(region).getByText('平台团队')).toBeTruthy()
    expect(within(region).getByText('fixture-release-key')).toBeTruthy()
    expect(within(region).getByText('读取文件')).toBeTruthy()
    expect(within(region).getByText('不访问外部网络')).toBeTruthy()
    expect(within(region).getByText(/管理员/).textContent).toContain('r-1')
  })

  it('读取失败时显示错误并保留详情，不渲染任何分区', async () => {
    await openDetail(async () => ({
      ok: true,
      value: { status: 'failed', code: 'NOT_FOUND', message: '资源不存在' },
    }))

    fireEvent.click(screen.getByRole('button', { name: '查看信任卡' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('资源不存在')
    expect(screen.queryByText('平台团队')).toBeNull()
  })

  it('未签名版本报错，绝不渲染无签名的信任卡', async () => {
    await openDetail(async () => ({
      ok: true,
      value: { status: 'failed', code: 'SIGNATURE_NOT_AVAILABLE', message: '该发布版本未签名，无法提供信任卡' },
    }))

    fireEvent.click(screen.getByRole('button', { name: '查看信任卡' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('未签名')
    expect(screen.queryByText('fixture-release-key')).toBeNull()
  })

  it('登录态失效提示重新登录', async () => {
    await openDetail(async () => ({ ok: true, value: { status: 'signed-out' } }))

    fireEvent.click(screen.getByRole('button', { name: '查看信任卡' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('登录状态已失效')
  })
})
