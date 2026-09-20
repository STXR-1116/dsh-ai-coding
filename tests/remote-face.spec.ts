/* 派生 Remote face 的漂移守卫。
 *
 * `src/client/remote-face.ts` 是 `build/generate-remote-face.mjs` 的产物，按仓库
 * 约定入库（这样浏览器半边无需 codegen 步骤即可 typecheck）。入库的产物天生有漂移
 * 风险：网关加了 `@Remote` 方法而没人重跑生成器时，类型面会静默落后于运行时契约。
 *
 * 守卫分两层，刻意都不重：
 *
 * 1. **构建期（权威）** —— `pnpm build` 的第一步就是跑生成器，它比较后按需重写。
 *    所以任何构建都会让 face 与网关一致；跑完 `git status` 若显示该文件被改动，
 *    即说明入库的产物曾经过期。
 * 2. **测试期（本文件）** —— 只用正则与字符串比较钉住不变量，不 import 生成器、
 *    不 spawn 子进程。生成器要 import `typescript`（数 MB）；把它拉进 Vitest 的
 *    worker 只为断言一个字符串并不划算 —— 早先两个版本分别用 `execFileSync`
 *    （worker 内带管道 stdio 的子进程）和直接 import（把 TS 编译器载进 worker），
 *    两者都让 worker 的存活状况更可疑。
 *
 * 这里的端点计数来自网关源码里 `@Remote` 的出现次数，与生成器的取法同源：
 * 生成器按方法上的装饰器逐个取，而本仓两个网关的每个 `@Remote` 都恰好落在一个
 * 方法上（`gateway.ts` 37 个带字面量名，`workspace-gateway.ts` 48 个裸装饰器）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const facePath = join(repoRoot, 'src', 'client', 'remote-face.ts')

/** Host gateways and the Typert wire namespace each one publishes. */
const GATEWAYS = [
  { file: 'src/gateway.ts', namespace: 'teamSkills', className: 'TeamSkillGateway' },
  { file: 'src/workspace-gateway.ts', namespace: 'cloudWorkspaces', className: 'WorkspaceGateway' },
]

const read = (relativePath) => readFileSync(join(repoRoot, relativePath), 'utf8')

describe('Remote face 漂移守卫', () => {
  it('face 的端点数等于两个网关声明的 @Remote 数量', () => {
    const face = read('src/client/remote-face.ts')
    const endpoints = [...face.matchAll(/^ {4}(\S+): \(/gmu)].map(match => match[1])
    const declared = GATEWAYS.reduce(
      (total, gateway) => total + [...read(gateway.file).matchAll(/@Remote\b/gu)].length,
      0,
    )
    expect(endpoints.length).toBe(declared)
    // 重名会让后一个静默覆盖前一个，端点表就不再是双射。
    expect(new Set(endpoints).size).toBe(endpoints.length)
  })

  it('face 每个端点都解析出参数表、返回类型与传输信封', () => {
    const face = read('src/client/remote-face.ts')
    const lines = face.split('\n').filter(line => /^ {4}\S+: \(/u.test(line))
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line).toMatch(/^ {4}\S+: \(.*\) => Promise<RemoteResult<.+>>$/u)
    }
  })

  it('两个命名空间都绑定到 TypertRemoteNamespaceMap', () => {
    const face = read('src/client/remote-face.ts')
    for (const gateway of GATEWAYS) {
      expect(face).toContain(`interface TypertRemoteNamespace$${gateway.namespace} {`)
      expect(face).toContain(`'${gateway.namespace}': TypertRemoteNamespace$${gateway.namespace}`)
    }
    expect(face).toContain("declare module '@deepseek-ai/dsh-typert-protocol' {")
    expect(face).toContain("import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'")
  })

  it('face 只从本包的类型模块取类型，不引用旧包名', () => {
    const face = read('src/client/remote-face.ts')
    const imports = [...face.matchAll(/from '([^']+)'/gu)].map(match => match[1])
    expect(imports.length).toBeGreaterThan(0)
    for (const specifier of imports) {
      expect(specifier === '@deepseek-ai/dsh-typert-protocol' || specifier.startsWith('../')).toBe(true)
    }
    expect(face).not.toContain('dsh-ai-coding-platform')
  })
})
