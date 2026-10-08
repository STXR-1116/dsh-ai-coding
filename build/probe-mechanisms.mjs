/**
 * 跑机制探针（M1–M4）并打印报告。
 *
 * 为什么单独写一个脚本：探针必须跑在**真实的浏览器客户端上下文**里（要拿 `ctx.get(...)` 的服务），
 * 而客户端服务**不暴露给页面外部**（早前实测：`window.__ModuleLoader__` 只有 load/create，
 * 没有根上下文）。所以探针作为插件的一部分随包安装，再由这个脚本启动**它自己的** `dsh web`
 * 实例读取结果 —— 所有者正在运行的实例不受影响，也不需要他重启。
 *
 * 用法: node build/probe-mechanisms.mjs [port]
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import net from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CHROME_CANDIDATES = [
  process.env.DSH_SPIKE_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean)

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Reserve a free port atomically (same fix as the smoke uses). */
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

/** Read the registry-global archive set — the archived sessions M2 needs. */
function archivedSessionIds() {
  try {
    const raw = readFileSync(join(homedir(), '.dsh', 'storages', 'workspace.json'), 'utf8')
    const parsed = JSON.parse(raw)
    const ids = parsed?.global?.archivedSessionIds ?? parsed?.archivedSessionIds ?? []
    return Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : []
  } catch {
    return []
  }
}

async function boot(port) {
  const child = spawn('dsh', ['--profile', 'web', '--no-open', '--port', String(port)], {
    shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', data => { out += String(data) })
  child.stderr.on('data', data => { out += String(data) })
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const token = /token=([A-Za-z0-9_-]+)/u.exec(out)?.[1]
    if (token !== undefined) return { child, token }
    await sleep(500)
  }
  throw new Error(`dsh web 未在 120s 内就绪。输出尾部:\n${out.slice(-800)}`)
}

/** Kill the whole tree: `shell: true` means child.kill() only reaps the shell. */
function killTree(child) {
  try {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  } catch { /* best effort */ }
}

/** Click the first button whose text matches one of the labels. */
async function clickByText(page, labels) {
  return page.evaluate(candidates => {
    const buttons = [...document.querySelectorAll('button')]
    const hit = buttons.find(button => candidates.some(label => (button.textContent ?? '').includes(label)))
    if (hit === undefined) return false
    hit.click()
    return true
  }, labels)
}

/**
 * 点侧栏里一个**已知标题**的会话，让 Conversation 挂载。
 *
 * 这条是实测逼出来的：全新浏览器没有工作区/当前会话记录，应用停在「选择工作区」英雄页，
 * 而右侧 Sidebar 的席位「仅在选中 Conversation 时」挂载 —— 不进入会话就测不到 M3/M4。
 * 标题取自所有者浏览器里真实存在的会话名（截图可见），不猜 DOM 结构：找 textContent
 * **恰好等于**标题的元素，取最深的一个点击（容器也含同样文本，点容器不会打开会话）。
 * @param titles - 候选会话标题。
 * @returns 是否点中。
 */
async function clickSessionByTitle(page, titles) {
  return page.evaluate(candidates => {
    const all = [...document.querySelectorAll('button, a, [role="button"], [role="treeitem"], li, div, span')]
    const matches = all.filter(node => candidates.includes((node.textContent ?? '').trim()))
    const target = matches[matches.length - 1]
    if (target === undefined) return false
    target.click()
    return true
  }, titles)
}

/**
 * Best-effort: 点侧栏里一个既有会话，让 Conversation 挂载。
 *
 * 不猜 DOM 结构：只认带 `data-session-id` 或 `role="listitem"` 的行；找不到就返回 false，
 * 由探针自己的 `ISessions.open()` 去切换（那是它本来就要做的事，且不产生副作用）。
 */
async function clickFirstSessionRow(page) {
  return page.evaluate(() => {
    const row = document.querySelector('[data-session-id], [role="listitem"]')
    if (row === null) return false
    row.click()
    return true
  })
}

const main = async () => {
  const port = Number(process.argv[2]) || await reservePort()
  const executablePath = CHROME_CANDIDATES.find(candidate => existsSync(candidate))
  if (executablePath === undefined) throw new Error('找不到 Chromium')
  const { default: puppeteer } = await import('puppeteer-core')

  const archived = archivedSessionIds()
  console.log(`归档会话数（来自 registry）：${archived.length}`)

  console.log(`启动 dsh web（端口 ${port}）…`)
  const { child, token } = await boot(port)
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  try {
    const page = await browser.newPage()
    const consoleLines = []
    page.on('console', message => {
      const text = message.text()
      if (text.includes('[ai-coding-probe]')) consoleLines.push(text)
    })
    // 新开的浏览器没有 localStorage，探针会因此找不到"我们映射过的会话"。这里预置一条映射，
    // 指向**真实归档过**的会话 —— 这样 M2 才是对归档会话的真实检验。
    // 同时打开探针开关：服务端会 303 重定向到 `/`，URL 上的 `?probe=1` 会丢，
    // 而这里注入的全局与存储对每个新文档都重新生效。
    await page.evaluateOnNewDocument(ids => {
      try {
        localStorage.setItem('dsh-ai-coding:probe', '1')
        localStorage.setItem(
          'dsh-ai-coding:workspace-session:probe',
          JSON.stringify(Object.fromEntries(ids.slice(0, 3).map((id, index) => [`ws-probe-${index}`, id]))),
        )
      } catch { /* storage unavailable: the probe reports it */ }
      globalThis.__DSH_AI_CODING_PROBE__ = true
    }, archived)

    await page.goto(`http://127.0.0.1:${port}/?token=${token}&probe=1`, { waitUntil: 'networkidle2', timeout: 60_000 })
    await page.waitForSelector('button', { timeout: 30_000 })

    // 页面会停在引导/选择工作区界面，而**右侧 Sidebar 的席位只在选中 Conversation 时挂载** ——
    // 在那个状态下测 M3 只会得到装配期的假失败。所以：先跳过引导，尽量让应用进入会话面，
    // 再按需重跑探针（探针把自己暴露成 `__aiCodingProbeRun`）。
    const skipped = await clickByText(page, ['稍后配置', '跳过', 'Skip', 'Later'])
    console.log(`跳过引导: ${skipped}`)
    await sleep(2_000)
    const mounted = await page.waitForFunction(
      () => document.querySelector('[contenteditable="true"]') !== null,
      { timeout: 8_000 },
    ).then(() => true).catch(() => false)
    console.log(`初次加载 Conversation 挂载: ${mounted}`)
    // 本脚本不再新建会话（那会在 DSH 里留下删不掉的空会话），所以没有要清理的 id。
    const createdId = undefined
    // 进会话：点侧栏里一个已知标题的会话。这是唯一被实测证明有效的办法 ——
    // 跳过引导、种 `dsh.sessions.current`、`ISessions.open()` 都不改变界面。
    if (!mounted) {
      const clicked = await clickSessionByTitle(page, [
        '插件与管理后台调试', 'Jev', '这张图中的人物是谁', 'dsh-ai-coding', 'AI Coding Hub', '新会话',
      ])
      console.log(`点会话标题: ${clicked}`)
      const afterClick = await page.waitForFunction(
        () => document.querySelector('[contenteditable="true"]') !== null,
        { timeout: 20_000 },
      ).then(() => true).catch(() => false)
      console.log(`点后 Conversation 挂载: ${afterClick}`)
    }
    // 新浏览器没有"当前会话"记录（`dsh.sessions.current = {}`），应用停在「选择工作区」英雄页，
    // **Conversation 不挂载 ⇒ 右侧面不挂载 ⇒ M3 无从验证**（实测三次都卡在这）。
    // 所以点一次侧栏的「新会话」让会话面出现；跑完用 `__aiCodingProbeArchive` 把那个会话归档隐藏，
    // 不在 DSH 里留下删不掉的空会话。
    // 新浏览器没有"当前会话"记录（`dsh.sessions.current = {}`），应用停在「选择工作区」英雄页，
    // Conversation 不挂载 ⇒ 右侧面不挂载 ⇒ M3 无从验证（实测多次都卡在这）。
    // 不再猜 DOM：把**已归档但可 open 的会话**种进那条记录（两种可能的内部形状一起种，只当实验），
    // 重新加载让应用自己恢复它 —— 全程不创建任何会话。
    if (!mounted && archived.length > 0) {
      await page.evaluateOnNewDocument(id => {
        try {
          // 形状未文档化：`dsh.sessions.current` 在本浏览器里是空对象 `{}`。这里同时种两种最常见的
          // 内部形状（按账号、按 current 字段），哪种生效都能恢复出会话；都不生效就退回问所有者。
          localStorage.setItem('dsh.sessions.current', JSON.stringify({ current: id, anonymous: id }))
        } catch { /* storage unavailable */ }
      }, archived[0])
      console.log(`种入当前会话记录（${archived[0].slice(0, 14)}…）并重新加载 …`)
      await page.reload({ waitUntil: 'networkidle2', timeout: 60_000 })
      const remounted = await page.waitForFunction(
        () => document.querySelector('[contenteditable="true"]') !== null,
        { timeout: 30_000 },
      ).then(() => true).catch(() => false)
      console.log(`重新加载后 Conversation 挂载: ${remounted}`)
    }

    const rerun = await page.evaluate(async () => {
      const runner = globalThis.__aiCodingProbeRun
      if (typeof runner !== 'function') return false
      await runner()
      return true
    })
    console.log(`按需重跑探针: ${rerun}`)

    // 应用把"当前会话"记在哪：直接把 localStorage 的键打出来看，而不是猜键名。
    const storageDump = await page.evaluate(() => {
      const rows = []
      try {
        for (let index = 0; index < localStorage.length; index += 1) {
          const key = localStorage.key(index)
          if (key === null) continue
          const value = localStorage.getItem(key) ?? ''
          rows.push(`${key} = ${value.slice(0, 120)}`)
        }
      } catch (error) { rows.push(`读取失败：${String(error)}`) }
      return rows
    })
    console.log(`\n---- localStorage（${storageDump.length} 项） ----`)
    for (const row of storageDump) console.log(`  ${row}`)

    let report
    try {
      await page.waitForSelector('#ai-coding-mechanism-probe', { timeout: 45_000 })
      report = await page.$eval('#ai-coding-mechanism-probe', node => node.textContent ?? '')
    } catch {
      console.log('⚠ 未在 45s 内等到探针输出元素；以下是 console 里收到的探针行：')
    }

    const paneSeen = await page.evaluate(() => document.querySelector('[data-probe-pane]') !== null)
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 300))

    console.log('\n================ 探针报告 ================')
    if (report === undefined || report.length === 0) {
      console.log('（无 DOM 报告）')
    } else {
      const parsed = JSON.parse(report)
      for (const [key, value] of Object.entries(parsed)) {
        if (key === 'facts') continue
        const result = value
        console.log(`${result.ok ? '✅' : '❌'} ${key}\n     ${result.detail}`)
      }
      console.log('\n---- facts ----')
      console.log(JSON.stringify(parsed.facts, null, 2))
    }
    console.log(`\n探针 pane 正文是否出现在 DOM 中: ${paneSeen}`)
    if (consoleLines.length > 0) console.log(`\nconsole 探针行数: ${consoleLines.length}`)
    console.log('\n---- 页面文本前 300 字（确认外壳正常） ----')
    console.log(bodyText.replace(/\n+/gu, ' | '))
    console.log('==========================================')

    // 清理：把本次为"让会话面挂载"而新建的会话归档隐藏 —— 官方明确没有删除入口，
    // 留着就是一条永久空会话。归档后它从所有分组视图消失（与产品自身的做法一致）。
    if (createdId !== undefined && createdId.length > 0) {
      const archived = await page.evaluate(async id => {
        const archive = globalThis.__aiCodingProbeArchive
        if (typeof archive !== 'function') return '没有清理入口'
        try {
          const result = await archive(id)
          return result === undefined ? '归档调用返回 undefined' : `归档结果 ${JSON.stringify(result)}`
        } catch (error) {
          return `归档抛错：${String(error)}`
        }
      }, createdId)
      console.log(`清理：本次创建的会话 ${createdId.slice(0, 14)}… → ${archived}`)
    } else {
      console.log('清理：本次未新建会话（未拿到 id），无需清理')
    }
  } finally {
    await browser.close()
    killTree(child)
  }
  process.exit(0)
}

await main()
