/* 覆盖补齐：插件入口此前没有用例导入——它的注册契约（服务依赖、两个扩展点
 * 的名称/归属 id/顺序、以及侧栏动作与浮层共用同一个控制器）全部无人看守。
 *
 * 这里用最小假 context 驱动真实 `apply()`：不引入渲染层，只钉住注册出去的东西
 * 是什么、被打开时指向哪里。二期起本插件浏览器半自提供两个 remote 命名空间
 * 服务，注册契约同样在这里看守：键名、提供行为、以及浮层拿到的 remote 面就是
 * 这两个服务实例本身。
 */
import { describe, expect, it } from 'vitest'
import * as entry from '../src/client/index.ts'
import { apply, inject } from '../src/client/index.ts'
import { NS } from '../src/client/locales.ts'

/** Fixture bearer value for the fake backend; it authorizes nothing anywhere. */
const FIXTURE_TOKEN = `fixture-token-${'not-a-secret'}`

interface Registration {
  readonly name: string
  readonly id: string
  readonly order: number
  readonly locale: string
  readonly inject: () => unknown
}

function fakeContext() {
  const effects: Array<() => void> = []
  const dictionaries: Array<{ namespace: string; zh: unknown; en: unknown }> = []
  const registrations: Registration[] = []
  const provided: Array<{ readonly name: string; readonly value: unknown }> = []
  const openedSessions: string[] = []
  let startedSessions = 0
  const ctx = {
    effect: (run: () => () => void) => {
      effects.push(run())
    },
    reflect: {
      provide: (name: string, value: unknown) => {
        provided.push({ name, value })
      },
    },
    locale: {
      register: (namespace: string, values: { zh: unknown; en: unknown }) => {
        dictionaries.push({ namespace, zh: values.zh, en: values.en })
      },
    },
    slots: {
      inject: (_name: string, register: () => unknown) => {
        register()
      },
      register: (registration: Registration) => {
        registrations.push(registration)
      },
    },
    remote: { marker: 'remote' },
    layout: { marker: 'layout' },
    sessions: {
      open: (sessionId: string) => {
        openedSessions.push(sessionId)
      },
      // 0.1.5 moved Session creation off `ctx.workspaces` onto the client session
      // face (`ISessions.create`), so the fake counts it here.
      create: () => {
        startedSessions += 1
      },
    },
    workspaces: { marker: 'workspaces' },
  }
  return {
    ctx,
    effects,
    dictionaries,
    registrations,
    provided,
    openedSessions,
    startedSessionCount: () => startedSessions,
  }
}

describe('平台插件入口注册契约', () => {
  it('声明它真正使用的服务：不含 remote 三键，也不含无人读取的 workspaces', () => {
    // inject 是**持续硬依赖**（手册：并非一次性的启动检查）：没有提供方的条目会让
    // fragment 永久 PENDING，提供方每次抖动都会卸载重载本 fragment。所以这里必须是
    // 与代码实际读取集合相等的**最小集**——`ctx.workspaces` 在本 fragment 已无读取点
    // （会话创建移到 ISessions.create），留着它只会在没有 workspace registry 的部署上
    // 白等；remote 三键则由本 fragment 自己提供，提供者不等待自己。
    expect(inject).toEqual(['locale', 'slots', 'sessions', 'layout'])
  })

  it('导出的 Config 标记 apiBaseUrl 为 required：缺环境变量时加载期校验失败', () => {
    // 0.1.5-rc.2 的浏览器 runner 不向 fragment 下发行配置（apply 的第二参为
    // undefined），loader 面的 `Config` 导出会让加载器拿 undefined 过校验、
    // 永久打红本 fragment——因此入口绝不导出名为 Config 的成员（D23，见台账）；
    // 行 schema 以别的名字保留，供设置面与未来基线复用。
    expect('Config' in entry).toBe(false)
    const schema = entry.PlatformClientConfigSchema
    const missing = schema['~standard'].validate({})
    expect('issues' in missing && missing.issues !== undefined).toBe(true)
    const blank = schema['~standard'].validate({ apiBaseUrl: '' })
    // schemastery 的 required 看不见空串——空串由显式 resolve 拒绝。
    expect('issues' in blank && blank.issues !== undefined).toBe(false)
  })

  it('未配置设置时 apply 仍完成注册（工作台进入设置面）', () => {
    const fake = fakeContext()
    apply(fake.ctx as never)
    expect(fake.provided.map(serviceEntry => serviceEntry.name)).toEqual(['remote.teamSkills', 'remote.cloudWorkspaces'])
  })

  it('浏览器半自提供 remote.teamSkills / remote.cloudWorkspaces 两个服务', () => {
    const fake = fakeContext()

    apply(fake.ctx as never)

    expect(fake.provided.map(serviceEntry => serviceEntry.name)).toEqual(['remote.teamSkills', 'remote.cloudWorkspaces'])
  })

  it('浏览器配置解析：static-token 缺 token、空白 apiBaseUrl 均拒绝', () => {
    expect(() => entry.resolvePlatformClientConfig({ apiBaseUrl: '' }))
      .toThrowError(/DSH_AI_CODING_PLATFORM_API_URL/)
    expect(() => entry.resolvePlatformClientConfig({ apiBaseUrl: 'http://backend.test/v1', authMode: 'static-token' }))
      .toThrowError(/static-token.*requires a non-empty accessToken/s)
    const resolved = entry.resolvePlatformClientConfig({ apiBaseUrl: 'http://backend.test/v1/', accessToken: FIXTURE_TOKEN })
    // 尾斜杠由 WorkspaceHttpClient 的 normalize 归一，resolver 只去空白。
    expect(resolved.workspaceApiBaseUrl).toBe('http://backend.test/v1/')
    expect(resolved.authMode).toBe('account')
  })

  it('把字典作为 effect 注册，并按本包命名空间登记', () => {
    const fake = fakeContext()

    apply(fake.ctx as never)

    expect(fake.dictionaries).toHaveLength(1)
    expect(fake.dictionaries[0]?.namespace).toBe(NS)
    // 两个字典都必须交给注册表；只给中文会让英文界面回落到键名。
    expect(Object.keys(fake.dictionaries[0]?.zh as object)).toEqual(['platform.name', 'platform.shortName', 'platform.open', 'platform.close', 'platform.demo', 'platform.offline'])
    expect(Object.keys(fake.dictionaries[0]?.en as object)).toEqual(['platform.name', 'platform.shortName', 'platform.open', 'platform.close', 'platform.demo', 'platform.offline'])
  })

  it('注册侧栏动作与浮层两个扩展点，归属 id 与顺序稳定', () => {
    const fake = fakeContext()

    apply(fake.ctx as never)

    expect(fake.registrations.map(registration => registration.name)).toEqual(['sidebar.footer.action', 'shell.overlay'])
    expect(fake.registrations.map(registration => registration.id)).toEqual(['ai-coding-platform-entry', 'ai-coding-platform-surface'])
    expect(fake.registrations.map(registration => registration.order)).toEqual([30, 30])
    expect(fake.registrations.every(registration => registration.locale === NS)).toBe(true)
  })

  it('侧栏动作与浮层共用同一个控制器实例', () => {
    const fake = fakeContext()
    apply(fake.ctx as never)

    const entry = fake.registrations[0]?.inject() as { onOpen: () => void }
    const overlay = fake.registrations[1]?.inject() as { controller: { getSnapshot: () => boolean } }

    expect(overlay.controller.getSnapshot()).toBe(false)
    entry.onOpen()
    // 侧栏动作打开的就是浮层正在读的那个控制器，不是另一个副本。
    expect(overlay.controller.getSnapshot()).toBe(true)
  })

  it('浮层拿到的 remote 面就是自提供的两个服务实例，会话目标接在所声明的服务上', () => {
    const fake = fakeContext()
    apply(fake.ctx as never)

    const overlay = fake.registrations[1]?.inject() as {
      remote: { teamSkills: unknown; cloudWorkspaces: unknown }
      layout: unknown
      openSession: (sessionId: string) => void
      startSession: () => void
    }

    expect(overlay.remote.teamSkills).toBe(fake.provided[0]?.value)
    expect(overlay.remote.cloudWorkspaces).toBe(fake.provided[1]?.value)
    expect(overlay.layout).toBe(fake.ctx.layout)
    overlay.openSession('session-1')
    overlay.startSession()
    expect(fake.openedSessions).toEqual(['session-1'])
    expect(fake.startedSessionCount()).toBe(1)
  })
})
