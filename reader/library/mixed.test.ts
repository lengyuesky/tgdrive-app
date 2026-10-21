import { describe, expect, it } from 'vitest'
import { ReadingLibrary } from './service'
import { contentKind, unitFormat } from './model'
import { aggregateReading } from './reading'
import { file, memoryDrive, signal, sources } from './test-fixtures'
import { PreferenceStore, readerDefaultPreferences, resolvePreferences } from '../state'

describe('统一阅读馆数据链', () => {
  it('切换来源的局部刷新隔离已改格式成员，保留不可见成员而不恢复重复旧归属', async () => {
    const root = file(1, '/甲', true), other = file(10, '/乙', true)
    const entries = [root, other, file(2, '/甲/星河 第1卷.cbz'), file(3, '/甲/星河 第2卷.cbz'), file(4, '/乙/星河 第3卷.cbz')]
    const mock = memoryDrive(entries)
    mock.seed('library:sources', sources(root, other).config)
    const library = new ReadingLibrary(mock.drive, 'all')
    try {
      await library.initialize(); await library.refresh()
      const primaryId = library.snapshot.works.rows[0]!.id
      expect(library.snapshot.works.rows[0]!.members).toHaveLength(3)
      mock.nodes.set(2, file(2, '/甲/星河 第1卷.epub'))
      await library.selectSource(1)
      const works = library.snapshot.works.rows.filter(work => !work.redirectTo)
      expect(works.map(work => [work.kind, work.members.map(member => member.unitId)])).toEqual([['books', [2]], ['comics', [3, 4]]])
      expect(works[0]!.id).toBe(primaryId)
      expect(library.query({ kind: 'books' }).items[0]!.units.map(unit => unit.nodeId)).toEqual([2])
      expect(library.query({ kind: 'comics' }).items[0]!.units.map(unit => unit.nodeId)).toEqual([3])
      await library.refresh()
      expect(library.snapshot.works.rows).toEqual(works)
    } finally { library.destroy() }
  })

  it('真实刷新经历书转漫再转多本书，不丢别名标志与首组偏好，不复制偏好到新作品', async () => {
    const root = file(1, '/阅读', true), books = [file(2, '/阅读/星河 第1卷.epub'), file(3, '/阅读/星河 第2卷.epub')]
    const mock = memoryDrive([root, ...books], { source: '/阅读' }), library = new ReadingLibrary(mock.drive, 'all')
    try {
      await library.initialize(); await library.refresh()
      const original = library.snapshot.works.rows, primaryId = original[0]!.id, aliasId = original[1]!.id
      const preferences = new PreferenceStore(mock.drive, readerDefaultPreferences)
      const saved = await preferences.saveWork(await preferences.loadWork(primaryId), 'comic', { direction: 'rtl', mode: 'double' })
      const flag = await library.reading.setFlags(aliasId, await library.reading.flags(aliasId), { favorite: true, wantToRead: true })
      mock.nodes.set(2, file(2, '/阅读/星河 第1卷.cbz'))
      mock.nodes.set(3, file(3, '/阅读/星河 第2卷.zip'))
      await library.refresh()
      expect(library.snapshot.works.rows.find(work => work.id === primaryId)).toMatchObject({ kind: 'comics', members: [{ unitId: 2 }, { unitId: 3 }] })
      let state = await library.loadReadingState()
      expect(library.query({ favorite: true, wantToRead: true }, state.readings, state.flags).total).toBe(1)
      for (const book of books) mock.nodes.set(book.id, book)
      await library.refresh()
      const works = library.snapshot.works.rows, active = works.filter(work => !work.redirectTo)
      expect(active).toHaveLength(2)
      expect(active.every(work => work.kind === 'books' && work.members.length === 1)).toBe(true)
      expect(active[0]!.id).toBe(primaryId)
      expect(active[1]!.id).not.toBe(aliasId)
      expect(works.find(work => work.id === aliasId)?.redirectTo).toBe(primaryId)
      expect(await preferences.loadWork(primaryId)).toEqual(saved)
      expect((await preferences.loadWork(active[1]!.id)).value.overrides).toEqual({})
      expect(await library.reading.flags(aliasId)).toEqual(flag)
      state = await library.loadReadingState()
      const favorite = library.query({ favorite: true }, state.readings, state.flags)
      expect(favorite.items.map(item => item.work?.id)).toEqual([primaryId])
      await library.refresh()
      expect(library.snapshot.works.rows).toEqual(works)
    } finally { library.destroy() }
  })

  it('一次扫描发现书漫及直属图片目录，按真实格式归组，重扫保持作品身份', async () => {
    const entries = [file(1, '/阅读', true), file(2, '/阅读/星河 第1卷.txt'), file(3, '/阅读/星河 第2卷.epub'),
      file(4, '/阅读/文档.pdf'), file(5, '/阅读/星河 第1卷.cbz'), file(6, '/阅读/星河 第2卷.zip'),
      file(7, '/阅读/图片章', true), file(8, '/阅读/图片章/001.jpg'), file(9, '/阅读/空目录', true), file(10, '/阅读/其他.mp4')]
    const mock = memoryDrive(entries, { source: '/阅读' }), library = new ReadingLibrary(mock.drive, 'all')
    try {
      await library.initialize(); await library.refresh()
      expect(library.snapshot.complete).toBe(true)
      expect(library.snapshot.units.map(unit => unit.nodeId).sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7])
      const works = library.snapshot.works.rows
      expect(works.filter(work => work.kind === 'books')).toHaveLength(3)
      const comic = works.find(work => work.members.length === 2)!
      expect(comic).toMatchObject({ kind: 'comics', orderConfirmed: true })
      expect(comic.members.map(member => member.unitId)).toEqual([5, 6])
      expect(works.every(work => work.members.every(member => contentKind(library.snapshot.units.find(unit => unit.nodeId === member.unitId)!.format) === work.kind))).toBe(true)
      for (const unit of library.snapshot.units) expect((await library.openUnit(unit.nodeId)).format).toBe(unit.format)
      await library.refresh()
      expect(library.snapshot.works.rows).toEqual(works)
      expect(library.query({ kind: 'books' }).total).toBe(3)
      expect(library.query({ kind: 'comics' }).total).toBe(2)
      expect(library.query({ kind: 'comics', format: 'txt' }).total).toBe(0)
    } finally { library.destroy() }
  })

  it('书与漫共用历史、想读、收藏及状态筛选，未加载状态不会成为未读', async () => {
    const root = file(1, '/阅读', true), book = file(2, '/阅读/正文.txt'), comic = file(3, '/阅读/图像.cbz')
    const mock = memoryDrive([root, book, comic], { source: '/阅读' }), library = new ReadingLibrary(mock.drive, 'all')
    try {
      await library.initialize(); await library.refresh()
      expect(library.query({ status: 'unread' }).total).toBe(0)
      expect(library.query({ status: 'unknown' }).total).toBe(2)
      const bookProgress = await library.reading.saveProgress({ file: book, title: '正文', location: { format: 'txt', index: 2, offset: 91 } }, null, signal())
      const comicProgress = await library.reading.saveProgress({ file: comic, title: '图像', location: { format: 'comic', index: 4 } }, null, signal())
      for (const work of library.snapshot.works.rows) {
        const base = await library.reading.flags(work.id)
        await library.reading.setFlags(work.id, base, { favorite: true, wantToRead: true })
      }
      const state = await library.loadReadingState()
      expect(library.query({ favorite: true }, state.readings, state.flags).total).toBe(2)
      expect(library.query({ wantToRead: true, kind: 'books' }, state.readings, state.flags).total).toBe(1)
      expect(library.query({ status: 'reading' }, state.readings, state.flags).total).toBe(2)
      expect(library.history.snapshot.rows.map(row => row.nodeId)).toEqual([3, 2])
      expect(mock.records.get('progress:2')).toEqual(bookProgress.record)
      expect(mock.records.get('progress:3')).toEqual(comicProgress.record)
      expect(aggregateReading([])).toMatchObject({ status: 'unknown', percent: undefined })
      expect(unitFormat(file(99, '/阅读/001.png'), 'all')).toBeUndefined()
    } finally { library.destroy() }
  })

  it('新阅读馆空偏好默认文字分页与漫画适宽，已存 V1 保留滚动、RTL 与适宽，不自动重写', async () => {
    const mock = memoryDrive(), store = new PreferenceStore(mock.drive, readerDefaultPreferences)
    const initial = await store.load()
    expect(resolvePreferences(initial.value, 'text').mode).toBe('page')
    expect(resolvePreferences(initial.value, 'comic')).toMatchObject({ mode: 'single', fit: 'width' })
    expect(resolvePreferences(initial.value, 'pdf').fit).toBe('page')
    const old = mock.seed('preferences', { mode: 'scroll', direction: 'rtl', fit: 'width', theme: 'dark' })
    const loaded = await store.load()
    expect(loaded.migrated).toBe(true)
    expect(resolvePreferences(loaded.value, 'text').mode).toBe('scroll')
    expect(resolvePreferences(loaded.value, 'comic')).toMatchObject({ mode: 'scroll', fit: 'width', direction: 'rtl' })
    expect(resolvePreferences(loaded.value, 'pdf').fit).toBe('width')
    expect(mock.records.get('preferences')).toEqual(old)
    expect(mock.set).not.toHaveBeenCalled()
  })
})
