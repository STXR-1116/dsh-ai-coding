/* 覆盖补齐：`treeEntryMarkers` 对服务端词表之外变更值的处理。
 *
 * 变更集来自服务端；出现词表外的 `change` 时该函数**刻意**给出 `undefined`
 * （不猜一个近似值），但仍把该路径标为未同步——因为「有变更但类型未知」与
 * 「没有变更」必须区分。此前只有三种已知取值被走到。
 */
import { describe, expect, it } from 'vitest'
import { treeEntryMarkers } from '../src/client/cloud-workspaces/workspace-markers.ts'

describe('treeEntryMarkers', () => {
  it('reports the change kinds the server vocabulary defines', () => {
    expect(treeEntryMarkers('src/a.ts', [{ path: 'src/a.ts', change: 'modified' }]).change).toBe('modified')
    expect(treeEntryMarkers('src/a.ts', [{ path: 'src/a.ts', change: 'added' }]).change).toBe('added')
    expect(treeEntryMarkers('src/a.ts', [{ path: 'src/a.ts', change: 'deleted' }]).change).toBe('deleted')
  })

  it('keeps an out-of-vocabulary change unsynced without inventing a kind', () => {
    const markers = treeEntryMarkers('src/a.ts', [{ path: 'src/a.ts', change: 'renamed' }])
    expect(markers.change).toBeUndefined()
    expect(markers.unsynced).toBe(true)
  })

  it('leaves a path outside the change set unmarked', () => {
    const markers = treeEntryMarkers('src/a.ts', [{ path: 'src/b.ts', change: 'modified' }])
    expect(markers.change).toBeUndefined()
    expect(markers.unsynced).toBe(false)
  })
})
