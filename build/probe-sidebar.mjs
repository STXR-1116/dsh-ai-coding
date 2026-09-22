/**
 * Diagnostic: what does a *plain* `dsh web` actually put in the sidebar?
 *
 * Boots the web profile the way an operator does — no fixture, no environment
 * overrides — opens the page in headless Chromium and reports every sidebar
 * footer action, every console message and whether this plugin's entry and the
 * deployment declaration are present. Written to answer one report: the
 * workbench entry missing while a `cordis plugin` entry is shown.
 *
 * Usage: `node build/probe-sidebar.mjs [port]`
 *
 * @module dsh-ai-coding/build/probe-sidebar
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

const port = Number(process.argv[2] ?? 8050)
/** Extra `dsh` arguments after the port, so the probe reproduces the operator's exact invocation (e.g. a `--patch` overlay). */
const extraArgs = process.argv.slice(3)
const base = `http://127.0.0.1:${port}`

const server = spawn('dsh', ['--profile', 'web', '--no-open', '--port', String(port), ...extraArgs], { shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
let output = ''
server.stdout.on('data', chunk => { output += chunk })
server.stderr.on('data', chunk => { output += chunk })

/** Kill the shell wrapper's whole tree, or the node server outlives the probe. */
function killTree() {
  if (server.pid === undefined) return
  spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' })
}

try {
  const deadline = Date.now() + 90_000
  let token
  while (Date.now() < deadline) {
    const match = /token=([A-Za-z0-9_-]+)/.exec(output)
    if (match !== null) { token = match[1]; break }
    await delay(250)
  }
  if (token === undefined) throw new Error(`server never printed a URL; tail=${output.slice(-400)}`)

  // The index is served behind the browser-session exchange: 303 sets the cookie.
  const first = await fetch(`${base}/?token=${token}`, { redirect: 'manual' })
  const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0]
  const location = first.headers.get('location') ?? '/'
  const html = await (await fetch(new URL(location, base), { headers: { cookie } })).text()

  console.log('--- index ---')
  console.log('  bytes:', html.length)
  console.log('  module record for this plugin:', html.includes('"id":"dsh-ai-coding"'))
  console.log('  deployment declaration present:', html.includes('__DSH_AI_CODING_PLATFORM_DEPLOYMENT__'))
  for (const needle of ['dsh-client-ui-cordis', 'dsh-host-plugin-inventory', 'cordis-panel']) {
    console.log(`  index mentions ${needle}:`, html.includes(needle))
  }

  const { default: puppeteer } = await import('puppeteer-core')
  const executablePath = [
    process.env.DSH_SMOKE_BROWSER,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean).find(candidate => existsSync(candidate))
  if (executablePath === undefined) throw new Error('no Chromium installation found')

  const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const page = await browser.newPage()
  const consoleLines = []
  page.on('console', message => consoleLines.push(`[${message.type()}] ${message.text()}`))
  page.on('pageerror', error => consoleLines.push(`[pageerror] ${error.message}`))
  // The served URL carries the token; without it the fence answers 401.
  await page.goto(`${base}/?token=${token}`, { waitUntil: 'networkidle2' })
  await delay(5_000)

  console.log('--- page ---')
  const reported = await page.evaluate(() => ({
    footerActions: [...document.querySelectorAll('button[aria-label]')]
      .map(button => button.getAttribute('aria-label'))
      .filter(label => label !== null),
    declaration: Object.keys(globalThis).filter(key => key.includes('AI_CODING')),
    bodyHead: (document.body?.innerText ?? '').replace(/\s+/gu, ' ').slice(0, 240),
  }))
  console.log('  footer-ish aria-labels:', JSON.stringify(reported.footerActions.slice(0, 25)))
  console.log('  injected globals:', JSON.stringify(reported.declaration))
  console.log('  body head:', reported.bodyHead)

  console.log('--- console (' + consoleLines.length + ' lines) ---')
  for (const line of consoleLines.slice(-25)) console.log('  ' + line.slice(0, 220))
  writeFileSync('probe-sidebar.log', consoleLines.join('\n') + '\n')
  await browser.close()
} catch (error) {
  console.log('probe failed:', error instanceof Error ? error.message : String(error))
} finally {
  killTree()
  await delay(500)
}
