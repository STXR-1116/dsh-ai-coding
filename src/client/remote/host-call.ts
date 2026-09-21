/**
 * Browser caller for this plugin's host bridge.
 *
 * The counterpart of `src/host-bridge.ts`: the host registers an authenticated
 * channel on `ctx.connection.rpc`, and this module calls it. The service exists
 * only in a browser carrier; a host build of this module never runs it.
 *
 * The bridge is reached through the `connection` service rather than imported,
 * because `@deepseek-ai/dsh-client-connection/client` is a module-table row the
 * shell loads — this bundle must not inline a second copy of the wire client.
 *
 * @module dsh-ai-coding/client/remote/host-call
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { HOST_BRIDGE_CHANNEL, HOST_BRIDGE_INTERNAL, HOST_BRIDGE_UNAVAILABLE } from '../../bridge-contract.ts'
import { failResult, okResult, remoteFailure } from './errors.ts'

/**
 * Read the browser half of the connection service.
 *
 * `Context.connection` is declared twice in this repository's single TypeScript
 * program: `@deepseek-ai/dsh-client-connection` augments it with the **host**
 * registry (`HostConnectionHandle`, whose `rpc` only handles/intercepts), and
 * `@deepseek-ai/dsh-client-connection/client` augments it with the **browser**
 * handle (whose `rpc` calls). The host declaration wins here — the same
 * single-program collision recorded as D22 in `docs/api-drift-ledger.md`.
 *
 * The value in a browser carrier is the client handle, and the members used
 * below are read from that published contract (`ClientConnectionRpc.call`), so
 * the narrowing is asserted once, at the one boundary that crosses from the
 * shared context type into browser behaviour.
 * @param ctx - browser plugin context.
 * @returns the client-side RPC caller, or undefined when the shell has none.
 */
function clientRpc(ctx: Context): ClientConnectionRpc | undefined {
  const connection = ctx.get('connection') as unknown as { readonly rpc?: ClientConnectionRpc } | undefined
  return connection?.rpc
}

/**
 * The bridge is unavailable in this browser carrier.
 *
 * Distinct from a business failure: it means the shell has no Connection RPC to
 * call at all, which is a deployment fact the operator can act on, not a result
 * of the operation they asked for.
 */
/**
 * Call one host bridge endpoint and adapt the answer to the Remote face.
 *
 * Connection already authenticates the request and echoes a correlation id, so
 * this only has to translate the envelope: `{ok:true,value}` passes through,
 * and a failure becomes the face's structural `RemoteFailure` carrying the
 * bridge's own code so consumers keep branching on it.
 * @param ctx - browser plugin context carrying `connection`.
 * @param endpoint - one `HOST_BRIDGE_ENDPOINTS` value.
 * @param payload - endpoint-owned request payload.
 * @param signal - optional caller cancellation.
 * @returns the operation result in the Remote face's envelope.
 */
export async function callHostBridge<T>(
  ctx: Context,
  endpoint: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<RemoteResult<T>> {
  const rpc = clientRpc(ctx)
  if (rpc === undefined) {
    return failResult(remoteFailure(
      HOST_BRIDGE_UNAVAILABLE,
      '当前浏览器载体没有 Connection RPC 通道，无法访问宿主本地操作。',
    ))
  }
  try {
    const result = await rpc.call(HOST_BRIDGE_CHANNEL, endpoint, payload, signal)
    return result.ok ? okResult(result.value as T) : failResult(remoteFailure(result.error.code, result.error.message))
  } catch (error) {
    return failResult(remoteFailure(
      HOST_BRIDGE_INTERNAL,
      error instanceof Error && error.message.length > 0 ? error.message : 'host bridge call failed',
    ))
  }
}
