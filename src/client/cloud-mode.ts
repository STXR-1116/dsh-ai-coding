import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { PlatformRemote } from './remote/types.ts'
import { NS } from './locales.ts'
import { CloudSidebarSlot } from './CloudSidebar.tsx'
import { CloudModeBadge } from './CloudModeBadge.tsx'

/**
 * 「云工作空间接管模式」控制器。
 *
 * 目标形态（所有者标注图，四条）：
 *  1. 左栏上 = **后端返回的会话记录**；
 *  2. 左栏下 = **文件列表**；
 *  3. 中央 = **外壳的原生会话区**（功能与样式不变，内容来自后端服务）；
 *  4. 右上 = **"已被接管 / 已连接"的标志**。
 * 退出接管时官方界面**原样回来**。
 *
 * ## 机制与依据
 *
 * 接管左栏 = 遮蔽官方 `sidebar.workspaces` 这个**单席位**的占用者。
 * `reference/subsystems/slots`：「对于 single、list 和 keyed cell，**priority 是遮蔽优先级**」。
 * 随包实现（**手册未覆盖，依据为随包源码 + 实测**）：
 *  - `entriesOfSlot(key)` 把按 priority **升序**排好的条目投影为"每格第一个存活条目" ⇒ 单席位
 *    **priority 最小者胜**；同优先级注册第二个会**直接抛错**；
 *  - 条目会被 `reportEntryError` 的崩溃上报**弃权**（`abdicated`），在本次注册生命期内不再进入投影。
 *
 * ## 一条实测换来的教训（本文件的核心）
 *
 * 第一版把注册放进 `ctx.plugin(...)` 装载的**子插件**里，并用 `fiber.dispose()` 退出。
 * 语义上更"框架"（注册属于子插件的 effect），但**渲染器看不到那些注册**：
 *  - `apply` 确实跑了（探针可见）、`register` 也确实返回了、连注册表投影里都**只有我们的条目**；
 *  - 可界面毫无变化：左栏仍是官方占用者，连挂在**另一个席位**上的标志也**没有**出现。
 * ⇒ 结论：**客户端片段的席位注册必须来自片段自己的上下文**。现在改为在片段 ctx 上注册，
 * 并自己持有 `register` 返回的 disposer（官方文档：「disposal authority remains with the registrant」）——
 * 退出时逐个调用即可，同时这些注册本来也属于片段的 effect，双重保障。
 */

/** 左栏（工作区/会话浏览）席位：`kind: 'single'`、`scope: 'root'`。 */
const WORKSPACES_SLOT = 'sidebar.workspaces'

/** 会话标题栏右侧的动作席位（接管标志挂这里）。 */
const HEADER_ACTIONS_SLOT = 'conversation.session.header.actions'

/** 遮蔽优先级：单席位是**最小者胜**，所以取一个足够小的值。 */
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
  /** 进入/退出时的一并动作（关闭浮层等）。 */
  readonly onEnter?: () => void
  readonly onExit?: () => void
}

/**
 * 席位服务的最小面。两个席位由装不上的官方包声明，名字不在 `ctx.slots.inject` 的联合里，
 * 所以按本仓既有做法只做类型窄化，值仍是真实服务（调用必须**带接收者**，否则丢 `this`）。
 */
interface SlotFace {
  register: (registration: Record<string, unknown>, component: unknown) => unknown
}

/**
 * 建立一个接管控制器（单个，随客户端片段存活）。
 * @param ctx - 客户端插件上下文（**必须是片段自己的**，见文件头教训）。
 * @param deps - 见 {@link CloudModeDeps}。
 * @returns 控制器。
 */
export function createCloudMode(ctx: ClientContext, deps: CloudModeDeps): CloudModeController {
  /** 接管期间的 disposer 集合：非空即"接管中"。 */
  let disposers: (() => void)[] | undefined

  const slots = ctx.slots as unknown as SlotFace

  const controller: CloudModeController = {
    enter: () => {
      if (disposers !== undefined) return
      const registered: unknown[] = [
        // 左栏：遮蔽官方占用者（只替换渲染者，声明仍归 ui-workspace）。
        slots.register({
          name: WORKSPACES_SLOT,
          priority: SHADOW_PRIORITY,
          locale: NS,
          inject: (): { remote: PlatformRemote; onExit: () => void } => ({
            remote: deps.remote,
            onExit: () => { controller.exit() },
          }),
        }, CloudSidebarSlot),
        // 会话标题栏右侧：接管标志。
        slots.register({
          name: HEADER_ACTIONS_SLOT,
          locale: NS,
          inject: () => ({}),
        }, CloudModeBadge),
      ]
      disposers = registered
        .filter((value): value is () => void => typeof value === 'function')
        .map(dispose => dispose)
      // 撤销靠 `register` 的返回值。若它没有返回可调用的 disposer（客户端 runner 的服务代理
      // 有可能不透传返回值），`disposers` 会是空的 —— 那"退出即还原"就只剩片段卸载这一条路。
      // 真机已验证：**接管本身成功**（左栏换成会话记录 + 文件列表 + 退出）；退出这一环待定，
      // 见分支说明与设计稿 §8「风险与回退」。
      deps.onEnter?.()
    },
    exit: () => {
      const current = disposers
      disposers = undefined
      // 逐个撤销：撤销后官方占用者重新胜出（这就是"退出即还原"）。
      for (const dispose of current ?? []) {
        try {
          dispose()
        } catch (error) {
          console.warn('[dsh-ai-coding] 撤销接管注册失败：', error)
        }
      }
      deps.onExit?.()
    },
    isActive: () => disposers !== undefined,
  }
  return controller
}
