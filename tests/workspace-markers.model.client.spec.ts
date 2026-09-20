// 2-2「工程树、会话与预览」模型层验收（蓝图 §5.2）。
//
// 异常矩阵：
//   标记     —— 变更集中文件 → Agent 修改标记 + 未同步状态（modified/added/deleted
//               逐值）；测试关联按路径特征（tests/ 目录、*.test.*、*.spec.*）；
//               不在变更集中的路径无修改标记。
//   查看器   —— static_html→sandbox、image→image、markdown→markdown、diff→diff、
//               终端输出（x-terminal/terminal 路径）→terminal、json→json、
//               其余文本→text；类型错误输入不抛错、按文本兜底显式呈现。
import { describe, expect, it } from 'vitest'
import { selectPreviewViewer, treeEntryMarkers } from '../src/client/cloud-workspaces/workspace-markers.ts'

describe('treeEntryMarkers 工程树标记', () => {
  const changes = [
    { path: 'src/app.json', change: 'modified' },
    { path: 'src/new.ts', change: 'added' },
    { path: 'src/old.ts', change: 'deleted' },
  ]

  it('变更集中的文件携带 Agent 修改标记与未同步状态', () => {
    expect(treeEntryMarkers('src/app.json', changes)).toEqual({
      change: 'modified', unsynced: true, testAssociated: false,
    })
    expect(treeEntryMarkers('src/new.ts', changes).change).toBe('added')
    expect(treeEntryMarkers('src/old.ts', changes).change).toBe('deleted')
  })

  it('不在变更集中的路径无修改标记（未同步为 false）', () => {
    const markers = treeEntryMarkers('README.md', changes)
    expect(markers.change).toBeUndefined()
    expect(markers.unsynced).toBe(false)
  })

  it('测试关联：tests 目录与 *.test.* / *.spec.* 命名', () => {
    expect(treeEntryMarkers('tests/app.spec.ts', []).testAssociated).toBe(true)
    expect(treeEntryMarkers('src/run.test.ts', []).testAssociated).toBe(true)
    expect(treeEntryMarkers('__tests__/a.ts', []).testAssociated).toBe(true)
    expect(treeEntryMarkers('src/app.ts', []).testAssociated).toBe(false)
  })
})

describe('selectPreviewViewer 按内容类型选择查看器', () => {
  it('五类查看器逐类映射', () => {
    expect(selectPreviewViewer('static_html', 'text/html', 'index.html')).toBe('sandbox')
    expect(selectPreviewViewer('image', 'image/png', 'logo.png')).toBe('image')
    expect(selectPreviewViewer('markdown', 'text/markdown', 'README.md')).toBe('markdown')
    expect(selectPreviewViewer('diff', 'text/x-diff', 'changes.diff')).toBe('diff')
    expect(selectPreviewViewer('text', 'text/x-terminal', 'terminal/output.txt')).toBe('terminal')
    expect(selectPreviewViewer('text', 'application/json', 'data.json')).toBe('json')
    expect(selectPreviewViewer('text', 'text/plain', 'notes.txt')).toBe('text')
  })

  it('kind 与 contentType 冲突时以终端特征优先，不误判为普通文本', () => {
    expect(selectPreviewViewer('text', 'text/x-terminal;charset=utf-8', 'any.txt')).toBe('terminal')
  })
})
