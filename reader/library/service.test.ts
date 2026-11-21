import { testId } from './test-fixtures'
import { describe, expect, it, vi } from 'vitest'
import { ReadingLibrary, bindLibraryLifecycle, isLibraryAbort } from './index'
import { editWorkMetadata, nextWorkUnit, splitWork } from './grouping'
import { png, zip } from '../../tests/fixtures/reader-files.mjs'
import { SOURCES_KEY } from './sources'
import { deferred, file, memoryHost, signal, sources } from './test-fixtures'

async function configured() {
  const root = file(1, '/书', true), book = file(2, '/书/一本.txt'), mock = await memoryHost([root, book])
  await mock.seed(SOURCES_KEY, sources(root).config)
  return { ...mock, root, book }
}
describe('ReadingLibrary 集中服务的真实 SDK 行为', () => {
  it('新平台不迁移旧封面键，不清除未知数据，也不调用旧批量 RPC', async () => {
    const mock = await memoryHost()
    const old = await mock.seed('cover:7', { version: 'v1' }), progress = await mock.seed('progress:2', { page: 1 })
    const library = new ReadingLibrary(mock.host, 'books')
    await library.initialize()
    expect(mock.records.get(old.key)).toEqual(old); expect(mock.records.get(progress.key)).toEqual(progress)
    expect(mock.set).not.toHaveBeenCalled(); expect(mock.remove).not.toHaveBeenCalled(); expect(mock.query).not.toHaveBeenCalled()
    expect('batch' in mock.host).toBe(false); library.destroy()
  })
  it('无来源初始化零枚举，添加立即扫描；移除不删记录，再纳入恢复稳定作品 ID', async () => {
    const root = file(1, '/书', true), book = file(2, '/书/一本.txt'), mock = await memoryHost([root, book]), changed = vi.fn(), library = new ReadingLibrary(mock.host, 'books', { changed })
    expect((await library.initialize()).units).toEqual([])
    expect(mock.list).not.toHaveBeenCalled(); expect(mock.readRange).not.toHaveBeenCalled()
    const added = await library.addSource('/书'); expect((await added.scan).complete).toBe(true)
    const before = library.snapshot
    expect(before.units.map(unit => unit.nodeId)).toEqual([testId(2)]); expect(before.works.rows).toHaveLength(1)
    const progress = await mock.seed('progress:2', { file: book, title: '书名', location: { format: 'txt', index: 2 } })
    const bookmark = await mock.seed('bookmark:2:a', { location: { format: 'txt', index: 1 } })
    await library.removeSource(testId(1))
    expect(library.snapshot.units).toEqual([])
    expect(mock.records.get(progress.key)).toEqual(progress); expect(mock.records.get(bookmark.key)).toEqual(bookmark)
    const back = await library.addSource('/书'); await back.scan
    expect(library.snapshot.works.rows[0]!.id).toBe(before.works.rows[0]!.id)
    expect(mock.remove.mock.calls.every(([key]) => key.startsWith('library:cache:'))).toBe(true); expect(changed).toHaveBeenCalled()
    library.destroy()
  })
  it('启动缓存优先不扫描；目录版本变化不宣称全库，新单元只在刷新发现', async () => {
    const mock = await configured(), first = new ReadingLibrary(mock.host, 'books')
    await first.initialize(); await first.refresh(); first.destroy(); mock.list.mockClear()
    const warm = new ReadingLibrary(mock.host, 'books'), cached = await warm.initialize()
    expect(cached).toMatchObject({ fromCache: true, complete: true })
    expect(cached.units).toHaveLength(1); expect(mock.list).not.toHaveBeenCalled()
    warm.destroy()
    mock.nodes.set(1, { ...mock.root, content_version: 'v2' }); mock.nodes.set(3, file(3, '/书/新增.epub'))
    const changed = new ReadingLibrary(mock.host, 'books')
    expect((await changed.initialize()).fromCache).toBe(true)
    expect(changed.snapshot.units).toHaveLength(1); expect(mock.list).not.toHaveBeenCalled()
    await changed.synchronize(); expect(changed.snapshot.units).toHaveLength(2)
    expect(changed.snapshot.complete).toBe(true); changed.destroy()
  })
  it('清除可回收索引仍恢复首次加入时间和人工修正，原文件从未改动', async () => {
    const mock = await configured(), now = vi.spyOn(Date, 'now').mockReturnValue(100), first = new ReadingLibrary(mock.host, 'books')
    await first.initialize(); await first.refresh()
    const snapshot = first.snapshot, work = snapshot.works.rows[0]!
    await first.publishWorks({ ...snapshot.works, rows: editWorkMetadata(snapshot.works.rows, work.id, { title: '人工书名', authors: ['作者'], description: '简介' }) })
    const original = structuredClone(mock.nodes.get(2))
    first.destroy()
    for (const key of mock.records.keys()) if (key.startsWith('library:cache:')) mock.records.delete(key)
    now.mockReturnValue(9000)
    const second = new ReadingLibrary(mock.host, 'books'); await second.initialize(); await second.refresh()
    expect(second.snapshot.units[0]!.firstIndexedAt).toBe(100)
    expect(second.query({ view: 'files' }).items[0]!.firstIndexedAt).toBe(100)
    expect(second.query().items[0]!).toMatchObject({ metadata: { title: '人工书名', authors: ['作者'], description: '简介' }, work: { id: work.id } })
    expect(mock.nodes.get(2)).toEqual(original); second.destroy()
  })
  it('旧扫描即使忽略取消晚返回，也不能覆盖已切换来源的新索引', async () => {
    const mock = await configured(), other = file(3, '/别处', true), second = file(4, '/别处/新书.txt')
    mock.nodes.set(3, other); mock.nodes.set(4, second)
    const library = new ReadingLibrary(mock.host, 'books'); await library.initialize()
    const waiting = deferred(), started = deferred(), query = mock.query.getMockImplementation()!
    mock.query.mockImplementationOnce(async (params, options) => { const page = await query(params, options); started.resolve(); await waiting.promise; return page })
    const stale = library.refresh().catch(error => error)
    await started.promise; await library.removeSource(testId(1))
    const added = await library.addSource('/别处'); await added.scan
    const current = library.snapshot
    waiting.resolve(); expect(isLibraryAbort(await stale)).toBe(true)
    expect(library.snapshot).toEqual(current)
    expect(library.snapshot.units.map(unit => unit.nodeId)).toEqual([testId(4)])
    const next = new ReadingLibrary(mock.host, 'books'); expect((await next.initialize()).units.map(unit => unit.nodeId)).toEqual([testId(4)])
    library.destroy(); next.destroy()
  })
  it('源配置失败不允许写空配置；完整扫描末尾来源失效不清除旧索引', async () => {
    const mock = await configured(), failed = new ReadingLibrary(mock.host, 'books')
    mock.get.mockRejectedValueOnce(new Error('来源读取失败'))
    await expect(failed.initialize()).rejects.toThrow('来源读取失败')
    await expect(failed.addSource('/书')).rejects.toMatchObject({ code: 'not_initialized' })
    expect(mock.set).not.toHaveBeenCalled(); expect(mock.list).not.toHaveBeenCalled(); failed.destroy()
    const library = new ReadingLibrary(mock.host, 'books'); await library.initialize(); await library.refresh()
    mock.nodes.delete(2)
    const original = mock.query.getMockImplementation()!
    mock.query.mockImplementationOnce(async (params, options) => {
      const page = await original(params, options)
      // 文件页返回后移动来源，增量游标与源身份必须使扫描不完整。
      queueMicrotask(() => mock.nodes.set(1, file(mock.root.id, '/移动后', true)))
      return page
    })
    const scan = await library.refresh()
    expect(scan.complete).toBe(false)
    expect(library.snapshot.units.map(unit => unit.nodeId)).toContain(testId(2))
    library.destroy()
  })
  it('读取摘要/标志有批量接口，名称作者/格式来源/状态筛选与加入最近读排序可直接调用', async () => {
    const mock = await configured(); mock.nodes.set(3, file(3, '/书/二.pdf'))
    const library = new ReadingLibrary(mock.host, 'books'); await library.initialize(); await library.refresh()
    const before = library.snapshot, work = before.works.rows.find(work => work.members[0]!.unitId === testId(2))!
    await library.publishWorks({ ...before.works, rows: editWorkMetadata(before.works.rows, work.id, { title: '星河', authors: ['测试作者'] }) })
    await mock.seed('progress:2', { file: mock.book, title: '星河', location: { format: 'txt', index: 2 } }, 800)
    await mock.seed('progress:3', { file: mock.nodes.get(3)!, title: '二', location: { format: 'pdf', index: 0 } }, 900)
    await mock.seed('library:reading:2', { schemaVersion: 1, contentVersion: mock.book.content_version, status: 'read' })
    await mock.seed(`library:flags:${work.id}`, { schemaVersion: 1, favorite: true, wantToRead: true })
    mock.stat.mockClear()
    const state = await library.loadReadingState()
    expect(mock.stat).not.toHaveBeenCalled()
    expect(library.query({ query: '作者', sourceId: testId(1), format: 'txt', status: 'read', favorite: true }, state.readings, state.flags).items[0]!.metadata.title).toBe('星河')
    expect(library.query({ sort: 'recent' }, state.readings, state.flags).items.map(item => item.units[0]!.nodeId)).toEqual([testId(3), testId(2)])
    library.invalidateReadingState()
    mock.storageList.mockRejectedValueOnce(new Error('状态读取失败'))
    await expect(library.loadReadingState()).rejects.toThrow('状态读取失败')
    expect(state.readings.get(testId(2))!.status).toBe('read'); library.destroy()
  })
  it('先扫描 001/002 再按需读 ComicInfo 自动归组，别名标志不丢失；手工拆分不被重新合并', async () => {
    const root = file(1, '/漫画', true), mock = await memoryHost([root])
    await mock.seed(SOURCES_KEY, sources(root).config)
    const books = await Promise.all([2, 3].map(async (id, index) => await mock.binary(file(id, `/漫画/00${index + 1}.zip`), zip([
      ['ComicInfo.xml', `<ComicInfo><Series>同一系列</Series><Number>${index + 1}</Number></ComicInfo>`], ['1.png', png(12, 20, [10, 20, 30])],
    ]))))
    const library = new ReadingLibrary(mock.host, 'comics'); await library.initialize(); await library.refresh()
    const initial = library.snapshot.works.rows
    expect(initial).toHaveLength(2); expect(initial.every(work => work.grouping === 'single' && !work.orderConfirmed)).toBe(true)
    const primaryId = initial[0]!.id, aliasId = initial[1]!.id
    const flags = await mock.seed(`library:flags:${aliasId}`, { schemaVersion: 1, wantToRead: true, favorite: true })
    const progress = await mock.seed('progress:2', { file: books[0], title: '001', location: { format: 'comic', index: 0, ratio: 0.5 } })
    const bookmark = await mock.seed('bookmark:2:a', { title: '旧书签', content_version: 'v1', location: { format: 'comic', index: 0 } })
    await Promise.all(library.snapshot.units.map(unit => library.getMetadata(unit)))
    const merged = library.snapshot.works, active = merged.rows.filter(work => !work.redirectTo)
    expect(active).toHaveLength(1)
    expect(active[0]).toMatchObject({ id: primaryId, grouping: 'automatic', orderConfirmed: true, seriesKey: '同一系列' })
    expect(active[0]!.members.map(member => member.unitId)).toEqual([testId(2), testId(3)])
    expect(merged.rows.find(work => work.id === aliasId)).toMatchObject({ members: [], redirectTo: primaryId })
    let state = await library.loadReadingState()
    expect(library.query({}, state.readings, state.flags).items[0]!.flags).toMatchObject({ favorite: true, wantToRead: true })
    expect(mock.records.get(flags.key)).toEqual(flags)
    await library.publishWorks({ ...merged, rows: splitWork(merged.rows, primaryId, [[3], [2]].map(group => group.map(testId))) })
    await Promise.all(library.snapshot.units.map(unit => library.getMetadata(unit))); await library.refresh()
    const split = library.snapshot.works.rows.filter(work => !work.redirectTo), primary = split.find(work => work.id === primaryId)!, fresh = split.find(work => work.id !== primaryId)!
    expect(split).toHaveLength(2); expect(split.every(work => work.grouping === 'manual')).toBe(true)
    expect(primary.members.map(member => member.unitId)).toEqual([testId(3)]); expect(fresh.id).not.toBe(aliasId)
    state = await library.loadReadingState()
    const items = library.query({}, state.readings, state.flags).items
    expect(items.find(item => item.id === primaryId)!.flags).toMatchObject({ favorite: true, wantToRead: true })
    expect(items.find(item => item.id === fresh.id)!.flags).toMatchObject({ favorite: false, wantToRead: false })
    expect(state.readings.get(testId(2))!.status).toBe('reading')
    await library.reading.setWorkFlags(primary, library.snapshot.works.rows, state.flagSnapshots, { favorite: false, wantToRead: false }, signal())
    await library.refresh(); state = await library.loadReadingState()
    expect(library.query({}, state.readings, state.flags).items.every(item => !item.flags.favorite && !item.flags.wantToRead)).toBe(true)
    expect(mock.records.get('progress:2')).toEqual(progress); expect(mock.records.get('bookmark:2:a')).toEqual(bookmark)
    expect(mock.records.has(flags.key)).toBe(true)
    library.destroy()
  })
  it('详情按需读到冲突内嵌信息后立即更新顺序置信状态，作品 ID 和旧人工记录保持', async () => {
    const root = file(1, '/漫画', true), mock = await memoryHost([root])
    await mock.seed(SOURCES_KEY, sources(root).config)
    const first = await mock.binary(file(2, '/漫画/星河 第1卷.cbz'), zip([['ComicInfo.xml', '<ComicInfo><Series>另一系列</Series><Volume>1</Volume></ComicInfo>'], ['1.png', png(12, 20, [1, 2, 3])]]))
    await mock.binary(file(3, '/漫画/星河 第2卷.cbz'), zip([['1.png', png(12, 20, [1, 2, 3])]]))
    const library = new ReadingLibrary(mock.host, 'comics'); await library.initialize(); await library.refresh()
    const old = library.snapshot.works.rows[0]!
    expect(nextWorkUnit(old, testId(2))).toBe(testId(3)); expect(mock.readRange).not.toHaveBeenCalled()
    await library.getMetadata(library.snapshot.units.find(unit => unit.nodeId === first.id)!)
    expect(library.snapshot.works.rows[0]!.id).toBe(old.id)
    expect(nextWorkUnit(library.snapshot.works.rows[0]!, testId(2))).toBeUndefined()
    library.destroy()
    const next = new ReadingLibrary(mock.host, 'comics'); await next.initialize()
    expect(nextWorkUnit(next.snapshot.works.rows[0]!, testId(2))).toBeUndefined(); next.destroy()
  })
  it('缓存配额失败仅会话降级；人工快照失败抛出可重试草稿，不篡改旧人工数据', async () => {
    const mock = await configured(), library = new ReadingLibrary(mock.host, 'books')
    await library.initialize(); await library.refresh()
    const original = mock.set.getMockImplementation()!
    mock.set.mockImplementation(async (key, request, options) => { if (key.startsWith('library:cache:index')) throw new Error('配额不足'); return original(key, request, options) })
    await library.refresh()
    expect(library.snapshot.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'index_session_only' })]))
    const before = library.snapshot.works, draft = { ...before, rows: editWorkMetadata(before.rows, before.rows[0]!.id, { title: '草稿' }) }
    mock.set.mockRejectedValueOnce(new Error('保存失败'))
    await expect(library.publishWorks(draft)).rejects.toMatchObject({ code: 'snapshot_not_published', draft })
    expect(library.snapshot.works).toEqual(before)
    library.destroy()
  })
  it('隐藏或进入阅读可暂停扫描/封面，恢复后继续，pagehide 销毁生命周期', async () => {
    const mock = await configured(), library = new ReadingLibrary(mock.host, 'books'); await library.initialize()
    const unbind = bindLibraryLifecycle(library), pending = library.refresh()
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true); document.dispatchEvent(new Event('visibilitychange'))
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(library.snapshot.progress?.phase).toBe('paused'); expect(mock.list).not.toHaveBeenCalled()
    await expect(library.covers.get({ nodeId: testId(2), file: mock.book, format: 'txt', sourceIds: [1].map(testId), firstIndexedAt: 1 }, signal())).rejects.toMatchObject({ code: 'library_paused' })
    library.resume(); await pending
    window.dispatchEvent(new Event('pagehide'))
    await expect(library.openUnit(testId(2))).rejects.toMatchObject({ name: 'AbortError' })
    unbind()
  })
})
