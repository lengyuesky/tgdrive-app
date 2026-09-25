import { afterEach, describe, expect, it, vi } from 'vitest'
import { CoverStore, coverHash } from './cover-store'
import { memoryDrive } from './library/test-fixtures'

const cover = (tag: string) => `data:image/webp;base64,${btoa(tag)}`
afterEach(() => { vi.useRealTimers() })

describe('服务器封面库客户端', () => {
  it('同一轮读取合并为批量请求，每批最多 16 个键，只返回命中项', async () => {
    const mock = memoryDrive()
    for (let index = 0; index < 20; index++) await mock.drive.covers.put(`unit:${index}`, cover(String(index)), { i: index })
    mock.coverGet.mockClear()
    const store = new CoverStore<{ i: number }>(mock.drive)
    const results = await Promise.all([...Array.from({ length: 20 }, (_, index) => store.get(`unit:${index}`)), store.get('unit:99'), store.get('unit:3')])
    expect(mock.coverGet).toHaveBeenCalledTimes(2)
    expect(mock.coverGet.mock.calls.map(([keys]) => keys.length)).toEqual([16, 5])
    expect(results[3]).toEqual({ data: cover('3'), meta: { i: 3 } })
    expect(results[20]).toBeUndefined(); expect(results[21]).toEqual(results[3])
    // 命中后进入内存，不再请求宿主；返回副本，调用方改动不污染缓存。
    results[3]!.meta!.i = 100
    expect(await store.get('unit:3')).toEqual({ data: cover('3'), meta: { i: 3 } })
    expect(mock.coverGet).toHaveBeenCalledTimes(2)
    store.destroy()
  })
  it('写入先进内存立即可读，后台逐张写入；单张失败不影响其他封面', async () => {
    const mock = memoryDrive(), store = new CoverStore(mock.drive)
    mock.coverPut.mockRejectedValueOnce(Object.assign(new Error('单张封面最多 256 KiB'), { status: 400 }))
    const first = store.set('unit:1', cover('a')), second = store.set('unit:2', cover('b'), { h: 'x' })
    expect(await store.get('unit:1')).toEqual({ data: cover('a'), meta: null })
    expect(await first).toBe(false); expect(await second).toBe(true)
    expect(store.mode).toBe('persistent')
    expect(mock.coverRecords.has('unit:1')).toBe(false); expect(mock.coverRecords.get('unit:2')).toMatchObject({ meta: { h: 'x' } })
    expect(await store.set('unit:3', cover('c'))).toBe(true)
    expect(await store.delete('unit:2')).toBe(true); expect(mock.coverRecords.has('unit:2')).toBe(false)
    expect(await store.stats()).toMatchObject({ entries: 1 })
    store.destroy()
  })
  it('宿主读取失败按未命中处理；取消只影响自己的等待', async () => {
    const mock = memoryDrive(); await mock.drive.covers.put('unit:1', cover('a'))
    const store = new CoverStore(mock.drive)
    mock.coverGet.mockRejectedValueOnce(Object.assign(new Error('应用请求过于频繁'), { code: 'rate_limited' }))
    expect(await store.get('unit:1')).toBeUndefined()
    const controller = new AbortController(), cancelled = store.get('unit:1', controller.signal), kept = store.get('unit:1')
    controller.abort()
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    expect(await kept).toEqual({ data: cover('a'), meta: null })
    const pending = new CoverStore(mock.drive), waiting = pending.get('unit:1')
    pending.destroy()
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    store.destroy()
  })
  it('内存一级缓存按条数与字节淘汰最久未用', async () => {
    const mock = memoryDrive([], {}, { covers: false }), store = new CoverStore(mock.drive, { entries: 2, bytes: 1024 })
    await store.set('a', cover('a')); await store.set('b', cover('b'))
    await store.get('a'); await store.set('c', cover('c'))
    expect(await store.get('b')).toBeUndefined(); expect(await store.get('a')).toBeDefined()
    await store.set('big', `data:image/webp;base64,${'A'.repeat(2048)}`)
    expect(await store.get('big')).toBeUndefined()
    expect(store.mode).toBe('session'); expect(await store.stats()).toBeNull()
    expect(mock.coverPut).not.toHaveBeenCalled(); expect(mock.coverGet).not.toHaveBeenCalled()
    store.destroy()
  })
  it('摘要稳定且区分内容', () => {
    expect(coverHash('a')).toBe(coverHash('a')); expect(coverHash('a')).not.toBe(coverHash('b'))
  })
})
