import { describe, expect, it } from 'vitest'
import { editWorkMetadata, reconcileWorks } from './grouping'
import { jsonBytes } from './model'
import { SNAPSHOT_SHARD_BYTES, SnapshotPublishError } from './snapshot'
import { WorksStore } from './works'
import { file, memoryHost, signal, unit } from './test-fixtures'

const drafts = (count: number) => reconcileWorks([], Array.from({ length: count }, (_, index) => unit(file(index + 2, `/书/作品${index}.txt`))), 'books').map(work => ({ ...work, overrides: { title: '人工标题', description: '长中文简介'.repeat(600) } }))
describe('WorksStore 不可变分片及 CAS 指针', () => {
  it('按实际 UTF-8 字节分片，所有分片写完后才发布，ID 与人工信息跨会话恢复', async () => {
    const mock = await memoryHost(), store = new WorksStore(mock.host), empty = await store.load(signal())
    const saved = await store.save({ ...empty, rows: drafts(20) }, signal())
    const calls = mock.set.mock.calls
    expect(calls.at(-1)?.[0]).toBe('library:works')
    const shards = calls.filter(([key]) => key.startsWith('library:works:shard:'))
    expect(shards.length).toBeGreaterThan(1)
    expect(shards.every(([, request]) => jsonBytes(request.value) <= SNAPSHOT_SHARD_BYTES && request.condition.type === 'absent')).toBe(true)
    expect(await new WorksStore(mock.host).load(signal())).toEqual(saved)
    expect(calls.some(([key]) => key.startsWith('progress:') || key.startsWith('bookmark:'))).toBe(false)
  })
  it('第二分片失败保持旧指针和完整草稿，不把半个分组暴露给读者', async () => {
    const mock = await memoryHost(), store = new WorksStore(mock.host)
    const base = await store.save({ ...await store.load(), rows: drafts(1) }, signal()), pointer = structuredClone(mock.records.get('library:works'))
    const draft = { ...base, rows: drafts(20) }, original = mock.set.getMockImplementation()!
    let count = 0
    mock.set.mockImplementation(async (key, request, options) => {
      if (key.startsWith('library:works:shard:') && ++count === 2) throw new Error('配额不足')
      return original(key, request, options)
    })
    const failure = await store.save(draft, signal()).catch(error => error)
    expect(failure).toBeInstanceOf(SnapshotPublishError)
    expect(failure.draft).toEqual(draft)
    expect(mock.records.get('library:works')).toEqual(pointer)
    expect((await store.load()).rows).toEqual(base.rows)
    expect(mock.remove.mock.calls.every(([key]) => key.startsWith('library:works:shard:'))).toBe(true)
  })
  it('并发人工修改不重试覆盖；缺分片、未知 schema 均报错而非返回空库', async () => {
    const mock = await memoryHost(), store = new WorksStore(mock.host)
    const base = await store.save({ ...await store.load(), rows: drafts(2) }, signal()), stale = structuredClone(base)
    const first = await store.save({ ...base, rows: editWorkMetadata(base.rows, base.rows[0]!.id, { title: '设备一修改' }) }, signal())
    await expect(store.save({ ...stale, rows: editWorkMetadata(stale.rows, stale.rows[0]!.id, { title: '设备二草稿' }) }, signal())).rejects.toMatchObject({ code: 'snapshot_not_published', cause: { code: 'storage_conflict' } })
    expect(await store.load()).toEqual(first)
    const pointer = mock.records.get('library:works')!.value as { shards: { key: string }[] }
    const missing = (await mock.host.kvGet(pointer.shards[0]!.key)).record!
    await mock.host.kvDelete(missing.key, { revision: missing.revision })
    await expect(store.load()).rejects.toMatchObject({ code: 'incomplete_snapshot' })
    await mock.seed('library:works', { schemaVersion: 9 })
    await expect(store.load()).rejects.toMatchObject({ code: 'unknown_snapshot' })
  })
  it('发布前来源代次检查失败不更新指针；取消保留已有快照', async () => {
    const mock = await memoryHost(), store = new WorksStore(mock.host)
    const base = await store.save({ ...await store.load(), rows: drafts(1) }, signal())
    await expect(store.save({ ...base, rows: drafts(2) }, signal(), () => { throw new Error('旧来源已失效') })).rejects.toMatchObject({ cause: { message: '旧来源已失效' } })
    expect(await store.load()).toEqual(base)
    const controller = new AbortController(); controller.abort()
    await expect(store.save({ ...base, rows: drafts(2) }, controller.signal)).rejects.toMatchObject({ code: 'snapshot_not_published' })
    expect(await store.load()).toEqual(base)
  })
})
