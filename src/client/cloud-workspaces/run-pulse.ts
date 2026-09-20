/**
 * 运行脉搏时间线的客户端合成（蓝图 §2-5，§11.11）：服务端脉搏条目与客户端
 * 观测的事件流重联合并为一条按时间排序的时间线。未知 kind 显式呈现为
 * unknown——不丢弃、不改写；渲染条目有上限，超出部分按需加载（低性能降级）。
 */
import type { RunPulseEntry } from '../../types.ts'

/** 客户端观测的一次事件流重连。 */
export interface PulseReconnect {
  readonly at: string
  readonly attempt: number
}

/** 合成后的脉搏条目：统一呈现形状，checkpoint 条目携带「当时视图」打开目标。 */
export interface RunPulseItem {
  readonly kind: 'status' | 'approval' | 'tool_call' | 'test' | 'checkpoint' | 'reconnect' | 'unknown'
  readonly at: string
  readonly revision: number | undefined
  readonly summary: string
  /** kind 专属呈现文本（测试计数、工具与结果、操作者等）；由条目数据派生。 */
  readonly detail: string
  readonly checkpointId: string | undefined
  readonly consumed: boolean | undefined
}

/** 低性能降级：单次渲染条目上限，其余按需加载。 */
export const RUN_PULSE_RENDER_LIMIT = 50

function entryItem(entry: RunPulseEntry): RunPulseItem {
  const record = entry as Readonly<Record<string, unknown>>
  const base = { at: entry.at, revision: entry.revision, summary: entry.summary }
  switch (entry.kind) {
    case 'status':
      return { kind: 'status', ...base, detail: entry.operator, checkpointId: undefined, consumed: undefined }
    case 'approval':
      return { kind: 'approval', ...base, detail: entry.operator, checkpointId: undefined, consumed: undefined }
    case 'tool_call':
      return { kind: 'tool_call', ...base, detail: `${entry.tool} · ${entry.result}`, checkpointId: undefined, consumed: undefined }
    case 'test':
      return { kind: 'test', ...base, detail: `${entry.passed}/${entry.total} 通过${entry.failed > 0 ? `，失败 ${entry.failed}` : ''}`, checkpointId: undefined, consumed: undefined }
    case 'checkpoint':
      return { kind: 'checkpoint', ...base, detail: '', checkpointId: entry.checkpointId, consumed: entry.consumed }
    default:
      // 未知条目显式呈现：summary 保留原始值，不推断语义。
      return {
        kind: 'unknown',
        at: typeof record['at'] === 'string' ? record['at'] : '',
        revision: typeof record['revision'] === 'number' ? record['revision'] : undefined,
        summary: typeof record['summary'] === 'string' ? record['summary'] : '',
        detail: '',
        checkpointId: undefined,
        consumed: undefined,
      }
  }
}

/**
 * 合并服务端脉搏条目与客户端重连观测，按 `at` 升序稳定排序并施加渲染上限。
 * @param input - 服务端条目与客户端重连观测。
 * @returns 渲染条目与未渲染计数。
 */
export function buildRunPulse(input: {
  readonly entries: readonly RunPulseEntry[]
  readonly reconnects: readonly PulseReconnect[]
}): { readonly items: readonly RunPulseItem[]; readonly hiddenCount: number } {
  const merged: Array<RunPulseItem & { readonly sortKey: string }> = [
    ...input.entries.map(entry => ({ ...entryItem(entry), sortKey: entry.at })),
    ...input.reconnects.map(reconnect => ({
      kind: 'reconnect' as const,
      at: reconnect.at,
      revision: undefined,
      summary: `事件流重连（第 ${reconnect.attempt} 次）`,
      detail: '',
      checkpointId: undefined,
      consumed: undefined,
      sortKey: reconnect.at,
    })),
  ]
  merged.sort((left, right) => left.sortKey.localeCompare(right.sortKey))
  const rendered = merged.slice(0, RUN_PULSE_RENDER_LIMIT).map(({ sortKey: _sortKey, ...item }) => item)
  return { items: rendered, hiddenCount: Math.max(0, merged.length - RUN_PULSE_RENDER_LIMIT) }
}
