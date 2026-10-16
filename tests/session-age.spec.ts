/**
 * `compactAge` 的阈值与文案。
 *
 * 为什么值得单测：所有者对照原生左栏指出「会话记录样式与原生的不一致」——
 * 修法之一就是把原始 ISO 串换成**与官方字典一致**的紧凑相对时间
 * （官方产物里：`time.now=刚刚` / `time.minutes={n}分钟` / `time.days={n}天` …）。
 * 阈值是可变的逻辑，文案是契约 —— 两者都钉住，别再退回 ISO 串。
 */
import { describe, expect, it } from 'vitest'
import { compactAge, AGE_LABELS_ZH } from '../src/client/cloud-workspaces/session-age.ts'

/** 固定"现在"，让断言与墙上时钟无关。 */
const NOW = Date.parse('2026-09-22T12:00:00Z')

/** 相对 NOW 造一个 ISO 串。 */
const ago = (ms: number): string => new Date(NOW - ms).toISOString()

describe('compactAge', () => {
  it('按官方字典的措辞给出紧凑相对时间', () => {
    expect(compactAge(ago(30_000), AGE_LABELS_ZH, NOW)).toBe('刚刚')
    expect(compactAge(ago(14 * 60_000), AGE_LABELS_ZH, NOW)).toBe('14分钟')
    expect(compactAge(ago(3 * 3_600_000), AGE_LABELS_ZH, NOW)).toBe('3小时')
    expect(compactAge(ago(24 * 86_400_000), AGE_LABELS_ZH, NOW)).toBe('24天')
    expect(compactAge(ago(3 * 30 * 86_400_000), AGE_LABELS_ZH, NOW)).toBe('3个月')
    expect(compactAge(ago(2 * 365 * 86_400_000), AGE_LABELS_ZH, NOW)).toBe('2年')
  })

  it('阈值边界不跳变：59 分钟仍是分钟、60 分钟变小时', () => {
    expect(compactAge(ago(59 * 60_000), AGE_LABELS_ZH, NOW)).toBe('59分钟')
    expect(compactAge(ago(60 * 60_000), AGE_LABELS_ZH, NOW)).toBe('1小时')
    expect(compactAge(ago(23 * 3_600_000), AGE_LABELS_ZH, NOW)).toBe('23小时')
    expect(compactAge(ago(24 * 3_600_000), AGE_LABELS_ZH, NOW)).toBe('1天')
    expect(compactAge(ago(29 * 86_400_000), AGE_LABELS_ZH, NOW)).toBe('29天')
    expect(compactAge(ago(30 * 86_400_000), AGE_LABELS_ZH, NOW)).toBe('1个月')
  })

  it('未来时间（时钟偏差）不显示负数', () => {
    expect(compactAge(new Date(NOW + 5 * 60_000).toISOString(), AGE_LABELS_ZH, NOW)).toBe('刚刚')
  })

  it('英文文案照官方字典（now / {n}min / {n}d）', () => {
    const en = { now: 'now', minutes: '{n}min', hours: '{n}h', days: '{n}d', months: '{n}mo', years: '{n}y' }
    expect(compactAge(ago(10_000), en, NOW)).toBe('now')
    expect(compactAge(ago(5 * 60_000), en, NOW)).toBe('5min')
    expect(compactAge(ago(86_400_000), en, NOW)).toBe('1d')
  })

  it('时间串不可解析时原样返回，不编造时间', () => {
    expect(compactAge('不是时间', AGE_LABELS_ZH, NOW)).toBe('不是时间')
  })
})
