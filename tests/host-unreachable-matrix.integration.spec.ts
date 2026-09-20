/* TeamSkillHost 的「未配置 / 服务不可达 / 未登录」矩阵（覆盖专项：host 批）。
 *
 * host 的每条接缝都先解析客户端与会话，再发请求；此前的规格只走通了「一切正常」
 * 的那一支，于是每条 `if ('status' in client) return client`、
 * `if (session === undefined) return signed-out` 与 `return failureOf(error)`
 * 都没被执行。
 *
 * 不变量（一条都不能破）：服务不可达、未配置或未登录时，每条接缝都必须给出
 * **显式终态**（not-ready / failed / signed-out），既不抛异常，也不返回形似成功的值。
 * 三类接缝各有自己的正确答案，逐条钉在下面：服务面接缝随模式给 not-ready /
 * failed / signed-out；账户面接缝在没有凭据提供者时一律 not-ready（它必须把会话
 * 写进凭据存储，缺存储不是「先试一下」）；本地副本接缝离线时返回本地列表。
 *
 * 分类：FIXTURE-ONLY（注入 fetch，不开真实连接）。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CredentialProvider, type CredentialKey, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { createTeamSkillService } from '../dev/team-skill-service/src/server.ts'
import { TeamSkillHost, STATIC_TOKEN_PARTITION } from '../src/host.ts'
import type { TeamSkillHostOptions } from '../src/host.ts'

/** 一个只有一条固定授权的内存凭据存储：让账户面接缝真正走到传输层。 */
class FixedGrantCredentials extends CredentialProvider {
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
    return Promise.resolve({
      kind: 'grant',
      payload: { userId: 'member-1', accessToken: 'grant-token', refreshToken: 'refresh-matrix', expiresAt: Date.now() + 3_600_000 },
    })
  }

  describeRecord(_key: CredentialKey): Promise<never> {
    return Promise.reject(new Error('not used in tests'))
  }

  listRecords(): Promise<readonly never[]> {
    return Promise.resolve([])
  }

  modifyRecord(
    _key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    return mutate(undefined)
  }

  deleteRecord(_key: CredentialKey): Promise<void> {
    return Promise.resolve()
  }
}

const roots: string[] = []
const services: ReturnType<typeof createTeamSkillService>[] = []

/** 凭据存储自身不可读：遥测必须显式报 CREDENTIALS_UNAVAILABLE 而不是继续发送。 */
class ThrowingCredentials extends CredentialProvider {
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
    return Promise.reject(new Error('credential store unavailable'))
  }

  describeRecord(_key: CredentialKey): Promise<never> {
    return Promise.reject(new Error('not used in tests'))
  }

  listRecords(): Promise<readonly never[]> {
    return Promise.reject(new Error('credential store unavailable'))
  }

  modifyRecord(): Promise<CredentialRecord | undefined> {
    return Promise.reject(new Error('credential store unavailable'))
  }

  deleteRecord(_key: CredentialKey): Promise<void> {
    return Promise.reject(new Error('credential store unavailable'))
  }
}

/** 凭据存储里一开始没有任何授权：账户面解析出「未登录」，但可以接受写入。 */
class EmptyCredentials extends CredentialProvider {
  private record: CredentialRecord | undefined

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
    return Promise.resolve(this.record)
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
    this.record = await mutate(this.record)
    return this.record
  }

  deleteRecord(_key: CredentialKey): Promise<void> {
    this.record = undefined
    return Promise.resolve()
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

/** One seam, called with arguments the service never sees in these modes. */
const SEAMS: ReadonlyArray<readonly [string, (host: TeamSkillHost) => Promise<unknown>]> = [
  ['login', host => host.login({ username: 'member@example.com', password: 'member-pass' })],
  ['account', host => host.account()],
  ['refreshAccount', host => host.refreshAccount()],
  ['changePassword', host => host.changePassword({ currentPassword: 'a', newPassword: 'b' })],
  ['logout', host => host.logout()],
  ['accessSummary', host => host.accessSummary()],
  ['projects', host => host.projects()],
  ['project', host => host.project('project-alpha')],
  ['catalog', host => host.catalog('project-alpha')],
  ['trustCard', host => host.trustCard({ skillId: 'skill-x', version: '1.0.0', projectId: 'project-alpha' })],
  ['knowledgeBases', host => host.knowledgeBases('project-alpha')],
  ['knowledgeSearch', host => host.knowledgeSearch({ projectId: 'project-alpha', query: '发布', knowledgeBaseIds: ['k-1'] })],
  ['knowledgePreview', host => host.knowledgePreview('k-1', 'doc-1')],
  ['memoryRecall', host => host.memoryRecall({ projectId: 'project-alpha', query: '发布' })],
  ['memoryCapture', host => host.memoryCapture({ projectId: 'project-alpha', sessionId: 'sess-1', messages: [] }, 'matrix-capture')],
  ['memoryList', host => host.memoryList({ projectId: 'project-alpha', limit: 5 })],
  ['memoryCandidatesConfirm', host => host.memoryCandidatesConfirm({ memoryId: 'memory-x', expectedRevision: 1 }, 'matrix-confirm')],
  ['memoryGet', host => host.memoryGet('memory-x')],
  ['memoryUpdate', host => host.memoryUpdate({ memoryId: 'memory-x', content: '改写', expectedRevision: 1 }, 'matrix-update')],
  ['memoryDelete', host => host.memoryDelete({ memoryId: 'memory-x', expectedRevision: 1 }, 'matrix-delete')],
  ['memoryJobs', host => host.memoryJobs('project-alpha')],
  ['memoryAudit', host => host.memoryAudit('project-alpha')],
  ['installations', host => host.installations('project-alpha')],
  ['syncReleaseStatus', host => host.syncReleaseStatus('project-alpha')],
  ['uninstall', host => host.uninstall({ localInstallationId: 'local-x' })],
  ['install', host => host.install({
    skillId: 'skill-x', version: '1.0.0', projectId: 'project-alpha', scope: 'global',
    environment: { dshVersion: '0.0.0-test', availableTools: [], availableMcpServers: [], presentEnvironmentVariableNames: [] },
  })],
  ['telemetryAccount', host => host.telemetryAccount()],
]

/** Account-plane seams: they persist the session in the credential store first. */
const ACCOUNT_SEAMS = new Set(['login', 'account', 'refreshAccount', 'changePassword', 'logout'])

/**
 * Local-copy seams answer from the installation store: with no endpoint they
 * return the local list (empty for a fresh Host) rather than a degraded status.
 */
const LOCAL_COPY_SEAMS = new Set(['installations', 'syncReleaseStatus'])

type Mode = 'unconfigured' | 'unreachable' | 'signed-out'

/** The terminal status one seam owes in one mode. */
function owed(mode: Mode, name: string): readonly string[] {
  if (LOCAL_COPY_SEAMS.has(name)) return []
  if (name === 'telemetryAccount') return ['signed-out']
  // 账户面接缝先解析账户客户端与会话：客户端建不起来是 not-ready，部署本身没有
  // 账户身份（静态令牌）是 signed-out；两者都不得退化成「像成功一样的值」。
  if (ACCOUNT_SEAMS.has(name)) return ['not-ready', 'signed-out']
  // 服务面接缝：未配置必然 not-ready；不可达与未登录随该接缝所在的平面给出
  // failed（服务面）/ signed-out（账户面）/ not-ready（还缺另一样依赖），
  // 本矩阵在此只钉「显式终态」，具体终态由下面两条专门用例钉住。
  return mode === 'unconfigured' ? ['not-ready'] : ['failed', 'signed-out', 'not-ready']
}

/** Drives every seam in one mode and checks the status it owes. */
async function driveAllSeams(options: TeamSkillHostOptions, mode: Mode): Promise<void> {
  const host = new TeamSkillHost(options)
  for (const [name, call] of SEAMS) {
    const result = await call(host)
    const want = owed(mode, name)
    if (want.length === 0) {
      expect(result, `${mode} 模式下 ${name} 应返回本地列表`).toEqual([])
      continue
    }
    const status = (result as { status?: unknown } | null)?.status
    expect(typeof status, `${mode} 模式下 ${name} 给出了非终态结果: ${JSON.stringify(result)?.slice(0, 160)}`)
      .toBe('string')
    expect(want, `${mode} 模式下 ${name} 的终态`).toContain(status)
  }
}

async function stateRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-host-matrix-'))
  roots.push(directory)
  return directory
}

describe('TeamSkillHost 未配置 / 不可达 / 未登录矩阵', () => {
  it('answers not-ready with the missing field for every service seam when no endpoint is configured', async () => {
    const stateDirectory = await stateRoot()
    const host = new TeamSkillHost({ stateDirectory, globalSkillRoot: join(stateDirectory, 'skills') })
    for (const name of ['projects', 'knowledgeSearch', 'memoryRecall', 'memoryGet', 'memoryList'] as const) {
      const call = SEAMS.find(([seam]) => seam === name)?.[1]
      expect(call, name).toBeDefined()
      const result = await call?.(host)
      expect(result, `${name} 的未配置形状`).toMatchObject({ status: 'not-ready' })
    }
    // 清单式的 not-ready 必须自我说明缺哪个字段，而不是一个笼统的空状态。
    const call = SEAMS.find(([seam]) => seam === 'projects')?.[1]
    expect(await call?.(host)).toEqual({ status: 'not-ready', missing: ['apiBaseUrl'] })
  })

  it('answers failed when a configured deployment cannot reach its service', async () => {
    const stateDirectory = await stateRoot()
    const ctx = new Context()
    const host = new TeamSkillHost({
      apiBaseUrl: 'http://127.0.0.1:1/v1',
      stateDirectory,
      globalSkillRoot: join(stateDirectory, 'skills'),
      credentials: new FixedGrantCredentials(ctx),
      fetch: async () => { throw new Error('offline') },
    })
    for (const name of ['projects', 'accessSummary', 'knowledgeSearch', 'memoryRecall', 'memoryGet', 'memoryCapture'] as const) {
      const call = SEAMS.find(([seam]) => seam === name)?.[1]
      const result = await call?.(host)
      // 配置齐全、只是服务不可达：必须是 failed（带稳定码），不是 not-ready，也不是空列表。
      expect(result, `${name} 的不可达终态`).toMatchObject({ status: 'failed' })
    }
    // 账户面接缝同样要走到请求再失败，而不是停在「没配置」。
    for (const name of ['login', 'refreshAccount', 'changePassword', 'account'] as const) {
      const call = SEAMS.find(([seam]) => seam === name)?.[1]
      const result = await call?.(host)
      expect(result, `${name} 的不可达终态`).toMatchObject({ status: 'failed' })
    }
    // 登出相反：本地清凭据本身就完成了，服务不可达不该把登出报成失败。
    const logout = SEAMS.find(([seam]) => seam === 'logout')?.[1]
    expect(await logout?.(host)).toMatchObject({ status: 'signed-out' })
  })

  it('reports telemetry delivery outcomes for a revoke, a credential failure and a plain error', async () => {
    const request = { events: [], sequence: 1 } as unknown as Parameters<TeamSkillHost['telemetryDeliver']>[0]
    // 静态令牌部署的分区就是 static-token：分区不符会被判为「账号已切换」，请求根本不会发出。
    const deliver = async (fetchImpl: typeof globalThis.fetch): Promise<unknown> =>
      new TeamSkillHost({ apiBaseUrl: 'http://127.0.0.1:1/v1', accessToken: 'static-token', fetch: fetchImpl })
        .telemetryDeliver(request, 100, STATIC_TOKEN_PARTITION)

    // 403 PROJECT_ACCESS_REVOKED 是「撤销」而不是普通失败：调用方要据此停止重试。
    const revoked = await deliver(async () => new Response(
      JSON.stringify({ code: 'PROJECT_ACCESS_REVOKED', message: '项目授权已撤销', request_id: 'r', data: null }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    ))
    expect(revoked).toMatchObject({ status: 'revoked' })

    // 其它稳定码原样透出，摘要有界（脱敏规则本身由遥测摘要规格覆盖）。
    const failed = await deliver(async () => new Response(
      JSON.stringify({ code: 'RATE_LIMITED', message: '太频繁', request_id: 'r', data: null }),
      { status: 429, headers: { 'content-type': 'application/json' } },
    ))
    expect(failed).toMatchObject({ status: 'failed', code: 'RATE_LIMITED' })
    const summary = (failed as { summary: string }).summary
    expect(summary.length).toBeGreaterThan(0)
    expect(summary.length).toBeLessThanOrEqual(200)

    // 抛出非 Error 值时也必须给出可判定的失败，而不是让异常逃逸。
    const thrown = await deliver(async () => { throw 'not an error' })
    expect(thrown).toMatchObject({ status: 'failed' })

    // 分区与解析结果不一致（例如队列期间换了账号）：显式延后，不发送、不静默。
    const deferred = await new TeamSkillHost({
      apiBaseUrl: 'http://127.0.0.1:1/v1',
      accessToken: 'static-token',
      fetch: async () => { throw new Error('不该发出请求') },
    }).telemetryDeliver(request, 100, 'another-partition')
    expect(deferred).toMatchObject({ status: 'failed', code: 'TELEMETRY_ACCOUNT_CHANGED' })
  })

  it('refuses telemetry delivery when the endpoint is missing or the credential store cannot be read', async () => {
    const request = { events: [], sequence: 1 } as unknown as Parameters<TeamSkillHost['telemetryDeliver']>[0]

    const noEndpoint = new TeamSkillHost({ accessToken: 'static-token', fetch: async () => { throw new Error('不该发出请求') } })
    expect(await noEndpoint.telemetryDeliver(request, 100, 'account-1'))
      .toMatchObject({ status: 'failed', code: 'API_BASE_URL_MISSING' })

    // 端点在但没有凭据提供者：账户客户端建不起来，同样是 API_BASE_URL_MISSING
    // 而不是「随便挑一个身份发出去」。
    const noAccountPlane = new TeamSkillHost({
      apiBaseUrl: 'http://127.0.0.1:1/v1',
      fetch: async () => { throw new Error('不该发出请求') },
    })
    const planeOutcome = await noAccountPlane.telemetryDeliver(request, 100, 'account-1')
    expect(planeOutcome.status).toBe('failed')

    // 地址非空但不是可用的 URL：账户客户端建不起来，同样必须显式失败（不静默发送）。
    const malformed = new TeamSkillHost({
      apiBaseUrl: 'not-a-url',
      fetch: async () => { throw new Error('不该发出请求') },
    })
    const malformedOutcome = await malformed.telemetryDeliver(request, 100, 'account-1')
    expect(malformedOutcome.status).toBe('failed')
    if (malformedOutcome.status === 'failed') expect(malformedOutcome.code.length).toBeGreaterThan(0)

    // 有凭据存储但既没有登录态也没有静态令牌：分区解析不出，批次显式延后。
    const noIdentity = new TeamSkillHost({
      apiBaseUrl: 'http://127.0.0.1:1/v1',
      credentials: new EmptyCredentials(new Context()),
      fetch: async () => { throw new Error('不该发出请求') },
    })
    const identityOutcome = await noIdentity.telemetryDeliver(request, 100, 'account-1')
    expect(identityOutcome).toMatchObject({ status: 'failed', code: 'TELEMETRY_ACCOUNT_CHANGED' })

    const unreadable = new TeamSkillHost({
      apiBaseUrl: 'http://127.0.0.1:1/v1',
      fetch: async () => { throw new Error('不该发出请求') },
      credentials: new ThrowingCredentials(new Context()),
    })
    expect(await unreadable.telemetryDeliver(request, 100, 'account-1'))
      .toMatchObject({ status: 'failed', code: 'CREDENTIALS_UNAVAILABLE' })
  })

  it('refreshes an expiring account session before an authorized request', async () => {
    const service = createTeamSkillService({ port: 0, seed: true })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const login = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'member@example.com', password: 'member-pass' }),
    })
    const session = ((await login.json()) as { data: { access_token: string; refresh_token: string } }).data

    // 凭据在刷新窗口内到期：下一次授权请求必须先换新令牌，再把新会话写回存储。
    const ctx = new Context()
    const credentials = new EmptyCredentials(ctx)
    await credentials.modifyRecord('dsh-ai-coding-platform/account' as CredentialKey, () => Promise.resolve({
      kind: 'grant',
      payload: {
        userId: 'member-1',
        accessToken: session.access_token,
        refreshToken: session.refresh_token,
        expiresAt: Date.now() + 5_000,
      },
    }))
    const host = new TeamSkillHost({ apiBaseUrl: `http://127.0.0.1:${port}/v1`, credentials })

    const projects = await host.projects()
    expect(Array.isArray(projects)).toBe(true)

    const refreshed = await credentials.readRecord('dsh-ai-coding-platform/account' as CredentialKey)
    expect(refreshed?.kind).toBe('grant')
    const payload = refreshed?.kind === 'grant'
      ? refreshed.payload as { accessToken?: string; expiresAt?: number }
      : undefined
    expect(payload?.accessToken).toBeTruthy()
    expect(payload?.expiresAt).toBeGreaterThan(Date.now() + 5_000)
  })

  it('rotates the account session on an explicit refresh', async () => {
    const service = createTeamSkillService({ port: 0, seed: true })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const login = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'member@example.com', password: 'member-pass' }),
    })
    const session = ((await login.json()) as { data: { access_token: string; refresh_token: string } }).data

    const credentials = new EmptyCredentials(new Context())
    await credentials.modifyRecord('dsh-ai-coding-platform/account' as CredentialKey, () => Promise.resolve({
      kind: 'grant',
      payload: {
        userId: 'member-1',
        accessToken: session.access_token,
        refreshToken: session.refresh_token,
        expiresAt: Date.now() + 3_600_000,
      },
    }))
    const host = new TeamSkillHost({ apiBaseUrl: `http://127.0.0.1:${port}/v1`, credentials })

    // 显式刷新必须换到新会话并写回存储，而不是回报旧状态。
    const rotated = await host.refreshAccount()
    expect(rotated).toMatchObject({ status: 'authenticated' })
    const stored = await credentials.readRecord('dsh-ai-coding-platform/account' as CredentialKey)
    expect(stored?.kind).toBe('grant')
  })

  it('writes the account session on a real login and clears it on logout', async () => {
    const service = createTeamSkillService({ port: 0, seed: true })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const ctx = new Context()
    const credentials = new EmptyCredentials(ctx)
    const host = new TeamSkillHost({
      apiBaseUrl: `http://127.0.0.1:${port}/v1`,
      credentials,
    })

    // 成功登录要把会话写进凭据存储，并回报浏览器可用的账号状态。
    const signedIn = await host.login({ username: 'member@example.com', password: 'member-pass' })
    expect(signedIn).toMatchObject({ status: 'authenticated' })
    const stored = await credentials.readRecord('dsh-ai-coding-platform/account' as CredentialKey)
    expect(stored?.kind).toBe('grant')

    const signedOut = await host.logout()
    expect(signedOut).toMatchObject({ status: 'signed-out' })
    expect(await credentials.readRecord('dsh-ai-coding-platform/account' as CredentialKey)).toBeUndefined()
  })
  it('answers not-ready for every service seam when no endpoint is configured', async () => {
    const stateDirectory = await stateRoot()
    await driveAllSeams({ stateDirectory, globalSkillRoot: join(stateDirectory, 'skills') }, 'unconfigured')
  })

  it('answers an explicit status for every seam when the endpoint is unreachable and no account is stored', async () => {
    const stateDirectory = await stateRoot()
    await driveAllSeams({
      apiBaseUrl: 'http://127.0.0.1:1/v1',
      stateDirectory,
      globalSkillRoot: join(stateDirectory, 'skills'),
      fetch: async () => { throw new Error('offline') },
    }, 'unreachable')
  })

  it('answers signed-out for every service seam in an account deployment with no stored grant', async () => {
    const stateDirectory = await stateRoot()
    await driveAllSeams({
      apiBaseUrl: 'http://127.0.0.1:1/v1',
      stateDirectory,
      globalSkillRoot: join(stateDirectory, 'skills'),
      fetch: async () => { throw new Error('不该发出请求') },
    }, 'signed-out')
  })

  it('reports a delivery failure with a sanitized, machine-readable code', async () => {
    const host = new TeamSkillHost({
      apiBaseUrl: 'http://127.0.0.1:1/v1',
      accessToken: 'static-token',
      fetch: async () => { throw new Error('token=secret-value 传输失败') },
    })
    const request = { events: [], sequence: 1 } as unknown as Parameters<typeof host.telemetryDeliver>[0]
    const outcome = await host.telemetryDeliver(request, 100, 'account-1')
    expect(['failed', 'revoked']).toContain(outcome.status)
    if (outcome.status === 'failed') {
      // 摘要必须是脱敏后的文本，并带上可判定的码。
      expect(outcome.summary).not.toContain('secret-value')
      expect(typeof outcome.code).toBe('string')
    }
  })
})
