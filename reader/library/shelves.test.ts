import { testId } from './test-fixtures'
import type { NodeId } from '@tgdrive/page-sdk'
import { describe, expect, it, vi } from 'vitest'
import { ReadingLibrary, SHELVES_KEY } from './index'
import { deferred, file, memoryHost, shelves, signal, sources } from './test-fixtures'

const makeLibrary = (mock: Awaited<ReturnType<typeof memoryHost>>) => new ReadingLibrary(mock.host, 'all', {}, undefined, true)

describe('手动书库持久索引与目录隔离', () => {
  it('图片目录本身作为书库来源，回到书库列表后仍从持久索引恢复此阅读单元', async () => {
    const folder = file(2, '/漫画/第一章', true), mock = await memoryHost([folder, file(21, '/漫画/第一章/01.jpg')])
    const library = new ReadingLibrary(mock.host, 'comics', {}, undefined, true)
    await library.initialize()
    const added = await library.addSource(folder.path, { name: '第一章' }); await added.scan
    expect(library.snapshot.units.map(unit => unit.nodeId)).toEqual([folder.id])
    await library.selectSource(undefined, signal(), false)
    await library.selectSource(folder.id)
    expect(library.snapshot.units.map(unit => unit.nodeId), JSON.stringify(library.snapshot.issues)).toEqual([folder.id])
    expect(library.snapshot.complete).toBe(true); library.destroy()
  })
  it('离开来源尚未返回时重选同一书库，旧请求不能以空索引覆盖最终选择', async () => {
    const root = file(1, '/甲', true), mock = await memoryHost([root, file(10, '/甲/小说.txt')])
    await mock.seed(SHELVES_KEY, shelves(root).config)
    const library = makeLibrary(mock); await library.initialize(); await library.selectSource(root.id)
    const roots = library.access.roots.bind(library.access), started = deferred(), waiting = deferred()
    vi.spyOn(library.access, 'roots').mockImplementationOnce(async (...args) => { const result = await roots(...args); started.resolve(); await waiting.promise; return result })
    const previous = library.selectSource(undefined, signal(), false).catch(error => error)
    await started.promise; expect(library.selectingSource).toBe(true)
    await library.selectSource(root.id)
    waiting.resolve(); expect(await previous).toMatchObject({ code: 'source_changed' })
    expect(library.snapshot.indexedSourceId).toBe(root.id); expect(library.snapshot.units.map(unit => unit.nodeId)).toEqual(['10'])
    library.destroy()
  })

  it('不读取旧来源索引，无书库时不允许全盘刷新，不影响旧进度和书签', async () => {
    const root = file(1, '/旧目录', true), mock = await memoryHost([root, file(10, '/旧目录/旧书.txt')])
    const legacy = await mock.seed('library:sources', sources(root).config)
    const progress = await mock.seed('progress:10', { file: file(10, '/旧目录/旧书.txt'), location: { format: 'txt', index: 1 } })
    const bookmark = await mock.seed('bookmark:10:a', { title: '保留' })
    const library = makeLibrary(mock)
    expect((await library.initialize()).sources.config.sources).toEqual([])
    expect(mock.get.mock.calls.some(([key]) => key === 'library:sources' || key === 'library:cache:index')).toBe(false)
    await expect(library.refresh()).rejects.toMatchObject({ code: 'no_shelf_selected' })
    expect(mock.list).not.toHaveBeenCalled()
    expect(mock.records.get(legacy.key)).toEqual(legacy); expect(mock.records.get(progress.key)).toEqual(progress); expect(mock.records.get(bookmark.key)).toEqual(bookmark)
    library.destroy()
  })

  it('创建一个书库只扫描其目录，索引保存后重开可直接读取，不重新扫描其他库', async () => {
    const a = file(1, '/甲', true), b = file(2, '/乙', true), mock = await memoryHost([a, b, file(10, '/甲/小说.txt'), file(20, '/乙/漫画.cbz')])
    const library = makeLibrary(mock); await library.initialize()
    const first = await library.addSource('/甲', { name: '小说库' }); await first.scan
    expect(library.snapshot.units.map(unit => unit.nodeId)).toEqual([testId(10)])
    const firstLists = mock.query.mock.calls.map(([params]) => params.roots)
    expect(firstLists).toEqual([[a.id]])
    expect(mock.records.has('library:cache:shelves:v1:index:source:1000000000000000001')).toBe(true)
    mock.query.mockClear(); mock.list.mockClear()
    const second = await library.addSource('/乙', { name: '漫画库' }); await second.scan
    expect(mock.query.mock.calls.map(([params]) => params.roots)).toEqual([[b.id]])
    expect(library.snapshot.units.map(unit => unit.nodeId)).toEqual([testId(20)])
    expect(library.query().items.map(item => item.units[0]!.nodeId)).toEqual([testId(20)])
    const firstIndex = mock.records.get('library:cache:shelves:v1:index:source:' + a.id)!
    // 模拟真实宿主把 JSON 对象键重排，缓存有效性不能依赖序列化键顺序。
    const value = firstIndex.value as { meta: { roots: { nodeId: NodeId; path: string; contentVersion: string }[] } }
    value.meta.roots = value.meta.roots.map(root => ({ contentVersion: root.contentVersion, nodeId: root.nodeId, path: root.path }))
    await mock.seed(firstIndex.key, value)
    library.destroy(); mock.query.mockClear(); mock.list.mockClear()
    const warm = makeLibrary(mock); await warm.initialize()
    expect(warm.snapshot.units).toEqual([])
    await warm.selectSource(testId(1))
    expect(warm.snapshot.units.map(unit => unit.nodeId)).toEqual([testId(10)])
    expect(mock.list).not.toHaveBeenCalled()
    await warm.selectSource(testId(2))
    expect(warm.snapshot.units.map(unit => unit.nodeId)).toEqual([testId(20)])
    expect(mock.list).not.toHaveBeenCalled()
    warm.destroy()
  })

  it('书库名或目录重复都拒绝，未知书库配置不覆盖，删除不清除阅读记录', async () => {
    const a = file(1, '/甲', true), b = file(2, '/乙', true), mock = await memoryHost([a, b])
    const library = makeLibrary(mock); await library.initialize()
    const first = await library.addSource('/甲', { name: '书库' }); await first.scan
    await expect(library.addSource('/乙', { name: '书库' })).rejects.toMatchObject({ code: 'duplicate_shelf_name' })
    await expect(library.addSource('/甲', { name: '另一个库' })).rejects.toMatchObject({ code: 'duplicate_source' })
    const progress = await mock.seed('progress:10', { kept: true }), bookmark = await mock.seed('bookmark:10:a', { kept: true })
    await library.removeSource(testId(1))
    expect(library.snapshot.units).toEqual([])
    expect(mock.records.get(progress.key)).toEqual(progress); expect(mock.records.get(bookmark.key)).toEqual(bookmark)
    library.destroy()
    const bad = await mock.seed(SHELVES_KEY, { schemaVersion: 99, sources: [] }), rejected = makeLibrary(mock)
    await expect(rejected.initialize()).rejects.toMatchObject({ code: 'unknown_sources' })
    expect(mock.records.get(SHELVES_KEY)).toEqual(bad)
    rejected.destroy()
  })

  it('明确选中一个书库刷新，不重新扫描另一个目录，重命名不改绑节点', async () => {
    const a = file(1, '/甲', true), b = file(2, '/乙', true), mock = await memoryHost([a, b, file(10, '/甲/小说.txt'), file(20, '/乙/漫画.cbz')])
    await mock.seed(SHELVES_KEY, shelves(a, b).config)
    const library = makeLibrary(mock); await library.initialize(); await library.selectSource(testId(1))
    mock.query.mockClear(); mock.list.mockClear(); await library.refresh()
    expect(mock.query.mock.calls.map(([params]) => params.roots)).toEqual([[a.id]])
    await library.renameSource(testId(1), '新的小说库', library.snapshot.sources, signal())
    expect(library.snapshot.sources.config.sources[0]).toMatchObject({ name: '新的小说库', nodeId: testId(1), path: '/甲' })
    library.destroy()
  })
})
