/** Package-owned checks for native knowledge-search session records. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * This package owns the invariant contribution. The pre-merge two-package
 * split registered the host companion as `@deepseek-ai/dsh-ai-coding-platform`
 * and the client companion as `@deepseek-ai/dsh-client-ui-ai-coding-platform`;
 * the merged single package registers once, under its own name.
 */
const PACKAGE_NAME = 'dsh-ai-coding'

/** Cordis companion plugin name. */
export const name = 'dsh-ai-coding-invariant'
/** Invariant registry required by the companion. */
export const inject = ['invariants']

const install: InvariantInstaller = Object.assign(
  (ctx: Context, fail: InvariantFailure) => {
    ctx.on(
      'internal/dispatch',
      (_mode, eventName, args) => {
        if (eventName !== 'session/event') return
        const [, event] = args as [Session, SessionEvent]
        if (event.type !== 'knowledge-search') return
        if (event.data.knowledgeBaseIds.length === 0 || event.data.query.trim().length === 0) {
          fail(`session event ${event.seq} has an empty knowledge selection or query`)
        }
        if (event.data.knowledgeBases.some(item => !event.data.knowledgeBaseIds.includes(item.knowledgeBaseId))) {
          fail(`session event ${event.seq} reports a knowledge base outside its selected set`)
        }
      },
      { global: true },
    )
  },
  { inject: ['sessions'] },
)

/** Register the knowledge-search invariant companion. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
