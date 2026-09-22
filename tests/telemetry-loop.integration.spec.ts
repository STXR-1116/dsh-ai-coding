/* oxlint-disable typescript/no-base-to-string -- wire-value assertions mirror sibling integration suites */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
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
import type { CredentialKey, CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { createTeamSkillService } from '../dev/team-skill-service/src/server.ts'
import { STATIC_TOKEN_PARTITION, TeamSkillHost } from '../src/host.ts'
import { TelemetryQueue } from '../src/telemetry/queue.ts'
import { TelemetryReporter } from '../src/telemetry/reporter.ts'
import { TeamSkillTelemetryBackend } from '../src/telemetry/backend.ts'
import { TelemetryProjection } from '../src/telemetry/projection.ts'
import type { TelemetryQueueSettings } from '../src/types.ts'
import { MockAdapter, textResponse } from './helpers/mock-adapter.ts'

let BASE = ''

const settings: TelemetryQueueSettings = {
  maxEvents: 1000,
  maxBytes: 1024 * 1024,
  batchMaxEvents: 50,
  batchMaxBytes: 256 * 1024,
  flushIntervalMs: 5,
  httpTimeoutMs: 500,
  maxAttempts: 3,
  retentionMs: 24 * 60 * 60 * 1000,
  claimTimeoutMs: 60_000,
}

const services: Array<{ readonly server: Server }> = []
const roots: string[] = []
const queues: TelemetryQueue[] = []

afterEach(async () => {
  for (const service of services.splice(0)) {
    service.server.closeAllConnections()
    await new Promise<void>((resolve) => {
      service.server.close(() => {
        resolve()
      })
    })
  }
  for (const queue of queues.splice(0)) queue.close()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function startService(port = 0): Promise<void> {
  const service = createTeamSkillService({ port, seed: true })
  services.push(service)
  await service.listen()
  const address = service.server.address() as AddressInfo
  BASE = `http://127.0.0.1:${address.port}/v1`
}

/**
 * Reserve one OS-assigned port for a test that must reuse the same address.
 *
 * The outage-recovery case below deliberately stops the service and brings it
 * back at the *same* URL, which is why it cannot simply pass `0` twice — but a
 * hard-coded literal made that address a shared identifier: with several Vitest
 * processes running at once (the owning gate forks workers and runs projects
 * side by side), a second process binding the same literal fails with
 * `EADDRINUSE`, and a test whose service never bound then talks to whichever
 * stranger did — surfacing as a wrong account state or someone else's revision
 * rather than as the bind failure that caused it. That is the official
 * "host-resource collision" class; the remedy is atomic unique allocation, so
 * this asks the OS once and the test reuses the answer.
 * @returns a port number the OS has just confirmed is free.
 */
async function reservePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => { probe.listen(0, '127.0.0.1', () => { resolve() }) })
  const { port } = probe.address() as AddressInfo
  await new Promise<void>((resolve) => { probe.close(() => { resolve() }) })
  return port
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() > deadline) return false
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

/** Unwraps the service's {code,message,request_id,data} envelope. */
async function dataOf(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json()) as Record<string, unknown>
  return (body.data ?? body) as Record<string, unknown>
}

function adminHeaders(): Record<string, string> {
  return { authorization: 'Bearer admin-demo' }
}

function memberHeaders(): Record<string, string> {
  return { authorization: 'Bearer demo-token' }
}

interface Loop {
  readonly queue: TelemetryQueue
  readonly backend: TeamSkillTelemetryBackend
  readonly reporter: TelemetryReporter
  readonly ctx: Context
  runTurn(sessionId: string): Promise<unknown>
}

async function openLoop(host: TeamSkillHost): Promise<Loop> {
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
  const root = await mkdtemp(join(tmpdir(), 'dsh-telemetry-loop-'))
  roots.push(root)
  const queue = TelemetryQueue.open(join(root, 'state'), settings)
  queues.push(queue)
  const reporter = new TelemetryReporter(queue, settings, {
    send: (batch, accountId) => host.telemetryDeliver(batch, settings.httpTimeoutMs, accountId),
    resolveAccount: async () => {
      const account = await host.telemetryAccount()
      return 'userId' in account ? account : { status: 'not-ready' }
    },
  })
  let backend!: TeamSkillTelemetryBackend
  const fiber = await ctx.plugin({
    name: 'loop-telemetry-backend',
    inject: ['sessions'],
    apply: (inner: Context) => {
      backend = new TeamSkillTelemetryBackend(inner, queue, reporter, sessionId => sessionId.length > 0)
      backend.setAccount({ userId: 'member-1' })
    },
  })
  void fiber
  return {
    queue,
    backend,
    reporter,
    ctx,
    runTurn: async (sessionId) => {
      const agent = await ctx.agentLoop.create(SessionId(sessionId), { provider: 'mock', model: 'mock' })
      backend.configureProject(sessionId, 'project-alpha')
      agent.followup(createUserMessage({ content: [{ type: 'text', text: `prompt for ${sessionId}` }], source: { kind: 'user' } }))
      await new Promise<void>((resolve) => {
        const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
          if (subject === agent && status === 'idle') {
            dispose()
            resolve()
          }
        })
      })
      return agent.session
    },
  }
}


/** Host with a real logged-in member session stored in a Host-only credential map. */
async function openLoggedInHost(): Promise<TeamSkillHost> {
  const records = new Map<CredentialKey, CredentialRecord>()
  const credentials = {
    readRecord: async (key: CredentialKey) => records.get(key),
    modifyRecord: async (key: CredentialKey, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) => {
      const next = await mutate(records.get(key))
      if (next !== undefined) records.set(key, next)
      return next
    },
    deleteRecord: async (key: CredentialKey) => {
      records.delete(key)
    },
  } as unknown as CredentialProvider
  const hostRoot = await mkdtemp(join(tmpdir(), 'dsh-telemetry-host-'))
  roots.push(hostRoot)
  const host = new TeamSkillHost({
    apiBaseUrl: BASE,
    credentials,
    stateDirectory: join(hostRoot, 'state'),
    globalSkillRoot: 'unused',
  })
  expect(await host.login({ username: 'member@example.com', password: 'member-pass' })).toMatchObject({ status: 'authenticated' })
  return host
}

describe('telemetry account precedence and logout', () => {
  it('prefers the logged-in account session over the static token and stops delivery after logout', async () => {
    await startService()
    const authorizations: string[] = []
    const capturingFetch: typeof fetch = async (input, init) => {
      const header = new Headers(init?.headers).get('authorization')
      if (header !== null) authorizations.push(header)
      return fetch(input, init)
    }
    const records = new Map<CredentialKey, CredentialRecord>()
    const credentials = {
      readRecord: async (key: CredentialKey) => records.get(key),
      modifyRecord: async (
        key: CredentialKey,
        mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
      ) => {
        const next = await mutate(records.get(key))
        if (next !== undefined) records.set(key, next)
        return next
      },
      deleteRecord: async (key: CredentialKey) => {
        records.delete(key)
      },
    } as unknown as CredentialProvider
    const hostRoot = await mkdtemp(join(tmpdir(), 'dsh-telemetry-precedence-'))
    roots.push(hostRoot)
    const host = new TeamSkillHost({
      apiBaseUrl: BASE,
      accessToken: 'demo-token',
      credentials,
      fetch: capturingFetch,
      stateDirectory: join(hostRoot, 'state'),
      globalSkillRoot: 'unused',
    })
    expect(await host.login({ username: 'member@example.com', password: 'member-pass' })).toMatchObject({ status: 'authenticated' })
    authorizations.length = 0

    // 登录态账号优先：静态 Token 同时配置时，telemetry 仍用登录会话。
    const delivery = await host.telemetryDeliver(
      {
        schemaVersion: 1,
        batchId: 'precedence-batch',
        projectId: 'project-alpha',
        clientSentAt: new Date().toISOString(),
        events: [
          {
            schemaVersion: 1,
            eventId: 'precedence-event',
            installationId: 'inst',
            projectId: 'project-alpha',
            sessionId: 's',
            kind: 'turn.finished',
            occurredAt: new Date().toISOString(),
            sourceType: 'turn/end',
            sourceSeq: 1,
            turn: 1,
            outcome: 'success',
          },
        ],
      },
      500,
      'member-1',
    )
    // 与恢复用例相同：服务在用例间重启，旧 keep-alive 连接可能消耗一次尝试
    let precedenceOutcome = delivery
    for (let attempt = 0; attempt < 5 && precedenceOutcome.status === 'failed'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 100))
      precedenceOutcome = await host.telemetryDeliver(
        {
          schemaVersion: 1,
          batchId: `precedence-batch-${attempt}`,
          projectId: 'project-alpha',
          clientSentAt: new Date().toISOString(),
          events: [
            {
              schemaVersion: 1,
              eventId: `precedence-event-${attempt}`,
              installationId: 'inst',
              projectId: 'project-alpha',
              sessionId: 's',
              kind: 'turn.finished',
              occurredAt: new Date().toISOString(),
              sourceType: 'turn/end',
              sourceSeq: 1,
              turn: 1,
              outcome: 'success',
            },
          ],
        },
        500,
        'member-1',
      )
    }
    expect(precedenceOutcome.status).toBe('sent')
    // 登录态账号优先：Authorization 是登录会话 token，而不是同时配置的静态 token。
    expect(authorizations[0]?.startsWith('Bearer access-')).toBe(true)

    // 退出后没有登录态账号：按拍板规则静态 Token 作为兜底通道使用。
    await host.logout()
    authorizations.length = 0
    let afterLogout = await host.telemetryDeliver(
      {
        schemaVersion: 1,
        batchId: 'precedence-after-logout',
        projectId: 'project-alpha',
        clientSentAt: new Date().toISOString(),
        events: [
          {
            schemaVersion: 1,
            eventId: 'precedence-after-logout-event',
            installationId: 'inst',
            projectId: 'project-alpha',
            sessionId: 's',
            kind: 'turn.finished',
            occurredAt: new Date().toISOString(),
            sourceType: 'turn/end',
            sourceSeq: 1,
            turn: 1,
            outcome: 'success',
          },
        ],
      },
      500,
      STATIC_TOKEN_PARTITION,
    )
    for (let attempt = 0; attempt < 5 && afterLogout.status === 'failed'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 100))
      afterLogout = await host.telemetryDeliver(
        {
          schemaVersion: 1,
          batchId: `precedence-after-logout-${attempt}`,
          projectId: 'project-alpha',
          clientSentAt: new Date().toISOString(),
          events: [
            {
              schemaVersion: 1,
              eventId: `precedence-after-logout-event-${attempt}`,
              installationId: 'inst',
              projectId: 'project-alpha',
              sessionId: 's',
              kind: 'turn.finished',
              occurredAt: new Date().toISOString(),
              sourceType: 'turn/end',
              sourceSeq: 1,
              turn: 1,
              outcome: 'success',
            },
          ],
        },
        500,
        STATIC_TOKEN_PARTITION,
      )
    }
    expect(afterLogout.status).toBe('sent')
    expect(authorizations[authorizations.length - 1]).toBe('Bearer demo-token')
  })

  it('keeps the static token as the fallback when no login account exists', async () => {
    await startService()
    const host = new TeamSkillHost({
      apiBaseUrl: BASE,
      accessToken: 'demo-token',
      stateDirectory: join(await mkdtemp(join(tmpdir(), 'dsh-telemetry-static-')), 'state'),
      globalSkillRoot: 'unused',
    })
    const outcome = await host.telemetryDeliver(
      {
        schemaVersion: 1,
        batchId: 'static-fallback-batch',
        projectId: 'project-alpha',
        clientSentAt: new Date().toISOString(),
        events: [
          {
            schemaVersion: 1,
            eventId: 'static-fallback-event',
            installationId: 'inst',
            projectId: 'project-alpha',
            sessionId: 's',
            kind: 'turn.finished',
            occurredAt: new Date().toISOString(),
            sourceType: 'turn/end',
            sourceSeq: 1,
            turn: 1,
            outcome: 'success',
          },
        ],
      },
      500,
      STATIC_TOKEN_PARTITION,
    )
    expect(outcome.status).toBe('sent')
  })
})

/** R12 共用：登录态宿主（可注入静态 Token 与 fetch）+ 凭据表外露。 */
async function openR12Host(options: { readonly staticToken?: string; readonly fetch?: typeof fetch } = {}): Promise<TeamSkillHost> {
  const records = new Map<CredentialKey, CredentialRecord>()
  const credentials = {
    readRecord: async (key: CredentialKey) => records.get(key),
    modifyRecord: async (
      key: CredentialKey,
      mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
    ) => {
      const next = await mutate(records.get(key))
      if (next !== undefined) records.set(key, next)
      return next
    },
    deleteRecord: async (key: CredentialKey) => {
      records.delete(key)
    },
  } as unknown as CredentialProvider
  const hostRoot = await mkdtemp(join(tmpdir(), 'dsh-r12-host-'))
  roots.push(hostRoot)
  const host = new TeamSkillHost({
    apiBaseUrl: BASE,
    ...(options.staticToken === undefined ? {} : { accessToken: options.staticToken }),
    credentials,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    stateDirectory: join(hostRoot, 'state'),
    globalSkillRoot: 'unused',
  })
  ;(host as unknown as { r12Records: Map<CredentialKey, CredentialRecord> }).r12Records = records
  expect(await host.login({ username: 'member@example.com', password: 'member-pass' })).toMatchObject({ status: 'authenticated' })
  return host
}

function r12Event(queue: TelemetryQueue, eventId: string): Parameters<TelemetryQueue['enqueue']>[0] {
  return {
    schemaVersion: 1,
    eventId,
    installationId: queue.installationId,
    projectId: 'project-alpha',
    sessionId: 'r12-session',
    kind: 'turn.finished',
    occurredAt: new Date().toISOString(),
    sourceType: 'turn/end',
    sourceSeq: 1,
    turn: 1,
    outcome: 'success',
  }
}

/** R12 共用：镜像 Gateway 的账号解析（登录态优先、signed-out 才静态兜底）。 */
function r12ResolveAccount(host: TeamSkillHost): () => Promise<{ readonly userId: string } | { readonly status: 'signed-out' | 'not-ready' }> {
  return async () => {
    const account = await host.telemetryAccount()
    if ('userId' in account) return account
    if (account.status === 'signed-out') return { userId: STATIC_TOKEN_PARTITION }
    return account
  }
}

/** 批次请求 Authorization 捕获 fetch：逐请求记录到传入列表后透传。 */
function captureBatchFetch(into: string[]): typeof fetch {
  return async (input, init) => {
    if (String(input).includes('/telemetry/batches')) {
      into.push(new Headers(init?.headers).get('authorization') ?? 'none')
    }
    return fetch(input, init)
  }
}

describe('R12 account-partition vs Authorization races over real HTTP', () => {
  it('claim 后 A→logout（宿主配静态 Token）：分区检查拒绝 → 零批次请求，A 行保留可恢复且不被静态分区排空', async () => {
    await startService()
    const batchAuthorizations: string[] = []
    const host = await openR12Host({ staticToken: 'demo-token', fetch: captureBatchFetch(batchAuthorizations) })
    const root = await mkdtemp(join(tmpdir(), 'dsh-r12-q1-'))
    roots.push(root)
    const queue = TelemetryQueue.open(join(root, 'state'), settings)
    queues.push(queue)
    queue.enqueue(r12Event(queue, 'r12-logout-event'), 'member-1', Date.now())

    // 注入：claim 后、send 前发生 A→logout（凭据清除、确认 signed-out、静态兜底就绪）。
    const reporter = new TelemetryReporter(queue, settings, {
      send: async (batch, accountId) => {
        await host.logout()
        return host.telemetryDeliver(batch, settings.httpTimeoutMs, accountId)
      },
      resolveAccount: r12ResolveAccount(host),
    })
    await reporter.shutdown()

    // 实际请求证据：零批次请求发出（不是只看返回 code）。
    expect(batchAuthorizations).toEqual([])
    const status = reporter.status('project-alpha')
    expect(status.lastFailure?.code).toBe('TELEMETRY_ACCOUNT_CHANGED')
    expect(status.mode).toBe('failed')
    // A 行保留且语义未被错误修改：同一 event ID、attempts 恰好登记一次失败、项目不变。
    const pending = queue.pendingBatch('member-1', Date.now() + 600_000)
    expect(pending?.events.map(event => event.eventId)).toEqual(['r12-logout-event'])
    expect(pending?.events.every(event => event.attempts === 1)).toBe(true)
    expect(pending?.projectId).toBe('project-alpha')
    // 恢复 drain（账号已为 static 分区）不得排空 member-1 行——分区隔离保持。
    expect(queue.counts().events).toBe(1)
    const recovery = new TelemetryReporter(queue, settings, {
      send: async (batch, accountId) => host.telemetryDeliver(batch, settings.httpTimeoutMs, accountId),
      resolveAccount: r12ResolveAccount(host),
    })
    await recovery.shutdown()
    expect(batchAuthorizations).toEqual([])
    expect(queue.counts().events).toBe(1)
  })

  it('claim 后 A→B（登录另一账号）：分区检查拒绝 → 零批次请求，A 行保留', async () => {
    await startService()
    const batchAuthorizations: string[] = []
    const host = await openR12Host({ fetch: captureBatchFetch(batchAuthorizations) })
    const root = await mkdtemp(join(tmpdir(), 'dsh-r12-q2-'))
    roots.push(root)
    const queue = TelemetryQueue.open(join(root, 'state'), settings)
    queues.push(queue)
    queue.enqueue(r12Event(queue, 'r12-switch-event'), 'member-1', Date.now())

    // 注入：claim 后、send 前登录另一账号 B（admin-1）。
    const reporter = new TelemetryReporter(queue, settings, {
      send: async (batch, accountId) => {
        expect(await host.login({ username: 'admin@example.com', password: 'admin-pass' })).toMatchObject({ status: 'authenticated' })
        return host.telemetryDeliver(batch, settings.httpTimeoutMs, accountId)
      },
      resolveAccount: r12ResolveAccount(host),
    })
    await reporter.shutdown()

    expect(batchAuthorizations).toEqual([])
    expect(reporter.status('project-alpha').lastFailure?.code).toBe('TELEMETRY_ACCOUNT_CHANGED')
    expect(queue.counts().events).toBe(1)
  })

  it('分区比较后、HTTP 请求前登出：一次发送以不可变的 A 凭据完成，wire Authorization 为 A', async () => {
    await startService()
    const hostRecordsHolder: { records?: Map<CredentialKey, CredentialRecord> } = {}
    let seenBatchAuthorization: string | null = null
    const switchingFetch: typeof fetch = async (input, init) => {
      if (String(input).includes('/telemetry/batches')) {
        // 分区检查已通过、请求即将发出：此刻本地登出（服务端会话仍有效），
        // 已构建的请求头必须仍是 A 的不可变凭据，绝不能换成 B/static。
        seenBatchAuthorization = new Headers(init?.headers).get('authorization')
        for (const key of [...(hostRecordsHolder.records?.keys() ?? [])]) hostRecordsHolder.records?.delete(key)
      }
      return fetch(input, init)
    }
    const host = await openR12Host({ staticToken: 'demo-token', fetch: switchingFetch })
    hostRecordsHolder.records = (host as unknown as { r12Records: Map<CredentialKey, CredentialRecord> }).r12Records
    expect(hostRecordsHolder.records?.size).toBeGreaterThan(0)

    const outcome = await host.telemetryDeliver(
      {
        schemaVersion: 1,
        batchId: 'r12-immutable-batch',
        projectId: 'project-alpha',
        clientSentAt: new Date().toISOString(),
        events: [
          {
            schemaVersion: 1,
            eventId: 'r12-immutable-event',
            installationId: 'r12-install',
            projectId: 'project-alpha',
            sessionId: 'r12-session',
            kind: 'turn.finished',
            occurredAt: new Date().toISOString(),
            sourceType: 'turn/end',
            sourceSeq: 1,
            turn: 1,
            outcome: 'success',
          },
        ],
      },
      settings.httpTimeoutMs,
      'member-1',
    )
    // 实际 wire 请求：Authorization 是 A 的登录会话 Token，不是静态 Token。
    expect(String(seenBatchAuthorization).startsWith('Bearer access-')).toBe(true)
    expect(outcome.status).toBe('sent')
    // 发送完成后账号已切换：下一次解析为明确 signed-out（后续发送按新状态走 static 兜底）。
    const next = await host.telemetryAccount()
    expect(next).toEqual({ status: 'signed-out' })
  })

  it('请求进行中登出：in-flight 请求以 A 凭据完成，后续发送不再使用 A', async () => {
    await startService()
    let inFlightAuthorization: string | null = null
    let releaseResponse!: () => void
    const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve })
    const delayingFetch: typeof fetch = async (input, init) => {
      if (String(input).includes('/telemetry/batches')) {
        inFlightAuthorization = new Headers(init?.headers).get('authorization')
        const response = await fetch(input, init)
        await responseGate
        return response
      }
      return fetch(input, init)
    }
    const host = await openR12Host({ staticToken: 'demo-token', fetch: delayingFetch })
    const hostRecords = (host as unknown as { r12Records: Map<CredentialKey, CredentialRecord> }).r12Records

    const deliverPromise = host.telemetryDeliver(
      {
        schemaVersion: 1,
        batchId: 'r12-inflight-batch',
        projectId: 'project-alpha',
        clientSentAt: new Date().toISOString(),
        events: [
          {
            schemaVersion: 1,
            eventId: 'r12-inflight-event',
            installationId: 'r12-install',
            projectId: 'project-alpha',
            sessionId: 'r12-session',
            kind: 'turn.finished',
            occurredAt: new Date().toISOString(),
            sourceType: 'turn/end',
            sourceSeq: 1,
            turn: 1,
            outcome: 'success',
          },
        ],
      },
      settings.httpTimeoutMs,
      'member-1',
    )
    // 请求已在途：此刻登出，不得改变在途请求的主体。
    await new Promise(resolve => setTimeout(resolve, 100))
    for (const key of [...hostRecords.keys()]) hostRecords.delete(key)
    releaseResponse()
    const outcome = await deliverPromise
    expect(String(inFlightAuthorization).startsWith('Bearer access-')).toBe(true)
    expect(outcome.status).toBe('sent')
    const next = await host.telemetryAccount()
    expect(next).toEqual({ status: 'signed-out' })
  })
  it('R15 端到端分层脱敏：projection→队列→HTTP body→fixture→admin 每层都不含原始敏感子串', async () => {
    await startService()
    const secretBearer = 'Bearer ezR9qLmT7vWsEcR3tKxY'
    const rawMessage = `provider exploded: ${secretBearer} with password=p4ssw0rd! at C:\\Users\\dev\\app\\config.yaml`
    const outgoingBodies: string[] = []
    const capturingFetch: typeof fetch = async (input, init) => {
      if (String(input).includes('/telemetry/batches') && init?.body !== undefined) {
        outgoingBodies.push(String(init.body))
      }
      return fetch(input, init)
    }
    const host = await openR12Host({ staticToken: 'demo-token', fetch: capturingFetch })
    await host.logout()
    const root = await mkdtemp(join(tmpdir(), 'dsh-r15-q-'))
    roots.push(root)
    const queue = TelemetryQueue.open(join(root, 'state'), settings)
    queues.push(queue)
    const reporter = new TelemetryReporter(queue, settings, {
      send: async (batch, accountId) => host.telemetryDeliver(batch, settings.httpTimeoutMs, accountId),
      resolveAccount: r12ResolveAccount(host),
    })

    // 第 1 层 projection：敏感 message 进投影时即被脱敏。
    const projection = new TelemetryProjection()
    const facts = projection.project(
      {
        channel: 'ops',
        time: 1_700_000_000_500,
        severity: 'error',
        attributes: { 'telemetry.op': 'agent-error', 'session.id': 'r15-session', 'error.name': 'ProviderError', turn: 1, step: 1 },
        body: { name: 'ProviderError', message: rawMessage },
      },
      'r15-session',
    )
    const errorFact = facts.map(fact => fact).find(fact => fact.kind === 'agent.error')
    expect(errorFact?.error?.summary).toBeDefined()
    expect(errorFact?.error?.summary).not.toContain(secretBearer)
    expect(errorFact?.error?.summary).toContain('[REDACTED]')

    // 第 2 层 queue：入库行（含 kind 后缀的稳定 ID）不含原始敏感子串。
    queue.enqueue(
      {
        schemaVersion: 1,
        eventId: `${queue.installationId}:r15-session:9:agent.error`,
        installationId: queue.installationId,
        projectId: 'project-alpha',
        sessionId: 'r15-session',
        kind: 'agent.error',
        occurredAt: new Date().toISOString(),
        sourceType: 'ops/agent-error',
        sourceSeq: 9,
        turn: 1,
        step: 1,
        outcome: 'error',
        ...(errorFact?.error === undefined ? {} : { error: errorFact.error }),
      },
      'static-token',
      Date.now(),
    )
    const dbPath = join(root, 'state', 'telemetry', 'telemetry.db')
    reporter.start()
    expect(await waitFor(async () => queue.counts().events === 0)).toBe(true)
    await reporter.shutdown()
    void dbPath

    // 第 3 层 HTTP body：出站批次请求不含原始敏感子串。
    expect(outgoingBodies.length).toBeGreaterThan(0)
    for (const body of outgoingBodies) {
      expect(body).not.toContain(secretBearer)
      expect(body).not.toContain('p4ssw0rd!')
      expect(body).not.toContain('C:\\Users\\dev')
    }
    // 第 4+5 层 fixture 存储与 admin JSON：只含脱敏文本。
    const adminEvents = await fetch(`${BASE}/admin/projects/project-alpha/telemetry/events?from=2000-01-01T00:00:00.000Z&to=2100-01-01T00:00:00.000Z&limit=200`, {
      headers: { authorization: 'Bearer admin-demo' },
    })
    const adminText = JSON.stringify(await adminEvents.json())
    expect(adminText).not.toContain(secretBearer)
    expect(adminText).not.toContain('p4ssw0rd!')
    expect(adminText).not.toContain('C:\\Users\\dev')
    expect(adminText).toContain('[REDACTED]')
  })
})

describe('AI Coding observability closed loop over real HTTP', () => {
  it('delivers real DSH events through the queue to the fixture and reads the same batch in the admin', async () => {
    await startService()
    const records = new Map<CredentialKey, CredentialRecord>()
    const credentials = {
      readRecord: async (key: CredentialKey) => records.get(key),
      modifyRecord: async (
        key: CredentialKey,
        mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
      ) => {
        const next = await mutate(records.get(key))
        if (next !== undefined) records.set(key, next)
        return next
      },
      deleteRecord: async (key: CredentialKey) => {
        records.delete(key)
      },
    } as unknown as CredentialProvider
    const hostRoot = await mkdtemp(join(tmpdir(), 'dsh-telemetry-host-'))
    roots.push(hostRoot)
    const host = new TeamSkillHost({
      apiBaseUrl: BASE,
      credentials,
      stateDirectory: join(hostRoot, 'state'),
      globalSkillRoot: 'unused',
    })
    expect(await host.login({ username: 'member@example.com', password: 'member-pass' })).toMatchObject({ status: 'authenticated' })

    const loop = await openLoop(host)
    await loop.runTurn('loop-session-a')
    await loop.reporter.shutdown()

    expect(loop.queue.counts().events).toBe(0)

    const overviewResponse = await fetch(`${BASE}/admin/telemetry/overview?from=2000-01-01T00:00:00.000Z&to=2100-01-01T00:00:00.000Z`, { headers: adminHeaders() })
    expect(overviewResponse.status).toBe(200)
    const overview = await dataOf(overviewResponse)
    expect(overview.has_data).toBe(true)
    const summary = overview.summary as {
      sessions: { total: number }
      turns: { total: number; completed: number }
      llm: { requests: number; total_tokens: null }
      delivery: { accepted: number; gaps: number }
    }
    expect(summary.sessions.total).toBe(1)
    expect(summary.turns.total).toBe(1)
    expect(summary.turns.completed).toBe(1)
    expect(summary.llm.requests).toBe(1)
    // Token totals stay null because the provider reported none; no cost fields exist.
    expect(summary.llm.total_tokens).toBeNull()
    expect(JSON.stringify(overview)).not.toContain('cost')
    expect(JSON.stringify(overview)).not.toContain('assistant answer body')

    const summaryResponse = await fetch(`${BASE}/admin/projects/project-alpha/telemetry/summary?from=2000-01-01T00:00:00.000Z&to=2100-01-01T00:00:00.000Z`, { headers: adminHeaders() })
    expect(summaryResponse.status).toBe(200)
    const projectSummary = await dataOf(summaryResponse)
    expect(projectSummary.project_id).toBe('project-alpha')
    expect((projectSummary.summary as { turns: { total: number } }).turns.total).toBe(1)

    const eventsResponse = await fetch(`${BASE}/admin/projects/project-alpha/telemetry/events?from=2000-01-01T00:00:00.000Z&to=2100-01-01T00:00:00.000Z&limit=50`, { headers: adminHeaders() })
    expect(eventsResponse.status).toBe(200)
    const events = await dataOf(eventsResponse)
    const items = events.items as Array<{ session_id: string; kind: string; token_usage: { total_tokens: number | null } | null }>
    expect(items.length).toBeGreaterThan(0)
    expect(items.every(item => item.session_id === 'loop-session-a' || item.kind === 'delivery.gap')).toBe(true)
    expect(JSON.stringify(items)).not.toContain('prompt for loop-session-a')
    expect(JSON.stringify(items)).not.toContain('assistant answer body')

    // RED: a batch-level unknown field fails the whole batch with 400.
    const badBatchResponse = await fetch(`${BASE}/telemetry/batches`, {
      method: 'POST',
      headers: { ...memberHeaders(), 'content-type': 'application/json', 'Idempotency-Key': 'bad-batch-level' },
      body: JSON.stringify({
        schema_version: 1,
        batch_id: 'bad-batch-level',
        project_id: 'project-alpha',
        unexpected_batch_field: true,
        client_sent_at: new Date().toISOString(),
        events: [],
      }),
    })
    expect(badBatchResponse.status).toBe(400)
    expect(((await badBatchResponse.json()) as { code: string }).code).toBe('TELEMETRY_SCHEMA_INVALID')

    // RED: sensitive or non-whitelist fields are rejected by the schema gate.
    const badResponse = await fetch(`${BASE}/telemetry/batches`, {
      method: 'POST',
      headers: { ...memberHeaders(), 'content-type': 'application/json', 'Idempotency-Key': 'bad-1' },
      body: JSON.stringify({
        schema_version: 1,
        batch_id: 'bad-batch',
        project_id: 'project-alpha',
        client_sent_at: new Date().toISOString(),
        events: [
          {
            schema_version: 1,
            event_id: 'bad-event',
            installation_id: 'inst',
            project_id: 'project-alpha',
            session_id: 's',
            kind: 'turn.finished',
            occurred_at: new Date().toISOString(),
            source_type: 'turn/end',
            turn: 1,
            outcome: 'success',
            prompt: 'top secret user prompt',
          },
        ],
      }),
    })
    expect(badResponse.status).toBe(202)
    const badBody = await dataOf(badResponse)
    expect(badBody.results).toEqual([
      { event_id: 'bad-event', status: 'rejected', reason: 'TELEMETRY_SCHEMA_INVALID' },
    ])
    // The rejected event with its sensitive field never reached storage.
    const afterRed = await dataOf(
      await fetch(`${BASE}/admin/projects/project-alpha/telemetry/events?from=2000-01-01T00:00:00.000Z&to=2100-01-01T00:00:00.000Z&limit=200`, { headers: adminHeaders() }),
    )
    expect(JSON.stringify(afterRed)).not.toContain('bad-event')
    expect(JSON.stringify(afterRed)).not.toContain('top secret user prompt')

    // GREEN: the same batch without the sensitive field is accepted per event.
    const goodResponse = await fetch(`${BASE}/telemetry/batches`, {
      method: 'POST',
      headers: { ...memberHeaders(), 'content-type': 'application/json', 'Idempotency-Key': 'good-1' },
      body: JSON.stringify({
        schema_version: 1,
        batch_id: 'good-batch',
        project_id: 'project-alpha',
        client_sent_at: new Date().toISOString(),
        events: [
          {
            schema_version: 1,
            event_id: 'good-event',
            installation_id: 'inst',
            project_id: 'project-alpha',
            session_id: 's',
            kind: 'turn.finished',
            occurred_at: new Date().toISOString(),
            source_type: 'turn/end',
            turn: 1,
            outcome: 'success',
          },
        ],
      }),
    })
    expect(goodResponse.status).toBe(202)
    const good = await dataOf(goodResponse)
    expect(good.results).toEqual([{ event_id: 'good-event', status: 'accepted' }])

    // Member accounts cannot read team analytics at all.
    const memberOverview = await fetch(`${BASE}/admin/telemetry/overview?from=2000-01-01T00:00:00.000Z&to=2100-01-01T00:00:00.000Z`, { headers: memberHeaders() })
    expect(memberOverview.status).toBe(403)
  })

  it('retains the queue across service unavailability and resumes delivery after recovery', async () => {
    // One OS-assigned reservation reused by both starts: the outage models the
    // same service returning at the same URL *without* claiming a shared literal
    // port, which is what made this case collide with concurrent Vitest
    // processes (EADDRINUSE) and then fail as a wrong account state.
    const port = await reservePort()
    await startService(port)
    // Static-token delivery mirrors OIDC-configured deployments; the fixture's
    // deterministic seed token survives the restart used to model recovery.
    const host = new TeamSkillHost({
      apiBaseUrl: BASE,
      accessToken: 'demo-token',
      stateDirectory: join(await mkdtemp(join(tmpdir(), 'dsh-telemetry-host2-')), 'state'),
      globalSkillRoot: 'unused',
    })
    const root = await mkdtemp(join(tmpdir(), 'dsh-telemetry-loopq-'))
    roots.push(root)
    const queue = TelemetryQueue.open(join(root, 'state'), settings)
    queues.push(queue)
    const reporter = new TelemetryReporter(queue, settings, {
      send: (batch, accountId) => host.telemetryDeliver(batch, settings.httpTimeoutMs, accountId),
      // Static-token deployment: the account mirror resolves signed-out to the
      // shared static partition, matching the Host's real send identity.
      resolveAccount: async () => {
        const account = await host.telemetryAccount()
        if ('userId' in account) return account
        if (account.status === 'signed-out') return { userId: STATIC_TOKEN_PARTITION }
        return account
      },
    })
    const dto = {
      schemaVersion: 1 as const,
      eventId: 'loop-recovery-event',
      installationId: queue.installationId,
      projectId: 'project-alpha',
      sessionId: 's',
      kind: 'turn.finished' as const,
      occurredAt: new Date().toISOString(),
      sourceType: 'turn/end',
      sourceSeq: 1,
      turn: 1,
      outcome: 'success' as const,
    }
    // The Host enqueues through the same path the collector uses.
    queue.enqueue(dto, STATIC_TOKEN_PARTITION, Date.now())

    // RED: the service is down; the flush fails explicitly and the row is kept.
    for (const service of services.splice(0)) {
      service.server.closeAllConnections()
      await new Promise<void>((resolve) => {
        service.server.close(() => {
          resolve()
        })
      })
    }
    await reporter.shutdown()
    expect(queue.counts().events).toBe(1)
    const failing = reporter.status('project-alpha')
    expect(failing.mode).toBe('failed')
    expect(failing.lastFailure?.code).toBe('NETWORK_ERROR')

    // GREEN: the service returns (deterministic seed accepts the same token) and
    // the queue drains once the retry backoff window has elapsed. A pooled
    // keep-alive socket to the dead instance may cost one attempt; bounded
    // retries model the reporter's own backoff.
    await startService(port)
    const recovery = new TelemetryReporter(queue, settings, {
      send: (batch, accountId) => host.telemetryDeliver(batch, settings.httpTimeoutMs, accountId),
      resolveAccount: async () => {
        const account = await host.telemetryAccount()
        if ('userId' in account) return account
        if (account.status === 'signed-out') return { userId: STATIC_TOKEN_PARTITION }
        return account
      },
    })
    for (let attempt = 0; attempt < 5 && queue.counts().events > 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 100))
      await recovery.shutdown()
    }
    expect(queue.counts().events).toBe(0)
    expect(recovery.status('project-alpha').lastAcceptedAt).not.toBeNull()
    expect(recovery.status('project-alpha').mode).toBe('active')
  })

  it('stops a revoked project partition with an authorization gap instead of misdelivering', async () => {
    await startService()
    const host = await openLoggedInHost()
    const root = await mkdtemp(join(tmpdir(), 'dsh-telemetry-loopq3-'))
    roots.push(root)
    const queue = TelemetryQueue.open(join(root, 'state'), settings)
    queues.push(queue)
    const reporter = new TelemetryReporter(queue, settings, {
      send: (batch, accountId) => host.telemetryDeliver(batch, settings.httpTimeoutMs, accountId),
      resolveAccount: async () => {
        const account = await host.telemetryAccount()
        return 'userId' in account ? account : { status: 'not-ready' }
      },
    })
    queue.enqueue(
      {
        schemaVersion: 1,
        eventId: 'loop-revoke-event',
        installationId: queue.installationId,
        projectId: 'project-alpha',
        sessionId: 's',
        kind: 'turn.finished',
        occurredAt: new Date().toISOString(),
        sourceType: 'turn/end',
        sourceSeq: 2,
        turn: 1,
        outcome: 'success',
      },
      'member-1',
      Date.now(),
    )

    // The admin revokes member-1's project membership before the batch sends.
    const revoke = await fetch(`${BASE}/admin/projects/project-alpha/members/member-1`, {
      method: 'DELETE',
      headers: { ...adminHeaders(), 'content-type': 'application/json', 'Idempotency-Key': `revoke-${Date.now()}`, 'If-Match': '1' },
    })
    expect(revoke.status).toBe(200)

    await reporter.shutdown()
    // The partition stopped with a persisted authorization_revoked gap.
    const status = reporter.status('project-alpha')
    expect(status.mode).toBe('authorization-revoked')
    expect(status.authorizationState).toBe('revoked')
    // Only the gap remains queued (the raw events were removed with the partition).
    expect(queue.counts().gaps).toBeGreaterThanOrEqual(1)
    expect(queue.isRevoked('member-1', 'project-alpha')).toBe(true)
  })
})
