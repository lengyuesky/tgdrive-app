import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Drive, FileEntry, RecordValue } from '../sdk/types'
import { LIBRARIES_KEY, LibrariesStore, LibraryAccess, directoryPath, libraryForFile, parseLibraries, withinDirectory, type CinemaLibrary, type CinemaLibraries } from './libraries'
import { ReadScheduler } from './io'
import type { CinemaFavorite, CinemaProgress } from './model'

const movie: CinemaLibrary = { id: 'movie', name: '电影', directoryId: 10, directoryPath: '/电影' }
const series: CinemaLibrary = { id: 'series', name: '电视剧', directoryId: 20, directoryPath: '/电视剧' }
const config = (libraries = [movie, series]): CinemaLibraries => ({ schemaVersion: 1, libraries })
const entry = (id: number, path: string, is_dir = false): FileEntry => ({ id, path, name: path.split('/').pop()!, is_dir, size: 100, content_version: 'v1', created_at: 1, modified_at: 1, favorite: false })
const record = <T>(key: string, value: T): RecordValue<T> => ({ key, value, revision: 'r1', updated_at: 1 })
const signal = () => new AbortController().signal
function setup() {
  const nodes = new Map<number, FileEntry>([[10, entry(10, '/电影', true)], [20, entry(20, '/电视剧', true)], [30, entry(30, '/电影/电影.mp4')]])
  const stat = vi.fn(async (ref: { id: number }) => {
    const file = nodes.get(ref.id)
    if (!file) throw new Error('文件不存在')
    return file
  })
  const searchPage = vi.fn().mockResolvedValue({ results: [], has_more: false, next_cursor: null })
  const list = vi.fn().mockResolvedValue({ entries: [], has_more: false, next_cursor: null })
  const saved = vi.fn().mockResolvedValue({ records: [], has_more: false, next_cursor: null })
  const get = vi.fn().mockResolvedValue(null), set = vi.fn().mockImplementation(async (key, value) => ({ key, value, revision: 'r2', updated_at: 2 }))
  const drive = { files: { stat, searchPage, list }, storage: { list: saved, get, set } } as unknown as Drive
  return { nodes, stat, searchPage, list, saved, get, set, drive, access: new LibraryAccess(drive, new ReadScheduler()), store: new LibrariesStore(drive) }
}
afterEach(() => vi.useRealTimers())

describe('命名媒体库配置', () => {
  it('名称去空白，允许父子媒体库；空配置合法但不会生成默认根目录', () => {
    expect(parseLibraries(config([]))).toEqual(config([]))
    const child = { id: 'child', name: ' 收藏电影 ', directoryId: 11, directoryPath: '/电影//收藏/./' }
    expect(parseLibraries(config([movie, child])).libraries[1]).toMatchObject({ name: '收藏电影', directoryPath: '/电影/收藏' })
  })
  it('拒绝非法版本、空名称、超长名称、重复标识、重名和重复目录', () => {
    for (const raw of [null, {}, { schemaVersion: 2, libraries: [] }, { schemaVersion: 1, libraries: null }]) expect(() => parseLibraries(raw)).toThrow('配置格式无效')
    for (const name of ['', '  ', '影'.repeat(51), '电\n影']) expect(() => parseLibraries(config([{ ...movie, name }]))).toThrow('名称')
    expect(() => parseLibraries(config([movie, { ...series, id: movie.id }]))).toThrow('标识')
    expect(() => parseLibraries(config([movie, { ...series, name: '电影 ' }]))).toThrow('同名')
    expect(() => parseLibraries(config([movie, { ...series, directoryId: movie.directoryId }]))).toThrow('已经绑定')
    expect(() => parseLibraries(config([{ ...movie, directoryId: 0 }]))).toThrow('有效的文件夹')
  })
  it('检查媒体库数量和 UTF-8 编码后的宿主单条数据容量', () => {
    const many = Array.from({ length: 33 }, (_, i) => ({ ...movie, id: `id${i}`, name: `库${i}`, directoryId: i + 1, directoryPath: `/库${i}` }))
    expect(() => parseLibraries(config(many))).toThrow('32 个')
    const huge = many.slice(0, 12).map(item => ({ ...item, directoryPath: '/' + '中'.repeat(1000) }))
    expect(() => parseLibraries(config(huge))).toThrow('32 KiB')
  })
  it('配置只经私有存储持久化，显式使用表单基线的 CAS 修订号', async () => {
    const s = setup()
    expect(await s.store.load()).toEqual({ config: config([]), revision: null })
    s.get.mockResolvedValue(record(LIBRARIES_KEY, config()))
    const snapshot = await s.store.load()
    const saved = await s.store.save(config([movie]), snapshot.revision)
    expect(s.set).toHaveBeenCalledWith(LIBRARIES_KEY, config([movie]), 'r1', { signal: undefined })
    expect(saved).toEqual({ config: config([movie]), revision: 'r2' })
    expect(s.stat).not.toHaveBeenCalled(); expect(s.list).not.toHaveBeenCalled(); expect(s.searchPage).not.toHaveBeenCalled()
  })
  it('读取失败、配置损坏及写冲突都不会回退全盘或自动覆盖', async () => {
    const s = setup()
    s.get.mockRejectedValueOnce(new Error('离线'))
    await expect(s.store.load()).rejects.toThrow('离线')
    s.get.mockResolvedValue(record(LIBRARIES_KEY, { schemaVersion: 99 }))
    await expect(s.store.load()).rejects.toThrow('配置格式无效')
    s.set.mockRejectedValueOnce({ code: 'storage_conflict' })
    await expect(s.store.save(config(), 'old')).rejects.toEqual({ code: 'storage_conflict' })
    expect(s.set).toHaveBeenCalledTimes(1)
    expect(s.searchPage).not.toHaveBeenCalled(); expect(s.list).not.toHaveBeenCalled()
  })
})

describe('媒体库范围与按需加载', () => {
  it('匹配完整目录边界，拒绝上级跳转和非法路径，父子库优先最深的根', () => {
    expect(directoryPath('/电影//合集/./')).toBe('/电影/合集')
    expect(withinDirectory('/电影/合集/视频.mp4', '/电影')).toBe(true)
    expect(withinDirectory('/电影花絮/视频.mp4', '/电影')).toBe(false)
    expect(withinDirectory('/电影/../视频.mp4', '/电影')).toBe(false)
    expect(withinDirectory('电影/视频.mp4', '/电影')).toBe(false)
    expect(withinDirectory('/任意/视频.mp4', '/')).toBe(true)
    const child = { ...series, directoryPath: '/电影/合集' }
    expect(libraryForFile(entry(30, '/电影/合集/视频.mp4'), [movie, child])?.id).toBe(child.id)
    expect(libraryForFile(entry(30, '/电影/封面.png'), [movie])).toBeUndefined()
  })
  it('没有选中媒体库时不允许搜索或枚举，也不读取任何历史或文件', async () => {
    const s = setup(), abort = signal()
    await expect(s.access.search(null, {}, abort)).rejects.toThrow('先进入')
    await expect(s.access.list(null, '/', null, abort)).rejects.toThrow('当前媒体库')
    await expect(s.access.video(config([]), 30, abort)).rejects.toThrow('先创建')
    expect(await s.access.savedPage([], 'favorite:', null, 48, abort)).toMatchObject({ entries: [], has_more: false })
    for (const spy of [s.stat, s.searchPage, s.list, s.saved]) expect(spy).not.toHaveBeenCalled()
  })
  it('仅解析当前库的根；查询绑定该库并保留分页，不请求其他库', async () => {
    const s = setup(), abort = signal()
    const { roots } = await s.access.roots(config(), abort, movie.id)
    expect(s.stat.mock.calls.map(([ref]) => ref.id)).toEqual([10])
    await s.access.search(roots[0], { q: '故事', extensions: ['mp4'], cursor: 'next' }, abort)
    expect(s.searchPage).toHaveBeenCalledWith({ under: '/电影', q: '故事', extensions: ['mp4'], cursor: 'next', kind: 'file', limit: 200 }, { signal: abort })
    await s.access.list(roots[0], '/电影/合集', 'next', abort)
    expect(s.list).toHaveBeenCalledWith({ path: '/电影/合集', cursor: 'next', limit: 200 }, { signal: abort })
    await expect(s.access.list(roots[0], '/电影花絮', null, abort)).rejects.toThrow('当前媒体库')
    expect(s.list).toHaveBeenCalledTimes(1)
  })
  it('根目录移动后按节点 ID 绑定，不跟随同路径新节点或回退全盘', async () => {
    const s = setup(), abort = signal()
    s.nodes.set(10, entry(10, '/改名电影', true)); s.nodes.set(50, entry(50, '/电影', true))
    expect((await s.access.roots(config(), abort, movie.id)).roots[0]).toMatchObject({ name: '电影', directoryId: 10, directoryPath: '/改名电影' })
    s.nodes.delete(10)
    const resolved = await s.access.roots(config(), abort, movie.id)
    expect(resolved.roots).toEqual([]); expect(resolved.unavailable).toHaveLength(1)
    expect(s.stat.mock.calls.every(([ref]) => ref.id === 10)).toBe(true)
    expect(s.searchPage).not.toHaveBeenCalled()
  })
  it('播放前重新核对当前文件路径；库内操作不能跳入另一个已配置库', async () => {
    const s = setup(), abort = signal()
    expect((await s.access.video(config(), 30, abort, movie.id)).library.id).toBe(movie.id)
    s.nodes.set(30, entry(30, '/电视剧/电影.mp4'))
    await expect(s.access.video(config(), 30, abort, movie.id)).rejects.toThrow('范围内')
    expect((await s.access.video(config(), 30, abort)).library.id).toBe(series.id)
    await expect(s.access.video(config([series]), 30, abort, movie.id)).rejects.toThrow('已删除')
    expect(s.list).not.toHaveBeenCalled(); expect(s.searchPage).not.toHaveBeenCalled()
  })
  it('取消后的迟到查询不返回可展示数据', async () => {
    const s = setup(), controller = new AbortController()
    let release!: (value: unknown) => void
    s.searchPage.mockImplementation(() => new Promise(resolve => { release = resolve }))
    const pending = s.access.search(movie, {}, controller.signal)
    controller.abort(); release({ results: [entry(30, '/电影/旧片.mp4')], has_more: false, next_cursor: null })
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('收藏和历史仅显示有效媒体库内的记录', () => {
  it('按当前路径筛选，而非保存时的路径；库外记录不被删除或改写', async () => {
    const s = setup(), abort = signal()
    s.nodes.set(30, entry(30, '/其他/移出.mp4')); s.nodes.set(31, entry(31, '/电影/移入.mp4'))
    const outside = record<CinemaFavorite>('favorite:30', { file: entry(30, '/电影/移出.mp4') })
    const inside = record<CinemaFavorite>('favorite:31', { file: entry(31, '/其他/移入.mp4') })
    s.saved.mockResolvedValue({ records: [outside, inside], has_more: false, next_cursor: null })
    const page = await s.access.savedPage<CinemaFavorite>([movie], 'favorite:', null, 48, abort)
    expect(page.entries.map(item => item.file.path)).toEqual(['/电影/移入.mp4'])
    expect(page.entries[0].record).toBe(inside)
    expect(s.set).not.toHaveBeenCalled(); expect(s.list).not.toHaveBeenCalled(); expect(s.searchPage).not.toHaveBeenCalled()
    expect(outside.value.file.path).toBe('/电影/移出.mp4')
    s.nodes.set(30, entry(30, '/电影/移出.mp4'))
    expect((await s.access.savedPage([movie], 'favorite:', null, 48, abort)).entries).toHaveLength(2)
  })
  it('过滤后为空仍保留服务器游标，不为填满一页读遍历史', async () => {
    const s = setup()
    const value: CinemaProgress = { file: entry(30, '/电影/电影.mp4'), seconds: 5, duration: 20, completed: false }
    s.saved.mockResolvedValue({ records: [record('progress:30', value)], has_more: true, next_cursor: 'stored-next' })
    const page = await s.access.savedPage([series], 'progress:', 'stored-current', 48, signal())
    expect(page).toMatchObject({ entries: [], has_more: true, next_cursor: 'stored-next' })
    expect(s.saved).toHaveBeenCalledTimes(1)
    expect(s.saved.mock.calls[0][0]).toEqual({ prefix: 'progress:', cursor: 'stored-current', limit: 48 })
  })
  it('保持旧内容版本的记录，以便续播逻辑拒绝错误的进度；文件元数据使用最新版', async () => {
    const s = setup()
    const value: CinemaProgress = { file: entry(30, '/电影/电影.mp4'), seconds: 5, duration: 20, completed: false }
    s.nodes.set(30, { ...value.file, content_version: 'v2' })
    s.saved.mockResolvedValue({ records: [record('progress:30', value)], has_more: false, next_cursor: null })
    const page = await s.access.savedPage<CinemaProgress>([movie], 'progress:', null, 12, signal())
    expect(page.entries[0].file.content_version).toBe('v2')
    expect(page.entries[0].record.value.file.content_version).toBe('v1')
    expect(s.set).not.toHaveBeenCalled()
  })
  it('记录验证有界并发和限速，离开页面取消尚未开始的元数据读取', async () => {
    vi.useFakeTimers()
    const s = setup(), controller = new AbortController()
    s.saved.mockResolvedValue({ records: Array.from({ length: 48 }, (_, i) => record(`favorite:${i + 100}`, { file: entry(i + 100, `/电影/${i}.mp4`) })), has_more: false, next_cursor: null })
    const releases: (() => void)[] = []
    s.stat.mockImplementation(ref => new Promise(resolve => { releases.push(() => resolve(entry(ref.id, `/电影/${ref.id}.mp4`))) }))
    const pending = s.access.savedPage([movie], 'favorite:', null, 48, controller.signal)
    const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(0)
    expect(s.stat).toHaveBeenCalledTimes(4)
    releases.splice(0).forEach(release => release())
    await vi.advanceTimersByTimeAsync(100)
    expect(s.stat).toHaveBeenCalledTimes(8)
    releases.splice(0).forEach(release => release())
    await vi.advanceTimersByTimeAsync(500)
    expect(s.stat).toHaveBeenCalledTimes(8)
    controller.abort(); await vi.runAllTimersAsync(); await cancelled
    expect(s.stat).toHaveBeenCalledTimes(8)
  })
})
