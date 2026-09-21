/** Remote-face envelope helpers for the browser-provided remote services. */

import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { TeamSkillHttpError } from '../../http.ts'
import { WorkspaceHttpError } from '../../workspace-http.ts'

/**
 * One Remote failure as the browser face delivers it.
 *
 * The generated client face rebuilds failures structurally on the far side of
 * the wire ("discrimination is always by `code`, never by `instanceof`"), and
 * the protocol package is not a module-table row this bundle can import as a
 * value, so the browser face constructs the same structural value — marker,
 * service code, and message included — instead of instantiating the class.
 * Service-reported codes (e.g. `PROJECT_ACCESS_FORBIDDEN`) are outside the
 * compiler's merged details map but are exactly what consumers branch on.
 * @param code - Stable service or carrier failure code.
 * @param message - Human diagnostic carried to the surface.
 * @returns the failure value for a `RemoteResult` error branch.
 */
export function remoteFailure(code: string, message: string): RemoteFailure {
  return {
    name: 'RemoteError',
    code,
    message,
    details: {},
    isDSHRemoteError: true,
  } as unknown as RemoteFailure
}

/** Wrap one business result into the face's success branch. */
export function okResult<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

/** Wrap one failure into the face's error branch. */
export function failResult(error: RemoteFailure): RemoteResult<never> {
  return { ok: false, error }
}

/**
 * Map one thrown value onto the face's failure branch. Service-reported codes
 * survive unchanged (consumers branch on them); anything else degrades to the
 * carrier code every consumer already treats as unclassified.
 * @param error - A caught value from the HTTP clients or the runtime.
 * @returns the failure value for a `RemoteResult` error branch.
 */
export function failureOf(error: unknown): RemoteFailure {
  if (error instanceof TeamSkillHttpError) return remoteFailure(error.code, error.message)
  if (error instanceof WorkspaceHttpError) return remoteFailure(error.code, error.message)
  return remoteFailure(
    'gateway/internal',
    error instanceof Error && error.message.length > 0 ? error.message : 'browser remote client failed',
  )
}
