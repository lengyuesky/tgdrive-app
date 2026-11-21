import { describe, expect, it, vi } from 'vitest'
import { LibraryAccess } from './sources'
import { LibraryScanner } from './scanner'
import { reconcileUnits } from './reconcile'
import { ReadingLibrary } from './service'
import { file, memoryHost, signal, sources } from './test-fixtures'
import type { LibraryScope } from './model'

async function baseline(entries: ReturnType<typeof file>[], kind: LibraryScope = 'books') {
  const root = file(1, '/书', true), mock = await memoryHost([root, ...entries]), access = new LibraryAccess(mock.host)
  access.setSources(sources(root))
  const scan = await new LibraryScanner(access, kind).start().result
  expect(scan.complete).toBe(true)
  return { ...mock, root, access, scan, apply: async (cursor = scan.changeCursor!, units = scan.unitsFound) => reconcileUnits(access, await access.roots(signal()), kind, units, cursor, signal()) }
}

describe('持久变更游标的增量核对', () => {
  it('图片移动核对旧目录，图片改成其他后缀后不保留空章节，不遍历文件树', async () => {
    const left = file(2, '/书/左', true), right = file(3, '/书/右', true)
    const x = await baseline([left, right, file(4, '/书/左/01.png')], 'comics')
    expect(x.scan.unitsFound.map(unit => unit.nodeId)).toEqual([left.id])
    await x.host.changeNode({ id: '4', parent: right.id })
    const moved = await x.apply()
    expect(moved.units.map(unit => unit.nodeId)).toEqual([right.id])
    await x.host.changeNode({ id: '4', name: '不是图片.bin' })
    expect((await x.apply(moved.cursor, moved.units)).units).toEqual([])
    expect(x.directoriesWithFiles).toHaveBeenCalled(); expect(x.list).not.toHaveBeenCalled(); expect(x.readRange).not.toHaveBeenCalled()
  })
  it('新增、覆盖、后缀改变、回收与隐藏节点按当前格式重核，保留首次索引时间', async () => {
    const x = await baseline([file(2, '/书/原.txt'), file(3, '/书/文档.pdf')])
    const time = x.scan.unitsFound.find(unit => unit.nodeId === '2')!.firstIndexedAt
    await x.host.changeNode({ id: '2', bytes: [8, 9], name: '更新.epub' })
    await x.host.changeNode({ id: '3', visible: false })
    await x.host.addNode({ id: '500', parent_id: x.root.id, name: '新书.txt', kind: 'file', bytes: [] })
    await x.host.addNode({ id: '501', parent_id: x.root.id, name: '.隐藏.txt', kind: 'file', bytes: [] })
    const updated = await x.apply()
    expect(updated.units.map(unit => unit.nodeId).sort()).toEqual(['2', '500'])
    expect(updated.units.find(unit => unit.nodeId === '2')).toMatchObject({ firstIndexedAt: time, format: 'epub', file: { size: '2', name: '更新.epub' } })
    await x.host.changeNode({ id: '2', name: '不再支持.bin' })
    expect((await x.apply(updated.cursor, updated.units)).units.map(unit => unit.nodeId)).toEqual(['500'])
  })
  it('子树移动只重查该子树，更新派生路径；回收子树不会删除兄弟书籍', async () => {
    const folder = file(2, '/书/旧目录', true), x = await baseline([folder, file(3, '/书/旧目录/章节.txt'), file(4, '/书/兄弟.txt')])
    x.query.mockClear()
    await x.host.changeNode({ id: folder.id, name: '新目录' })
    const moved = await x.apply()
    expect(moved.units.find(unit => unit.nodeId === '3')?.file.path).toBe('/书/新目录/章节.txt')
    expect(x.query.mock.calls.every(([request]) => request.roots.length === 1 && request.roots[0] === folder.id)).toBe(true)
    await x.host.changeNode({ id: folder.id, visible: false })
    expect((await x.apply(moved.cursor, moved.units)).units.map(unit => unit.nodeId)).toEqual(['4'])
    expect(x.list).not.toHaveBeenCalled()
  })
  it('只有未授权变更的空页仍按 has_more 继续，直到本轮高水位', async () => {
    const root = file(1, '/书', true), other = file(9, '/其他', true), x = await memoryHost([root, other, file(2, '/书/原.txt')])
    await x.host.setScope({ mode: 'selected', directories: [{ directory_id: root.id, access: 'read_only' }] })
    const access = new LibraryAccess(x.host); access.setSources(sources(root))
    const scan = await new LibraryScanner(access, 'books').start().result
    for (let index = 0; index < 240; index++) await x.host.addNode({ id: String(index + 1000), parent_id: other.id, name: `范围外${index}.txt`, kind: 'file', bytes: [] })
    const skipped = await x.host.changes({ cursor: scan.changeCursor, limit: 200 })
    expect(skipped.changes).toEqual([])
    await x.host.addNode({ id: '9999', parent_id: root.id, name: '范围内新增.txt', kind: 'file', bytes: [] })
    // 内存替身可在一页越过全部未授权日志；注入合法的提前检查点空页，续页仍用真实 Rust 游标。
    x.changes.mockResolvedValueOnce({ ...skipped, has_more: true })
    const result = await reconcileUnits(access, await access.roots(signal()), 'books', scan.unitsFound, scan.changeCursor!, signal())
    expect(result.units.map(unit => unit.nodeId).sort()).toEqual(['2', '9999'])
    expect(x.changes.mock.calls.at(-1)![0].cursor).toBe(skipped.next_cursor); expect(result.cursor).not.toBe(scan.changeCursor)
  })
  it('变更游标过期完整核对，撤权清除可见派生列表但保留阅读记录', async () => {
    const root = file(1, '/书', true), x = await memoryHost([root, file(2, '/书/原.txt')])
    await x.seed('library:sources', sources(root).config)
    const library = new ReadingLibrary(x.host, 'books'); await library.initialize(); await library.refresh()
    const before = x.query.mock.calls.length
    x.changes.mockRejectedValueOnce(Object.assign(new Error('变更日志过期'), { code: 'cursor_expired' }))
    await library.synchronize()
    expect(x.query.mock.calls.length).toBeGreaterThan(before); expect(library.snapshot.complete).toBe(true)
    const progress = await x.seed('progress:2', { retained: true })
    await x.host.setScope({ mode: 'none' })
    await library.synchronize()
    expect(library.snapshot.units).toEqual([]); expect(library.snapshot.complete).toBe(false)
    expect(x.records.get(progress.key)).toEqual(progress); library.destroy()
  })
})
