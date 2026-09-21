/** The remote namespaces this plugin provides in the browser. */

import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'

/**
 * The two remote namespaces this plugin's browser fragment self-hosts, shaped
 * exactly like the assembled `ctx.remote` members they stand in for. The
 * shell's typert registry only projects upstream namespaces, so this plugin's
 * faces would otherwise never leave PENDING.
 */
export type PlatformRemote = Pick<ClientRemote, 'teamSkills' | 'cloudWorkspaces'>
