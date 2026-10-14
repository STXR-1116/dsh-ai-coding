/**
 * 把一个本地 HTML 截成 PNG（供效果图/设计稿用）。
 *
 * 复用 mount-smoke 的浏览器探测方式（puppeteer-core + 本机 Chrome/Edge）。
 * 用法：node build/screenshot.mjs <输入.html> <输出.png> [宽] [高]
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const CANDIDATES = [
  process.env.DSH_SPIKE_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean)

const [input, output, width = '1360', height = '900'] = process.argv.slice(2)
if (input === undefined || output === undefined) {
  console.error('用法：node build/screenshot.mjs <输入.html> <输出.png> [宽] [高]')
  process.exit(1)
}
const executablePath = CANDIDATES.find(candidate => existsSync(candidate))
if (executablePath === undefined) { console.error('找不到 Chromium'); process.exit(1) }

const { default: puppeteer } = await import('puppeteer-core')
const browser = await puppeteer.launch({
  executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
try {
  const page = await browser.newPage()
  await page.setViewport({ width: Number(width), height: Number(height), deviceScaleFactor: 2 })
  await page.goto(pathToFileURL(resolve(input)).href, { waitUntil: 'load' })
  await page.screenshot({ path: resolve(output), fullPage: true })
  console.log(`✓ ${output}`)
} finally {
  await browser.close()
}
