import { describe, expect, it } from 'vitest'
import { buildPermissionChain, permissionResultFromApi, summarizeBatchGrant } from '../src/lib/permission-chain.ts'

// 4-3「账号与权限」模型层验收（蓝图 §6.3，§11.19）。
//
// 异常矩阵：
//   继承链 —— 五层固定顺序：组织角色 → 项目成员 → 资产绑定 → 临时授权 →
//             最终判定；临时授权层固定 BLOCKED（服务端契约未提供，不得用
//             「无记录」冒充）；被模拟用户在组织角色层明示。
//   判定   —— allowed → 最终判定「允许」；PROJECT_NOT_MEMBER → 项目成员层
//             「不满足」且最终判定「拒绝」。
//   批量   —— 受影响对象 = 每一行请求；失败行保留稳定码不合并；全成功时
//             failures 为空数组（真零，不是缺失）。
//   归一   —— api 失败结果归一为 denied 事实（code/message 保留）。

const allowedMember = {
  decision: 'allowed' as const,
  code: 'OK',
  reason: '授权通过',
  policyVersion: 'perm-policy@1',
  requestId: 'req-1',
  simulatedUser: { userId: 'u-member', displayName: '演示成员', role: 'member' },
  context: { project_id: 'project-alpha' },
}

describe('4-3 权限继承链', () => {
  it('五层固定顺序，临时授权层固定 BLOCKED，被模拟用户明示', () => {
    const chain = buildPermissionChain(allowedMember, '协作台前端')
    expect(chain.map(row => row.layer)).toEqual([
      '组织角色', '项目成员', '资产绑定', '临时授权', '最终判定',
    ])
    expect(chain[3]?.verdict).toBe('BLOCKED')
    expect(chain[3]?.detail).toContain('BLOCKED')
    expect(chain[0]?.detail).toContain('演示成员')
    expect(chain[4]?.verdict).toBe('允许')
  })

  it('PROJECT_NOT_MEMBER：项目成员层不满足，最终判定拒绝', () => {
    const chain = buildPermissionChain({
      decision: 'denied',
      code: 'PROJECT_NOT_MEMBER',
      reason: '该用户不是项目成员',
      policyVersion: 'perm-policy@1',
      requestId: 'req-2',
      simulatedUser: { userId: 'u-member', displayName: '演示成员', role: 'member' },
      context: {},
    }, '项目 Beta')
    expect(chain[1]?.verdict).toBe('不满足')
    expect(chain[1]?.detail).toContain('该用户不是项目成员')
    expect(chain[4]?.verdict).toBe('拒绝')
  })
})

describe('4-3 批量授权汇总', () => {
  it('受影响对象逐行保留，失败行携带稳定码不合并', () => {
    const summary = summarizeBatchGrant([
      { userId: 'u-1', ok: true, code: null },
      { userId: 'u-2', ok: false, code: 'REVISION_CONFLICT' },
      { userId: 'u-3', ok: true, code: null },
    ])
    expect(summary.affected).toBe(3)
    expect(summary.succeeded).toBe(2)
    expect(summary.failures.length).toBe(1)
    expect(summary.failures[0]?.userId).toBe('u-2')
    expect(summary.failures[0]?.code).toBe('REVISION_CONFLICT')
  })

  it('全成功：failures 是真零（空数组），不是缺失', () => {
    const summary = summarizeBatchGrant([{ userId: 'u-1', ok: true, code: null }])
    expect(summary.failures).toEqual([])
    expect(summary.succeeded).toBe(summary.affected)
  })
})

describe('4-3 api 结果归一', () => {
  it('非 2xx 归一为 denied 事实；2xx 保留 decision 与模拟用户', () => {
    const failure = permissionResultFromApi({ ok: false, error: { kind: 'service', code: 'HTTP_500', message: '下游失败' } })
    expect(failure?.decision).toBe('denied')
    expect(failure?.code).toBe('HTTP_500')
    const ok = permissionResultFromApi({ ok: true, value: { decision: 'allowed', code: 'OK', reason: '授权通过', policy_version: 'perm-policy@1', request_id: 'req-9', simulated_user: { user_id: 'u-1', display_name: '演示成员', role: 'member' } } })
    expect(ok?.decision).toBe('allowed')
    expect(ok?.simulatedUser?.userId).toBe('u-1')
  })
})
