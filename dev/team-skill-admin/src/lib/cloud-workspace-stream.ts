/**
 * The admin surface's view of the cloud workspace event stream.
 *
 * The back office shows live Workspace and Run state, not a page someone
 * refreshes. This reader owns one subscription through the same-origin
 * authorized proxy: it takes the REST snapshot first, subscribes with the event
 * id that snapshot ended at, applies each frame once, reconnects from its own
 * watermark, re-reads the snapshots when the service says the replay window is
 * gone, and stops the moment the caller abandons it.
 *
 * Every frame is validated against the service's event contract before it is
 * applied: a missing or mistyped contract field is wire drift, not a value to
 * substitute, so the reader reports `stale` with the reason and keeps its cursor
 * where it was rather than advancing it on data it cannot trust.
 *
 * It is deliberately a plain class rather than a hook so the behavior can be
 * driven without a renderer, and so the React page is only wiring.
 */

/**
 * Live connection state shown to an operator.
 *
 * `stale` is the protocol-failure state: the connection is up but the service
 * sent something the event contract does not allow, so the reader stopped
 * applying frames and will not report `live` again until a valid event arrives.
 */
export type CloudStreamStatus =
  | 'idle'
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'resync'
  | 'stale'
  | 'stopped'
  | 'denied'

/** Resource types the service event contract defines; outside this set is drift. */
const RESOURCE_TYPES = ['workspace', 'run', 'file', 'changes', 'agent_profile'] as const

/** One resource type the service may name in an event. */
export type CloudStreamResourceType = (typeof RESOURCE_TYPES)[number]

/** Why a frame failed the event contract, kept for the operator surface. */
export interface CloudStreamProtocolError {
  /** Stable code, matching the Host-side vocabulary for wire drift. */
  readonly code: 'SERVICE_PROTOCOL_ERROR'
  /** What was wrong, naming the offending field. */
  readonly message: string
}

/**
 * A frame that does not satisfy the service event contract.
 *
 * Thrown internally so the parse path can reject at the first bad field instead
 * of threading a result union through every check.
 */
class CloudStreamProtocolViolation extends Error {
  readonly code = 'SERVICE_PROTOCOL_ERROR'
  constructor(message: string) {
    super(message)
    this.name = 'CloudStreamProtocolViolation'
  }
}

/** Names a value's JSON shape for a violation message. */
function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return `a ${typeof value}`
}

/** Requires one non-empty string contract field. */
function requireEventField(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new CloudStreamProtocolViolation(`${field} must be a string, received ${describeValue(value)}`)
  }
  if (value.length === 0) {
    throw new CloudStreamProtocolViolation(`${field} must not be empty`)
  }
  return value
}

/** Requires a non-negative integer revision; `0` is a legal service value. */
function requireRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new CloudStreamProtocolViolation(
      `revision must be a non-negative integer, received ${describeValue(value)}`,
    )
  }
  return value
}

/** Requires a member of the contract's resource-type union. */
function requireResourceType(value: unknown): CloudStreamResourceType {
  const candidate = requireEventField(value, 'resource_type')
  if (!(RESOURCE_TYPES as readonly string[]).includes(candidate)) {
    throw new CloudStreamProtocolViolation(
      `resource_type must be one of ${RESOURCE_TYPES.join('|')}, received ${JSON.stringify(candidate)}`,
    )
  }
  return candidate as CloudStreamResourceType
}

/** One delivered frame, already past the JSON gate. */
export interface CloudStreamEvent {
  readonly eventId: string
  readonly resourceType: CloudStreamResourceType
  readonly resourceId: string
  readonly revision: number
  readonly eventType: string
  readonly occurredAt: string
  readonly payload: Readonly<Record<string, unknown>>
}

/** What the reader reports to its owner. */
export interface CloudStreamCallbacks {
  /** Current connection state; called on every transition, never per frame. */
  readonly onStatus: (status: CloudStreamStatus) => void
  /** One frame accepted after the duplicate guard. */
  readonly onEvent: (event: CloudStreamEvent) => void
  /**
   * The service declared its replay window is gone: the caller must re-read the
   * authoritative snapshots. Rejecting keeps the stream out of `live`.
   */
  readonly onResync: () => Promise<void>
}

export interface CloudStreamOptions {
  /** Absolute or same-origin URL of the event stream, including any query. */
  readonly url: string
  /** Authorization header value; the proxy requires the admin session's bearer token. */
  readonly authorization?: string
  readonly callbacks: CloudStreamCallbacks
  /** Reconnect backoff in milliseconds; defaults to a short, bounded schedule. */
  readonly reconnectDelayMs?: (attempt: number) => number
  /** Injectable transport for tests. */
  readonly fetch?: typeof globalThis.fetch
}

const LF = String.fromCharCode(10)

/** One decoded frame plus the control markers the service interleaves. */
type Decoded = { readonly kind: 'event'; readonly frame: SseFrame } | { readonly kind: 'resync' } | { readonly kind: 'replay-done' }

interface SseFrame {
  readonly event: string
  readonly id: string
  readonly data: string
}

/** Finds the next line terminator, accepting LF, CRLF and a bare CR. */
function nextLineBreak(text: string): { readonly index: number; readonly length: number } | undefined {
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === LF) return { index, length: 1 }
    if (char === '\r') {
      if (index === text.length - 1) return undefined
      return { index, length: text[index + 1] === LF ? 2 : 1 }
    }
  }
  return undefined
}

/**
 * Parses one event frame under the service's event contract.
 *
 * Every field the contract names is required and type-checked. The reader must
 * not substitute a sentinel (`0`, `'unknown'`, `''`, `{}`) for a missing field,
 * nor borrow the SSE `id` or the event name for a missing data field: a
 * substituted value would advance the replay cursor and paint a state the
 * service never declared.
 * @param frame - One decoded SSE frame.
 * @returns the parsed event, or `undefined` for a frame that carries no event.
 * @throws CloudStreamProtocolViolation when the frame violates the contract.
 */
function parseCloudStreamEvent(frame: SseFrame): CloudStreamEvent | undefined {
  if (frame.data === '') {
    // A bare comment (heartbeat) frame decodes to nothing at all; an `id` with
    // no payload cannot carry an event, so it is drift rather than a no-op.
    if (frame.id === '') return undefined
    throw new CloudStreamProtocolViolation('event frame carried an SSE id but no data payload')
  }
  if (frame.id === '') {
    throw new CloudStreamProtocolViolation('event frame is missing the SSE id field')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(frame.data)
  } catch {
    throw new CloudStreamProtocolViolation(`event data is not valid JSON: ${frame.data.slice(0, 80)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CloudStreamProtocolViolation(`event data must be a JSON object, received ${describeValue(parsed)}`)
  }
  const record = parsed as Record<string, unknown>
  const payload = record.payload
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new CloudStreamProtocolViolation(`payload must be an object, received ${describeValue(payload)}`)
  }
  return Object.freeze({
    eventId: requireEventField(record.event_id, 'event_id'),
    resourceType: requireResourceType(record.resource_type),
    resourceId: requireEventField(record.resource_id, 'resource_id'),
    revision: requireRevision(record.revision),
    eventType: requireEventField(record.event_type, 'event_type'),
    occurredAt: requireEventField(record.occurred_at, 'occurred_at'),
    payload: Object.freeze({ ...payload }),
  })
}

/**
 * The one subscription an operator's page owns.
 *
 * Lifecycle: `start()` opens the stream; `stop()` releases it permanently. A
 * dropped connection reconnects from the last applied event id, so a resumed
 * subscription replays exactly what was missed instead of restarting.
 */
export class CloudWorkspaceStream {
  private readonly fetcher: typeof globalThis.fetch
  private readonly reconnectDelay: (attempt: number) => number
  private abort: AbortController | undefined
  private generation = 0
  private stopped = false
  /** Last applied event id; opaque, used only as the replay cursor. */
  private cursor = ''
  /** Event ids already applied, so a replayed frame is not applied twice. */
  private readonly applied = new Set<string>()
  /**
   * Highest revision applied so far, per `resource_type:resource_id`.
   *
   * This is ordering state, not duplicate state: `event_id` is only the replay
   * cursor and an exact-duplicate guard, so a service may legitimately replay an
   * older revision under a new event id on the next connection. The map belongs
   * to the subscription rather than to one connection — keeping it inside the
   * read loop let every reconnect forget what had already been applied.
   */
  private readonly appliedRevisions = new Map<string, number>()
  private attempt = 0
  private lastStatus: CloudStreamStatus = 'idle'
  /**
   * The contract violation that put this subscription in `stale`.
   *
   * Kept after the connection is torn down and re-established so the operator
   * surface keeps naming the failure until a valid event actually arrives —
   * clearing it on reconnect would report a healthy stream for a service that is
   * still sending frames the contract does not allow.
   */
  private protocolError: CloudStreamProtocolError | undefined

  constructor(private readonly options: CloudStreamOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch
    this.reconnectDelay = options.reconnectDelayMs ?? (attempt => Math.min(500 * attempt, 5000))
  }

  /** The current connection state. */
  get status(): CloudStreamStatus {
    return this.lastStatus
  }

  /** The cursor a fresh `start()` would replay from. */
  get watermark(): string {
    return this.cursor
  }

  /** The contract violation currently keeping this subscription out of `live`. */
  get violation(): CloudStreamProtocolError | undefined {
    return this.protocolError
  }

  /**
   * Starts (or restarts) the subscription.
   * @param afterEventId - Watermark the REST snapshot ended at; `''` means none.
   */
  start(afterEventId = ''): void {
    this.stop()
    this.stopped = false
    this.cursor = afterEventId
    this.applied.clear()
    this.appliedRevisions.clear()
    this.protocolError = undefined
    this.attempt = 0
    const generation = this.generation + 1
    this.generation = generation
    this.abort = new AbortController()
    void this.loop(generation, this.abort.signal)
  }

  /**
   * Releases the subscription.
   *
   * After this the reader holds no connection, no timer and no cursor, so an
   * unmounted page cannot keep rendering frames from a stream nobody owns.
   */
  stop(): void {
    this.stopped = true
    this.generation += 1
    this.abort?.abort()
    this.abort = undefined
    this.cursor = ''
    this.applied.clear()
    this.appliedRevisions.clear()
    this.protocolError = undefined
    this.setState('stopped')
  }

  private setStatus(status: CloudStreamStatus): void {
    this.lastStatus = status
    this.options.callbacks.onStatus(status)
  }

  /** Reports a state only when it actually changed, so the UI is not re-rendered per frame. */
  private setState(status: CloudStreamStatus): void {
    if (status === this.lastStatus) return
    this.setStatus(status)
  }

  /** Builds the stream URL for the current cursor. */
  private url(): string {
    const separator = this.options.url.includes('?') ? '&' : '?'
    return `${this.options.url}${separator}after=${encodeURIComponent(this.cursor)}`
  }

  private isCurrent(generation: number, signal: AbortSignal): boolean {
    return !this.stopped && generation === this.generation && !signal.aborted
  }

  private async loop(generation: number, signal: AbortSignal): Promise<void> {
    for (;;) {
      if (!this.isCurrent(generation, signal)) return
      // A stale protocol failure outranks the reconnect states: the operator
      // must keep seeing why this subscription is not live.
      this.setState(this.protocolError === undefined
        ? (this.attempt === 0 && this.cursor === '' ? 'connecting' : 'reconnecting')
        : 'stale')
      try {
        const response = await this.fetcher(this.url(), {
          headers: {
            accept: 'text/event-stream',
            ...(this.options.authorization === undefined ? {} : { authorization: this.options.authorization }),
          },
          cache: 'no-store',
          signal,
        })
        if (!this.isCurrent(generation, signal)) return
        if (!response.ok) {
          // A rejected session is not a transient outage: retrying would hammer
          // the proxy and still never deliver data, so it stops and says why.
          if (response.status === 401 || response.status === 403) {
            this.setState('denied')
            return
          }
          throw new Error(`event stream rejected with HTTP ${response.status}`)
        }
        if (response.body === null) throw new Error('event stream has no body')
        const outcome = await this.consume(response.body, generation, signal)
        if (!this.isCurrent(generation, signal)) return
        if (outcome === 'resynced') {
          // The snapshot is authoritative again, so the window is replayed from
          // its start on a fresh connection, immediately and without backoff.
          this.attempt = 0
          continue
        }
        this.attempt += 1
      } catch {
        if (!this.isCurrent(generation, signal)) return
        this.attempt += 1
      }
      if (!this.isCurrent(generation, signal)) return
      await delay(this.reconnectDelay(this.attempt), signal)
    }
  }

  /**
   * Reads one connection to its end, applying each frame exactly once.
   *
   * Ordering is the service's: `revision` decides whether an event is progress
   * for its resource, while the opaque `event_id` is only the replay cursor and
   * an exact-duplicate guard.
   *
   * A frame that violates the event contract ends the read as `stale`: the
   * caller reconnects from the cursor it already had, so the bad frame is never
   * applied and never advances the replay position.
   */
  private async consume(
    body: ReadableStream<Uint8Array>,
    generation: number,
    signal: AbortSignal,
  ): Promise<'ended' | 'resynced' | 'stale'> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffered = ''
    let event = ''
    let id = ''
    let data = ''
    let sawField = false
    let resynced = false
    let violated = false

    const dispatch = async (): Promise<void> => {
      const frameEvent = event === '' ? 'message' : event
      const frameId = id
      const frameData = data
      event = ''
      id = ''
      data = ''
      const wasField = sawField
      sawField = false
      if (!wasField && frameId === '' && frameData === '') return
      if (frameEvent === 'stream.replay-done') {
        // The service declared its replay complete, which is evidence that the
        // peer speaks the protocol. Reporting `live` here keeps a healthy but
        // empty replay window connected, without claiming liveness for a stream
        // whose frames have not yet been validated.
        if (this.protocolError === undefined) this.setState('live')
        return
      }
      if (frameEvent === 'resync_required') {
        this.setState('resync')
        try {
          await this.options.callbacks.onResync()
        } catch {
          // A snapshot that cannot be re-read leaves the window unverified, so
          // the caller keeps showing `resync` instead of a healthy live stream,
          // and the connection is left as it is rather than resumed blind.
          return
        }
        // The snapshot is authoritative again, so the window is replayed from
        // its start on a new connection. Revision state is deliberately KEPT: the
        // snapshot was read after everything already applied, so the replayed
        // window is old news and only genuinely newer events should reach the
        // page. (A `RESYNC_REQUIRED` is the service asking for a snapshot, not
        // permission to move the operator's view backwards.)
        this.cursor = ''
        this.applied.clear()
        resynced = true
        return
      }
      let frame: CloudStreamEvent | undefined
      try {
        frame = parseCloudStreamEvent({ event: frameEvent, id: frameId, data: frameData })
      } catch (error) {
        // The frame is rejected as a whole: nothing is applied, the cursor stays
        // where it was, and the connection stops claiming to be live until a
        // valid event arrives.
        const violation = error instanceof CloudStreamProtocolViolation
          ? error
          : new CloudStreamProtocolViolation(String(error))
        this.protocolError = { code: violation.code, message: violation.message }
        this.setState('stale')
        violated = true
        return
      }
      if (frame === undefined) return
      if (this.applied.has(frame.eventId)) return
      const key = `${frame.resourceType}:${frame.resourceId}`
      const appliedRevision = this.appliedRevisions.get(key)
      // Duplicates and stale replays are dropped; the service owns ordering, and
      // its revisions are monotonic per resource across connections. An equal
      // revision under a different event id is no progress either, so the
      // comparison is `<=` rather than `<`.
      if (appliedRevision !== undefined && frame.revision <= appliedRevision) return
      this.appliedRevisions.set(key, frame.revision)
      this.applied.add(frame.eventId)
      this.cursor = frame.eventId
      this.protocolError = undefined
      this.setState('live')
      this.options.callbacks.onEvent(frame)
    }

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!this.isCurrent(generation, signal)) return 'ended'
        buffered += decoder.decode(value, { stream: true })
        for (;;) {
          if (resynced) return 'resynced'
          if (violated) return 'stale'
          const terminator = nextLineBreak(buffered)
          if (terminator === undefined) break
          const line = buffered.slice(0, terminator.index)
          buffered = buffered.slice(terminator.index + terminator.length)
          if (line === '') {
            await dispatch()
            if (resynced) return 'resynced'
            if (violated) return 'stale'
            if (!this.isCurrent(generation, signal)) return 'ended'
            continue
          }
          if (line.startsWith(':')) continue
          sawField = true
          const colon = line.indexOf(':')
          const field = colon === -1 ? line : line.slice(0, colon)
          const raw = colon === -1 ? '' : line.slice(colon + 1)
          const value_ = raw.startsWith(' ') ? raw.slice(1) : raw
          if (field === 'event') event = value_
          else if (field === 'id') id = value_
          else if (field === 'data') data += (data.length === 0 ? '' : LF) + value_
        }
      }
      return 'ended'
    } finally {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }
}

/** Waits, waking early when the owning signal aborts. */
async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}
