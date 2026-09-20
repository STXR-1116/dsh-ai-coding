// workspace-http 剩余嵌套缺失变异（终收尾轮·覆盖专项第二批之二）。
//
// 逐字段覆盖 parseRun 时间线、AgentProfile 绑定、dry-run blocked 结果、
// edit context 版本状态、pulse 各 kind 的必填成员、approval 三块子对象与
// checkpoint 完成步骤的拒绝分支；另含 parsePage 的空游标路径。
//
// 分类：FIXTURE-ONLY。
import { describe, expect, it } from 'vitest'
import { parseAgentProfile, parseApproval, parseProfileDryRun, parseProfileEditContext, parsePulse, parseRun, parseRunCheckpoint, parsePage } from '../src/workspace-http.ts'

const TS0 = '2026-09-17T00:00:00.000Z'

const baseRun = {
  run_id: 'run-x',
  project_id: 'project-alpha',
  workspace_id: 'ws-1',
  session_id: 's-1',
  agent_profile_version_id: 'apv-1',
  asset_version_ids: ['k-1'],
  execution_policy: { permission_mode: 'approval', tool_allowlist: ['read'] },
  workspace_revision: 1,
  status: 'running',
  write_mode: 'read_only',
  lease_id: null,
  revision: 2,
  error_code: null,
  created_at: TS0,
  updated_at: TS0,
  events: [
    { status: 'running', at: TS0, reason: 'r', operator: 'o', policy_version: 'apv-1', revision: 1, trace_id: 't' },
  ],
}

const profileWithBinding = {
  status: 'published',
  agent_profile_id: 'ap-1',
  agent_profile_version_id: 'apv-1',
  name: 'n',
  description: 'd',
  version_label: '1.0.0',
  change_summary: 'c',
  agent_type_id: 'at-1',
  agent_type_name: 't',
  agent_type_key: 'k',
  agent_type_readiness: 'ready',
  agent_type_capabilities: [],
  model: 'm',
  reasoning: 'r',
  skills: [{ asset_id: 's-1', asset_version_id: 's-1@1', name: 'skill', readiness: 'ready', unavailable_reason: null }],
  knowledge_bases: [],
  memory: null,
  execution_policy: { permission_mode: 'approval' },
  readiness: 'ready',
  unavailable_reason: null,
  default: true,
  created_by: 'u',
  published_at: TS0,
  updated_at: TS0,
  type_extension_config: {},
}

describe('workspace-http 嵌套缺失变异', () => {
  const timelineVariants: Record<string, Record<string, unknown>> = {
    without_reason: { status: 'running', at: TS0, operator: 'o', policy_version: 'apv-1', revision: 1, trace_id: 't' },
    without_operator: { status: 'running', at: TS0, reason: 'r', policy_version: 'apv-1', revision: 1, trace_id: 't' },
    without_policy_version: { status: 'running', at: TS0, reason: 'r', operator: 'o', revision: 1, trace_id: 't' },
    without_revision: { status: 'running', at: TS0, reason: 'r', operator: 'o', policy_version: 'apv-1', trace_id: 't' },
    without_trace_id: { status: 'running', at: TS0, reason: 'r', operator: 'o', policy_version: 'apv-1', revision: 1 },
  }

  for (const [variant, event] of Object.entries(timelineVariants)) {
    it(`parseRun rejects a timeline entry ${variant}`, () => {
      const payload = { ...baseRun, events: [event] }
      expect(() => parseRun(payload)).toThrow()
    })
  }

  it('parseRun rejects a non-finite optional number inside the execution policy', () => {
    const payload = { ...baseRun, execution_policy: { permission_mode: 'approval', timeout_ms: 'soon' } }
    expect(() => parseRun(payload)).toThrow()
  })

  it('parseRun rejects a string-array member that carries a non-string', () => {
    const payload = { ...baseRun, asset_version_ids: ['k-1', 7] }
    expect(() => parseRun(payload)).toThrow()
  })

  it('parseAgentProfile rejects a binding whose required flag is missing', () => {
    expect(() => parseAgentProfile(profileWithBinding)).toThrow()
  })

  it('parseProfileDryRun accepts a blocked outcome', () => {
    const payload = {
      dry_run_id: 'dry-2',
      agent_profile_version_id: 'apv-1',
      outcome: 'blocked',
      checks: [{ check: '资产授权', result: 'fail', detail: '未授权' }],
      created_at: TS0,
    }
    expect(parseProfileDryRun(payload).outcome).toBe('blocked')
  })

  it('parseProfileEditContext rejects an unknown version status', () => {
    const payload = {
      agent_profile_id: 'ap-1',
      revision: 1,
      name: 'n',
      versions: [{ agent_profile_version_id: 'apv-1', version: '1', status: 'pending' }],
    }
    expect(() => parseProfileEditContext(payload)).toThrow()
  })

  it('parsePulse rejects each kind-specific required member when missing', () => {
    const items: Record<string, unknown>[] = [
      { kind: 'approval', at: TS0, revision: 1, trace_id: 't', summary: 's', decision: 'maybe', operator: 'o' },
      { kind: 'tool_call', at: TS0, revision: 1, trace_id: 't', summary: 's', result: 'r' },
      { kind: 'checkpoint', at: TS0, revision: 1, trace_id: 't', summary: 's', checkpoint_id: 'c-1' },
      { kind: 'test', at: TS0, revision: 1, trace_id: 't', summary: 's', total: 1 },
    ]
    const failures: string[] = []
    for (const item of items) {
      const single = { run_id: 'run-1', items: [item] }
      try {
        parsePulse(single)
      } catch {
        failures.push(String(item.kind))
      }
    }
    expect(failures.length).toBe(4)
  })

  it('parseApproval rejects missing permission, risk and revocable members', () => {
    const base = {
      approval_id: 'a-1',
      run_id: 'run-1',
      action: 'terminal.write',
      summary: 's',
      affected: ['ws-1'],
      permission: { code: 'OK', allowed: true, reason: 'r', policy_version: 'p' },
      asset_versions: [{ asset_version_id: 'k-1', status: 'bound', detail: 'd' }],
      risk: { level: 'low', reason: 'low' },
      revocable: { revocable: true, how: 'h' },
      expires_at: TS0,
      created_at: TS0,
    }
    const withoutCode = JSON.parse(JSON.stringify(base)) as { permission: Record<string, unknown> }
    delete withoutCode.permission.code
    expect(() => parseApproval(withoutCode)).toThrow()
    const withoutRiskReason = JSON.parse(JSON.stringify(base)) as { risk: Record<string, unknown> }
    delete withoutRiskReason.risk.reason
    expect(() => parseApproval(withoutRiskReason)).toThrow()
    const withoutFlag = JSON.parse(JSON.stringify(base)) as { revocable: Record<string, unknown> }
    delete withoutFlag.revocable.revocable
    expect(() => parseApproval(withoutFlag)).toThrow()
  })

  it('parseRunCheckpoint rejects a non-integer completed step', () => {
    const payload = {
      created_at: TS0,
      trace_id: 't',
      session_seq: 1,
      tool_results: [],
      pending_approval: null,
      completed_steps: [0, 'one'],
      agent_config: { agent_profile_version_id: 'apv-1', execution_policy: {} },
      asset_version_ids: [],
      workspace_revision: 2,
      plan_id: null,
      resume_preview: { reuse: [], replay: [] },
    }
    expect(() => parseRunCheckpoint(payload)).toThrow()
  })

  it('parsePage returns a null cursor when the page is exhausted', () => {
    const page = parsePage({ items: [1, 2], next_cursor: null }, (entry: unknown) => entry, 'probe page')
    expect(page.items).toEqual([1, 2])
    expect(page.nextCursor).toBeNull()
  })
})
