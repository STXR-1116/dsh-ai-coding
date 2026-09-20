/**
 * 可观测四层聚合与运营建议变更草案（蓝图 §6.8，4-8）。
 *
 * 四层：运行健康、交付质量、资产质量、权限安全。每层从既有数据源聚合指标，
 * 不引入新的数据源。运营建议只生成证据充分的变更草案——不能自动修改生产
 * 配置，每条建议包含证据窗口、置信度、影响范围、关联运行、建议动作和撤销
 * 方式，应用建议仍需审批。
 */

/** 一层的健康状态。 */
export type LayerStatus = 'healthy' | 'degraded' | 'critical'

/** 单层可观测指标。 */
export interface ObservabilityLayer {
  readonly layer: string
  readonly status: LayerStatus
  readonly metrics: readonly { readonly label: string; readonly value: number; readonly unit: string }[]
  readonly issues: readonly string[]
}

/** 四层聚合输入。 */
export interface ObservabilityInput {
  readonly runs: readonly { readonly status: string }[]
  readonly telemetryDelivery: { readonly accepted: number; readonly retryable: number; readonly rejected: number; readonly gaps: number }
  readonly assetHealth: readonly { readonly assetType: string; readonly healthy: boolean; readonly reason: string | null }[]
  readonly authorizationDenied: number
}

/**
 * 聚合四层可观测指标。
 * @param input - 各数据源的只读聚合。
 * @returns 四层指标列表（固定顺序）。
 */
export function buildObservabilityLayers(input: ObservabilityInput): readonly ObservabilityLayer[] {
  const total = input.runs.length
  const failed = input.runs.filter(r => r.status === 'failed').length
  const runHealth: LayerStatus = total === 0 ? 'healthy' : failed / total > 0.3 ? 'critical' : failed > 0 ? 'degraded' : 'healthy'

  const delivery = input.telemetryDelivery
  const deliveryTotal = delivery.accepted + delivery.retryable + delivery.rejected
  const deliveryStatus: LayerStatus = delivery.gaps > 0 || delivery.rejected > 0 ? 'critical' : delivery.retryable > 0 ? 'degraded' : 'healthy'

  const unhealthyAssets = input.assetHealth.filter(a => !a.healthy)
  const assetStatus: LayerStatus = unhealthyAssets.length === 0 ? 'healthy' : unhealthyAssets.length > input.assetHealth.length / 2 ? 'critical' : 'degraded'

  const permStatus: LayerStatus = input.authorizationDenied > 5 ? 'critical' : input.authorizationDenied > 0 ? 'degraded' : 'healthy'

  return [
    {
      layer: '运行健康',
      status: runHealth,
      metrics: [
        { label: '总运行', value: total, unit: '个' },
        { label: '失败', value: failed, unit: '个' },
      ],
      issues: failed > 0 ? [`${failed} 个运行失败`] : [],
    },
    {
      layer: '交付质量',
      status: deliveryStatus,
      metrics: [
        { label: '已接受', value: delivery.accepted, unit: '条' },
        { label: '可重试', value: delivery.retryable, unit: '条' },
        { label: '已拒绝', value: delivery.rejected, unit: '条' },
        { label: '缺口', value: delivery.gaps, unit: '个' },
      ],
      issues: delivery.gaps > 0 ? [`${delivery.gaps} 个交付缺口`] : [],
    },
    {
      layer: '资产质量',
      status: assetStatus,
      metrics: [
        { label: '总资产', value: input.assetHealth.length, unit: '项' },
        { label: '不健康', value: unhealthyAssets.length, unit: '项' },
      ],
      issues: unhealthyAssets.map(a => `${a.assetType}:${a.reason ?? '未知原因'}`),
    },
    {
      layer: '权限安全',
      status: permStatus,
      metrics: [{ label: '授权拒绝', value: input.authorizationDenied, unit: '次' }],
      issues: input.authorizationDenied > 0 ? [`${input.authorizationDenied} 次授权拒绝`] : [],
    },
  ]
}

/** 运营建议变更草案。 */
export interface ChangeProposal {
  readonly proposalId: string
  readonly title: string
  readonly evidenceWindow: string
  readonly confidence: 'high' | 'medium' | 'low'
  readonly impactScope: string
  readonly relatedRunIds: readonly string[]
  readonly suggestedAction: string
  readonly undoMethod: string
  /** 变更草案：应用前需要审批。 */
  readonly requiresApproval: true
}

/**
 * 从四层指标生成变更草案。
 * @param layers - 四层可观测指标。
 * @returns 需要审批的变更草案列表（无问题时为空数组）。
 */
export function generateChangeProposals(layers: readonly ObservabilityLayer[]): readonly ChangeProposal[] {
  const proposals: ChangeProposal[] = []
  for (const layer of layers) {
    if (layer.status === 'healthy') continue
    if (layer.layer === '运行健康' && layer.issues.length > 0) {
      proposals.push({
        proposalId: `proposal-run-health`,
        title: '运行健康需要关注',
        evidenceWindow: '最近 7 天',
        confidence: 'high',
        impactScope: '运行层面',
        relatedRunIds: [],
        suggestedAction: '检查失败运行的错误码和审计记录，确认是否需要重试或取消。',
        undoMethod: '不适用：运行状态由服务端管理，无需撤销。',
        requiresApproval: true,
      })
    }
    if (layer.layer === '资产质量' && layer.issues.length > 0) {
      proposals.push({
        proposalId: `proposal-asset-quality`,
        title: '部分资产不健康',
        evidenceWindow: '当前状态',
        confidence: 'high',
        impactScope: '资产绑定',
        relatedRunIds: [],
        suggestedAction: '检查不健康资产的原因，确认是否需要替换版本或修复依赖。',
        undoMethod: '不适用：资产状态由治理流程管理。',
        requiresApproval: true,
      })
    }
  }
  return proposals
}
