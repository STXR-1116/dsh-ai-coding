/* 覆盖补齐：本包自己的 locale 字典此前没有任何用例导入。 */
import { describe, expect, it } from 'vitest'
import { NS, en, zh } from '../src/client/locales.ts'

describe('platform locale dictionaries', () => {
  it('keeps every English key present so the standard registry stays complete', () => {
    // `en` 用 satisfies 在类型层保证；运行时再钉一次，防止有人绕过 as const 放宽。
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('carries a non-empty translation for each key in both languages', () => {
    for (const key of Object.keys(zh) as Array<keyof typeof zh>) {
      expect(zh[key], `zh.${key}`).not.toBe('')
      expect(en[key], `en.${key}`).not.toBe('')
    }
  })

  it('exposes the namespace this package registers', () => {
    expect(NS).toBe('aiCodingPlatform')
  })
})
