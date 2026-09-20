/**
 * 云工作空间后台的「服务端声明能力状态」。
 *
 * 后台不允许用 `?? []` / `?? null` 把缺省值当成功；每个功能的状态只能由
 * 服务端响应里的证据推导：
 *  - 响应头 `x-fixture-only: true` → `fixture-only`
 *  - 服务端声明生产能力未提供（`NOT_IMPLEMENTED` 等）→ `not-ready`
 *  - 服务不可用（网络错误 / 下游 5xx / 业务失败）→ `failed`
 *  - 协议错误（非统一 envelope、缺必需字段）→ `blocked`
 * 只有既没有 fixture 头、也没有任何失败信号时才可能是 `ready`。
 */
import type { CloudApiResult } from './team-skill-api.ts'

/** 每个后台功能都会显示的服务端声明状态。 */
export type CloudCapabilityStatus = 'ready' | 'fixture-only' | 'not-ready' | 'failed' | 'blocked'

/** 云工作空间后台功能标识。 */
export type CloudFunctionId =
  | 'agent-types'
  | 'agent-profiles'
  | 'workspaces'
  | 'workspace-detail'
  | 'runs'
  | 'audits'

/** 状态文字：失败类状态不得伪装成成功。 */
export const CLOUD_CAPABILITY_TEXT: Record<CloudCapabilityStatus, string> = {
  ready: 'ready',
  'fixture-only': 'fixture-only',
  'not-ready': 'not-ready',
  failed: '失败',
  blocked: 'BLOCKED',
}

/** 功能显示名。 */
export const CLOUD_FUNCTION_LABEL: Record<CloudFunctionId, string> = {
  'agent-types': 'Agent 类型',
  'agent-profiles': 'Agent 配置',
  workspaces: 'Workspace 运维',
  'workspace-detail': 'Workspace 详情',
  runs: 'Agent Run 检索',
  audits: '统一审计',
}

/** 服务端显式声明「生产能力未提供 / 未就绪」的业务码。 */
const PRODUCTION_NOT_PROVIDED_CODES: ReadonlySet<string> = new Set([
  'NOT_IMPLEMENTED',
  'NOT_READY',
  'PRODUCTION_NOT_PROVIDED',
  'PRODUCTION_NOT_IMPLEMENTED',
  'CAPABILITY_NOT_READY',
  'SERVICE_NOT_READY',
])

export interface CloudCapability {
  readonly fn: CloudFunctionId
  readonly label: string
  readonly status: CloudCapabilityStatus
  readonly text: string
  /** 服务端声明原文；测试与人工复核都能从这里追溯到证据。 */
  readonly detail: string
  /** 服务端返回了 0 条记录：显式标记，避免空数据被读成成功。 */
  readonly empty: boolean
}

function describe(text: string, evidence: { readonly requestId: string | null; readonly status: number }): string {
  return `${text}（request_id ${evidence.requestId ?? '—'} · HTTP ${String(evidence.status)}）`
}

/**
 * 由服务端响应证据推导能力状态。`itemCount` 是该功能的记录条数，
 * 为 0 时只做显式标记，绝不把「空」当成非成功以外的含义。
 */
export function capabilityFromResult(
  fn: CloudFunctionId,
  result: CloudApiResult<unknown>,
  itemCount?: number,
): CloudCapability {
  const label = CLOUD_FUNCTION_LABEL[fn]
  const empty = itemCount === 0
  const emptySuffix = empty ? '（服务端返回 0 条记录，空集合不视为成功）' : ''
  if (result.ok) {
    const base = { fn, label, empty }
    if (result.evidence.fixtureOnly)
      return {
        ...base,
        status: 'fixture-only',
        text: CLOUD_CAPABILITY_TEXT['fixture-only'],
        detail: describe('服务端声明响应头 x-fixture-only: true，是本地 fixture 而非生产能力', result.evidence) + emptySuffix,
      }
    return {
      ...base,
      status: 'ready',
      text: CLOUD_CAPABILITY_TEXT.ready,
      detail: describe('服务端声明生产响应', result.evidence) + emptySuffix,
    }
  }
  const error = result.error
  const base = { fn, label, empty: false }
  if (error.kind === 'not-ready')
    return {
      ...base,
      status: 'not-ready',
      text: CLOUD_CAPABILITY_TEXT['not-ready'],
      detail: `服务端声明未就绪：缺少 ${error.missing.join('、')}`,
    }
  if (error.kind === 'unavailable')
    return {
      ...base,
      status: 'failed',
      text: CLOUD_CAPABILITY_TEXT.failed,
      detail: describe(`服务不可用：${error.code} ${error.message}`, result.evidence),
    }
  if (error.kind === 'service' && PRODUCTION_NOT_PROVIDED_CODES.has(error.code))
    return {
      ...base,
      status: 'not-ready',
      text: CLOUD_CAPABILITY_TEXT['not-ready'],
      detail: describe(`服务端声明生产能力未提供：${error.code} ${error.message}`, result.evidence),
    }
  if (error.kind === 'service' && error.code === 'INVALID_RESPONSE')
    return {
      ...base,
      status: 'blocked',
      text: CLOUD_CAPABILITY_TEXT.blocked,
      detail: `协议错误：${error.message}`,
    }
  if (error.kind === 'unauthorized' || error.kind === 'forbidden')
    return {
      ...base,
      status: 'blocked',
      text: CLOUD_CAPABILITY_TEXT.blocked,
      detail: describe(`服务端拒绝访问：${error.code} ${error.message}`, result.evidence),
    }
  return {
    ...base,
    status: 'failed',
    text: CLOUD_CAPABILITY_TEXT.failed,
    detail: describe(`服务端返回业务失败：${error.code} ${error.message}`, result.evidence),
  }
}
