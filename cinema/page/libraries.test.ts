import { describe, expect, it, vi } from 'vitest'
import { LibrariesStore, LibraryAccess, directoryPath, libraryForFile, parseLibraries, withinDirectory } from './libraries'
import type { CinemaFavorite, CinemaProgress } from './model'
import type { CinemaRecord, LibraryDraft } from './client'
import type { MemoryHost } from '@tgdrive/test-host'
import { body, configuration, failure, fixture, json, movie, node, series } from './test-fixture'

async function setup() {
  let host!: MemoryHost
  const state = { config: configuration(), records: [] as CinemaRecord<CinemaFavorite | CinemaProgress>[], cursor: null as string | null, broken: false, conflict: false }
  const calls: Array<{ path: string; body: Record<string, unknown> }> = []
  const result = await fixture(async request => {
    const value = body(request); calls.push({ path: request.path, body: value })
    if (request.path === '/owner/config') {
      if (state.broken) return failure('backend_unavailable', '离线', 503)
      const libraries = await Promise.all(state.config.libraries.map(async library => {
        try { const node = await host.stat({ by: 'id', id: library.root_id }); return { ...library, path: node.path, authorized: true } }
        catch { return { ...library, path: null, authorized: false } }
      }))
      return json({ ...state.config, libraries })
    }
    if (request.path === '/owner/libraries') {
      if (state.conflict || value.revision !== state.config.revision) return failure()
      const libraries = (value.libraries as LibraryDraft[]).map(item => ({ ...item, path: item.root_id === '2' ? '/影视' : '/电视剧', authorized: true }))
      state.config = { ...state.config, libraries, revision: 'saved' }; return json(state.config)
    }
    if (request.path === '/owner/files/stat') {
      try { return json(await host.stat(value as Parameters<MemoryHost['stat']>[0])) }
      catch (error) { return failure((error as { code: string }).code, '节点不可读', (error as { status: number }).status) }
    }
    if (request.path === '/owner/catalog') return json({ items: [], descriptions: {}, total: 0, next_cursor: state.cursor })
    if (request.path === '/owner/files/list') return json({ items: [], total: 0, next_cursor: state.cursor })
    if (request.path === '/owner/storage/list') return json({ records: state.records, total: state.records.length, next_cursor: state.cursor })
    return json(null)
  })
  host = result.host
  return { ...result, state, calls, store: new LibrariesStore(result.cinema), access: new LibraryAccess(result.cinema) }
}

describe('独立后端的命名媒体库配置', () => {
  it('空配置不会建立默认全盘库，名称去空白，父子目录可以分别命名', () => {
    expect(parseLibraries({ libraries: [] })).toEqual({ libraries: [] })
    const child = { ...series, id: '3'.repeat(32), name: ' 收藏电影 ', root_id: '20', path: '/影视/收藏' }
    expect(parseLibraries({ libraries: [movie, child] }).libraries[1].name).toBe('收藏电影')
  })
  it('拒绝损坏结构、空或超长名称、重复身份、重名、重复目录及非规范路径', () => {
    for (const raw of [null, {}, { libraries: null }]) expect(() => parseLibraries(raw)).toThrow('配置格式')
    for (const name of ['', ' ', '影'.repeat(54), '电\n影']) expect(() => parseLibraries({ libraries: [{ ...movie, name }] })).toThrow('名称')
    expect(() => parseLibraries({ libraries: [movie, { ...series, id: movie.id }] })).toThrow('标识')
    expect(() => parseLibraries({ libraries: [movie, { ...series, name: '电影 ' }] })).toThrow('同名')
    expect(() => parseLibraries({ libraries: [movie, { ...series, root_id: movie.root_id }] })).toThrow('已经绑定')
    expect(() => parseLibraries({ libraries: [{ ...movie, root_id: '0' }] })).toThrow('有效的文件夹')
    expect(() => parseLibraries({ libraries: [{ ...movie, path: '/影视//合集' }] })).toThrow('路径')
  })
  it('数量有明确上限，超长路径不再误套旧 KV 的三十二 KiB 配置容量', () => {
    const libraries = Array.from({ length: 33 }, (_, index) => ({ ...movie, id: index.toString(16).padStart(32, '0'), name: `库${index}`, root_id: String(index + 1) }))
    expect(() => parseLibraries({ libraries })).toThrow('32 个')
    expect(parseLibraries({ libraries: libraries.slice(0, 12).map(item => ({ ...item, path: '/' + '中'.repeat(1000) })) }).libraries).toHaveLength(12)
  })
  it('配置通过后端并显式使用编辑快照的 CAS 修订，不调用宿主 KV 或扫描视频', async () => {
    const test = await setup(), kv = vi.spyOn(test.host, 'kvPut'), query = vi.spyOn(test.host, 'query')
    const snapshot = await test.store.load(); await test.store.save({ libraries: [movie] }, snapshot.revision)
    expect(test.calls.find(call => call.path === '/owner/libraries')!.body).toEqual({ revision: 'r1', libraries: [{ id: movie.id, name: movie.name, kind: 'movie', root_id: '2' }] })
    expect(kv).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled()
  })
  it('读失败和写冲突不会回退全盘或自动覆盖', async () => {
    const test = await setup(); test.state.broken = true
    await expect(test.store.load()).rejects.toThrow('离线')
    test.state.broken = false; test.state.conflict = true
    await expect(test.store.save({ libraries: [movie] }, 'old')).rejects.toMatchObject({ code: 'storage_conflict' })
    expect(test.calls.filter(call => call.path === '/owner/libraries')).toHaveLength(1)
  })
})

describe('目录范围、当前身份与按页读取', () => {
  it('路径按完整目录边界判断，拒绝上级跳转；重叠库优先最深根', () => {
    expect(directoryPath('/影视/合集')).toBe('/影视/合集')
    expect(withinDirectory('/影视/合集/视频.mp4', '/影视')).toBe(true); expect(withinDirectory('/影视花絮/视频.mp4', '/影视')).toBe(false)
    expect(withinDirectory('/影视/../视频.mp4', '/影视')).toBe(false); expect(withinDirectory('影视/视频.mp4', '/影视')).toBe(false)
    expect(withinDirectory('/任意/视频.mp4', '/')).toBe(true)
    const child = { ...series, path: '/影视/合集' }
    expect(libraryForFile(node('3', '/影视/合集/视频.mp4'), [movie, child])?.id).toBe(child.id)
    expect(libraryForFile(node('3', '/影视/海报.png'), [movie])).toBeUndefined()
  })
  it('没选媒体库就不查询，空根不会读取收藏或历史', async () => {
    const test = await setup()
    await expect(test.access.search(null, {}, test.signal)).rejects.toThrow('先进入')
    await expect(test.access.list(null, '/', null, test.signal)).rejects.toThrow('当前媒体库')
    await expect(test.access.video({ libraries: [] }, '3', test.signal)).rejects.toThrow('先创建')
    expect(await test.access.savedPage([], 'favorite:', null, 48, test.signal)).toMatchObject({ entries: [], next_cursor: null })
    expect(test.calls).toHaveLength(0)
  })
  it('搜索传递库身份、文件格式与游标，不为填满页面扫描其他库', async () => {
    const test = await setup(); test.state.cursor = 'next'
    const page = await test.access.search(movie, { q: '故事', extensions: ['mp4'], cursor: 'current' }, test.signal)
    expect(page.next_cursor).toBe('next')
    expect(test.calls[0].body).toEqual({ q: '故事', extensions: ['mp4'], cursor: 'current', ancestor: movie.id, raw_files: true, limit: 48 })
    await expect(test.access.list(movie, '/影视花絮', null, test.signal)).rejects.toThrow('当前媒体库')
    expect(test.calls).toHaveLength(1)
  })
  it('根目录改名后配置按节点身份显示最新路径，不跟随同路径新节点', async () => {
    const test = await setup(); await test.host.changeNode({ id: '2', name: '改名影视' })
    await test.host.addNode({ id: '50', parent_id: '1', name: '影视', kind: 'directory' })
    const snapshot = await test.store.load()
    expect(snapshot.config.libraries[0]).toMatchObject({ root_id: '2', path: '/改名影视' })
    await test.host.changeNode({ id: '2', visible: false })
    const changed = await test.store.load(), roots = await test.access.roots(changed.config, test.signal, movie.id)
    expect(roots.roots).toEqual([]); expect(roots.unavailable).toHaveLength(1)
  })
  it('播放前核对实际节点，指定库不能跳入另一个已授权媒体库', async () => {
    const test = await setup(), snapshot = await test.store.load()
    expect((await test.access.video(snapshot.config, '3', test.signal, movie.id)).library.id).toBe(movie.id)
    await test.host.changeNode({ id: '3', parent: '10' })
    await expect(test.access.video(snapshot.config, '3', test.signal, movie.id)).rejects.toThrow('范围内')
    expect((await test.access.video(snapshot.config, '3', test.signal)).library.id).toBe(series.id)
  })
})

describe('收藏历史的页面消费', () => {
  it('仅展示当前媒体库的有效记录，库外记录隐藏但不改写，空页保留游标', async () => {
    const test = await setup(); test.state.cursor = 'stored-next'
    test.state.records = [{ key: 'favorite:3', revision: 'r1', value: { file: node('3', '/其他/移出.mp4') } }, { key: 'favorite:11', revision: 'r1', value: { file: node('11', '/影视/移入.mp4') } }]
    const page = await test.access.savedPage([movie], 'favorite:', 'stored-current', 48, test.signal)
    expect(page.entries.map(entry => entry.file.path)).toEqual(['/影视/移入.mp4']); expect(page.next_cursor).toBe('stored-next')
    expect(test.calls).toHaveLength(1)
    test.state.records = test.state.records.slice(0, 1)
    expect(await test.access.savedPage([movie], 'favorite:', null, 48, test.signal)).toMatchObject({ entries: [], next_cursor: 'stored-next' })
  })
})
// 旧存储版本迁移、路径规范化别名和页面固定限速不再保留；真实离库／回库、覆盖与全部授权核对由 Rust 后端和宿主替身回归覆盖。
