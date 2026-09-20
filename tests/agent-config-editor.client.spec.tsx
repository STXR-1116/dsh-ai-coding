// @vitest-environment jsdom
/* 覆盖补齐：`AgentConfigEditor` 此前**从未被任何用例挂载**（该文件 0%）。
 *
 * `AgentConfigView` 会在 `detail.status === 'ready'` 且点了「编辑配置」时渲染它，
 * 而既有用例只走到只读详情为止——于是整套编辑态（读上下文 → 规划 → 草稿 → 保存/
 * 试运行/发布）连同它的失败分支都没有防线。本文件用 stub remote 直接挂编辑器。
 *
 * 分类：FIXTURE-ONLY。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AgentConfigEditor } from '../src/client/agent-config/AgentConfigEditor'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const ready = <T,>(value: T): { status: 'ready'; value: T; fixtureOnly: boolean } => ({ status: 'ready', value, fixtureOnly: false })

const editContext = (status: 'draft' | 'published' | 'archived') => ready({
  profileId: 'ap-code-default',
  revision: 7,
  name: '默认研发代理',
  versions: [{ agentProfileVersionId: 'apv-draft-1', version: 'v2', status }],
})

const dryRunResult = {
  dryRunId: 'dr-1',
  agentProfileVersionId: 'apv-draft-1',
  outcome: 'ready' as const,
  checks: [{ check: 'policy', result: 'pass' as const, detail: '策略允许写入' }],
  createdAt: '2026-09-17T00:00:00Z',
}

type Fns = Record<string, ReturnType<typeof vi.fn>>

function fakeRemote(overrides: Fns = {}): { readonly remote: ClientRemote; readonly fns: Fns } {
  const fns: Fns = {
    profileEditContext: vi.fn(async () => editContext('draft')),
    assetCandidates: vi.fn(async () => ready([])),
    updateProfileDraft: vi.fn(async () => ready({})),
    dryRunProfile: vi.fn(async () => ready(dryRunResult)),
    publishProfileVersion: vi.fn(async () => ready({})),
    createProfileVersion: vi.fn(async () => editContext('draft')),
    ...overrides,
  }
  const remote = {
    cloudWorkspaces: Object.fromEntries(Object.entries(fns).map(([name, fn]) => [
      name,
      async (...args: unknown[]) => ({
        ok: true as const,
        value: await (fn as (...forwarded: unknown[]) => Promise<unknown>)(...args),
      }),
    ])),
  } as unknown as ClientRemote
  return { remote, fns }
}

describe('AgentConfigEditor', () => {
  it('loads the edit context and offers the three draft actions', async () => {
    const { remote } = fakeRemote()
    render(<AgentConfigEditor remote={remote} profileId="ap-code-default" />)

    const editor = await screen.findByRole('region', { name: '配置编辑器' })
    await waitFor(() => { expect(editor.textContent).toContain('草稿版本：apv-draft-1') })
    expect(screen.getByLabelText('名称')).toBeTruthy()
    expect(screen.getByLabelText('描述')).toBeTruthy()
    expect(screen.getByRole('button', { name: '保存草稿' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '配置试运行' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '发布草稿' })).toBeTruthy()
    // 资产选择器表头七个维度齐全。
    expect(editor.textContent).toContain('资产选择器')
    for (const column of ['名称', '版本', '用途', '授权', 'readiness', '更新时间', '来源', '可选']) {
      expect(editor.textContent).toContain(column)
    }
  })

  it('surfaces an unreadable edit context as an explicit blocked reason', async () => {
    const { remote } = fakeRemote({
      profileEditContext: vi.fn(async () => ({ status: 'failed', code: 'NOT_FOUND', message: '配置不存在' })),
    })
    render(<AgentConfigEditor remote={remote} profileId="ap-code-default" />)

    const alert = await screen.findByRole('alert')
    await waitFor(() => { expect(alert.textContent).toContain('不可编辑：配置不存在') })
  })

  it('blocks editing when the newest version is archived', async () => {
    const { remote, fns } = fakeRemote({ profileEditContext: vi.fn(async () => editContext('archived')) })
    render(<AgentConfigEditor remote={remote} profileId="ap-code-default" />)

    const alert = await screen.findByRole('alert')
    await waitFor(() => { expect(alert.textContent).toContain('不可编辑') })
    // 不可编辑时不得自动建草稿。
    expect(fns.createProfileVersion).not.toHaveBeenCalled()
  })

  it('creates a draft version when the newest version is published', async () => {
    const { remote, fns } = fakeRemote({ profileEditContext: vi.fn(async () => editContext('published')) })
    render(<AgentConfigEditor remote={remote} profileId="ap-code-default" />)

    await waitFor(() => { expect(fns.createProfileVersion).toHaveBeenCalled() })
    await waitFor(() => { expect(screen.getByRole('button', { name: '保存草稿' })).toBeTruthy() })
  })

  it('reports a saved draft through the status line', async () => {
    const { remote, fns } = fakeRemote()
    render(<AgentConfigEditor remote={remote} profileId="ap-code-default" />)
    await screen.findByRole('button', { name: '保存草稿' })

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '改过的名字' } })
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }))

    await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('草稿已保存') })
    expect(fns.updateProfileDraft).toHaveBeenCalledWith(expect.objectContaining({
      profileId: 'ap-code-default',
      expectedRevision: 7,
      patch: { name: '改过的名字', description: '' },
    }))
  })

  it('reports a failed save instead of leaving the click silent', async () => {
    const { remote } = fakeRemote({
      updateProfileDraft: vi.fn(async () => { throw Object.assign(new Error('revision 已变化'), { code: 'REVISION_CONFLICT' }) }),
    })
    render(<AgentConfigEditor remote={remote} profileId="ap-code-default" />)
    await screen.findByRole('button', { name: '保存草稿' })

    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }))
    await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('保存失败：revision 已变化') })
  })

  it('renders the dry-run checks when the dry run succeeds', async () => {
    const { remote } = fakeRemote()
    render(<AgentConfigEditor remote={remote} profileId="ap-code-default" />)
    await screen.findByRole('button', { name: '配置试运行' })

    fireEvent.click(screen.getByRole('button', { name: '配置试运行' }))
    const panel = await screen.findByRole('status', { name: '配置试运行结果' })
    expect(panel.textContent).toContain('策略允许写入')
  })

  it('does not let a failed dry run pass silently', async () => {
    // 试运行失败必须与保存失败一样有显式出口：点击不能什么都不发生。
    const { remote } = fakeRemote({
      dryRunProfile: vi.fn(async () => ({ status: 'failed', code: 'DRY_RUN_BLOCKED', message: '该配置被阻断' })),
    })
    render(<AgentConfigEditor remote={remote} profileId="ap-code-default" />)
    await screen.findByRole('button', { name: '配置试运行' })

    fireEvent.click(screen.getByRole('button', { name: '配置试运行' }))
    await waitFor(() => {
      const surfaces = screen.queryAllByRole('status').concat(screen.queryAllByRole('alert'))
      expect(surfaces.map(node => node.textContent ?? '').join('|')).toMatch(/试运行失败|该配置被阻断|DRY_RUN_BLOCKED/u)
    })
  })

  it('publishes the draft and asks the parent to close the editor', async () => {
    const onFinished = vi.fn()
    const { remote, fns } = fakeRemote()
    render(<AgentConfigEditor remote={remote} profileId="ap-code-default" onFinished={onFinished} />)
    await screen.findByRole('button', { name: '发布草稿' })

    fireEvent.click(screen.getByRole('button', { name: '发布草稿' }))
    await waitFor(() => { expect(onFinished).toHaveBeenCalledTimes(1) })
    expect(fns.publishProfileVersion).toHaveBeenCalledWith(expect.objectContaining({
      profileId: 'ap-code-default',
      versionId: 'apv-draft-1',
      expectedRevision: 7,
    }))
  })
})
