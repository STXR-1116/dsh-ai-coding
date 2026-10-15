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
  // A3：入口改为选中主面板，这里记录 selectPanel 的调用。
  const selectedPanels: string[] = []
  // 方案 A：入口改为打开右栏面板，这里记录 openTab 的调用。
  const openedPanes: string[] = []
  let startedSessions = 0
  /** 被 dispose 掉的子插件数（接管模式"退出即还原"的判据）。 */
  let disposedChildren = 0
  /** 最近一次装载的子插件 fiber（供注册数断言）。 */
  let lastChild: { registeredCount: number; ownedCount: number } | undefined
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
    /**
     * 最小 `ctx.plugin`：装载子插件并返回 fiber。
     *
     * 「退出即还原」的依据是官方语义——注册属于 effect、随所属插件卸载撤销
     * （`develop/cordis-tutorial/02-lifecycle-and-effects`）。这个假实现把那条语义**如实模拟**：
     * 子插件注册的东西记在它自己的名下，`dispose()` 时只移除它名下的那些。
     * 若产品代码把注册错挂到父上下文（本项目第一版就是那样），这里会**报错**而不是悄悄放过。
     */
    plugin: (child: { apply?: (ctx: unknown) => void }) => {
      const owned: Registration[] = []
      const before = registrations.length
      const childCtx = {
        slots: {
          inject: (_name: string, register: () => unknown) => { register() },
          register: (registration: Registration) => {
            registrations.push(registration)
            owned.push(registration)
          },
        },
        locale: ctx.locale,
      }
      child.apply?.(childCtx)
      // 子插件没注册任何东西 = 注册挂错了上下文（正是我们要防的漂移）。
      const registered = registrations.length - before
      lastChild = { registeredCount: registered, ownedCount: owned.length }
      return {
        registeredCount: registered,
        ownedCount: owned.length,
        dispose: () => {
          for (const entry of owned) {
            const at = registrations.indexOf(entry)
            if (at >= 0) registrations.splice(at, 1)
          }
          disposedChildren += 1
        },
      }
    },
    remote: { marker: 'remote' },
    layout: { marker: 'layout', selectPanel: (panelId: string) => { selectedPanels.push(panelId) } },
    // 方案 A 的入口走右栏：`openRightPane` 通过 `ctx.get('sidebarRight').openTab(kind)` 打开面板。
    sidebarRight: { marker: 'sidebarRight', openTab: (kind: string) => { openedPanes.push(kind) } },
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
    /**
     * cordis' accessor for a service this fiber does not inject.
     *
     * The plugin reads `workspaces` through it, because a **property** read of a
     * non-injected service throws at runtime (`cannot get property … without
     * inject`) — doing that killed this whole browser fragment in 0.1.13: no sidebar
     * entry, and the mount smoke's first step went red. See `src/client/index.ts`.
     * @param name - service key being read.
     * @returns the fake service, or `undefined` for anything not provided here.
     */
    // 可选服务一律经 `ctx.get`（本仓硬规则：未 inject 的属性访问会抛错）——
    // `openRightPane` 读 `sidebarRight`、`registerCloudFilePanes` 读 `sidebarRightTabs`，
    // 所以这个假表必须把它们供上，否则那些注册会被静默跳过（测试看似通过、其实什么都没验）。
    get: (name: string): unknown => (name === 'workspaces'
      ? ctx.workspaces
      : name === 'sidebarRight'
        ? ctx.sidebarRight
        : undefined),
  }
  return {
    ctx,
    effects,
    dictionaries,
    registrations,
    provided,
    openedSessions,
    selectedPanels,
    openedPanes,
    startedSessionCount: () => startedSessions,
    disposedChildren: () => disposedChildren,
    lastChild: () => lastChild,
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

  it('只注册侧栏动作与浮层两个扩展点；不占右栏、不占中央列（接管模式之前）', () => {
    const fake = fakeContext()

    apply(fake.ctx as never)

    // 本插件自己的扩展点：侧栏动作 + 浮层。接管模式的两个席位注册**不在启动期**发生 ——
    // 它们属于接管子插件（只有点了「云工作空间」才装载，见下一条用例）。
    expect(fake.registrations.map(registration => registration.name)).toEqual(['sidebar.footer.action', 'shell.overlay'])
    expect(fake.registrations.map(registration => registration.id)).toEqual(['ai-coding-platform-entry', 'ai-coding-platform-surface'])
    expect(fake.registrations.map(registration => registration.order)).toEqual([30, 30])
    expect(fake.registrations.every(registration => registration.locale === NS)).toBe(true)

    // 启动期不碰这三处：右栏页签（A2/A3 的产物已按所有者决定撤除）、中央主面板、rail 图标。
    for (const name of ['sidebar.right.pane.tab', 'main', 'sidebar.panellist']) {
      expect(fake.registrations.filter(registration => registration.name === name)).toHaveLength(0)
    }
  })

  it('点「云工作空间」进入接管：注册左栏遮蔽与会话标志，且注册归子插件所有', async () => {
    const fake = fakeContext()
    apply(fake.ctx as never)

    const overlay = fake.registrations[1]?.inject() as {
      controller: { getSnapshot: () => boolean }
      onEnterCloudMode: () => void
    }
    overlay.onEnterCloudMode()

    // 接管期间的两处注册：左栏（遮蔽官方占用者）与会话标题栏标志。
    const names = fake.registrations.map(registration => registration.name)
    expect(names).toContain('sidebar.workspaces')
    expect(names).toContain('conversation.session.header.actions')
    // 遮蔽用的优先级必须显式给出（ui-workspace 占用时未声明 priority）。
    const shadow = fake.registrations.find(registration => registration.name === 'sidebar.workspaces')
    expect((shadow as unknown as { priority: number }).priority).toBeGreaterThan(0)
    // 接管的是原生界面：浮层顺手关掉，否则它会盖住刚接管的左栏。
    expect(overlay.controller.getSnapshot()).toBe(false)
    // **注册必须归子插件所有** —— 否则「退出即还原」是假的（框架只撤销子插件名下的注册）。
    expect(fake.lastChild()?.registeredCount).toBeGreaterThan(0)
    expect(fake.lastChild()?.ownedCount).toBe(fake.lastChild()?.registeredCount)
  })

  it('退出接管撤销全部注册：官方左栏自动回来', async () => {
    const fake = fakeContext()
    apply(fake.ctx as never)

    const overlay = fake.registrations[1]?.inject() as { onEnterCloudMode: () => void }
    overlay.onEnterCloudMode()
    const during = fake.registrations.map(registration => registration.name)

    // 退出由左栏占用者自己的按钮触发（inject 里给的回调）。
    const sidebar = fake.registrations.find(registration => registration.name === 'sidebar.workspaces') as unknown as {
      inject: () => { onExit: () => void }
    }
    sidebar.inject().onExit()
    await Promise.resolve()

    expect(fake.disposedChildren()).toBe(1)
    // 接管期间的两处注册都没了 ⇒ 官方占用者重新胜出（这就是"还原"）。
    const after = fake.registrations.map(registration => registration.name)
    expect(after).not.toContain('sidebar.workspaces')
    expect(after).not.toContain('conversation.session.header.actions')
    // 插件自己的两个扩展点不受影响。
    expect(after).toEqual(during.filter(name => name !== 'sidebar.workspaces' && name !== 'conversation.session.header.actions'))
  })

  it('侧栏动作只打开浮层（登录/配置/各视图都在那里），不碰中央列', () => {
    const fake = fakeContext()
    apply(fake.ctx as never)

    const entry = fake.registrations[0]?.inject() as { onOpen: () => void }
    const overlay = fake.registrations[1]?.inject() as { controller: { getSnapshot: () => boolean } }

    expect(overlay.controller.getSnapshot()).toBe(false)
    entry.onOpen()
    // 浮层是插件自己的管理台：登录、配置与各个视图都在里面，行为与从前一致。
    expect(overlay.controller.getSnapshot()).toBe(true)
    // 接管原生界面是**浮层内**点「云工作空间」触发的，不是入口的职责（所有者：插件功能都不变）。
    expect(fake.registrations.map(registration => registration.name)).not.toContain('sidebar.workspaces')
    expect(fake.selectedPanels).toEqual([])
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
