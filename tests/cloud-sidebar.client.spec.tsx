// @vitest-environment jsdom
/**
 * 左栏「会话记录」的点击契约。
 *
 * 所有者实测：「点击会话记录无响应」。这条用例把**点击 → 回调**这一段钉住 ——
 * 它此前只被"接管后左栏渲染出来了"覆盖（那是渲染，不是交互），所以点击断了也没人发现。
 *
 * 同时钉住另一件事：**当前选中行必须有可见反馈**（`aria-current`）——
 * 点击后的中央内容一时看不到（要等后端内容），高亮就是用户唯一的即时反馈。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { CloudSidebar } from '../src/client/CloudSidebar.tsx'
import type { PlatformRemote } from '../src/client/remote/types.ts'

// 显式 cleanup：本项目的 jsdom 项目没有开 globals，testing-library 的自动清理不生效。
// 实测后果：前一个用例的组件留在 DOM 里 ⇒ `findByRole` 拿到两个同名按钮 ⇒ 点到旧的那个，
// 断言拿到的是旧 mock（"单独跑通过、一起跑失败"的典型形状）。
afterEach(() => { cleanup() })

const ready = (value: unknown) => ({ ok: true as const, value: { status: 'ready' as const, value, fixtureOnly: true } })

/** 只实现左栏用到的读与新建：会话记录、目录、新建会话。 */
function fakeRemote(): PlatformRemote {
  return {
    teamSkills: {},
    workspaceSessions: {},
    cloudWorkspaces: {
      // 新建：返回一条新记录（契约 §3.1.1：`{ session: {...} }` 由 host 映射成 camelCase）。
      createWorkspaceSession: vi.fn(async () => ready({ sessionId: 'sess-new', title: '新会话 1' })),
      workspaceSessionRecords: vi.fn(async () => ready([
        // **camelCase**：这是 host 映射后的形状（平台给的是 snake_case，host 负责转换）。
        // 第一版这里写成 `{session_id, title, updated_at}`，于是 `sessionId` 恒为 undefined ——
        // 点击照样"有反应"，但回调收到的 id 是空的（这条测试当场把这个说了出来）。
        { sessionId: 'sess-1', title: '联调记录：云工作空间状态序列', updatedAt: '2026-09-22T09:10:00Z' },
        { sessionId: 'sess-2', title: '初始化与依赖安装', updatedAt: '2026-09-21T18:40:00Z' },
      ])),
      workspaceFiles: vi.fn(async () => ready({ path: '', revision: 7, items: [] })),
    },
  } as unknown as PlatformRemote
}

/** 让左栏认为当前选中了这个工作空间（它读的是视图写入的共享通道）。 */
function selectWorkspace(workspaceId: string): void {
  window.localStorage.setItem('cloud-workspace-ui:project-alpha:member-1', JSON.stringify({ selectedId: workspaceId }))
}

describe('左栏会话记录的点击', () => {
  it('点「＋ 新建」⇒ 调后端新建接口，并切到新建的会话', async () => {
    selectWorkspace('ws-alpha-1')
    const remote = fakeRemote()
    const onSelectPlatformSession = vi.fn()
    render(<CloudSidebar remote={remote} onSelectPlatformSession={onSelectPlatformSession} />)

    // 新会话按钮在「会话记录」标题行右侧（契约 §3.1.1：接管模式自己的入口）。
    const create = await screen.findByRole('button', { name: '新建会话' })
    fireEvent.click(create)
    await vi.waitFor(() => {
      expect(remote.cloudWorkspaces.createWorkspaceSession).toHaveBeenCalledWith('ws-alpha-1')
    })
    // 新建成功后切到它（中央随后由外壳切会话）。
    await vi.waitFor(() => {
      expect(onSelectPlatformSession).toHaveBeenCalledWith('ws-alpha-1', 'sess-new')
    })
  })

  it('点一条记录 ⇒ 回调带上（工作空间 id, 平台会话 id）', async () => {
    selectWorkspace('ws-alpha-1')
    const onSelectPlatformSession = vi.fn()
    render(
      <CloudSidebar
        remote={fakeRemote()}
        onSelectPlatformSession={onSelectPlatformSession}
      />,
    )

    const first = await screen.findByRole('button', { name: /联调记录：云工作空间状态序列/u })
    // 相对时间照原生写：那行文字**就是**相对时间（不是原始 ISO 串）——
    // 所有者对照原生指出过这一点，所以在这里一并钉住（同一个按钮，不做第二次渲染）。
    expect(first.textContent).toMatch(/刚刚|分钟|小时|天|个月|年/u)
    expect(first.textContent).not.toMatch(/T\d{2}:\d{2}/u)

    fireEvent.click(first)
    expect(onSelectPlatformSession).toHaveBeenCalledWith('ws-alpha-1', 'sess-1')
  })

  it('点击后该行立刻高亮（中央内容一时看不到时的即时反馈）', async () => {
    selectWorkspace('ws-alpha-1')
    render(<CloudSidebar remote={fakeRemote()} onSelectPlatformSession={() => {}} />)

    // 直接按 aria-label 取容器：`<section aria-label>` 在 testing-library 里既不是
    // labelable 元素（`getByLabelText` 拿不到），role 计算也不稳定地给 `region`。
    const pane = document.querySelector('[aria-label="会话记录区"]')!
    const second = await within(pane as HTMLElement).findByRole('button', { name: /初始化与依赖安装/u })
    expect(second.getAttribute('aria-current')).toBeNull()
    fireEvent.click(second)
    expect(second.getAttribute('aria-current')).toBe('true')
  })

})
