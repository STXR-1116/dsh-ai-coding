/* TeamSkillGateway 余下接缝（覆盖专项：gateway 批·续）。
 *
 * 前一接缝规格覆盖账户/项目/目录/知识面；本规格补齐账号写、项目记忆的召回与
 * 变更、本地安装与信任卡、采集器生命周期与按会话的记忆清理。全部走真实
 * fixture（内存凭据 + 真实 SessionStore/AgentRegistry）。
 *
 * 本轮由这些用例钉出一个真实缺陷：零命中的召回其 `context_text` 合法为空，
 * 而 host 的 requireString 把空串当成协议漂移——于是「没有召回内容」被报告成
 * 服务协议错误；已改为 requireStringValue（空串是服务端取值），下面两条召回
 * 用例分别钉住「零命中」与「有命中」两种合法结果。
 *
 * 分类：FIXTURE-ONLY。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CredentialProvider, type CredentialKey, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import SessionStore from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { createTeamSkillService } from '../dev/team-skill-service/src/server.ts'
import { TeamSkillGateway } from '../src/gateway.ts'

const services: ReturnType<typeof createTeamSkillService>[] = []
const roots: string[] = []

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
    if (next === undefined) this.state.grant = undefined
    else if (next.kind === 'grant' && typeof next.payload === 'object' && next.payload !== null) {
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

afterEach(async () => {
  for (const service of services.splice(0)) {
    service.server.closeAllConnections()
    await new Promise<void>((resolve) => {
      service.server.close(() => { resolve() })
    })
  }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }).catch(() => undefined)))
})

/** 起 fixture、登录 member、把登录句柄写成 Host 凭据，返回装配好的 gateway。 */
async function buildGateway(): Promise<TeamSkillGateway> {
  const service = createTeamSkillService({ port: 0, seed: true })
  services.push(service)
  await service.listen()
  const port = (service.server.address() as AddressInfo).port
  const base = `http://127.0.0.1:${port}/v1`

  const login = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'member@example.com', password: 'member-pass' }),
  })
  expect(login.status).toBe(200)
  const grant = ((await login.json()) as { data: { access_token: string } }).data.access_token

  const stateDirectory = await mkdtemp(join(tmpdir(), 'dsh-gateway-remaining-'))
  roots.push(stateDirectory)
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  const credentials = new MemoryCredentialProvider(ctx, {
    grant: { userId: 'member-1', accessToken: grant, refreshToken: 'refresh-remaining', expiresAt: Date.now() + 3_600_000 },
  })
  void credentials
  return new TeamSkillGateway(ctx, {
    apiBaseUrl: base,
    stateDirectory,
    globalSkillRoot: join(stateDirectory, 'skills'),
    telemetry: { flushIntervalMs: 60_000, claimTimeoutMs: 60_000 },
  })
}

describe('TeamSkillGateway 余下接缝（真实 fixture）', () => {
  it('reports a wrong current password as an explicit credential failure', async () => {
    const gateway = await buildGateway()
    const result = await gateway.changePassword({ currentPassword: 'not-the-password', newPassword: 'member-pass-2' })
    expect(result).toMatchObject({ status: 'failed', code: 'INVALID_CREDENTIALS' })
  })

  it('reads the aggregate access summary as a bare value', async () => {
    const gateway = await buildGateway()
    const summary = await gateway.accessSummary()
    if ('status' in summary && (summary.status === 'failed' || summary.status === 'signed-out' || summary.status === 'not-ready')) {
      throw new Error(`access summary unavailable: ${JSON.stringify(summary)}`)
    }
    const value = summary as { readonly organizations: readonly { readonly organizationId: string }[] }
    expect(value.organizations.some(organization => organization.organizationId === 'org-alpha')).toBe(true)
  })

  it('distinguishes a recall with no hits from a recall that matched', async () => {
    const gateway = await buildGateway()

    // 零命中：合法的空上下文文本，不是协议错误。
    const none = await gateway.memoryRecall({ projectId: 'project-alpha', query: '绝不可能命中的检索词-zzz' })
    if (!('items' in none)) throw new Error(`recall unavailable: ${JSON.stringify(none)}`)
    expect(none.items).toEqual([])
    expect(none.contextText).toBe('')

    // 空查询按项目范围召回：命中项必须带完整来源（layer/score/reason/confidence）。
    const matched = await gateway.memoryRecall({ projectId: 'project-alpha', query: '' })
    if (!('items' in matched)) throw new Error(`recall unavailable: ${JSON.stringify(matched)}`)
    expect(matched.items.length).toBeGreaterThanOrEqual(1)
    expect(matched.contextText.length).toBeGreaterThan(0)
    const first = matched.items[0]
    expect(first?.layer).toBe('L1')
    expect(typeof first?.score).toBe('number')
    expect(typeof first?.recallReason).toBe('string')
    expect(first?.confidence).toBeGreaterThanOrEqual(0)
  })

  it('answers memory mutations on an unknown id with the stable not-found code', async () => {
    const gateway = await buildGateway()
    expect(await gateway.memoryCandidatesConfirm({ memoryId: 'memory-absent', expectedRevision: 1 }, 'remaining-1'))
      .toMatchObject({ status: 'failed', code: 'MEMORY_NOT_FOUND' })
    expect(await gateway.memoryUpdate({ memoryId: 'memory-absent', content: '改写', expectedRevision: 1 }, 'remaining-2'))
      .toMatchObject({ status: 'failed', code: 'MEMORY_NOT_FOUND' })
    expect(await gateway.memoryDelete({ memoryId: 'memory-absent', expectedRevision: 1 }, 'remaining-3'))
      .toMatchObject({ status: 'failed', code: 'MEMORY_NOT_FOUND' })
  })

  it('reads local installations and release synchronization as empty lists for a fresh Host', async () => {
    const gateway = await buildGateway()
    expect(await gateway.installations('project-alpha')).toEqual([])
    expect(await gateway.syncReleaseStatus('project-alpha')).toEqual([])
  })

  it('refuses a trust card, an install and an uninstall that the service does not serve', async () => {
    const gateway = await buildGateway()
    expect(await gateway.trustCard({ skillId: 'skill-absent', version: '1.0.0', projectId: 'project-alpha' }))
      .toMatchObject({ status: 'failed', code: 'NOT_FOUND' })

    const installed = await gateway.install({
      skillId: 'skill-absent', version: '1.0.0', projectId: 'project-alpha', scope: 'global',
      environment: { dshVersion: '0.0.0-test', availableTools: [], availableMcpServers: [], presentEnvironmentVariableNames: [] },
    })
    // 失败必须停在具体阶段并带上「能不能重试 + 怎么做」，而不是只说失败。
    expect(installed).toMatchObject({ status: 'failed', code: 'NOT_FOUND', failedStage: 'authorization' })
    if (installed.status === 'failed') {
      expect(installed.stages.length).toBeGreaterThan(0)
      expect(installed.retryable.retryable).toBe(false)
      expect(installed.retryable.how.length).toBeGreaterThan(0)
    }

    expect(await gateway.uninstall({ localInstallationId: 'local-absent' }))
      .toMatchObject({ status: 'failed', code: 'LOCAL_INSTALLATION_NOT_FOUND' })
  })

  it('drives the collector lifecycle through pause, resume, flush and clear', async () => {
    const gateway = await buildGateway()
    const paused = await gateway.pauseCollector()
    expect(paused).toMatchObject({ status: 'ready' })
    if (paused.status === 'ready') expect(paused.value.mode).toBe('paused')

    const resumed = await gateway.resumeCollector()
    if (resumed.status === 'ready') expect(resumed.value.mode).toBe('active')

    const flushed = await gateway.flushCollector()
    expect(flushed).toMatchObject({ status: 'ready' })

    const cleared = await gateway.clearPendingCollectorData()
    expect(cleared).toMatchObject({ status: 'ready' })
  })

  it('refuses to clear project memory for a session that is not live', async () => {
    const gateway = await buildGateway()
    expect(() => { gateway.clearProjectMemory('sess-not-live') }).toThrow(/not a live agent/u)
  })
})
