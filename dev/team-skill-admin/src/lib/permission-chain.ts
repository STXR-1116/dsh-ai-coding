/**
 * 权限继承链与权限模拟器的客户端纯模型（蓝图 §6.3 账号与权限，§11.19）。
 *
 * 继承链按固定五层顺序组装：组织角色 → 项目成员 → 资产绑定 → 临时授权 →
 * 最终判定。临时授权层服务端契约未提供，固定呈现为 BLOCKED——不得用
 * 「无记录」或空行冒充该层。批量授权的汇总是纯计数：每个受影响对象一行，
 * 失败行保留稳定码，成功与失败都不合并。
 */
import type { ApiResult } from './team-skill-api'

/** 一次权限模拟的判定（§11.9/§11.19 wire 形状，camelCase 由调用方映射）。 */
export interface PermissionSimulateResult {
  readonly decision: 'allowed' | 'denied'
  readonly code: string
  readonly reason: string
  readonly policyVersion: string
  readonly requestId: string
  /** 被模拟用户（§11.19）；未模拟时为 undefined。 */
  readonly simulatedUser?: { readonly userId: string; readonly displayName: string; readonly role: string }
  readonly context: Readonly<Record<string, unknown>>
}

/** 继承链的一层。 */
export interface PermissionChainRow {
  readonly layer: string
  readonly verdict: string
  readonly detail: string
}

/** 批量授权的单行结果。 */
export interface BatchGrantRow {
  readonly userId: string
  readonly ok: boolean
  readonly code: string | null
}

/** 批量授权汇总：受影响对象数、成功数与失败行（不合并、不省略）。 */
export interface BatchGrantSummary {
  readonly affected: number
  readonly succeeded: number
  readonly failures: readonly BatchGrantRow[]
}

const ROLE_LABEL: Record<string, string> = {
  admin: '平台管理员',
  manager: '组织经理',
  member: '成员',
}

/**
 * 组装权限继承链（§11.19）：五层固定顺序，临时授权层固定 BLOCKED。
 * @param result - 服务端模拟判定。
 * @param projectName - 目标项目名（展示用；判定事实以 code/reason 为准）。
 * @returns 按层序排列的继承链。
 */
export function buildPermissionChain(result: PermissionSimulateResult, projectName: string): readonly PermissionChainRow[] {
  const allowed = result.decision === 'allowed'
  const roleLabel = ROLE_LABEL[result.simulatedUser?.role ?? ''] ?? '未知角色'
  return [
    {
      layer: '组织角色',
      verdict: allowed || result.code !== 'ROLE_FORBIDDEN' ? '满足' : '不满足',
      detail: result.simulatedUser === undefined
        ? `${roleLabel}（当前登录身份）`
        : `${roleLabel}（被模拟用户 ${result.simulatedUser.displayName}）`,
    },
    {
      layer: '项目成员',
      verdict: allowed || result.code !== 'PROJECT_NOT_MEMBER' ? '满足' : '不满足',
      detail: allowed || result.code !== 'PROJECT_NOT_MEMBER' ? `已是 ${projectName} 的项目成员` : result.reason,
    },
    {
      layer: '资产绑定',
      verdict: '满足',
      detail: result.context['agent_profile_version_id'] === undefined
        ? '未涉及 Agent 资产维度'
        : `Agent 版本 ${String(result.context['agent_profile_version_id'])} 在绑定范围内`,
    },
    {
      layer: '临时授权',
      verdict: 'BLOCKED',
      detail: '服务端契约未提供（BLOCKED）：临时授权层无事实可呈现',
    },
    {
      layer: '最终判定',
      verdict: allowed ? '允许' : '拒绝',
      detail: `${result.code} · ${result.reason} · ${result.policyVersion} · request ${result.requestId}`,
    },
  ]
}

/**
 * 汇总批量授权结果：受影响对象 = 请求的每一行；失败行保留原稳定码。
 * @param rows - 逐行执行结果。
 * @returns 汇总（affected = rows.length，不丢行）。
 */
export function summarizeBatchGrant(rows: readonly BatchGrantRow[]): BatchGrantSummary {
  return {
    affected: rows.length,
    succeeded: rows.filter(row => row.ok).length,
    failures: rows.filter(row => !row.ok),
  }
}

/** 把 admin api 的 permission-check 结果映射为模型判定（非 2xx 也归一为拒绝事实）。 */
export function permissionResultFromApi(result: ApiResult<Record<string, unknown>>): PermissionSimulateResult | undefined {
  if (!result.ok) {
    const error = result.error
    return {
      decision: 'denied',
      code: error.kind === 'not-ready' ? 'SERVICE_NOT_READY' : error.code,
      reason: error.kind === 'not-ready' ? `服务尚未配置：缺少 ${error.missing.join('、')}` : error.message,
      policyVersion: 'perm-policy@1',
      requestId: '',
      context: {},
    }
  }
  const value = result.value
  if (value['decision'] !== 'allowed' && value['decision'] !== 'denied') return undefined
  const simulatedUser = value['simulated_user'] as { user_id?: unknown; display_name?: unknown; role?: unknown } | undefined
  return {
    decision: value['decision'],
    code: String(value['code'] ?? ''),
    reason: String(value['reason'] ?? ''),
    policyVersion: String(value['policy_version'] ?? ''),
    requestId: String(value['request_id'] ?? ''),
    ...(simulatedUser !== undefined && typeof simulatedUser.user_id === 'string'
      ? { simulatedUser: { userId: simulatedUser.user_id, displayName: String(simulatedUser.display_name ?? ''), role: String(simulatedUser.role ?? '') } }
      : {}),
    context: (value['context'] ?? {}) as Readonly<Record<string, unknown>>,
  }
}
