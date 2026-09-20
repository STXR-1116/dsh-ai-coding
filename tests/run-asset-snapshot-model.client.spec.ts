/* 覆盖补齐：`assetDriftLabel` / `runAssetRows` 的未走到分支。
 *
 * 该纯模型的全部意义是「不让绑定时事实与读取时状态互相冒充」，因此每一条
 * 分支都是对外语义，不是防御性代码：
 *   - 可选资产绑定时不可用但**服务端没给原因**（必须如实说明「服务未提供原因」，
 *     不得编一个原因或留空）；
 *   - 「可选」标签（非必需资产）；
 *   - 绑定/当前状态落在词表之外时**原样透出**（不映射成默认值）。
 */
import { describe, expect, it } from 'vitest'
import { assetDriftLabel, runAssetRows } from '../src/client/cloud-workspaces/run-asset-snapshot.ts'
import type { RunAssetSnapshotEntry } from '../src/types.ts'

const entry = (overrides: Partial<RunAssetSnapshotEntry>): RunAssetSnapshotEntry => ({
  assetType: 'skill',
  assetId: 'skill:x',
  assetVersionId: 'skill:x@1.0.0',
  name: '资产',
  required: true,
  order: 1,
  readinessAtBinding: 'ready',
  unavailableReasonAtBinding: null,
  currentState: 'bound',
  withdrawnAt: null,
  withdrawalAuditId: null,
  ...overrides,
})

describe('assetDriftLabel', () => {
  it('reports withdrawal and catalogue disappearance only for assets ready at binding', () => {
    expect(assetDriftLabel(entry({ currentState: 'withdrawn' }))).toContain('之后被撤回')
    expect(assetDriftLabel(entry({ currentState: 'missing' }))).toContain('不在服务目录中')
    expect(assetDriftLabel(entry({ currentState: 'bound' }))).toBeUndefined()
  })

  it('names a required asset that was already unavailable at binding as a run that should not have started', () => {
    const label = assetDriftLabel(entry({
      readinessAtBinding: 'unavailable', required: true, unavailableReasonAtBinding: '知识库已下线',
    }))
    expect(label).toContain('必需资产')
    expect(label).toContain('本次运行不应启动')
  })

  it('says the service gave no reason rather than inventing or omitting one', () => {
    const withReason = assetDriftLabel(entry({
      readinessAtBinding: 'unavailable', required: false, unavailableReasonAtBinding: '知识库已下线',
    }))
    expect(withReason).toContain('知识库已下线')
    const withoutReason = assetDriftLabel(entry({
      readinessAtBinding: 'unavailable', required: false, unavailableReasonAtBinding: null,
    }))
    expect(withoutReason).toContain('服务未提供原因')
  })
})

describe('runAssetRows', () => {
  it('keeps server order and marks optional assets as optional', () => {
    const rows = runAssetRows({
      runId: 'run-1',
      capturedAt: '2026-09-16T00:00:00Z',
      runRevision: 2,
      assets: [
        entry({ assetVersionId: 'a@1', name: 'A', order: 1 }),
        entry({ assetVersionId: 'b@1', name: 'B', order: 2, required: false }),
      ],
      governance: [],
    })
    expect(rows.map(row => row.assetVersionId)).toEqual(['a@1', 'b@1'])
    expect(rows.map(row => row.requiredLabel)).toEqual(['必需', '可选'])
    // 未发生变化时不加噪声。
    expect(rows.every(row => row.driftLabel === undefined)).toBe(true)
  })

  it('passes out-of-vocabulary binding and current states through verbatim', () => {
    const rows = runAssetRows({
      runId: 'run-1',
      capturedAt: '2026-09-16T00:00:00Z',
      runRevision: 2,
      assets: [entry({
        readinessAtBinding: 'degraded' as RunAssetSnapshotEntry['readinessAtBinding'],
        currentState: 'archived' as RunAssetSnapshotEntry['currentState'],
      })],
      governance: [],
    })
    // 词表漂移要看得见，不能被默认标签抹平。
    expect(rows[0]!.bindingLabel).toBe('绑定时：degraded')
    expect(rows[0]!.currentLabel).toBe('当前：archived')
  })
})
