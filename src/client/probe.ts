/**
 * 机制探针（**临时**）：验证复用 DSH 前端所依赖的四条机制。
 *
 * 只在 URL 带 `probe=1` 时运行（`maybeRunMechanismProbe`），因此对正常使用零影响。
 * 结果同时写进 console 与 `#ai-coding-mechanism-probe` 元素，供 `build/probe-mechanisms.mjs`
 * 用 Puppeteer 读取。**验证完即删** —— 它不是产品代码。
 *
 * 待验证（设计稿 §9.5）：
 * - M1 外壳 Conversation 能否渲染我们创建的会话（`ISessions.open` 之后）
 * - M2 **归档**会话能否 `open`（决定要不要取消归档）
 * - M3 右侧 Sidebar 能否承载我们注册的 pane（`sidebarRightTabs.register` + `sidebar.right.pane.tab`）
 * - M4 右栏**多 pane**（会话列表 + 文件 + 预览）能否共存（`split`）
 *
 * @module dsh-ai-coding/client/probe
 */

import { createElement } from 'react'

import type { Context } from '@deepseek-ai/cordis'

/** 探针输出元素 id。 */
export const PROBE_ELEMENT_ID = 'ai-coding-mechanism-probe'

/** 每条机制的结果。 */
interface MechanismResult {
  readonly ok: boolean
  readonly detail: string
}

/** 探针报告。 */
export interface ProbeReport {
  m1ShellRendersOurSession: MechanismResult
  m2ArchivedSessionOpenable: MechanismResult
  m3RightPaneRegistration: MechanismResult
  m4MultiPane: MechanismResult
  readonly facts: Record<string, unknown>
}

/** 我们持久化映射的键前缀（`workspace-session-store` 保持一致）。 */
const MAPPING_PREFIX = 'dsh-ai-coding:workspace-session'

/**
 * M2 只在首轮切换会话。
 *
 * 探针会自动重跑，而 `ISessions.open()` 会改变界面上的当前会话 —— 重复调用会把使用者从会话里
 * 反复踢回英雄页（实测：每 4 秒一次）。机制只需要验证一次。
 */
let openedOnce = false

/**
 * 首轮的成功结果。
 *
 * 探针会自动重跑，而注册**不幂等**：同一个 tab 类型 id 再次注册会被注册表按文档拒绝
 * （`tab type id … is already registered` —— 重复 id 属接线错误）。所以注册只做一次，
 * 之后各轮复用首轮结论，否则报告里看到的会是"重跑时的假失败"，而首轮其实成功了。
 */
let registered: MechanismResult | undefined
let multiPane: MechanismResult | undefined
/** 已注册的探针 kind；M4 的 `openTab` 需要它，而它在重跑时不再重新注册。 */
let probeKind: string | undefined

/** 收集 localStorage 里我们记下的会话 id（探针不创建任何东西）。 */
function mappedSessionIds(): readonly string[] {
  const ids = new Set<string>()
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key === null || !key.startsWith(MAPPING_PREFIX)) continue
      const raw = localStorage.getItem(key)
      if (raw === null) continue
      const parsed: unknown = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object') {
        for (const value of Object.values(parsed as Record<string, unknown>)) {
          if (typeof value === 'string' && value.length > 0) ids.add(value)
        }
      }
    }
  } catch { /* storage unavailable: report empty rather than throw */ }
  return [...ids]
}

/** 右侧 pane 的正文：一个可被 Puppeteer 找到的标记节点。 */
function probePaneBody() {
  // `createElement` 而非 JSX：探针是 .ts 文件，不值得为它改扩展名。
  return createElement(
    'div',
    { 'data-probe-pane': '1', style: { padding: '8px' } },
    '云工作空间探针 pane',
  )
}

/**
 * 等到应用装配完成。
 *
 * 探针是在片段 `apply()` 时被调用的，而那一刻应用**还在装配**：`uiConversation` 尚未提供、
 * 会话列表还是空的、槽位声明者还没声明自己的席位。第一次跑探针时这三件事一起出现，看起来像
 * 三条机制都不可行 —— 其实全是**装配期的假失败**。判据取"会话列表非空"（它来自 Host 的
 * `session.list`，与登录状态无关）。
 * @param read - 服务读取器。
 * @returns 等待结果（耗时与列表长度），超时也返回而不抛错。
 */
async function waitForSettled(read: (name: string) => unknown): Promise<{ elapsedMs: number; listIds: number }> {
  const started = Date.now()
  const deadline = started + 40_000
  while (Date.now() < deadline) {
    const sessions = read('sessions') as undefined | { list?: { getSnapshot?: () => { ids?: readonly string[] } } }
    const count = (() => {
      try { return sessions?.list?.getSnapshot?.().ids?.length ?? 0 } catch { return 0 }
    })()
    if (count > 0) return { elapsedMs: Date.now() - started, listIds: count }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return { elapsedMs: Date.now() - started, listIds: 0 }
}

/**
 * 等会话区（Conversation）挂载。
 *
 * 右侧 Sidebar 的席位「仅在选中 Conversation 时」挂载，而 M3 的注册依赖它；应用停在
 * 引导/选择工作区界面时它根本不存在 —— 第一次实测的 `Cannot read properties of undefined
 * (reading 'ids')` 就是这个状态造成的，与 API 形状无关。
 * @returns 等待结果：是否挂载、耗时、以及判定用到的 DOM 标记。
 */
async function waitForConversationSurface(): Promise<{ mounted: boolean; elapsedMs: number; markers: Record<string, boolean> }> {
  const started = Date.now()
  const deadline = started + 25_000
  let markers: Record<string, boolean> = {}
  while (Date.now() < deadline) {
    markers = (() => {
      try {
        return {
          editor: document.querySelector('[contenteditable="true"]') !== null,
          main: document.querySelector('main') !== null,
        }
      } catch { return { editor: false, main: false } }
    })()
    if (markers.editor) break
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return { mounted: markers.editor === true, elapsedMs: Date.now() - started, markers }
}

/**
 * 跑四条机制验证。
 * @param ctx - 客户端插件上下文。
 * @returns 报告（永不抛错：每条机制各自 try/catch）。
 */
export async function runMechanismProbe(ctx: Context): Promise<ProbeReport> {
  const facts: Record<string, unknown> = {}
  const read = (name: string): unknown => {
    try {
      return (ctx.get as (key: string) => unknown)(name)
    } catch (error) {
      return `get 抛错：${error instanceof Error ? error.message : String(error)}`
    }
  }

  // 先等装配完成，再读服务与列表 —— 否则得到的是装配期的假失败（第一次实测就是如此）。
  facts.settled = await waitForSettled(read)

  const sessions = read('sessions') as undefined | {
    list?: { getSnapshot?: () => { ids?: readonly string[]; current?: string } }
    open?: (id: string) => void
    binding?: (id: string) => unknown
  }
  const uiConversation = read('uiConversation') as undefined | { binding?: (id: string) => unknown }
  const sidebarRightTabs = read('sidebarRightTabs') as undefined | {
    register?: (definition: Record<string, unknown>) => unknown
  }
  const sidebarRight = read('sidebarRight') as undefined | {
    openTab?: (kind: string, options?: unknown) => unknown
    isExpanded?: () => boolean
    split?: (paneId?: string) => unknown
    active?: () => unknown
  }
  const slots = read('slots') as undefined | {
    register?: (registration: Record<string, unknown>, component: unknown) => unknown
    inject?: (name: string, register: () => unknown) => unknown
  }

  const ids = (() => {
    try { return sessions?.list?.getSnapshot?.().ids ?? [] } catch { return [] }
  })()
  const mapped = mappedSessionIds()
  facts.servicePresence = {
    sessions: sessions !== undefined,
    uiConversation: uiConversation !== undefined,
    sidebarRightTabs: sidebarRightTabs !== undefined,
    sidebarRight: sidebarRight !== undefined,
    slots: slots !== undefined,
  }
  facts.controllerListIds = ids.length
  facts.mappedSessionIds = mapped
  // 归档会话是否仍在控制器列表里 —— M2 的前半问。
  facts.mappedStillListed = mapped.filter(id => ids.includes(id)).length
  facts.sidebarRightExpanded = (() => {
    try { return sidebarRight?.isExpanded?.() } catch (error) { return `抛错：${String(error)}` }
  })()

  // M2（先做，因为 M1 依赖一个可用的会话 id）：把归档会话设为当前会话。
  //
  // **只在第一轮调用**：探针会自动重跑，而每次 `open()` 都会切换界面上的当前会话 —— 实测后果是
  // 所有者一进会话就被踢回「探索未至之境」英雄页（每 4 秒一次）。机制验证不需要重复切换。
  let target = mapped.find(id => ids.includes(id)) ?? mapped[0]
  const m2: MechanismResult = (() => {
    if (target === undefined) return { ok: false, detail: '没有找到我们映射过的会话 id（先前的验收可能已清掉 localStorage）' }
    if (openedOnce) return { ok: true, detail: `已在首轮 open(${target.slice(0, 12)}…)；本轮不重复切换会话` }
    try {
      sessions?.open?.(target)
      openedOnce = true
      return { ok: true, detail: `open(${target.slice(0, 12)}…) 未抛错` }
    } catch (error) {
      return { ok: false, detail: `open 抛错：${error instanceof Error ? error.message : String(error)}` }
    }
  })()

  // M1：会话装配能否为该会话解析（外壳 Conversation 渲染它的前提）。
  const m1: MechanismResult = (() => {
    if (target === undefined) return { ok: false, detail: '没有可用的会话 id' }
    try {
      const binding = uiConversation?.binding?.(target)
      if (binding === undefined) return { ok: false, detail: 'binding() 返回 undefined' }
      const chat = (binding as { target?: (kind: string) => unknown }).target?.('chat')
      const hasApi = chat !== null && typeof chat === 'object'
        && typeof (chat as { getSnapshot?: unknown }).getSnapshot === 'function'
        && typeof (chat as { subscribe?: unknown }).subscribe === 'function'
      return hasApi
        ? { ok: true, detail: 'binding().target("chat") 可解析且具备 getSnapshot/subscribe' }
        : { ok: false, detail: `chat target 形状不符：${Object.keys((chat ?? {}) as object).join(',') || '空'}` }
    } catch (error) {
      return { ok: false, detail: `binding 抛错：${error instanceof Error ? error.message : String(error)}` }
    }
  })()

  // M3：注册一个 tab 类型 + 正文，然后按 kind 打开。
  //
  // 两条实测得来的约束：
  // 1. 正文必须走 `slots.inject(...)`（官方示例写法），不能直接 `slots.register(...)` —— 席位的
  //    声明者可能还没声明它；
  // 2. **要等右侧 Sidebar 的面挂载**：官方契约是「root 作用域的 rightbar 控制器**仅在选中
  //    Conversation 时**挂载该席位」，所以它是有状态依赖的，得等 M2 的 `open()` 让会话面出现。
  //    第一次实测就是在这个状态下抛 `Cannot read properties of undefined (reading 'ids')`。
  const m3: MechanismResult = await (async () => {
    if (registered !== undefined) return { ...registered, detail: `${registered.detail}（重跑复用首轮结论）` }
    const tabs = sidebarRightTabs
    const slotRegistry = slots
    if (tabs?.register === undefined || slotRegistry?.inject === undefined || slotRegistry.register === undefined) {
      return { ok: false, detail: 'sidebarRightTabs 或 slots 服务不可用（缺 register/inject）' }
    }
    const kind = 'ai-coding-probe'
    try {
      // **带接收者**：注册表用私有字段 `this.ids`，摘下来调用会丢 `this` 并抛
      // `Cannot read properties of undefined (reading 'ids')` —— 我第一次就是这么误判的。
      tabs.register({
        id: '@dsh-ai-coding/probe',
        kind,
        patterns: ['*.probe'],
        canOpen: (address: string) => address.startsWith('dsh-resource://probe/'),
        title: () => '探针 pane',
      })
      // 正文走 `slots.inject(...)`（官方示例写法）：直接 register 会读到尚未声明的席位注册表。
      // `.bind(...)` 不只是为了过类型：它**保证接收者不丢** —— 摘下来调用会丢 `this`，
      // 本仓已经因此出过一次事故（tab 注册表那次）。
      const registerSlot = slotRegistry.register.bind(slotRegistry)
      slotRegistry.inject('sidebar.right.pane.tab', () => registerSlot(
        { name: 'sidebar.right.pane.tab', key: '@dsh-ai-coding/probe' },
        probePaneBody,
      ))
      probeKind = kind
      registered = { ok: true, detail: `已注册 kind=${kind}（带接收者调用），正文经 slots.inject 登记` }
      return registered
    } catch (error) {
      return { ok: false, detail: `注册抛错：${error instanceof Error ? error.message : String(error)}` }
    }
  })()

  // M4：开一个 tab 并 split，看 pane 能否共存（重跑复用首轮结论）。
  const m4: MechanismResult = await (async () => {
    if (multiPane !== undefined) return { ...multiPane, detail: `${multiPane.detail}（重跑复用首轮结论）` }
    if (probeKind === undefined || sidebarRight?.openTab === undefined) {
      return { ok: false, detail: 'M3 未成功或 openTab 不可用' }
    }
    try {
      // **不传 `replaceTab`**：这里调的是**导航服务** `ctx.sidebarRight.openTab`，其
      // `replaceTab?: TabId`（字符串，见随包 `service.d.ts`）；而官方文档页举的例子用的是
      // **tab 自身动作** `tab.actions.openTab`，那里的 `replaceTab?: boolean`（`slots.d.ts`）。
      // 两者同名、选项类型不同 —— 我照文档写了 `replaceTab: false`，于是布局引擎去找一个叫
      // `false` 的 tab，报 `layout: tab false has no pane`。
      sidebarRight.openTab(probeKind)
      const split = sidebarRight.split?.()
      const expanded = sidebarRight.isExpanded?.()
      facts.activeTab = (() => {
        try { return JSON.stringify(sidebarRight.active?.() ?? null).slice(0, 120) } catch (error) { return `active() 抛错：${String(error)}` }
      })()
      facts.splitReturned = split === undefined ? 'undefined' : String(split).slice(0, 40)
      facts.expandedAfterOpen = expanded
      multiPane = split === undefined
        ? { ok: false, detail: `openTab 未抛错（active=${String(facts.activeTab)}，expanded=${String(expanded)}），但 split() 返回 undefined` }
        : { ok: true, detail: `openTab 成功、split() 返回 ${String(split).slice(0, 24)}…，expanded=${String(expanded)}` }
      return multiPane
    } catch (error) {
      return { ok: false, detail: `openTab/split 抛错：${error instanceof Error ? error.message : String(error)}` }
    }
  })()

  return { m1ShellRendersOurSession: m1, m2ArchivedSessionOpenable: m2, m3RightPaneRegistration: m3, m4MultiPane: m4, facts }
}

/**
 * 当探针开关打开时运行探针，并把结果写进 console 与 DOM。
 *
 * 开关三种写法任一即可：URL 的 `?probe=1`、`globalThis.__DSH_AI_CODING_PROBE__ === true`、
 * localStorage 的 `dsh-ai-coding:probe === '1'`。后两种是必需的：**服务端会 303 重定向到 `/`**，
 * 查询串在重定向后就不见了（冒烟里记过：`server redirects to set its auth cookie — status 303`），
 * 而 `evaluateOnNewDocument` 注入的全局与存储对**每个新文档**都重新生效。
 * @param ctx - 客户端插件上下文。
 * @returns 报告，未运行时为 `undefined`。
 */
export async function maybeRunMechanismProbe(ctx: Context): Promise<ProbeReport | undefined> {
  let enabled = false
  try {
    enabled = new URLSearchParams(location.search).get('probe') === '1'
      || (globalThis as { __DSH_AI_CODING_PROBE__?: unknown }).__DSH_AI_CODING_PROBE__ === true
      || localStorage.getItem('dsh-ai-coding:probe') === '1'
  } catch {
    enabled = false
  }
  if (!enabled) return undefined

  /**
   * 跑一次并落盘结果。
   *
   * 定义为可重复调用：**应用状态会变**（尤其是"选中 Conversation 时右侧面才挂载"），
   * 所以验证脚本可以先驱动界面再重跑，而不是只能在页面加载那一刻测一次。
   */
  const write = async (): Promise<ProbeReport> => {
    const report = await runMechanismProbe(ctx)
    const text = JSON.stringify(report)
    try {
      let node = document.getElementById(PROBE_ELEMENT_ID)
      if (node === null) {
        node = document.createElement('div')
        node.id = PROBE_ELEMENT_ID
        node.style.display = 'none'
        document.body.appendChild(node)
      }
      node.textContent = text
    } catch { /* DOM 还不可用：console 仍带报告，脚本可稍后重跑 */ }
    console.log(`[ai-coding-probe] ${text}`)
    return report
  }

  try {
    const hooks = globalThis as {
      __aiCodingProbeRun?: () => Promise<ProbeReport>
      __aiCodingProbeArchive?: (id: string) => Promise<unknown>
    }
    hooks.__aiCodingProbeRun = write
    // 清理入口：验证脚本可能为了"让会话面挂载"而新建一个会话（新浏览器没有当前会话记录），
    // 跑完用它把那个会话归档隐藏 —— 否则会在 DSH 里留下一条**删不掉**的空会话
    // （官方明确：没有 Session 删除控件）。用我们自己的归档路径，不另写一套。
    hooks.__aiCodingProbeArchive = async (sessionId: string) => {
      const workspaces = readService(ctx, 'workspaces') as undefined | {
        archiveSession?: (id: string) => Promise<unknown>
      }
      return workspaces?.archiveSession?.(sessionId)
    }
  } catch { /* 暴露失败不影响首次运行 */ }

  const first = await write()

  // 自动重试：探针跑在页面加载那一刻，而 M3/M4 依赖**会话面已挂载**（官方契约：右侧 Sidebar 的
  // 席位「仅在选中 Conversation 时」挂载）。人通常是加载完之后才点进会话的，所以只跑一次必然测不到。
  // 这里每 4 秒重跑一次、最多 90 秒，M3/M4 都成功就停 —— 使用者不必碰控制台。
  const started = Date.now()
  const timer = setInterval(() => {
    if (Date.now() - started > 90_000) { clearInterval(timer); return }
    void write().then(report => {
      if (report.m3RightPaneRegistration.ok && report.m4MultiPane.ok) clearInterval(timer)
    }).catch(() => { /* 单次失败不影响后续重试 */ })
  }, 4_000)
  try {
    // 定时器不该拖住页面生命周期之外的东西；探针本身是临时件。
    (globalThis as { __aiCodingProbeTimer?: unknown }).__aiCodingProbeTimer = timer
  } catch { /* 忽略 */ }

  return first
}

/**
 * 读一个客户端服务（`ctx.get`，缺服务返回 `undefined` 而不抛）。
 * @param ctx - 客户端插件上下文。
 * @param name - 服务键。
 * @returns 服务或 `undefined`。
 */
function readService(ctx: Context, name: string): unknown {
  try {
    return (ctx.get as (key: string) => unknown)(name)
  } catch {
    return undefined
  }
}
