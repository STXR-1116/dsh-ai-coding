/* oxlint-disable typescript/no-base-to-string -- Fetch stubs stringify RequestInfo wire values. */
/* workspace-host 残余分支（覆盖专项：workspace-host 批）。
 *
 * 两类：①REST 路径上此前只有「成功」被驱动的分支——列表载荷漂移、传输失败与
 * 取消、非法 apiBaseUrl、凭据清除失败、跨工作空间的变更集、可选参数的缺省臂；
 * ②SSE 循环的失败路径——协议违规、非法事件、流上 401、窗口修剪与水位截断、
 * runId 作用域、没有 scope.resync 的重同步。
 *
 * 分类：FIXTURE-ONLY（本地脚本化服务，非产品 fixture）。
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceHost } from '../src/workspace-host.ts'
import type { WorkspaceSessionProvider } from '../src/workspace-host.ts'

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => {
      server.close(() => { resolve() })
    })
  }
})

/** A session that hands out one identity and records every clear attempt. */
function recordingSession(cleared: string[], clearImpl: () => Promise<boolean> = async () => true): WorkspaceSessionProvider {
  return {
    read: async () => ({ accessToken: 'host-token', identity: 'identity:host-token' }),
    clear: async (identity: string) => {
      cleared.push(identity)
      return clearImpl()
    },
  }
}

interface Call {
  readonly url: string
  readonly method: string
  readonly body: unknown
  readonly headers: Record<string, string>
}

type Outcome = { readonly status: number; readonly body: unknown } | 'reject' | 'abort'

/** A host whose one fetcher answers from a script and records every call. */
function scriptedHost(
  respond: (call: Call) => Outcome,
  options: { readonly eventBufferLimit?: number } = {},
): { readonly host: WorkspaceHost; readonly calls: Call[] } {
  const calls: Call[] = []
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value })
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      headers,
    }
    calls.push(call)
    const outcome = respond(call)
    if (outcome === 'reject') throw new Error('传输中断')
    if (outcome === 'abort') throw Object.assign(new Error('已取消'), { name: 'AbortError' })
    const envelope = outcome.status >= 400
      ? { code: 'AUTH_REQUIRED', message: '登录已失效', request_id: 'req-401', data: null }
      : { code: 0, message: 'ok', request_id: 'req-ok', data: outcome.body }
    return new Response(JSON.stringify(envelope), {
      status: outcome.status,
      headers: { 'content-type': 'application/json', 'x-fixture-only': 'true' },
    })
  }
  return {
    host: new WorkspaceHost({
      apiBaseUrl: 'http://service.test',
      session: recordingSession([]),
      fetch: fetcher,
      ...options,
    }),
    calls,
  }
}

describe('workspace-host 残余分支（REST）', () => {
  it('treats a list payload that is not an object, and one without an items array, as protocol drift', async () => {
    const arrayPayload = scriptedHost(() => ({ status: 200, body: [] })).host
    const notAnObject = await arrayPayload.codeSources('project-1')
    expect(notAnObject.status).toBe('failed')
    if (notAnObject.status === 'failed') {
      expect(notAnObject.code).toBe('SERVICE_PROTOCOL_ERROR')
      expect(notAnObject.message).toContain('must be an object')
    }

    const missingItems = scriptedHost(() => ({ status: 200, body: {} })).host
    const notAnArray = await missingItems.codeSources('project-1')
    expect(notAnArray.status).toBe('failed')
    if (notAnArray.status === 'failed') {
      expect(notAnArray.code).toBe('SERVICE_PROTOCOL_ERROR')
      expect(notAnArray.message).toContain('must be an array')
    }
  })

  it('maps a transport failure and an aborted request to local failures', async () => {
    const broken = await scriptedHost(() => 'reject').host.workspaces('project-1')
    expect(broken.status).toBe('failed')
    if (broken.status === 'failed') {
      expect(broken.code).toBe('LOCAL_OPERATION_FAILED')
      expect(broken.message).toBe('传输中断')
    }

    const aborted = await scriptedHost(() => 'abort').host.workspaces('project-1')
    expect(aborted.status).toBe('failed')
    if (aborted.status === 'failed') {
      expect(aborted.code).toBe('OPERATION_CANCELED')
      expect(aborted.message).toBe('请求已取消')
    }

    // 不是 Error 的拒绝也要落到同一个本地失败，而不是漏成未处理拒绝。
    const thrown = new WorkspaceHost({
      apiBaseUrl: 'http://service.test',
      session: recordingSession([]),
      fetch: async () => { throw 'not an error' },
    })
    expect(await thrown.workspaces('project-1')).toMatchObject({ status: 'failed', code: 'LOCAL_OPERATION_FAILED' })
  })

  it('reports an unusable apiBaseUrl as an invalid configuration instead of a request failure', async () => {
    const host = new WorkspaceHost({
      apiBaseUrl: 'not-an-absolute-url',
      session: recordingSession([]),
      fetch: async () => { throw new Error('不该发出请求') },
    })
    const result = await host.workspaces('project-1')
    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.code).toBe('INVALID_CONFIGURATION')
      expect(result.message).toContain('not an absolute URL')
    }
  })

  it('signs out on a 401 and still signs out when the credential store refuses the clear', async () => {
    const cleared: string[] = []
    const host = new WorkspaceHost({
      apiBaseUrl: 'http://service.test',
      session: recordingSession(cleared),
      fetch: async () => new Response(JSON.stringify({ code: 'AUTH_REQUIRED', message: '登录已失效', request_id: 'r', data: null }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    })
    expect(await host.workspaces('project-1')).toEqual({ status: 'signed-out' })
    expect(cleared).toEqual(['identity:host-token'])

    // 凭据存储自己失败时，请求路径不得抛出：仍然是 signed-out。
    const failing = new WorkspaceHost({
      apiBaseUrl: 'http://service.test',
      session: recordingSession([], async () => { throw new Error('store unavailable') }),
      fetch: async () => new Response(JSON.stringify({ code: 'AUTH_REQUIRED', message: '登录已失效', request_id: 'r', data: null }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    })
    expect(await failing.workspaces('project-1')).toEqual({ status: 'signed-out' })
  })

  it('rejects a change set that belongs to another workspace', async () => {
    const host = scriptedHost(() => ({
      status: 200,
      body: { workspace_id: 'someone-else', baseline_revision: 1, revision: 2, files: [] },
    })).host
    const result = await host.workspaceChanges('ws-1')
    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.code).toBe('SERVICE_PROTOCOL_ERROR')
      expect(result.message).toContain('someone-else')
    }
  })

  it('carries the optional arguments only when the caller supplies them', async () => {
    const preview = scriptedHost(() => ({
      status: 200,
      body: { path: 'src/app.json', revision: 1, etag: 'e', kind: 'diff', content_type: 'text/plain', diff: '{}' },
    }))
    await preview.host.workspacePreview('ws-1', 'src/app.json', 'diff')
    expect(preview.calls[0]?.url).toContain('mode=diff')

    const action = scriptedHost(() => ({
      status: 200,
      body: {
        workspace_id: 'ws-1', project_id: 'p', owner_user_id: 'u', repository_id: 'r', branch: 'main',
        display_name: 'd', default_agent_profile_version_id: 'apv-1', status: 'ready', revision: 1,
        last_error: null, created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z',
      },
    }))
    await action.host.workspaceAction('ws-1', 'start')
    expect(action.calls[0]?.body).toEqual({})
    expect(action.calls[0]?.method).toBe('POST')

    const run = scriptedHost(() => ({
      status: 202,
      body: {
        run_id: 'run-1', project_id: 'p', workspace_id: 'ws-1', session_id: 's', agent_profile_version_id: 'apv-1',
        asset_version_ids: [], execution_policy: { permission_mode: 'approval' }, workspace_revision: 1, status: 'preparing',
        write_mode: 'read_only', lease_id: null, revision: 1, error_code: null,
        created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z',
      },
    }))
    await run.host.createRun({ workspaceId: 'ws-1', sessionId: 's', writeMode: 'read_only', expectedWorkspaceRevision: 1 })
    expect(run.calls[0]?.body).toEqual({ session_id: 's', write_mode: 'read_only', expected_workspace_revision: 1 })
    await run.host.createRun({
      workspaceId: 'ws-1', sessionId: 's', writeMode: 'write', expectedWorkspaceRevision: 2,
      agentProfileVersionId: 'apv-2', planId: 'plan-1',
    })
    expect(run.calls[1]?.body).toEqual({
      session_id: 's', write_mode: 'write', expected_workspace_revision: 2,
      agent_profile_version_id: 'apv-2', plan_id: 'plan-1',
    })

    const plan = scriptedHost(() => ({
      status: 200,
      body: {
        plan_id: 'plan-1', project_id: 'p', workspace_id: 'ws-1', goal: 'g', steps: [], agent_profile_version_id: 'apv-1',
        asset_version_ids: [], status: 'draft', revision: 1, created_by: 'u', created_at: 'a', updated_at: 'b', edits: [],
      },
    }))
    await plan.host.updatePlan({ workspaceId: 'ws-1', planId: 'plan-1', expectedRevision: 1, changeSummary: '摘要' })
    expect(plan.calls[0]?.body).toEqual({ change_summary: '摘要' })
    await plan.host.updatePlan({
      workspaceId: 'ws-1', planId: 'plan-1', goal: '新目标', steps: [{ title: '步骤一' }],
      agentProfileVersionId: 'apv-2', assetVersionIds: ['skill:a@1'], expectedRevision: 2, changeSummary: '全量修订',
    })
    expect(plan.calls[1]?.body).toEqual({
      goal: '新目标',
      steps: [{ title: '步骤一', depends_on: undefined }],
      agent_profile_version_id: 'apv-2',
      asset_version_ids: ['skill:a@1'],
      change_summary: '全量修订',
    })

    const draft = scriptedHost(() => ({
      status: 200,
      body: { agent_profile_id: 'ap-1', revision: 1, name: 'n', description: 'd', agent_type_id: 'at-1', versions: [] },
    }))
    await draft.host.updateProfileDraft({ profileId: 'ap-1', expectedRevision: 1, patch: { name: '只改名字' } })
    expect(draft.calls[0]?.body).toEqual({ name: '只改名字' })
    await draft.host.updateProfileDraft({
      profileId: 'ap-1', expectedRevision: 2,
      patch: { name: '新名字', description: '新描述', model: 'deepseek-v4', reasoning: 'high' },
    })
    expect(draft.calls[1]?.body).toEqual({ name: '新名字', description: '新描述', model: 'deepseek-v4', reasoning: 'high' })
  })

  it('addresses one named checkpoint, one run-scoped lens, and a candidate page without items', async () => {
    const checkpoint = scriptedHost(() => ({
      status: 200,
      body: {
        checkpoint_id: 'cp-1', created_at: 'a', trace_id: 't', session_seq: 1, tool_results: [], pending_approval: null,
        completed_steps: [], agent_config: { agent_profile_version_id: 'apv-1', execution_policy: { permission_mode: 'approval' } },
        asset_version_ids: [], workspace_revision: 1, plan_id: null, consumed: false, consumed_at: null,
        resume_preview: { reuse: [], replay: [] }, fixture_only: true,
      },
    }))
    await checkpoint.host.runCheckpoint('run-1', 'cp-1')
    expect(checkpoint.calls[0]?.url).toContain('checkpoint_id=cp-1')

    const lens = scriptedHost(() => ({
      status: 200,
      body: { workspace_id: 'ws-1', revision: 1, generated_at: 'a', entries: [], permission_decisions: [] },
    }))
    await lens.host.contextLens('ws-1', 'run-1')
    expect(lens.calls[0]?.url).toContain('run_id=run-1')

    // 分页页缺少 items 时是空页，而不是「列表加载失败」。
    const candidates = scriptedHost(() => ({ status: 200, body: {} }))
    expect(await candidates.host.assetCandidates('project-1')).toMatchObject({ status: 'ready', value: [] })
  })
})

/** One SSE data frame for the scripted origins below. */
function eventFrame(eventType: string, eventId: string, revision: number): string {
  const payload = {
    event_id: eventId,
    resource_type: 'workspace',
    resource_id: 'ws-1',
    revision,
    event_type: eventType,
    occurred_at: new Date().toISOString(),
    payload: {},
  }
  return `event: ${eventType}\nid: ${eventId}\ndata: ${JSON.stringify(payload)}\n\n`
}

/** A scripted SSE origin; the script answers one response body per request. */
async function streamOrigin(
  script: (url: string, requestIndex: number) => string | { readonly unauthorized: true },
): Promise<{ readonly baseUrl: string; readonly urls: string[] }> {
  const urls: string[] = []
  const server = createServer((request, response) => {
    const url = request.url ?? '/'
    urls.push(url)
    const outcome = script(url, urls.length)
    if (typeof outcome !== 'string') {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ code: 'AUTH_REQUIRED', message: '登录已失效', request_id: 'r', data: null }))
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    response.end(outcome)
  })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, urls }
}

/** Waits until the recorded states include the expected one. */
function awaitStates(seen: string[], wanted: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => { reject(new Error(`未观察到 ${wanted}；已见 ${seen.join(',')}`)) }, 5_000)
    const check = (): void => {
      if (seen.includes(wanted)) {
        clearTimeout(deadline)
        resolve()
        return
      }
      setTimeout(check, 10)
    }
    check()
  })
}

describe('workspace-host 残余分支（SSE 循环）', () => {
  it('marks the stream stale on a non-JSON frame and on a frame that is not an event', async () => {
    // 没有 event 名的帧按 message 处理：data 不是 JSON 就是协议违规。
    const raw = await streamOrigin(() => 'id: evt-bad\ndata: {oops}\n\n')
    const rawSeen: string[] = []
    const rawHost = new WorkspaceHost({
      apiBaseUrl: raw.baseUrl,
      session: recordingSession([]),
      reconnectDelayMs: () => 5,
    })
    rawHost.onStreamStateChange((_id, state) => rawSeen.push(state.status))
    rawHost.startStream({ projectId: 'project-alpha' })
    await awaitStates(rawSeen, 'stale')
    rawHost.stopStream()

    // 合法 JSON 但不是流事件：同样是漂移，不能当成「没有事件」继续声称 live。
    const shape = await streamOrigin(() => 'event: workspace.updated\nid: evt-shape\ndata: {"unexpected":true}\n\n')
    const shapeSeen: string[] = []
    const shapeHost = new WorkspaceHost({
      apiBaseUrl: shape.baseUrl,
      session: recordingSession([]),
      reconnectDelayMs: () => 5,
    })
    shapeHost.onStreamStateChange((_id, state) => shapeSeen.push(state.status))
    shapeHost.startStream({ projectId: 'project-alpha' })
    await awaitStates(shapeSeen, 'stale')
    shapeHost.stopStream()
  })

  it('keeps reconnecting on a stream failure that is not an expired session', async () => {
    const cleared: string[] = []
    const seen: string[] = []
    // 503 而不是 401：不得当成会话失效去清凭据，只按重连退避继续。
    const server = createServer((_request, response) => {
      response.writeHead(503, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ code: 'SERVICE_UNAVAILABLE', message: '维护中', request_id: 'r', data: null }))
    })
    servers.push(server)
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
    const host = new WorkspaceHost({
      apiBaseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      session: recordingSession(cleared),
      reconnectDelayMs: () => 5,
    })
    host.onStreamStateChange((_id, state) => seen.push(state.status))
    host.startStream({ projectId: 'project-alpha' })
    await awaitStates(seen, 'reconnecting')
    expect(cleared).toEqual([])
    expect(seen).not.toContain('stopped')
    host.stopStream()
  })

  it('signs out and stops when the stream itself answers 401', async () => {
    const { baseUrl } = await streamOrigin(() => ({ unauthorized: true }))
    const cleared: string[] = []
    const seen: string[] = []
    const host = new WorkspaceHost({
      apiBaseUrl: baseUrl,
      session: recordingSession(cleared),
      reconnectDelayMs: () => 5,
    })
    host.onStreamStateChange((_id, state) => seen.push(state.status))
    host.startStream({ projectId: 'project-alpha' })
    await awaitStates(seen, 'stopped')
    expect(cleared).toEqual(['identity:host-token'])
    host.stopStream()
  })

  it('keeps the replay window bounded and reports an out-of-window watermark honestly', async () => {
    const three = eventFrame('workspace.updated', 'evt-1', 1) + eventFrame('workspace.updated', 'evt-2', 2) + eventFrame('workspace.updated', 'evt-3', 3)
    const { baseUrl } = await streamOrigin(() => three)
    const host = new WorkspaceHost({
      apiBaseUrl: baseUrl,
      session: recordingSession([]),
      reconnectDelayMs: () => 5,
      eventBufferLimit: 2,
    })
    const subscription = host.startStream({ projectId: 'project-alpha' })
    const seen: string[] = []
    host.onStreamStateChange((_id, state) => seen.push(state.status))
    await awaitStates(seen, 'live')

    const after = host.streamEventsAfter('', subscription.subscriptionId)
    expect(after.events.length).toBeLessThanOrEqual(2)
    expect(after.truncated).toBe(false)
    host.stopStream()

    // 空窗口 + 未知水位：没有可报告的前缀，因此不是截断。
    const empty = await streamOrigin(() => '')
    const emptyHost = new WorkspaceHost({ apiBaseUrl: empty.baseUrl, session: recordingSession([]), reconnectDelayMs: () => 5 })
    const emptySubscription = emptyHost.startStream({ projectId: 'project-alpha' })
    expect(emptyHost.streamEventsAfter('evt-not-in-window', emptySubscription.subscriptionId)).toEqual({ events: [], truncated: false })
    emptyHost.stopStream()

    // 释放一个从未持有的句柄是空操作。
    emptyHost.stopStream('never-subscribed')
    expect(emptyHost.streamState('never-subscribed')).toEqual({ status: 'idle' })
  })

  it('carries the run scope into the stream query and resumes without a scope resync', async () => {
    const frames = 'event: resync_required\nid: evt-resync\ndata: {"code":"RESYNC_REQUIRED","message":"窗口已过期"}\n\n'
    const { baseUrl, urls } = await streamOrigin((_url, index) => (index === 1 ? frames : eventFrame('workspace.updated', 'evt-1', 1)))
    const seen: string[] = []
    const host = new WorkspaceHost({ apiBaseUrl: baseUrl, session: recordingSession([]), reconnectDelayMs: () => 5 })
    host.onStreamStateChange((_id, state) => seen.push(state.status))
    host.startStream({ projectId: 'project-alpha', runId: 'run-1' })
    await awaitStates(seen, 'live')

    expect(urls[0]).toContain('run_id=run-1')
    // 作用域没有声明 resync：重同步是成功的空操作，游标清空后从零重放。
    expect(seen).toContain('resync')
    expect(seen).not.toContain('stale')
    expect(urls[1]).toContain('after=')
    host.stopStream()
  })

  it('stops a resync that resolves after its subscription was released', async () => {
    const { baseUrl } = await streamOrigin(() => 'event: resync_required\nid: evt-resync\ndata: {"code":"RESYNC_REQUIRED","message":"窗口已过期"}\n\n')
    let releaseResync: () => void = () => {}
    const gate = new Promise<void>((resolve) => { releaseResync = resolve })
    const host = new WorkspaceHost({ apiBaseUrl: baseUrl, session: recordingSession([]), reconnectDelayMs: () => 5 })
    const subscription = host.startStream({
      projectId: 'project-alpha',
      // 挂在重同步里：订阅被释放时重同步还没回来。
      resync: async () => { await gate },
    })

    // 让重同步先进入挂起，再释放订阅，然后才让它完成：循环必须就此退出，
    // 而不是拿着一个已被释放的订阅继续重放。
    await new Promise<void>((resolve) => { setTimeout(resolve, 30) })
    host.stopStream(subscription.subscriptionId)
    releaseResync()
    await new Promise<void>((resolve) => { setTimeout(resolve, 30) })
    expect(host.streamState(subscription.subscriptionId)).toEqual({ status: 'idle' })
  })

  it('stops delivering frames once its subscription is released mid-stream', async () => {
    // 两帧在同一次读取里到达：处理第一帧时释放订阅，第二帧不得再投递。
    const two = eventFrame('workspace.updated', 'evt-1', 1) + eventFrame('workspace.updated', 'evt-2', 2)
    const { baseUrl } = await streamOrigin(() => two)
    const host = new WorkspaceHost({ apiBaseUrl: baseUrl, session: recordingSession([]), reconnectDelayMs: () => 5 })
    const delivered: string[] = []
    const subscription = host.startStream({ projectId: 'project-alpha' })
    let released = false
    const dispose = host.onStreamEvent((_id, event) => {
      delivered.push(event.eventId)
      if (released) return
      released = true
      host.stopStream(subscription.subscriptionId)
    })

    await new Promise<void>((resolve) => { setTimeout(resolve, 80) })
    dispose()
    expect(delivered).toEqual(['evt-1'])
  })

  it('stops the loop at the tail check when its subscription is released as the stream ends', async () => {
    // 末帧不带空行终止符（多个 `\n` 只留一个）：解码器把最后一行收进帧后，流已结束，
    // 于是收尾帧在读取循环之外才被投递——处理它的过程中释放订阅后，生成器不再需要
    // 下一次读取，循环是「正常收尾」离开 try 的，必须在收尾检查处退出，而不是再排一次
    // 重连退避。
    const { baseUrl, urls } = await streamOrigin(() => eventFrame('workspace.updated', 'evt-1', 1).slice(0, -1))
    const host = new WorkspaceHost({ apiBaseUrl: baseUrl, session: recordingSession([]), reconnectDelayMs: () => 5 })
    const subscription = host.startStream({ projectId: 'project-alpha' })
    const delivered: string[] = []
    const dispose = host.onStreamEvent((_id, event) => {
      delivered.push(event.eventId)
      host.stopStream(subscription.subscriptionId)
    })

    await new Promise<void>((resolve) => { setTimeout(resolve, 80) })
    dispose()
    // 帧照常投递（没有终止符的收尾帧也必须到达消费者），但只有一次连接：
    // 已释放的订阅不得重连。
    expect(delivered).toEqual(['evt-1'])
    expect(urls).toEqual(['/v1/events/stream?project_id=project-alpha&after='])
  })
})
