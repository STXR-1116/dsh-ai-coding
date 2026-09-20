/**
 * 运行证据时间轴的纯模型（蓝图 §6.7，4-7）：把 §11.7 状态转移、§11.11 脉搏
 * 条目与文件变更合成一条有序证据时间轴，覆盖目标、计划、审批、上下文账本、
 * 模型请求摘要、工具调用、文件变更、测试、重连、恢复、最终结果。敏感内容
 * 默认脱敏——凭据引用与 token 字段以占位呈现。
 */
import type { CloudRun } from './team-skill-types'

/** 证据时间轴的一个条目。 */
export interface EvidenceTimelineEntry {
  readonly category: string
  readonly at: string
  readonly summary: string
  readonly detail: string
  readonly redacted: boolean
}

const TIMELINE_ORDER = [
  '目标', '计划', '审批', '上下文账本', '模型请求摘要',
  '工具调用', '文件变更', '测试', '重连', '恢复', '最终结果',
] as const

function timelineOrder(category: string): number {
  const idx = TIMELINE_ORDER.indexOf(category as (typeof TIMELINE_ORDER)[number])
  return idx === -1 ? TIMELINE_ORDER.length : idx
}

/** 从 CloudRun 的 timeline 与字段合成目标、审批、最终结果条目。 */
function runToEntries(run: CloudRun): EvidenceTimelineEntry[] {
  const entries: EvidenceTimelineEntry[] = []
  for (const entry of run.timeline ?? []) {
    entries.push({
      category: '审批',
      at: entry.at,
      summary: `${entry.status}：${entry.reason}`,
      detail: `操作者 ${entry.operator} · 策略 ${entry.policy_version} · rev ${entry.revision}`,
      redacted: false,
    })
  }
  if (run.error_code !== null && run.error_code !== undefined) {
    entries.push({
      category: '最终结果',
      at: run.updated_at,
      summary: `失败：${run.error_code}`,
      detail: `trace ${run.trace_id}`,
      redacted: false,
    })
  } else if (run.status === 'succeeded') {
    entries.push({
      category: '最终结果',
      at: run.updated_at,
      summary: '成功',
      detail: `trace ${run.trace_id}`,
      redacted: false,
    })
  }
  return entries
}

/** 脉搏条目到时间轴条目的映射。 */
function pulseToEntries(pulse: Record<string, unknown>): EvidenceTimelineEntry[] {
  const items = pulse['items']
  if (!Array.isArray(items)) return []
  return items.map((item): EvidenceTimelineEntry => {
    const record = item as Record<string, unknown>
    const kind = String(record['kind'] ?? '')
    const at = String(record['at'] ?? '')
    const summary = String(record['summary'] ?? '')
    if (kind === 'tool_call') {
      return {
        category: '工具调用',
        at,
        summary: `${record['tool'] ?? ''}：${record['call_id'] ?? ''}`,
        detail: String(record['result'] ?? ''),
        redacted: false,
      }
    }
    if (kind === 'approval') {
      return {
        category: '审批',
        at,
        summary: `${record['decision'] === 'approve' ? '批准' : '拒绝'}`,
        detail: `操作者 ${record['operator'] ?? ''}`,
        redacted: false,
      }
    }
    if (kind === 'test') {
      return {
        category: '测试',
        at,
        summary: `测试 ${record['passed']}/${record['total']} 通过`,
        detail: '',
        redacted: false,
      }
    }
    return {
      category: kind,
      at,
      summary,
      detail: '',
      redacted: false,
    }
  })
}

/** 文件变更到时间轴条目的映射。 */
function changesToEntries(changes: Record<string, unknown>): EvidenceTimelineEntry[] {
  const files = changes['files']
  if (!Array.isArray(files)) return []
  return files.map((file): EvidenceTimelineEntry => {
    const record = file as Record<string, unknown>
    const path = String(record['path'] ?? '')
    const change = String(record['change'] ?? 'modified')
    return {
      category: '文件变更',
      at: '',
      summary: `${change}：${path}`,
      detail: '',
      redacted: false,
    }
  })
}

const REDACT_PATTERNS = [/credential/i, /token/i, /secret/i, /password/i]

/** 对条目应用默认脱敏：凭据引用与敏感字段名匹配的行 detail 以占位呈现。 */
function redact(entries: readonly EvidenceTimelineEntry[]): readonly EvidenceTimelineEntry[] {
  return entries.map(entry => {
    const shouldRedact = REDACT_PATTERNS.some(pattern => pattern.test(entry.summary) || pattern.test(entry.detail))
    if (shouldRedact) {
      return { ...entry, detail: '（已脱敏）', redacted: true }
    }
    return entry
  })
}

/** 证据时间轴的输入。 */
export interface EvidenceTimelineInput {
  readonly run: CloudRun
  readonly pulse?: Record<string, unknown> | undefined
  readonly changes?: Record<string, unknown> | undefined
}

/**
 * 合成一条有序证据时间轴；默认脱敏敏感内容。
 * @param input - 运行快照、脉搏条目与文件变更。
 * @returns 时间轴条目（按 at 升序、类别固定优先级稳定排序）。
 */
export function buildEvidenceTimeline(input: EvidenceTimelineInput): readonly EvidenceTimelineEntry[] {
  const raw = [
    ...runToEntries(input.run),
    ...pulseToEntries(input.pulse ?? {}),
    ...changesToEntries(input.changes ?? {}),
  ]
  const redacted = redact(raw)
  return [...redacted].sort((left, right) => {
    const byAt = left.at.localeCompare(right.at)
    if (byAt !== 0) return byAt
    return timelineOrder(left.category) - timelineOrder(right.category)
  })
}
