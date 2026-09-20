/* 覆盖补齐：`resolveTelemetrySettings` 的三条拒绝分支。
 *
 * 解析器把「部署配置里的每个字段都必须是正整数，且批量上限不得超过队列容量」
 * 作为硬约束；此前的覆盖只走了「全部缺省」与「部分覆盖」两条成功路径，
 * 三条 throw 从未被执行。它们是配置错误的唯一防线，不得只靠默认值掩盖。
 */
import { describe, expect, it } from 'vitest'
import { resolveTelemetrySettings } from '../src/telemetry/settings.ts'

describe('resolveTelemetrySettings', () => {
  it('applies the documented defaults when the deployment omits every field', () => {
    expect(resolveTelemetrySettings()).toEqual({
      maxEvents: 10_000,
      maxBytes: 33_554_432,
      batchMaxEvents: 500,
      batchMaxBytes: 2_097_152,
      flushIntervalMs: 15_000,
      httpTimeoutMs: 10_000,
      maxAttempts: 12,
      retentionMs: 604_800_000,
      claimTimeoutMs: 60_000,
    })
  })

  it('rejects a field that is not a positive integer', () => {
    expect(() => resolveTelemetrySettings({ maxEvents: 0 })).toThrow(/must be a positive integer/u)
    expect(() => resolveTelemetrySettings({ maxEvents: -1 })).toThrow(/must be a positive integer/u)
    expect(() => resolveTelemetrySettings({ flushIntervalMs: 1.5 })).toThrow(/must be a positive integer/u)
    expect(() => resolveTelemetrySettings({ maxAttempts: Number.NaN })).toThrow(/must be a positive integer/u)
  })

  it('rejects batch limits that exceed queue capacity', () => {
    expect(() => resolveTelemetrySettings({ maxEvents: 10, batchMaxEvents: 11 }))
      .toThrow(/"batchMaxEvents" must not exceed "maxEvents"/u)
    expect(() => resolveTelemetrySettings({ maxBytes: 1024, batchMaxBytes: 2048 }))
      .toThrow(/"batchMaxBytes" must not exceed "maxBytes"/u)
  })
})
