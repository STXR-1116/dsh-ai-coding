/**
 * 真机验证：Workspace 会话「建后归档」是否既从侧栏消失、又仍可被会话控制器解析。
 *
 * 为什么需要真机：机制结论来自类型与包文档（见 docs/cloud-workspace-redesign.md §10），
 * 而它涉及三件只有在运行中的客户端里才能确认的事：
 *   1. 插件能否真的拿到 `workspaces` 服务并调用 `archiveSession`；
 *   2. 归档后侧栏**所有分组**里确实没有该会话的行；
 *   3. 归档后 `sessions.binding(id)` 仍能解析（复用是否完好）。
 *
 * 用法: node build/spike-archive-session.mjs [port]
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import net from 'node:net'

const CHROME_CANDIDATES = [
  process.env.DSH_SPIKE_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean)

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Reserve a free port atomically (the smoke's fix for host-resource collisions). */
function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

async function boot(port) {
  const child = spawn('dsh', ['--profile', 'web', '--no-open', '--port', String(port)], {
    shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', d => { out += String(d) })
  child.stderr.on('data', d => { out += String(d) })
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const token = /token=([A-Za-z0-9_-]+)/u.exec(out)?.[1]
    if (token !== undefined) return { child, token }
    await sleep(500)
  }
  throw new Error(`dsh web 未在 120s 内就绪。输出尾部:\n${out.slice(-600)}`)
}

/**
 * Kill the whole tree: `shell: true` means `child.kill()` only reaps the shell, and an open
 * pipe keeps this process alive (the first run hung until its 600s cap).
 */
function killTree(child) {
  try {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  } catch { /* best effort */ }
}

/** Dismiss the first-run onboarding so the shell (and its session list) renders. */
async function passOnboarding(page) {
  for (const label of ['稍后配置', '跳过', 'Skip', 'Later']) {
    const clicked = await page.evaluate(text => {
      const button = [...document.querySelectorAll('button')].find(node => (node.textContent ?? '').includes(text))
      if (button === undefined) return false
      button.click()
      return true
    }, label)
    if (clicked) { console.log(`  onboarding: clicked 「${label}」`); await sleep(2_500); return true }
  }
  console.log('  onboarding: 未找到跳过按钮（可能本就没有引导页）')
  return false
}

const main = async () => {
  const port = Number(process.argv[2]) || await reservePort()
  const executablePath = CHROME_CANDIDATES.find(candidate => existsSync(candidate))
  if (executablePath === undefined) throw new Error('找不到 Chromium')
  const { default: puppeteer } = await import('puppeteer-core')

  console.log(`启动 dsh web（端口 ${port}）…`)
  const { child, token } = await boot(port)
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  try {
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${port}/?token=${token}`, { waitUntil: 'networkidle2', timeout: 60_000 })
    await page.waitForSelector('button', { timeout: 30_000 })
    await sleep(4_000)
    await passOnboarding(page)

    // ---- 阶段 1：探出客户端服务句柄 ----
    const discovery = await page.evaluate(async () => {
      const loader = globalThis.__ModuleLoader__
      const shape = (object, depth = 0) => {
        if (object === null || typeof object !== 'object' || depth > 1) return typeof object
        return Object.fromEntries(Object.keys(object).slice(0, 40).map(key => {
          const value = object[key]
          return [key, typeof value === 'function' ? 'fn' : shape(value, depth + 1)]
        }))
      }
      // The Cordis app's root context is what holds the services. Hunt for it: a context
      // exposes `get(name)` plus plugin/registry machinery.
      const looksLikeCtx = value => typeof value === 'object' && value !== null
        && typeof value.get === 'function' && (typeof value.plugin === 'function' || 'root' in value || 'registry' in value)
      const found = []
      for (const key of Object.keys(globalThis)) {
        try { if (looksLikeCtx(globalThis[key])) found.push(`window.${key}`) } catch { /* getter threw */ }
      }
      for (const key of Object.keys(loader ?? {})) {
        try { if (looksLikeCtx(loader[key])) found.push(`__ModuleLoader__.${key}`) } catch { /* getter threw */ }
      }
      // `load()` may hand back a module whose exports include the running app.
      const loaded = {}
      for (const id of ['@deepseek-ai/dsh-cordis-client-runner/client', '@deepseek-ai/dsh-api-session-controller/client', '@deepseek-ai/dsh-api-workspace-controller/client']) {
        try {
          const module = await loader.load(id)
          loaded[id] = Object.keys(module ?? {}).slice(0, 20)
        } catch (error) { loaded[id] = `ERR ${String(error).slice(0, 90)}` }
      }
      return {
        loaderKeys: Object.keys(loader ?? {}),
        loaderShape: shape(loader),
        ctxCandidates: found,
        loaded,
        dshGlobals: Object.keys(globalThis).filter(key => /DSH|dsh|ordis|ctx/i.test(key)).slice(0, 40),
        sidebarText: (document.body?.innerText ?? '').slice(0, 400),
      }
    })
    console.log('---- 阶段 1：句柄探测 ----')
    console.log(JSON.stringify(discovery, null, 2))
  } finally {
    await browser.close()
    killTree(child)
  }
  // Exit explicitly: a lingering grandchild or pipe would otherwise keep the loop alive
  // (the first run sat until its 600s cap after printing everything).
  process.exit(0)
}

await main()
