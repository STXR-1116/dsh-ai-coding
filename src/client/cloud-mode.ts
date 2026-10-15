import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { PlatformRemote } from './remote/types.ts'
import { NS } from './locales.ts'
import { CloudSidebar } from './CloudSidebar.tsx'
import { CloudModeBadge } from './CloudModeBadge.tsx'

/**
 * 「云工作空间接管模式」控制器。
 *
 * 目标形态（所有者定义）：点插件里的「云工作空间」后，**插件接管 DSH 原生界面本身** ——
 * 左栏换成"平台会话记录 + 文件列表"，中央保持外壳的原生会话区，会话标题栏出现接管标志；
 * 退出时官方界面**原样回来**。
 *
 * 为什么"退出即还原"是**框架保证**：`develop/cordis-tutorial/02-lifecycle-and-effects`：
 * 「通过 Cordis API 建立的注册属于 effect，**会在所属插件卸载时撤销**。」
 * ⇒ 接管期间的席位注册**必须发生在子插件自己的上下文里**（`child.slots.register`），
 * 否则它们会挂在父插件上、`dispose()` 之后依然存在（那是本文件第一版的写法，已修正）。
 *
 * 为什么能用遮蔽实现：`reference/subsystems/slots`：「对于 single、list 和 keyed cell，
 * **priority 是遮蔽优先级**」「cardinality single：单个 cell，**渲染当前 priority 胜者**」——
 * 遮蔽只替换**渲染者**，声明（owner props、children）仍归 ui-workspace。
 */

/** 左栏（工作区/会话浏览）席位：`kind: 'single'`、`scope: 'root'`。 */
const WORKSPACES_SLOT = 'sidebar.workspaces'

/** 会话标题栏右侧的动作席位（接管标志挂这里）。 */
const HEADER_ACTIONS_SLOT = 'conversation.session.header.actions'

/**
 * 遮蔽优先级：**越小越优先**（实测）。
 *
 * 判定依据：注册表给未声明 priority 的条目自动分配的是**递减**的负数
 * （`allocatePriority: () => --this.nextPriority`），即"后注册者数字更小"——
 * 若"越大越优先"，后注册者反而永远遮蔽不了先注册者，与遮蔽语义相悖。
 * 第一版按"越大越优先"写了 `1`，结果是：注册确实发生（探针可见），但界面上**没有任何变化** ——
 * 因为 ui-workspace 先注册、拿到 `-1`，比 `1` 更优先。这个坑记在这里，免得再踩。
 */
const SHADOW_PRIORITY = -1000

/** 接管控制器。 */
export interface CloudModeController {
  /** 进入接管（幂等）。 */
  enter: () => void
  /** 退出接管：撤销全部注册，官方界面回来（幂等）。 */
  exit: () => void
  /** 当前是否处于接管中。 */
  isActive: () => boolean
}

/** 建立控制器所需的外部依赖。 */
export interface CloudModeDeps {
  /** 本插件的浏览器侧远程面。 */
  readonly remote: PlatformRemote
  /** 进入/退出时的一并动作（关闭浮层、切换当前会话等）。 */
  readonly onEnter?: () => void
  readonly onExit?: () => void
}

/** 席位服务的最小面（`sidebar.workspaces` 与 `conversation.session.header.actions` 由装不上的官方包声明，
 * 名字不在 `ctx.slots.inject` 的联合里，所以按本仓既有做法只做类型窄化，值仍是真实服务）。 */
interface SlotFace {
  inject: (name: string, register: () => unknown) => unknown
  register: (registration: Record<string, unknown>, component: unknown) => unknown
}

/**
 * 建立一个接管控制器（单个，随客户端片段存活）。
 * @param ctx - 客户端插件上下文。
 * @param deps - 见 {@link CloudModeDeps}。
 * @returns 控制器。
 */
export function createCloudMode(ctx: ClientContext, deps: CloudModeDeps): CloudModeController {
  /** 子插件的 fiber：非空即"接管中"。 */
  let fiber: { dispose: () => unknown } | undefined

  const takeover = {
    name: 'ai-coding-cloud-takeover',
    // 属性访问必须已注入（本仓硬规则：未 inject 的属性访问会抛错）。
    inject: ['slots', 'locale'],
    /**
     * 接管期间的注册集合。
     *
     * 注意：这里用**子上下文**的 `slots`（`child.slots`）—— 注册才归属这个子插件的 effect，
     * `fiber.dispose()` 时随之一并撤销。这一条是"退出即还原"的全部秘密。
     * @param child - 子插件上下文。
     */
    apply(child: ClientContext): void {
      const childSlots = child.slots as unknown as SlotFace
      // 左栏：以 priority 遮蔽官方占用者，只替换渲染者。
      childSlots.inject(WORKSPACES_SLOT, () => childSlots.register({
        name: WORKSPACES_SLOT,
        priority: SHADOW_PRIORITY,
        locale: NS,
        inject: (): { remote: PlatformRemote; onExit: () => void } => ({
          remote: deps.remote,
          onExit: () => { controller.exit() },
        }),
      }, CloudSidebar))
      // 会话标题栏右侧：接管标志。
      childSlots.inject(HEADER_ACTIONS_SLOT, () => childSlots.register({
        name: HEADER_ACTIONS_SLOT,
        locale: NS,
        inject: () => ({}),
      }, CloudModeBadge))
    },
  }

  const controller: CloudModeController = {
    enter: () => {
      if (fiber !== undefined) return
      fiber = ctx.plugin(takeover) as unknown as { dispose: () => unknown }
      deps.onEnter?.()
    },
    exit: () => {
      const current = fiber
      fiber = undefined
      // 卸载是异步的（框架在所有清理完成后兑现），这里不 await：调用方（按钮）不需要等待。
      void current?.dispose()
      deps.onExit?.()
    },
    isActive: () => fiber !== undefined,
  }
  return controller
}
