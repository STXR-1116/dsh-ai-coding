import { describe, expect, it } from 'vitest'
import { parseRun, parseStreamEvent } from '../src/workspace-http.ts'

// 蓝图阶段 0（0-5）：四张表锁定后的「实现与表一致」机械探针。
//
// 1) 运行状态迁移表（蓝图 §4.2 / API 需求）：既有 `AgentRunStatus` 的 9 个取值
//    是统一状态机的迁移源列——服务端词汇必须逐字接受；未识别状态必须显式映射
//    为 `unknown`（客户端映射），不得吞成 `running` 等默认值。
// 2) 事件字段映射表（蓝图 §7.2 / API 需求 §11.1）：事件帧字段集为
//    `event_id`/`event_type`/`occurred_at`/`revision`/`resource_type`（闭集）/
//    `resource_id`/`payload`；`revision` 是唯一新旧判据；补偿游标是服务端
//    `evt_opaque_id`——解析结果不得出现第二个可独立推进的 `sequence` 位置。
// 3) 错误 envelope（API 需求 §12）：错误数据必须为 null（客户端侧：错误解析
//    只接受 code/message，不消费 error data），由 fixture 探针逐状态码覆盖。

function runPayload(status: unknown): Record<string, unknown> {
  return {
    run_id: 'run-1',
    project_id: 'project-alpha',
    workspace_id: 'ws-1',
    session_id: 'sess-1',
    agent_profile_version_id: 'apv-1',
    asset_version_ids: ['skill:x@1.0.0'],
    execution_policy: { permission_mode: 'approval' },
    workspace_revision: 3,
    status,
    write_mode: 'read_only',
    lease_id: null,
    revision: 5,
    error_code: null,
    created_at: '2026-09-15T00:00:00Z',
    updated_at: '2026-09-15T00:01:00Z',
  }
}

describe('0-5 运行状态迁移表（§11.7 统一词表落地）', () => {
  // 统一词表（wire）：九个服务端状态逐字解析。
  const WIRE: ReadonlyArray<[string, string]> = [
    ['preparing', 'preparing'],
    ['awaiting_approval', 'awaiting_approval'],
    ['running', 'running'],
    ['paused', 'paused'],
    ['awaiting_user', 'awaiting_user'],
    ['succeeded', 'succeeded'],
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
    ['expired', 'expired'],
  ]

  for (const [wire, expected] of WIRE) {
    it(`统一状态 ${wire} 逐字解析为 ${expected}`, () => {
      const run = parseRun(runPayload(wire))
      expect(run.status).toBe(expected)
    })
  }

  it('旧词表值从 wire 移除：显式映射为 unknown，不得映射为任何活跃状态', () => {
    expect(parseRun(runPayload('queued')).status).toBe('unknown')
    expect(parseRun(runPayload('starting')).status).toBe('unknown')
    expect(parseRun(runPayload('waiting_approval')).status).toBe('unknown')
    expect(parseRun(runPayload('canceled')).status).toBe('unknown')
  })

  it('未识别状态显式呈现为 unknown，不得吞成 running 等默认值', () => {
    expect(parseRun(runPayload('draft')).status).toBe('unknown')
    expect(parseRun(runPayload(42)).status).toBe('unknown')
  })

  it('draft 不是运行状态：归 Plan（§11.6），作为运行状态时显式 unknown', () => {
    expect(parseRun(runPayload('draft')).status).toBe('unknown')
  })
})

function eventPayload(resourceType: unknown): Record<string, unknown> {
  return {
    event_id: 'evt-1',
    event_type: 'workspace.updated',
    occurred_at: '2026-09-15T00:00:00Z',
    revision: 7,
    resource_type: resourceType,
    resource_id: 'ws-1',
    payload: { note: 'fixture' },
  }
}

describe('0-5 事件字段映射表（闭集 resource_type、revision 唯一新旧判据、单一补偿游标）', () => {
  const CLOSED_RESOURCE_TYPES = ['workspace', 'run', 'file', 'changes', 'agent_profile', 'stream'] as const

  for (const resourceType of CLOSED_RESOURCE_TYPES) {
    it(`resource_type ${resourceType} 在闭集内逐字解析`, () => {
      const event = parseStreamEvent(eventPayload(resourceType))
      expect(event.resourceType).toBe(resourceType)
    })
  }

  it('闭集之外不得放宽：未知 resource_type 显式映射为 unknown', () => {
    expect(parseStreamEvent(eventPayload('telemetry')).resourceType).toBe('unknown')
    expect(parseStreamEvent(eventPayload('approval')).resourceType).toBe('unknown')
  })

  it('revision 逐字保留（唯一新旧判据），0 是合法值', () => {
    expect(parseStreamEvent(eventPayload('workspace')).revision).toBe(7)
    const zero = parseStreamEvent({ ...eventPayload('workspace'), revision: 0 })
    expect(zero.revision).toBe(0)
  })

  it('解析结果不含 sequence：补偿位置只有服务端签发的 evt_opaque_id 一个', () => {
    const event = parseStreamEvent({ ...eventPayload('workspace'), sequence: 99 })
    expect(Object.hasOwn(event, 'sequence')).toBe(false)
    expect(Object.hasOwn(event, 'evtOpaqueId')).toBe(false)
  })

  it('字段集之外的多余字段不进入解析结果（增量字段必须先改契约再实现）', () => {
    const event = parseStreamEvent({ ...eventPayload('workspace'), operator: 'someone', trace_id: 't-1' })
    expect(Object.keys(event).sort()).toEqual([
      'eventId',
      'eventType',
      'occurredAt',
      'payload',
      'resourceId',
      'resourceType',
      'revision',
    ])
  })
})
