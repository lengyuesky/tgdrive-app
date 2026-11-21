import { describe, expect, it, vi } from 'vitest'
import { LibraryAccess, SOURCES_KEY, SourcesStore, filesChangeAffectsSources, parseSources } from './sources'
import { deferred, file, memoryHost, signal, sources, testId } from './test-fixtures'

describe('SourcesStore 来源使用当前配置', () => {
  it('没有来源不枚举，配置读取失败或未知版本绝不回退根目录或覆盖原记录', async () => {
    const mock = await memoryHost([file(0, '/', true)])
    const store = new SourcesStore(mock.host), access = new LibraryAccess(mock.host)
    const empty = await store.load(signal()); access.setSources(empty)
    expect(empty.config.sources).toEqual([])
    expect(await access.roots(signal())).toEqual({ roots: [], unavailable: [] })
    await expect(access.file(testId(5), signal())).rejects.toMatchObject({ code: 'no_sources' })
    expect(mock.list).not.toHaveBeenCalled(); expect(mock.query).not.toHaveBeenCalled(); expect(mock.stat).not.toHaveBeenCalled()
    mock.get.mockRejectedValueOnce(new Error('读取失败'))
    await expect(store.load(signal())).rejects.toThrow('读取失败')
    const old = await mock.seed(SOURCES_KEY, { schemaVersion: 42, sources: ['/'] })
    await expect(store.load(signal())).rejects.toMatchObject({ code: 'unknown_sources' })
    expect(mock.records.get(SOURCES_KEY)).toEqual(old); expect(mock.set).not.toHaveBeenCalled()
  })
  it('只读取现行来源，宿主不存在旧目录设置或数据迁移调用', async () => {
    const directory = file(1, '/书库', true), mock = await memoryHost([directory]), store = new SourcesStore(mock.host)
    expect((await store.load(signal())).config.sources).toEqual([])
    expect(mock.get.mock.calls.map(([key]) => key)).toEqual([SOURCES_KEY])
    const saved = await store.add(await store.load(), directory.path, false, signal())
    expect(await store.load()).toEqual(saved)
    expect('settings' in mock.host).toBe(false)
  })
  it('目录删除或选择过程中重建不会误绑定，同 ID 拒绝，父子允许，最多 16 个', async () => {
    const mock = await memoryHost(), store = new SourcesStore(mock.host)
    await expect(store.add(await store.load(), '/旧书库', false, signal())).rejects.toMatchObject({ code: 'not_found' })
    expect(mock.set).not.toHaveBeenCalled()
    const parent = file(1, '/书', true), child = file(2, '/书/子目录', true)
    mock.nodes.set(1, parent); mock.nodes.set(2, child)
    const first = await store.add(await store.load(), parent.path, false, signal())
    await expect(store.add(first, parent.path, false, signal())).rejects.toMatchObject({ code: 'duplicate_source' })
    const nested = await store.add(first, child.path, false, signal())
    expect(nested.config.sources.map(source => source.nodeId)).toEqual([testId(1), testId(2)])
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
    const mock = await memoryHost([file(1, '/一', true), file(2, '/二', true)]), store = new SourcesStore(mock.host)
    const base = await store.load(), draft = structuredClone(base), saved = await store.add(base, '/一', false, signal())
    await expect(store.add(draft, '/二', false, signal())).rejects.toMatchObject({ code: 'storage_conflict' })
    expect(draft).toEqual(base)
    await mock.seed('progress:8', { old: true }); await mock.seed('bookmark:8:a', { old: true }); await mock.seed('library:works', { old: true })
    await store.remove(saved, testId(1), signal())
    expect(mock.remove).not.toHaveBeenCalled()
    expect([...mock.records.keys()]).toEqual(expect.arrayContaining(['progress:8', 'bookmark:8:a', 'library:works']))
  })
})

describe('LibraryAccess 稳定节点及异步范围核对', () => {
  it('目录移动继续按 ID 访问，删除后同路径重建不误绑定', async () => {
    const root = file(1, '/书', true), book = file(2, '/书/正文.txt'), mock = await memoryHost([root, book]), access = new LibraryAccess(mock.host)
    access.setSources(sources(root))
    mock.nodes.set(1, file(1, '/移动后', true)); mock.nodes.set(2, file(2, '/移动后/正文.txt'))
    expect((await access.file(testId(2), signal())).file.path).toBe('/移动后/正文.txt')
    mock.nodes.delete(1); mock.nodes.set(9, file(9, '/移动后', true))
    await expect(access.file(testId(2), signal())).rejects.toMatchObject({ code: 'source_unavailable' })
    expect(mock.stat.mock.calls.every(([ref]) => ref.by === 'id')).toBe(true)
  })
  it('离开来源或版本变化不能打开，列表与搜索都使用真实游标及固定来源', async () => {
    const root = file(1, '/书', true), entries = Array.from({ length: 205 }, (_, index) => file(index + 2, `/书/正文${index}.txt`))
    const mock = await memoryHost([root, ...entries, file(999, '/书外/秘密.txt')]), access = new LibraryAccess(mock.host)
    access.setSources(sources(root))
    await expect(access.file('999', signal())).rejects.toMatchObject({ code: 'outside_sources' })
    await expect(access.file('2', signal(), 'old')).rejects.toMatchObject({ code: 'file_changed' })
    const first = await access.list(root.id, null, signal()), second = await access.list(root.id, first.next_cursor, signal())
    expect(second.items).toHaveLength(5)
    expect(mock.list).toHaveBeenLastCalledWith({ directory: { by: 'id', id: root.id }, sort: 'name', order: 'asc', cursor: first.next_cursor, limit: 200 }, expect.anything())
    const found = await access.search(root.id, { q: '正文', extensions: ['txt'] }, signal())
    await access.search(root.id, { q: '正文', cursor: found.next_cursor, extensions: ['txt'] }, signal())
    expect(mock.query).toHaveBeenLastCalledWith({ roots: [root.id], recursive: true, filter: { kind: 'all', name_contains: '正文', extensions: ['txt'], include_hidden: false }, sort: 'name', order: 'asc', limit: 200, cursor: found.next_cursor }, expect.anything())
    await expect(access.search('999', {}, signal())).rejects.toMatchObject({ code: 'source_removed' })
  })
  it('返回越界节点必须报错，不把过滤后的空页冒充一次成功扫描', async () => {
    const root = file(1, '/书', true), outside = file(2, '/别处/秘密.txt'), mock = await memoryHost([root, outside]), access = new LibraryAccess(mock.host)
    access.setSources(sources(root))
    const page = await mock.host.list({ directory: { by: 'id', id: root.id }, sort: 'name', order: 'asc', limit: 200, cursor: null })
    mock.list.mockResolvedValueOnce({ ...page, items: [outside] })
    await expect(access.list(root.id, null, signal())).rejects.toMatchObject({ code: 'invalid_page' })
    const query = await mock.host.query({ roots: [root.id], recursive: true, filter: { kind: 'all', extensions: [], include_hidden: false }, sort: 'name', order: 'asc', limit: 200, cursor: null })
    mock.query.mockResolvedValueOnce({ ...query, items: [outside] })
    await expect(access.search(root.id, {}, signal())).rejects.toMatchObject({ code: 'invalid_page' })
  })
  it('慢 stat 返回时再次核对来源：切来源、目录移动及文件移动均失效', async () => {
    const root = file(1, '/书', true), book = file(2, '/书/正文.txt'), other = file(3, '/别处', true), mock = await memoryHost([root, book, other]), access = new LibraryAccess(mock.host)
    access.setSources(sources(root))
    const original = mock.stat.getMockImplementation()!, waiting = deferred(), entered = deferred()
    mock.stat.mockImplementation(async (ref, options) => { const result = await original(ref, options); if (ref.by === 'id' && ref.id === book.id) { entered.resolve(); await waiting.promise }; return result })
    const pending = access.file(book.id, signal()), rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await entered.promise; access.setSources(sources(other)); waiting.resolve(); await rejected
    mock.stat.mockImplementation(original); access.setSources(sources(root))
    let moved = false
    mock.stat.mockImplementation(async (ref, options) => {
      const result = await original(ref, options)
      if (ref.by === 'id' && ref.id === book.id && !moved) { moved = true; mock.nodes.set(root.id, file(root.id, '/移动', true)) }
      return result
    })
    await expect(access.file(book.id, signal())).rejects.toMatchObject({ code: 'source_changed' })
    mock.nodes.set(root.id, file(root.id, '/书', true)); moved = false
    mock.stat.mockImplementation(async (ref, options) => {
      const result = await original(ref, options)
      if (ref.by === 'id' && ref.id === book.id && !moved) { moved = true; mock.nodes.set(book.id, file(book.id, '/别处/正文.txt')) }
      return result
    })
    await expect(access.file(book.id, signal())).rejects.toMatchObject({ code: 'file_changed' })
  })
  it('来源 stat 并行核对且逐项失败隔离，不依赖不存在的批量 RPC', async () => {
    const one = file(1, '/一', true), two = file(2, '/二', true), book = file(3, '/一/正文.txt'), mock = await memoryHost([one, two, book]), access = new LibraryAccess(mock.host)
    access.setSources(sources(one, two))
    expect((await access.file(book.id, signal())).sourceIds).toEqual([one.id])
    expect('batch' in mock.host).toBe(false)
    mock.nodes.delete(two.id)
    const roots = await access.roots(signal())
    expect(roots.roots.map(item => item.source.nodeId)).toEqual([one.id])
    expect(roots.unavailable).toEqual([{ source: expect.objectContaining({ nodeId: two.id }), message: expect.stringContaining('节点不存在') }])
    expect((await access.file(book.id, signal())).sourceIds).toEqual([one.id])
    mock.nodes.delete(book.id)
    await expect(access.file(book.id, signal())).rejects.toMatchObject({ code: 'not_found' })
    const many = Array.from({ length: 16 }, (_, index) => file(index + 10, `/库${index}`, true))
    for (const entry of many) mock.nodes.set(entry.id, entry)
    access.setSources(sources(...many)); mock.stat.mockClear()
    expect((await access.roots(signal())).roots).toHaveLength(16); expect(mock.stat).toHaveBeenCalledTimes(16)
  })
  it('目录请求期间移动或来源失效，旧页不能发布', async () => {
    const root = file(1, '/书', true), book = file(2, '/书/正文.txt'), mock = await memoryHost([root, book]), access = new LibraryAccess(mock.host)
    access.setSources(sources(root))
    const list = mock.list.getMockImplementation()!
    mock.list.mockImplementationOnce(async (...args) => { const page = await list(...args); mock.nodes.set(root.id, file(root.id, '/移动后', true)); return page })
    await expect(access.list(root.id, null, signal())).rejects.toMatchObject({ code: 'directory_changed' })
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
