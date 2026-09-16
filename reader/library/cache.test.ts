import { describe, expect, it, vi } from 'vitest'
import { BudgetCache, CACHE_BUDGETS, TaskPool } from './cache'
import { jsonBytes } from './model'
import { deferred, memoryDrive, signal } from './test-fixtures'

const text = (value: unknown): value is string => typeof value === 'string'
describe('BudgetCache 字节预算及非破坏性降级', () => {
  it('缩略图 8 MiB、元数据 4 MiB，按字节 LRU 回收，跨会话复用并只删缓存前缀', async () => {
    expect(CACHE_BUDGETS).toEqual({ thumbnail: 8 * 1024 * 1024, metadata: 4 * 1024 * 1024 })
    const mock = memoryDrive(), cache = new BudgetCache(mock.drive, 'thumbnail', 700, text)
    mock.seed('progress:1', { old: true }); mock.seed('library:works:shard:user:0', { old: true })
    let now = 10; vi.spyOn(Date, 'now').mockImplementation(() => now++)
    await cache.set('a', '甲'.repeat(60), signal()); await cache.set('b', '乙'.repeat(60), signal())
    await cache.get('a', signal()); await cache.set('c', '丙'.repeat(60), signal())
    expect(await cache.get('b')).toBeUndefined(); expect(await cache.get('a')).toBe('甲'.repeat(60))
    expect(cache.status.bytes).toBeLessThanOrEqual(700)
    const diskBytes = [...mock.records.values()].filter(record => record.key.startsWith(cache.prefix)).reduce((sum, record) => sum + jsonBytes(record.value), 0)
    expect(diskBytes).toBeLessThanOrEqual(700)
    expect(mock.remove.mock.calls.every(([key]) => key.startsWith('library:cache:thumbnail:'))).toBe(true)
    expect(mock.records.has('progress:1')).toBe(true); expect(mock.records.has('library:works:shard:user:0')).toBe(true)
    const reopened = new BudgetCache(mock.drive, 'thumbnail', 700, text)
    expect(await reopened.get('c')).toBe('丙'.repeat(60)); expect(await reopened.get('b')).toBeUndefined()
    cache.destroy(); reopened.destroy()
  })
  it('配额或缓存读取失败仅会话降级，已读、收藏及人工数据不删除；超大单记录不持久化', async () => {
    const mock = memoryDrive(), status = vi.fn(), cache = new BudgetCache(mock.drive, 'metadata', CACHE_BUDGETS.metadata, text, status)
    const user = mock.seed('library:reading:1', { schemaVersion: 1, status: 'read' })
    mock.set.mockRejectedValueOnce(new Error('配额不足'))
    await cache.set('session', '可用元数据')
    expect(cache.status.mode).toBe('session'); expect(await cache.get('session')).toBe('可用元数据')
    expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'session', message: expect.stringContaining('不受影响') }))
    expect(mock.records.get(user.key)).toEqual(user); expect(mock.remove).not.toHaveBeenCalled()
    const next = new BudgetCache(mock.drive, 'thumbnail', CACHE_BUDGETS.thumbnail, text)
    const calls = mock.set.mock.calls.length
    await next.set('large', 'x'.repeat(100 * 1024))
    expect(await next.get('large')).toHaveLength(100 * 1024)
    expect(mock.set).toHaveBeenCalledTimes(calls)
    cache.destroy(); next.destroy()
  })
  it('未知缓存 schema 不被当成有效数据或静默覆盖', async () => {
    const mock = memoryDrive(), first = new BudgetCache(mock.drive, 'metadata', 4096, text)
    await first.set('known', '旧缓存')
    const record = [...mock.records.values()][0]!
    record.value = { ...(record.value as object), schemaVersion: 99 }
    const next = new BudgetCache(mock.drive, 'metadata', 4096, text), count = mock.set.mock.calls.length
    expect(await next.get('known')).toBeUndefined()
    await next.set('known', '新缓存')
    expect(next.status.mode).toBe('session'); expect(mock.set).toHaveBeenCalledTimes(count)
    first.destroy(); next.destroy()
  })
  it('首次磁盘读取很慢时调用方仍能取消，不占住封面并发槽', async () => {
    const mock = memoryDrive(), waiting = deferred(), entered = deferred(), cache = new BudgetCache(mock.drive, 'metadata', 4096, text)
    mock.storageList.mockImplementationOnce(async () => { entered.resolve(); await waiting.promise; return { records: [], has_more: false, next_cursor: null } })
    const controller = new AbortController(), pending = cache.get('x', controller.signal).then(() => 'resolved', error => error.name)
    await entered.promise; controller.abort()
    const result = await Promise.race([pending, new Promise<string>(resolve => setTimeout(() => resolve('timeout'), 30))])
    waiting.resolve(); await pending; cache.destroy()
    expect(result).toBe('AbortError')
  })
})

describe('TaskPool 库任务并发与取消', () => {
  it('限制实际运行任务，排队取消不执行，异常归还槽位', async () => {
    const pool = new TaskPool(2), release = deferred(), controller = new AbortController()
    let active = 0, peak = 0
    const work = vi.fn(async () => { active++; peak = Math.max(peak, active); await release.promise; active--; return '完成' })
    const first = pool.run(signal(), work), second = pool.run(signal(), work)
    const cancelled = pool.run(controller.signal, work).catch(error => error.name)
    controller.abort(); expect(await cancelled).toBe('AbortError'); expect(work).toHaveBeenCalledTimes(2)
    release.resolve(); await Promise.all([first, second]); expect(peak).toBe(2)
    await expect(pool.run(signal(), async () => { throw new Error('提取失败') })).rejects.toThrow('提取失败')
    expect(await pool.run(signal(), async () => 1)).toBe(1)
  })
})
