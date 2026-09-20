import { describe, expect, it } from 'vitest'
import {
  INSTALL_STAGES,
  buildInstallStages,
  classifyInstallFailure,
  type TeamSkillInstallStage,
} from '../src/install-stages.ts'

/**
 * 契约探针：《DSH-平台模块现状与后端API需求.md》§11.14（2026-09-16 冻结），
 * 安装七阶段证据。
 *
 * 异常矩阵：
 * - 缺失：未执行的阶段不得被省略，也不得呈现为 succeeded；前序失败后其后阶段
 *   一律 `skipped`，且必须携带非空 detail。
 * - 类型错误：阶段名越出闭集不可构造（类型层）；错误码不在映射表内时不得被
 *   猜测归入更早的阶段，只能落在失败当时正在执行的阶段。
 * - 边界：全部成功时 `rollback` 必须为 `skipped`；回滚自身失败必须可表达且
 *   不可重试；回滚被跳过的 detail 不得为空。
 * - 并发：无（纯函数）。
 * - 下游失败：授权类码归 `authorization`、校验类码归 `precheck`、依赖不可用归
 *   `precheck` 且可重试、下载失败归 `download` 且可重试、制品校验失败归
 *   `verify` 且不可重试。
 * - 审计：本模块不写审计；阶段证据只描述本次尝试。
 */

function succeeded(...stages: TeamSkillInstallStage[]): ReadonlyMap<TeamSkillInstallStage, string> {
  return new Map(stages.map(stage => [stage, `${stage} 完成`]))
}

describe('§11.14 安装七阶段证据', () => {
  it('七个阶段恒定出现且顺序固定，全部成功时回滚为 skipped', () => {
    const stages = buildInstallStages({
      succeeded: succeeded('authorization', 'precheck', 'download', 'verify', 'write', 'discovery'),
      failedStage: null,
      failedDetail: '',
      rollback: 'skipped',
      rollbackDetail: '',
    })

    expect(stages.map(item => item.stage)).toEqual([...INSTALL_STAGES])
    expect(stages.map(item => item.outcome)).toEqual([
      'succeeded',
      'succeeded',
      'succeeded',
      'succeeded',
      'succeeded',
      'succeeded',
      'skipped',
    ])
    for (const item of stages) expect(item.detail.length).toBeGreaterThan(0)
  })

  it('某阶段失败时其后阶段一律 skipped，失败阶段携带证据', () => {
    const stages = buildInstallStages({
      succeeded: succeeded('authorization', 'precheck', 'download'),
      failedStage: 'verify',
      failedDetail: '制品摘要不匹配',
      rollback: 'succeeded',
      rollbackDetail: '已回滚本次写入',
    })
    const byStage = new Map(stages.map(item => [item.stage, item]))

    expect(byStage.get('authorization')?.outcome).toBe('succeeded')
    expect(byStage.get('download')?.outcome).toBe('succeeded')
    expect(byStage.get('verify')).toMatchObject({ outcome: 'failed', detail: '制品摘要不匹配' })
    // 失败之后的阶段不得呈现为成功，也不得被省略。
    for (const stage of ['write', 'discovery'] as const) {
      expect(byStage.get(stage)?.outcome).toBe('skipped')
      expect(byStage.get(stage)?.detail.length).toBeGreaterThan(0)
    }
    expect(byStage.get('rollback')).toMatchObject({ outcome: 'succeeded', detail: '已回滚本次写入' })
    expect(stages).toHaveLength(INSTALL_STAGES.length)
  })

  it('授权失败时不产生回滚：回滚保持 skipped 且仍给出说明', () => {
    const stages = buildInstallStages({
      succeeded: new Map(),
      failedStage: 'authorization',
      failedDetail: '该账号无权安装此版本',
      rollback: 'skipped',
      rollbackDetail: '',
    })
    const byStage = new Map(stages.map(item => [item.stage, item]))

    expect(byStage.get('authorization')?.outcome).toBe('failed')
    for (const stage of ['precheck', 'download', 'verify', 'write', 'discovery'] as const) {
      expect(byStage.get(stage)?.outcome).toBe('skipped')
    }
    expect(byStage.get('rollback')?.outcome).toBe('skipped')
    expect(byStage.get('rollback')?.detail.length).toBeGreaterThan(0)
  })

  it('回滚自身失败必须可表达', () => {
    const stages = buildInstallStages({
      succeeded: succeeded('authorization', 'precheck', 'download', 'verify', 'write'),
      failedStage: 'discovery',
      failedDetail: '运行时未发现安装结果',
      rollback: 'failed',
      rollbackDetail: '回滚未能恢复原始副本',
    })
    const rollback = stages.find(item => item.stage === 'rollback')
    expect(rollback).toMatchObject({ outcome: 'failed', detail: '回滚未能恢复原始副本' })
    expect(stages.find(item => item.stage === 'discovery')?.outcome).toBe('failed')
  })

  it('授权类错误码归 authorization 且不可重试', () => {
    for (const code of ['NOT_FOUND', 'RESOURCE_NOT_FOUND', 'SKILL_NOT_PROJECT_ASSET', 'INSTALL_AUTHORIZATION_REVOKED']) {
      const failure = classifyInstallFailure(code, 'download')
      expect(failure.stage).toBe('authorization')
      expect(failure.retryable.retryable).toBe(false)
      expect(failure.retryable.how.length).toBeGreaterThan(0)
    }
  })

  it('校验类错误码归 precheck 且不可重试', () => {
    for (const code of ['VALIDATION_ERROR', 'IDEMPOTENCY_CONFLICT', 'REVISION_CONFLICT']) {
      const failure = classifyInstallFailure(code, 'authorization')
      expect(failure.stage).toBe('precheck')
      expect(failure.retryable.retryable).toBe(false)
    }
  })

  it('依赖不可用归 precheck 但可重试', () => {
    const failure = classifyInstallFailure('UPSTREAM_UNAVAILABLE', 'authorization')
    expect(failure.stage).toBe('precheck')
    expect(failure.retryable.retryable).toBe(true)
  })

  it('下载失败归 download 可重试，制品校验失败归 verify 不可重试', () => {
    expect(classifyInstallFailure('NETWORK_ERROR', 'download')).toMatchObject({
      stage: 'download',
      retryable: { retryable: true },
    })
    expect(classifyInstallFailure('ARTIFACT_DIGEST_MISMATCH', 'verify')).toMatchObject({
      stage: 'verify',
      retryable: { retryable: false },
    })
  })

  it('映射表外的错误码不得被归入更早的阶段', () => {
    // 未知码只能落在失败当时正在执行的阶段，不得猜测为 authorization/precheck。
    expect(classifyInstallFailure('SOMETHING_NEW', 'write').stage).toBe('write')
    expect(classifyInstallFailure('SOMETHING_NEW', 'discovery').stage).toBe('discovery')
  })
})
