import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryHost, type SeedNode } from '@tgdrive/test-host'
import { LibraryScanner, mergeScan, type ScanHandle } from './scanner'
import { LibraryAccess } from './sources'
import { deferred, file, memoryHost, sources, unit } from './test-fixtures'
import type { LibraryScope } from './model'
const directHosts = new Set<MemoryHost>()
afterEach(async () => { await Promise.all([...directHosts].map(host => host.dispose())); directHosts.clear() })
async function setup(entries: ReturnType<typeof file>[], kind: LibraryScope = 'books') {
  const root = file(1, '/书', true), mock = await memoryHost([root, ...entries]), access = new LibraryAccess(mock.host)
  access.setSources(sources(root)); return { ...mock, root, access, scanner: new LibraryScanner(access, kind) }
}
describe('通用文件发现与弱一致增量核对', () => {
  it('一千本书按 200 项应用批次发现，保留首次时间，不列树或读取正文', async () => {
    const entries = Array.from({ length: 1000 }, (_, index) => file(index + 2, `/书/合成${String(index).padStart(4, '0')}.txt`)), mock = await setup(entries), batches: number[] = []
    const result = await mock.scanner.start({ previous: [unit(entries[0]!, [mock.root.id], 3)], onBatch: batch => batches.push(batch.length) }).result
    expect(result).toMatchObject({ complete: true, end: 'complete', nodes: 1000, units: 1000, directories: 1 })
    expect(batches).toEqual([200, 200, 200, 200, 200]); expect(result.unitsFound[0]!.firstIndexedAt).toBe(3)
    expect(new Set(result.unitsFound.map(entry => entry.nodeId)).size).toBe(1000)
    expect(mock.query.mock.calls.every(([request]) => request.limit === 200 && request.filter.extensions.includes('txt'))).toBe(true)
    expect(mock.list).not.toHaveBeenCalled(); expect(mock.readRange).not.toHaveBeenCalled()
  })
  it('超过一万本长路径书库的字节截页仍完整，绝不按页内数量或旧 2000 上限结束', async () => {
    const nodes: SeedNode[] = []
    let parent = '1'
    for (let index = 0; index < 15; index++) { const id = String(index + 2); nodes.push({ id, parent_id: parent, name: `层${index}-` + 'd'.repeat(232), kind: 'directory' }); parent = id }
    for (let index = 0; index < 10000; index++) nodes.push({ id: String(index + 1000), parent_id: parent, name: `书_${String(index).padStart(5, '0')}_` + 'n'.repeat(150) + '.txt', kind: 'file', bytes: [] })
    const host = await MemoryHost.create({ now: Date.now(), app: { id: 'reader', name: '书库分页测试', version: '2.0.0', generation: 'g1' }, files: { read: true, write: false }, scope: { mode: 'all', access: 'read_only' }, nodes }); directHosts.add(host)
    const root = await host.stat({ by: 'id', id: parent }), access = new LibraryAccess(host); access.setSources(sources(root))
    const real = host.query.bind(host), lengths: number[] = [], continuedShort: boolean[] = []
    vi.spyOn(host, 'query').mockImplementation(async (request, options) => { const page = await real(request, options); lengths.push(page.items.length); continuedShort.push(page.items.length < request.limit && page.next_cursor !== null); return page })
    const result = await new LibraryScanner(access, 'books').start().result
    expect(result.complete).toBe(true); expect(result.unitsFound).toHaveLength(10000); expect(new Set(result.unitsFound.map(entry => entry.nodeId)).size).toBe(10000)
    expect(continuedShort.some(Boolean)).toBe(true); expect(lengths.length).toBeGreaterThan(50); expect(result.changeCursor).toBeTruthy()
  }, 120000)
  it('父子来源去重，图片只发现直属目录，漫画归档仍独立，隐藏项不入库', async () => {
    const folder = file(2, '/书/图集', true), mock = await setup([folder, file(3, '/书/故事 第1卷.cbz'), file(4, '/书/图集/故事 第2卷.zip'), file(5, '/书/.隐藏.txt'), ...Array.from({ length: 420 }, (_, index) => file(index + 10, `/书/图集/${index}.png`))], 'all')
    mock.access.setSources(sources(mock.root, folder))
    const result = await mock.scanner.start().result
    expect(result).toMatchObject({ complete: true, units: 3, directories: 2 }); expect(result.unitsFound.map(entry => entry.nodeId).sort()).toEqual(['2', '3', '4'])
    expect(result.unitsFound.find(entry => entry.nodeId === '2')).toMatchObject({ format: 'images', sourceIds: [mock.root.id, folder.id] })
    expect(JSON.stringify(result.unitsFound)).not.toContain('.png'); expect(mock.directoriesWithFiles).toHaveBeenCalled(); expect(mock.list).not.toHaveBeenCalled()
  })
  it('第一页之后新增、覆盖、改名或移除的文件由同一 scan_cursor 核对', async () => {
    const entries = Array.from({ length: 301 }, (_, index) => file(index + 2, `/书/${String(index).padStart(4, '0')}.txt`)), mock = await setup(entries), read = mock.query.getMockImplementation()!
    let changed = false
    mock.query.mockImplementation(async (...args) => {
      const page = await read(...args)
      if (!changed) {
        changed = true
        await mock.host.addNode({ id: '999', parent_id: mock.root.id, name: '0000-新增.txt', kind: 'file', bytes: [] })
        await mock.host.changeNode({ id: '2', visible: false }); await mock.host.changeNode({ id: '3', name: '改名.txt', bytes: [8] })
      }
      return page
    })
    const result = await mock.scanner.start().result
    expect(result.complete).toBe(true); expect(result.unitsFound).toHaveLength(301); expect(result.unitsFound.some(entry => entry.nodeId === '2')).toBe(false)
    expect(result.unitsFound.find(entry => entry.nodeId === '999')?.file.name).toBe('0000-新增.txt'); expect(result.unitsFound.find(entry => entry.nodeId === '3')?.file.name).toBe('改名.txt')
    expect(mock.changes.mock.calls[0]?.[0].cursor).toBeTruthy()
  })
  it('失败与取消保留旧记录，成功扫描才移除消失项', async () => {
    const old = unit(file(99, '/书/旧.txt')), mock = await setup([file(2, '/书/当前.txt')])
    mock.query.mockRejectedValueOnce(new Error('查询失败'))
    const failed = await mock.scanner.start().result; expect(failed).toMatchObject({ complete: false, end: 'failed' }); expect(mergeScan([old], failed).units).toEqual([old])
    const controller = new AbortController(); controller.abort()
    const cancelled = await mock.scanner.start({ signal: controller.signal }).result; expect(cancelled.end).toBe('cancelled'); expect(mergeScan([old], cancelled).units).toEqual([old])
    expect(mergeScan([old], await mock.scanner.start().result).units.map(entry => entry.nodeId)).toEqual(['2'])
  })
  it('按批取消只返回已完成部分，不把局部发现发布成全库', async () => {
    const mock = await setup(Array.from({ length: 800 }, (_, index) => file(index + 2, `/书/${index}.txt`)))
    let handle: ScanHandle
    handle = mock.scanner.start({ onBatch: () => handle.cancel() })
    const result = await handle.result; expect(result).toMatchObject({ units: 200, complete: false, end: 'cancelled' })
    expect(mergeScan([unit(file(9999, '/书/保留.txt'))], result).units).toHaveLength(201)
  })
  it('初始暂停及在途暂停恢复不会误当取消，也不丢失当前游标', async () => {
    const mock = await setup([file(2, '/书/一本.txt')]), progress = vi.fn(), first = mock.scanner.start({ onProgress: progress })
    first.pause(); await new Promise(resolve => setTimeout(resolve, 10)); expect(mock.query).not.toHaveBeenCalled(); expect(progress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'paused' }))
    first.resume(); expect((await first.result).complete).toBe(true)
    const started = deferred()
    mock.query.mockImplementationOnce(async (_request, options) => { started.resolve(); return new Promise((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true })) })
    const second = mock.scanner.start(); await started.promise; second.pause(); second.resume(); expect((await second.result).complete).toBe(true)
  })
  it('来源代次变化使迟到扫描失效，不能覆盖新来源', async () => {
    const mock = await setup([file(2, '/书/正文.txt')]), wait = deferred(), entered = deferred(), read = mock.query.getMockImplementation()!
    mock.query.mockImplementationOnce(async (...args) => { const page = await read(...args); entered.resolve(); await wait.promise; return page })
    const pending = mock.scanner.start(); await entered.promise; mock.access.setSources({ config: { schemaVersion: 1, sources: [] }, revision: 'next' }); wait.resolve()
    expect((await pending.result).complete).toBe(false)
  })
})
