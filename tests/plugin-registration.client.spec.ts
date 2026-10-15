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
import {
  CLOUD_FILES_TAB_ID,
  CLOUD_FILES_TAB_KIND,
  CLOUD_PREVIEW_TAB_ID,
  CLOUD_WORKSPACE_TAB_ID,
  CLOUD_WORKSPACE_TAB_KIND,
} from '../src/client/index.ts'
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

  it('注册侧栏动作、浮层与右栏三个 pane，归属 id 与顺序稳定；不占中央列', () => {
    const fake = fakeContext()

    apply(fake.ctx as never)

    // 本插件自己的扩展点：侧栏动作 + 浮层（浮层保留但入口不再指向它）。
    const entries = fake.registrations.filter(registration =>
      registration.name !== 'sidebar.right.pane.tab' && registration.name !== 'main' && registration.name !== 'sidebar.panellist')
    expect(entries.map(registration => registration.name)).toEqual(['sidebar.footer.action', 'shell.overlay'])
    expect(entries.map(registration => registration.id)).toEqual(['ai-coding-platform-entry', 'ai-coding-platform-surface'])
    expect(entries.map(registration => registration.order)).toEqual([30, 30])
    expect(entries.every(registration => registration.locale === NS)).toBe(true)

    // 方案 A：官方右栏的三个产品页（工作空间 / 目录 / 预览）。断言的是**我们的实现身份**，
    // 因为正文席位按 key 关联 —— key 漂移会让面板正文挂到别处，而界面看起来只是"面板空了"。
    const panes = fake.registrations.filter(registration => registration.name === 'sidebar.right.pane.tab')
    // 顺序 = 注册顺序（目录 → 预览 → 工作空间）。页面类型本身按 kind 索引，列表顺序只影响
    // 「＋」菜单里的排列，所以这里钉住它只是为了"顺序变了看得见"。
    expect(panes.map(registration => (registration as unknown as { key: string }).key))
      .toEqual([CLOUD_FILES_TAB_ID, CLOUD_PREVIEW_TAB_ID, CLOUD_WORKSPACE_TAB_ID])

    // **我们不再占用中央列**：`main` 主面板与 `sidebar.panellist` rail 图标都已撤除
    // （A3 曾用它们把工作台放进中央列，所有者对照效果图后选定 A ⇒ 中央列永远属于外壳的会话区）。
    // 这条断言是那个决定的门禁：谁再把产品面塞进中央列，这里会红。
    expect(fake.registrations.filter(registration => registration.name === 'main')).toHaveLength(0)
    expect(fake.registrations.filter(registration => registration.name === 'sidebar.panellist')).toHaveLength(0)
  })

  it('侧栏动作打开浮层（登录/配置/完整工作台在那里）；我们不占中央列（方案 A）', () => {
    const fake = fakeContext()
    apply(fake.ctx as never)

    const entry = fake.registrations[0]?.inject() as { onOpen: () => void }
    const overlay = fake.registrations[1]?.inject() as { controller: { getSnapshot: () => boolean } }

    expect(overlay.controller.getSnapshot()).toBe(false)
    entry.onOpen()
    // 浮层是插件自己的管理台（登录、配置、完整工作台）——关掉它之后就是方案 A 的画面：
    // 中央是外壳的原生会话区，右栏是我们的三个 pane。
    expect(overlay.controller.getSnapshot()).toBe(true)
    // **同时**打开右栏的「云文件」面板：产品面住在右栏，而浮层盖着它 ——
    // 不顺手打开的话，用户关掉浮层也**没有路径发现**那些面板（所有者验收时就是这样找不到 Tab 条的）。
    expect(fake.openedPanes).toEqual([CLOUD_FILES_TAB_KIND])
    // 但仍然**不占中央列**（不 selectPanel）：中央永远是外壳的原生会话区。
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
