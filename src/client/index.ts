/** Browser entry for the single first-party AI Coding platform demo. */
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
import { PlatformSurface } from './PlatformSurface.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Platform demo shell copy. */
    aiCodingPlatform: PlatformKey
  }
}

export type { PlatformEntryProps } from './PlatformEntry.tsx'
export type { PlatformSurfaceProps } from './PlatformSurface.tsx'
export { PlatformDemoController } from './controller.ts'

/** Services required for the locale and the two DSH extension slots. */
export const inject = ['locale', 'slots', 'remote', 'remote.teamSkills', 'remote.cloudWorkspaces', 'sessions', 'workspaces', 'layout']

/**
 * The two client-side service faces this entry calls, named explicitly.
 *
 * `ctx.sessions` and `ctx.workspaces` are each declared twice in this
 * repository's single TypeScript program: the host half's
 * `@deepseek-ai/dsh-session` augments cordis `Context` with `SessionStore`, and
 * `@deepseek-ai/dsh-workspace` with the host `IWorkspaces`; the client half's
 * `@deepseek-ai/dsh-api-session-controller/client` and
 * `@deepseek-ai/dsh-api-workspace-controller/client` augment the same two keys
 * with `ISessions` and the client `IWorkspaces`. Declaration merging keeps one
 * of each pair, and here the host declarations win.
 *
 * Upstream splits the halves across `tsconfig.host.json` and
 * `tsconfig.client.json` precisely so this cannot happen; this package has one
 * root program. The values in the browser are the client faces — the members
 * named below are read from the published client contracts
 * (`ISessions.open(id: SessionId): void`, `ISessions.create(opts?)`), not
 * guessed — so the narrowing is asserted here once, at the single boundary that
 * crosses from the shared context type into client behaviour.
 */
interface ClientSessionFace {
  /** Focus one existing Session. */
  open(id: SessionId): void
  /** Create and open a new Session. */
  create(): unknown
}

/**
 * Read the client-side service faces off the shared context.
 * @param ctx - client plugin context carrying the assembled services.
 * @returns the session face and the workspace service, client-side typed.
 */
function clientFaces(ctx: ClientContext): { sessions: ClientSessionFace } {
  return { sessions: ctx.sessions as unknown as ClientSessionFace }
}

/** Register the sidebar entry and frame overlay owned by this plugin. */
export function apply(ctx: ClientContext): void {
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
      remote: typeof ctx.remote
      layout: ILayout
      openSession: (sessionId: SessionId) => void
      startSession: () => void
    } => ({
      controller,
      remote: ctx.remote,
      layout: ctx.layout,
      openSession: (sessionId) => { faces.sessions.open(sessionId) },
      // 0.1.5 removed `IWorkspaces.startSession()`: starting a Session is a
      // Session-layer operation, and the client `ISessions.create(opts?)` is its
      // replacement. The workspace registry no longer owns Session creation.
      startSession: () => { faces.sessions.create() },
    }),
  }, PlatformSurface))
}
