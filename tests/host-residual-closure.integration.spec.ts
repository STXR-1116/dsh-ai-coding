/* oxlint-disable typescript/no-base-to-string -- Fetch seams stringify RequestInfo wire values. */
/* oxlint-disable typescript/prefer-promise-reject-errors -- A rejected store seam deliberately carries a non-Error value. */
/* TeamSkillHost 的残余分支收口（覆盖专项：host 批·收口）。
 *
 * 三类：①未配置的本地守卫（状态根 / 发现钩子 / 静态 Token 组合）；②本地副本的写入与
 * 回滚——写入失败、运行时发现抛错、回滚自身失败、隔离后无法落盘；③账号面——登录态
 * Host 的会话解析失败、令牌轮换竞态、授权记录损坏。靠真实 fixture 服务、真实磁盘副本
 * 与可脚本化的安装存储 / 凭据接缝驱动。
 *
 * 分类：FIXTURE-ONLY（本地脚本化接缝 + 仓库自带的 team-skill-service fixture）。
 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { CredentialKey, CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { createTeamSkillService } from '../dev/team-skill-service/src/server.ts'
import { TeamSkillHost } from '../src/host.ts'
import type { TeamSkillInstallationStoreLike } from '../src/installation-store.ts'
import type { TeamSkillInstallationRecord, TeamSkillInstallRequest, TeamSkillScope } from '../src/types.ts'

const services: ReturnType<typeof createTeamSkillService>[] = []
const roots: string[] = []

afterEach(async () => {
  for (const service of services.splice(0)) {
    service.server.closeAllConnections()
    await new Promise<void>((resolve) => {
      service.server.close(() => { resolve() })
    })
  }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }).catch(() => undefined)))
})

/** 一份真实登录产出的会话；两份互不相同，但都对 fixture 有效。 */
interface Session {
  readonly accessToken: string
  readonly refreshToken: string
}

/** 起真实 fixture 服务，并交付端点与一份已登录会话。 */
async function fixtureService(): Promise<{ readonly baseUrl: string; readonly session: Session }> {
  const service = createTeamSkillService({ port: 0, seed: true })
  services.push(service)
  await service.listen()
  const baseUrl = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}/v1`
  return { baseUrl, session: await loginSession(baseUrl) }
}

/** 登录一次；每次登录都会签发一套新令牌。 */
async function loginSession(baseUrl: string): Promise<Session> {
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'member@example.com', password: 'member-pass' }),
  })
  const session = ((await response.json()) as { data: { access_token: string; refresh_token: string } }).data
  return { accessToken: session.access_token, refreshToken: session.refresh_token }
}

/** 一份可脚本化的安装存储：list 返回当前记录，并可就地注入三个方法的失败。 */
class ScriptedStore implements TeamSkillInstallationStoreLike {
  readonly upserts: TeamSkillInstallationRecord[] = []
  readonly removes: string[] = []
  readonly failures: { list?: unknown; upsert?: unknown; remove?: unknown } = {}

  constructor(private readonly records: TeamSkillInstallationRecord[]) {}

  list(): Promise<readonly TeamSkillInstallationRecord[]> {
    if (this.failures.list !== undefined) return Promise.reject(this.failures.list)
    return Promise.resolve([...this.records])
  }

  upsert(next: TeamSkillInstallationRecord): Promise<void> {
    if (this.failures.upsert !== undefined) return Promise.reject(this.failures.upsert)
    this.upserts.push(next)
    const index = this.records.findIndex(record => record.localInstallationId === next.localInstallationId)
    if (index === -1) this.records.push(next)
    else this.records[index] = next
    return Promise.resolve()
  }

  remove(localInstallationId: string): Promise<void> {
    if (this.failures.remove !== undefined) return Promise.reject(this.failures.remove)
    this.removes.push(localInstallationId)
    const index = this.records.findIndex(record => record.localInstallationId === localInstallationId)
    if (index !== -1) this.records.splice(index, 1)
    return Promise.resolve()
  }

  current(): readonly TeamSkillInstallationRecord[] {
    return this.records
  }

  /** 记录身份到状态的映射，便于按身份断言而不依赖存储顺序。 */
  states(): Map<string, string> {
    return new Map(this.records.map(record => [record.localInstallationId, record.installed.state]))
  }
}

/** 在临时目录里写出一份真实的已安装副本，并返回与磁盘一致的记录。 */
async function installedRecord(options: {
  readonly localInstallationId: string
  readonly runtimeName: string
  readonly state?: 'normal' | 'withdrawn' | 'uninstalled'
  readonly scope?: TeamSkillScope
  readonly skillId?: string
  readonly version?: string
}): Promise<{ readonly record: TeamSkillInstallationRecord; readonly directory: string }> {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'dsh-host-closure-'))
  roots.push(stateDirectory)
  const directory = join(stateDirectory, 'skills', options.runtimeName)
  await mkdir(directory, { recursive: true })
  const body = Buffer.from(`# ${options.runtimeName}\n\n已安装的 Team Skill。\n`, 'utf8')
  await writeFile(join(directory, 'SKILL.md'), body)
  return {
    directory,
    record: {
      localInstallationId: options.localInstallationId,
      skillId: options.skillId ?? 'skill-alpha',
      projectId: 'project-alpha',
      scope: options.scope ?? 'global',
      installed: {
        runtimeName: options.runtimeName,
        version: options.version ?? '1.0.0',
        artifactSha256: 'a'.repeat(64),
        directory,
        files: [{ path: 'SKILL.md', sha256: createHash('sha256').update(body).digest('hex') }],
        state: options.state ?? 'normal',
      },
      installedAt: '2026-09-01T00:00:00.000Z',
    },
  }
}

/** 一个空的私有状态根。 */
async function stateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-host-closure-state-'))
  roots.push(root)
  return root
}

/** 交付一个可安装的发布身份：取真实服务目录里的第一条。 */
async function firstRelease(baseUrl: string, accessToken: string): Promise<{ skillId: string; version: string }> {
  const catalog = await new TeamSkillHost({ apiBaseUrl: baseUrl, accessToken }).catalog('project-alpha')
  if (catalog.status !== 'ready') throw new Error(`目录不可用: ${JSON.stringify(catalog)}`)
  const item = catalog.catalog.items[0]
  if (item === undefined) throw new Error('服务端目录里没有可安装的发布')
  return { skillId: item.skillId, version: item.version }
}

/** 一次安装请求；默认落在全局作用域。 */
function installRequest(
  item: { readonly skillId: string; readonly version: string },
  options: { readonly scope?: TeamSkillScope; readonly workspaceId?: string; readonly confirmModifiedReplace?: boolean } = {},
): TeamSkillInstallRequest {
  return {
    skillId: item.skillId,
    version: item.version,
    projectId: 'project-alpha',
    scope: options.scope ?? 'global',
    ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
    ...(options.confirmModifiedReplace === true ? { confirmModifiedReplace: true } : {}),
    environment: { dshVersion: '0.1.1', availableTools: [], availableMcpServers: [], presentEnvironmentVariableNames: [] },
  }
}

/** 一份可脚本化的凭据服务：读按脚本出牌，写 / 删就地生效并记账。 */
class CredentialVault {
  readonly writes: CredentialRecord[] = []
  private scripted: Array<CredentialRecord | undefined>
  private stored: CredentialRecord | undefined

  constructor(options: { readonly reads?: Array<CredentialRecord | undefined>; readonly stored?: CredentialRecord } = {}) {
    this.scripted = [...(options.reads ?? [])]
    this.stored = options.stored
  }

  read = (): Promise<CredentialRecord | undefined> =>
    Promise.resolve(this.scripted.length > 0 ? this.scripted.shift() : this.stored)

  modify = async (
    _key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> => {
    const next = await mutate(this.stored)
    this.stored = next
    if (next !== undefined) this.writes.push(next)
    return next
  }

  remove = (): Promise<void> => {
    this.stored = undefined
    return Promise.resolve()
  }

  /** 该接缝只实现 Host 读写的三个方法，其余由 CredentialProvider 的契约提供。 */
  asProvider(): CredentialProvider {
    return { readRecord: this.read, modifyRecord: this.modify, deleteRecord: this.remove } as unknown as CredentialProvider
  }
}

/** 一份与 Host 账号会话同形的授权记录。 */
function grantRecord(session: Session, expiresAt = Date.now() + 3_600_000): CredentialRecord {
  return {
    kind: 'grant',
    payload: {
      userId: 'member-1',
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresAt,
    },
  }
}

/** 交付存储里的授权令牌，便于断言落盘的是哪一份。 */
function storedToken(record: CredentialRecord | undefined): string | undefined {
  if (record === undefined || record.kind !== 'grant') return undefined
  const payload = record.payload
  if (typeof payload !== 'object' || payload === null || !('accessToken' in payload)) return undefined
  return typeof payload.accessToken === 'string' ? payload.accessToken : undefined
}

/** 转发到真实 fixture，同时记录每次请求的 Authorization。 */
function recordingFetch(seen: string[], forward: typeof globalThis.fetch = globalThis.fetch): typeof globalThis.fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const authorization = new Headers(init?.headers).get('authorization')
    if (authorization !== null) seen.push(authorization)
    return await forward(input, init)
  }
}

describe('TeamSkillHost 本地守卫', () => {
  it('answers every local guard explicitly when the Host is not configured for installs', async () => {
    const { baseUrl, session } = await fixtureService()
    const root = await stateRoot()
    // 有端点、有全局根、有存储，唯独没有状态根：读取、同步与安装都必须点名缺项。
    const host = new TeamSkillHost({
      apiBaseUrl: baseUrl,
      accessToken: session.accessToken,
      globalSkillRoot: join(root, 'skills'),
      installationStore: new ScriptedStore([]),
    })

    expect(await host.installations('project-alpha')).toMatchObject({ status: 'not-ready', missing: ['stateDirectory'] })
    expect(await host.syncReleaseStatus('project-alpha')).toMatchObject({ status: 'not-ready', missing: ['stateDirectory'] })
    expect(await host.install(installRequest({ skillId: 'code-review', version: '1.0.0' })))
      .toMatchObject({ status: 'not-ready', missing: ['stateDirectory'] })

    // 工作空间身份解不出本地路径：同样是显式缺项，而不是猜一个根目录。
    const unresolvable = new TeamSkillHost({
      apiBaseUrl: baseUrl,
      accessToken: session.accessToken,
      stateDirectory: root,
      globalSkillRoot: join(root, 'skills'),
      installationStore: new ScriptedStore([]),
      refreshSkillCatalog: async () => true,
      resolveWorkspace: () => undefined,
    })
    expect(await unresolvable.install(installRequest({ skillId: 'code-review', version: '1.0.0' }, {
      scope: 'project', workspaceId: 'workspace-1',
    }))).toMatchObject({ status: 'not-ready', missing: ['workspaceId'] })
  })

  it('names the missing endpoint or access token depending on what the deployment lacks', async () => {
    const { baseUrl } = await fixtureService()
    // 有端点，既没有静态 Token 也没有凭据服务：缺的是访问令牌，不是端点。
    const host = new TeamSkillHost({ apiBaseUrl: baseUrl })
    expect(await host.catalog('project-alpha')).toMatchObject({ status: 'not-ready', missing: ['accessToken'] })
    // 空字符串的静态 Token 与缺席等价：同样点名，且不把它当成可用凭据。
    const empty = new TeamSkillHost({ apiBaseUrl: baseUrl, accessToken: '' })
    expect(await empty.catalog('project-alpha')).toMatchObject({ status: 'not-ready', missing: ['accessToken'] })
    // 反过来：有静态 Token 却没有端点，缺项是端点。
    const endpointless = new TeamSkillHost({ accessToken: 'static-token' })
    expect(await endpointless.catalog('project-alpha')).toMatchObject({ status: 'not-ready', missing: ['apiBaseUrl'] })
  })

  it('reports an unresolvable local root for the copies a withdrawal touches', async () => {
    const { baseUrl, session } = await fixtureService()
    const root = await stateRoot()
    // 项目作用域却没有工作空间身份：既不能隔离已下线副本，也不能隔离未发布副本。
    const normal = await installedRecord({
      localInstallationId: 'closure-normal', runtimeName: 'skill-closure-alpha', scope: 'project',
    })
    const withdrawn = await installedRecord({
      localInstallationId: 'closure-withdrawn', runtimeName: 'skill-closure-beta', state: 'withdrawn', scope: 'project',
    })
    const host = new TeamSkillHost({
      apiBaseUrl: baseUrl,
      accessToken: session.accessToken,
      stateDirectory: root,
      globalSkillRoot: join(root, 'skills'),
      installationStore: new ScriptedStore([normal.record, withdrawn.record]),
      refreshSkillCatalog: async () => true,
    })

    expect(await host.syncReleaseStatus('project-alpha'))
      .toMatchObject({ status: 'failed', code: 'LOCAL_WORKSPACE_UNAVAILABLE' })
    // 两个副本都留在磁盘上：定位不了本地根就不能动它们。
    expect(await readdir(normal.directory)).toEqual(['SKILL.md'])
    expect(await readdir(withdrawn.directory)).toEqual(['SKILL.md'])

    // 只剩已隔离的项目作用域副本：同步先碰上隔离态，同样不能动它。
    const onlyWithdrawn = new TeamSkillHost({
      apiBaseUrl: baseUrl,
      accessToken: session.accessToken,
      stateDirectory: root,
      globalSkillRoot: join(root, 'skills'),
      installationStore: new ScriptedStore([withdrawn.record]),
      refreshSkillCatalog: async () => true,
    })
    expect(await onlyWithdrawn.syncReleaseStatus('project-alpha'))
      .toMatchObject({ status: 'failed', code: 'LOCAL_WORKSPACE_UNAVAILABLE' })
  })

  it('treats a missing discovery hook as confirmation for an already-quarantined copy', async () => {
    const { baseUrl, session } = await fixtureService()
    const root = await stateRoot()
    const { record } = await installedRecord({
      localInstallationId: 'closure-quarantined', runtimeName: 'skill-closure-gamma', state: 'withdrawn',
    })
    const store = new ScriptedStore([record])
    // 没有发现钩子：隔离态只做确认（视为已确认），不重复隔离也不写记录。
    const host = new TeamSkillHost({
      apiBaseUrl: baseUrl,
      accessToken: session.accessToken,
      stateDirectory: root,
      globalSkillRoot: join(root, 'skills'),
      installationStore: store,
    })

    const listed = await host.syncReleaseStatus('project-alpha')
    expect(Array.isArray(listed)).toBe(true)
    expect(store.upserts).toEqual([])
    expect(store.current()[0]?.installed.state).toBe('withdrawn')
  })

  it('reports an explicit local failure when DSH cannot confirm a quarantined copy', async () => {
    const { baseUrl, session } = await fixtureService()
    const root = await stateRoot()
    const { record } = await installedRecord({
      localInstallationId: 'closure-confirm', runtimeName: 'skill-closure-delta', state: 'withdrawn',
    })
    const host = new TeamSkillHost({
      apiBaseUrl: baseUrl,
      accessToken: session.accessToken,
      stateDirectory: root,
      globalSkillRoot: join(root, 'skills'),
      installationStore: new ScriptedStore([record]),
      refreshSkillCatalog: async () => false,
    })

    expect(await host.syncReleaseStatus('project-alpha'))
      .toMatchObject({ status: 'failed', code: 'LOCAL_REFRESH_FAILED' })
  })

  it('restores a quarantined copy when its record cannot be written', async () => {
    const { baseUrl, session } = await fixtureService()
    const root = await stateRoot()
    const { record, directory } = await installedRecord({
      localInstallationId: 'closure-restore', runtimeName: 'skill-closure-epsilon',
    })
    const store = new ScriptedStore([record])
    // 磁盘移动成功、记录落盘失败：副本必须搬回原位，而不是留在隔离区成为孤儿。
    store.failures.upsert = 'record write failed'
    const host = new TeamSkillHost({
      apiBaseUrl: baseUrl,
      accessToken: session.accessToken,
      stateDirectory: root,
      globalSkillRoot: join(root, 'skills'),
      installationStore: store,
      refreshSkillCatalog: async () => true,
    })

    expect(await host.syncReleaseStatus('project-alpha'))
      .toMatchObject({ status: 'failed', code: 'LOCAL_OPERATION_FAILED' })
    expect(await readdir(directory)).toEqual(['SKILL.md'])
    // 隔离区里不再留副本（只剩搬空后的容器目录）。
    expect(await readdir(join(root, 'quarantine', 'closure-restore')).catch(() => [])).toEqual([])
  })

  it('answers an unusable local store with an explicit local failure', async () => {
    const { baseUrl, session } = await fixtureService()
    const root = await stateRoot()
    const store = new ScriptedStore([])
    // 存储读取直接失败（记录文件损坏）：读取面报本地失败，不抛出也不装作空列表。
    store.failures.list = new Error('记录文件不可读')
    const host = new TeamSkillHost({
      apiBaseUrl: baseUrl,
      accessToken: session.accessToken,
      stateDirectory: root,
      globalSkillRoot: join(root, 'skills'),
      installationStore: store,
    })

    expect(await host.installations('project-alpha'))
      .toMatchObject({ status: 'failed', code: 'LOCAL_OPERATION_FAILED', message: '记录文件不可读' })
  })

  it('reports a non-Error local failure without leaking it as a crash', async () => {
    const { baseUrl, session } = await fixtureService()
    const root = await stateRoot()
    const store = new ScriptedStore([])
    // 接缝可以抛出任意值：映射必须给出稳定的本地失败码与兜底说明。
    store.failures.list = 'boom'
    const host = new TeamSkillHost({
      apiBaseUrl: baseUrl,
      accessToken: session.accessToken,
      stateDirectory: root,
      globalSkillRoot: join(root, 'skills'),
      installationStore: store,
    })

    expect(await host.installations('project-alpha')).toMatchObject({
      status: 'failed',
      code: 'LOCAL_OPERATION_FAILED',
      message: 'Team Skill local operation failed.',
    })
  })
})

describe('TeamSkillHost 安装写入与回滚', () => {
  /** 同一状态根、同一存储，只是发现钩子不同：装一次之后再来一次。 */
  function retryHost(
    baseUrl: string,
    accessToken: string,
    root: string,
    store: ScriptedStore,
    refresh: () => Promise<boolean>,
  ): TeamSkillHost {
    return new TeamSkillHost({
      apiBaseUrl: baseUrl,
      accessToken,
      stateDirectory: root,
      globalSkillRoot: join(root, 'skills'),
      installationStore: store,
      refreshSkillCatalog: async () => await refresh(),
    })
  }

  it('skips a foreign copy and restores the displaced record when discovery denies the install', async () => {
    const { baseUrl, session } = await fixtureService()
    const root = await stateRoot()
    const item = await firstRelease(baseUrl, session.accessToken)
    const store = new ScriptedStore([])

    expect((await retryHost(baseUrl, session.accessToken, root, store, async () => true).install(installRequest(item))).status)
      .toBe('succeeded')
    const installed = store.current()[0]
    expect(installed?.installed.state).toBe('normal')

    // 同一状态根里另有一个别的 Skill 的副本：它不是本次身份的物理副本，必须原样跳过。
    const foreign = await installedRecord({
      localInstallationId: 'closure-foreign', runtimeName: 'skill-closure-foreign', skillId: 'skill-other',
    })
    await store.upsert(foreign.record)

    const denied = await retryHost(baseUrl, session.accessToken, root, store, async () => false)
      .install(installRequest(item, { confirmModifiedReplace: true }))
    expect(denied).toMatchObject({ status: 'failed', code: 'LOCAL_REFRESH_FAILED' })
    // 整体回滚：被取代的旧记录恢复 normal，本次新记录删除，别家的记录不受影响。
    const states = store.states()
    expect(states.size).toBe(2)
    expect(states.get('closure-foreign')).toBe('normal')
    expect(states.get(installed?.localInstallationId ?? '')).toBe('normal')
  }, 30_000)

  it('restores the displaced record when the discovery refresh itself throws', async () => {
    const { baseUrl, session } = await fixtureService()
    const root = await stateRoot()
    const item = await firstRelease(baseUrl, session.accessToken)
    const store = new ScriptedStore([])

    expect((await retryHost(baseUrl, session.accessToken, root, store, async () => true).install(installRequest(item))).status)
      .toBe('succeeded')
    const installed = store.current()[0]
    const thrown = await retryHost(baseUrl, session.accessToken, root, store, async () => { throw new Error('目录刷新失败') })
      .install(installRequest(item, { confirmModifiedReplace: true }))

    expect(thrown.status).toBe('failed')
    // 新记录删除、旧记录恢复：安装记录与磁盘上那一份副本仍然一一对应。
    expect(store.removes).toHaveLength(1)
    expect([...store.states().entries()]).toEqual([[installed?.localInstallationId, 'normal']])
  }, 30_000)

  it('records a failed rollback instead of claiming the previous copy came back', async () => {
    const { baseUrl, session } = await fixtureService()
    const root = await stateRoot()
    const item = await firstRelease(baseUrl, session.accessToken)
    const store = new ScriptedStore([])
    expect((await retryHost(baseUrl, session.accessToken, root, store, async () => true).install(installRequest(item))).status)
      .toBe('succeeded')

    // 发现阶段抛错后回滚：删除新记录这一步失败，回滚就不能算成功。
    store.failures.remove = new Error('记录删除失败')
    const result = await retryHost(baseUrl, session.accessToken, root, store, async () => { throw new Error('目录刷新失败') })
      .install(installRequest(item, { confirmModifiedReplace: true }))

    expect(result.status).toBe('failed')
    const rollback = result.status === 'failed' ? result.stages.find(entry => entry.stage === 'rollback') : undefined
    // 部分回滚必须可见：阶段写 failed，而不是 skipped 或 succeeded。
    expect(rollback).toMatchObject({ outcome: 'failed' })
  }, 30_000)
})

describe('TeamSkillHost 账号面', () => {
  it('writes the rotated session back to Host credentials after a password change', async () => {
    const { baseUrl } = await fixtureService()
    const vault = new CredentialVault()
    const host = new TeamSkillHost({ apiBaseUrl: baseUrl, credentials: vault.asProvider() })

    expect(await host.login({ username: 'member@example.com', password: 'member-pass' }))
      .toMatchObject({ status: 'authenticated', user: { userId: 'member-1' } })
    const before = storedToken(await vault.read())
    const changed = await host.changePassword({ currentPassword: 'member-pass', newPassword: 'member-pass-2' })
    expect(changed).toMatchObject({ status: 'authenticated' })
    // 改密会吊销旧会话：新会话必须落盘，否则用户被自己的旧凭据锁在门外。
    const after = storedToken(await vault.read())
    expect(after).toBeDefined()
    expect(after).not.toBe(before)
  }, 30_000)

  it('answers account mutations signed-out when no session is stored', async () => {
    const { baseUrl } = await fixtureService()
    const host = new TeamSkillHost({ apiBaseUrl: baseUrl, credentials: new CredentialVault().asProvider() })

    expect(await host.refreshAccount()).toEqual({ status: 'signed-out' })
    expect(await host.changePassword({ currentPassword: 'a', newPassword: 'b' })).toEqual({ status: 'signed-out' })
    // 项目数据面同一条路径：没有存储的会话就不能拿静态身份去请求。
    expect(await host.catalog('project-alpha')).toEqual({ status: 'signed-out' })
  })

  it('gives a request-layer failure without stages the same stage evidence as a staged one', async () => {
    const { baseUrl, session } = await fixtureService()
    const root = await stateRoot()
    const item = await firstRelease(baseUrl, session.accessToken)
    // 存储的授权已过期、续期端点不可用：安装连访问令牌都拿不到，请求层直接失败。
    const vault = new CredentialVault({ stored: grantRecord(session, 0) })
    const host = new TeamSkillHost({
      apiBaseUrl: baseUrl,
      credentials: vault.asProvider(),
      stateDirectory: root,
      globalSkillRoot: join(root, 'skills'),
      installationStore: new ScriptedStore([]),
      refreshSkillCatalog: async () => true,
      fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (String(input).includes('/auth/refresh')) {
          return new Response(JSON.stringify({ code: 'SERVICE_UNAVAILABLE', message: '续期服务维护中', request_id: 'r', data: null }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          })
        }
        return await globalThis.fetch(input, init)
      },
    })

    const result = await host.install(installRequest(item))
    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      // 「依赖不可用」说的是怎么重试、不是停在哪一步：按既有映射落在 precheck，
      // 但必须可重试——并且阶段证据与有阶段的失败一样完整。
      expect(result.failedStage).toBe('precheck')
      expect(result.retryable.retryable).toBe(true)
      expect(result.stages.map(entry => entry.stage)).toEqual([
        'authorization', 'precheck', 'download', 'verify', 'write', 'discovery', 'rollback',
      ])
    }
  }, 30_000)

  it('treats an unusable authorization record as unusable for telemetry delivery', async () => {
    const batch = {
      schemaVersion: 1 as const,
      batchId: 'batch-closure',
      projectId: 'project-alpha',
      clientSentAt: '2026-09-18T00:00:00.000Z',
      events: [],
    }
    // 记录形状不对：非对象负载、null 负载、错误的 kind——都无法确认登录态，停止发送。
    for (const record of [
      { kind: 'grant', payload: 'not-a-grant' },
      { kind: 'grant', payload: null },
      { kind: 'password', payload: { userId: 'member-1' } },
    ] as CredentialRecord[]) {
      const host = new TeamSkillHost({
        apiBaseUrl: 'http://127.0.0.1:1/v1',
        credentials: new CredentialVault({ stored: record }).asProvider(),
      })
      expect(await host.telemetryDeliver(batch, 1_000, 'member-1'))
        .toMatchObject({ status: 'failed', code: 'CREDENTIALS_UNAVAILABLE' })
    }
  })

  it('keeps the grant the credential store already rotated to', async () => {
    const { baseUrl } = await fixtureService()
    const older = await loginSession(baseUrl)
    const newer = await loginSession(baseUrl)
    // 读序：①调用方读到的旧授权 ②续期前的复核读到已轮换的新授权。
    const vault = new CredentialVault({ reads: [grantRecord(older, 0), grantRecord(newer)] })
    const seen: string[] = []
    const host = new TeamSkillHost({ apiBaseUrl: baseUrl, credentials: vault.asProvider(), fetch: recordingFetch(seen) })

    expect(await host.catalog('project-alpha')).toMatchObject({ status: 'ready' })
    // 没有拿旧刷新令牌去换会话：直接采用存储里已经更新的那一份。
    expect(seen).toEqual([`Bearer ${newer.accessToken}`])
    expect(vault.writes).toEqual([])
  }, 30_000)

  it('keeps a grant that was rotated while the refresh was being acquired', async () => {
    const { baseUrl } = await fixtureService()
    const older = await loginSession(baseUrl)
    const rotated = await loginSession(baseUrl)
    // 读序：①调用方的旧授权 ②续期前的复核仍是同一份 ③取得续期后复核已是新的一份。
    const vault = new CredentialVault({ reads: [grantRecord(older, 0), grantRecord(older, 0), grantRecord(rotated)] })
    const seen: string[] = []
    const host = new TeamSkillHost({ apiBaseUrl: baseUrl, credentials: vault.asProvider(), fetch: recordingFetch(seen) })

    expect(await host.catalog('project-alpha')).toMatchObject({ status: 'ready' })
    expect(seen).toEqual([`Bearer ${rotated.accessToken}`])
    expect(vault.writes).toEqual([])
  }, 30_000)

  it('keeps a grant that was rotated while the refresh was in flight', async () => {
    const { baseUrl } = await fixtureService()
    const older = await loginSession(baseUrl)
    const late = await loginSession(baseUrl)
    // 读序：①②③都是旧授权，续期请求发出后才出现新的一份（④）。
    const vault = new CredentialVault({
      reads: [grantRecord(older, 0), grantRecord(older, 0), grantRecord(older, 0), grantRecord(late)],
    })
    const seen: string[] = []
    const host = new TeamSkillHost({ apiBaseUrl: baseUrl, credentials: vault.asProvider(), fetch: recordingFetch(seen) })

    expect(await host.catalog('project-alpha')).toMatchObject({ status: 'ready' })
    // 续期结果不覆盖已经更新的记录，操作改用最新那一份。
    expect(seen).toEqual([`Bearer ${late.accessToken}`])
    expect(vault.writes).toEqual([])
  }, 30_000)
})
