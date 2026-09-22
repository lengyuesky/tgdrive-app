import { describe, expect, it, vi } from 'vitest'
import { LibraryAccess, SOURCES_KEY, SourcesStore, filesChangeAffectsSources, parseSources } from './sources'
import { deferred, file, memoryDrive, signal, sources } from './test-fixtures'

describe('SourcesStore 来源与旧值迁移', () => {
  it('没有来源不枚举，配置读取失败或未知版本绝不回退根目录或覆盖旧记录', async () => {
    const mock = memoryDrive([file(0, '/', true)])
    const store = new SourcesStore(mock.drive), access = new LibraryAccess(mock.drive)
    const empty = await store.migrate(signal()); access.setSources(empty.snapshot)
    expect(empty.migration).toBe('none')
    expect(await access.roots(signal())).toEqual({ roots: [], unavailable: [] })
    await expect(access.file(5, signal())).rejects.toMatchObject({ code: 'no_sources' })
    expect(mock.list).not.toHaveBeenCalled(); expect(mock.searchPage).not.toHaveBeenCalled(); expect(mock.stat).not.toHaveBeenCalled()
    mock.get.mockRejectedValueOnce(new Error('读取失败'))
    await expect(store.migrate(signal())).rejects.toThrow('读取失败')
    const old = mock.seed(SOURCES_KEY, { schemaVersion: 42, sources: ['/'] })
    await expect(store.migrate(signal())).rejects.toMatchObject({ code: 'unknown_sources' })
    expect(mock.records.get(SOURCES_KEY)).toEqual(old); expect(mock.set).not.toHaveBeenCalled()
  })
  it('非根旧目录校验两次后 CAS 迁移，旧设置保持；根目录必须二次确认', async () => {
    const directory = file(1, '/旧书库', true)
    const mock = memoryDrive([directory], { source_dir: '/旧书库' }), store = new SourcesStore(mock.drive)
    const migration = await store.migrate(signal())
    expect(migration.migration).toBe('migrated')
    expect(migration.snapshot.config.sources).toEqual([expect.objectContaining({ nodeId: 1, path: '/旧书库', contentVersion: 'v1' })])
    expect(mock.stat.mock.calls.map(call => call[0])).toEqual([{ path: '/旧书库' }, { id: 1 }])
    expect(mock.set.mock.calls[0]?.[2]).toBeNull()
    expect(mock.drive.settings.patch).not.toHaveBeenCalled()
    expect((await store.migrate(signal())).migration).toBe('existing')
    const root = memoryDrive([file(0, '/', true)], { source_dir: '/' }), rootStore = new SourcesStore(root.drive)
    expect((await rootStore.migrate(signal())).migration).toBe('confirm-root')
    expect(root.stat).not.toHaveBeenCalled(); expect(root.set).not.toHaveBeenCalled()
    await expect(rootStore.add((await rootStore.load()), '/', false, signal())).rejects.toMatchObject({ code: 'confirm_root' })
    expect((await rootStore.migrate(signal(), true)).snapshot.config.sources[0]).toMatchObject({ nodeId: 0, rootConfirmed: true })
  })
  it('旧目录删除或选择过程中重建不会误绑定，同 ID 拒绝，父子允许，最多 16 个', async () => {
    const mock = memoryDrive([], { source_dir: '/旧书库' }), store = new SourcesStore(mock.drive)
    await expect(store.migrate(signal())).rejects.toMatchObject({ code: 'not_found' })
    expect(mock.set).not.toHaveBeenCalled()
    const parent = file(1, '/书', true), child = file(2, '/书/子目录', true)
    mock.nodes.set(1, parent); mock.nodes.set(2, child)
    const first = await store.add(await store.load(), parent.path, false, signal())
    await expect(store.add(first, parent.path, false, signal())).rejects.toMatchObject({ code: 'duplicate_source' })
    const nested = await store.add(first, child.path, false, signal())
    expect(nested.config.sources.map(source => source.nodeId)).toEqual([1, 2])
    const max = sources(...Array.from({ length: 16 }, (_, index) => file(index + 10, `/库${index}`, true)))
    await expect(store.add(max, child.path, false, signal())).rejects.toMatchObject({ code: 'source_limit' })
    expect(() => parseSources({ schemaVersion: 1, sources: [...max.config.sources, nested.config.sources[0]] })).toThrow('16')
    const replace = mock.stat.getMockImplementation()!
    mock.stat.mockImplementationOnce(async (ref, options) => {
      const selected = await replace(ref, options)
      mock.nodes.delete(selected.id); mock.nodes.set(99, file(99, child.path, true))
      return selected
    })
    await expect(store.add({ config: { schemaVersion: 1, sources: [] }, revision: nested.revision }, child.path, false, signal())).rejects.toMatchObject({ code: 'not_found' })
  })
  it('并发配置不重试覆盖，移除来源不删除历史、书签和人工记录', async () => {
    const mock = memoryDrive([file(1, '/一', true), file(2, '/二', true)]), store = new SourcesStore(mock.drive)
    const base = await store.load(), draft = structuredClone(base)
    const saved = await store.add(base, '/一', false, signal())
    await expect(store.add(draft, '/二', false, signal())).rejects.toMatchObject({ code: 'storage_conflict' })
    expect(draft).toEqual(base)
    mock.seed('progress:8', { old: true }); mock.seed('bookmark:8:a', { old: true }); mock.seed('library:works', { old: true })
    await store.remove(saved, 1, signal())
    expect(mock.remove).not.toHaveBeenCalled()
    expect([...mock.records.keys()]).toEqual(expect.arrayContaining(['progress:8', 'bookmark:8:a', 'library:works']))
  })
})

describe('LibraryAccess 稳定节点及异步范围核对', () => {
  it('目录移动继续按 ID 访问，删除后同路径重建不误绑定', async () => {
    const root = file(1, '/书', true), book = file(2, '/书/正文.txt')
    const mock = memoryDrive([root, book]), access = new LibraryAccess(mock.drive)
    access.setSources(sources(root))
    mock.nodes.set(1, file(1, '/移动后', true, 'v2')); mock.nodes.set(2, file(2, '/移动后/正文.txt'))
    expect((await access.file(2, signal())).file.path).toBe('/移动后/正文.txt')
    mock.nodes.delete(1); mock.nodes.set(9, root)
    await expect(access.file(2, signal())).rejects.toMatchObject({ code: 'source_unavailable' })
    expect(mock.stat.mock.calls.every(([ref]) => 'id' in ref)).toBe(true)
  })
  it('旧节点离开范围或版本变更不能打开，分页查找始终指定来源及 200 限制', async () => {
    const root = file(1, '/书', true), book = file(2, '/书/正文.txt'), other = file(3, '/书外/秘密.txt')
    const mock = memoryDrive([root, book, other]), access = new LibraryAccess(mock.drive)
    access.setSources(sources(root))
    await expect(access.file(3, signal())).rejects.toMatchObject({ code: 'outside_sources' })
    await expect(access.file(2, signal(), 'old')).rejects.toMatchObject({ code: 'file_changed' })
    expect((await access.list(1, '20', signal())).entries).toEqual([])
    expect(mock.list).toHaveBeenLastCalledWith({ path: '/书', cursor: '20', limit: 200 }, expect.anything())
    await access.search(1, { q: '正文', cursor: '200', extensions: ['txt'] }, signal())
    expect(mock.searchPage).toHaveBeenLastCalledWith({ under: '/书', q: '正文', cursor: '200', extensions: ['txt'], limit: 200 }, expect.anything())
    await expect(access.search(999, {}, signal())).rejects.toMatchObject({ code: 'source_removed' })
  })
  it('SDK 返回越界节点必须报错，不把过滤后的空页冒充一次成功全扫描', async () => {
    const root = file(1, '/书', true), outside = file(2, '/别处/秘密.txt'), mock = memoryDrive([root, outside]), access = new LibraryAccess(mock.drive)
    access.setSources(sources(root))
    mock.list.mockResolvedValueOnce({ path: root.path, entries: [outside], has_more: false, next_cursor: null })
    await expect(access.list(1, null, signal())).rejects.toMatchObject({ code: 'invalid_page' })
    mock.searchPage.mockResolvedValueOnce({ results: [outside], has_more: false, next_cursor: null })
    await expect(access.search(1, {}, signal())).rejects.toMatchObject({ code: 'invalid_page' })
  })
  it('慢 stat 返回时再次核对来源：切来源、目录移动及文件移动均失效', async () => {
    const root = file(1, '/书', true), book = file(2, '/书/正文.txt'), other = file(3, '/别处', true)
    const mock = memoryDrive([root, book, other]), access = new LibraryAccess(mock.drive)
    access.setSources(sources(root))
    const original = mock.stat.getMockImplementation()!, waiting = deferred(), entered = deferred()
    mock.stat.mockImplementation(async (ref, options) => {
      const result = await original(ref, options)
      if ('id' in ref && ref.id === 2) { entered.resolve(); await waiting.promise }
      return result
    })
    const pending = access.file(2, signal()); const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await entered.promise; access.setSources(sources(other)); waiting.resolve(); await rejected
    mock.stat.mockImplementation(original); access.setSources(sources(root))
    let moved = false
    mock.stat.mockImplementation(async (ref, options) => {
      const result = await original(ref, options)
      if ('id' in ref && ref.id === 2 && !moved) { moved = true; mock.nodes.set(1, file(1, '/移动', true, 'v2')) }
      return result
    })
    await expect(access.file(2, signal())).rejects.toMatchObject({ code: 'source_changed' })
    mock.nodes.set(1, root); moved = false
    mock.stat.mockImplementation(async (ref, options) => {
      const result = await original(ref, options)
      if ('id' in ref && ref.id === 2 && !moved) { moved = true; mock.nodes.set(2, file(2, '/范围外/正文.txt')) }
      return result
    })
    await expect(access.file(2, signal())).rejects.toMatchObject({ code: 'file_changed' })
  })
  it('宿主声明 rpc.batch 时来源根与目标文件合并为两次批量核对，逐项失败不影响其余', async () => {
    const one = file(1, '/一', true), two = file(2, '/二', true), book = file(3, '/一/正文.txt')
    const mock = memoryDrive([one, two, book], {}, { batch: true }), access = new LibraryAccess(mock.drive)
    access.setSources(sources(one, two))
    const opened = await access.file(3, signal())
    expect(opened.file.path).toBe('/一/正文.txt'); expect(opened.sourceIds).toEqual([1])
    // 两次批量各含全部来源与目标文件，不再逐个 stat 往返。
    expect(mock.batch).toHaveBeenCalledTimes(2)
    expect(mock.batch.mock.calls.map(([calls]) => calls)).toEqual([
      [{ method: 'files.stat', params: { id: 1 } }, { method: 'files.stat', params: { id: 2 } }, { method: 'files.stat', params: { id: 3 } }],
      [{ method: 'files.stat', params: { id: 1 } }, { method: 'files.stat', params: { id: 2 } }, { method: 'files.stat', params: { id: 3 } }],
    ])
    // 某个来源缺失只进入不可用列表，其余来源与文件照常。
    mock.nodes.delete(2)
    const roots = await access.roots(signal())
    expect(roots.roots.map(item => item.source.nodeId)).toEqual([1])
    expect(roots.unavailable).toEqual([{ source: expect.objectContaining({ nodeId: 2 }), message: expect.stringContaining('节点不存在') }])
    expect((await access.file(3, signal())).sourceIds).toEqual([1])
    // 目标文件缺失按该项错误抛出。
    mock.nodes.delete(3)
    await expect(access.file(3, signal())).rejects.toMatchObject({ code: 'not_found' })
    // 批量返回条目数不一致或越界节点一律拒绝。
    mock.batch.mockResolvedValueOnce([{ result: one }])
    await expect(access.roots(signal())).rejects.toMatchObject({ code: 'invalid_file' })
    mock.batch.mockResolvedValueOnce([{ result: one }, { result: { ...two, id: 99 } }])
    expect((await access.roots(signal())).unavailable.map(item => item.source.nodeId)).toEqual([2])
    // 超过 16 个来源分批发送。
    const many = Array.from({ length: 16 }, (_, index) => file(index + 10, `/库${index}`, true))
    many.forEach(entry => mock.nodes.set(entry.id, entry)); mock.nodes.set(3, file(3, '/库0/正文.txt'))
    access.setSources(sources(...many)); mock.batch.mockClear()
    await access.file(3, signal())
    expect(mock.batch.mock.calls.map(([calls]) => calls.length)).toEqual([16, 1, 16, 1])
  })
  it('目录请求期间重绑定路径或来源失效，旧页不能发布', async () => {
    const root = file(1, '/书', true), book = file(2, '/书/正文.txt'), mock = memoryDrive([root, book]), access = new LibraryAccess(mock.drive)
    access.setSources(sources(root))
    mock.list.mockImplementationOnce(async () => {
      mock.nodes.set(1, file(1, '/移动后', true, 'v2'))
      return { entries: [book], path: root.path, has_more: false, next_cursor: null }
    })
    await expect(access.list(1, null, signal())).rejects.toMatchObject({ code: 'directory_changed' })
    expect(mock.readRange).not.toHaveBeenCalled()
  })
})

describe('文件事件与来源范围', () => {
  it('范围未知一律相关；已知目录按来源包含或祖先关系过滤；没有来源时无关', () => {
    const list = sources(file(1, '/书', true), file(2, '/漫画/连载', true)).config.sources
    expect(filesChangeAffectsSources(list, undefined)).toBe(true)
    expect(filesChangeAffectsSources(list, ['/书', 1])).toBe(true)
    expect(filesChangeAffectsSources(list, ['/书/子目录'])).toBe(true)
    expect(filesChangeAffectsSources(list, ['/漫画'])).toBe(true)
    expect(filesChangeAffectsSources(list, ['/'])).toBe(true)
    expect(filesChangeAffectsSources(list, ['/影片', '/书籍', '/漫画/完结'])).toBe(false)
    expect(filesChangeAffectsSources(list, [])).toBe(false)
    expect(filesChangeAffectsSources([], ['/书'])).toBe(false)
    expect(filesChangeAffectsSources([], undefined)).toBe(true)
  })
})
