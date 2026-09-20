/**
 * The former client-package half of the two-package split. The split is gone:
 * this repository is ONE package, and the invariants registry reserves
 * ownership per full package name —
 * `invariants: package "<name>" is already registered` is thrown by
 * `InvariantRegistry.register()` for a second registration — so the merged
 * package can carry exactly one companion. This module therefore re-exports
 * that single companion instead of registering a second one under the old
 * `@deepseek-ai/dsh-client-ui-ai-coding-platform` identity, keeping the
 * `./client-node/invariant` entry of this package's node half pointing at the
 * one registration the package owns.
 *
 * The companion it aliases carries the real checks; this half was a no-op in
 * the split (`install = () => {}`), so nothing is lost by the merge.
 *
 * @module dsh-ai-coding/client-node/invariant
 */
export { apply, inject, name } from '../invariant.ts'
