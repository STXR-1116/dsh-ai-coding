/**
 * Start the local AI Coding platform fixture — idempotently.
 *
 * ## Why this exists
 *
 * Acceptance kept stalling on `Failed to fetch（当前服务地址：http://127.0.0.1:4100/v1）`,
 * four times in one session. The cause is always the same and never the plugin: the
 * dev fixture (`dev/team-skill-service`) is not running, and **nothing starts it** —
 * DSH does not manage it. Starting it by hand worked, but a detached process did not
 * reliably survive, so "start it again" became a recurring manual step.
 *
 * This script makes that step safe to repeat: if the port already answers it says so
 * and exits 0; otherwise it starts the fixture detached, waits until it answers, and
 * reports where its log went. Running it twice is harmless.
 *
 * It is deliberately **not** a plugin concern: the plugin only talks to the platform,
 * it never spawns it (see README › 验收与排查).
 *
 * Usage: `pnpm fixture [port]` (default 4100, the fixture's own default).
 */

import { spawn } from 'node:child_process'
import { openSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const port = Number(process.argv[2] ?? process.env.TEAM_SKILL_SERVICE_PORT ?? 4100)
const logPath = join(tmpdir(), `dsh-fixture-${port}.log`)

/**
 * Ask the port whether anything answers.
 * Any HTTP status counts as up — a 404 or 405 still proves a server owns the port.
 * @returns whether the fixture is already serving.
 */
function probe() {
  return new Promise(resolve => {
    const req = request({ host: '127.0.0.1', port, path: '/v1/auth/login', method: 'GET', timeout: 1_500 }, res => {
      res.resume()
      resolve(true)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.end()
  })
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

if (await probe()) {
  console.log(`夹具已在运行：http://127.0.0.1:${port}（无需重复启动）`)
  process.exit(0)
}

// `detached: true` + `unref()` so the fixture outlives this script; stdio goes to a log
// file rather than a pipe, because an open pipe is what keeps a parent alive on Windows.
const log = openSync(logPath, 'a')
const child = spawn(process.execPath, ['--import', 'tsx', 'dev/team-skill-service/src/server.ts'], {
  cwd: repoRoot,
  detached: true,
  stdio: ['ignore', log, log],
  windowsHide: true,
  env: { ...process.env, TEAM_SKILL_SERVICE_PORT: String(port) },
})
child.unref()

const deadline = Date.now() + 30_000
while (Date.now() < deadline) {
  await sleep(500)
  if (await probe()) {
    console.log(`夹具已启动：http://127.0.0.1:${port}（pid ${child.pid}）`)
    console.log(`日志：${logPath}`)
    process.exit(0)
  }
}

console.error(`夹具在 30 秒内没有就绪。日志：${logPath}`)
process.exit(1)
