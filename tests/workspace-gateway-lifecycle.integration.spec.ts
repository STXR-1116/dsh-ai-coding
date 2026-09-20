/* workspace-gateway 生命周期、预览授予与流事件 seam（覆盖专项：workspace-gateway 批）。
 *
 * 这些 seam 此前没有任何测试驱动（函数级 0%）：预览授予（部署白名单 + 默认拒绝）、
 * 创建工作空间、停止/归档/删除、PR/丢弃/提交、流事件读取，以及 Cordis 卸载时
 * 释放 Host 的 effect。
 *
 * 全部走真实 fixture（static-token 装配，与矩阵同一模式）；失败路径断言服务端
 * 稳定码，不用「不崩溃」代替判定。
 *
 * 分类：FIXTURE-ONLY。
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createTeamSkillService } from '../dev/team-skill-service/src/server.ts'
import { WorkspaceGateway } from '../src/workspace-gateway.ts'
import type { WorkspaceQueryResult, WorkspaceStreamState } from '../src/workspace-types.ts'

const services: ReturnType<typeof createTeamSkillService>[] = []
const servers: Server[] = []

afterEach(async () => {
  for (const service of services.splice(0)) {
    service.server.closeAllConnections()
    await new Promise<void>((resolve) => {
      service.server.close(() => { resolve() })
    })
  }
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => {
      server.close(() => { resolve() })
    })
  }
})

function ready<T>(result: WorkspaceQueryResult<T>): T {
  if (result.status !== 'ready') {
    throw new Error(`seam 未就绪: ${JSON.stringify(result)}`)
  }
  return result.value
}

/** Polls one owned subscription until it reports the expected state. */
async function awaitStreamStatus(
  gateway: WorkspaceGateway,
  subscriptionId: string,
  status: string,
): Promise<WorkspaceStreamState> {
  const deadline = Date.now() + 5_000
  for (;;) {
    const state = await gateway.streamState(subscriptionId)
    if (state.status === status) return state
    if (Date.now() > deadline) throw new Error(`订阅未在预算内到达 ${status}：${state.status}`)
    await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
  }
}

/** One SSE data frame the scripted origins below emit. */
function streamFrame(eventType: string, eventId: string, revision: number): string {
  const payload = {
    event_id: eventId,
    resource_type: 'workspace',
    resource_id: 'ws-alpha-1',
    revision,
    event_type: eventType,
    occurred_at: new Date().toISOString(),
    payload: {},
  }
  return `event: ${eventType}\nid: ${eventId}\ndata: ${JSON.stringify(payload)}\n\n`
}

/** 装配一个指向真实 fixture 的网关；previewOrigins 缺省即默认拒绝。 */
async function fixtureGateway(previewOrigins?: string[]): Promise<{ port: number; gateway: WorkspaceGateway }> {
  const service = createTeamSkillService({ port: 0, seed: true })
  services.push(service)
  await service.listen()
  const port = (service.server.address() as AddressInfo).port
  const login = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin@example.com', password: 'admin-pass' }),
  })
  expect(login.status).toBe(200)
  const token = ((await login.json()) as { data: { access_token: string } }).data.access_token
  const gateway = new WorkspaceGateway(new Context(), {
    apiBaseUrl: `http://127.0.0.1:${port}`,
    accessToken: token,
    authMode: 'static-token',
    ...(previewOrigins === undefined ? {} : { previewOrigins }),
  })
  return { port, gateway }
}

describe('workspace-gateway 生命周期与预览授予（真实 fixture）', () => {
  it('issuance needs both the allowlisted origin and the controlled app port', async () => {
    const { gateway } = await fixtureGateway(['https://workspace-app.fixture.internal'])
    const grant = ready(await gateway.workspacePreviewUrl('ws-alpha-1', 3000))
    expect(grant.workspaceId).toBe('ws-alpha-1')
    expect(grant.url.startsWith('https://workspace-app.fixture.internal/ws-alpha-1/')).toBe(true)
    expect(Number.isFinite(Date.parse(grant.expiresAt))).toBe(true)

    // 端口不在受控白名单：服务端 403，网关不得把它变成可用 URL。
    const deniedPort = await gateway.workspacePreviewUrl('ws-alpha-1', 4000)
    expect(deniedPort.status).toBe('failed')
    if (deniedPort.status === 'failed') expect(deniedPort.code).toBe('PREVIEW_DENIED')

    // 部署白名单为空即默认拒绝：授予对象未登记，按协议错误拒绝而不是放行。
    const { gateway: defaultDeny } = await fixtureGateway()
    const notAllowlisted = await defaultDeny.workspacePreviewUrl('ws-alpha-1', 3000)
    expect(notAllowlisted.status).toBe('failed')
    if (notAllowlisted.status === 'failed') expect(notAllowlisted.message).toContain('allowlisted')
  })

  it('runs stop → archive → delete, and the record is gone afterwards', async () => {
    const { gateway } = await fixtureGateway()
    const before = ready(await gateway.workspace('ws-alpha-1'))
    expect(before.status).toBe('ready')

    const stopped = ready(await gateway.workspaceAction('ws-alpha-1', 'stop', before.revision))
    expect(stopped.status).toBe('stopped')
    expect(stopped.revision).toBeGreaterThan(before.revision)

    const archived = ready(await gateway.workspaceAction('ws-alpha-1', 'archive', stopped.revision))
    expect(archived.status).toBe('archived')

    const deleting = ready(await gateway.deleteWorkspace('ws-alpha-1', archived.revision))
    expect(deleting.status).toBe('deleting')

    const gone = await gateway.workspace('ws-alpha-1')
    expect(gone.status).toBe('failed')
    if (gone.status === 'failed') expect(gone.code).toBe('RESOURCE_NOT_FOUND')
  })

  it('refuses a lifecycle write at a stale revision and leaves the workspace untouched', async () => {
    const { gateway } = await fixtureGateway()
    const before = ready(await gateway.workspace('ws-alpha-1'))

    const stale = await gateway.workspaceAction('ws-alpha-1', 'stop', before.revision + 1)
    expect(stale.status).toBe('failed')
    if (stale.status === 'failed') expect(stale.code).toBe('REVISION_CONFLICT')
    expect(ready(await gateway.workspace('ws-alpha-1')).status).toBe('ready')
  })

  it('commits, opens a pull request and discards at the revision each step reports', async () => {
    const { gateway } = await fixtureGateway()
    const start = ready(await gateway.workspace('ws-alpha-1'))
    expect(ready(await gateway.workspaceChanges('ws-alpha-1')).files.length).toBeGreaterThan(0)

    const committed = ready(await gateway.gitCommit('ws-alpha-1', '覆盖轮次提交', start.revision))
    expect(committed.revision).toBeGreaterThan(start.revision)
    expect(ready(await gateway.workspaceChanges('ws-alpha-1')).files).toEqual([])

    const pullRequest = ready(await gateway.createPullRequest('ws-alpha-1', '覆盖轮次 PR', committed.revision))
    expect(pullRequest.pullRequestId.startsWith('pr-')).toBe(true)

    const discarded = ready(await gateway.discardChanges('ws-alpha-1', committed.revision))
    expect(discarded.revision).toBe(committed.revision + 1)
  })

  it('creates a workspace from an authorized source and names why the rest are refused', async () => {
    const { gateway } = await fixtureGateway()
    const created = ready(await gateway.createWorkspace({
      projectId: 'project-alpha',
      repositoryId: 'repo-1',
      branch: 'main',
      agentProfileVersionId: 'apv-1',
      displayName: '矩阵新空间',
    }))
    expect(created.displayName).toBe('矩阵新空间')
    expect(created.status).toBe('provisioning')
    expect(created.revision).toBe(1)

    // 仓库不在该项目的授权清单里：服务端拥有这份清单，表单不得自选。
    const unknownRepository = await gateway.createWorkspace({
      projectId: 'project-alpha', repositoryId: 'repo-2', branch: 'main', agentProfileVersionId: 'apv-1',
    })
    expect(unknownRepository.status).toBe('failed')
    if (unknownRepository.status === 'failed') expect(unknownRepository.code).toBe('FORBIDDEN')

    const unknownBranch = await gateway.createWorkspace({
      projectId: 'project-alpha', repositoryId: 'repo-1', branch: 'not-authorized', agentProfileVersionId: 'apv-1',
    })
    expect(unknownBranch.status).toBe('failed')
    if (unknownBranch.status === 'failed') expect(unknownBranch.code).toBe('VALIDATION_ERROR')
  })

  it('hands back the events an owned subscription consumed after a watermark', async () => {
    const { gateway } = await fixtureGateway()
    const subscription = await gateway.startStream({ projectId: 'project-alpha' })
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if ((await gateway.streamState(subscription.subscriptionId)).status === 'live') break
      await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
    }

    // 造一个真实事件：停止工作空间会写 workspace.updated 并推给订阅者。
    const live = ready(await gateway.workspace('ws-alpha-1'))
    ready(await gateway.workspaceAction('ws-alpha-1', 'stop', live.revision))

    const after = await gateway.streamEventsAfter(subscription.subscriptionId, '')
    expect(after.truncated).toBe(false)
    expect(after.events.length).toBeGreaterThan(0)
    expect(after.events.some(event => event.resourceType === 'workspace' && event.resourceId === 'ws-alpha-1')).toBe(true)

    // 命中水位：只回该事件之后的条目，且不报告截断。
    const watermark = after.events[0]?.eventId ?? ''
    const fromWatermark = await gateway.streamEventsAfter(subscription.subscriptionId, watermark)
    expect(fromWatermark.events.some(event => event.eventId === watermark)).toBe(false)
    expect(fromWatermark.truncated).toBe(false)

    // 水位不在窗口内：必须显式报告截断，而不是把部分列表当成完整历史。
    const unknownWatermark = await gateway.streamEventsAfter(subscription.subscriptionId, 'evt-not-in-window')
    expect(unknownWatermark.truncated).toBe(true)

    // 释放后订阅不再有可读历史（游标与窗口一并丢弃）。
    await gateway.stopStream(subscription.subscriptionId)
    expect(await gateway.streamState(subscription.subscriptionId)).toMatchObject({ status: 'idle' })
    expect((await gateway.streamEventsAfter(subscription.subscriptionId, '')).events).toEqual([])
  })

  it('releases the Host when the Cordis context is disposed', async () => {
    const ctx = new Context()
    const gateway = new WorkspaceGateway(ctx, {
      apiBaseUrl: 'http://127.0.0.1:1',
      accessToken: 'static-token',
      authMode: 'static-token',
    })
    const subscription = await gateway.startStream({ projectId: 'project-alpha' })

    await ctx.fiber.dispose()

    // 卸载后 Host 不再持有订阅：句柄停在 idle，新订阅直接 stopped 而不是重连。
    expect(await gateway.streamState(subscription.subscriptionId)).toMatchObject({ status: 'idle' })
    expect((await gateway.startStream({ projectId: 'project-alpha' })).state).toMatchObject({ status: 'stopped' })
  })

  it('re-reads the project and workspace snapshots on resync_required, then resumes without a watermark', async () => {
    const { gateway } = await fixtureGateway()
    // 水位落在夹具保留窗口之外：服务端要求重同步，网关必须重读 scope 声明的
    // 两份权威快照，再从零重放——而不是拿着过期水位继续当游标。
    const subscription = await gateway.startStream({
      projectId: 'project-alpha',
      workspaceId: 'ws-alpha-1',
      lastEventId: 'evt-out-of-window',
    })

    const state = await awaitStreamStatus(gateway, subscription.subscriptionId, 'live')
    expect(state.status).toBe('live')
    expect((await gateway.streamEventsAfter(subscription.subscriptionId, '')).events.length).toBeGreaterThan(0)
    await gateway.stopStream(subscription.subscriptionId)
  })

  it('reports a resync that resolves to signed-out as stale, not live', async () => {
    // 会话在流存活期间被撤销：重同步读到的不是失败而是 signed-out，
    // 这条分支同样不得把流标成 live。
    let releaseResync: () => void = () => {}
    const resyncGate = new Promise<void>((resolve) => { releaseResync = resolve })
    const server = createServer((request, response) => {
      const url = request.url ?? '/'
      if (url.includes('/v1/projects/')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ code: 0, message: 'ok', request_id: 'req-ok', data: { items: [] } }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.write(streamFrame('workspace.updated', 'evt-000001', 1))
      void resyncGate.then(() => {
        response.write('event: resync_required\nid: evt-resync\ndata: {"code":"RESYNC_REQUIRED","message":"窗口已过期"}\n\n')
        response.end()
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
    const port = (server.address() as AddressInfo).port

    const store: { record: unknown } = { record: { kind: 'grant', payload: { accessToken: 'account-token' } } }
    const ctx = new Context()
    ctx.provide('credentials', {
      readRecord: async () => store.record,
      deleteRecord: async () => { store.record = undefined },
      modifyRecord: async (_key: string, mutate: (current: unknown) => Promise<unknown>) => mutate(store.record),
    } as never)

    const gateway = new WorkspaceGateway(ctx, { apiBaseUrl: `http://127.0.0.1:${port}` })
    const subscription = await gateway.startStream({ projectId: 'project-alpha' })
    await awaitStreamStatus(gateway, subscription.subscriptionId, 'live')

    store.record = undefined
    releaseResync()

    const state = await awaitStreamStatus(gateway, subscription.subscriptionId, 'stale')
    expect(state.status).toBe('stale')
    if (state.status === 'stale') expect(state.message).toContain('signed-out')
    await gateway.stopStream(subscription.subscriptionId)
  })

  it('keeps the stream stale when the snapshot the resync depends on cannot be read', async () => {
    const server = createServer((request, response) => {
      const url = request.url ?? '/'
      // 重同步要读权威快照；这条读取失败时不得回落到 live。
      if (url.includes('/v1/projects/')) {
        response.writeHead(503, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ code: 'SERVICE_UNAVAILABLE', message: '维护中', request_id: 'req-503', data: null }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.write('event: resync_required\nid: evt-resync\ndata: {"code":"RESYNC_REQUIRED","message":"窗口已过期"}\n\n')
      response.end()
    })
    servers.push(server)
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
    const port = (server.address() as AddressInfo).port

    const gateway = new WorkspaceGateway(new Context(), {
      apiBaseUrl: `http://127.0.0.1:${port}`,
      accessToken: 'static-token',
      authMode: 'static-token',
    })
    const subscription = await gateway.startStream({ projectId: 'project-alpha' })

    const state = await awaitStreamStatus(gateway, subscription.subscriptionId, 'stale')
    expect(state.status).toBe('stale')
    if (state.status === 'stale') expect(state.code).toBe('SERVICE_UNAVAILABLE')
    await gateway.stopStream(subscription.subscriptionId)
  })
})
