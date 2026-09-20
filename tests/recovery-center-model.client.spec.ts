/* 覆盖补齐：`buildRecoveryCenter` 里「失败运行没有错误码」的两条分支。
 *
 * 服务端的失败运行不一定带 `errorCode`（瞬态/超时无码是真实情形）。该模型对
 * 这两种输入的规定是**仍然安全可重试**，且证据行如实写「无」而不是留空——
 * 与「有码」路径只差文案，不是死分支。
 */
import { describe, expect, it } from 'vitest'
import { buildRecoveryCenter } from '../src/client/cloud-workspaces/recovery-center.ts'
import type { AgentRunSnapshot } from '../src/types.ts'

const run = (overrides: Partial<AgentRunSnapshot>): AgentRunSnapshot => ({
  runId: 'run-1',
  projectId: 'project-alpha',
  workspaceId: 'ws-alpha-1',
  sessionId: 'sess-1',
  agentProfileVersionId: 'apv-1',
  assetVersionIds: [],
  executionPolicy: {},
  workspaceRevision: 7,
  status: 'running',
  writeMode: 'read_only',
  leaseId: null,
  revision: 3,
  errorCode: null,
  createdAt: '2026-09-16T00:00:00Z',
  updatedAt: '2026-09-16T00:01:00Z',
  ...overrides,
})

describe('buildRecoveryCenter 失败运行归类', () => {
  it('routes an authorization failure to an administrator, not to a caller retry', () => {
    const items = buildRecoveryCenter({ runs: [run({ status: 'failed', errorCode: 'FORBIDDEN' })] })
    expect(items).toHaveLength(1)
    expect(items[0]!.action).toBe('needs-admin')
    expect(items[0]!.evidence).toContain('FORBIDDEN')
  })

  it('keeps a coded non-authorization failure as a safe retry', () => {
    const items = buildRecoveryCenter({ runs: [run({ status: 'failed', errorCode: 'RUN_TIMEOUT' })] })
    expect(items[0]!.action).toBe('safe-retry')
    expect(items[0]!.reason).toContain('RUN_TIMEOUT')
    expect(items[0]!.evidence).toContain('error_code=RUN_TIMEOUT')
  })

  it('still offers a safe retry when the failure carries no code, and says so instead of leaving it blank', () => {
    const items = buildRecoveryCenter({ runs: [run({ runId: 'run-nocode', status: 'failed', errorCode: null })] })
    expect(items).toHaveLength(1)
    expect(items[0]!.action).toBe('safe-retry')
    expect(items[0]!.reason).toBe('运行失败，可安全重试')
    expect(items[0]!.evidence).toContain('error_code=无')
    expect(items[0]!.evidence).not.toContain('error_code= ·')
  })

  it('ignores runs that did not fail', () => {
    expect(buildRecoveryCenter({ runs: [run({ status: 'running' })] })).toHaveLength(0)
  })
})
