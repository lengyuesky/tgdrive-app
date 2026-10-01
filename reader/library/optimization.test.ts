import { describe, expect, it, vi } from 'vitest'
import { ReadingLibrary } from './service'
import { ReadingStateCache } from './reading-cache'
import { SOURCES_KEY } from './sources'
import { deferred, file, memoryDrive, sources } from './test-fixtures'
import { MeView } from '../ui/me-view'
import type { UiContext } from '../ui/types'

async function setup(count = 1) {
  const root = file(1, '/书', true), files = Array.from({ length: count }, (_, i) => file(i + 2, `/书/书${i}.txt`))
  const mock = memoryDrive([root, ...files]); mock.seed(SOURCES_KEY, sources(root).config)
  const library = new ReadingLibrary(mock.drive, 'books'); await library.initialize(); await library.refresh()
  return { mock, library, root, files }
}
describe('阅读馆增量加载', () => {
  it('连续翻页复用状态，单条进度事件只读取该书两个键，不扫描文件树', async () => {
    const { mock, library, files } = await setup(3)
    const before = await library.loadReadingState(); mock.storageList.mockClear(); mock.list.mockClear(); mock.get.mockClear()
    before.readings.clear()
    expect((await library.loadReadingState()).readings.size).toBe(3)
    expect(mock.storageList).not.toHaveBeenCalled()
    mock.seed('progress:2', { file: files[0], title: '更新', location: { format: 'txt', index: 1, offset: 42 } })
    library.invalidateReadingState('progress:2')
    expect((await library.loadReadingState()).readings.get(2)?.location?.offset).toBe(42)
    expect(mock.get.mock.calls.map(([key]) => key).sort()).toEqual(['library:reading:2', 'progress:2'])
    expect(mock.list).not.toHaveBeenCalled(); expect(mock.storageList).not.toHaveBeenCalled(); library.destroy()
  })
  it('本页修改收藏后缓存立即失效，保持 CAS 修订基线', async () => {
    const { mock, library } = await setup()
    const state = await library.loadReadingState(), work = library.snapshot.works.rows[0]!
    await library.reading.setFlags(work.id, state.flagSnapshots.get(work.id)!, { favorite: true })
    const next = await library.loadReadingState()
    expect(next.flags.get(work.id)?.favorite).toBe(true)
    expect(next.flagSnapshots.get(work.id)?.revision).toBe(mock.records.get('library:flags:' + work.id)?.revision)
    library.destroy()
  })
  it('多调用共享读取，取消一个等待者不影响另一个，过期后重新校对', async () => {
    const mock = memoryDrive(), signal = new AbortController().signal, gate = deferred(), cache = new ReadingStateCache(mock.drive, signal)
    const read = vi.fn(async () => { await gate.promise; return { readings: new Map(), flags: new Map(), flagSnapshots: new Map() } })
    const controller = new AbortController(), first = cache.load('a', [], read, controller.signal), second = cache.load('a', [], read, signal)
    const cancelled = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort(); gate.resolve(); await cancelled; await second
    expect(read).toHaveBeenCalledTimes(1)
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000)
    await cache.load('a', [], read, signal); expect(read).toHaveBeenCalledTimes(2); now.mockRestore()
  })
  it('请求在途时收到更新，旧结果不会发布为当前状态', async () => {
    const mock = memoryDrive(), signal = new AbortController().signal, gate = deferred(), cache = new ReadingStateCache(mock.drive, signal)
    const value = { readings: new Map(), flags: new Map(), flagSnapshots: new Map() }
    const read = vi.fn().mockImplementationOnce(async () => { await gate.promise; return value }).mockResolvedValue(value)
    const pending = cache.load('a', [], read, signal)
    cache.invalidate(); gate.resolve(); await pending
    expect(read).toHaveBeenCalledTimes(2)
  })
  it('只重扫发生变化的子目录，保留兄弟目录，删除文件从目标范围移除', async () => {
    const root = file(1, '/书', true), left = file(2, '/书/左', true), right = file(3, '/书/右', true)
    const mock = memoryDrive([root, left, right, file(4, '/书/左/旧.txt'), file(5, '/书/右/保留.txt')])
    mock.seed(SOURCES_KEY, sources(root).config)
    const library = new ReadingLibrary(mock.drive, 'books'); await library.initialize(); await library.refresh(); mock.list.mockClear()
    mock.nodes.delete(4); mock.nodes.set(6, file(6, '/书/左/新.txt'))
    await library.refresh(undefined, ['/书/左'])
    expect(mock.list.mock.calls.map(([params]) => params.path)).toEqual(['/书/左'])
    expect(library.snapshot.units.map(unit => unit.nodeId).sort()).toEqual([5, 6]); expect(library.snapshot.complete).toBe(true)
    library.destroy()
  })
  it('来源分片可独立加载，切回完整缓存不重新枚举其他来源', async () => {
    const a = file(1, '/甲', true), b = file(2, '/乙', true), mock = memoryDrive([a, b, file(3, '/甲/甲.txt'), file(4, '/乙/乙.txt')])
    mock.seed(SOURCES_KEY, sources(a, b).config)
    const library = new ReadingLibrary(mock.drive, 'books'); await library.initialize()
    await library.selectSource(1); expect(library.snapshot.units.map(unit => unit.nodeId)).toEqual([3])
    await library.selectSource(2); expect(library.snapshot.units.map(unit => unit.nodeId)).toEqual([4])
    mock.list.mockClear(); await library.selectSource(1)
    expect(library.snapshot.units.map(unit => unit.nodeId)).toEqual([3]); expect(mock.list).not.toHaveBeenCalled()
    library.destroy()
  })
  it('收藏与想读超过 100 项仍能翻页到最后，DOM 维持每页 40 条', async () => {
    const { library, mock } = await setup(105)
    for (const work of library.snapshot.works.rows) mock.seed('library:flags:' + work.id, { schemaVersion: 1, favorite: true, wantToRead: true })
    const container = document.createElement('div'); document.body.append(container)
    const context = { library, drive: mock.drive, kind: 'books', signal: new AbortController().signal, openDetail: vi.fn() } as unknown as UiContext
    const view = new MeView(container, context)
    for (const kind of ['fav', 'want'] as const) {
      await view.render(kind)
      for (let page = 0; page < 2; page++) {
        expect(container.querySelector('#' + kind + '-items-list')?.childElementCount).toBe(40)
        ;[...container.querySelectorAll('button')].find(button => button.textContent === '下一页')!.click()
        await vi.waitFor(() => expect(container.textContent).toContain('第 ' + (page + 2) + ' / 3 页'))
      }
      expect(container.querySelector('#' + kind + '-items-list')?.childElementCount).toBe(25)
      expect([...container.querySelectorAll('button')].find(button => button.textContent === '下一页')!.disabled).toBe(true)
    }
    view.destroy(); library.destroy(); container.remove()
  })
})

it('全部来源达到 2000 条后，单独选择另一来源仍可发现并阅读该来源', async () => {
  const a = file(1, '/甲', true), b = file(2, '/乙', true)
  const mock = memoryDrive([a, b, ...Array.from({ length: 2001 }, (_, i) => file(i + 10, '/甲/' + i + '.txt')), file(3000, '/乙/后面的书.txt')])
  mock.seed(SOURCES_KEY, sources(a, b).config)
  const library = new ReadingLibrary(mock.drive, 'books'); await library.initialize(); await library.refresh()
  expect(library.snapshot.complete).toBe(false); expect(library.snapshot.units.some(unit => unit.nodeId === 3000)).toBe(false)
  await library.selectSource(2)
  expect(library.snapshot.units.map(unit => unit.nodeId)).toEqual([3000])
  expect((await library.openUnit(3000)).file.name).toBe('后面的书.txt')
  await library.removeSource(2)
  expect(library.snapshot.indexedSourceId).toBeUndefined(); expect(library.snapshot.units.some(unit => unit.nodeId === 3000)).toBe(false)
  library.destroy()
}, 15_000)

it('后台来源重载尚未返回时立即打开图书，会等待重载而不是报未初始化', async () => {
  const { library, mock } = await setup(), gate = deferred(), started = deferred(), original = mock.get.getMockImplementation()!
  mock.get.mockImplementationOnce(async (...args) => { started.resolve(); await gate.promise; return original(...args) })
  const reload = library.initialize(); await started.promise
  const opened = library.openUnit(2)
  gate.resolve(); await reload
  expect((await opened).file.id).toBe(2); library.destroy()
})

it('远端作品更新仅重读作品快照，文件目录不被重新扫描', async () => {
  const { library, mock } = await setup(); mock.list.mockClear()
  await library.reloadWorks()
  expect(mock.list).not.toHaveBeenCalled(); expect((await library.openUnit(2)).file.id).toBe(2); library.destroy()
})
