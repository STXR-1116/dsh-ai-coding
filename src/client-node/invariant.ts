/**
 * Package-owned invariant companion for the AI Coding platform plugin.
 * @module dsh-ai-coding/client-node/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

// Registration identity is kept at the original two-package split name; the
// invariants service keys ownership by this string (ROADMAP: revisit on the
// first baseline bump against the published invariants contract).
const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-ai-coding-platform'

/** Cordis companion plugin name. */
export const name = 'client-ui-ai-coding-platform-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the demo owns only local browser presentation state;
 * its behavior is asserted by component tests rather than a cross-plugin event.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
