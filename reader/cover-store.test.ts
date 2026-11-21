import { afterEach, describe, expect, it, vi } from 'vitest'
import { CoverStore, coverHash } from './cover-store'
import { file, memoryHost } from './library/test-fixtures'
import { contentRef } from './files'
const cover = (tag: string) => `data:image/webp;base64,${btoa(tag)}`
afterEach(() => { vi.useRealTimers() })

async function setup() {
  const source = file(2, '/源.bin'), mock = await memoryHost([source])
  return { ...mock, source, sources: [contentRef(source)] }
}
describe('通用小对象封面缓存', () => {
  it('同一轮读取按 64 键合并，只返回命中项并复用热点副本', async () => {
    const mock = await setup()
    for (let index = 0; index < 70; index++) await mock.host.cachePut(`unit:${index}`, new Uint8Array([index]), 'image/webp', { metadata: { i: index }, sources: mock.sources })
    mock.cacheLookup.mockClear()
    const store = new CoverStore<{ i: number }>(mock.host)
    const results = await Promise.all([...Array.from({ length: 70 }, (_, index) => store.get(`unit:${index}`)), store.get('unit:99'), store.get('unit:3')])
    expect(mock.cacheLookup).toHaveBeenCalledTimes(2)
    expect(mock.cacheLookup.mock.calls.map(([request]) => request.keys.length)).toEqual([64, 7])
    expect(results[3]?.meta).toEqual({ i: 3 }); expect(results[3]?.data).toContain('/cache-media/')
    expect(results[70]).toBeUndefined(); expect(results[71]).toEqual(results[3])
    results[3]!.meta!.i = 100
    expect((await store.get('unit:3'))?.meta).toEqual({ i: 3 })
    expect(mock.cacheLookup).toHaveBeenCalledTimes(2)
    store.destroy()
  })
  it('写入先进热点，单张失败不影响其他图；删除与统计走通用缓存', async () => {
    const mock = await setup(), store = new CoverStore(mock.host)
    mock.cachePut.mockRejectedValueOnce(new Error('单张写入失败'))
    const first = store.set('unit:1', cover('a'), null, mock.sources), second = store.set('unit:2', cover('b'), { h: 'x' }, mock.sources)
    expect(await store.get('unit:1')).toEqual({ data: cover('a'), meta: null })
    expect(await first).toBe(false); expect(await second).toBe(true)
    expect(store.mode).toBe('persistent')
    expect((await mock.host.cacheLookup({ keys: ['unit:1', 'unit:2'] })).hits.map(hit => hit.entry.key)).toEqual(['unit:2'])
    expect(await store.set('unit:3', cover('c'), null, mock.sources)).toBe(true)
    expect(await store.delete('unit:2')).toBe(true)
    expect((await mock.host.cacheLookup({ keys: ['unit:2'] })).hits).toHaveLength(0)
    expect((await store.stats()).cache_bytes).toBe('1')
    store.destroy()
  })
  it('宿主读取失败按未命中处理，取消只影响自己的等待，销毁拒绝等待者', async () => {
    const mock = await setup()
    await mock.host.cachePut('unit:1', new Uint8Array([1]), 'image/webp', { metadata: null, sources: mock.sources })
    const store = new CoverStore(mock.host)
    mock.cacheLookup.mockRejectedValueOnce(new Error('读取失败'))
    expect(await store.get('unit:1')).toBeUndefined()
    const controller = new AbortController(), cancelled = store.get('unit:1', controller.signal), kept = store.get('unit:1')
    controller.abort(); await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    expect((await kept)?.data).toContain('/cache-media/')
    const pending = new CoverStore(mock.host), waiting = pending.get('unit:1'); pending.destroy()
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    store.destroy()
  })
  it('热点按条数与字节淘汰，持久对象仍可重取；无来源或超对象预算不保存', async () => {
    const mock = await setup(), store = new CoverStore(mock.host, { entries: 2, bytes: 1024 })
    await store.set('a', cover('a'), null, mock.sources); await store.set('b', cover('b'), null, mock.sources)
    await store.get('a'); await store.set('c', cover('c'), null, mock.sources)
    expect(store.memoryStatus.entries).toBe(2)
    mock.cacheLookup.mockClear(); expect(await store.get('b')).toBeDefined(); expect(mock.cacheLookup).toHaveBeenCalledTimes(1)
    expect(await store.set('no-source', cover('x'))).toBe(false)
    expect(await store.set('big', `data:image/webp;base64,${'A'.repeat(3 * 1024 * 1024)}`, null, mock.sources)).toBe(false)
    expect(await store.get('big')).toBeUndefined()
    store.destroy()
  })
  it('新实例的缓存查找会自动拒绝内容已覆盖或已撤权的来源', async () => {
    const mock = await setup(), first = new CoverStore(mock.host)
    await first.set('cover', cover('a'), null, mock.sources); first.destroy()
    await mock.host.changeNode({ id: mock.source.id, bytes: [7] })
    const second = new CoverStore(mock.host)
    expect(await second.get('cover')).toBeUndefined()
    expect((await mock.host.cacheLookup({ keys: ['cover'] })).hits).toHaveLength(0)
    second.destroy()
  })
  it('摘要稳定且区分内容', () => { expect(coverHash('a')).toBe(coverHash('a')); expect(coverHash('a')).not.toBe(coverHash('b')) })
})
