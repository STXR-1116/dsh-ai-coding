/* 派生 Remote face 的漂移守卫。
 *
 * `src/client/remote-face.ts` 是 `build/generate-remote-face.mjs` 的产物，按仓库
 * 约定入库（这样浏览器半边无需 codegen 步骤即可 typecheck）。入库的产物天生有漂移
 * 风险：网关加了 `@Remote` 方法而没人重跑生成器时，类型面会静默落后于运行时契约。
 *
 * 这个用例把「产物 == 重新生成的结果」变成一条会红的断言，成本是一次 `--check`
 * 子进程。上游同样有这个风险，靠的是构建期生成 —— 本仓布局下生成器跑不起来
 * （见 docs/typert-wiring-notes.md），所以把守卫挪到测试里。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const generator = join(repoRoot, 'build', 'generate-remote-face.mjs')

describe('Remote face 漂移守卫', () => {
  it('入库的 src/client/remote-face.ts 与重新生成的结果一致', () => {
    // `--check` 不写文件；不一致时以非零码退出并打印重跑命令。
    const run = (): string =>
      execFileSync(process.execPath, [generator, '--check'], { cwd: repoRoot, encoding: 'utf8' })

    expect(run).not.toThrow()
    expect(run()).toContain('remote face is up to date')
  })

  it('face 覆盖两个网关声明的全部 @Remote 端点', async () => {
    // 生成器自身已校验「类存在」「端点非空」「端点不重名」；这里只钉住数量与命名空间，
    // 让端点数意外塌缩（例如装饰器写法变化导致漏采）也能被看见。
    const face = await import('../src/client/remote-face.ts')
    expect(face).toBeDefined()

    const source = await import('node:fs').then(fs => fs.readFileSync(join(repoRoot, 'src', 'client', 'remote-face.ts'), 'utf8'))
    const endpoints = [...source.matchAll(/^ {4}(\S+): \(/gmu)].map(match => match[1])
    expect(endpoints.length).toBe(85)
    expect(new Set(endpoints).size).toBe(85)
    expect(source).toContain("'teamSkills': TypertRemoteNamespace$teamSkills")
    expect(source).toContain("'cloudWorkspaces': TypertRemoteNamespace$cloudWorkspaces")
  })
})
