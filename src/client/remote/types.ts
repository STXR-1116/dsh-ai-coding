/** The remote namespaces this plugin provides in the browser. */

import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'

import type { WorkspaceSessionsFace } from './workspace-sessions.ts'

/**
 * The remote namespaces this plugin's browser fragment self-hosts, shaped
 * exactly like the assembled `ctx.remote` members they stand in for. The
 * shell's typert registry only projects upstream namespaces, so this plugin's
 * faces would otherwise never leave PENDING.
 *
 * `workspaceSessions` has no upstream counterpart — it is this plugin's own
 * capability (resolve one cloud Workspace's conversation session, hidden from
 * the shell's session list by archiving it; see
 * `docs/cloud-workspace-redesign.md` §10). It rides on the remote object because
 * that object already reaches the workbench, so the two client service faces
 * stay at the single boundary that owns them.
 */
export type PlatformRemote = Pick<ClientRemote, 'teamSkills' | 'cloudWorkspaces'> & {
  readonly workspaceSessions: WorkspaceSessionsFace
}
