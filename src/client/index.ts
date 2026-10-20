/**
 * Browser entry for the single first-party AI Coding platform demo.
 *
 * ## Coverage: this file is outside the official development manual
 *
 * The official manual (`develop/`, 18 pages) documents **Node-side plugin
 * development only**. It says nothing about the browser half: the `dsh.client`
 * declaration, `lib/client.js`, the boot graph, `remote.<ns>` services, the
 * api-remotes assembly, or how a plugin reaches the host from a served page.
 * Everything in `src/client/**` and the client rows of `package.json` therefore
 * rests on the **shipped source plus measurement**, not on documented contract —
 * the same standing recorded in `docs/official-tutorial-notes.md` and
 * `docs/api-drift-ledger.md` (D1/D2/D8/D22/D23).
 *
 * The rule this repository holds itself to for that territory: conflict with
 * nothing the manual *does* document, keep the mechanism as close to what the
 * shipped first-party packages do as possible, and mark the basis in the code
 * rather than presenting it as an official convention.
 */
// 0.1.1-rc.2 re-exported the client root context and SessionId from the
// withdrawn `@deepseek-ai/dsh-client-runtime/client` package. On the 0.1.5-rc.2
// baseline a client plugin's root context IS the cordis `Context` (every
// published client package declares `import type { Context as ClientContext }
// from '@deepseek-ai/cordis'`), and `SessionId` is assembled by the API-remotes
// facade from `@deepseek-ai/dsh-client-connection/client`.
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: contributes this plugin's Remote namespaces to TypertRemoteNamespaceMap.
import type {} from './remote-face.ts'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: `ctx.slots` and its slot registries are declared by the renderer.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ILayout, MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: `useSessions` / `useWorkspaces` are contributed to the slot
// framework's merge-extensible `GlobalStandardProps` by these two client UI
// packages, so the overlay's props only carry them once both are in the program.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
// Type-only: the client-side `ctx.sessions` / `ctx.workspaces` service faces.
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import { en, NS, zh, type PlatformKey } from './locales.ts'
import { WorkspaceSessionsRemote, type UiConversationFace } from './remote/workspace-sessions.ts'
import { resolveBrowserStorage } from './cloud-workspaces/workspace-session-store.ts'
import { readSelection } from './cloud-workspaces/cloud-files-state.ts'
import { setCurrentSession } from './current-session.ts'
import { createCloudMode } from './cloud-mode.ts'
import { PlatformDemoController } from './controller.ts'
import { PlatformEntry } from './PlatformEntry.tsx'
import { PlatformSurfaceEntry } from './PlatformSurfaceEntry.tsx'
import type { PlatformSurfaceProps } from './PlatformSurface.tsx'
import { PlatformClientConfigSchema, resolvePlatformClientConfig } from './remote/config.ts'
import { resolveBrowserSettings } from './remote/settings.ts'
import { TeamSkillsRemoteService } from './remote/team-skills.ts'
import { CloudWorkspacesRemoteService } from './remote/cloud-workspaces.ts'
import type { PlatformRemote } from './remote/types.ts'

// `LocaleNamespaceMap` 由 `@deepseek-ai/dsh-client-ui-slots` 声明（0.2.1 仍是如此），
// 所以增广**必须指向那个包** —— 指向 renderer/client 不会合并，命名空间等于没登记。
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Platform demo shell copy. */
    aiCodingPlatform: PlatformKey
  }
}

export type { PlatformEntryProps } from './PlatformEntry.tsx'
export type { PlatformSurfaceProps } from './PlatformSurface.tsx'
export { PlatformDemoController } from './controller.ts'
export { PlatformClientConfigSchema, resolvePlatformClientConfig } from './remote/config.ts'
export type { PlatformClientConfig, ResolvedPlatformClientConfig } from './remote/config.ts'
export { readBrowserSettings, readDeploymentSettings, writeBrowserSettings, resolveBrowserSettings } from './remote/settings.ts'
export type { BrowserRemoteSettings } from './remote/settings.ts'
export { TeamSkillsRemoteService } from './remote/team-skills.ts'
export { CloudWorkspacesRemoteService } from './remote/cloud-workspaces.ts'

/**
 * Services required for the locale, the two DSH extension slots and the
 * session-navigation actions the overlay hands to the workbench.
 *
 * The `remote` / `remote.teamSkills` / `remote.cloudWorkspaces` keys the
 * generated face names are deliberately ABSENT: the assembled shell's typert
 * registry only projects upstream namespaces, so waiting on them parked this
 * fragment in PENDING forever. This fragment now provides the two namespace
 * services itself, and a provider must not wait for itself.
 *
 * `workspaces` is absent for the same reason it is absent from the host row's
 * list — nothing here reads `ctx.workspaces`. Session creation moved to the
 * session face (`ISessions.create`), so the workspace registry is no longer a
 * dependency of this fragment at all. The workspace UI is still declared, but at
 * package level in `dsh.client.inject`, which is what supplies the
 * `useWorkspaces` slot prop.
 *
 * `inject` is a continuous hard dependency: every entry that has no provider
 * parks this fragment in PENDING, so the list carries exactly what the code
 * below reads.
 */
export const inject = ['locale', 'slots', 'sessions', 'layout']

/**
 * Read the client-side session face off the shared context.
 *
 * `ctx.sessions` is declared twice in this repository's single TypeScript
 * program: the host half's `@deepseek-ai/dsh-session` augments cordis
 * `Context` with `SessionStore`, and the client half's
 * `@deepseek-ai/dsh-api-session-controller/client` augments the same key with
 * `ISessions`. Declaration merging keeps one of each pair, and here the host
 * declaration wins.
 *
 * Upstream splits the halves across `tsconfig.host.json` and
 * `tsconfig.client.json` precisely so this cannot happen; this package has one
 * root program. The value in the browser is the client face — the members
 * named below are read from the published client contract
 * (`ISessions.open(id: SessionId): void`, `ISessions.create(opts?)`), not
 * guessed — so the narrowing is asserted here once, at the single boundary
 * that crosses from the shared context type into client behaviour.
 */
interface ClientSessionFace {
  /**
   * （0.2.1 已**移除**）聚焦一个既有会话。
   *
   * 旧版本 `ISessions` 有 `open(id)`，我们照着它声明了这个成员 —— 于是编译通过、
   * **运行时是 `undefined`**（真机报 `faces.sessions.open is not a function`）。
   * 0.2.1 把会话导航搬到了**工作空间面**（`UiWorkspace.openSession`，见 `ClientWorkspacesFace`），
   * 官方 `ISessions` 现在只剩 `retain` / `using` / `retainInfo`。
   * 成员保留为可选只是为了把"别再用它"写在类型上。
   */
  open?(id: SessionId): void
  /** Create and adopt a Session on the Host; resolves once addressable. */
  create(opts?: { readonly workspaceId?: string; readonly cwd?: string }): Promise<string>
  /** Resolve one Session's binding; `undefined` when the id is unknown. */
  binding(id: string): unknown
}

/**
 * The client workspace-controller slice this plugin needs.
 *
 * Same boundary and same reason as {@link ClientSessionFace}: the `workspaces` key
 * is declared by whichever half wins declaration merging in this single program,
 * so the browser face is narrowed here once — from the published client contract
 * (`IWorkspaces.archiveSession(sessionId): Promise<RemoteResult<WorkspaceArchiveValue>>`,
 * see `docs/cloud-workspace-redesign.md` §10), not guessed.
 */
interface ClientWorkspacesFace {
  /**
   * 选一个会话并显示它的对话（0.2.1 的导航入口）。
   *
   * 官方 `UiWorkspace.openSession(target: SessionTarget): void`
   * （`dsh-client-ui-workspace/lib/types/client/navigation.d.ts`）。
   * 0.2.1 把"当前显示哪个会话"从 `ISessions` 挪到了这里 —— 官方原话是
   * 「navigation belongs to view owners」。
   */
  openSession(target: unknown): void
  /**
   * Archive a Session into the registry-global archive set: hidden from every
   * grouping surface, log and accounting slot retained.
   * @param sessionId - Session to hide.
   * @returns the remote result; `ok: false` carries a stable code.
   */
  archiveSession(sessionId: string): Promise<{ readonly ok: boolean; readonly error?: { readonly code: string; readonly message: string } }>
}

/**
 * 0.2.1 的**会话导航**面（官方 `UiWorkspace`，服务键 `uiWorkspace`）。
 *
 * 从 0.1.5 的 `ISessions.open(id)` 搬到这里 —— 官方原话「navigation belongs to view owners」。
 * 只声明我们用到的那一个成员；其余成员不抄（抄一份不用的接口，是这次踩坑的同一个来源）。
 */
interface ClientUiWorkspaceFace {
  /** 选一个会话并显示它的对话。 */
  openSession(target: unknown): void
}

/**
 * 由 `ctx.inject` 在服务就绪时填充的导航面。
 *
 * 为什么还要它，而不是只靠 `ctx.get`：`ctx.get` 只在服务**已在同一可见范围**内时才返回实例；
 * 客户端服务是后注册的，`apply()` 那一刻必然取不到。`ctx.inject(['uiWorkspace'], …)` 是 cordis 的
 * 官方等待方式 —— 服务就绪后才回调，拿到的实例一定有效。两者配合：注入的先验值优先，其次现读。
 */
let injectedUiWorkspace: ClientUiWorkspaceFace | undefined

/**
 * 取导航面。
 * @param ctx - 客户端片段上下文（服务查找用它的实时视图）。
 * @returns 导航面；服务尚未就绪或未提供时为 `undefined`。
 */
function readUiWorkspace(ctx: ClientContext): ClientUiWorkspaceFace | undefined {
  if (injectedUiWorkspace !== undefined) return injectedUiWorkspace
  return ctx.get('uiWorkspace') as unknown as ClientUiWorkspaceFace | undefined
}

/**
 * Read the client-side service faces off the shared context.
 * @param ctx - client plugin context carrying the assembled services.
 * @returns the session and workspace faces, client-side typed.
 */
function clientFaces(ctx: ClientContext): {
  sessions: ClientSessionFace
  workspaces: ClientWorkspacesFace | undefined
} {
  return {
    sessions: ctx.sessions as unknown as ClientSessionFace,
    // Read through `ctx.get`, **not** as a property. This plugin does not inject
    // `workspaces` (it is an optional dependency — see the resolver, which reports
    // a stable failure when it is missing), and cordis **throws** on a property
    // read of a service the fiber did not inject:
    //   `cannot get property "webServer" without inject`
    // Reading it as `ctx.workspaces` therefore threw inside `apply()`, which killed
    // this browser fragment on load: no sidebar entry, and the mount smoke's first
    // step failed as 0.1.13 was installed. `ctx.get` is the accessor that returns
    // `undefined` instead of throwing, and it is the pattern this repository
    // already uses for optional services (`ctx.get('credentials')`).
    workspaces: ctx.get('workspaces') as unknown as ClientWorkspacesFace | undefined,
    // 导航面见 `readUiWorkspace()`：它是**现读**的，不在这里捕获（apply 时服务还没注册）。
  }
}

/**
 * Read the conversation assembly face, or `undefined` where none is provided.
 *
 * `ctx.get` through a narrow cast for the same two reasons as above: a property read
 * of a non-injected service throws, and the service key's declaration lives in
 * `@deepseek-ai/dsh-client-ui-conversation`, a package this repository does not
 * depend on (it is part of the shell's bundle). The face itself is narrowed in
 * `remote/workspace-sessions.ts`, next to the contract it mirrors.
 * @param ctx - client plugin context.
 * @returns the conversation face, or `undefined` when that plugin is not loaded.
 */
function readUiConversation(ctx: ClientContext): UiConversationFace | undefined {
  return (ctx.get as (name: string) => unknown)('uiConversation') as UiConversationFace | undefined
}

/**
 * Register the sidebar entry, the frame overlay, and the two browser-provided
 * remote namespace services owned by this plugin.
 * @param ctx - client plugin context (the mounting fiber's cordis context).
 */
export function apply(ctx: ClientContext): void {
  // The 0.1.5-rc.2 client runner delivers no mount-row configuration to
  // browser fragments (see docs/api-drift-ledger.md D23): the deployment
  // values come from the workbench's settings face instead, applied live.
  // The row schema is kept as an export for reuse and a future baseline that
  // does deliver config — but exporting it as `Config` would have the loader
  // validate `undefined` against it and brick the fragment, so it is not.
  const readConfig = resolveBrowserSettings
  // Cordis Service construction registers each face under its key
  // (`remote.teamSkills` / `remote.cloudWorkspaces`) as an effect of this
  // fiber, so unloading the row unregisters both.
  const teamSkills = new TeamSkillsRemoteService(ctx, readConfig)
  const cloudWorkspaces = new CloudWorkspacesRemoteService(
    ctx,
    readConfig,
    () => teamSkills.currentGrant(),
    (grant) => { teamSkills.clearSessionIfCurrent(grant) },
  )
  const controller = new PlatformDemoController()
  const faces = clientFaces(ctx)
  // 导航面：用 `ctx.inject` **等服务就绪**再取（`apply` 那一刻客户端服务还没注册，
  // 直接 `ctx.get` 只会拿到 undefined —— 真机上"无法切换会话"就是这个形态）。
  // 服务名不在本仓的 cordis 增广里，按本仓既有做法做一次类型窄化。
  ctx.inject(['uiWorkspace'] as never, (scoped) => {
    scoped.effect(() => {
      injectedUiWorkspace = (scoped as unknown as { uiWorkspace?: ClientUiWorkspaceFace }).uiWorkspace
      return () => { injectedUiWorkspace = undefined }
    })
  })
  // Cloud-Workspace conversation sessions: one session per Workspace, created on
  // demand and archived the moment it exists, so it never appears in the shell's
  // session list while the session controller still resolves it (redesign notes
  // §10). The durable mapping is scoped per account; when the services or the
  // storage are unavailable the face reports a stable failure rather than
  // inventing a session id.
  const workspaceSessions = new WorkspaceSessionsRemote({
    // Thunks, not values: this fragment is applied while the browser app is still
    // assembling, so a service that is absent right now may exist a moment later.
    // Capturing it here would pin this face to "unavailable" for the session.
    services: () => {
      const current = clientFaces(ctx)
      return current.workspaces === undefined
        ? undefined
        : { sessions: current.sessions, workspaces: current.workspaces, uiConversation: readUiConversation(ctx) }
    },
    storage: resolveBrowserStorage,
  })
  // The face this plugin's components consume: the two namespaces self-hosted,
  // shaped exactly like the assembled `ctx.remote` they stand in for, plus this
  // plugin's own `workspaceSessions`.
  const remote: PlatformRemote = { teamSkills, cloudWorkspaces, workspaceSessions }
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-ai-coding-platform: dictionaries')

  /**
   * 把外壳的当前会话切到某个云工作空间的会话（T2/T3 共用）。
   *
   * **放在回调里、一次点击触发一次**是有来由的：之前在视图的 React effect 里做，
   * `openSession` 每次渲染都是新闭包 ⇒ 清理函数每次渲染都跑 ⇒ "恢复→渲染→再恢复"死循环，
   * 直接把界面卡死（0.1.51 的事故）。
   *
   * @param workspaceId - 云工作空间 id。
   * @param platformSessionId - 平台会话 id；给了就映射到**该会话自己的** DSH 会话（左栏点某条记录时）。
   */
  const openWorkspaceSession = async (workspaceId: string, platformSessionId?: string): Promise<void> => {
    try {
      const account = await remote.teamSkills.account()
      const accountId = account.ok
        ? (account.value as { user?: { userId?: string } }).user?.userId
        : undefined
      const outcome = await remote.workspaceSessions.ensure({
        ...(accountId === undefined ? {} : { accountId }),
        cloudWorkspaceId: workspaceId,
        ...(platformSessionId === undefined ? {} : { platformSessionId }),
        // 接管模式的会话**留在会话列表里**（不归档）：归档态的会话当"当前会话"用时，
        // 外壳过一会儿就不再认它，中央退回"新会话"空态 ——
        // 所有者实测：「进入云工作空间后停留一段时间就会自动新开一个会话」。
        keepInList: true,
      })
      if (!outcome.ok) {
        console.warn('[dsh-ai-coding] 本工作空间的会话不可用：', outcome.message)
        return
      }
      // 0.2.1：导航在 **uiWorkspace** 面（`UiWorkspace.openSession`），不在 `ISessions` 上
      //（`dsh-client-ui-workspace` 的 `interface Context { uiWorkspace: UiWorkspace }`）。
      //
      // **必须惰性读取**：`clientFaces(ctx)` 在 `apply()` 时就被调用，而那时客户端服务
      // 往往**还没注册** —— 闭包捕获到的会是 `undefined`，之后永远失败（真机实测的正是这个形态）。
      // `readUiWorkspace()` 每次都现读，服务就绪后自然可用。
      const navigation = readUiWorkspace(ctx)
      if (navigation === undefined) {
        console.warn('[dsh-ai-coding] 无法切换会话：客户端未提供 uiWorkspace 服务')
      } else {
        navigation.openSession(outcome.sessionId)
      }
      // 方案 A：记住"插件自己打开的这个会话" —— 知识库绑定跟着它走
      //（0.2.1 起插件读不到外壳的当前会话，官方：navigation belongs to view owners）。
      setCurrentSession(String(outcome.sessionId))
    } catch (error) {
      console.warn('[dsh-ai-coding] 切换工作空间会话失败：', error)
    }
  }

  // 云工作空间**接管模式**（所有者定义）：点插件里的「云工作空间」即接管 DSH 原生界面。
  // 进入时：关掉浮层（接管的是原生界面，浮层留着会盖住它）+ 把外壳切到**本工作空间的会话**；
  // 退出时：兜底重载，官方界面回来。
  const cloudMode = createCloudMode(ctx, {
    remote,
    onEnter: () => {
      controller.close()
      const workspaceId = readSelection()?.workspaceId
      if (workspaceId === undefined) return
      void openWorkspaceSession(workspaceId)
    },
    // 退出接管：清掉"插件自己的会话" —— 否则知识库绑定会算到已经离开的会话上。
    onExit: () => { setCurrentSession(undefined) },
    // 左栏点某条会话记录 ⇒ 切到**该记录自己的**会话（映射按「工作空间 + 平台会话」做键）。
    onSelectPlatformSession: (workspaceId, platformSessionId) => {
      void openWorkspaceSession(workspaceId, platformSessionId)
    },
  })

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'ai-coding-platform-entry',
    order: 30,
    locale: NS,
    inject: (): { onOpen: () => void } => ({
      // 入口只打开**浮层**：登录、配置与插件的各个视图都在那个面里，行为与从前一致。
      // 接管原生界面是**浮层内**点「云工作空间」触发的（见 PlatformShell 的导航处理），
      // 而不是入口的职责 —— 所有者明确要求"插件功能都不变，只有云工作空间走接管"。
      onOpen: controller.open,
    }),
  }, PlatformEntry))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'ai-coding-platform-surface',
    order: 30,
    locale: NS,
    inject: (): {
      controller: PlatformDemoController
      remote: PlatformSurfaceProps['remote']
      layout: ILayout
      openSession: (sessionId: SessionId) => void
      startSession: () => void
      /** 接管入口：浮层里点「云工作空间」时调用（所有者定义的行为）。 */
      onEnterCloudMode: () => void
    } => ({
      controller,
      remote,
      layout: ctx.layout,
      // 0.2.1：导航走 uiWorkspace 面（`UiWorkspace.openSession`）—— `ISessions.open` 已不存在。
      // 与上面同理：**现读**，不要在 apply 时捕获（那时服务还没注册）。
      openSession: (sessionId) => {
        const navigation = readUiWorkspace(ctx)
        if (navigation === undefined) {
          console.warn('[dsh-ai-coding] 无法切换会话：客户端未提供 uiWorkspace 服务')
          return
        }
        navigation.openSession(sessionId)
      },
      // 0.1.5 removed `IWorkspaces.startSession()`: starting a Session is a
      // Session-layer operation, and the client `ISessions.create(opts?)` is its
      // replacement. The workspace registry no longer owns Session creation.
      startSession: () => { faces.sessions.create() },
      // 接管入口：浮层里点「云工作空间」时调用（所有者定义的行为）。
      onEnterCloudMode: () => { cloudMode.enter() },
    }),
  }, PlatformSurfaceEntry))

}