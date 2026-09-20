/* oxlint-disable typescript/no-base-to-string -- Fetch stubs stringify RequestInfo wire values. */
/* TeamSkillHttpClient 的可选参数、信封与错误处理（覆盖专项：http 批）。
 *
 * host 调用这个客户端时几乎不带可选参数、也不传 AbortSignal，于是「带了」的那一支
 * 从未执行；同样，成功路径的信封/错误体形状此前只有合法样本。本规格直接驱动客户端
 * （注入 fetch），把可选参数、signal 透传、非 JSON 响应体、畸形信封与闭集词表
 * 各自的正反两面都跑一遍。
 *
 * 分类：FIXTURE-ONLY（注入 fetch，不开真实连接）。
 */
import { describe, expect, it } from 'vitest'
import { TeamSkillHttpClient } from '../src/http.ts'

interface Call {
  readonly url: string
  readonly method: string
  readonly body: unknown
  readonly signal: AbortSignal | null | undefined
}

/** A client whose fetch answers from a script and records every request. */
function scriptedClient(respond: (call: Call) => { readonly status: number; readonly text: string }): {
  readonly client: TeamSkillHttpClient
  readonly calls: Call[]
} {
  const calls: Call[] = []
  const client = new TeamSkillHttpClient({
    apiBaseUrl: 'https://service.test/v1',
    accessToken: 'token-1',
    fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const call: Call = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        signal: init?.signal,
      }
      calls.push(call)
      const outcome = respond(call)
      return new Response(outcome.text, { status: outcome.status, headers: { 'content-type': 'application/json' } })
    },
  })
  return { client, calls }
}

/** A successful envelope around one payload. */
function ok(data: unknown): { readonly status: number; readonly text: string } {
  return { status: 200, text: JSON.stringify({ code: 0, message: 'ok', request_id: 'req-1', data }) }
}

const MEMORY = {
  memory_id: 'memory-1',
  team_id: 'team-1',
  project_id: 'project-alpha',
  content: '联调约定：提交前先跑门禁',
  layer: 'L1',
  source_kind: 'agent_turn',
  tier: 'team',
  source_event_id: 'evt-1',
  expires_at: null,
  scope: 'shared',
  captured_by_user_id: 'member-1',
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
  revision: 3,
  status: 'ACTIVE',
  importance: 0.5,
  recall_count: 2,
  last_recalled_at: null,
}

describe('TeamSkillHttpClient 可选参数', () => {
  it('carries the optional search arguments and the abort signal into the request', async () => {
    const { client, calls } = scriptedClient(() => ok({ knowledge_bases: [], results: [] }))
    const controller = new AbortController()
    await client.knowledgeSearch({
      projectId: 'project-alpha', query: '发布', knowledgeBaseIds: ['k-1'], topK: 7, traceId: 'trace-1',
    }, controller.signal)

    expect(calls[0]?.body).toEqual({
      query: '发布', knowledge_base_ids: ['k-1'], top_k: 7, trace_id: 'trace-1',
    })
    expect(calls[0]?.signal).toBe(controller.signal)
  })

  it('carries the recall signal, the capture task id and the list filters', async () => {
    const { client, calls } = scriptedClient((call) => {
      if (call.url.includes('/recall')) {
        return ok({ status: 'READY', items: [], context_text: '', strategy: 'server', effective_policy: { top_k: 5, relevance_threshold: 0.5, token_budget: 1000 } })
      }
      if (call.url.includes('/capture')) return ok({ status: 'PENDING', event_id: 'evt-mut', job_id: 'job-1' })
      return ok({ items: [], next_cursor: null, total_estimate: 0 })
    })

    const controller = new AbortController()
    await client.memoryRecall({ projectId: 'project-alpha', query: '发布' }, controller.signal)
    expect(calls[0]?.signal).toBe(controller.signal)

    await client.memoryCapture({
      projectId: 'project-alpha', sessionId: 'sess-1', taskId: 'task-9', messages: [{ role: 'user', content: '捕获' }],
    }, 'key-capture')
    expect(calls[1]?.body).toMatchObject({ task_id: 'task-9' })

    await client.memoryList({ projectId: 'project-alpha', keyword: '约定', cursor: 'cursor-2', limit: 20 })
    expect(calls[2]?.body).toMatchObject({ keyword: '约定', cursor: 'cursor-2', limit: 20 })
  })

  it('omits the project filter entirely when the caller has none', async () => {
    const { client, calls } = scriptedClient(() => ok({ items: [] }))
    await client.memoryJobs()
    await client.memoryAudit()
    expect(calls[0]?.body).toEqual({})
    expect(calls[1]?.body).toEqual({})
  })

  it('parses one memory from the detail, confirm and audit seams', async () => {
    const { client } = scriptedClient((call) => {
      if (call.url.includes('/candidates/')) return ok({ memory: MEMORY })
      if (call.url.includes('/audit')) {
        return ok({
          items: [{
            audit_id: 'audit-1', operation: 'memory.confirm', operated_by_user_id: 'member-1', role: 'member',
            memory_id: null, project_id: 'project-alpha', result: 'succeeded', event_id: 'evt-1',
          }],
        })
      }
      return ok(MEMORY)
    })

    expect((await client.memoryGet('memory-1')).memoryId).toBe('memory-1')
    expect((await client.memoryCandidatesConfirm({ memoryId: 'memory-1', expectedRevision: 3 }, 'key-confirm')).memoryId).toBe('memory-1')
    const audit = await client.memoryAudit('project-alpha')
    expect(audit[0]).toMatchObject({ auditId: 'audit-1', role: 'member', memoryId: null })
  })

  it('answers an empty release-status request without calling the service', async () => {
    const { client, calls } = scriptedClient(() => ok({ items: [] }))
    expect(await client.releaseStatus([])).toEqual([])
    expect(calls).toEqual([])

    const { client: withItems, calls: itemCalls } = scriptedClient(() => ok({
      items: [{ skill_id: 'skill-1', version: '1.0.0', project_id: 'project-alpha', status: 'published' }],
    }))
    expect(await withItems.releaseStatus([{ skillId: 'skill-1', version: '1.0.0', projectId: 'project-alpha' }]))
      .toMatchObject([{ skillId: 'skill-1', status: 'published' }])
    expect(itemCalls[0]?.body).toMatchObject({ items: [{ skill_id: 'skill-1', version: '1.0.0', project_id: 'project-alpha' }] })

    // 闭集外的发布状态是协议漂移，不是「未知状态」。
    const { client: invalid } = scriptedClient(() => ok({
      items: [{ skill_id: 'skill-1', version: '1.0.0', project_id: 'project-alpha', status: 'gone' }],
    }))
    await expect(invalid.releaseStatus([{ skillId: 'skill-1', version: '1.0.0', projectId: 'project-alpha' }]))
      .rejects.toThrow(/invalid release status/u)
  })
})

describe('TeamSkillHttpClient 遥测批次', () => {
  it('serializes every optional event member and reads each acknowledgement status', async () => {
    const bodies: unknown[] = []
    const client = new TeamSkillHttpClient({
      apiBaseUrl: 'https://service.test/v1',
      accessToken: 'token-1',
      fetch: async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        bodies.push(typeof init?.body === 'string' ? JSON.parse(init.body) : undefined)
        return new Response(JSON.stringify({
          code: 0,
          message: 'ok',
          request_id: 'req-1',
          data: {
            batch_id: 'batch-1',
            server_received_at: '2026-09-01T00:00:00.000Z',
            server_checkpoint: 'checkpoint-1',
            results: [
              { event_id: 'e1', status: 'accepted' },
              { event_id: 'e2', status: 'duplicate' },
              { event_id: 'e3', status: 'retryable', retry_after_seconds: 5, reason: 'busy' },
              { event_id: 'e4', status: 'rejected', reason: 'bad' },
            ],
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })

    // 事件字面量填满全部可选成员；断言落在序列化后的线上字段名上，因此这里只做一次
    // 收窄转换（可选成员的联合类型在字面量里无法逐个表达）。
    const event = {
      schemaVersion: 1 as const,
      eventId: 'e1',
      installationId: 'install-1',
      projectId: 'project-alpha',
      sessionId: 'sess-1',
      kind: 'tool.call' as const,
      occurredAt: '2026-09-01T00:00:00.000Z',
      sourceType: 'agent' as const,
      sourceSeq: 3,
      turn: 2,
      step: 4,
      durationMs: 120,
      outcome: 'succeeded' as const,
      provider: 'deepseek',
      model: 'deepseek-v3.2',
      toolName: 'bash',
      toolCategory: 'terminal' as const,
      callId: 'call-1',
      approvalId: 'approval-1',
      compactionId: 'compact-1',
      retryable: true,
      retryCount: 1,
      tokenUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      error: { name: 'TimeoutError', code: 'ETIMEDOUT', summary: '超时' },
      approval: { decision: 'approve' as const },
      compaction: { kind: 'auto' as const },
      gap: { reason: 'trimmed', count: 2, firstEventId: 'evt-1', lastEventId: 'evt-2' },
    } as unknown as Parameters<typeof client.telemetryBatches>[0]['events'][number]
    const result = await client.telemetryBatches({
      schemaVersion: 1, batchId: 'batch-1', projectId: 'project-alpha', clientSentAt: '2026-09-01T00:00:00.000Z', events: [event],
    }, 1000)

    expect(result.results.map(ack => ack.status)).toEqual(['accepted', 'duplicate', 'retryable', 'rejected'])
    const [sent] = bodies as [{ readonly events: readonly Record<string, unknown>[] }]
    // 可选成员存在即数据：一个都不许被静默丢掉。
    expect(sent.events[0]).toMatchObject({
      tool_name: 'bash',
      call_id: 'call-1',
      approval_id: 'approval-1',
      compaction_id: 'compact-1',
      retryable: true,
      retry_count: 1,
      token_usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
      error: { name: 'TimeoutError', code: 'ETIMEDOUT', summary: '超时' },
      approval: { decision: 'approve' },
      compaction: { kind: 'auto' },
      gap: { reason: 'trimmed', count: 2, first_event_id: 'evt-1', last_event_id: 'evt-2' },
    })
  })

  it('rejects a batch acknowledgement for a different batch', async () => {
    const { client } = scriptedClient(() => ok({
      batch_id: 'another-batch', server_received_at: 'a', server_checkpoint: 'c', results: [],
    }))
    await expect(client.telemetryBatches({
      schemaVersion: 1, batchId: 'batch-1', projectId: 'project-alpha', clientSentAt: 'a', events: [],
    }, 1000)).rejects.toThrow(/batch id that does not match/u)
  })

  it('omits absent optional members and rejects an unknown acknowledgement status', async () => {
    const bodies: unknown[] = []
    const client = new TeamSkillHttpClient({
      apiBaseUrl: 'https://service.test/v1',
      accessToken: 'token-1',
      fetch: async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        bodies.push(typeof init?.body === 'string' ? JSON.parse(init.body) : undefined)
        return new Response(ok({
          batch_id: 'batch-2', server_received_at: 'a', server_checkpoint: 'c',
          results: [{ event_id: 'e1', status: 'accepted' }],
        }).text, { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })
    // 只带必填成员的错误、审批、压缩与缺口：缺席的成员一个都不许凭空补出来。
    const bare = {
      schemaVersion: 1 as const, eventId: 'e1', installationId: 'i', projectId: 'p', sessionId: null,
      kind: 'agent.error' as const, occurredAt: 'a', sourceType: 'agent',
      error: { name: 'TimeoutError' },
      approval: {},
      compaction: {},
      gap: { reason: 'trimmed', count: 1 },
    } as unknown as Parameters<typeof client.telemetryBatches>[0]['events'][number]
    await client.telemetryBatches({
      schemaVersion: 1, batchId: 'batch-2', projectId: 'project-alpha', clientSentAt: 'a', events: [bare],
    }, 1000)
    const [sent] = bodies as [{ readonly events: readonly Record<string, unknown>[] }]
    expect(sent.events[0]).toMatchObject({
      error: { name: 'TimeoutError' },
      approval: {},
      compaction: {},
      gap: { reason: 'trimmed', count: 1 },
    })
    expect(JSON.stringify(sent.events[0])).not.toContain('summary')
    expect(JSON.stringify(sent.events[0])).not.toContain('first_event_id')

    // 闭集外的 ack 状态是协议漂移，不是「未知结果」。
    const { client: unknownAck } = scriptedClient(() => ok({
      batch_id: 'batch-3', server_received_at: 'a', server_checkpoint: 'c',
      results: [{ event_id: 'e1', status: 'maybe' }],
    }))
    await expect(unknownAck.telemetryBatches({
      schemaVersion: 1, batchId: 'batch-3', projectId: 'project-alpha', clientSentAt: 'a', events: [],
    }, 1000)).rejects.toThrow(/invalid telemetry event/u)
  })
})

describe('TeamSkillHttpClient 信封与错误', () => {
  it('rejects a 200 body that is not JSON and envelopes that are not envelopes', async () => {
    const notJson = scriptedClient(() => ({ status: 200, text: 'gateway exploded' }))
    await expect(notJson.client.knowledgeBases('project-alpha')).rejects.toThrow(/invalid JSON\./u)

    const noData = scriptedClient(() => ({ status: 200, text: JSON.stringify({ code: 0, message: 'ok', request_id: 'r' }) }))
    await expect(noData.client.knowledgeBases('project-alpha')).rejects.toThrow(/a response without data/u)

    // code 与 message 的类型都必须成立：只给一个数字码、或 message 不是字符串，都不算成功信封。
    const badMessage = scriptedClient(() => ({ status: 200, text: JSON.stringify({ code: 'OK', message: 42, request_id: 'r', data: {} }) }))
    await expect(badMessage.client.knowledgeBases('project-alpha')).rejects.toThrow(/invalid response envelope/u)
  })

  it('maps a non-JSON failure body and a numeric failure code', async () => {
    const notJson = scriptedClient(() => ({ status: 503, text: 'upstream exploded' }))
    await expect(notJson.client.knowledgeBases('project-alpha')).rejects.toThrow(/invalid JSON error response/u)

    // 稳定的失败信封要求 data 显式为 null、request_id 为字符串；数字码同样是码。
    const numeric = scriptedClient(() => ({
      status: 429, text: JSON.stringify({ code: 42901, message: '太频繁', request_id: 'req-429', data: null }),
    }))
    const raised = await numeric.client.knowledgeBases('project-alpha')
      .then(() => { throw new Error('本应失败') }, (error: unknown) => error as { code: string; message: string })
    expect(raised.code).toBe('42901')
    expect(raised.message).toBe('太频繁')

    // 缺 request_id 的失败体不是可用信封：按协议错误处理，而不是编一个码出来。
    const incomplete = scriptedClient(() => ({ status: 429, text: JSON.stringify({ code: 'RATE_LIMITED', message: '太频繁', data: null }) }))
    await expect(incomplete.client.knowledgeBases('project-alpha')).rejects.toThrow(/invalid error envelope/u)
  })
})
