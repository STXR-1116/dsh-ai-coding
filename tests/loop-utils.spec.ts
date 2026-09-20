/* 覆盖补齐：`textOf` 的两条未被现有用例走到的分支。
 *
 * 该助手是知识/记忆生命周期循环共用的会话正文提取器，此前的覆盖只来自
 * knowledge-loop / memory-loop 的端到端路径——它们喂进来的都是带 text 的
 * 文本块，因此「文本块没有 text」（`?? ''` 右侧）与「最终没有可提取文本」
 * （返回 undefined 的分支）从未被执行。这两条是真实可达的输入，不是死代码。
 */
import { describe, expect, it } from 'vitest'
import { textOf } from '../src/loop-utils.ts'

describe('textOf', () => {
  it('joins every text block and skips the non-text ones', () => {
    expect(textOf({
      content: [
        { type: 'text', text: '发布' },
        { type: 'tool-call' },
        { type: 'text', text: '流程' },
      ],
    })).toBe('发布流程')
  })

  it('treats a text block without its own text as empty content', () => {
    // `block.text ?? ''` 的右侧：块类型是 text 但没有 text 字段。
    expect(textOf({ content: [{ type: 'text' }] })).toBeUndefined()
  })

  it('returns undefined when no block carries text at all', () => {
    expect(textOf({ content: [{ type: 'tool-call' }, { type: 'image' }] })).toBeUndefined()
    expect(textOf({ content: [] })).toBeUndefined()
  })
})
