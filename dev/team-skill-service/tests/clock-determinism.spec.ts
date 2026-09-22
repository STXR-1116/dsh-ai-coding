/* 时钟接缝的负向对照：证明「计划中的转移」不再由墙钟抢跑。
 *
 * 官方测试政策把「时钟」列为三类应当 mock 的边界之一，并规定**「只有单独运行时才通过」的
 * spec 是它自己的缺陷**，不是 runner 不稳定（docs/testing）；官方 flake 归类把这类失败定为
 * load-sensitive synchronization，修法是「用 barrier 取代概率性等待」，且不得藏进更宽的
 * 超时或重试里（ci-flake-diagnosis）。
 *
 * 竞态原貌：新建工作空间会排一个 `transitionAt = now + 40`，到期后在**读取时惰性兑现**并把
 * `revision += 1`（`applyTransition`）。于是「读 revision → 做别的事 → 带 If-Match 写」的流程
 * 只要跨过那 40ms 就拿到**合法**的 409 —— 负载越高越容易，这正是那些集成用例偶发红的原因。
 *
 * 本文件刻意制造那个窗口：创建后**真实等待 120ms**（远超 40ms）再读。
 *  - 冻结时钟 → 截止时间随时钟静止、永不越过 → 仍是 provisioning，**确定性**通过；
 *  - 若回退成墙钟（把注入的 now 去掉）→ 那 120ms 足以推进状态 → 断言变红。这就是负向对照。
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { createTeamSkillService } from '../src/server.ts'
import { bodyOf } from './response.ts'

const services: Array<{ readonly server: Server }> = []

afterEach(async () => {
  for (const service of services.splice(0)) {
    service.server.closeAllConnections()
    await new Promise<void>((resolve) => { service.server.close(() => { resolve() }) })
  }
})

/** A clock that only moves when the test moves it. */
function frozenClock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start
  return { now: () => current, advance: (ms: number) => { current += ms } }
}

/** Boot one service on an ephemeral port and return its admin headers. */
async function boot(now: () => number): Promise<{ port: number; headers: Record<string, string> }> {
  const service = createTeamSkillService({ port: 0, now })
  services.push(service)
  await service.listen()
  const port = (service.server.address() as AddressInfo).port
  const login = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin@example.com', password: 'admin-pass' }),
  })
  const token = ((await bodyOf(login)) as { access_token: string }).access_token
  return { port, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }
}

/** Create one workspace and return its id. */
async function createWorkspace(port: number, headers: Record<string, string>, key: string): Promise<string> {
  const created = await fetch(`http://127.0.0.1:${port}/v1/projects/project-alpha/workspaces`, {
    method: 'POST',
    headers: { ...headers, 'idempotency-key': key },
    body: JSON.stringify({
      repository_id: 'repo-1',
      branch: 'feature/cloud',
      agent_profile_version_id: 'apv-1',
      display_name: '时序对照',
    }),
  })
  expect(created.status).toBe(202)
  const snapshot = (await bodyOf(created)) as { workspace_id: string; status: string }
  expect(snapshot.status).toBe('provisioning')
  return snapshot.workspace_id
}

/** Read one workspace's current status and revision (`bodyOf` unwraps `data`). */
async function read(port: number, id: string, headers: Record<string, string>): Promise<{ status: string; revision: number }> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/workspaces/${id}`, { headers })
  return (await bodyOf(response)) as { status: string; revision: number }
}

describe('计划中的生命周期转移不再与墙钟抢跑', () => {
  it('时钟冻结时，真实等待 400ms 也不会越过 200ms 的截止时间', async () => {
    const clock = frozenClock()
    const { port, headers } = await boot(clock.now)
    const id = await createWorkspace(port, headers, 'clock-frozen-create')
    const before = await read(port, id, headers)

    // Twice the fixture's own provisioning deadline (200 ms). Waiting less than
    // the deadline would pass even with the wall clock, so this number is what
    // makes the case discriminating rather than decorative.
    await delay(400)

    const after = await read(port, id, headers)
    expect(after.status).toBe('provisioning')
    // Nothing advanced, so nothing bumped the revision the client already holds.
    expect(after.revision).toBe(before.revision)
  }, 30_000)

  it('测试推进时钟后，转移照常发生（冻结不是把功能关掉）', async () => {
    const clock = frozenClock()
    const { port, headers } = await boot(clock.now)
    const id = await createWorkspace(port, headers, 'clock-advance-create')
    const before = await read(port, id, headers)

    // The barrier that replaces probabilistic waiting: the test decides when the
    // deadline passes instead of racing the wall clock to it.
    clock.advance(60_000)

    const after = await read(port, id, headers)
    expect(['starting', 'ready']).toContain(after.status)
    expect(after.revision).toBeGreaterThan(before.revision)
  }, 30_000)
})
