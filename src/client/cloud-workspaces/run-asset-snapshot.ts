/**
 * 运行资产版本快照的客户端纯模型（蓝图 §4.5，§11.18 A）。
 *
 * 这套模型的全部意义在于**不让两套状态互相冒充**：`readinessAtBinding` 是绑定
 * 那一刻的事实，`currentState` 是读取那一刻的事实。撤回资产版本之后，两者会不同，
 * 而「不同」本身就是要展示的信息——用户要看到「绑定时可用、之后被撤回，本次运行
 * 不受影响」，而不是一个被当前状态改写过的、看起来从未就绪过的账。
 */
import type { RunAssetSnapshot, RunAssetSnapshotEntry } from '../../types.ts'

/** 绑定时刻就绪度的中文标签；词表外原样透出。 */
export const BINDING_READINESS_LABELS: Record<string, string> = {
  ready: '绑定时就绪',
  unavailable: '绑定时不可用',
}

/** 读取时刻资产状态的中文标签；词表外原样透出。 */
export const ASSET_CURRENT_STATE_LABELS: Record<string, string> = {
  bound: '当前可用',
  withdrawn: '当前已撤回',
  missing: '当前不在服务目录',
}

/** 运行绑定资产的一行展示。 */
export interface RunAssetRow {
  readonly assetVersionId: string
  readonly name: string
  readonly requiredLabel: '必需' | '可选'
  readonly bindingLabel: string
  readonly currentLabel: string
  /** 绑定之后发生变化时给出后果说明；未变化为 undefined。 */
  readonly driftLabel?: string
}

/**
 * 一条资产在绑定之后是否发生了变化（撤回或从目录中消失）。
 * @param entry - 快照条目。
 * @returns 变化说明；未变化为 undefined。
 */
export function assetDriftLabel(entry: RunAssetSnapshotEntry): string | undefined {
  if (entry.readinessAtBinding === 'ready' && entry.currentState === 'withdrawn') {
    return '绑定时可用，之后被撤回：本运行不受影响'
  }
  if (entry.readinessAtBinding === 'ready' && entry.currentState === 'missing') {
    return '绑定时可用，之后不在服务目录中：本运行不受影响'
  }
  if (entry.readinessAtBinding === 'unavailable' && entry.required) {
    // 必需资产在绑定时就不可用意味着这次运行本不该启动；如实指出，不粉饰成正常。
    return '绑定时即不可用（必需资产）：本次运行不应启动，请核对服务端记录'
  }
  if (entry.readinessAtBinding === 'unavailable') {
    return `绑定时即不可用（可选资产，不阻断运行）：${entry.unavailableReasonAtBinding ?? '服务未提供原因'}`
  }
  return undefined
}

/**
 * 把快照映射成可渲染的行，顺序照抄服务端（order 是服务端的判断）。
 * @param snapshot - 运行资产快照。
 * @returns 资产行。
 */
export function runAssetRows(snapshot: RunAssetSnapshot): readonly RunAssetRow[] {
  return snapshot.assets.map((entry) => {
    const drift = assetDriftLabel(entry)
    return {
      assetVersionId: entry.assetVersionId,
      name: entry.name,
      requiredLabel: entry.required ? '必需' : '可选',
      bindingLabel: BINDING_READINESS_LABELS[entry.readinessAtBinding] ?? `绑定时：${entry.readinessAtBinding}`,
      currentLabel: ASSET_CURRENT_STATE_LABELS[entry.currentState] ?? `当前：${entry.currentState}`,
      ...(drift === undefined ? {} : { driftLabel: drift }),
    }
  })
}

/**
 * 快照里是否存在「绑定之后发生变化」的资产：这是需要用户注意的信号，
 * 而不是一个可以并进常规渲染的细节。
 * @param snapshot - 运行资产快照。
 * @returns 存在变化为 true。
 */
export function runAssetSnapshotDrifted(snapshot: RunAssetSnapshot): boolean {
  return snapshot.assets.some(entry => assetDriftLabel(entry) !== undefined)
}

/**
 * 治理审计行的一行展示（跨模块审计：从运行追到资产治理）。
 * @param entry - 治理条目。
 * @returns 展示文本。
 */
export function assetGovernanceLabel(entry: RunAssetSnapshot['governance'][number]): string {
  return `${entry.at} · ${entry.actorName} · ${entry.action} · ${entry.assetVersionId}`
}
