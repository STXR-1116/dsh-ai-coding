/**
 * Classify which screen a browser page is showing — for **diagnosis only**.
 *
 * ## Why
 *
 * When a step of the mount smoke fails, today's report is a symptom: "settings
 * input not found", "login form not visible". Reading that back to a cause means
 * reading a page dump by hand, which is exactly what went wrong repeatedly while
 * this plugin was being adapted. A named state points at the cause: a
 * `settings-face` means the deployment declared no endpoint, a `service-error`
 * means the endpoint is unreachable.
 *
 * ## Shape
 *
 * The official `classification_using_confidence` cookbook: one `Choice` over the
 * candidate states, then read the answer's **`confidence`** to decide whether to
 * report the specific state or the broader family it belongs to. Reported one
 * level up, a doubtful answer stays useful instead of being asserted or dropped,
 * and the fallback costs no second request because the hierarchy is ours.
 * (Measured there: confident answers right 90%, doubtful ones 40% at the specific
 * level — 70% once broadened.)
 *
 * ## Diagnosis only, never an assertion
 *
 * This must not decide whether a test passes. A model returns a probability, and
 * the repository's testing policy is explicit that a spec which only passes alone
 * is that spec's defect — gates need determinism. So: it runs **after** a step has
 * already failed, to say where the app actually was, and any failure inside it
 * returns `undefined` rather than disturbing the run.
 *
 * @module dsh-ai-coding/build/page-state-classifier
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Model pinned to a version: threshold tuning does not survive an alias moving. */
export const CLASSIFIER_MODEL = 'jev-1.13.0'

/**
 * Below this the specific state is not reported; the family is.
 * Set from measurement, not taste — see `--live`.
 */
export const DEFAULT_CONFIDENCE_FLOOR = 0.7

/** The coarse families, used when the model is not confident enough to name a state. */
export const STATE_FAMILIES = ['未就绪', '已就绪', '失败', '无法识别']

/**
 * The states this app can be in, with the boundaries written out.
 *
 * `what` / `not_for` / `examples` are the official structured option shape; the
 * `not_for` line is what keeps two lookalike screens apart (the settings face and
 * the login form both show a form, and only one of them is a failure to deploy).
 * Human review of these descriptions is the point — the official guidance says to
 * expect to edit questions collaboratively.
 */
export const PAGE_STATES = {
  'settings-face': {
    family: '未就绪',
    what: '页面要求操作者填写服务地址：标题或表单里有「服务地址 / 配置编程协作台的服务地址」之类的字段，且没有账号登录表单',
    not_for: '有账号密码登录表单的是 login-form；有报错与「重新加载」按钮的是 service-error',
    examples: ['配置编程协作台的服务地址 + 平台服务地址（必填，含 /v1）输入框'],
  },
  'login-form': {
    family: '未就绪',
    what: '页面要求输入账号与密码登录（用户名/密码输入框 + 登录按钮），或提示登录已过期',
    not_for: '要求填服务地址的是 settings-face',
    examples: ['账号 + 密码 + 登录'],
  },
  'project-picker': {
    family: '已就绪',
    what: '已登录且页面在等操作者选择项目或知识库：出现项目选择器（如「当前项目」下拉）或项目/知识库列表',
    not_for: '已经渲染出工作台模块内容（导航、会话、工作区列表）的是 workbench-ready',
    examples: ['当前项目 下拉框 + 项目列表'],
  },
  'workbench-ready': {
    family: '已就绪',
    what: '工作台已渲染出实际内容：模块导航、工作区/知识库视图或会话界面可见',
    not_for: '仅有登录或项目选择界面的是前两个状态',
    examples: ['侧栏「打开编程协作台」+ 工作区列表 ws-alpha-1', '知识库视图 k-1'],
  },
  'service-error': {
    family: '失败',
    what: '页面报服务不可用或读取失败：出现「服务暂时不可用」「Failed to fetch」等字样，通常带「重新加载」按钮',
    not_for: '整页空白或只有挂载失败提示的是 boot-pending / render-failure',
    examples: ['服务暂时不可用（当前服务地址：http://…）', 'Failed to fetch'],
  },
  'boot-pending': {
    family: '未就绪',
    what: '页面尚未挂载完成：出现 pending / waiting for services / web boot 之类的等待提示，或工作台入口还没出现',
    not_for: '已经报错的是 service-error / render-failure',
    examples: ['pending banner', 'waiting for services'],
  },
  'render-failure': {
    family: '失败',
    what: '本插件的界面渲染失败并显示了降级提示：出现「渲染失败 / 重新加载页面即可恢复」并提到 dsh-ai-coding 标签',
    not_for: '服务侧失败是 service-error',
    examples: ['协作台界面渲染失败 / The workbench failed to render'],
  },
  unrecognised: {
    family: '无法识别',
    what: '以上都不是：页面是登录墙、错误页、空白页，或内容不足以判断',
    not_for: '不要为了给出答案而勉强归入上面任何一类',
    examples: ['Internal Server Error', '空白页面'],
  },
}

/** Read the API key from its file source. Never from `process.env` (DSH scrubs it), never printed. */
function readApiKey() {
  const envFile = join(homedir(), '.dsh', '.env')
  if (!existsSync(envFile)) return undefined
  const line = readFileSync(envFile, 'utf8').split(/\r?\n/).find(l => l.startsWith('TYPESAFE_API_KEY='))
  const value = line?.slice('TYPESAFE_API_KEY='.length).trim()
  return value && value.length > 0 ? value : undefined
}

/**
 * Ask which state the page is in.
 *
 * Never throws and never returns a judgement it did not receive: a missing key, a
 * refused request, a timeout or a malformed body all give `undefined`, so the
 * caller can print "state unknown" instead of losing the original failure.
 * @param pageText - the page's visible text (and any other cheap signal).
 * @param options - overrides for the floor, model and endpoint.
 * @returns the state, or `undefined` when no judgement was obtained.
 */
export async function classifyPageState(pageText, options = {}) {
  const floor = options.confidenceFloor ?? DEFAULT_CONFIDENCE_FLOOR
  const apiKey = options.apiKey ?? readApiKey()
  if (apiKey === undefined) return undefined

  const truncated = pageText.length > 12_000 ? `${pageText.slice(0, 12_000)}\n…（截断）` : pageText
  const body = {
    model: options.model ?? CLASSIFIER_MODEL,
    state: { page_text: truncated },
    questions: {
      state: {
        type: 'choice',
        instructions: 'Which screen is this application currently showing? Judge only what `page_text` shows.',
        criteria: Object.fromEntries(Object.entries(PAGE_STATES).map(([name, spec]) => [name, {
          what: spec.what,
          not_for: spec.not_for,
          examples: spec.examples,
        }])),
      },
    },
  }

  let response
  try {
    response = await fetch(options.endpoint ?? 'https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
    })
  } catch {
    return undefined
  }
  if (!response.ok) return undefined

  let parsed
  try { parsed = await response.json() } catch { return undefined }
  const answer = parsed?.answers?.state
  const state = answer?.choice
  const confidence = answer?.confidence
  if (typeof state !== 'string' || typeof confidence !== 'number') return undefined
  const family = PAGE_STATES[state]?.family ?? '无法识别'
  return {
    level: confidence >= floor ? 'state' : 'family',
    label: confidence >= floor ? state : family,
    state,
    family,
    confidence,
    probabilities: answer.probabilities,
  }
}

/** The one-line sentence a failing smoke step appends. */
export function describePageState(result) {
  if (result === undefined) return '页面状态：未能判定（分类器不可用或请求失败）'
  const percent = `${Math.round(result.confidence * 100)}%`
  return result.level === 'state'
    ? `页面状态：${result.state}（置信度 ${percent}）`
    : `页面状态：置信度不足以指名（${percent}，最可能是 ${result.state}）→ 粗粒度判定：${result.family}`
}

/** Launch Chromium, open the app, return the visible text. Mirrors the smoke's own launch. */
async function dumpLivePage(url) {
  const { default: puppeteer } = await import('puppeteer-core')
  const candidates = [
    process.env.DSH_SMOKE_BROWSER,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean)
  const executablePath = candidates.find(candidate => existsSync(candidate))
  if (executablePath === undefined) throw new Error('no Chromium installation found')
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  try {
    const page = await browser.newPage()
    await page.goto(url, { waitUntil: 'networkidle2' })
    await new Promise(resolve => setTimeout(resolve, 2_000))
    return await page.evaluate(() => document.body?.innerText ?? '')
  } finally {
    await browser.close()
  }
}

// CLI: `node build/page-state-classifier.mjs --file <dump>` or `--live <url>`
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  const args = process.argv.slice(2)
  const flag = args[0]
  const value = args[1]
  let text
  if (flag === '--file' && value) text = readFileSync(value, 'utf8')
  else if (flag === '--live' && value) text = await dumpLivePage(value)
  else if (flag === '--stdin') text = readFileSync(0, 'utf8')
  else {
    console.log('用法: node build/page-state-classifier.mjs --file <dump.txt> | --live <url> | --stdin')
    process.exit(2)
  }
  console.log(`输入 ${text.length} 字符`)
  const result = await classifyPageState(text)
  console.log(describePageState(result))
  if (result !== undefined) {
    const ranked = Object.entries(result.probabilities ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 3)
    console.log(`最可能的前三: ${ranked.map(([name, p]) => `${name} ${(p * 100).toFixed(1)}%`).join('  ')}`)
  }
}
