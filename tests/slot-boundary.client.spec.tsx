// @vitest-environment jsdom
/* 槽位条目必须崩不掉。
 *
 * 渲染器给每个槽位条目套了自己的错误边界，捕获到错误后会做两件事：
 * 打印 `slot entry crashed in '<slot>': <error>`，并调用 `onEntryError` —— 槽位核心据此把该
 * 条目**退役**：注释原文是「在其注册的余生里都被排除在 entriesOfSlot 投影之外，而注册本身
 * 仍留在账本上」。没有任何东西会重新渲染它，也没有任何东西告诉用户入口为什么消失了；只有
 * 重新加载页面才能恢复。
 *
 * 对一个**启动器**来说这是最坏的结果：一次标签查表或图标的瞬时故障，不该把本会话里进入工作台
 * 的唯一入口带走。所以本插件给自己的贡献套上自己的边界，让框架看到的是「渲染成功」，条目留在
 * 原地、降级但可用。
 *
 * 本文件钉住这个性质：子树的异常**不逃逸**（否则框架就会退役条目），且降级内容仍然可用。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SlotBoundary } from '../src/client/slot-boundary.tsx'
import { PlatformEntry } from '../src/client/PlatformEntry.tsx'
import { PlatformSurfaceEntry } from '../src/client/PlatformSurfaceEntry.tsx'
import type { PlatformEntryProps } from '../src/client/PlatformEntry.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** A child that always throws, standing in for the fault we cannot reproduce. */
function Exploding(): never {
  throw new Error('render failed on purpose')
}

/** Silence and capture the boundary's own report. */
function captureConsole() {
  return vi.spyOn(console, 'error').mockImplementation(() => {})
}

const entryProps = (overrides: Partial<PlatformEntryProps> = {}): PlatformEntryProps => ({
  wide: true,
  onOpen: vi.fn(),
  t: ((key: string) => key) as PlatformEntryProps['t'],
  ...overrides,
} as PlatformEntryProps)

describe('SlotBoundary：异常不逃逸到槽位', () => {
  it('子树抛错时渲染降级内容，而不是把异常抛给框架', () => {
    const reported = captureConsole()
    // 若异常逃逸，这一行会直接失败——那正是条目被退役的路径。
    render(
      <SlotBoundary slot="sidebar.footer.action" fallback={<span>降级入口</span>}>
        <Exploding />
      </SlotBoundary>,
    )
    expect(screen.getByText('降级入口')).toBeTruthy()
    expect(reported).toHaveBeenCalled()
  })

  it('报告带上本插件的标签与该槽位，便于定位', () => {
    const reported = captureConsole()
    render(
      <SlotBoundary slot="shell.overlay" fallback={<span>降级</span>}>
        <Exploding />
      </SlotBoundary>,
    )
    // React 自己会先打一条 "The above error occurred in…"，本插件的报告在它的调用里；
    // 断言「存在一条带我们标签与槽位的报告」，而不是假定它一定是第一条。
    const ours = reported.mock.calls.map(call => String(call[0] ?? '')).filter(line => line.includes('[dsh-ai-coding]'))
    expect(ours).toHaveLength(1)
    expect(ours[0]).toContain('shell.overlay')
  })

  it('不出错时原样渲染子树', () => {
    render(
      <SlotBoundary slot="sidebar.footer.action" fallback={<span>降级</span>}>
        <span>正常内容</span>
      </SlotBoundary>,
    )
    expect(screen.getByText('正常内容')).toBeTruthy()
    expect(screen.queryByText('降级')).toBeNull()
  })
})

describe('侧栏入口：样式化渲染失败时仍保留可用入口', () => {
  it('t 抛错时降级为一个不依赖任何本插件资源的按钮', () => {
    captureConsole()
    const onOpen = vi.fn()
    const broken = { ...entryProps({ onOpen }), t: (() => { throw new Error('missing namespace') }) as PlatformEntryProps['t'] }
    render(<PlatformEntry {...broken} />)
    // 入口没有消失，且无障碍名与正常路径一致（选择器与肌肉记忆都还成立）。
    const button = screen.getByRole('button')
    expect(button.getAttribute('aria-label')).toContain('打开编程协作台')
    fireEvent.click(button)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('正常路径渲染样式化按钮并沿用注入的动作', () => {
    const onOpen = vi.fn()
    const t = ((key: string) => (key === 'platform.shortName' ? '协作台' : '打开编程协作台')) as PlatformEntryProps['t']
    render(<PlatformEntry {...entryProps({ onOpen, t })} />)
    const button = screen.getByRole('button')
    expect(button.getAttribute('aria-label')).toBe('打开编程协作台')
    expect(screen.getByText('协作台')).toBeTruthy()
    fireEvent.click(button)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })
})

describe('工作台浮层：整块渲染失败也收纳在边界内', () => {
  it('PlatformSurface 抛错时显示命名清楚的失败面板，而不是让浮层条目被退役', () => {
    captureConsole()
    // 故意给一个残缺的 props：工作台在渲染期读取注入面，这会触发异常。
    const broken = { } as unknown as Parameters<typeof PlatformSurfaceEntry>[0]
    render(<PlatformSurfaceEntry {...broken} />)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('dsh-ai-coding')
    expect(alert.textContent).toContain('重新加载页面')
  })
})
