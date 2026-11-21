/** 不可变分片先保存，最后单键 CAS 发布；多键之间没有事务，未知提交结果不清理分片。 */
import type { HostClient, JsonValue, KvRecord } from '@tgdrive/page-sdk'
import { LIMITS } from '@tgdrive/page-sdk/contract'
import { kvCondition } from '../records'
import { LibraryError, jsonBytes, newId, timeSlice } from './model'

export const SNAPSHOT_SHARD_BYTES = Math.min(24 * 1024, LIMITS.MAX_KV_VALUE_BYTES)
interface Descriptor { key: string; count: number }
interface SnapshotPointer<M> { schemaVersion: 1; snapshotId: string; shards: Descriptor[]; indexes?: Descriptor[]; meta: M }
interface SnapshotShard<T> { schemaVersion: 1; snapshotId: string; index: number; rows: T[] }
interface SnapshotIndex { schemaVersion: 1; snapshotId: string; index: number; shards: Descriptor[] }
export interface ShardedSnapshot<T, M> { rows: T[]; meta: M; revision: string | null }
export class SnapshotPublishError<T, M> extends LibraryError {
  constructor(readonly draft: ShardedSnapshot<T, M>, cause: unknown) { super('snapshot_not_published', (cause as { code?: string })?.code === 'storage_conflict' ? '另一设备已更新，原快照和本地草稿均保留' : '分片保存失败，原快照和本地草稿均保留', { cause }) }
}
export class ShardedStore<T, M> {
  constructor(private host: HostClient, readonly key: string, private row: (raw: unknown) => T, private metadata: (raw: unknown) => M, private empty: () => M, private maxRows = Infinity, private shardBytes = SNAPSHOT_SHARD_BYTES) {
    if (shardBytes < 128 || shardBytes > LIMITS.MAX_KV_VALUE_BYTES) throw new LibraryError('snapshot_limit', '分片字节预算无效')
  }
  private pointer(raw: unknown): SnapshotPointer<M> {
    const pointer = raw as SnapshotPointer<M> | null
    if (!pointer || pointer.schemaVersion !== 1 || !/^[a-f0-9]{32}$/.test(pointer.snapshotId) || !Array.isArray(pointer.shards)
      || pointer.indexes !== undefined && (!Array.isArray(pointer.indexes) || pointer.shards.length > 0)) throw new LibraryError('unknown_snapshot', '快照格式损坏或版本未知，未覆盖原记录')
    return pointer
  }
  private async descriptors(pointer: SnapshotPointer<M>, signal?: AbortSignal): Promise<Descriptor[]> {
    if (!pointer.indexes) return pointer.shards
    const shards: Descriptor[] = []
    for (const [index, descriptor] of pointer.indexes.entries()) {
      if (descriptor.key !== `${this.key}:index:${pointer.snapshotId}:${index}`) throw new LibraryError('invalid_snapshot', '快照索引分片路径无效')
      const record = (await this.host.kvGet(descriptor.key, { signal })).record, value = record?.value as unknown as SnapshotIndex | undefined
      if (!value || value.schemaVersion !== 1 || value.snapshotId !== pointer.snapshotId || value.index !== index || !Array.isArray(value.shards) || value.shards.length !== descriptor.count) throw new LibraryError('incomplete_snapshot', '快照索引分片缺失或损坏')
      shards.push(...value.shards)
      if (shards.length > LIMITS.DEFAULT_KV_ENTRIES) throw new LibraryError('snapshot_limit', '快照分片超出应用条数预算')
    }
    return shards
  }
  async load(signal?: AbortSignal, retryChanged = true): Promise<ShardedSnapshot<T, M>> {
    const record = (await this.host.kvGet(this.key, { signal })).record
    signal?.throwIfAborted()
    if (!record) return { rows: [], meta: this.empty(), revision: null }
    const pointer = this.pointer(record.value), meta = this.metadata(pointer.meta), rows: T[] = []
    try {
      const descriptors = await this.descriptors(pointer, signal)
      for (const [index, descriptor] of descriptors.entries()) {
        if (descriptor.key !== `${this.key}:shard:${pointer.snapshotId}:${index}` || !Number.isSafeInteger(descriptor.count) || descriptor.count < 1 || rows.length + descriptor.count > this.maxRows) throw new LibraryError('invalid_snapshot', '快照分片索引无效或超限')
        const record = (await this.host.kvGet(descriptor.key, { signal })).record, shard = record?.value as unknown as SnapshotShard<unknown> | undefined
        signal?.throwIfAborted()
        if (!shard || shard.schemaVersion !== 1 || shard.snapshotId !== pointer.snapshotId || shard.index !== index || !Array.isArray(shard.rows) || shard.rows.length !== descriptor.count || jsonBytes(shard) > this.shardBytes) throw new LibraryError('incomplete_snapshot', '快照分片缺失或损坏，未把不完整数据当作空记录')
        rows.push(...shard.rows.map(this.row))
      }
    } catch (error) {
      signal?.throwIfAborted()
      if (retryChanged) {
        const latest = (await this.host.kvGet(this.key, { signal })).record
        if (latest && latest.revision !== record.revision) return this.load(signal, false)
      }
      throw error
    }
    return { rows, meta, revision: record.revision }
  }
  async save(draft: ShardedSnapshot<T, M>, signal?: AbortSignal, beforePublish?: () => Promise<void> | void): Promise<ShardedSnapshot<T, M>> {
    const rows = draft.rows.map(this.row), meta = this.metadata(draft.meta)
    if (rows.length > this.maxRows) throw new LibraryError('snapshot_limit', '快照记录数量超过上限')
    const snapshotId = newId(), shards: SnapshotShard<T>[] = []
    let shard: SnapshotShard<T> = { schemaVersion: 1, snapshotId, index: 0, rows: [] }
    for (const row of rows) {
      const candidate = { ...shard, rows: [...shard.rows, row] }
      if (jsonBytes(candidate) > this.shardBytes) {
        if (!shard.rows.length) throw new LibraryError('snapshot_item_limit', '单条记录过大，无法安全保存')
        shards.push(shard); shard = { schemaVersion: 1, snapshotId, index: shards.length, rows: [row] }
        if (jsonBytes(shard) > this.shardBytes) throw new LibraryError('snapshot_item_limit', '单条记录过大，无法安全保存')
      } else shard = candidate
    }
    if (shard.rows.length) shards.push(shard)
    const descriptors = shards.map(shard => ({ key: `${this.key}:shard:${snapshotId}:${shard.index}`, count: shard.rows.length }))
    const pointer: SnapshotPointer<M> = { schemaVersion: 1, snapshotId, meta, shards: descriptors }
    const indexes: SnapshotIndex[] = []
    if (jsonBytes(pointer) > LIMITS.MAX_KV_VALUE_BYTES) {
      let value: SnapshotIndex = { schemaVersion: 1, snapshotId, index: 0, shards: [] }
      for (const descriptor of descriptors) {
        if (jsonBytes({ ...value, shards: [...value.shards, descriptor] }) > SNAPSHOT_SHARD_BYTES) { indexes.push(value); value = { schemaVersion: 1, snapshotId, index: indexes.length, shards: [] } }
        value.shards.push(descriptor)
      }
      if (value.shards.length) indexes.push(value)
      pointer.shards = []; pointer.indexes = indexes.map(value => ({ key: `${this.key}:index:${snapshotId}:${value.index}`, count: value.shards.length }))
    }
    if (jsonBytes(pointer) > LIMITS.MAX_KV_VALUE_BYTES) throw new LibraryError('snapshot_item_limit', '快照元信息超过单值上限，原快照未改变')
    const created: KvRecord[] = []
    let publishing = false, previous: KvRecord | null = null
    try {
      previous = (await this.host.kvGet(this.key, { signal })).record
      if ((previous?.revision ?? null) !== draft.revision) throw Object.assign(new Error('快照已被另一任务更新'), { code: 'storage_conflict' })
      for (const value of [...shards.map(shard => ({ key: descriptors[shard.index]!.key, value: shard })), ...indexes.map(index => ({ key: pointer.indexes![index.index]!.key, value: index }))]) {
        signal?.throwIfAborted()
        created.push(await this.host.kvPut(value.key, { value: value.value as unknown as JsonValue, condition: { type: 'absent' } }, { signal }))
        if (signal) await timeSlice(signal)
      }
      signal?.throwIfAborted(); await beforePublish?.(); signal?.throwIfAborted()
      publishing = true
      const saved = await this.host.kvPut(this.key, { value: pointer as unknown as JsonValue, condition: kvCondition(draft.revision) }, { signal })
      // 已确认 CAS 成功才清理被替换的快照；并发读者发现指针改变后会重读一次。
      if (previous) await this.cleanPrevious(previous).catch(() => {})
      return { rows, meta, revision: saved.revision }
    } catch (error) {
      if (!publishing || (error as { code?: string }).code === 'storage_conflict') {
        for (const record of created) await this.host.kvDelete(record.key, { revision: record.revision }).catch(() => {})
      }
      throw new SnapshotPublishError(structuredClone(draft), error)
    }
  }
  private async cleanPrevious(record: KvRecord) {
    const pointer = this.pointer(record.value), descriptors = await this.descriptors(pointer)
    for (const [index, descriptor] of descriptors.entries()) {
      if (descriptor.key !== `${this.key}:shard:${pointer.snapshotId}:${index}`) continue
      const record = (await this.host.kvGet(descriptor.key)).record
      if (record) await this.host.kvDelete(record.key, { revision: record.revision })
    }
    for (const [index, descriptor] of (pointer.indexes ?? []).entries()) {
      if (descriptor.key !== `${this.key}:index:${pointer.snapshotId}:${index}`) continue
      const record = (await this.host.kvGet(descriptor.key)).record
      if (record) await this.host.kvDelete(record.key, { revision: record.revision })
    }
  }
}
