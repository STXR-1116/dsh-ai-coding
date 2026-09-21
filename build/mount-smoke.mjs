/**
 * Mount smoke: prove that this package mounts into a real `dsh web` profile,
 * that its browser half is registered and served, and — against a real
 * Chromium — that the browser fragment activates, self-provides its two
 * remote namespace services, and renders the fixture workbench.
 *
 * Gate 4 of the adaptation plan asks for red/green logs and at least three green
 * runs before "passing" can be claimed, so this script is deliberately a single
 * self-contained run that prints one `SMOKE <verdict>` line and exits non-zero
 * on any failed step. Wrap it in a loop to collect the required runs; see
 * `docs/mount-smoke-log.md` for the archived transcripts.
 *
 * Steps, all against freshly spawned servers:
 *   1. fixture — spawn the team-skill fixture service on an ephemeral port.
 *   2. boot    — `dsh --profile web --no-open --port <port>` with the full
 *                `DSH_*` deployment environment and wait for its tokenized URL
 *                line. A boot-time failure (an unmountable row, a declared-but-
 *                missing subpath, a duplicate client source) shows up here.
 *   3. page    — fetch `/` with the token. The server answers 303 to set its
 *                auth cookie; the script follows that redirect by hand and
 *                keeps the cookie (Node's `fetch` has no cookie jar).
 *   4. roster  — assert the boot graph carries a client-module record for
 *                `dsh-ai-coding`, with the URL the loader will request.
 *   5. bundle  — fetch that URL and assert the browser half is this package's
 *                closure-factory artifact (first line `window.__ModuleLoader__.load(`,
 *                non-trivial size).
 *   6. shell   — real Chromium opens the page: the shell mounts and this
 *                package's sidebar entry appears, with no pending/failure
 *                banner anywhere on the page (P0-1 acceptance).
 *   7. panel   — the unconfigured workbench opens its settings face; saving
 *                the deployment values there reaches the sign-in form, and
 *                after signing in the workbench renders the fixture seed
 *                workspace `ws-alpha-1` (cloud workspaces view) and knowledge
 *                base `k-1` (knowledge view) — the browser remote services
 *                answering real reads (P0-1 acceptance).
 *   8. fail-loud — a second `dsh web` run with a fresh, unconfigured browser:
 *                the workbench must open straight onto the settings face that
 *                names the missing value (`apiBaseUrl`, 必填) instead of a
 *                silent not-ready blur (P0-2).
 *
 * Environment:
 *   `DSH_SMOKE_BROWSER` — Chromium executable to drive (default: the first of
 *   Chrome/Edge found at the standard Windows install paths).
 *   `DSH_SMOKE_USER` / `DSH_SMOKE_PASS` — fixture credentials for the panel
 *   login (defaults: admin@example.com / admin-pass, the fixture seed).
 *
 * Usage: `node build/mount-smoke.mjs [port]`
 *
 * @module dsh-ai-coding/build/mount-smoke
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

const PACKAGE_ID = 'dsh-ai-coding'
const BANNER = 'window.__ModuleLoader__.load('
const BOOT_TIMEOUT_MS = 90_000
const HTTP_TIMEOUT_MS = 30_000
const BROWSER_TIMEOUT_MS = 120_000
/** A real browser half is hundreds of kilobytes; this only rejects an error page. */
const MIN_BUNDLE_BYTES = 100_000

const port = Number(process.argv[2] ?? 7799)
const base = `http://127.0.0.1:${port}`
const fixturePort = await freePort()
const fixtureBase = `http://127.0.0.1:${fixturePort}`

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

/** Ask the OS for one free TCP port, then release it for the server to bind. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port: found } = probe.address()
      probe.close(() => resolve(found))
    })
    probe.on('error', reject)
  })
}

/** Spawn a process tree whose teardown always kills the whole tree. */
function spawnTree(command, args, options = {}) {
  const child = spawn(command, args, { shell: true, stdio: ['ignore', 'pipe', 'pipe'], ...options })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  const kill = () => {
    if (child.pid === undefined || child.exitCode !== null) return
    if (process.platform === 'win32') {
      // `/T` takes the child node process the shell shim created.
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
    }
  }
  return { child, output: () => output, kill }
}

/** Wait until `predicate` sees the accumulated output or the deadline passes. */
async function waitFor(serverProcess, predicate, deadline, step) {
  while (Date.now() < deadline) {
    const found = predicate(serverProcess.output())
    if (found !== undefined && found !== false) return found
    if (serverProcess.child.exitCode !== null || serverProcess.child.signalCode !== null) break
    await delay(250)
  }
  check(step, false, 'timed out waiting for the expected output')
  return undefined
}

// The deployment environment the green run mounts with. Both faces point at
// the fixture service; the platform token authorizes nothing outside it.
const deploymentEnv = {
  ...process.env,
  TEAM_SKILL_SERVICE_PORT: String(fixturePort),
  DSH_AI_CODING_PLATFORM_API_URL: `${fixtureBase}/v1`,
  DSH_AI_CODING_PLATFORM_ACCESS_TOKEN: 'demo-token',
  DSH_CLOUD_WORKSPACE_API_URL: `${fixtureBase}/v1`,
  DSH_CLOUD_WORKSPACE_ACCESS_TOKEN: 'demo-token',
  DSH_CLOUD_WORKSPACE_AUTH_MODE: 'static-token',
}

// 0. The fixture service the browser reads its seeds from.
const fixture = spawnTree('node', ['--import', 'tsx', 'dev/team-skill-service/src/server.ts'], {
  cwd: process.cwd(),
  env: deploymentEnv,
})
fixture.child.stdout.on('data', (chunk) => process.stdout.write(chunk))
fixture.child.stderr.on('data', (chunk) => process.stderr.write(chunk))
const fixtureUp = await waitFor(
  fixture,
  out => (/Team Skill service listening/.test(out) ? true : undefined),
  Date.now() + 30_000,
  'fixture: service started',
)

// 1-7. The green run: full deployment environment.
const server = spawnTree('dsh', ['--profile', 'web', '--no-open', '--port', String(port)], { env: deploymentEnv })
server.child.stdout.on('data', (chunk) => process.stdout.write(chunk))
server.child.stderr.on('data', (chunk) => process.stderr.write(chunk))
let serverExit
server.child.on('exit', (code) => { serverExit = code })

/** Kill the spawned servers and everything they started; safe to call twice. */
function killServerTree(target) {
  target.kill()
}

try {
  if (!check('fixture: service started', fixtureUp === true, `port ${fixturePort}`)) {
    throw new Error('fixture failed')
  }

  // 1. Wait for the tokenized URL. The server prints exactly one.
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  const token = await waitFor(server, (out) => /token=([A-Za-z0-9_-]+)/.exec(out)?.[1], deadline, 'boot: server prints its tokenized URL')
  if (token === undefined || !check('boot: server prints its tokenized URL', true, `port ${port}`)) {
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

  // 5-7. The real-browser phase.
  await browserPhase(token)

  // 8. Fail-loud: the same boot WITHOUT the deployment environment must name
  // its failure instead of waiting silently.
  await failLoudPhase()
} catch (error) {
  console.log(`smoke aborted: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  killServerTree(server)
  killServerTree(fixture)
  await delay(500)
  killServerTree(server)
  killServerTree(fixture)
}

/** Launch the packaged Chromium (or Edge) headless. */
async function launchBrowser() {
  const { default: puppeteer } = await import('puppeteer-core')
  const candidates = [
    process.env.DSH_SMOKE_BROWSER,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean)
  const executablePath = candidates.find(candidate => existsSync(candidate))
  if (executablePath === undefined) throw new Error('no Chromium/Edge installation found (set DSH_SMOKE_BROWSER)')
  return puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
}

/** The real-browser acceptance: shell mounts, settings face, seeds render. */
async function browserPhase(token) {
  let browser
  try {
    browser = await launchBrowser()
    const page = await browser.newPage()
    const consoleLines = []
    page.on('console', (message) => { consoleLines.push(message.text()) })
    page.on('pageerror', (error) => { consoleLines.push(`pageerror: ${error.message}`) })

    await page.goto(`${base}/?token=${token}`, { waitUntil: 'domcontentloaded', timeout: HTTP_TIMEOUT_MS })
    const entrySelector = '[aria-label="打开编程协作台"], [aria-label="Open coding workspace"]'
    const mounted = await page.waitForSelector(entrySelector, { timeout: BROWSER_TIMEOUT_MS }).then(() => true).catch(() => false)
    if (!check('browser: shell mounts and the sidebar entry appears', mounted,
      mounted ? 'sidebar entry selector found' : summarizeConsole(consoleLines))) {
      throw new Error('browser shell did not mount')
    }

    const bodyText = await page.evaluate(() => document.body.innerText)
    check('browser: no pending banner and no boot failure banner',
      !bodyText.includes('pending') && !bodyText.includes('web boot') && !bodyText.includes('waiting for services'),
      'page carries no pending / waiting-for-services / web boot text')

    // Open the panel; a fresh browser profile is unconfigured, so the workbench
    // must open straight onto its settings face (loud, named, actionable).
    await page.click(entrySelector)
    const settingsInput = await page.waitForSelector('input[name="dsh-ai-coding-api-base-url"]', { timeout: BROWSER_TIMEOUT_MS }).catch(() => false)
    if (!check('browser: unconfigured workbench opens the settings face', settingsInput !== false,
      settingsInput === false ? summarizeConsole(consoleLines) : 'settings form visible')) {
      throw new Error('settings face did not appear')
    }
    await page.type('input[name="dsh-ai-coding-api-base-url"]', `${fixtureBase}/v1`)
    await page.type('input[name="dsh-ai-coding-workspace-api-base-url"]', `${fixtureBase}/v1`)
    await page.type('input[name="dsh-ai-coding-access-token"]', 'demo-token')
    await page.evaluate(() => {
      const select = document.querySelector('select[name="dsh-ai-coding-workspace-auth-mode"]')
      const setter = Object.getOwnPropertyDescriptor(globalThis.HTMLSelectElement.prototype, 'value')?.set
      setter?.call(select, 'static-token')
      select?.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await page.type('input[name="dsh-ai-coding-workspace-access-token"]', 'demo-token')
    await page.evaluate(() => {
      const submit = [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === '保存并继续')
      submit?.click()
    })

    // The account gate turns `ready`: sign in and reach the project picker.
    const loginInput = await page.waitForSelector('input[autocomplete="username"]', { timeout: BROWSER_TIMEOUT_MS }).catch(() => false)
    if (!check('browser: saving settings reaches the account sign-in', loginInput !== false,
      loginInput === false ? summarizeConsole(consoleLines) : 'login form visible')) {
      throw new Error('login form did not appear')
    }
    const username = process.env.DSH_SMOKE_USER ?? 'admin@example.com'
    const password = process.env.DSH_SMOKE_PASS ?? 'admin-pass'
    await page.type('input[autocomplete="username"]', username)
    await page.type('input[autocomplete="current-password"]', password)
    await page.evaluate(() => {
      const submit = [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === '登录')
      submit?.click()
    })

    const projectSelect = await page.waitForSelector('select[aria-label="当前项目"]', { timeout: BROWSER_TIMEOUT_MS }).catch(() => false)
    if (!check('browser: account gate turns ready after panel sign-in', projectSelect !== false,
      projectSelect === false ? summarizeConsole(consoleLines) : 'project picker visible')) {
      throw new Error('login did not reach ready')
    }
    await page.evaluate(() => {
      const select = document.querySelector('select[aria-label="当前项目"]')
      const option = select?.querySelector('option[value]:not([value=""])')
      if (select !== null && option !== null && option !== undefined) {
        const setter = Object.getOwnPropertyDescriptor(globalThis.HTMLSelectElement.prototype, 'value')?.set
        setter?.call(select, option.value)
        select.dispatchEvent(new Event('change', { bubbles: true }))
      }
    })
    // Selecting a project reloads the detail surfaces; give them a beat.
    await delay(1_500)

    // Cloud workspaces view renders the fixture seed workspace.
    await clickNav(page, '云工作空间')
    const workspaceRendered = await page.waitForFunction(
      () => document.body.innerText.includes('ws-alpha-1'),
      { timeout: BROWSER_TIMEOUT_MS },
    ).then(() => true).catch(() => false)
    check('browser: workbench renders fixture seed workspace ws-alpha-1', workspaceRendered,
      workspaceRendered ? 'ws-alpha-1 visible in the cloud workspaces view' : summarizeConsole(consoleLines))

    // Knowledge view renders the fixture seed knowledge base.
    await clickNav(page, '知识库')
    const knowledgeRendered = await page.waitForFunction(
      () => document.body.innerText.includes('k-1'),
      { timeout: BROWSER_TIMEOUT_MS },
    ).then(() => true).catch(() => false)
    check('browser: knowledge view renders fixture seed k-1', knowledgeRendered,
      knowledgeRendered ? 'k-1 visible in the knowledge view' : summarizeConsole(consoleLines))
  } finally {
    await browser?.close()
  }
}

/**
 * The P0-2 acceptance: a browser with no deployment settings must land on the
 * loud, named settings face — never a silent not-ready blur and never a
 * half-working workbench. The plugin still loads (the settings face IS the
 * configuration channel on this baseline), so the sidebar entry appears and
 * the settings form names the missing value.
 */
async function failLoudPhase() {
  const barePort = await freePort()
  const bareBase = `http://127.0.0.1:${barePort}`
  const bare = spawnTree('dsh', ['--profile', 'web', '--no-open', '--port', String(barePort)], {
    env: { ...process.env, TEAM_SKILL_SERVICE_PORT: String(fixturePort) },
  })
  let browser
  try {
    const deadline = Date.now() + BOOT_TIMEOUT_MS
    const token = await waitFor(bare, (out) => /token=([A-Za-z0-9_-]+)/.exec(out)?.[1], deadline, 'fail-loud: bare server prints its tokenized URL')
    if (token === undefined || !check('fail-loud: bare server prints its tokenized URL', true, `port ${barePort}`)) {
      throw new Error('fail-loud boot failed')
    }

    browser = await launchBrowser()
    const page = await browser.newPage()
    const consoleLines = []
    page.on('console', (message) => { consoleLines.push(message.text()) })
    page.on('pageerror', (error) => { consoleLines.push(`pageerror: ${error.message}`) })
    await page.goto(`${bareBase}/?token=${token}`, { waitUntil: 'domcontentloaded', timeout: HTTP_TIMEOUT_MS })

    const entrySelector = '[aria-label="打开编程协作台"], [aria-label="Open coding workspace"]'
    const mounted = await page.waitForSelector(entrySelector, { timeout: BROWSER_TIMEOUT_MS }).then(() => true).catch(() => false)
    check('fail-loud: the plugin still loads (settings face is the config channel)', mounted,
      mounted ? 'sidebar entry present' : summarizeConsole(consoleLines))

    await page.click(entrySelector)
    const settingsShown = await page.waitForSelector('input[name="dsh-ai-coding-api-base-url"]', { timeout: BROWSER_TIMEOUT_MS }).then(() => true).catch(() => false)
    const bodyText = await page.evaluate(() => document.body.innerText)
    const namesTheMissingValue = bodyText.includes('配置编程协作台的服务地址') && bodyText.includes('必填')
    check('fail-loud: unconfigured workbench names the missing settings loudly',
      settingsShown && namesTheMissingValue,
      `settings form: ${String(settingsShown)}, heading names the required value: ${String(namesTheMissingValue)}`)
  } finally {
    await browser?.close()
    bare.kill()
    await delay(500)
    bare.kill()
  }
}

/** Click one workbench nav item by its visible label (rail buttons carry icon + hint text). */
async function clickNav(page, label) {
  await page.evaluate((text) => {
    const candidates = [...document.querySelectorAll('button, a, [role="tab"]')]
      .filter(candidate => (candidate.textContent ?? '').includes(text))
    candidates.sort((left, right) => (left.textContent?.length ?? 0) - (right.textContent?.length ?? 0))
    candidates[0]?.click()
  }, label)
  await delay(800)
}

/** A bounded console tail so failure details land in the smoke log. */
function summarizeConsole(consoleLines) {
  const tail = consoleLines.slice(-6).map(line => line.slice(0, 200))
  return tail.length > 0 ? `console tail: ${tail.join(' | ')}` : 'console empty'
}

const failed = steps.filter(step => !step.ok)
console.log(`SMOKE ${failed.length === 0 && steps.length >= 12 ? 'GREEN' : 'RED'} (${steps.length - failed.length}/${steps.length} steps)`)
process.exit(failed.length === 0 && steps.length >= 12 ? 0 : 1)
