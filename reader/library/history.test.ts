import { describe, expect, it, vi } from 'vitest'
import { HistoryStore } from './history'
import { LibraryAccess } from './sources'
import { deferred, file, memoryDrive, signal, sources } from './test-fixtures'
import type { LibraryProgress } from './model'

function setup(count: number) {
  const root = file(1, '/书', true), files = Array.from({ length: count }, (_, index) => file(index + 2, `/书/历史${index}.txt`)), mock = memoryDrive([root, ...files]), access = new LibraryAccess(mock.drive)
  access.setSources(sources(root))
  files.forEach((entry, index) => mock.seed(`progress:${entry.id}`, { file: entry, title: entry.name, location: { format: 'txt', index: 0 } } satisfies LibraryProgress, index + 10))
  return { ...mock, files, root, access, history: new HistoryStore(mock.drive, access) }
}
describe('HistoryStore 时间排序和分页迁移', () => {
  it('跨 storage 键序分页找真正最新记录，有界保留 2000 条，不删原进度', async () => {
    const mock = setup(2050), latest = mock.files.find(file => file.id === 9)!
    mock.seed('progress:9', { file: latest, title: '最后更新时间', location: { format: 'txt', index: 3 } }, 90000)
    const state = await mock.history.migrate({ signal: signal() })
    expect(state).toMatchObject({ complete: true, retained: 2000, scanned: 2050, truncated: true })
    const pages = mock.storageList.mock.calls.filter(([params]) => params?.prefix === 'progress:')
    expect(pages).toHaveLength(11)
    expect(pages.every(([params]) => params?.limit === 200)).toBe(true)
    const page = await mock.history.page(0, 5, signal())
    expect(page.entries[0]!.nodeId).toBe(9)
    expect(page.entries.map(entry => entry.updatedAt)).toEqual([90000, 2059, 2058, 2057, 2056])
    expect(page).toMatchObject({ limited: true, complete: true, nextOffset: 5 })
    expect([...mock.records.keys()].filter(key => key.startsWith('progress:'))).toHaveLength(2050)
    expect(mock.remove).not.toHaveBeenCalled(); expect(mock.readRange).not.toHaveBeenCalled()
    const reopened = new HistoryStore(mock.drive, mock.access)
    expect((await reopened.load()).rows[0]!.nodeId).toBe(9)
  })
  it('取消保留已整理范围和游标，恢复迁移继续下一批而非伪装全历史', async () => {
    const mock = setup(450), controller = new AbortController(), progress = vi.fn(() => controller.abort())
    const partial = await mock.history.migrate({ signal: controller.signal, onProgress: progress })
    expect(partial).toMatchObject({ complete: false, scanned: 200, retained: 200 })
    expect(partial.message).toContain('已取消')
    const cursor = partial.cursor
    expect(cursor).not.toBeNull()
    const migrated = await mock.history.migrate({ signal: signal(), resume: true })
    expect(migrated).toMatchObject({ complete: true, retained: 450, scanned: 450 })
    const requests = mock.storageList.mock.calls.filter(([params]) => params?.prefix === 'progress:')
    expect(requests[1]![0]?.cursor).toBe(cursor)
  })
  it('失败不清空旧索引，未知 progress 不迁移，单条新进度按 updated_at 更新', async () => {
    const mock = setup(4)
    await mock.history.migrate({ signal: signal() })
    mock.storageList.mockRejectedValueOnce(new Error('网络失败'))
    const failed = await mock.history.migrate({ signal: signal() })
    expect(failed.complete).toBe(false); expect(mock.history.snapshot.rows).toHaveLength(4)
    mock.seed('progress:999', { bad: true }, 99999)
    await mock.history.migrate({ signal: signal() })
    expect(mock.history.snapshot.rows.map(entry => entry.nodeId)).not.toContain(999)
    const progress: LibraryProgress = { file: mock.files[0]!, title: '新进度', location: { format: 'txt', index: 4 } }
    await mock.history.record(mock.seed(`progress:${progress.file.id}`, progress, 88888) as Parameters<HistoryStore['record']>[0])
    expect(mock.history.snapshot.rows[0]!.nodeId).toBe(progress.file.id)
  })
  it('更新历史时回收刚替换的缓存分片，不让每次进度保存永久累积整份历史', async () => {
    const mock = setup(30)
    await mock.history.migrate({ signal: signal() })
    const shardCount = () => [...mock.records.keys()].filter(key => key.startsWith('library:cache:history:shard:')).length
    const initial = shardCount()
    for (let index = 0; index < 6; index++) {
      const progress: LibraryProgress = { file: mock.files[0]!, title: '正文', location: { format: 'txt', index } }
      await mock.history.record(mock.seed(`progress:${progress.file.id}`, progress, 1000 + index) as Parameters<HistoryStore['record']>[0])
      expect(shardCount()).toBe(initial)
    }
    expect(mock.remove.mock.calls.every(([key]) => key.startsWith('library:cache:history:shard:'))).toBe(true)
    expect([...mock.records.keys()].filter(key => key.startsWith('progress:'))).toHaveLength(30)
    const get = mock.get.getMockImplementation()!
    mock.get.mockImplementationOnce(async (key, options) => {
      const old = await get(key, options)
      const progress: LibraryProgress = { file: mock.files[0]!, title: '新一轮', location: { format: 'txt', index: 99 } }
      await mock.history.record(mock.seed(`progress:${progress.file.id}`, progress, 9000) as Parameters<HistoryStore['record']>[0])
      return old
    })
    const concurrent = await new HistoryStore(mock.drive, mock.access).load()
    expect(concurrent.rows[0]!.progress.location.index).toBe(99)
  })
  it('慢快照不能盖掉同期刚记录的最近阅读，旧迁移取消后不再发布进度回调', async () => {
    const mock = setup(4); await mock.history.migrate({ signal: signal() })
    const gate = deferred(), started = deferred(), get = mock.get.getMockImplementation()!
    let hold = true
    mock.get.mockImplementation(async (key, options) => { const value = await get(key, options); if (hold && key.includes(':shard:')) { hold = false; started.resolve(); await gate.promise } return value })
    const slow = mock.history.load(); await started.promise
    const progress: LibraryProgress = { file: mock.files[0]!, title: '最新阅读', location: { format: 'txt', index: 99 } }
    await mock.history.record(mock.seed(`progress:${progress.file.id}`, progress, 9000) as Parameters<HistoryStore['record']>[0])
    gate.resolve(); expect((await slow).rows[0]!.updatedAt).toBe(9000); expect(mock.history.snapshot.rows[0]!.progress.location.index).toBe(99)
    const next = deferred(), requested = deferred(), list = mock.storageList.getMockImplementation()!, onProgress = vi.fn()
    mock.storageList.mockImplementationOnce(async (params, options) => { const page = await list(params, options); requested.resolve(); await next.promise; return page })
    const migration = mock.history.migrate({ signal: signal(), onProgress })
    await requested.promise; mock.history.cancel(); next.resolve()
    expect((await migration).complete).toBe(false); expect(onProgress).not.toHaveBeenCalled()
  })
  it('移除来源只隐藏、重新纳入恢复，版本变化不恢复旧位置；慢 stat 切范围不泄露旧页', async () => {
    const mock = setup(2)
    await mock.history.migrate({ signal: signal() })
    const old = structuredClone(mock.records.get('progress:2'))
    mock.access.setSources({ config: { schemaVersion: 1, sources: [] }, revision: 'removed' })
    expect((await mock.history.page(0, 20, signal())).entries).toEqual([])
    mock.access.setSources(sources(mock.root))
    mock.nodes.set(2, { ...mock.files[0]!, content_version: 'v2' })
    const page = await mock.history.page(0, 20, signal())
    expect(page.entries).toHaveLength(2)
    expect(page.entries.find(entry => entry.nodeId === 2)?.location).toBeUndefined()
    expect(mock.records.get('progress:2')).toEqual(old)
    const original = mock.stat.getMockImplementation()!
    mock.stat.mockImplementation(async (ref, options) => {
      const result = await original(ref, options)
      if ('id' in ref && ref.id !== 1) mock.access.setSources({ config: { schemaVersion: 1, sources: [] }, revision: 'changed' })
      return result
    })
    await expect(mock.history.page(0, 20, signal())).rejects.toMatchObject({ name: 'AbortError' })
    expect(mock.remove).not.toHaveBeenCalled()
  })
})
