// workspace-http 公共层直接单测（终收尾轮·覆盖专项第二批）：
// normalizeApiBaseUrl 的三种拒绝形态、dry-run 的 blocked 合法结果、
// parsePage 的空游标路径。
//
// 分类：FIXTURE-ONLY。
import { describe, expect, it } from 'vitest'
import { normalizeApiBaseUrl, parseProfileDryRun, parsePage } from '../src/workspace-http.ts'

const TS0 = '2026-09-17T00:00:00.000Z'

describe('公共层：normalizeApiBaseUrl', () => {
  it('strips the trailing slash and any trailing /v1 segments', () => {
    expect(normalizeApiBaseUrl('http://x.test/')).toBe('http://x.test')
    expect(normalizeApiBaseUrl('http://x.test/v1')).toBe('http://x.test')
    expect(normalizeApiBaseUrl('http://x.test/v1/')).toBe('http://x.test')
    expect(normalizeApiBaseUrl('http://x.test/api/v1/v1')).toBe('http://x.test/api')
  })

  it('rejects non-absolute, non-http and query-carrying base URLs', () => {
    expect(() => normalizeApiBaseUrl('not-a-url')).toThrow('not an absolute URL')
    expect(() => normalizeApiBaseUrl('ftp://x.test')).toThrow('must use http or https')
    expect(() => normalizeApiBaseUrl('http://x.test/?a=1')).toThrow('must not carry a query')
    expect(() => normalizeApiBaseUrl('http://x.test/#frag')).toThrow('must not carry a query')
  })
})

describe('公共层：parseProfileDryRun 与 parsePage', () => {
  it('dry-run outcome accepts blocked', () => {
    const payload = {
      dry_run_id: 'dry-2',
      agent_profile_version_id: 'apv-1',
      outcome: 'blocked',
      checks: [{ check: '资产授权', result: 'fail', detail: '未授权' }],
      created_at: TS0,
    }
    expect(parseProfileDryRun(payload).outcome).toBe('blocked')
  })

  it('parsePage returns a null cursor when the page is exhausted', () => {
    const page = parsePage({ items: [1, 2], next_cursor: null }, (entry: unknown) => entry, 'probe page')
    expect(page.items).toEqual([1, 2])
    expect(page.nextCursor).toBeNull()
  })
})
