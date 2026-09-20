/* oxlint-disable typescript/no-unnecessary-type-assertion -- config object literals satisfy the parameter types directly */
/* oxlint-disable typescript/no-base-to-string -- wire-value assertions mirror sibling integration suites */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { CredentialProvider, type CredentialKey, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
// 0.1.5 drift: AgentLoop.inject now also requires sessionProjections, which
// dsh-session-projection provides. On the 0.1.1-rc.2 sources the loop mounted
// without it; on this baseline an unmounted registry leaves the loop's fiber
// waiting on an unmet injection, so ctx.agentLoop never appears and every
// await ctx.agentLoop.create(...) call throws.
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, textResponse } from './helpers/mock-adapter.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createTeamSkillService } from '../dev/team-skill-service/src/server.ts'
import { TeamSkillGateway } from '../src/gateway.ts'
import { TelemetryQueue } from '../src/telemetry/queue.ts'
import { TelemetryReporter } from '../src/telemetry/reporter.ts'
import type { CollectorStatus, TelemetryEventDto } from '../src/types.ts'

import type { AddressInfo } from 'node:net'

let BASE = ''

const services: Array<{ readonly server: Server }> = []

/** Outgoing-request recorder: one entry per real HTTP request through the chain. */
interface RecordedRequest {
  readonly path: string
  readonly auth: string | null
  readonly status: number
  readonly bodyJson?: unknown
}

let recorded: RecordedRequest[] = []
const originalFetch = globalThis.fetch

function installFetchRecorder(): void {
  recorded = []
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const response = await originalFetch(input, init)
    let bodyJson: unknown
    try {
      bodyJson = init?.body ? JSON.parse(String(init.body)) : undefined
    } catch {
      bodyJson = undefined
    }
    recorded.push({
      path: String(input).replace(/^https?:\/\/[^/]+/, ''),
      auth: new Headers(init?.headers).get('authorization'),
      status: response.status,
      bodyJson,
    })
    return response
  }) as typeof fetch
}

function batchPosts(): RecordedRequest[] {
  return recorded.filter(entry => entry.path.endsWith('/telemetry/batches'))
}

function acceptedBatchCount(): number {
  return batchPosts().filter(entry => entry.status === 202).length
}

afterEach(async () => {
  globalThis.fetch = originalFetch
  recorded = []
  for (const service of services.splice(0)) {
    service.server.closeAllConnections()
    await new Promise<void>((resolve) => {
      service.server.close(() => {
        resolve()
      })
    })
  }
})

async function startService(): Promise<void> {
  const service = createTeamSkillService({ port: 0, seed: true })
  services.push(service)
  await service.listen()
  const address = service.server.address() as AddressInfo
  BASE = `http://127.0.0.1:${address.port}/v1`
}

function staticTokenEvent(seq: number): TelemetryEventDto {
  return {
    schemaVersion: 1,
    eventId: `gw-static-${seq}`,
    installationId: 'gw-install',
    projectId: 'project-alpha',
    sessionId: 'gw-session',
    kind: 'turn.finished',
    occurredAt: new Date().toISOString(),
    sourceType: 'turn/end',
    sourceSeq: seq,
    turn: 1,
    outcome: 'success',
  }
}

/** Admin queries bypass the recorder via the retained original fetch. */
async function adminEventCount(): Promise<number> {
  const response = await originalFetch(`${BASE}/admin/projects/project-alpha/telemetry/events?from=2000-01-01T00:00:00.000Z&to=2100-01-01T00:00:00.000Z&limit=200`, {
    headers: { authorization: 'Bearer admin-demo' },
  })
  const body = (await response.json()) as { data?: { items?: unknown[] } }
  return body.data?.items?.length ?? -1
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() > deadline) return false
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

async function readyStatus(gateway: TeamSkillGateway): Promise<CollectorStatus> {
  const snapshot = await gateway.collectorStatus()
  if (snapshot.status !== 'ready') throw new Error(`collector not ready: ${JSON.stringify(snapshot)}`)
  return snapshot.value
}

/** 浏览器可见响应不含任何 Token 值（Remote 边界断言）。 */
function expectNoTokenLeak(status: CollectorStatus): void {
  const serialized = JSON.stringify(status)
  expect(serialized).not.toContain('demo-token')
  expect(serialized).not.toContain('access-')
  expect(serialized).not.toContain('refresh-')
}

/** 独立句柄直接向 Gateway 的队列数据库注入一条事件（绕过采集，专测上报路径）。 */
function enqueueInto(stateDirectory: string, event: TelemetryEventDto, accountPartition: string): void {
  const queue = TelemetryQueue.open(stateDirectory, {
    maxEvents: 1000,
    maxBytes: 1024 * 1024,
    batchMaxEvents: 50,
    batchMaxBytes: 256 * 1024,
    flushIntervalMs: 60,
    httpTimeoutMs: 500,
    maxAttempts: 3,
    retentionMs: 24 * 60 * 60 * 1000,
    claimTimeoutMs: 60_000,
  })
  queue.enqueue(event, accountPartition, Date.now())
  queue.close()
}

async function buildGateway(
  ctx: Context,
  stateDirectory: string,
  staticToken: string | undefined,
  settings: { readonly flushIntervalMs: number; readonly claimTimeoutMs: number } = { flushIntervalMs: 60, claimTimeoutMs: 60_000 },
): Promise<TeamSkillGateway> {
  await ctx.plugin(SessionStore)
  return new TeamSkillGateway(ctx, {
    apiBaseUrl: BASE,
    ...(staticToken === undefined ? {} : { accessToken: staticToken }),
    stateDirectory,
    globalSkillRoot: 'unused',
    telemetry: settings,
  })
}

/** Memory credential provider over one mutable grant; logout really clears it. */
class MemoryCredentialProvider extends CredentialProvider {
  constructor(ctx: Context, private readonly state: { grant: Record<string, unknown> | undefined }) {
    super(ctx)
  }

  resolve(): Promise<undefined> {
    return Promise.resolve(undefined)
  }

  describe(): Promise<never> {
    return Promise.reject(new Error('not used in tests'))
  }

  set(): Promise<void> {
    return Promise.resolve()
  }

  unset(): Promise<void> {
    return Promise.resolve()
  }

  readRecord(_key: CredentialKey): Promise<CredentialRecord | undefined> {
    return Promise.resolve(this.state.grant === undefined ? undefined : { kind: 'grant', payload: this.state.grant })
  }

  describeRecord(_key: CredentialKey): Promise<never> {
    return Promise.reject(new Error('not used in tests'))
  }

  listRecords(): Promise<readonly never[]> {
    return Promise.resolve([])
  }

  async modifyRecord(
    _key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const next = await mutate(this.readRecordSync())
    if (next === undefined) {
      this.state.grant = undefined
    } else if (next.kind === 'grant' && typeof next.payload === 'object' && next.payload !== null) {
      this.state.grant = next.payload as Record<string, unknown>
    }
    return next
  }

  deleteRecord(_key: CredentialKey): Promise<void> {
    this.state.grant = undefined
    return Promise.resolve()
  }

  private readRecordSync(): CredentialRecord | undefined {
    return this.state.grant === undefined ? undefined : { kind: 'grant', payload: this.state.grant }
  }
}

/** 凭据存储异常的提供者：readRecord 抛错（如 CREDENTIALS_INVALID）。 */
class ThrowingCredentialProvider extends CredentialProvider {
  resolve(): Promise<undefined> {
    return Promise.resolve(undefined)
  }

  describe(): Promise<never> {
    return Promise.reject(new Error('not used in tests'))
  }

  set(): Promise<void> {
    return Promise.reject(new Error('not used in tests'))
  }

  unset(): Promise<void> {
    return Promise.reject(new Error('not used in tests'))
  }

  readRecord(): Promise<CredentialRecord | undefined> {
    return Promise.reject(new Error('CREDENTIAL_STORE_CORRUPT'))
  }

  describeRecord(): Promise<never> {
    return Promise.reject(new Error('not used in tests'))
  }

  listRecords(): Promise<readonly never[]> {
    return Promise.reject(new Error('CREDENTIAL_STORE_CORRUPT'))
  }

  modifyRecord(): Promise<CredentialRecord | undefined> {
    return Promise.reject(new Error('CREDENTIAL_STORE_CORRUPT'))
  }

  deleteRecord(): Promise<void> {
    return Promise.reject(new Error('CREDENTIAL_STORE_CORRUPT'))
  }
}

describe('telemetry account semantics through the real Gateway/Reporter/Queue/fixture chain', () => {
  it('S1 凭据读取抛错 → not-ready：零发送、队列保留、静态分区不兜底、Token 不泄漏', async () => {
    installFetchRecorder()
    await startService()
    const stateDirectory = await mkdtemp(join(tmpdir(), 'dsh-gw-throwing-'))
    const ctx = new Context()
    new ThrowingCredentialProvider(ctx)
    const gateway = await buildGateway(ctx, stateDirectory, 'demo-token')
    enqueueInto(stateDirectory, staticTokenEvent(21), 'static-token')
    // 凭据读取异常 → not-ready：不得用静态分区继续 drain，队列必须保留。
    await new Promise(resolve => setTimeout(resolve, 600))
    const status = await readyStatus(gateway)
    expect(status.mode).toBe('not-ready')
    expect(status.queueEventCount).toBe(1)
    // 实际发送次数为 0：整条链路没有出现过一次 202 批次，甚至没有批次请求。
    expect(acceptedBatchCount()).toBe(0)
    expect(batchPosts()).toEqual([])
    expect(await adminEventCount()).toBe(0)
    expectNoTokenLeak(status)
  })

  it('R11 认证挂起窗口：login/refresh/logout 未完成时采集立即隔离（不写旧账号、不预写新账号），Authorization/分区/队列逐项断言', { timeout: 60_000 }, async () => {
    installFetchRecorder()
    await startService()
    const state: { grant: Record<string, unknown> | undefined } = { grant: undefined }
    const stateDirectory = await mkdtemp(join(tmpdir(), 'dsh-gw-authwindow-'))
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    // 0.1.5 drift: satisfy AgentLoop's new sessionProjections injection.
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('R11 window answer')]))
    new MemoryCredentialProvider(ctx, state)
    const gateway = new TeamSkillGateway(ctx, {
      apiBaseUrl: BASE,
      accessToken: 'demo-token',
      stateDirectory,
      globalSkillRoot: 'unused',
      telemetry: { flushIntervalMs: 60, claimTimeoutMs: 60_000 },
    })
    const agent = await ctx.agentLoop.create(SessionId('r11w-session'), { provider: 'mock', model: 'mock' })
    const runTurn = async (marker: string): Promise<void> => {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: `R11 window ${marker}` }], source: { kind: 'user' } }))
      await new Promise<void>((resolve) => {
        const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
          if (subject === agent && status === 'idle') {
            dispose()
            resolve()
          }
        })
      })
    }

    // 可控延迟：三个认证端点的门各自带 armed 开关，只在被测窗口内挂起。
    let loginArmed = false
    let refreshArmed = false
    let logoutArmed = false
    let releaseLogin!: () => void
    const loginGate = new Promise<void>((resolve) => { releaseLogin = resolve })
    let releaseRefresh!: () => void
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve })
    let releaseLogout!: () => void
    const logoutGate = new Promise<void>((resolve) => { releaseLogout = resolve })
    const recorderFetch = globalThis.fetch
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input)
      if (url.includes('/auth/login') && loginArmed) await loginGate
      if (url.includes('/auth/refresh') && refreshArmed) await refreshGate
      if (url.includes('/auth/logout') && logoutArmed) await logoutGate
      return recorderFetch(input, init)
    }) as typeof fetch

    try {
      // 基线：登录并绑定项目，排空 member 分区（Authorization=Bearer access-…）。
      expect((await gateway.login({ username: 'member@example.com', password: 'member-pass' })).status).toBe('authenticated')
      expect(await gateway.configureCollectorProject('r11w-session', 'project-alpha')).toEqual({
        status: 'ready',
        value: { projectId: 'project-alpha' },
      })
      await runTurn('baseline')
      expect(await waitFor(async () => (await readyStatus(gateway)).queueEventCount === 0)).toBe(true)
      expect(batchPosts().filter(entry => entry.status === 202).every(entry => entry.auth?.startsWith('Bearer access-') ?? false)).toBe(true)

      // 阶段 1（logout 挂起）：Promise 未完成时旧账号采集立即停止——
      // member 分区不新增、挂起窗口内没有任何批次请求（事件既不写旧账号也不发送）。
      logoutArmed = true
      const batchesBeforeLogoutWindow = batchPosts().length
      const isolatedBeforeLogout = (await readyStatus(gateway)).isolatedEventCount
      const logoutPromise = gateway.logout()
      await new Promise(resolve => setTimeout(resolve, 120))
      await runTurn('window-logout')
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(batchPosts().length).toBe(batchesBeforeLogoutWindow)
      expect((await readyStatus(gateway)).queueEventCount).toBe(0)
      // 正向隔离证据：窗口 turn 的事件确实到达采集入口并被隔离（计数增加），而非未产生。
      const isolatedAfterLogout = (await readyStatus(gateway)).isolatedEventCount
      expect(isolatedAfterLogout).toBeGreaterThan(isolatedBeforeLogout)
      releaseLogout()
      logoutArmed = false
      expect((await logoutPromise).status).toBe('signed-out')

      // 阶段 2（login 挂起）：从 signed-out 重新登录；挂起期间不写 static 分区、不预写新账号，
      // 因此也没有任何批次请求；事件到达采集入口后同样被隔离计数。
      loginArmed = true
      const batchesBeforeLoginWindow = batchPosts().length
      const isolatedBeforeLogin = (await readyStatus(gateway)).isolatedEventCount
      const loginPromise = gateway.login({ username: 'member@example.com', password: 'member-pass' })
      await new Promise(resolve => setTimeout(resolve, 120))
      await runTurn('window-login')
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(batchPosts().length).toBe(batchesBeforeLoginWindow)
      expect((await readyStatus(gateway)).queueEventCount).toBe(0)
      const isolatedAfterLogin = (await readyStatus(gateway)).isolatedEventCount
      expect(isolatedAfterLogin).toBeGreaterThan(isolatedBeforeLogin)
      releaseLogin()
      loginArmed = false
      expect((await loginPromise).status).toBe('authenticated')

      // 阶段 3（refresh 挂起）：member 分区继续；挂起期间事件被隔离、无批次请求，
      // 完成后新会话仍为 member。
      refreshArmed = true
      const batchesBeforeRefreshWindow = batchPosts().length
      const isolatedBeforeRefresh = (await readyStatus(gateway)).isolatedEventCount
      const refreshPromise = gateway.refreshAccount()
      await new Promise(resolve => setTimeout(resolve, 120))
      await runTurn('window-refresh')
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(batchPosts().length).toBe(batchesBeforeRefreshWindow)
      expect((await readyStatus(gateway)).queueEventCount).toBe(0)
      const isolatedAfterRefresh = (await readyStatus(gateway)).isolatedEventCount
      expect(isolatedAfterRefresh).toBeGreaterThan(isolatedBeforeRefresh)
      releaseRefresh()
      refreshArmed = false
      expect((await refreshPromise).status).toBe('authenticated')

      // 阶段 4：确认后的分区归属——member 时代批次全为登录 Token；signed-out 后 static 接管；
      // 三个挂起窗口的事件不出现在任何分区或后台。
      await runTurn('post-refresh')
      expect(await waitFor(async () => (await readyStatus(gateway)).queueEventCount === 0)).toBe(true)
      await gateway.logout()
      // 同形健康 turn 配对：统计一个健康 turn 实际上报的 event ID 数（批次差集，
      // 避免 admin 分页截断），与窗口隔离计数对比，证明“产生的每个事件都到达
      // 采集入口并被隔离”。
      const allSentIds = (): Set<string> => {
        const ids = new Set<string>()
        for (const entry of batchPosts()) {
          const body = entry.bodyJson as { events?: Array<{ event_id: string }> } | undefined
          for (const event of body?.events ?? []) ids.add(event.event_id)
        }
        return ids
      }
      const idsBeforePair = allSentIds()
      const receivedBeforePair = (await readyStatus(gateway)).receivedEventCount
      await runTurn('pair-healthy')
      expect(await waitFor(async () => (await readyStatus(gateway)).queueEventCount === 0)).toBe(true)
      const pairHealthyEvents = allSentIds().size - idsBeforePair.size
      expect(pairHealthyEvents).toBeGreaterThan(0)
      const receivedAfterPair = (await readyStatus(gateway)).receivedEventCount
      const totalIsolated = (await readyStatus(gateway)).isolatedEventCount
      // 同口径配对：健康 turn 在采集入口的记录接收数（receivedEventCount 差值）
      // 与每个窗口的隔离数相同——三个窗口的隔离总数 == 3 × 单 turn 接收数。
      expect(totalIsolated).toBe((receivedAfterPair - receivedBeforePair) * 3)
      await runTurn('post-logout')
      expect(await waitFor(async () => (await readyStatus(gateway)).queueEventCount === 0)).toBe(true)
      expect(batchPosts().filter(entry => entry.status === 202 && entry.auth === 'Bearer demo-token').length).toBeGreaterThan(0)
      const adminEvents = await originalFetch(`${BASE}/admin/projects/project-alpha/telemetry/events?from=2000-01-01T00:00:00.000Z&to=2100-01-01T00:00:00.000Z&limit=200`, {
        headers: { authorization: 'Bearer admin-demo' },
      })
      const adminText = JSON.stringify(await adminEvents.json())
      expect(adminText).not.toContain('window-login')
      expect(adminText).not.toContain('window-refresh')
      expect(adminText).not.toContain('window-logout')
      expectNoTokenLeak(await readyStatus(gateway))
    } finally {
      globalThis.fetch = recorderFetch
    }
  })

  it('R11 认证失败路径：错误口令登录失败后采集回到明确的既有账号分区（signed-out→static），不出现半切换', { timeout: 30_000 }, async () => {
    installFetchRecorder()
    await startService()
    const stateDirectory = await mkdtemp(join(tmpdir(), 'dsh-gw-authfail-'))
    const gateway = await buildGateway(new Context(), stateDirectory, 'demo-token')
    const fail = await gateway.login({ username: 'member@example.com', password: 'wrong-password' })
    expect(fail.status).not.toBe('authenticated')
    // 失败后无凭据 → 明确 signed-out，静态兜底接管（既有分区继续采集）。
    const baseline = await gateway.collectorStatus()
    expect(baseline.status === 'ready' ? baseline.value.mode : baseline.status).toBe('active')
    enqueueInto(stateDirectory, staticTokenEvent(101), 'static-token')
    expect(await waitFor(async () => (await readyStatus(gateway)).queueEventCount === 0)).toBe(true)
    const sent = batchPosts().filter(entry => entry.status === 202)
    expect(sent.length).toBeGreaterThan(0)
    expect(sent.every(entry => entry.auth === 'Bearer demo-token')).toBe(true)
    expectNoTokenLeak(await readyStatus(gateway))
  })

  it('R14 真实 Cordis 生命周期：wrapper 插件 fiber.dispose 触发构造期 effect（顺序：Reporter stop→最后 drain→Queue 只关一次）→ 重开可恢复、重复 dispose 幂等、关闭后入队显式 storage failure', { timeout: 30_000 }, async () => {
    installFetchRecorder()
    await startService()
    const state: { grant: Record<string, unknown> | undefined } = { grant: undefined }
    const stateDirectory = await mkdtemp(join(tmpdir(), 'dsh-gw-cordis-dispose-'))
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    // 0.1.5 drift: satisfy AgentLoop's new sessionProjections injection.
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('R14 answer')]))
    new MemoryCredentialProvider(ctx, state)

    // 顺序/次数捕获：原型级 spy 记录 Reporter stop、Reporter shutdown（含最后
    // drain）与 Queue close 的真实调用序列——不直接调用任何 dispose helper。
    const disposeOrder: string[] = []
    const reporterProto = TelemetryReporter.prototype as unknown as Record<string, unknown>
    const queueProto = TelemetryQueue.prototype as unknown as Record<string, unknown>
    const stopOriginal = reporterProto.stop as (this: TelemetryReporter) => void
    const shutdownOriginal = reporterProto.shutdown as (this: TelemetryReporter) => Promise<void>
    const closeOriginal = queueProto.close as (this: TelemetryQueue) => void
    const stopSpy = vi.spyOn(TelemetryReporter.prototype, 'stop').mockImplementation(function (this: TelemetryReporter) {
      disposeOrder.push('reporter.stop')
      stopOriginal.call(this)
    })
    const shutdownSpy = vi.spyOn(TelemetryReporter.prototype, 'shutdown').mockImplementation(function (this: TelemetryReporter): Promise<void> {
      disposeOrder.push('reporter.shutdown')
      void shutdownOriginal.call(this)
      return Promise.resolve()
    })
    const closeSpy = vi.spyOn(TelemetryQueue.prototype, 'close').mockImplementation(function (this: TelemetryQueue) {
      disposeOrder.push('queue.close')
      closeOriginal.call(this)
    })

    // 以 wrapper 插件装载：Gateway 在 wrapper 作用域内构造，构造期 effect 挂在
    // wrapper 的 fiber 上——真实 fiber.dispose 才是销毁触发器。
    const gatewayConfig = {
      apiBaseUrl: BASE,
      accessToken: 'demo-token',
      stateDirectory,
      globalSkillRoot: 'unused',
      telemetry: { flushIntervalMs: 60, claimTimeoutMs: 60_000 },
    }
    let gateway!: TeamSkillGateway
    // wrapper 插件只注入真实存在的 agents/sessions；构造器需要但本上下文不存在
    // 的 skills/workspaceRegistry 用 extend 遮蔽为自身属性（与根 ctx 上读取到
    // undefined 的行为一致），使属性访问不触发作用域限制。
    const wrapperFiber = await ctx.plugin({
      name: 'r14-gateway-wrapper',
      inject: ['agents', 'sessions'],
      apply: (scope: Context) => {
        const injected = scope as unknown as { agents: unknown; sessions: unknown }
        const childScope = scope.extend({
          agents: injected.agents,
          sessions: injected.sessions,
          skills: undefined,
          workspaceRegistry: undefined,
        }) as Context
        gateway = new TeamSkillGateway(childScope, gatewayConfig)
      },
    })
    expect(gateway, 'wrapper apply must have constructed the gateway').toBeInstanceOf(TeamSkillGateway)

    try {
      const agent = await ctx.agentLoop.create(SessionId('r14-session'), { provider: 'mock', model: 'mock' })
      expect((await gateway.login({ username: 'member@example.com', password: 'member-pass' })).status).toBe('authenticated')
      expect(await gateway.configureCollectorProject('r14-session', 'project-alpha')).toEqual({
        status: 'ready',
        value: { projectId: 'project-alpha' },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'R14 before dispose' }], source: { kind: 'user' } }))
      await new Promise<void>((resolve) => {
        const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
          if (subject === agent && status === 'idle') {
            dispose()
            resolve()
          }
        })
      })
      expect(await waitFor(async () => (await readyStatus(gateway)).queueEventCount === 0)).toBe(true)
      await gateway.logout()
      // dispose 前注入一条未发送行（member 分区，signed-out 后静态兜底不发送该分区）。
      enqueueInto(stateDirectory, staticTokenEvent(91), 'member-1')
      expect(await waitFor(async () => (await readyStatus(gateway)).queueEventCount === 1)).toBe(true)

      // 真实 Cordis 销毁路径：wrapper fiber.dispose（插件卸载）→ 构造期 effect。
      // 只考察 dispose 起点之后的记录（enqueueInto 的独立句柄 close 在此前发生）。
      const disposeStart = disposeOrder.length
      // 真实销毁：单次 fiber.dispose 触发构造期 effect（停止 Reporter → 最后
      // drain → 关闭 Queue）。不直接调用 disposeCollector 作为生命周期证据。
      await wrapperFiber.dispose()
      const disposeSequence = disposeOrder.slice(disposeStart)

      // 顺序与次数：Reporter shutdown（停止计时器 + 最后 drain；stop 在其内部
      // 触发）先于 Queue close；Gateway 自身队列只关一次。disposeOrder 里
      // shutdown 记录先于其内部嵌套的 stop 记录，因此以 close 晚于两者为准。
      expect(disposeSequence).toContain('reporter.stop')
      expect(disposeSequence).toContain('reporter.shutdown')
      expect(disposeSequence.indexOf('queue.close')).toBeGreaterThan(disposeSequence.indexOf('reporter.shutdown'))
      expect(disposeSequence.indexOf('queue.close')).toBeGreaterThan(disposeSequence.indexOf('reporter.stop'))
      console.log('R14SEQ', JSON.stringify(disposeSequence), 'post-idem', JSON.stringify(disposeOrder.slice(disposeStart)))
      expect(disposeSequence.filter(entry => entry === 'queue.close').length).toBe(1)
      // 重复销毁幂等：disposeCollector（collectorDisposed 守卫）与队列 close
      // 守卫保证后续调用零新增关闭。
      await gateway.disposeCollector()
      await gateway.disposeCollector()
      expect(disposeOrder.slice(disposeStart).filter(entry => entry === 'queue.close').length).toBe(1)

      // 重开同一数据库：行完整保留、无锁残留。
      const settings = {
        maxEvents: 1000, maxBytes: 1024 * 1024, batchMaxEvents: 50, batchMaxBytes: 256 * 1024,
        flushIntervalMs: 60, httpTimeoutMs: 500, maxAttempts: 3, retentionMs: 24 * 60 * 60 * 1000, claimTimeoutMs: 60_000,
      }
      const reopened = TelemetryQueue.open(stateDirectory, settings)
      try {
        // 未发送的注入行（member 分区）在重开库中完整可恢复；dispose 期间卸载
        // 流程还会写入会话收尾事件，因此只断言目标行存在而非总数。
        const pendingMember = reopened.pendingBatch('member-1', Date.now() + 600_000)
        expect(pendingMember?.events.map(event => event.eventId)).toContain('gw-static-91')
        expect(reopened.counts().events).toBeGreaterThanOrEqual(1)
      } finally {
        reopened.close()
      }
      // 真实插件卸载后采集管线整体摘除：post-dispose turn 的事件不再到达采集
      // 入口（receivedEventCount 不变）、队列为空、无任何新批次——句柄/监听器无残留。
      const receivedBeforePostDispose = (await readyStatus(gateway)).receivedEventCount
      const batchCountBeforePostDispose = batchPosts().length
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'R14 after dispose' }], source: { kind: 'user' } }))
      await new Promise<void>((resolve) => {
        const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
          if (subject === agent && status === 'idle') {
            dispose()
            resolve()
          }
        })
      })
      await new Promise(resolve => setTimeout(resolve, 300))
      const postDisposeStatus = await readyStatus(gateway)
      expect(postDisposeStatus.receivedEventCount).toBe(receivedBeforePostDispose)
      expect(postDisposeStatus.queueEventCount).toBe(0)
      expect(batchPosts().length).toBe(batchCountBeforePostDispose)
    } finally {
      stopSpy.mockRestore()
      shutdownSpy.mockRestore()
      closeSpy.mockRestore()
    }
  })

  it('R14 补充：effect disposer 关闭队列后，真实 turn 入队失败返回明确 storage failure（mode=storage-error）', { timeout: 30_000 }, async () => {
    installFetchRecorder()
    await startService()
    const state: { grant: Record<string, unknown> | undefined } = { grant: undefined }
    const stateDirectory = await mkdtemp(join(tmpdir(), 'dsh-gw-dispose-sf-'))
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    // 0.1.5 drift: satisfy AgentLoop's new sessionProjections injection.
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('R14 sf answer')]))
    new MemoryCredentialProvider(ctx, state)
    const gateway = new TeamSkillGateway(ctx, {
      apiBaseUrl: BASE,
      accessToken: 'demo-token',
      stateDirectory,
      globalSkillRoot: 'unused',
      telemetry: { flushIntervalMs: 60, claimTimeoutMs: 60_000 },
    })
    const agent = await ctx.agentLoop.create(SessionId('r14sf-session'), { provider: 'mock', model: 'mock' })
    expect((await gateway.login({ username: 'member@example.com', password: 'member-pass' })).status).toBe('authenticated')
    expect(await gateway.configureCollectorProject('r14sf-session', 'project-alpha')).toEqual({
      status: 'ready',
      value: { projectId: 'project-alpha' },
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'R14 sf before' }], source: { kind: 'user' } }))
    await new Promise<void>((resolve) => {
      const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
        if (subject === agent && status === 'idle') {
          dispose()
          resolve()
        }
      })
    })
    expect(await waitFor(async () => (await readyStatus(gateway)).queueEventCount === 0)).toBe(true)
    await gateway.logout()
    await new Promise(resolve => setTimeout(resolve, 400))

    // 关闭队列（真实 effect disposer 路径），随后真实 turn 入队失败 → storage-error。
    await gateway.collectorDisposeEffect()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'R14 sf after close' }], source: { kind: 'user' } }))
    await new Promise<void>((resolve) => {
      const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
        if (subject === agent && status === 'idle') {
          dispose()
          resolve()
        }
      })
    })
    const postDispose = await gateway.collectorStatus()
    expect(postDispose.status === 'ready' ? postDispose.value.mode : postDispose.status).toBe('storage-error')
  })

  it('S2/R8 刷新失败（真实 /auth/refresh 401）→ signed-out：双分区行都保留、稳定窗口零批次请求（无静态 Token 部署，接管语义另见 S2b）', { timeout: 20_000 }, async () => {
    installFetchRecorder()
    await startService()
    const state: { grant: Record<string, unknown> | undefined } = { grant: undefined }
    const stateDirectory = await mkdtemp(join(tmpdir(), 'dsh-gw-refresh-fail-'))
    const ctx = new Context()
    new MemoryCredentialProvider(ctx, state)
    // 无静态 Token 部署：刷新失败后不存在任何兜底身份，signed-out 是终态，
    // 零发送窗口因此永久稳定——member 与 static-token 对照行都不可能被发送。
    const gateway = await buildGateway(ctx, stateDirectory, undefined)
    expect((await gateway.login({ username: 'member@example.com', password: 'member-pass' })).status).toBe('authenticated')
    expect(state.grant).toBeDefined()

    // 令牌过期 + 垃圾 refresh token：reporter drain 时真实请求 /auth/refresh 必失败。
    state.grant = { ...(state.grant as Record<string, unknown>), refreshToken: 'garbage-refresh-token', expiresAt: Date.now() - 60_000 }
    // R8：member 与 static-token 两个分区同时注入，失败时两者都必须保留。
    enqueueInto(stateDirectory, staticTokenEvent(31), 'member-1')
    enqueueInto(stateDirectory, staticTokenEvent(32), 'static-token')

    // 真实链路：Gateway → Reporter drain → Host accountRequest → /auth/refresh 401 → signed-out。
    expect(await waitFor(async () => (await readyStatus(gateway)).mode === 'signed-out')).toBe(true)
    // R8 零批次断言：直接断言没有任何 /telemetry/batches 请求（不限状态码——
    // 非 202 响应也是一次请求，不得被“仅数 202”误判为零发送）。
    expect(batchPosts()).toEqual([])
    const refreshAttempts = recorded.filter(entry => entry.path.endsWith('/auth/refresh'))
    expect(refreshAttempts.length).toBeGreaterThan(0)
    expect(refreshAttempts.every(entry => entry.status === 401)).toBe(true)
    // 两个分区行都保留；零发送在无兜底部署下永久稳定（再观察 400ms 复核）。
    const status = await readyStatus(gateway)
    expect(status.mode).toBe('signed-out')
    expect(status.queueEventCount).toBe(2)
    expect(await adminEventCount()).toBe(0)
    expect(state.grant).toBeUndefined()
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(batchPosts()).toEqual([])
    expect((await readyStatus(gateway)).queueEventCount).toBe(2)
    expect(await adminEventCount()).toBe(0)
    expectNoTokenLeak(status)
  })

  it('S2b/R2 状态转换：刷新失败→确认 signed-out（凭据清除）→静态兜底接管，仅静态分区发送、member 行保留', { timeout: 20_000 }, async () => {
    installFetchRecorder()
    await startService()
    const state: { grant: Record<string, unknown> | undefined } = { grant: undefined }
    const stateDirectory = await mkdtemp(join(tmpdir(), 'dsh-gw-s2b-'))
    const ctx = new Context()
    new MemoryCredentialProvider(ctx, state)
    // 周期拉到足够长：本用例显式驱动每一次 drain（flushCollector），
    // 不再让断言与 60ms 的上报定时器赛跑。signed-out 是「凭据已清除」到
    // 「下一次 drain 重新解析账号」之间的真实瞬态（静态兜底部署下，下一次
    // drain 会立刻把账号解析成静态分区并把模式拉回 active），用 50ms 轮询采样
    // 一个几十毫秒的瞬态必然随负载丢样——这正是本用例此前在聚合跑下反复转红的
    // 机制（红跑日志按 §11.4 保留）。显式驱动后两段状态都是**不动点**，可稳定断言。
    const gateway = await buildGateway(ctx, stateDirectory, 'demo-token', { flushIntervalMs: 3_600_000, claimTimeoutMs: 60_000 })
    expect((await gateway.login({ username: 'member@example.com', password: 'member-pass' })).status).toBe('authenticated')
    state.grant = { ...(state.grant as Record<string, unknown>), refreshToken: 'garbage-refresh-token', expiresAt: Date.now() - 60_000 }
    enqueueInto(stateDirectory, staticTokenEvent(81), 'member-1')
    enqueueInto(stateDirectory, staticTokenEvent(82), 'static-token')

    // 阶段一（失败窗口）：显式 drain 用 member 分区发送 → 401 → 真实 /auth/refresh 401
    // → 凭据被清除 → 该次发送的结果就是 signed-out，模式停在这个不动点上。
    await gateway.flushCollector()
    expect(await waitFor(async () => (await readyStatus(gateway)).mode === 'signed-out')).toBe(true)
    const refreshAttempts = recorded.filter(entry => entry.path.endsWith('/auth/refresh'))
    expect(refreshAttempts.length).toBeGreaterThan(0)
    expect(refreshAttempts.every(entry => entry.status === 401)).toBe(true)
    expect(state.grant).toBeUndefined()
    // 阶段二（确认 signed-out 后的状态转换）：再一次显式 drain → 账号解析为静态兜底
    // 分区 → 模式回到 active 并只排空静态分区行，member 分区行保留不被发送不清空。
    await gateway.flushCollector()
    expect(await waitFor(async () => batchPosts().some(entry => entry.status === 202 && entry.auth === 'Bearer demo-token'))).toBe(true)
    expect((await readyStatus(gateway)).mode).toBe('active')
    const takeoverBatches = batchPosts().filter(entry => entry.status === 202)
    expect(takeoverBatches.every(entry => entry.auth === 'Bearer demo-token')).toBe(true)
    const sentIds = takeoverBatches.flatMap((entry) => {
      const body = entry.bodyJson as { events?: Array<{ event_id: string }> } | undefined
      return body?.events?.map(event => event.event_id) ?? []
    })
    expect(sentIds).toContain(staticTokenEvent(82).eventId)
    expect(sentIds).not.toContain(staticTokenEvent(81).eventId)
    expect((await readyStatus(gateway)).queueEventCount).toBe(1)
    expect(await adminEventCount()).toBe(1)
    expectNoTokenLeak(await readyStatus(gateway))
  })


  it('S3 无凭据 + 静态 Token → reporter 实际 drain，Authorization 为静态 Token', async () => {
    installFetchRecorder()
    await startService()
    const stateDirectory = await mkdtemp(join(tmpdir(), 'dsh-gw-static-'))
    const gateway = await buildGateway(new Context(), stateDirectory, 'demo-token')
    enqueueInto(stateDirectory, staticTokenEvent(1), 'static-token')
    expect(await waitFor(async () => (await readyStatus(gateway)).queueEventCount === 0)).toBe(true)
    const status = await readyStatus(gateway)
    expect(status.mode).toBe('active')
    expect(status.lastAcceptedAt).not.toBeNull()
    // Authorization 断言：批次以静态 Token 发送。
    const sent = batchPosts().filter(entry => entry.status === 202)
    expect(sent.length).toBeGreaterThan(0)
    expect(sent.every(entry => entry.auth === 'Bearer demo-token')).toBe(true)
    expect(await adminEventCount()).toBeGreaterThan(0)
    expectNoTokenLeak(status)
  })

  it('S4 明确登出 + 静态 Token → 静态兜底接管（Authorization 切换），旧分区行保留', { timeout: 20_000 }, async () => {
    installFetchRecorder()
    await startService()
    const state: { grant: Record<string, unknown> | undefined } = { grant: undefined }
    const stateDirectory = await mkdtemp(join(tmpdir(), 'dsh-gw-logout-'))
    const ctx = new Context()
    new MemoryCredentialProvider(ctx, state)
    const gateway = await buildGateway(ctx, stateDirectory, 'demo-token')
    expect((await gateway.login({ username: 'member@example.com', password: 'member-pass' })).status).toBe('authenticated')

    // 登录态：member 分区 drain，Authorization 为登录会话 Token。
    enqueueInto(stateDirectory, staticTokenEvent(11), 'member-1')
    expect(await waitFor(async () => (await readyStatus(gateway)).queueEventCount === 0)).toBe(true)
    const loginSent = batchPosts().filter(entry => entry.status === 202)
    expect(loginSent.length).toBeGreaterThan(0)
    expect(loginSent.every(entry => entry.auth !== null && entry.auth.startsWith('Bearer access-'))).toBe(true)
    const afterLogin = await adminEventCount()
    expect(afterLogin).toBeGreaterThan(0)

    // 登出：旧 member 分区行停止发送且保留；静态分区行以静态 Token 兜底发送。
    await gateway.logout()
    enqueueInto(stateDirectory, staticTokenEvent(14), 'member-1')
    enqueueInto(stateDirectory, staticTokenEvent(13), 'static-token')
    expect(await waitFor(async () => (await readyStatus(gateway)).queueEventCount === 1)).toBe(true)
    const logoutSent = batchPosts().filter(entry => entry.status === 202 && entry.auth === 'Bearer demo-token')
    expect(logoutSent.length).toBeGreaterThan(0)
    const afterLogout = await adminEventCount()
    expect(afterLogout).toBeGreaterThan(afterLogin)
    // member 分区残留行不被发送也不被清空。
    await new Promise(resolve => setTimeout(resolve, 600))
    expect((await readyStatus(gateway)).queueEventCount).toBe(1)
    expect(await adminEventCount()).toBe(afterLogout)
    expectNoTokenLeak(await readyStatus(gateway))
  })

  it('S5/R9 登录态优先：member 行以登录 Authorization 发送，static-token 对照行不发送且留在队列', async () => {
    installFetchRecorder()
    await startService()
    const state: { grant: Record<string, unknown> | undefined } = { grant: undefined }
    const stateDirectory = await mkdtemp(join(tmpdir(), 'dsh-gw-precedence-'))
    const ctx = new Context()
    new MemoryCredentialProvider(ctx, state)
    const gateway = await buildGateway(ctx, stateDirectory, 'demo-token')
    expect((await gateway.login({ username: 'member@example.com', password: 'member-pass' })).status).toBe('authenticated')
    // R9：同时注入 member 与 static-token 两条不同 event ID 的对照事件。
    const memberRow = staticTokenEvent(41)
    const staticRow = staticTokenEvent(42)
    enqueueInto(stateDirectory, memberRow, 'member-1')
    enqueueInto(stateDirectory, staticRow, 'static-token')

    expect(await waitFor(async () => (await readyStatus(gateway)).queueEventCount === 1)).toBe(true)
    // R9：断言全部实际批次请求——member 行以登录 Authorization 发送；
    // 非空集合上的 every 才有效。
    const allBatches = batchPosts()
    expect(allBatches.length).toBeGreaterThan(0)
    expect(allBatches.every(entry => entry.status === 202)).toBe(true)
    expect(allBatches.every(entry => entry.auth !== null && entry.auth.startsWith('Bearer access-'))).toBe(true)
    expect(allBatches.some(entry => entry.auth === 'Bearer demo-token')).toBe(false)
    const sentIds = allBatches.flatMap((entry) => {
      const body = entry.bodyJson as { events?: Array<{ event_id: string }> } | undefined
      return body?.events?.map(e => e.event_id) ?? []
    })
    expect(sentIds).toContain(memberRow.eventId)
    expect(sentIds).not.toContain(staticRow.eventId)
    // static-token 对照行仍在队列。
    const status = await readyStatus(gateway)
    expect(status.queueEventCount).toBe(1)
    expectNoTokenLeak(status)
    // 后台核对：member 行可见、static 行不在。
    const adminEvents = await originalFetch(`${BASE}/admin/projects/project-alpha/telemetry/events?from=2000-01-01T00:00:00.000Z&to=2100-01-01T00:00:00.000Z&limit=200`, {
      headers: { authorization: 'Bearer admin-demo' },
    })
    const adminBody = (await adminEvents.json()) as { data?: { items?: Array<{ event_id: string }> } | undefined }
    const adminIds = (adminBody.data?.items ?? []).map(item => item.event_id)
    expect(adminIds).toContain(memberRow.eventId)
    expect(adminIds).not.toContain(staticRow.eventId)
  })

  it('S7/R8 非 202 批次响应也是一次请求（挂起成员 → 401），行保留且 attempts 递增', async () => {
    installFetchRecorder()
    await startService()
    const stateDirectory = await mkdtemp(join(tmpdir(), 'dsh-gw-suspended-'))
    await buildGateway(new Context(), stateDirectory, 'demo-token')
    enqueueInto(stateDirectory, staticTokenEvent(51), 'static-token')

    // 挂起 member-1（demo-token 所属用户）：批次请求得到 401（非 202）。
    const usersRes = await originalFetch(`${BASE}/admin/users`, { headers: { authorization: 'Bearer admin-demo' } })
    const usersBody = (await usersRes.json()) as { data?: { items?: Array<{ user_id: string; revision: number }> } }
    const memberRevision = usersBody.data?.items?.find(u => u.user_id === 'member-1')?.revision ?? 1
    const suspend = await originalFetch(`${BASE}/admin/users/member-1`, {
      method: 'PATCH',
      headers: { authorization: 'Bearer admin-demo', 'content-type': 'application/json', 'Idempotency-Key': `susp-${Date.now()}`, 'If-Match': String(memberRevision) },
      body: JSON.stringify({ status: 'suspended' }),
    })
    expect(suspend.status).toBe(200)

    // R8 红（故意失败）：断言零批次——但非 202 的批次请求确实发生了，该断言必须失败。
    expect(await waitFor(async () => batchPosts().length > 0)).toBe(true)
    const failedBatch = batchPosts().find(entry => entry.status !== 202)
    expect(failedBatch).toBeDefined()
    expect(() => {
      expect(batchPosts()).toEqual([])
    }).toThrow()

    // 绿（正确口径）：非 202 请求被如实记录为一次请求。
    expect(failedBatch?.status).toBe(401)
  })

  it('R16 归档项目拒绝绑定：admin 归档 project-alpha 后换绑被拒（RESOURCE_NOT_FOUND 语义），绑定不创建', { timeout: 20_000 }, async () => {
    installFetchRecorder()
    await startService()
    const stateDirectory = await mkdtemp(join(tmpdir(), 'dsh-gw-archive-'))
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    // 0.1.5 drift: satisfy AgentLoop's new sessionProjections injection.
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    new MemoryCredentialProvider(ctx, { grant: undefined } as { grant: Record<string, unknown> | undefined })
    // 直接构造（buildGateway 会重复注册 sessions 服务）。
    const gateway = new TeamSkillGateway(ctx, {
      apiBaseUrl: BASE,
      accessToken: 'demo-token',
      stateDirectory,
      globalSkillRoot: 'unused',
      telemetry: { flushIntervalMs: 60, claimTimeoutMs: 60_000 },
    })
    expect((await gateway.login({ username: 'member@example.com', password: 'member-pass' })).status).toBe('authenticated')
    await ctx.agentLoop.create(SessionId('r16a-session'), { provider: 'mock', model: 'mock' })

    // 先证明归档前可以正常绑定（基线）。
    expect(await gateway.configureCollectorProject('r16a-session', 'project-alpha')).toEqual({
      status: 'ready',
      value: { projectId: 'project-alpha' },
    })
    // admin 归档 project-alpha（If-Match 当前 revision=1）。
    const archive = await originalFetch(`${BASE}/admin/projects/project-alpha:archive`, {
      method: 'POST',
      headers: { authorization: 'Bearer admin-demo', 'content-type': 'application/json', 'Idempotency-Key': `archive-${Date.now()}`, 'If-Match': '1' },
      body: JSON.stringify({}),
    })
    expect(archive.status).toBe(200)
    // 解除绑定后重新换绑归档项目：服务端授权确认拒绝（归档=RESOURCE_NOT_FOUND 语义），
    // 不创建 binding。
    await gateway.clearCollectorProject('r16a-session')
    const rebind = await gateway.configureCollectorProject('r16a-session', 'project-alpha')
    expect(rebind).toMatchObject({ status: 'failed', code: 'PROJECT_NOT_AUTHORIZED' })
    expect(await readyStatus(gateway)).toMatchObject({ projectId: null })
  })

  it('R16 换绑前经服务端授权确认：未授权项目绑定保持不变，A→B 原子切换，登出后拒绝换绑', { timeout: 20_000 }, async () => {
    installFetchRecorder()
    await startService()
    const state: { grant: Record<string, unknown> | undefined } = { grant: undefined }
    const stateDirectory = await mkdtemp(join(tmpdir(), 'dsh-gw-rebind-'))
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    // 0.1.5 drift: satisfy AgentLoop's new sessionProjections injection.
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    new MemoryCredentialProvider(ctx, state)
    // SessionStore 已在上方安装；这里直接构造 Gateway，避免重复注册 sessions 服务。
    const gateway = new TeamSkillGateway(ctx, {
      apiBaseUrl: BASE,
      accessToken: 'demo-token',
      stateDirectory,
      globalSkillRoot: 'unused',
      telemetry: { flushIntervalMs: 60, claimTimeoutMs: 60_000 },
    })
    expect((await gateway.login({ username: 'member@example.com', password: 'member-pass' })).status).toBe('authenticated')
    await ctx.agentLoop.create(SessionId('r16-session'), { provider: 'mock', model: 'mock' })

    // 绑定 A（member-1 已授权 project-alpha）。
    expect(await gateway.configureCollectorProject('r16-session', 'project-alpha')).toEqual({
      status: 'ready',
      value: { projectId: 'project-alpha' },
    })
    expect(await readyStatus(gateway)).toMatchObject({ projectId: 'project-alpha' })

    // 绕过 UI 直接换绑未授权的 project-beta（seed members 为空）→ 拒绝且绑定保持 A。
    expect(await gateway.configureCollectorProject('r16-session', 'project-beta')).toMatchObject({
      status: 'failed',
      code: 'PROJECT_NOT_AUTHORIZED',
    })
    expect(await readyStatus(gateway)).toMatchObject({ projectId: 'project-alpha' })

    // A→B：管理员先授予 org-beta 组织成员关系，再加入 project-beta，换绑完整生效。
    const orgGrant = await originalFetch(`${BASE}/admin/organizations/org-beta/members/member-1`, {
      method: 'PUT',
      headers: { authorization: 'Bearer admin-demo', 'content-type': 'application/json', 'Idempotency-Key': `org-grant-${Date.now()}`, 'If-Match': '1' },
      body: JSON.stringify({}),
    })
    expect(orgGrant.status).toBe(200)
    const grant = await originalFetch(`${BASE}/admin/projects/project-beta/members/member-1`, {
      method: 'PUT',
      headers: { authorization: 'Bearer admin-demo', 'content-type': 'application/json', 'Idempotency-Key': `grant-${Date.now()}`, 'If-Match': '1' },
      body: JSON.stringify({}),
    })
    expect(grant.status).toBe(200)
    expect(await gateway.configureCollectorProject('r16-session', 'project-beta')).toEqual({
      status: 'ready',
      value: { projectId: 'project-beta' },
    })
    expect(await readyStatus(gateway)).toMatchObject({ projectId: 'project-beta' })

    // 登出后换绑回 A：服务端无法确认授权 → ACCOUNT_SIGNED_OUT，绑定保持 B。
    expect((await gateway.logout()).status).toBe('signed-out')
    expect(await gateway.configureCollectorProject('r16-session', 'project-alpha')).toMatchObject({
      status: 'failed',
      code: 'ACCOUNT_SIGNED_OUT',
    })
    expect(await readyStatus(gateway)).toMatchObject({ projectId: 'project-beta' })
  })

  it('R11 登录/登出采集窗口消除：logout 返回后的真实采集进入静态分区并以静态 Token 发送', { timeout: 30_000 }, async () => {
    installFetchRecorder()
    await startService()
    const state: { grant: Record<string, unknown> | undefined } = { grant: undefined }
    const stateDirectory = await mkdtemp(join(tmpdir(), 'dsh-gw-window-'))
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    // 0.1.5 drift: satisfy AgentLoop's new sessionProjections injection.
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('assistant answer body')]))
    new MemoryCredentialProvider(ctx, state)
    const gateway = new TeamSkillGateway(ctx, {
      apiBaseUrl: BASE,
      accessToken: 'demo-token',
      stateDirectory,
      globalSkillRoot: 'unused',
      telemetry: { flushIntervalMs: 60, claimTimeoutMs: 60_000 },
    })
    expect((await gateway.login({ username: 'member@example.com', password: 'member-pass' })).status).toBe('authenticated')
    const agent = await ctx.agentLoop.create(SessionId('r11-session'), { provider: 'mock', model: 'mock' })
    expect(await gateway.configureCollectorProject('r11-session', 'project-alpha')).toEqual({
      status: 'ready',
      value: { projectId: 'project-alpha' },
    })
    const runTurn = async (): Promise<void> => {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'R11 prompt' }], source: { kind: 'user' } }))
      await new Promise<void>((resolve) => {
        const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
          if (subject === agent && status === 'idle') {
            dispose()
            resolve()
          }
        })
      })
    }

    // 登录态 turn：采集进 member 分区，以登录 Authorization 发送。
    await runTurn()
    expect(await waitFor(async () => (await readyStatus(gateway)).queueEventCount === 0)).toBe(true)
    const afterLoginBatches = batchPosts().filter(entry => entry.status === 202)
    expect(afterLoginBatches.length).toBeGreaterThan(0)
    expect(afterLoginBatches.every(entry => entry.auth !== null && entry.auth.startsWith('Bearer access-'))).toBe(true)

    // 登出后的真实采集（非手工注入）：静态分区接管，Authorization 切到静态 Token。
    expect((await gateway.logout()).status).toBe('signed-out')
    await runTurn()
    expect(await waitFor(async () => (await readyStatus(gateway)).queueEventCount === 0)).toBe(true)
    const allSent = batchPosts().filter(entry => entry.status === 202)
    const logoutSent = allSent.slice(afterLoginBatches.length)
    expect(logoutSent.length).toBeGreaterThan(0)
    expect(logoutSent.every(entry => entry.auth === 'Bearer demo-token')).toBe(true)
    expectNoTokenLeak(await readyStatus(gateway))
  })

  it('R14 Cordis dispose 关闭 TelemetryQueue：关闭后可重新打开且队列行完整保留', async () => {
    installFetchRecorder()
    await startService()
    const stateDirectory = await mkdtemp(join(tmpdir(), 'dsh-gw-dispose-'))
    const ctx = new Context()
    const gateway = await buildGateway(ctx, stateDirectory, undefined)
    enqueueInto(stateDirectory, staticTokenEvent(61), 'static-token')
    expect(await waitFor(async () => (await readyStatus(gateway)).queueEventCount === 1)).toBe(true)

    // Cordis 关闭 effect（构造时注册）最终调用 disposeCollector：
    // 停止 Reporter、完成最终 drain（signed-out 停止）并 close 队列。
    await gateway.disposeCollector()
    // dispose 后重新打开同一数据库：无损坏、无锁残留、行完整保留。
    const reopened = TelemetryQueue.open(stateDirectory, {
      maxEvents: 1000,
      maxBytes: 1024 * 1024,
      batchMaxEvents: 50,
      batchMaxBytes: 256 * 1024,
      flushIntervalMs: 60,
      httpTimeoutMs: 500,
      maxAttempts: 3,
      retentionMs: 24 * 60 * 60 * 1000,
      claimTimeoutMs: 60_000,
    })
    try {
      expect(reopened.counts().events).toBe(1)
    } finally {
      reopened.close()
    }
  })

  it('S6/R8 无登录态且无静态 Token → signed-out：零批次请求、队列保留', async () => {
    installFetchRecorder()
    await startService()
    const stateDirectory = await mkdtemp(join(tmpdir(), 'dsh-gw-neither-'))
    const gateway = await buildGateway(new Context(), stateDirectory, undefined)
    enqueueInto(stateDirectory, staticTokenEvent(2), 'static-token')
    await new Promise(resolve => setTimeout(resolve, 400))
    const status = await readyStatus(gateway)
    expect(status.mode).toBe('signed-out')
    // R8 零批次断言：任何 /telemetry/batches 请求（含非 202）都不允许。
    expect(batchPosts()).toEqual([])
    expect(status.queueEventCount).toBe(1)
    expect(await adminEventCount()).toBe(0)
    expectNoTokenLeak(status)
  })
})
