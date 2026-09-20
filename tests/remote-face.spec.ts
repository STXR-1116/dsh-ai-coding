/* 派生 Remote face 的漂移守卫。
 *
 * `src/client/remote-face.ts` 是 `build/generate-remote-face.mjs` 的产物，按仓库
 * 约定入库（这样浏览器半边无需 codegen 步骤即可 typecheck）。入库的产物天生有漂移
 * 风险：网关加了 `@Remote` 方法而没人重跑生成器时，类型面会静默落后于运行时契约。
 *
 * 这个用例把「产物 == 重新生成的结果」变成一条会红的断言。比较在进程内完成 ——
 * 早先的写法是 `execFileSync` 去跑生成器的 `--check` 模式，那会在 Vitest 的 fork 里
 * 再 spawn 一个带管道 stdio 的子 node；整仓跑出现过 `[vitest-pool]: Worker forks
 * emitted error` / `Worker exited unexpectedly`（约五次全量跑里一次，连已完成的两个
 * 用例一起丢掉），worker 内捕获 stdio 的子进程是合理嫌疑。改成直接 import 生成器的
 * 纯函数后，测试不再创建任何进程。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalizeNewlines, readCheckedInFace, renderRemoteFace } from '../build/generate-remote-face.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('Remote face 漂移守卫', () => {
  it('入库的 src/client/remote-face.ts 与重新生成的结果一致', () => {
    // 归一化换行：本仓在 Windows 上以 core.autocrlf 检出（入库 LF、落盘 CRLF），
    // 生成器写 LF，字节比较会把每个 Windows 检出都判成 stale。
    expect(normalizeNewlines(readCheckedInFace())).toBe(normalizeNewlines(renderRemoteFace()))
  })

  it('face 覆盖两个网关声明的全部 @Remote 端点', () => {
    // 生成器自身已校验「类存在」「端点非空」「端点不重名」；这里只钉住数量与命名空间，
    // 让端点数意外塌缩（例如装饰器写法变化导致漏采）也能被看见。
    const source = readFileSync(join(repoRoot, 'src', 'client', 'remote-face.ts'), 'utf8')
    const endpoints = [...source.matchAll(/^ {4}(\S+): \(/gmu)].map(match => match[1])
    expect(endpoints.length).toBe(85)
    expect(new Set(endpoints).size).toBe(85)
    expect(source).toContain("'teamSkills': TypertRemoteNamespace$teamSkills")
    expect(source).toContain("'cloudWorkspaces': TypertRemoteNamespace$cloudWorkspaces")
  })
})
