/**
 * Mount smoke: prove that this package mounts into a real `dsh web` profile and
 * that its browser half is registered and served.
 *
 * Gate 4 of the adaptation plan asks for red/green logs and at least three green
 * runs before "passing" can be claimed, so this script is deliberately a single
 * self-contained run that prints one `SMOKE <verdict>` line and exits non-zero
 * on any failed step. Wrap it in a loop to collect the required runs; see
 * `docs/mount-smoke-log.md` for the archived transcripts.
 *
 * Steps, all against a freshly spawned server:
 *   1. boot   — `dsh --profile web --no-open --port <port>` and wait for its
 *               tokenized URL line. A boot-time failure (an unmountable row, a
 *               declared-but-missing subpath, a duplicate client source) shows up
 *               here as a non-zero exit or a timeout.
 *   2. page   — fetch `/` with the token. The server answers 303 to set its auth
 *               cookie, so the script follows that redirect by hand and keeps the
 *               cookie: Node's `fetch` has no cookie jar.
 *   3. roster — assert the boot graph carries a client-module record for
 *               `dsh-ai-coding`, with the URL the loader will request.
 *   4. bundle — fetch that URL and assert the browser half is this package's
 *               closure-factory artifact (first line `window.__ModuleLoader__.load(`,
 *               non-trivial size).
 *
 * Usage: `node build/mount-smoke.mjs [port]`
 *
 * @module dsh-ai-coding/build/mount-smoke
 */

import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const PACKAGE_ID = 'dsh-ai-coding'
const BANNER = 'window.__ModuleLoader__.load('
const BOOT_TIMEOUT_MS = 90_000
const HTTP_TIMEOUT_MS = 30_000
/** A real browser half is hundreds of kilobytes; this only rejects an error page. */
const MIN_BUNDLE_BYTES = 100_000

const port = Number(process.argv[2] ?? 7799)
const base = `http://127.0.0.1:${port}`

/** One checked step; every failure is reported with the same shape. */
const steps = []
const check = (name, ok, detail) => {
  steps.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  return ok
}

/** Fetch with a hard deadline so a hung server cannot stall the smoke. */
async function fetchWithDeadline(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })
}

const server = spawn('dsh', ['--profile', 'web', '--no-open', '--port', String(port)], {
  shell: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})

let serverOutput = ''
server.stdout.on('data', (chunk) => { serverOutput += chunk; process.stdout.write(chunk) })
server.stderr.on('data', (chunk) => { serverOutput += chunk; process.stderr.write(chunk) })
let serverExit
server.on('exit', (code) => { serverExit = code })

try {
  // 1. Wait for the tokenized URL. The server prints exactly one.
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  let token
  while (Date.now() < deadline) {
    const match = /token=([A-Za-z0-9_-]+)/.exec(serverOutput)
    if (match !== null) { token = match[1]; break }
    if (serverExit !== undefined) break
    await delay(250)
  }
  if (!check('boot: server prints its tokenized URL', token !== undefined,
    token === undefined ? `no token after ${BOOT_TIMEOUT_MS / 1000}s (server exit ${serverExit ?? 'still running'})` : `port ${port}`)) {
    throw new Error('boot failed')
  }

  // 2. Fetch the shell. 303 → cookie → the page itself.
  const first = await fetchWithDeadline(`${base}/?token=${token}`, { redirect: 'manual' })
  const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0]
  const location = first.headers.get('location')
  let html
  if (first.status === 200) {
    html = await first.text()
  } else {
    if (!check('page: server redirects to set its auth cookie', location !== null && cookie !== '',
      `status ${first.status}, location ${location ?? 'none'}`)) throw new Error('no auth redirect')
    html = await (await fetchWithDeadline(new URL(location, base), { headers: { cookie } })).text()
  }
  check('page: shell renders with the auth cookie', html.length > 1000, `${html.length} bytes`)

  // 3. The browser roster record for this package.
  const record = new RegExp(`\\{"id":"${PACKAGE_ID}","url":"([^"]+)"`).exec(html)
  if (!check('roster: boot graph registers this package as a client module', record !== null,
    record === null ? `no record for ${PACKAGE_ID} in the boot graph` : record[1])) {
    throw new Error('roster missing')
  }

  // 4. The bundle the loader will request.
  const bundleUrl = new URL(record[1], base)
  const bundle = await fetchWithDeadline(bundleUrl, { headers: { cookie } })
  const source = bundle.status === 200 ? await bundle.text() : ''
  check('bundle: served', bundle.status === 200, `HTTP ${bundle.status}, ${source.length} bytes`)
  check('bundle: is this package\'s closure-factory artifact',
    source.startsWith(BANNER) && source.length > MIN_BUNDLE_BYTES,
    `first line ${JSON.stringify(source.split('\n')[0] ?? '')}`)
  check('bundle: carries the package id', source.includes(`id: "${PACKAGE_ID}"`))
} catch (error) {
  console.log(`smoke aborted: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  server.kill()
  // Windows needs the process tree gone; the shell wrapper holds the child.
  await delay(500)
  if (serverExit === undefined) server.kill('SIGKILL')
}

const failed = steps.filter(step => !step.ok)
console.log(`SMOKE ${failed.length === 0 && steps.length >= 5 ? 'GREEN' : 'RED'} (${steps.length - failed.length}/${steps.length} steps)`)
process.exit(failed.length === 0 && steps.length >= 5 ? 0 : 1)
