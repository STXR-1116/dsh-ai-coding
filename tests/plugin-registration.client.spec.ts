/* 覆盖补齐：插件入口此前没有用例导入——它的注册契约（服务依赖、两个扩展点
 * 的名称/归属 id/顺序、以及侧栏动作与浮层共用同一个控制器）全部无人看守。
 *
 * 这里用最小假 context 驱动真实 `apply()`：不引入渲染层，只钉住注册出去的东西
 * 是什么、被打开时指向哪里。
 */
import { describe, expect, it } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { NS } from '../src/client/locales.ts'

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
  const openedSessions: string[] = []
  let startedSessions = 0
  const ctx = {
    effect: (run: () => () => void) => {
      effects.push(run())
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
    openedSessions,
    startedSessionCount: () => startedSessions,
  }
}

describe('平台插件入口注册契约', () => {
  it('声明它真正使用的服务', () => {
    expect(inject).toEqual([
      'locale',
      'slots',
      'remote',
      'remote.teamSkills',
      'remote.cloudWorkspaces',
      'sessions',
      'workspaces',
      'layout',
    ])
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

  it('浮层的会话与工作空间目标接在所声明的服务上', () => {
    const fake = fakeContext()
    apply(fake.ctx as never)

    const overlay = fake.registrations[1]?.inject() as {
      remote: unknown
      layout: unknown
      openSession: (sessionId: string) => void
      startSession: () => void
    }

    expect(overlay.remote).toBe(fake.ctx.remote)
    expect(overlay.layout).toBe(fake.ctx.layout)
    overlay.openSession('session-1')
    overlay.startSession()
    expect(fake.openedSessions).toEqual(['session-1'])
    expect(fake.startedSessionCount()).toBe(1)
  })
})
