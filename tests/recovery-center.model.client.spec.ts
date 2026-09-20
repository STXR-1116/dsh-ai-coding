// 1-6「恢复中心」模型层验收（蓝图 §5.2/§8.3）。
//
// 异常矩阵：
//   五类来源 —— failed_run / pending_approval / stream_stale / index_delay /
//               unsynced_changes 逐类分类；无条目时为空数组（不伪造内容）。
//   四类动作 —— 授权类失败→needs-admin；超时/无码失败→safe-retry；paused→
//               needs-decision；stale→safe-retry；未同步变更→needs-decision。
//   证据     —— 每条目携带 evidence（错误码/revision/trace/文件数），
//               failed_run/pending_approval 携带 runId 供跳转明细。
//   顺序     —— 按来源类别固定顺序输出。
import { describe, expect, it } from 'vitest'
import { buildRecoveryCenter } from '../src/client/cloud-workspaces/recovery-center.ts'
import type { AgentRunSnapshot, WorkspaceChanges, WorkspaceStreamState } from '../src/types.ts'

const run = (status: AgentRunSnapshot['status'], runId: string, errorCode: string | null = null): AgentRunSnapshot => ({
  runId,
  projectId: 'project-alpha',
  workspaceId: 'ws-1',
  sessionId: 'sess-1',
  agentProfileVersionId: 'apv-1',
  assetVersionIds: [],
  executionPolicy: {},
  workspaceRevision: 7,
  status,
  writeMode: 'read_only',
  leaseId: null,
  revision: 3,
  errorCode,
  createdAt: '2026-09-16T00:00:00Z',
  updatedAt: '2026-09-16T00:01:00Z',
})

const changes: WorkspaceChanges = {
  workspaceId: 'ws-1',
  baselineRevision: 5,
  revision: 7,
  files: [{ path: 'src/app.json', change: 'modified', diff: '--- a\n+++ b' }],
}

describe('buildRecoveryCenter 五类来源与四类动作', () => {
  it('失败运行：授权类错误 → needs-admin；超时 → safe-retry；均携带证据与 runId', () => {
    const items = buildRecoveryCenter({
      runs: [
        run('failed', 'run-auth', 'FORBIDDEN'),
        run('failed', 'run-timeout', 'RUN_TIMEOUT'),
      ],
    })
    expect(items.map(item => item.action)).toEqual(['needs-admin', 'safe-retry'])
    expect(items[0]!.evidence).toContain('FORBIDDEN')
    expect(items[1]!.runId).toBe('run-timeout')
  })

  it('paused 运行 → needs-decision；stale → safe-retry；索引延迟 → safe-retry', () => {
    const items = buildRecoveryCenter({
      runs: [run('paused', 'run-p')],
      streamState: { status: 'stale' } as WorkspaceStreamState,
      indexDelay: true,
    })
    expect(items.map(item => item.kind)).toEqual(['pending_approval', 'stream_stale', 'index_delay'])
    expect(items[0]!.action).toBe('needs-decision')
    expect(items[1]!.action).toBe('safe-retry')
    expect(items[2]!.action).toBe('safe-retry')
  })

  it('未同步变更 → needs-decision 并携带基线/当前 revision 与文件数', () => {
    const items = buildRecoveryCenter({ runs: [], changes })
    expect(items).toHaveLength(1)
    expect(items[0]!.kind).toBe('unsynced_changes')
    expect(items[0]!.action).toBe('needs-decision')
    expect(items[0]!.evidence).toContain('baseline 5')
    expect(items[0]!.evidence).toContain('1 个文件')
  })

  it('无任何异常来源时为空数组（不伪造恢复条目）', () => {
    const emptyChanges: WorkspaceChanges = { workspaceId: 'ws-1', baselineRevision: 5, revision: 7, files: [] }
    expect(buildRecoveryCenter({
      runs: [run('running', 'run-ok')],
      changes: emptyChanges,
      streamState: { status: 'live' } as WorkspaceStreamState,
    })).toEqual([])
  })
})
