import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { PlatformRemote } from './remote/types.ts'
import { NS } from './locales.ts'
import { CloudSidebarSlot } from './CloudSidebar.tsx'
import { CloudModeBadge } from './CloudModeBadge.tsx'
import { CloudWorkspaceHero } from './CloudWorkspaceHero.tsx'

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

/** 会话标题栏右侧的动作席位（接管标志挂这里）。它是 `list` 类型 ⇒ 注册**必须**带 `id`。 */
const HEADER_ACTIONS_SLOT = 'conversation.session.header.actions'

/** 接管标志在该 list 席位里的条目 id（漏了它会直接抛错 —— 真机踩过）。 */
const BADGE_ID = 'ai-coding-cloud-mode'

/**
 * 空白会话页里的**工作区控制**席位（`kind: 'single'`、`scope: 'root'`）。
 *
 * 默认占用者列的是 **DSH 本地工作区**；接管期间由我们用云工作空间替换它 ——
 * 所有者的要求是「整个会话页面的数据都应该来自于后端」。
 */
const HERO_WORKSPACE_SLOT = 'conversation.hero.workspace'

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
  /**
   * 左栏点了某条平台会话记录（T3）。实现方负责"映射 + 把外壳切到该会话"。
   * @param workspaceId - 云工作空间 id。
   * @param platformSessionId - 平台会话 id。
   */
  readonly onSelectPlatformSession?: (workspaceId: string, platformSessionId: string) => void
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
      // 把两处注册放进 `ctx.effect`：
      //  - 注册因此归属**片段的 effect**（官方：「通过 Cordis API 建立的注册属于 effect，
      //    会在所属插件卸载时撤销」）；
      //  - 同时探测 effect 的**返回值**：若可调用，那就是"按需撤销"的入口（存下来给 exit 用）。
      const effectResult = (ctx as unknown as {
        effect: (body: () => () => void) => unknown
      }).effect(() => {
        const registered: unknown[] = []
        /**
         * 逐个注册并**各自兜错**。
         *
         * 为什么必须兜：所有者在真机上遇到过 —— 标志那处注册因为漏了 `id`（该席位是 `list` 类型，
         * 注册契约要求 `options.id`）而**抛错**，异常冒泡出 `enter` ⇒ 后面的
         * `deps.onEnter?.()` 没执行 ⇒ **浮层永不关闭**，用户看到的就是"点了云工作空间没反应"。
         * 一处附属注册失败，不该让整个接管动作半途而废。
         * @param label - 出错时用于指明是哪一处。
         * @param run - 实际注册。
         */
        const attempt = (label: string, run: () => unknown): void => {
          try {
            registered.push(run())
          } catch (error) {
            console.warn(`[dsh-ai-coding] 接管注册失败（${label}）：`, error)
          }
        }
        // 左栏：遮蔽官方占用者（只替换渲染者，声明仍归 ui-workspace）。
        attempt('sidebar.workspaces', () => slots.register({
          name: WORKSPACES_SLOT,
          priority: SHADOW_PRIORITY,
          locale: NS,
          inject: (): {
            remote: PlatformRemote
            onExit: () => void
            onSelectPlatformSession?: (workspaceId: string, platformSessionId: string) => void
          } => ({
            remote: deps.remote,
            onExit: () => { controller.exit() },
            ...(deps.onSelectPlatformSession === undefined
              ? {}
              : { onSelectPlatformSession: deps.onSelectPlatformSession }),
          }),
        }, CloudSidebarSlot))
        // 会话标题栏右侧：接管标志。
        // **`id` 必须有**：该席位是 `list` 类型，注册契约要求它（随包实现：
        // `case "list": … find(e => e.options.id === options.id …)`）。漏了会直接抛错。
        attempt('conversation.session.header.actions', () => slots.register({
          name: HEADER_ACTIONS_SLOT,
          id: BADGE_ID,
          locale: NS,
          inject: () => ({}),
        }, CloudModeBadge))
        // 空白会话页的「选择工作区」：接管期间换成**云工作空间**。
        // 所有者问：「为什么在云工作空间里点会话，跳出来选择的工程还是本地的？」
        // ——那块控件是外壳席位（`kind: 'single'`），默认列 DSH 本地工作区；
        // 手册：「复用已有 cell 表示**有意替换其展示**」⇒ 用它换成云端来源。
        attempt(HERO_WORKSPACE_SLOT, () => slots.register({
          name: HERO_WORKSPACE_SLOT,
          priority: SHADOW_PRIORITY,
          locale: NS,
          inject: () => ({}),
        }, CloudWorkspaceHero))
        // 子 disposer：`register` 的返回值不一定可调用（客户端 runner 的服务代理可能不透传），
        // 所以逐个判类型再调 —— 不假装成功。
        return () => {
          for (const value of registered) {
            if (typeof value === 'function') (value as () => void)()
          }
        }
      })
      disposers = typeof effectResult === 'function' ? [effectResult as () => void] : []
      // **无论如何都要关浮层**：接管注册即便部分失败，用户也不该被困在浮层里
      // （真机事故就是这么来的）。浮层该不该关，与注册成不成功无关。
      deps.onEnter?.()
    },
    exit: () => {
      const current = disposers
      disposers = undefined
      // 先尽力按需撤销（若哪条路能用上，就不必走下面那条粗的）。
      for (const dispose of current ?? []) {
        try {
          dispose()
        } catch (error) {
          console.warn('[dsh-ai-coding] 撤销接管注册失败：', error)
        }
      }
      deps.onExit?.()
      // **兜底：重载页面。**
      //
      // 实测结论（三条路都试过，真机验证）：
      //  1. 放进 `ctx.plugin(...)` 子插件的注册，**渲染器看不到**（左栏毫无变化）；
      //  2. 从片段 ctx 注册 —— 渲染器**能看到**（接管生效），但 `register` 的返回值
      //     （注册表自己的 disposer）在客户端 runner 的服务代理下**拿不到**；
      //  3. 用 `ctx.effect` 承载时，它的返回值**也不可调用**。
      // ⇒ 目前没有可用的"按需撤销"入口。而所有者的要求是**结果**：退出后官方界面原样回来。
      // 片段重新装载即回到未接管状态，所以这里用重载收口 —— 代价是一次刷新（用户主动点按钮，
      // 不在热路径上）。拿到真正的撤销入口后应替换掉这一行（见设计稿 §8）。
      // 兜底重载。`window` 可能不存在（非浏览器环境、单测）—— 那时**什么都不做**，
      // 也绝不抛错：退出按钮在任何环境都不能把界面搞崩。
      if (typeof window !== 'undefined' && typeof window.location?.reload === 'function') {
        window.location.reload()
      }
    },
    isActive: () => disposers !== undefined,
  }
  return controller
}
