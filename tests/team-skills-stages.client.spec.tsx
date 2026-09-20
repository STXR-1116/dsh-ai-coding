// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceListState } from './helpers/client-runtime-types.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-remotes/client'
import { TeamSkillsView } from '../src/client/team-skills/TeamSkillsView.tsx'

/**
 * 契约探针：《DSH-平台模块现状与后端API需求.md》§11.14（2026-09-16 冻结）。
 *
 * 异常矩阵：
 * - 缺失：未执行的阶段必须仍然渲染为「未执行」条目，不得整条省略——省略会让
 *   用户以为该阶段通过。
 * - 类型错误：阶段条目来自 Host，视图不做重排、不做结果改写。
 * - 边界：成功安装的 `rollback` 必须是「未执行」；失败安装的失败阶段必须是「失败」。
 * - 并发：无（单次交互）。
 * - 下游失败：安装请求本身失败（ok=false）时不产生阶段证据，视图不得伪造阶段。
 * - 审计：本探针断言的是呈现；证据内容来自 Host 的 `stages`。
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
        tags: ['质量', '审核'],
        publishedAt: '2026-08-29T08:00:00Z',
      },
    ],
  },
}

const INSTALLATION = {
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
} as const

// 校验阶段失败 → 写入与运行时发现都未执行，且没有可回滚的内容：
// 这才是契约里「失败之后的阶段一律 skipped」的真实形态。
const FAILED_STAGES = [
  { stage: 'authorization', outcome: 'succeeded', detail: '服务端已授权。' },
  { stage: 'precheck', outcome: 'succeeded', detail: '本地作用域与依赖预检已通过。' },
  { stage: 'download', outcome: 'succeeded', detail: '制品已下载。' },
  { stage: 'verify', outcome: 'failed', detail: '制品摘要与声明不一致。' },
  { stage: 'write', outcome: 'skipped', detail: '前序阶段失败，本阶段未执行。' },
  { stage: 'discovery', outcome: 'skipped', detail: '前序阶段失败，本阶段未执行。' },
  { stage: 'rollback', outcome: 'skipped', detail: '本次安装未发生回滚。' },
] as const

const SUCCEEDED_STAGES = [
  { stage: 'authorization', outcome: 'succeeded', detail: '服务端已授权。' },
  { stage: 'precheck', outcome: 'succeeded', detail: '本地作用域与依赖预检已通过。' },
  { stage: 'download', outcome: 'succeeded', detail: '制品已下载。' },
  { stage: 'verify', outcome: 'succeeded', detail: '校验通过。' },
  { stage: 'write', outcome: 'succeeded', detail: '已写入本地作用域。' },
  { stage: 'discovery', outcome: 'succeeded', detail: 'DSH 已确认发现该 Skill。' },
  { stage: 'rollback', outcome: 'skipped', detail: '本次安装未发生回滚。' },
] as const

function remoteFor(install: () => Promise<unknown>): ClientRemote {
  return {
    teamSkills: {
      catalog: async () => ({ ok: true, value: catalog }),
      installations: async () => ({ ok: true, value: [] }),
      syncReleaseStatus: async () => ({ ok: true, value: [] }),
      installSkill: install,
      uninstallSkill: async () => ({ ok: true, value: [] }),
    },
  } as unknown as ClientRemote
}

async function driveInstall(install: () => Promise<unknown>): Promise<void> {
  render(
    <TeamSkillsView
      remote={remoteFor(install)}
      useWorkspaces={withWorkspace}
      environment={environment}
      projectId="project-alpha"
      projects={[]}
    />,
  )
  await waitFor(() => screen.getByRole('heading', { name: '代码评审' }))
  fireEvent.click(screen.getByRole('button', { name: '安装 Skill' }))
  fireEvent.click(screen.getByRole('button', { name: '确认安装到当前项目' }))
}

describe('§11.14 安装阶段证据（视图）', () => {
  it('失败安装渲染全部七个阶段，失败阶段为失败、其后阶段为未执行', async () => {
    await driveInstall(async () => ({
      ok: true,
      value: {
        status: 'failed',
        code: 'ARTIFACT_DIGEST_MISMATCH',
        message: '制品摘要与声明不一致。',
        failedStage: 'verify',
        retryable: { retryable: false, how: '请联系发布者重新发布该版本。' },
        stages: FAILED_STAGES,
      },
    }))

    const region = await screen.findByRole('region', { name: '安装阶段证据' })
    const rows = within(region).getAllByRole('listitem')
    expect(rows).toHaveLength(7)
    expect(rows.map(row => row.getAttribute('data-stage'))).toEqual([
      'authorization',
      'precheck',
      'download',
      'verify',
      'write',
      'discovery',
      'rollback',
    ])
    expect(rows[3]?.getAttribute('data-outcome')).toBe('failed')
    expect(within(region).getByText('失败', { selector: 'span' })).toBeTruthy()
    // 失败阶段之后的阶段必须仍然出现且标为未执行，不得被省略。
    expect(rows.filter(row => row.getAttribute('data-outcome') === 'skipped')).toHaveLength(3)
  })

  it('成功安装的阶段证据里回滚为未执行', async () => {
    await driveInstall(async () => ({
      ok: true,
      value: {
        status: 'succeeded',
        installation: INSTALLATION,
        failedStage: null,
        retryable: { retryable: false, how: '安装已完成，无需重试。' },
        stages: SUCCEEDED_STAGES,
      },
    }))

    const region = await screen.findByRole('region', { name: '安装阶段证据' })
    const rows = within(region).getAllByRole('listitem')
    expect(rows).toHaveLength(7)
    expect(rows[6]?.getAttribute('data-outcome')).toBe('skipped')
    expect(within(region).getByText('本次安装未发生回滚。')).toBeTruthy()
  })

  it('请求本身失败时不产生阶段证据，不得伪造阶段', async () => {
    await driveInstall(async () => ({ ok: false, error: { kind: 'service', code: 'NETWORK_ERROR', message: '网络不可用' } }))

    await waitFor(() => screen.getByText(/安装失败/))
    expect(screen.queryByRole('region', { name: '安装阶段证据' })).toBeNull()
  })

  it('服务端未就绪同样不产生阶段证据', async () => {
    await driveInstall(async () => ({ ok: true, value: { status: 'not-ready', missing: ['apiBaseUrl'] } }))

    await waitFor(() => screen.getByText(/安装失败/))
    expect(screen.queryByRole('region', { name: '安装阶段证据' })).toBeNull()
  })

  it('失败时同时给出阶段、服务端 request id 与可重试动作', async () => {
    await driveInstall(async () => ({
      ok: true,
      value: {
        status: 'failed',
        code: 'UPSTREAM_UNAVAILABLE',
        message: '依赖服务暂不可用。',
        requestId: 'req-42',
        failedStage: 'precheck',
        retryable: { retryable: true, how: '依赖服务暂不可用；稍后重试即可。' },
        stages: FAILED_STAGES,
      },
    }))

    // 三件事缺一不可：停在哪一步、服务端取证入口、能否重试。
    await screen.findByRole('region', { name: '安装阶段证据' })
    expect(screen.getByText(/req-42/)).toBeTruthy()
    expect(screen.getByText(/稍后重试即可/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy()
  })

  it('不可重试的失败不提供重试按钮', async () => {
    await driveInstall(async () => ({
      ok: true,
      value: {
        status: 'failed',
        code: 'ARTIFACT_DIGEST_MISMATCH',
        message: '制品摘要与声明不一致。',
        failedStage: 'verify',
        retryable: { retryable: false, how: '请联系发布者重新发布该版本。' },
        stages: FAILED_STAGES,
      },
    }))

    await screen.findByRole('region', { name: '安装阶段证据' })
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
  })
})
