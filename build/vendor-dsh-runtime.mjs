/**
 * 从本地 DSH 安装 vendor 一份运行时包（类型 + 代码），供本地构建与类型检查。
 *
 * ## 为什么需要它（实测换来的）
 *
 * 1. registry **可达但不可靠**：`pnpm install` 反复 `UND_ERR_DESTROYED` 断流重试；
 * 2. 更硬的阻塞：**`@deepseek-ai/dsh-invariants@0.2.1-rc.2` 在仓库里没有这个版本** ✗
 *    （`ERR_PNPM_NO_MATCHING_VERSION`）—— 它只随 DSH 安装分发。
 * ⇒ 依赖 registry 装不齐；而 **DSH 安装里本来就是完整的 0.2.1-rc.2**，直接复制过来版本精确、
 *    也不需要网络。构建与 `pnpm typecheck` 因此要求本机装有同版本的 DSH（本工作流本就如此）。
 *
 * ## 边界
 *
 * - 只复制 `@deepseek-ai/dsh-*` 与 `@deepseek-ai/cordis`（运行时）；`node_modules` 不入库；
 * - 复制前清掉目标目录，避免 0.1.5 与 0.2.1 混在一起（那正是本次事故的形态）；
 * - 复制后打印版本，便于核对。
 *
 * 用法：`node build/vendor-dsh-runtime.mjs`
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

const HOME = process.env.USERPROFILE ?? process.env.HOME ?? ''
const source = join(HOME, 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai')
const target = join(process.cwd(), 'node_modules', '@deepseek-ai')

if (!existsSync(source)) {
  console.error(`✘ 找不到本机 DSH 安装：${source}`)
  process.exit(1)
}

/** DSH 自己的版本，写进日志便于核对。 */
const dshVersion = JSON.parse(readFileSync(join(source, '..', '..', 'package.json'), 'utf8')).version

/** 需要 vendor 的包：运行时框架 + cordis。 */
const names = readdirSync(source).filter(name => name === 'cordis' || name.startsWith('dsh-'))
if (names.length < 20) {
  console.error(`✘ 源目录里只找到 ${names.length} 个包，路径可能不对`)
  process.exit(1)
}

mkdirSync(target, { recursive: true })
let copied = 0
for (const name of names) {
  const from = join(source, name)
  if (!statSync(from).isDirectory()) continue
  const to = join(target, name)
  // 先删再拷：0.1.5 与 0.2.1 混装是这次事故的形态，不允许残留。
  rmSync(to, { recursive: true, force: true })
  // **必须 dereference**：pnpm 与 DSH 安装里的 `@deepseek-ai/*` 是**符号链接**，
  // 默认行为会把链接原样复制过来 ⇒ 复制出来全是断链 ⇒ tsc 报
  // `TS2307: Cannot find module '@deepseek-ai/…'`（本轮实测踩过）。
  cpSync(from, to, { recursive: true, dereference: true })
  copied += 1
}

const sample = ['dsh-session', 'dsh-client-ui-slots', 'dsh-client-ui-renderer', 'cordis']
console.log(`✓ 从 DSH ${dshVersion} vendor 了 ${copied} 个包到 node_modules/@deepseek-ai`)
for (const name of sample) {
  const pkg = join(target, name, 'package.json')
  if (existsSync(pkg)) console.log(`    ${name} ${JSON.parse(readFileSync(pkg, 'utf8')).version}`)
}
