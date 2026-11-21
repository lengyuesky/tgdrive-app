import { describe, expect, it, vi } from 'vitest'
import { LIMITS } from '@tgdrive/page-sdk/contract'
import { ShardedStore, SnapshotPublishError } from './snapshot'
import { memoryHost, signal } from './test-fixtures'
import { jsonBytes } from './model'

const parseRow = (value: unknown) => { if (typeof value !== 'string') throw new Error('测试快照条目无效'); return value }
const parseMeta = (value: unknown): { schemaVersion: 1 } => { if ((value as { schemaVersion?: number })?.schemaVersion !== 1) throw new Error('测试快照元信息无效'); return { schemaVersion: 1 } }
const store = (host: Awaited<ReturnType<typeof memoryHost>>['host'], shardBytes?: number) => new ShardedStore(host, 'test:snapshot', parseRow, parseMeta, () => ({ schemaVersion: 1 as const }), Infinity, shardBytes)

describe('单键发布的不可变分片', () => {
  it('分片目录超过 32 KiB 时再分片，主指针和每条 KV 都遵守契约限额', async () => {
    const mock = await memoryHost(), snapshot = store(mock.host, 400)
    const rows = Array.from({ length: 650 }, (_, index) => `${index}:` + '汉'.repeat(95))
    const saved = await snapshot.save({ ...await snapshot.load(), rows }, signal())
    const pointer = mock.records.get('test:snapshot')!.value as { shards: unknown[]; indexes: { key: string }[] }
    expect(pointer.shards).toEqual([]); expect(pointer.indexes.length).toBeGreaterThan(1)
    expect([...mock.records.values()].every(record => jsonBytes(record.value) <= LIMITS.MAX_KV_VALUE_BYTES)).toBe(true)
    expect(mock.set.mock.calls.filter(([key]) => key !== 'test:snapshot').every(([, request]) => request.condition.type === 'absent')).toBe(true)
    expect(await store(mock.host, 400).load()).toEqual(saved)
  })
  it('并发发布只允许一个指针成功，冲突清理自身草稿分片而不删胜出者', async () => {
    const mock = await memoryHost(), one = store(mock.host), two = store(mock.host)
    const base = await one.save({ ...await one.load(), rows: ['原记录'] })
    const draft = { ...base, rows: ['设备一草稿'] }
    let other!: Awaited<ReturnType<typeof two.save>>
    const rejected = await one.save(draft, signal(), async () => { other = await two.save({ ...base, rows: ['设备二先发布'] }) }).catch(error => error)
    expect(rejected).toBeInstanceOf(SnapshotPublishError); expect(rejected).toMatchObject({ draft, cause: { code: 'storage_conflict' } })
    expect(await one.load()).toEqual(other)
    const shards = [...mock.records.keys()].filter(key => key.startsWith('test:snapshot:shard:'))
    expect(shards).toHaveLength(1); expect(mock.remove.mock.calls.every(([key]) => key.startsWith('test:snapshot:shard:'))).toBe(true)
  })
  it('指针已提交但响应丢失时不删除新分片，重读可以核实完整提交结果', async () => {
    const mock = await memoryHost(), snapshot = store(mock.host), base = await snapshot.save({ ...await snapshot.load(), rows: ['原记录'] })
    const write = mock.set.getMockImplementation()!
    mock.set.mockImplementation(async (...args) => { const record = await write(...args); if (args[0] === 'test:snapshot') throw new Error('响应丢失'); return record })
    const draft = { ...base, rows: ['已经提交的记录'] }
    await expect(snapshot.save(draft)).rejects.toMatchObject({ code: 'snapshot_not_published', draft })
    expect((await snapshot.load()).rows).toEqual(draft.rows)
    // 未确认发布不清理任何旧或新分片，不能以网络错误假定 CAS 没有发生。
    expect([...mock.records.keys()].filter(key => key.startsWith('test:snapshot:shard:'))).toHaveLength(2)
  })
  it('发布前取消只清理本次分片，原指针、阅读记录和书签保持原样', async () => {
    const mock = await memoryHost(), snapshot = store(mock.host), base = await snapshot.save({ ...await snapshot.load(), rows: ['原记录'] })
    const progress = await mock.seed('progress:2', { retained: true }), bookmark = await mock.seed('bookmark:2:a', { retained: true })
    const controller = new AbortController(), pointer = mock.records.get('test:snapshot')!
    await expect(snapshot.save({ ...base, rows: ['未发布草稿'] }, controller.signal, () => controller.abort())).rejects.toMatchObject({ cause: { name: 'AbortError' } })
    expect(mock.records.get('test:snapshot')).toEqual(pointer); expect(await snapshot.load()).toEqual(base)
    expect(mock.records.get(progress.key)).toEqual(progress); expect(mock.records.get(bookmark.key)).toEqual(bookmark)
  })
  it('未知元信息、缺失索引或损坏分片拒绝读取，不把错误数据当作空快照', async () => {
    const mock = await memoryHost(), snapshot = store(mock.host)
    await mock.seed('test:snapshot', { schemaVersion: 9 })
    await expect(snapshot.load()).rejects.toMatchObject({ code: 'unknown_snapshot' })
    const invalid = mock.records.get('test:snapshot')!
    await mock.host.kvDelete(invalid.key, { revision: invalid.revision })
    await snapshot.save({ ...await snapshot.load(), rows: ['记录'] })
    const shard = [...mock.records.values()].find(record => record.key.startsWith('test:snapshot:shard:'))!
    await mock.host.kvDelete(shard.key, { revision: shard.revision })
    await expect(snapshot.load()).rejects.toMatchObject({ code: 'incomplete_snapshot' })
    expect(vi.mocked(mock.set).mock.calls.at(-1)![0]).toBe('test:snapshot')
  })
})
