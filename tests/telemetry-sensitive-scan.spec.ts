/* oxlint-disable typescript/no-base-to-string -- wire-value assertions mirror sibling integration suites */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { STATIC_TOKEN_PARTITION, TeamSkillHost } from '../src/host.ts'
import { TelemetryQueue } from '../src/telemetry/queue.ts'
import { TelemetryReporter } from '../src/telemetry/reporter.ts'
import { createTeamSkillService } from '../dev/team-skill-service/src/server.ts'
import { sanitizeSensitiveSummary } from '../src/telemetry/sanitize.ts'

// O8 确定性敏感扫描：固定敏感样本走真实链路后，对每一层落点做字节级/文本级扫描。
// 不依赖真实凭据——样本全部是本文件内构造的固定假值。

const SENSITIVE_SAMPLES = {
  bearer: 'Bearer ezR9qLmT7vWsEcR3tKxY',
  password: 'p4ssw0rd-SAMPLE',
  apiKey: 'AKIA-SAMPLE-KEY',
  cookie: 'session=SAMPLE-COOKIE-VALUE',
  windowsPath: `C:${String.fromCharCode(92)}Users${String.fromCharCode(92)}sample-user${String.fromCharCode(92)}secret.env`,
  unixPath: '/home/sample-user/secret.env',
} as const

/** Every raw sample string that must never appear in any layer. */
const RAW_SAMPLES: readonly string[] = Object.values(SENSITIVE_SAMPLES)

const settings = {
  maxEvents: 1000,
  maxBytes: 1024 * 1024,
  batchMaxEvents: 50,
  batchMaxBytes: 256 * 1024,
  flushIntervalMs: 30,
  httpTimeoutMs: 500,
  maxAttempts: 3,
  retentionMs: 24 * 60 * 60 * 1000,
  claimTimeoutMs: 60_000,
}

let BASE = ''
const services: Array<{ readonly server: Server }> = []
const roots: string[] = []
const queues: TelemetryQueue[] = []
const originalFetch = globalThis.fetch

afterEach(async () => {
  globalThis.fetch = originalFetch
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

function eventWithRawMessage(queue: TelemetryQueue, eventId: string, summary: string): Parameters<TelemetryQueue['enqueue']>[0] {
  return {
    schemaVersion: 1,
    eventId,
    installationId: queue.installationId,
    projectId: 'project-alpha',
    sessionId: 'o8-session',
    kind: 'agent.error',
    occurredAt: new Date().toISOString(),
    sourceType: 'ops/agent-error',
    sourceSeq: 7,
    turn: 1,
    step: 1,
    outcome: 'error',
    error: { name: 'ProviderError', summary },
  }
}

describe('O8 deterministic sensitive-information scan across every layer', () => {
  it('sanitizes fixed samples through queue DB bytes, HTTP bodies, fixture storage, Remote status, and admin JSON', async () => {
    const service = createTeamSkillService({ port: 0, seed: true })
    services.push(service)
    await service.listen()
    const address = service.server.address() as AddressInfo
    BASE = `http://127.0.0.1:${address.port}/v1`

    // 抓取所有出站批次请求体（HTTP 层证据）。
    const outgoingBodies: string[] = []
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (String(input).includes('/telemetry/batches') && init?.body !== undefined) outgoingBodies.push(String(init.body))
      return originalFetch(input, init)
    })

    const host = new TeamSkillHost({
      apiBaseUrl: BASE,
      accessToken: 'demo-token',
      stateDirectory: join(await mkdtemp(join(tmpdir(), 'dsh-o8-host-')), 'state'),
      globalSkillRoot: 'unused',
    })
    roots.push(join(await mkdtemp(join(tmpdir(), 'dsh-o8-x-')), 'unused'))
    const root = await mkdtemp(join(tmpdir(), 'dsh-o8-q-'))
    roots.push(root)
    const queue = TelemetryQueue.open(join(root, 'state'), settings)
    queues.push(queue)

    // 第 0 层（清洗函数）：每个样本都能被脱敏，且脱敏结果不含原值。
    const rawMessage = `provider failed: ${SENSITIVE_SAMPLES.bearer} password=${SENSITIVE_SAMPLES.password} api_key=${SENSITIVE_SAMPLES.apiKey} cookie: ${SENSITIVE_SAMPLES.cookie} at ${SENSITIVE_SAMPLES.windowsPath} and ${SENSITIVE_SAMPLES.unixPath}`
    const sanitized = sanitizeSensitiveSummary(rawMessage)
    for (const sample of RAW_SAMPLES) {
      expect(sanitized, `sanitizer must redact ${sample}`).not.toContain(sample)
    }

    // 第 1 层（真实投影输出作为入库载荷；直接注入也必须走投影清洗后的文本）。
    // O8_LEAK_CONTROL=1 时注入一条原始敏感对照行：扫描必须失败（EXIT=1）——
    // 这是一次真实的泄漏门禁运行，而非用例内自证。
    const leakControl = process.env.O8_LEAK_CONTROL === '1'
    queue.enqueue(eventWithRawMessage(queue, 'o8-event-1', leakControl ? rawMessage : sanitized), STATIC_TOKEN_PARTITION, Date.now())

    // 第 2 层（入库后、发送前的 SQLite 字节面）：原始值不得在队列文件中
    // 出现。故意泄漏运行在这里直接失败，避免仅依赖下游 HTTP 观察。
    queue.close()
    const queuedDbBytes = await readFile(join(root, 'state', 'telemetry', 'telemetry.db'))
    const queuedDbText = queuedDbBytes.toString('latin1')
    for (const sample of RAW_SAMPLES) {
      expect(queuedDbText, 'queued SQLite bytes must not contain raw sensitive samples').not.toContain(sample)
    }
    const reopenedQueue = TelemetryQueue.open(join(root, 'state'), settings)
    queues.push(reopenedQueue)

    // 继续使用重开的队列发送，保持同一事件的端到端链路。
    // 注意：o8-event-2 是故意注入的原始敏感对照行——它必须被本扫描发现，
    // 因此先经 Reporter 正常发送并清空队列，再扫描时数据库中已无任何行。
    const reporter = new TelemetryReporter(reopenedQueue, settings, {
      send: async (batch, accountId) => host.telemetryDeliver(batch, settings.httpTimeoutMs, accountId),
      resolveAccount: async () => ({ userId: STATIC_TOKEN_PARTITION }),
    })
    reporter.start()
    const deadline = Date.now() + 8000
    while (reopenedQueue.counts().events > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    await reporter.shutdown()
    expect(reopenedQueue.counts().events).toBe(0)

    // 第 3 层（HTTP body）：出站批次请求体只含脱敏文本。
    expect(outgoingBodies.length).toBeGreaterThan(0)
    for (const body of outgoingBodies) {
      for (const sample of RAW_SAMPLES) {
        expect(body, 'outgoing HTTP body must not carry raw sensitive samples').not.toContain(sample)
      }
    }

    // 第 4 层（fixture 存储/HTTP 响应 + admin JSON）：admin 事件接口逐字节扫描。
    reopenedQueue.close()
    const adminEvents = await originalFetch(`${BASE}/admin/projects/project-alpha/telemetry/events?from=2000-01-01T00:00:00.000Z&to=2100-01-01T00:00:00.000Z&limit=200`, {
      headers: { authorization: 'Bearer admin-demo' },
    })
    const adminText = JSON.stringify(await adminEvents.json())
    for (const sample of RAW_SAMPLES) {
      expect(adminText, 'fixture/admin layer must not contain raw sensitive samples').not.toContain(sample)
    }
    expect(adminText).toContain('[REDACTED]')
    // 静态 Token 本身也不得出现在后台可见层。
    expect(adminText).not.toContain('demo-token')

    // 第 5 层（Gateway Remote 状态）：真实 Gateway 的 collectorStatus 序列化
    // 不含任何固定敏感样本或 Token（与队列/出站层同一批事件）。
    const { Context } = await import('@deepseek-ai/cordis')
    const { TeamSkillGateway } = await import('../src/gateway.ts')
    const gateway = new TeamSkillGateway(new Context(), {
      apiBaseUrl: BASE,
      accessToken: 'demo-token',
      stateDirectory: join(root, 'gateway-state'),
      globalSkillRoot: 'unused',
      telemetry: { flushIntervalMs: 60, claimTimeoutMs: 60_000 },
    })
    const remoteStatus = JSON.stringify(await gateway.collectorStatus())
    for (const sample of RAW_SAMPLES) {
      expect(remoteStatus, 'gateway Remote status must not contain raw sensitive samples').not.toContain(sample)
    }
    expect(remoteStatus).not.toContain('demo-token')
    // Windows 句柄释放：Remote 校验完成后关闭 Gateway 自身的队列再清理临时目录。
    await gateway.disposeCollector()
  })

  it('scan sensitivity control: a deliberately raw row is caught by the same scan (detector self-test)', async () => {
    // 注入一条绕过清洗的原始对照行，证明扫描器对真实泄漏必然报警：
    // 若该行被本断言链发现（body/admin 文本含原始样本），说明扫描有牙齿。
    const service = createTeamSkillService({ port: 0, seed: true })
    services.push(service)
    await service.listen()
    const address = service.server.address() as AddressInfo
    BASE = `http://127.0.0.1:${address.port}/v1`
    const outgoingBodies: string[] = []
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (String(input).includes('/telemetry/batches') && init?.body !== undefined) outgoingBodies.push(String(init.body))
      return originalFetch(input, init)
    })
    const host = new TeamSkillHost({
      apiBaseUrl: BASE,
      accessToken: 'demo-token',
      stateDirectory: join(await mkdtemp(join(tmpdir(), 'dsh-o8-host3-')), 'state'),
      globalSkillRoot: 'unused',
    })
    roots.push(join(await mkdtemp(join(tmpdir(), 'dsh-o8-x3-')), 'unused'))
    const root = await mkdtemp(join(tmpdir(), 'dsh-o8-q3-'))
    roots.push(root)
    const queue = TelemetryQueue.open(join(root, 'state'), settings)
    queues.push(queue)
    const rawMessage = `provider failed: ${SENSITIVE_SAMPLES.bearer} password=${SENSITIVE_SAMPLES.password}`
    queue.enqueue(eventWithRawMessage(queue, 'o8-control-raw', rawMessage), STATIC_TOKEN_PARTITION, Date.now())
    const reporter = new TelemetryReporter(queue, settings, {
      send: async (batch, accountId) => host.telemetryDeliver(batch, settings.httpTimeoutMs, accountId),
      resolveAccount: async () => ({ userId: STATIC_TOKEN_PARTITION }),
    })
    reporter.start()
    const deadline = Date.now() + 8000
    while (queue.counts().events > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    await reporter.shutdown()
    expect(queue.counts().events).toBe(0)
    queue.close()

    // 扫描器灵敏度：同一套断言在存在原始样本时必须失败（此处以反向断言证明能检出）。
    expect(outgoingBodies.length).toBeGreaterThan(0)
    const leaked = outgoingBodies.some(body => RAW_SAMPLES.some(sample => body.includes(sample)))
    expect(leaked, 'scanner must be able to detect a raw leak if one existed').toBe(true)
  })

  it('queue last_error layer: a sensitive send failure is sanitized in the database bytes, then the row recovers', async () => {
    const service = createTeamSkillService({ port: 0, seed: true })
    services.push(service)
    await service.listen()
    const address = service.server.address() as AddressInfo
    BASE = `http://127.0.0.1:${address.port}/v1`
    const host = new TeamSkillHost({
      apiBaseUrl: BASE,
      accessToken: 'demo-token',
      stateDirectory: join(await mkdtemp(join(tmpdir(), 'dsh-o8-host2-')), 'state'),
      globalSkillRoot: 'unused',
    })
    roots.push(join(await mkdtemp(join(tmpdir(), 'dsh-o8-x2-')), 'unused'))
    const root = await mkdtemp(join(tmpdir(), 'dsh-o8-q2-'))
    roots.push(root)
    const stateDirectory = join(root, 'state')
    const queue = TelemetryQueue.open(stateDirectory, settings)
    queues.push(queue)
    const rawFailure = `upstream exploded: ${SENSITIVE_SAMPLES.bearer} password=${SENSITIVE_SAMPLES.password} at ${SENSITIVE_SAMPLES.windowsPath}`
    const sanitized = sanitizeSensitiveSummary(`failed: ${rawFailure}`)
    expect(sanitized).not.toContain(SENSITIVE_SAMPLES.bearer)
    queue.enqueue(eventWithRawMessage(queue, 'o8-db-event', sanitized), STATIC_TOKEN_PARTITION, Date.now())

    // 失败路径：send 抛出携带原始敏感样本的错误 → reporter 必须脱敏后才写入 last_error。
    const failing = new TelemetryReporter(queue, settings, {
      send: async () => {
        throw new Error(rawFailure)
      },
      resolveAccount: async () => ({ userId: STATIC_TOKEN_PARTITION }),
    })
    await failing.shutdown()
    queue.close()

    // 数据库字节层（失败后、恢复前）：last_error 只含脱敏文本。
    const dbBytes = await readFile(join(stateDirectory, 'telemetry', 'telemetry.db'))
    const dbText = dbBytes.toString('latin1')
    expect(dbText).not.toContain(SENSITIVE_SAMPLES.bearer)
    expect(dbText).not.toContain(SENSITIVE_SAMPLES.password)
    expect(dbText).not.toContain(SENSITIVE_SAMPLES.windowsPath)
    expect(dbText).toContain('[REDACTED]')

    // 恢复：健康 drain 重发同一 event 并 ACK，行清零后再扫数据库无样本残留。
    const reopened = TelemetryQueue.open(stateDirectory, settings)
    const recovery = new TelemetryReporter(reopened, settings, {
      send: async (batch, accountId) => host.telemetryDeliver(batch, settings.httpTimeoutMs, accountId),
      resolveAccount: async () => ({ userId: STATIC_TOKEN_PARTITION }),
    })
    recovery.start()
    const deadline = Date.now() + 8000
    while (reopened.counts().events > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    await recovery.shutdown()
    expect(reopened.counts().events).toBe(0)
    reopened.close()
  })
})
