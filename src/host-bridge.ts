/**
 * Host-local operation bridge.
 *
 * ## Why this exists
 *
 * This plugin's browser half answers `remote.teamSkills` / `remote.cloudWorkspaces`
 * by calling the AI Coding backend services directly over HTTP, because the
 * shell's assembly does not project a third-party plugin's Typert faces. That
 * works for everything the *service* owns, but four Team Skill operations are
 * owned by the **host process** and cannot be answered from a browser at all:
 *
 * | endpoint | why the browser cannot answer it |
 * |---|---|
 * | `teamSkills/installations` | reads the host's local installation records |
 * | `teamSkills/syncReleaseStatus` | reconciles and quarantines host-local copies |
 * | `teamSkills/installSkill` | downloads, verifies and writes the host's Skill root |
 * | `teamSkills/uninstallSkill` | removes host-local files |
 *
 * Before this module those four answered an explicit "the browser does not do
 * this" failure, so the workbench's install button could never succeed — reported
 * in acceptance testing as
 * `安装失败：安装需要宿主本地技能目录，浏览器端不执行安装。`.
 *
 * ## Coverage: outside the official development manual
 *
 * The official manual (`develop/`, 18 pages) documents Node-side plugin work
 * only; the host⇄browser business channel is not in it. This module's contract
 * therefore rests on the **shipped source plus measurement**, not on documented
 * convention: `@deepseek-ai/dsh-client-connection` is a first-party service whose
 * own types describe `requestRejection` as the way to authenticate "another Web
 * route", and it exports the request/response envelope schemas for exactly this
 * use. The same standing is recorded in `docs/official-tutorial-notes.md`.
 *
 * ## Why a hand-registered route rather than `connection.rpc.handle()`
 *
 * `HostConnectionRpc.handle()` looks like the shorter path, but it registers the
 * physical route with `owner.webServer.register(...)` where `owner` is resolved
 * from the caller, and it throws
 * `cannot get property "webServer" without inject` even when the registering
 * context injects both `connection` and `webServer`. Measured, not assumed.
 *
 * What Connection documents *for other features* is the pair used here:
 * {@link HostConnectionHandle.requestRejection} — "Apply Connection's Host/Origin
 * checks and browser authentication to another Web route" — plus the exported
 * envelope schemas. So this module owns its HTTP route and asks Connection to
 * authenticate it, which is the same sequence `connection` applies to its own
 * channels: Host/Origin fence, then browser session, then dispatch.
 *
 * The channel is registered from the existing `dsh-ai-coding` mount row rather
 * than as a new row: the mount contract allows exactly two rows (one bare name
 * that also carries the browser roster, one host-only subpath).
 *
 * @module dsh-ai-coding/host-bridge
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { clientRequestSchema, type ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
// Type-only: declares `Context.webServer` (the route registry this bridge mounts
// on) and `Context.connection` (the trust/auth fence it defers to).
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  HOST_BRIDGE_CHANNEL,
  HOST_BRIDGE_ENDPOINTS,
  HOST_BRIDGE_INTERNAL,
  HOST_BRIDGE_UNKNOWN_ENDPOINT,
} from './bridge-contract.ts'
import type { TeamSkillHost } from './host.ts'

export {
  HOST_BRIDGE_CHANNEL,
  HOST_BRIDGE_ENDPOINTS,
  HOST_BRIDGE_INTERNAL,
  HOST_BRIDGE_UNAVAILABLE,
  HOST_BRIDGE_UNKNOWN_ENDPOINT,
} from './bridge-contract.ts'
export type { HostBridgeEndpoint } from './bridge-contract.ts'

/**
 * Default largest request body this bridge accepts.
 *
 * Every payload here is a small JSON request — the release artifact itself is
 * downloaded by the host, never uploaded by the browser — so a tight cap keeps
 * the route from being a memory amplifier. Deployments that front the route with
 * their own proxy can raise it through the mount row's `hostBridgeMaxBodyBytes`.
 */
export const HOST_BRIDGE_MAX_BODY_BYTES = 1024 * 1024

/** Deployment-owned options for the host half of the bridge. */
export interface HostBridgeOptions {
  /** Largest accepted request body; defaults to {@link HOST_BRIDGE_MAX_BODY_BYTES}. */
  readonly maxBodyBytes?: number
}

/** Read the whole request body, refusing anything above `limit`. */
async function readBody(request: IncomingMessage, limit: number): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > limit) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Answer one decoded bridge request. */
async function dispatch(
  host: TeamSkillHost,
  endpoint: string,
  payload: unknown,
): Promise<ConnectionRpcResult<unknown>> {
  try {
    switch (endpoint) {
      case HOST_BRIDGE_ENDPOINTS.installations:
        return { ok: true, value: await host.installations(payload as string) }
      case HOST_BRIDGE_ENDPOINTS.syncReleaseStatus:
        return { ok: true, value: await host.syncReleaseStatus(payload as string) }
      case HOST_BRIDGE_ENDPOINTS.install:
        return { ok: true, value: await host.install(payload as Parameters<TeamSkillHost['install']>[0]) }
      case HOST_BRIDGE_ENDPOINTS.uninstall:
        return { ok: true, value: await host.uninstall(payload as Parameters<TeamSkillHost['uninstall']>[0]) }
      default:
        return {
          ok: false,
          error: {
            code: HOST_BRIDGE_UNKNOWN_ENDPOINT,
            message: `dsh-ai-coding host bridge has no endpoint "${endpoint}".`,
            details: {},
          },
        }
    }
  } catch (error) {
    // A thrown value is a carrier or programming failure, not a business result:
    // the operations above answer their own business failures as values. Surfacing
    // it as a failure result keeps the browser's envelope contract intact.
    return {
      ok: false,
      error: {
        code: HOST_BRIDGE_INTERNAL,
        message: error instanceof Error && error.message.length > 0 ? error.message : 'host bridge call failed',
        details: {},
      },
    }
  }
}

/** The endpoint a bridge URL names, or undefined when the path is not the channel's. */
function endpointOf(pathname: string): string | undefined {
  if (pathname !== HOST_BRIDGE_CHANNEL && !pathname.startsWith(`${HOST_BRIDGE_CHANNEL}/`)) return undefined
  const rest = pathname.slice(HOST_BRIDGE_CHANNEL.length).replace(/^\//u, '')
  return rest.length === 0 ? undefined : decodeURIComponent(rest)
}

/** Send one JSON response with no caching. */
function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  response.end(text)
}

/**
 * Register the host half of the bridge on the owning context.
 *
 * Both dependencies are declared together: Connection authenticates the request
 * and the web server carries it, and a deployment with no web server simply has
 * no channel — which is correct, because without a browser carrier there is
 * nothing to bridge to. Registration is owned by the calling fiber, so unloading
 * the row withdraws the route.
 * @param ctx - host plugin context of the row that owns the host operations.
 * @param host - the operation owner to dispatch into.
 */
export function installHostBridge(ctx: Context, host: TeamSkillHost, options: HostBridgeOptions = {}): void {
  const maxBodyBytes = options.maxBodyBytes ?? HOST_BRIDGE_MAX_BODY_BYTES
  ctx.inject(['connection', 'webServer'], (bridgeCtx) => {
    bridgeCtx.effect(() => bridgeCtx.webServer.register({
      kind: 'prefix',
      path: HOST_BRIDGE_CHANNEL,
      handler: (request, response) => {
        void (async (): Promise<void> => {
          // Connection owns the trust fence and the browser session; this route
          // never sees an unauthenticated request.
          const rejection = bridgeCtx.connection.requestRejection(request)
          if (rejection !== undefined) {
            response.writeHead(rejection)
            response.end(rejection === 401 ? 'unauthorized' : 'forbidden')
            return
          }
          if (request.method !== 'POST') {
            sendJson(response, 405, { error: 'method not allowed' })
            return
          }
          if (request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
            sendJson(response, 415, { error: 'content type must be application/json' })
            return
          }
          const endpoint = endpointOf(new URL(request.url ?? '/', 'http://dsh.internal').pathname)
          if (endpoint === undefined) {
            sendJson(response, 404, { error: 'not found' })
            return
          }
          const raw = await readBody(request, maxBodyBytes)
          if (raw === undefined) {
            sendJson(response, 413, { error: 'request body too large' })
            return
          }
          let decoded: unknown
          try {
            decoded = JSON.parse(raw)
          } catch {
            sendJson(response, 400, { error: 'body is not JSON' })
            return
          }
          const parsed = clientRequestSchema.safeParse(decoded)
          if (!parsed.success) {
            sendJson(response, 400, { error: 'not a client-request envelope' })
            return
          }
          const result = await dispatch(host, endpoint, parsed.data.payload)
          // The caller correlates on the echoed id; Connection's own channels
          // answer 200 with a failure inside the envelope, and so does this one.
          sendJson(response, 200, { type: 'server-response', rpcId: parsed.data.rpcId, result })
        })()
      },
    }), `dsh-ai-coding: host bridge ${HOST_BRIDGE_CHANNEL}`)
  })
}
