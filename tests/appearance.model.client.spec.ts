// @vitest-environment jsdom
/* 覆盖补齐：外观偏好的读写与 `system` 主题解析此前没有用例。
 *
 * 异常矩阵：
 *   读取 —— 未存储或存了词表外的值时回落到默认；`localStorage` 抛错时同样回落，
 *           外观失败不得拖垮整个界面。
 *   写入 —— 两个键都要落盘，并在下一次读取时生效；写入抛错按尽力而为吞掉
 *           （内存偏好仍然生效，不向界面报错）。
 *   解析 —— `system` 必须跟随 OS；固定取值原样返回，不受 OS 影响。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_APPEARANCE,
  loadAppearance,
  resolveTheme,
  saveAppearance,
} from '../src/client/appearance.ts'

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('外观偏好读取', () => {
  it('没有存储过时回落到默认（dark + compact）', () => {
    expect(loadAppearance()).toEqual(DEFAULT_APPEARANCE)
  })

  it('词表外的存储值不得被采纳', () => {
    window.localStorage.setItem('dsh.appearance.theme', 'neon')
    window.localStorage.setItem('dsh.appearance.density', 'roomy')

    expect(loadAppearance()).toEqual(DEFAULT_APPEARANCE)
  })

  it('存储不可用时回落默认且不抛错', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })

    expect(loadAppearance()).toEqual(DEFAULT_APPEARANCE)
  })
})

describe('外观偏好写入', () => {
  it('两个键都落盘，并在下一次读取时生效', () => {
    saveAppearance({ theme: 'light', density: 'comfortable' })

    expect(window.localStorage.getItem('dsh.appearance.theme')).toBe('light')
    expect(window.localStorage.getItem('dsh.appearance.density')).toBe('comfortable')
    expect(loadAppearance()).toEqual({ theme: 'light', density: 'comfortable' })
  })

  it('写入失败按尽力而为吞掉，不向调用方抛错', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })

    expect(() => {
      saveAppearance({ theme: 'light', density: 'comfortable' })
    }).not.toThrow()
  })
})

describe('主题解析', () => {
  it('system 跟随 OS 设置', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })

  it('固定取值原样返回，不受 OS 影响', () => {
    expect(resolveTheme('dark', false)).toBe('dark')
    expect(resolveTheme('light', true)).toBe('light')
  })
})
