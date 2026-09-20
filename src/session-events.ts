/**
 * The durable session-event vocabulary this plugin owns.
 *
 * Drift record (0.1.1-rc.2 → 0.1.5-rc.2): on the source vintage the session
 * package left its event vocabulary open — `SessionEvent<T>` and
 * `Session.append(type, data)` accepted any string type — so a plugin could
 * invent durable event types without declaring them anywhere. The 0.1.5-rc.2
 * baseline seals that vocabulary into `SessionEventMap` and constrains both
 * `SessionEvent<T extends keyof SessionEventMap>` and
 * `Session.append<T extends keyof SessionEventMap>`. A plugin that owns its own
 * durable events must therefore augment the map, exactly as every first-party
 * package does (canonical form: `declare module '@deepseek-ai/dsh-session/types'`
 * — see `@deepseek-ai/dsh-agent/lib/types/types.d.ts` and
 * `@deepseek-ai/dsh-compaction/lib/types/types.d.ts`).
 *
 * This module is the package's single augmentation point. It is deliberately
 * type-only: nothing here has runtime behavior, and the module is reachable from
 * the program through `src/index.ts` and `src/client-node/index.ts`.
 *
 * @module dsh-ai-coding/session-events
 */

import type { ContextLedger } from './context-ledger.ts'
import type { TeamSkillKnowledgeSearchEventData } from './knowledge-loop.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One per model request: the ranked, permission-filtered context ledger.
     * The ledger is reconstructible from the session log alone.
     */
    'context-ledger': ContextLedger
    /**
     * One per user turn that ran knowledge retrieval, including the skipped-row
     * and failed-request shapes. Carries whitelisted fields only.
     */
    'knowledge-search': TeamSkillKnowledgeSearchEventData
  }
}
