// @vitest-environment jsdom
/* 覆盖补齐：`PlatformEntry` 的宽栏 / 窄栏两种呈现。
 *
 * 该动作在侧栏展开时给出文字标签、收进导轨时只留图标并带 tooltip——两条分支
 * 此前只有一条被渲染到（另一条的 `wide ? … : …` 右侧从未执行）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PlatformEntry, type PlatformEntryProps } from '../src/client/PlatformEntry.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
})

/** 只覆盖本命名空间的 key；参数与运行时翻译函数同形。 */
const translate = (key: string): string => (zh as Record<string, string>)[key] ?? key

/**
 * 本命名空间的 locale 注册在 client 测试程序之外，因此 PropsLocale 在此解析为
 * object、t 不是声明属性；运行时组件确实需要它，故在测试里显式断言一次
 * 这份运行时 props 形状（唯一的一处逃生舱，仅限本测试）。
 */
const entryProps = (wide: boolean, onOpen: () => void): PlatformEntryProps =>
  ({ wide, onOpen, t: translate } as unknown as PlatformEntryProps)

describe('PlatformEntry', () => {
  it('renders the wide label and omits the tooltip when the sidebar is expanded', () => {
    const onOpen = vi.fn()
    render(<PlatformEntry {...entryProps(true, onOpen)} />)

    expect(screen.getByText(zh['platform.shortName'])).toBeTruthy()
    const button = screen.getByRole('button', { name: zh['platform.open'] })
    // 宽栏已经有可见文字，title 必须是 undefined（不重复朗读）。
    expect(button.getAttribute('title')).toBeNull()

    fireEvent.click(button)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('renders the icon alone with a tooltip when the sidebar is collapsed', () => {
    render(<PlatformEntry {...entryProps(false, vi.fn())} />)

    expect(screen.queryByText(zh['platform.shortName'])).toBeNull()
    const button = screen.getByRole('button', { name: zh['platform.open'] })
    expect(button.getAttribute('title')).toBe(zh['platform.open'])
  })
})
