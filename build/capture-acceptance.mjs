/**
 * Owner acceptance capture: boot the fixture and a real `dsh web`, walk the
 * panel on real Chromium (configure settings face → sign in → open the
 * workbench), and save screenshots of the acceptance surfaces.
 *
 * Outputs, under `docs/mount-acceptance/`:
 *   1-settings-face.png    — the unconfigured workbench's settings form.
 *   2-workbench-ws.png     — cloud workspaces view rendering `ws-alpha-1`.
 *   3-knowledge-k1.png     — knowledge view rendering `k-1`.
 *
 * Usage: `node build/capture-acceptance.mjs [port]`
 *
 * @module dsh-ai-coding/build/capture-acceptance
 */

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

const PACKAGE_DIR = new URL('..', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '')
const OUT_DIR = `${PACKAGE_DIR}docs/mount-acceptance`.replace(/\//g, '\\')

const port = Number(process.argv[2] ?? 7799)
const base = `http://127.0.0.1:${port}`

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

function spawnTree(command, args, options = {}) {
  const child = spawn(command, args, { shell: true, stdio: ['ignore', 'pipe', 'pipe'], ...options })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  const kill = () => {
    if (child.pid === undefined || child.exitCode !== null) return
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
    }
  }
  return { child, output: () => output, kill }
}

const fixturePort = await freePort()
const fixtureBase = `http://127.0.0.1:${fixturePort}`
const env = {
  ...process.env,
  TEAM_SKILL_SERVICE_PORT: String(fixturePort),
  DSH_AI_CODING_PLATFORM_API_URL: `${fixtureBase}/v1`,
  DSH_AI_CODING_PLATFORM_ACCESS_TOKEN: 'demo-token',
  DSH_CLOUD_WORKSPACE_API_URL: `${fixtureBase}/v1`,
  DSH_CLOUD_WORKSPACE_ACCESS_TOKEN: 'demo-token',
  DSH_CLOUD_WORKSPACE_AUTH_MODE: 'static-token',
}

const fixture = spawnTree('node', ['--import', 'tsx', 'dev/team-skill-service/src/server.ts'], { env, cwd: PACKAGE_DIR })
const server = spawnTree('dsh', ['--profile', 'web', '--no-open', '--port', String(port)], { env, cwd: PACKAGE_DIR })

let browser
try {
  const deadline = Date.now() + 120_000
  let token
  while (Date.now() < deadline) {
    token = /token=([A-Za-z0-9_-]+)/.exec(server.output())?.[1]
    if (token !== undefined) break
    if (server.child.exitCode !== null) throw new Error(`dsh web exited with ${server.child.exitCode}`)
    await delay(250)
  }
  if (token === undefined) throw new Error('no tokenized URL within the deadline')

  const { default: puppeteer } = await import('puppeteer-core')
  const candidates = [
    process.env.DSH_SMOKE_BROWSER,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean)
  const executablePath = candidates.find(candidate => existsSync(candidate))
  browser = await puppeteer.launch({ executablePath, headless: false, defaultViewport: { width: 1600, height: 950 }, args: ['--no-sandbox'] })
  const page = await browser.newPage()
  await page.goto(`${base}/?token=${token}`, { waitUntil: 'domcontentloaded', timeout: 30_000 })

  await page.waitForSelector('[aria-label="打开编程协作台"]', { timeout: 120_000 })
  await page.click('[aria-label="打开编程协作台"]')
  await page.waitForSelector('input[name="dsh-ai-coding-api-base-url"]', { timeout: 120_000 })
  mkdirSync(`${PACKAGE_DIR}docs/mount-acceptance`, { recursive: true })
  await page.screenshot({ path: `${PACKAGE_DIR}docs/mount-acceptance/1-settings-face.png` })

  await page.type('input[name="dsh-ai-coding-api-base-url"]', `${fixtureBase}/v1`)
  await page.type('input[name="dsh-ai-coding-workspace-api-base-url"]', `${fixtureBase}/v1`)
  await page.evaluate(() => {
    const select = document.querySelector('select[name="dsh-ai-coding-workspace-auth-mode"]')
    const setter = Object.getOwnPropertyDescriptor(globalThis.HTMLSelectElement.prototype, 'value')?.set
    setter?.call(select, 'static-token')
    select?.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await page.type('input[name="dsh-ai-coding-workspace-access-token"]', 'demo-token')
  await page.evaluate(() => {
    [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === '保存并继续')?.click()
  })

  await page.waitForSelector('input[autocomplete="username"]', { timeout: 120_000 })
  await page.type('input[autocomplete="username"]', process.env.DSH_SMOKE_USER ?? 'admin@example.com')
  await page.type('input[autocomplete="current-password"]', process.env.DSH_SMOKE_PASS ?? 'admin-pass')
  await page.evaluate(() => {
    [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === '登录')?.click()
  })

  await page.waitForSelector('select[aria-label="当前项目"]', { timeout: 120_000 })
  await page.evaluate(() => {
    const select = document.querySelector('select[aria-label="当前项目"]')
    const option = select?.querySelector('option[value]:not([value=""])')
    const setter = Object.getOwnPropertyDescriptor(globalThis.HTMLSelectElement.prototype, 'value')?.set
    setter?.call(select, option.value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await delay(1_500)

  await page.evaluate(() => {
    const candidates = [...document.querySelectorAll('button, a, [role="tab"]')]
      .filter(candidate => (candidate.textContent ?? '').includes('云工作空间'))
    candidates.sort((left, right) => (left.textContent?.length ?? 0) - (right.textContent?.length ?? 0))
    candidates[0]?.click()
  })
  await page.waitForFunction(() => document.body.innerText.includes('ws-alpha-1'), { timeout: 120_000 })
  await page.screenshot({ path: `${PACKAGE_DIR}docs/mount-acceptance/2-workbench-ws-alpha-1.png` })

  await page.evaluate(() => {
    const candidates = [...document.querySelectorAll('button, a, [role="tab"]')]
      .filter(candidate => (candidate.textContent ?? '').includes('知识库'))
    candidates.sort((left, right) => (left.textContent?.length ?? 0) - (right.textContent?.length ?? 0))
    candidates[0]?.click()
  })
  await page.waitForFunction(() => document.body.innerText.includes('k-1'), { timeout: 120_000 })
  await page.screenshot({ path: `${PACKAGE_DIR}docs/mount-acceptance/3-knowledge-k-1.png` })

  console.log('ACCEPTANCE CAPTURED: 3 screenshots under docs/mount-acceptance/')
} finally {
  await browser?.close()
  server.kill()
  fixture.kill()
  await delay(500)
  server.kill()
  fixture.kill()
}
