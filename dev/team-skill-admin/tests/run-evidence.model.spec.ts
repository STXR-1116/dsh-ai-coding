import { describe, expect, it } from 'vitest'
import { buildEvidenceTimeline } from '../src/lib/run-evidence.ts'
import type { CloudRun } from '../src/lib/team-skill-types.ts'

// 4-7「运行与审计」模型层验收（蓝图 §6.7）。
//
// 异常矩阵：
//   合成   —— CloudRun timeline + pulse 条目 + 文件变更合并为一条有序时间轴。
//   类别   —— 覆盖 审批/工具调用/测试/文件变更/最终结果；排序按 at 升序。
//   脱敏   —— 凭据引用或 token 字段的 detail 被脱敏为「（已脱敏）」。
//   空安全 —— 空 pulse / 空 changes / 空 timeline → 空时间轴不崩溃。

const run = (overrides: Partial<CloudRun> = {}): CloudRun => ({
  run_id: 'r-1', project_id: 'p-1', workspace_id: 'ws-1', session_id: 's-1',
  agent_profile_version_id: 'apv-1', asset_version_ids: [], execution_policy: {},
  workspace_revision: 1, status: 'running', write_mode: 'write', lease_id: null,
  revision: 1, error_code: null, created_at: '', updated_at: '',
  timeline: [
    { status: 'preparing', at: '2026-09-10T00:00:00Z', reason: 'Run 已创建', operator: 'admin', policy_version: 'apv-1', revision: 1, trace_id: 't-1' },
  ],
  ...overrides,
})

describe('4-7 证据时间轴', () => {
  it('合并 timeline/pulse/changes 为有序时间轴', () => {
    const timeline = buildEvidenceTimeline({
      run: run(),
      pulse: { items: [
        { kind: 'tool_call', at: '2026-09-10T00:01:00Z', summary: 'write_file：c1', tool: 'write_file', call_id: 'c1', result: '已写入' },
        { kind: 'test', at: '2026-09-10T00:02:00Z', summary: '测试', total: 5, passed: 5, failed: 0 },
      ] },
      changes: { files: [{ path: 'README.md', change: 'modified' }] },
    })
    expect(timeline.length).toBeGreaterThanOrEqual(3)
    const categories = timeline.map(entry => entry.category)
    expect(categories).toContain('审批')
    expect(categories).toContain('工具调用')
    expect(categories).toContain('测试')
    expect(categories).toContain('文件变更')
    // at 升序
    const ats = timeline.map(entry => entry.at)
    expect([...ats].sort()).toEqual(ats)
  })

  it('凭据/token 字段被脱敏为（已脱敏）', () => {
    const timeline = buildEvidenceTimeline({
      run: run({ error_code: null }),
      pulse: { items: [
        { kind: 'status', at: '2026-09-10T00:01:00Z', summary: '凭据 credential_token', detail: 'credential_secret_ref' },
      ] },
    })
    const sensitive = timeline.find(entry => (entry.summary + entry.detail).includes('credential'))
    expect(sensitive?.redacted).toBe(true)
    expect(sensitive?.detail).toBe('（已脱敏）')
  })

  it('失败运行带最终结果条目', () => {
    const timeline = buildEvidenceTimeline({
      run: run({ status: 'failed', error_code: 'AGENT_TYPE_UNAVAILABLE', updated_at: '2026-09-10T01:00:00Z' }),
    })
    const final = timeline.filter(entry => entry.category === '最终结果')
    expect(final.length).toBe(1)
    expect(final[0]?.summary).toContain('AGENT_TYPE_UNAVAILABLE')
  })

  it('空输入 → 空时间轴', () => {
    const timeline = buildEvidenceTimeline({ run: run({ timeline: [] }) })
    expect(timeline.length).toBe(0)
  })
})
