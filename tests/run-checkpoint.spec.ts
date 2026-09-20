/* oxlint-disable typescript/no-base-to-string -- Fetch stubs stringify RequestInfo wire values. */
/**
 * 1-3「检查点与恢复」Host 层验收（契约：API 需求 §11.8）。
 * 覆盖：pause/resume/checkpoint 走契约路径并携带幂等键；检查点严格解析
 * （字段缺失即协议错误）；恢复预览透传（reuse/replay）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseRunCheckpoint } from '../src/workspace-http.ts'
import { WorkspaceHost } from '../src/workspace-host.ts'
import type { WorkspaceSessionProvider } from '../src/workspace-host.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

function session(): WorkspaceSessionProvider {
  const current = 'cp-token'
  return {
    read: async () => ({ accessToken: current, identity: `identity:${current}` }),
    clear: async () => false,
  }
}

const checkpointDto = {
  created_at: '2026-09-16T01:00:00.000Z',
  trace_id: 'trace-1',
  session_seq: 7,
  tool_results: [{ call_id: 'call-1', tool: 'terminal', result: 'tests passed' }],
  pending_approval: null,
  completed_steps: [0],
  agent_config: {
    agent_profile_version_id: 'apv-1',
    execution_policy: { permission_mode: 'approval', write_mode: 'write' },
  },
  asset_version_ids: ['skill:x@1.0.0'],
  workspace_revision: 7,
  plan_id: 'plan-1',
  steps: ['步骤一：梳理', '步骤二：实现'],
  consumed: false,
  consumed_at: null,
  resume_preview: {
    reuse: [{ kind: 'plan_step', title: '步骤一：梳理' }, { kind: 'tool_result', call_id: 'call-1', tool: 'terminal' }],
    replay: [{ title: '步骤二：实现' }],
  },
  fixture_only: true,
}

interface StubRoute {
  readonly match: (url: string, method: string) => boolean
  readonly respond: () => { readonly status: number; readonly body: unknown }
}

function stubFetch(routes: StubRoute[]): {
  readonly fetcher: typeof globalThis.fetch
  readonly calls: Array<{ readonly url: string; readonly method: string; readonly headers: Record<string, string> }>
} {
  const calls: Array<{ readonly url: string; readonly method: string; readonly headers: Record<string, string> }> = []
  const fetcher = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value
    })
    calls.push({ url, method, headers })
    const route = routes.find(route => route.match(url, method))
    if (route === undefined) {
      return new Response(JSON.stringify({ code: 'RESOURCE_NOT_FOUND', message: '未脚本化', request_id: 'r', data: null }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    }
    const { status, body: payload } = route.respond()
    if (status >= 400) {
      return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ code: 0, message: 'ok', request_id: 'r', data: payload }), {
      status,
      headers: { 'content-type': 'application/json', 'x-fixture-only': 'true' },
    })
  }
  return { fetcher, calls }
}

describe('parseRunCheckpoint 严格解析', () => {
  it('契约字段集闭包：六类检查点状态与恢复预览透传', () => {
    const checkpoint = parseRunCheckpoint(checkpointDto)
    expect(Object.keys(checkpoint).sort()).toEqual([
      'agentConfig',
      'assetVersionIds',
      'completedSteps',
      'consumed',
      'consumedAt',
      'createdAt',
      'fixtureOnly',
      'pendingApproval',
      'planId',
      'resumePreview',
      'sessionSeq',
      'steps',
      'toolResults',
      'traceId',
      'workspaceRevision',
    ])
    expect(checkpoint.sessionSeq).toBe(7)
    expect(checkpoint.resumePreview.replay.map(step => step.title)).toEqual(['步骤二：实现'])
    expect(checkpoint.toolResults[0]?.callId).toBe('call-1')
  })

  it('元数据缺失是协议漂移：session_seq 缺失抛 SERVICE_PROTOCOL_ERROR', () => {
    const missing = { ...checkpointDto } as Record<string, unknown>
    delete missing['session_seq']
    expect(() => parseRunCheckpoint(missing)).toThrow(/session_seq/u)
  })
})

describe('WorkspaceHost 检查点生命周期', () => {
  it('pause 携带幂等键与会话序号；checkpoint 读取；resume 显式选择模式', async () => {
    const fullRun = (status: string, revision: number): Record<string, unknown> => ({
      run_id: 'run-1',
      project_id: 'project-alpha',
      workspace_id: 'ws-1',
      session_id: 'sess-1',
      agent_profile_version_id: 'apv-1',
      asset_version_ids: ['skill:x@1.0.0'],
      execution_policy: { permission_mode: 'approval' },
      workspace_revision: 7,
      status,
      write_mode: 'read_only',
      lease_id: null,
      revision,
      error_code: null,
      created_at: '2026-09-16T01:00:00.000Z',
      updated_at: '2026-09-16T01:01:00.000Z',
    })
    const { fetcher, calls } = stubFetch([
      { match: (url, method) => method === 'POST' && url.endsWith(':pause'), respond: () => ({ status: 200, body: fullRun('paused', 4) }) },
      { match: (url, method) => method === 'GET' && url.endsWith('/checkpoint'), respond: () => ({ status: 200, body: checkpointDto }) },
      { match: (url, method) => method === 'POST' && url.endsWith(':resume'), respond: () => ({ status: 200, body: fullRun('preparing', 5) }) },
    ])
    const host = new WorkspaceHost({ apiBaseUrl: 'http://service.test', session: session(), fetch: fetcher })

    const paused = await host.pauseRun({
      runId: 'run-1',
      sessionSeq: 7,
      toolResults: [{ callId: 'call-1', tool: 'terminal', result: 'tests passed' }],
      completedSteps: [0],
    })
    expect(paused.status).toBe('ready')

    const checkpoint = await host.runCheckpoint('run-1')
    expect(checkpoint.status).toBe('ready')
    const checkpointValue = checkpoint.status === 'ready' ? checkpoint.value : undefined
    expect(checkpointValue?.resumePreview.reuse.length).toBe(2)
    expect(checkpointValue?.resumePreview.replay.map(step => step.title)).toEqual(['步骤二：实现'])

    const resumed = await host.resumeRun({ runId: 'run-1', mode: 'continue' })
    expect(resumed.status).toBe('ready')

    const pauseCall = calls.find(call => call.url.endsWith(':pause'))
    expect(pauseCall?.headers['idempotency-key']).toBeTruthy()
    const resumeCall = calls.find(call => call.url.endsWith(':resume'))
    expect(resumeCall?.headers['idempotency-key']).toBeTruthy()
  })

  it('服务失败映射为 failed 并保留稳定错误码', async () => {
    const { fetcher } = stubFetch([
      {
        match: (url, method) => method === 'POST' && url.endsWith(':pause'),
        respond: () => ({ status: 409, body: { code: 'INVALID_STATUS', message: '当前状态 preparing 不允许暂停' } }),
      },
    ])
    const host = new WorkspaceHost({ apiBaseUrl: 'http://service.test', session: session(), fetch: fetcher })
    const result = await host.pauseRun({ runId: 'run-1', sessionSeq: 1 })
    expect(result.status).toBe('failed')
    if (result.status === 'failed') expect(result.code).toBe('INVALID_STATUS')
  })
})
