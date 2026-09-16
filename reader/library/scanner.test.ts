import { describe, expect, it, vi } from 'vitest'
import { LibraryScanner, mergeScan, type ScanHandle } from './scanner'
import { LibraryAccess } from './sources'
import { deferred, file, memoryDrive, signal, sources, unit } from './test-fixtures'

function setup(files: ReturnType<typeof file>[], kind: 'books' | 'comics' = 'books') {
  const root = file(1, '/书', true), mock = memoryDrive([root, ...files]), access = new LibraryAccess(mock.drive)
  access.setSources(sources(root))
  return { ...mock, root, access, scanner: new LibraryScanner(access, kind) }
}
describe('LibraryScanner 有界轻扫描', () => {
  it('1000 个合成图书按 200 批流式发现，只读文件信息，不读正文或元数据', async () => {
    const files = Array.from({ length: 1000 }, (_, index) => file(index + 2, `/书/合成${index}.txt`)), mock = setup(files), batches: number[] = []
    const result = await mock.scanner.start({ previous: [unit(files[0]!, [1], 3)], onBatch: batch => batches.push(batch.length) }).result
    expect(result).toMatchObject({ complete: true, end: 'complete', nodes: 1000, units: 1000, directories: 1 })
    expect(batches).toEqual([200, 200, 200, 200, 200])
    expect(mock.list).toHaveBeenCalledTimes(5)
    expect(mock.list.mock.calls.every(([params]) => params.limit === 200)).toBe(true)
    expect(result.unitsFound[0]!.firstIndexedAt).toBe(3)
    expect(new Set(result.unitsFound.map(unit => unit.nodeId)).size).toBe(1000)
    expect(mock.readRange).not.toHaveBeenCalled(); expect(mock.drive.media.url).not.toHaveBeenCalled(); expect(mock.drive.assets.read).not.toHaveBeenCalled()
  })
  it('到 2000 阅读单元即标记不完整，文件视图仍可通过 SDK 游标找到第 2001 本', async () => {
    const files = Array.from({ length: 2001 }, (_, index) => file(index + 2, `/书/${index}.epub`)), mock = setup(files)
    const result = await mock.scanner.start().result
    expect(result).toMatchObject({ complete: false, end: 'unit-limit', units: 2000 })
    expect(result.unitsFound).toHaveLength(2000)
    expect(result.issues[0]!.message).toContain('文件视图')
    const page = await mock.access.list(1, '2000', signal())
    expect(page.entries).toEqual([files[2000]])
    expect(page.has_more).toBe(false)
  })
  it('目录集合最多 10000，达到目录上限不继续分配队列', async () => {
    const mock = setup(Array.from({ length: 10000 }, (_, index) => file(index + 2, `/书/目录${index}`, true)))
    const result = await mock.scanner.start().result
    expect(result).toMatchObject({ complete: false, end: 'directory-limit', directories: 10000, units: 0 })
    expect(mock.list.mock.calls.every(([params]) => params.path === '/书')).toBe(true)
  })
  it('父子来源去重；图片仅标识直属目录，混放漫画归档独立保留', async () => {
    const folder = file(2, '/书/图集', true), files = [folder, file(3, '/书/故事 第1卷.cbz'), file(4, '/书/图集/故事 第2卷.zip'),
      ...Array.from({ length: 420 }, (_, index) => file(index + 10, `/书/图集/${index}.png`))]
    const mock = setup(files, 'comics')
    mock.access.setSources(sources(mock.root, folder))
    const result = await mock.scanner.start().result
    expect(result).toMatchObject({ complete: true, units: 3, directories: 2 })
    expect(result.unitsFound.map(unit => unit.nodeId).sort()).toEqual([2, 3, 4])
    expect(result.unitsFound.find(unit => unit.nodeId === 2)).toEqual(expect.objectContaining({ format: 'images', sourceIds: [1, 2] }))
    expect(JSON.stringify(result.unitsFound)).not.toContain('.png')
    expect(mock.list.mock.calls.filter(([params]) => params.path === '/书/图集')).toHaveLength(3)
  })
  it('失败、坏游标和取消保留旧记录，只有成功全扫描才核对消失项', async () => {
    const old = unit(file(99, '/书/旧记录.txt')), mock = setup([file(2, '/书/当前.txt')])
    mock.list.mockRejectedValueOnce(new Error('目录读取失败'))
    const failure = await mock.scanner.start().result
    expect(failure).toMatchObject({ complete: false, end: 'failed' })
    expect(mergeScan([old], failure).units).toEqual([old])
    mock.list.mockResolvedValueOnce({ path: '/书', entries: [], has_more: true, next_cursor: null })
    expect((await mock.scanner.start().result).issues).toEqual([expect.objectContaining({ code: 'invalid_cursor' })])
    const controller = new AbortController(); controller.abort()
    const cancelled = await mock.scanner.start({ signal: controller.signal }).result
    expect(cancelled).toMatchObject({ complete: false, end: 'cancelled' })
    expect(mergeScan([old], cancelled)).toMatchObject({ units: [old], complete: false })
    const success = await mock.scanner.start().result
    expect(mergeScan([old], success).units.map(unit => unit.nodeId)).toEqual([2])
  })
  it('按批取消会返回已完成部分，不把局部发现覆盖成全库', async () => {
    const mock = setup(Array.from({ length: 800 }, (_, index) => file(index + 2, `/书/${index}.txt`)))
    let handle: ScanHandle
    handle = mock.scanner.start({ onBatch: () => handle.cancel() })
    const result = await handle.result
    expect(result).toMatchObject({ units: 200, complete: false, end: 'cancelled' })
    expect(mock.list).toHaveBeenCalledTimes(1)
    const merged = mergeScan([unit(file(9999, '/书/保留.txt'))], result)
    expect(merged.units).toHaveLength(201)
    expect(merged.units[0]!.nodeId).toBe(9999)
  })
  it('首次来源请求尚未返回即可暂停，恢复后继续；快速暂停恢复不会误取消', async () => {
    const mock = setup([file(2, '/书/一本.txt')]), progress = vi.fn()
    const handle = mock.scanner.start({ onProgress: progress })
    handle.pause()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(mock.list).not.toHaveBeenCalled()
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'paused', complete: false }))
    handle.resume()
    expect((await handle.result).complete).toBe(true)
    const original = mock.list.getMockImplementation()!, started = deferred()
    mock.list.mockImplementationOnce(async (_params, options) => {
      started.resolve()
      return new Promise((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(new DOMException('读取已取消', 'AbortError')), { once: true }))
    })
    const second = mock.scanner.start()
    await started.promise; second.pause(); second.resume()
    expect((await second.result).complete).toBe(true)
    mock.list.mockImplementation(original)
  })
  it('扫描期间目录版本改变标记不完整；来源代次改变时旧结果不可当成功', async () => {
    const mock = setup(Array.from({ length: 300 }, (_, index) => file(index + 2, `/书/${index}.txt`)))
    const result = await mock.scanner.start({ onBatch: () => mock.nodes.set(1, { ...mock.root, content_version: 'v2' }) }).result
    expect(result).toMatchObject({ complete: false, units: 200, end: 'failed' })
    expect(result.issues[0]!.code).toBe('directory_changed')
    const waiting = deferred(), started = deferred(), original = mock.list.getMockImplementation()!
    mock.list.mockImplementationOnce(async (params, options) => { const page = await original(params, options); started.resolve(); await waiting.promise; return page })
    const pending = mock.scanner.start()
    await started.promise; mock.access.setSources({ config: { schemaVersion: 1, sources: [] }, revision: 'next' }); waiting.resolve()
    expect((await pending.result).complete).toBe(false)
  })
})
