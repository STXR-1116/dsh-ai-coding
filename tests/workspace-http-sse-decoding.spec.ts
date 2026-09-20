/* workspace-http 的 SSE 解码与 HTTP 客户端残余分支（覆盖专项：workspace-http 批）。
 *
 * 解码器按 event-stream 语法分帧（LF / CRLF / 裸 CR、跨块的行终止符与多字节字符、
 * 注释行、无空行结尾的末帧），控制事件变成显式标记，非法载荷变成协议违规而不是
 * 被丢掉；客户端侧覆盖 signal 透传、非 JSON 响应体与无响应体的流。
 *
 * 分类：FIXTURE-ONLY（构造的字节流，不发真实请求）。
 */
import { describe, expect, it } from 'vitest'
import { decodeSse, parseStreamEventData, WorkspaceHttpClient } from '../src/workspace-http.ts'
import type { SseFrame, SseProtocolViolation } from '../src/workspace-http.ts'

/** One byte-stream chunk: text, byte list, or raw bytes. */
type Chunk = string | readonly number[] | Uint8Array

/** Builds a byte stream from explicit chunks so splits can be placed on purpose. */
function byteStream(chunks: readonly Chunk[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        if (typeof chunk === 'string') controller.enqueue(encoder.encode(chunk))
        else if (chunk instanceof Uint8Array) controller.enqueue(chunk)
        else controller.enqueue(Uint8Array.from(chunk))
      }
      controller.close()
    },
  })
}

async function framesOf(chunks: readonly Chunk[]): Promise<readonly (SseFrame | 'resync_required' | 'replay_done' | SseProtocolViolation)[]> {
  const frames: (SseFrame | 'resync_required' | 'replay_done' | SseProtocolViolation)[] = []
  for await (const frame of decodeSse(byteStream(chunks))) frames.push(frame)
  return frames
}

const EVENT_DATA = JSON.stringify({
  event_id: 'evt-1',
  resource_type: 'workspace',
  resource_id: 'ws-1',
  revision: 1,
  event_type: 'workspace.updated',
  occurred_at: '2026-09-01T00:00:00.000Z',
  payload: {},
})

describe('decodeSse 分帧', () => {
  it('accepts LF, CRLF and a bare CR as the same terminator', async () => {
    const lf = await framesOf([`event: workspace.updated\nid: evt-1\ndata: ${EVENT_DATA}\n\n`])
    const crlf = await framesOf([`event: workspace.updated\r\nid: evt-1\r\ndata: ${EVENT_DATA}\r\n\r\n`])
    const cr = await framesOf([`event: workspace.updated\rid: evt-1\rdata: ${EVENT_DATA}\r\r`])

    for (const frames of [lf, crlf, cr]) {
      expect(frames).toHaveLength(1)
      expect(frames[0]).toMatchObject({ event: 'workspace.updated', id: 'evt-1' })
    }
  })

  it('holds a terminator and a multi-byte character that a chunk boundary splits', async () => {
    const danglingCr = await framesOf([`event: workspace.updated\nid: evt-1\ndata: ${EVENT_DATA}\r`, '\n\n'])
    expect(danglingCr).toHaveLength(1)

    // '云' 是 E4 BA 91：三个字节分两次到达，不能解码成替换字符。
    const bytes = new TextEncoder().encode(`event: workspace.updated\nid: evt-1\ndata: ${EVENT_DATA}\n\n`)
    const splitAt = bytes.indexOf(0xe4) + 1
    const split = await framesOf([bytes.slice(0, splitAt), bytes.slice(splitAt)])
    expect(split).toHaveLength(1)
  })

  it('skips comments and empty frames, and turns the control events into markers', async () => {
    const frames = await framesOf([
      ': ping\n\n',
      '\n',
      'event: resync_required\nid: evt-resync\ndata: {"code":"RESYNC_REQUIRED"}\n\n',
      'event: stream.replay-done\nid: evt-done\ndata: {}\n\n',
    ])
    expect(frames).toEqual(['resync_required', 'replay_done'])
  })

  it('reports a non-JSON message frame as a protocol violation instead of dropping it', async () => {
    const frames = await framesOf(['id: evt-bad\ndata: {oops}\n\n'])
    expect(frames).toHaveLength(1)
    const violation = frames[0] as SseProtocolViolation
    expect(violation.protocolError).toContain('non-JSON')
  })

  it('dispatches a final frame the service ended without a blank line', async () => {
    const frames = await framesOf([`event: workspace.updated\nid: evt-1\ndata: ${EVENT_DATA}`])
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ id: 'evt-1' })

    // 末段以换行结束但没有空行：缓冲里剩下的那一行仍要按字段应用。
    const terminated = await framesOf([`event: workspace.updated\nid: evt-2\ndata: ${EVENT_DATA}\n`])
    expect(terminated).toHaveLength(1)
    expect(terminated[0]).toMatchObject({ id: 'evt-2' })
  })

  it('accepts a field with no value and a value with no leading space', async () => {
    // `data` 无冒号按空值处理；`id:evt-3` 没有前导空格仍是 evt-3；只有事件名的帧被丢弃。
    const frames = await framesOf(['event: workspace.updated\nid:evt-3\ndata\n\n', 'event: workspace.updated\n\n'])
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ event: 'workspace.updated', id: 'evt-3', data: '' })
  })

  it('ignores a field the event-stream vocabulary does not define', async () => {
    const frames = await framesOf([`event: workspace.updated\nid: evt-9\nretry: 5000\ndata: ${EVENT_DATA}\n\n`])
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ id: 'evt-9' })
  })

  it('joins a frame whose payload the service split across several data lines', async () => {
    const halves = [EVENT_DATA.slice(0, 20), EVENT_DATA.slice(20)]
    const frames = await framesOf([`event: workspace.updated\nid: evt-10\ndata: ${halves[0]}\ndata: ${halves[1]}\n\n`])
    expect(frames).toHaveLength(1)
    expect((frames[0] as SseFrame).data).toBe(`${halves[0]}\n${halves[1]}`)
  })
})

describe('parseStreamEventData', () => {
  it('rejects a payload that is not JSON and one that is not an event', () => {
    expect(() => parseStreamEventData({ event: 'workspace.updated', id: 'e', data: '{oops}' }))
      .toThrow(/non-JSON event payload/u)
    expect(() => parseStreamEventData({ event: 'workspace.updated', id: 'e', data: '{"unexpected":true}' }))
      .toThrow(/resource_type|event_id/u)
    expect(parseStreamEventData({ event: 'workspace.updated', id: 'e', data: EVENT_DATA })).toMatchObject({ eventId: 'evt-1' })
  })
})

describe('WorkspaceHttpClient 残余分支', () => {
  it('passes the abort signal through and rejects an unparsable response body', async () => {
    const seen: Array<RequestInit | undefined> = []
    const client = new WorkspaceHttpClient('http://service.test', (async (_input: unknown, init?: RequestInit) => {
      seen.push(init)
      return new Response(JSON.stringify({ code: 0, message: 'ok', request_id: 'r', data: { ok: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }))

    const controller = new AbortController()
    await client.request('/things', { signal: controller.signal }, 'token')
    expect(seen[0]?.signal).toBe(controller.signal)

    const unparsable = new WorkspaceHttpClient('http://service.test', (async () =>
      new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } })))
    await expect(unparsable.request('/things', {}, 'token')).rejects.toThrow(/invalid JSON/u)
  })

  it('rejects a stream response that carries no body', async () => {
    const bodyless = new WorkspaceHttpClient('http://service.test', (async () =>
      new Response(null, { status: 200, headers: { 'content-type': 'text/event-stream' } })))
    await expect(bodyless.openStream('', 'token', new AbortController().signal)).rejects.toThrow(/has no body/u)
  })
})
