/** Browser entry for the single first-party AI Coding platform demo. */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
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

/** Register the sidebar entry and frame overlay owned by this plugin. */
export function apply(ctx: ClientContext): void {
  const controller = new PlatformDemoController()
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
      openSession: (sessionId) => { ctx.sessions.open(sessionId) },
      startSession: () => { ctx.workspaces.startSession() },
    }),
  }, PlatformSurface))
}
