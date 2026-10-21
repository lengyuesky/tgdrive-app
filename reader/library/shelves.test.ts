import { describe, expect, it, vi } from 'vitest'
import { ReadingLibrary, SHELVES_KEY } from './index'
import { file, memoryDrive, shelves, signal, sources } from './test-fixtures'

const makeLibrary = (mock: ReturnType<typeof memoryDrive>) => new ReadingLibrary(mock.drive, 'all', {}, undefined, true)

describe('手动书库持久索引与目录隔离', () => {
  it('不读取旧来源索引，无书库时不允许全盘刷新，不影响旧进度和书签', async () => {
    const root = file(1, '/旧目录', true), mock = memoryDrive([root, file(10, '/旧目录/旧书.txt')])
    const legacy = mock.seed('library:sources', sources(root).config)
    const progress = mock.seed('progress:10', { file: file(10, '/旧目录/旧书.txt'), location: { format: 'txt', index: 1 } })
    const bookmark = mock.seed('bookmark:10:a', { title: '保留' })
    const library = makeLibrary(mock)
    expect((await library.initialize()).sources.config.sources).toEqual([])
    expect(mock.get.mock.calls.some(([key]) => key === 'library:sources' || key === 'library:cache:index')).toBe(false)
    await expect(library.refresh()).rejects.toMatchObject({ code: 'no_shelf_selected' })
    expect(mock.list).not.toHaveBeenCalled()
    expect(mock.records.get(legacy.key)).toEqual(legacy); expect(mock.records.get(progress.key)).toEqual(progress); expect(mock.records.get(bookmark.key)).toEqual(bookmark)
    library.destroy()
  })

  it('创建一个书库只扫描其目录，索引保存后重开可直接读取，不重新扫描其他库', async () => {
    const a = file(1, '/甲', true), b = file(2, '/乙', true), mock = memoryDrive([a, b, file(10, '/甲/小说.txt'), file(20, '/乙/漫画.cbz')])
    const library = makeLibrary(mock); await library.initialize()
    const first = await library.addSource('/甲', { name: '小说库' }); await first.scan
    expect(library.snapshot.units.map(unit => unit.nodeId)).toEqual([10])
    const firstLists = mock.list.mock.calls.map(([params]) => params.path)
    expect(firstLists).toEqual(['/甲'])
    expect(mock.records.has('library:cache:shelves:v1:index:source:1')).toBe(true)
    mock.list.mockClear()
    const second = await library.addSource('/乙', { name: '漫画库' }); await second.scan
    expect(mock.list.mock.calls.map(([params]) => params.path)).toEqual(['/乙'])
    expect(library.snapshot.units.map(unit => unit.nodeId)).toEqual([20])
    expect(library.query().items.map(item => item.units[0]!.nodeId)).toEqual([20])
    const firstIndex = mock.records.get('library:cache:shelves:v1:index:source:1')!
    // 模拟真实宿主把 JSON 对象键重排，缓存有效性不能依赖序列化键顺序。
    const value = firstIndex.value as { meta: { roots: { nodeId: number; path: string; contentVersion: string }[] } }
    value.meta.roots = value.meta.roots.map(root => ({ contentVersion: root.contentVersion, nodeId: root.nodeId, path: root.path }))
    library.destroy(); mock.list.mockClear()
    const warm = makeLibrary(mock); await warm.initialize()
    expect(warm.snapshot.units).toEqual([])
    await warm.selectSource(1)
    expect(warm.snapshot.units.map(unit => unit.nodeId)).toEqual([10])
    expect(mock.list).not.toHaveBeenCalled()
    await warm.selectSource(2)
    expect(warm.snapshot.units.map(unit => unit.nodeId)).toEqual([20])
    expect(mock.list).not.toHaveBeenCalled()
    warm.destroy()
  })

  it('书库名或目录重复都拒绝，未知书库配置不覆盖，删除不清除阅读记录', async () => {
    const a = file(1, '/甲', true), b = file(2, '/乙', true), mock = memoryDrive([a, b])
    const library = makeLibrary(mock); await library.initialize()
    const first = await library.addSource('/甲', { name: '书库' }); await first.scan
    await expect(library.addSource('/乙', { name: '书库' })).rejects.toMatchObject({ code: 'duplicate_shelf_name' })
    await expect(library.addSource('/甲', { name: '另一个库' })).rejects.toMatchObject({ code: 'duplicate_source' })
    const progress = mock.seed('progress:10', { kept: true }), bookmark = mock.seed('bookmark:10:a', { kept: true })
    await library.removeSource(1)
    expect(library.snapshot.units).toEqual([])
    expect(mock.records.get(progress.key)).toEqual(progress); expect(mock.records.get(bookmark.key)).toEqual(bookmark)
    library.destroy()
    const bad = mock.seed(SHELVES_KEY, { schemaVersion: 99, sources: [] }), rejected = makeLibrary(mock)
    await expect(rejected.initialize()).rejects.toMatchObject({ code: 'unknown_sources' })
    expect(mock.records.get(SHELVES_KEY)).toEqual(bad)
    rejected.destroy()
  })

  it('明确选中一个书库刷新，不重新扫描另一个目录，重命名不改绑节点', async () => {
    const a = file(1, '/甲', true), b = file(2, '/乙', true), mock = memoryDrive([a, b, file(10, '/甲/小说.txt'), file(20, '/乙/漫画.cbz')])
    mock.seed(SHELVES_KEY, shelves(a, b).config)
    const library = makeLibrary(mock); await library.initialize(); await library.selectSource(1)
    mock.list.mockClear(); await library.refresh()
    expect(mock.list.mock.calls.map(([params]) => params.path)).toEqual(['/甲'])
    await library.renameSource(1, '新的小说库', library.snapshot.sources, signal())
    expect(library.snapshot.sources.config.sources[0]).toMatchObject({ name: '新的小说库', nodeId: 1, path: '/甲' })
    library.destroy()
  })
})
