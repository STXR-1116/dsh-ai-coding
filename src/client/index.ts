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
import { CloudFilesTree } from './cloud-workspaces/CloudFilesTree.tsx'
import { CloudPreviewPane } from './cloud-workspaces/CloudPreviewPane.tsx'
import { CloudWorkspacePane } from './CloudWorkspacePane.tsx'
import { resolveBrowserStorage } from './cloud-workspaces/workspace-session-store.ts'
import { PlatformDemoController } from './controller.ts'
import { PlatformEntry } from './PlatformEntry.tsx'
import { PlatformSurfaceEntry } from './PlatformSurfaceEntry.tsx'
import type { PlatformSurfaceProps } from './PlatformSurface.tsx'
import { PlatformClientConfigSchema, resolvePlatformClientConfig } from './remote/config.ts'
import { resolveBrowserSettings } from './remote/settings.ts'
import { TeamSkillsRemoteService } from './remote/team-skills.ts'
import { CloudWorkspacesRemoteService } from './remote/cloud-workspaces.ts'
import type { PlatformRemote } from './remote/types.ts'

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
  /** Focus one existing Session. */
  open(id: SessionId): void
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
   * Archive a Session into the registry-global archive set: hidden from every
   * grouping surface, log and accounting slot retained.
   * @param sessionId - Session to hide.
   * @returns the remote result; `ok: false` carries a stable code.
   */
  archiveSession(sessionId: string): Promise<{ readonly ok: boolean; readonly error?: { readonly code: string; readonly message: string } }>
}

/**
 * Read the client-side service faces off the shared context.
 * @param ctx - client plugin context carrying the assembled services.
 * @returns the session and workspace faces, client-side typed.
 */
function clientFaces(ctx: ClientContext): { sessions: ClientSessionFace; workspaces: ClientWorkspacesFace | undefined } {
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

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'ai-coding-platform-entry',
    order: 30,
    locale: NS,
    inject: (): { onOpen: () => void } => ({
      // 入口打开**浮层**：登录、配置与完整工作台都在那个面里（`PlatformSurfaceEntry` 是浮层席位的
      // 占用者，需要该席位的 runtime props，不能在右栏 pane 里当普通组件渲染）。
      // 关掉浮层之后就是方案 A 的画面：中央是外壳的原生会话区，右栏是我们的三个 pane。
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
    } => ({
      controller,
      remote,
      layout: ctx.layout,
      openSession: (sessionId) => { faces.sessions.open(sessionId) },
      // 0.1.5 removed `IWorkspaces.startSession()`: starting a Session is a
      // Session-layer operation, and the client `ISessions.create(opts?)` is its
      // replacement. The workspace registry no longer owns Session creation.
      startSession: () => { faces.sessions.create() },
    }),
  }, PlatformSurfaceEntry))

  // 方案 A：产品面全部落在**右栏的 pane**（云工作空间 / 云文件 / 预览），中央列不再归我们 ——
  // 那里永远是外壳的原生会话区。因此原 A3 的 `main` 主面板注册已撤除（见设计 §16.4 A3）。
  registerCloudFilePanes(ctx, remote)

}


/** 云文件**目录**面板在官方 tab 系统里的实现身份（同时是正文席位的 key）。 */
export const CLOUD_FILES_TAB_ID = '@dsh-ai-coding/cloud-files'

/** 云文件目录面板的 kind：页面类型，按 kind 打开、不认地址。 */
export const CLOUD_FILES_TAB_KIND = 'ai-coding-cloud-files'

/** 云文件**预览**面板的实现身份。 */
export const CLOUD_PREVIEW_TAB_ID = '@dsh-ai-coding/cloud-preview'

/** 云文件预览面板的 kind。 */
export const CLOUD_PREVIEW_TAB_KIND = 'ai-coding-cloud-preview'

/**
 * 把「云文件」注册成官方右侧 Sidebar 的**两个**产品页：目录与预览。
 *
 * 为什么是两个而不是一个：所有者对照原生后指出「面板上会一直有文件列表，原生的直接是文件预览」。
 * 官方本身就是分开的 —— 内置 `files` 与 `text` 是两个 tab 类型。合成一个面板，等于让预览永远被
 * 目录压着一半。
 *
 * 两处都必须**带接收者**调用：注册表用私有字段（`this.ids`），把方法摘下来调用会丢 `this` 并抛
 * `Cannot read properties of undefined (reading 'ids')` —— 本仓在探针里踩过一次，白跑两轮。
 * @param ctx - 客户端插件上下文。
 * @param remote - 本插件的浏览器侧远程面，供面板正文读取云文件。
 */
function registerCloudFilePanes(ctx: ClientContext, remote: PlatformRemote): void {
  const tabs = (ctx.get as (name: string) => unknown)('sidebarRightTabs') as undefined | {
    register?: (definition: {
      readonly id: string
      readonly kind: string
      readonly title: (address: string) => string
    }) => unknown
  }
  for (const [id, kind, title] of [
    [CLOUD_WORKSPACE_TAB_ID, CLOUD_WORKSPACE_TAB_KIND, '云工作空间'],
    [CLOUD_FILES_TAB_ID, CLOUD_FILES_TAB_KIND, '云文件'],
    [CLOUD_PREVIEW_TAB_ID, CLOUD_PREVIEW_TAB_KIND, '预览'],
  ] as const) {
    try {
      // 省略 `patterns` ⇒ 页面类型：只按 kind 打开，不认 `dsh-resource://` 地址。
      tabs?.register?.({ id, kind, title: () => title })
    } catch (error) {
      // 重复注册等接线错误按官方语义是错误；这里只记录，不让它拖垮整个片段。
      console.warn(`[dsh-ai-coding] tab 类型注册失败（${id}）：`, error)
    }
  }

  // `sidebar.right.pane.tab` 由 `dsh-client-ui-sidebar-right` 声明，而本仓**装不上**那个包
  // （registry 不可达；它只随 DSH 安装存在），所以 `ctx.slots.inject` 的名字联合里没有这个席位。
  // 这里只把**类型**窄化，值仍是真实的 slots 服务 —— 因此接收者不丢。
  const slots = ctx.slots as unknown as {
    inject: (name: string, register: () => unknown) => unknown
    register: (registration: Record<string, unknown>, component: unknown) => unknown
  }
  slots.inject('sidebar.right.pane.tab', () => slots.register({
    name: 'sidebar.right.pane.tab',
    key: CLOUD_FILES_TAB_ID,
    locale: NS,
    inject: (): { remote: PlatformRemote; openPreview: () => void } => ({
      remote,
      // 点目录里的文件时打开/聚焦预览面板（带接收者调用）。
      openPreview: () => { openRightPane(ctx, CLOUD_PREVIEW_TAB_KIND) },
    }),
  }, CloudFilesTree))
  slots.inject('sidebar.right.pane.tab', () => slots.register({
    name: 'sidebar.right.pane.tab',
    key: CLOUD_PREVIEW_TAB_ID,
    locale: NS,
    inject: (): { remote: PlatformRemote } => ({ remote }),
  }, CloudPreviewPane))
  // 方案 A 的第三个 pane：产品面（工作空间列表 / 生命周期 / 运行与审批 / 会话记录）。
  slots.inject('sidebar.right.pane.tab', () => slots.register({
    name: 'sidebar.right.pane.tab',
    key: CLOUD_WORKSPACE_TAB_ID,
    locale: NS,
    inject: (): { remote: PlatformRemote } => ({ remote }),
  }, CloudWorkspacePane))
}

/**
 * 打开（或聚焦）官方右侧 Sidebar 里我们自己的某个面板。
 *
 * 官方契约：写操作需要**已挂载的会话面**，没有时抛错而不是写进没人绘制的面。
 * @param ctx - 客户端插件上下文。
 * @param kind - 我们的 tab kind。
 */
export function openRightPane(ctx: ClientContext, kind: string): void {
  const sidebarRight = (ctx.get as (name: string) => unknown)('sidebarRight') as undefined | {
    openTab?: (kind: string) => unknown
  }
  try {
    // 带接收者调用（同上）。
    sidebarRight?.openTab?.(kind)
  } catch (error) {
    console.warn('[dsh-ai-coding] 打开右栏面板失败（可能当前没有挂载的会话面）：', error)
  }
}

/**
 * 「云工作空间」面板（方案 A 的产品面落点）：管理列，与「云文件」「预览」并列在官方右栏。
 *
 * 它与另两个 pane 一起构成方案 A 的落点分配：**中央列永远是外壳的原生会话区**，
 * 插件的产品面全部在右栏。原先 A3 把工作台注册成 `main` 主面板（占中央列），
 * 所有者对照效果图后选定 A ⇒ 该注册已撤除。
 */
export const CLOUD_WORKSPACE_TAB_ID = '@dsh-ai-coding/cloud-workspace'

/** 「云工作空间」面板的 kind。 */
export const CLOUD_WORKSPACE_TAB_KIND = 'ai-coding-cloud-workspace'

