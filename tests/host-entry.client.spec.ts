/* 覆盖补齐：包入口此前没有用例导入。
 *
 * 这个入口是 Host 侧的加载桩——插件的行为全部在浏览器侧（`src/client`），
 * Host 侧**必须不注册任何东西**。用例钉住它的公开面就是 `apply` 一个空实现：
 * 入口可加载、`apply()` 可调用且无返回值，避免有人在入口里偷偷挂上 Host 行为
 * 而无人察觉。
 *
 * 文件名带 `.client` 是编译平面要求：`tsconfig.host.json` 排除
 * `packages/client/<pkg>/src/` 整个目录，只有 client 平面能同时看到本包的两个入口。
 */
import { describe, expect, it } from 'vitest'
import * as hostEntry from '../src/client-node/index.ts'

describe('Host 加载入口', () => {
  it('公开面只有 apply，且它不接受任何参数', () => {
    expect(Object.keys(hostEntry)).toEqual(['apply'])
    expect(typeof hostEntry.apply).toBe('function')
    // 空实现：调用它不抛错，也不注册任何东西——它没有可传入的 ctx。
    hostEntry.apply()
    expect(hostEntry.apply.length).toBe(0)
  })
})
