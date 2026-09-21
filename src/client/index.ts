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
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
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
import { PlatformDemoController } from './controller.ts'
import { PlatformEntry } from './PlatformEntry.tsx'
import { PlatformSurface, type PlatformSurfaceProps } from './PlatformSurface.tsx'
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
export { readBrowserSettings, writeBrowserSettings, resolveBrowserSettings } from './remote/settings.ts'
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
  /** Create and open a new Session. */
  create(): unknown
}

/**
 * Read the client-side service face off the shared context.
 * @param ctx - client plugin context carrying the assembled services.
 * @returns the session face, client-side typed.
 */
function clientFaces(ctx: ClientContext): { sessions: ClientSessionFace } {
  return { sessions: ctx.sessions as unknown as ClientSessionFace }
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
  // The face this plugin's components consume: the two namespaces self-hosted,
  // shaped exactly like the assembled `ctx.remote` they stand in for.
  const remote: PlatformRemote = { teamSkills, cloudWorkspaces }
  const controller = new PlatformDemoController()
  const faces = clientFaces(ctx)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-ai-coding-platform: dictionaries')

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'ai-coding-platform-entry',
    order: 30,
    locale: NS,
    inject: (): { onOpen: () => void } => ({
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
  }, PlatformSurface))
}
