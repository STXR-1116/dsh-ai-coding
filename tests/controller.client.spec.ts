/* 覆盖补齐：`PlatformDemoController` 的幂等早返回与订阅退订。
 *
 * 侧栏动作与浮层共用这一个控制器，所以「重复 open 不重复通知」「close 未打开时
 * 不通知」是订阅者只重渲染一次的契约，此前没有用例走过这两条早返回分支。
 */
import { describe, expect, it, vi } from 'vitest'
import { PlatformDemoController } from '../src/client/controller.ts'

describe('PlatformDemoController', () => {
  it('notifies subscribers once per real transition and is idempotent', () => {
    const controller = new PlatformDemoController()
    const listener = vi.fn()
    controller.subscribe(listener)

    controller.open()
    expect(controller.getSnapshot()).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)

    // 已经打开时再 open 不得再次通知。
    controller.open()
    expect(listener).toHaveBeenCalledTimes(1)

    controller.close()
    expect(controller.getSnapshot()).toBe(false)
    expect(listener).toHaveBeenCalledTimes(2)

    // 已经关闭时再 close 同样不得通知。
    controller.close()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('stops notifying an unsubscribed listener', () => {
    const controller = new PlatformDemoController()
    const listener = vi.fn()
    const unsubscribe = controller.subscribe(listener)

    unsubscribe()
    controller.open()
    expect(listener).not.toHaveBeenCalled()
  })
})
