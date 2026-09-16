/** 不可变分片先落盘，最后以 CAS 发布单一指针；失败不触碰旧快照。 */
import type { Drive } from '../../sdk/types'
import { LibraryError, jsonBytes, newId, timeSlice } from './model'

export const SNAPSHOT_SHARD_BYTES = 48 * 1024
interface SnapshotPointer<M> { schemaVersion: 1; snapshotId: string; shards: { key: string; count: number }[]; meta: M }
interface SnapshotShard<T> { schemaVersion: 1; snapshotId: string; index: number; rows: T[] }
export interface ShardedSnapshot<T, M> { rows: T[]; meta: M; revision: string | null }
export class SnapshotPublishError<T, M> extends LibraryError {
  constructor(readonly draft: ShardedSnapshot<T, M>, cause: unknown) {
    super('snapshot_not_published', (cause as { code?: string })?.code === 'storage_conflict' ? '另一设备已更新，原快照和本地草稿均保留' : '分片保存失败，原快照和本地草稿均保留', { cause })
  }
}
export class ShardedStore<T, M> {
  constructor(private drive: Drive, readonly key: string, private row: (raw: unknown) => T, private metadata: (raw: unknown) => M, private empty: () => M, private maxRows = Infinity) {}
  async load(signal?: AbortSignal, retryCache = true): Promise<ShardedSnapshot<T, M>> {
    signal?.throwIfAborted()
    const record = await this.drive.storage.get(this.key, { signal })
    signal?.throwIfAborted()
    if (!record) return { rows: [], meta: this.empty(), revision: null }
    const pointer = record.value as SnapshotPointer<M> | null
    if (!pointer || pointer.schemaVersion !== 1 || !/^[a-f0-9]{32}$/.test(pointer.snapshotId) || !Array.isArray(pointer.shards) || pointer.shards.length > 10000) throw new LibraryError('unknown_snapshot', '快照格式损坏或版本未知，未覆盖原记录')
    const meta = this.metadata(pointer.meta), rows: T[] = [], revision = record.revision
    for (let index = 0; index < pointer.shards.length; index++) {
      const descriptor = pointer.shards[index]!
      if (!descriptor || descriptor.key !== `${this.key}:shard:${pointer.snapshotId}:${index}` || !Number.isSafeInteger(descriptor.count) || descriptor.count < 1 || rows.length + descriptor.count > this.maxRows) throw new LibraryError('invalid_snapshot', '快照分片索引无效或超限')
      const record = await this.drive.storage.get<SnapshotShard<unknown>>(descriptor.key, { signal })
      signal?.throwIfAborted()
      const shard = record?.value
      if (!shard || shard.schemaVersion !== 1 || shard.snapshotId !== pointer.snapshotId || shard.index !== index || !Array.isArray(shard.rows) || shard.rows.length !== descriptor.count || jsonBytes(shard) > SNAPSHOT_SHARD_BYTES) {
        // 可回收缓存的旧分片可能刚被另一设备替换，仅指针确已改变时重读一次。
        if (retryCache && this.key.startsWith('library:cache:')) {
          const latest = await this.drive.storage.get(this.key, { signal }); signal?.throwIfAborted()
          if (latest && latest.revision !== revision) return this.load(signal, false)
        }
        throw new LibraryError('incomplete_snapshot', '快照分片缺失或损坏，未把不完整数据当作空记录')
      }
      rows.push(...shard.rows.map(this.row))
    }
    return { rows, meta, revision: record.revision }
  }
  async save(draft: ShardedSnapshot<T, M>, signal?: AbortSignal, beforePublish?: () => Promise<void> | void): Promise<ShardedSnapshot<T, M>> {
    const rows = draft.rows.map(this.row), meta = this.metadata(draft.meta)
    if (rows.length > this.maxRows) throw new LibraryError('snapshot_limit', '快照记录数量超过上限')
    const snapshotId = newId(), shards: SnapshotShard<T>[] = []
    let shard: SnapshotShard<T> = { schemaVersion: 1, snapshotId, index: 0, rows: [] }
    // 以实际 UTF-8 大小切片，不把长中文简介或路径按字符数误当成字节数。
    for (const row of rows) {
      const candidate = { ...shard, rows: [...shard.rows, row] }
      if (jsonBytes(candidate) > SNAPSHOT_SHARD_BYTES) {
        if (!shard.rows.length) throw new LibraryError('snapshot_item_limit', '单条记录过大，无法安全保存')
        shards.push(shard); shard = { schemaVersion: 1, snapshotId, index: shards.length, rows: [row] }
        if (jsonBytes(shard) > SNAPSHOT_SHARD_BYTES) throw new LibraryError('snapshot_item_limit', '单条记录过大，无法安全保存')
      } else shard = candidate
    }
    if (shard.rows.length) shards.push(shard)
    const pointer: SnapshotPointer<M> = { schemaVersion: 1, snapshotId, meta, shards: shards.map(shard => ({ key: `${this.key}:shard:${snapshotId}:${shard.index}`, count: shard.rows.length })) }
    const cache = this.key.startsWith('library:cache:'), created: { key: string; revision: string }[] = []
    let publishing = false
    try {
      const previous = cache ? await this.drive.storage.get<SnapshotPointer<M>>(this.key, { signal }) : null
      if (cache && (previous?.revision ?? null) !== draft.revision) throw Object.assign(new Error('缓存已被另一任务更新'), { code: 'storage_conflict' })
      for (const shard of shards) {
        signal?.throwIfAborted()
        const key = pointer.shards[shard.index]!.key, record = await this.drive.storage.set(key, shard, null, { signal })
        created.push({ key, revision: record.revision })
        if (signal) await timeSlice(signal)
      }
      signal?.throwIfAborted(); await beforePublish?.(); signal?.throwIfAborted()
      publishing = true
      const saved = await this.drive.storage.set(this.key, pointer, draft.revision, { signal })
      signal?.throwIfAborted()
      // 只回收刚被本次 CAS 替换的缓存快照，不碰人工快照、别人的草稿或其他前缀。
      const old = previous?.value
      if (previous?.revision === draft.revision && old?.schemaVersion === 1 && /^[a-f0-9]{32}$/.test(old.snapshotId) && Array.isArray(old.shards) && old.shards.length <= 10000) {
        for (const [index, descriptor] of old.shards.entries()) {
          if (descriptor?.key !== `${this.key}:shard:${old.snapshotId}:${index}`) continue
          try {
            const record = await this.drive.storage.get(descriptor.key, { signal })
            if (record) await this.drive.storage.delete(record.key, record.revision, { signal })
          } catch { break }
        }
      }
      return { rows, meta, revision: saved.revision }
    } catch (error) {
      // 未尝试发布或明确 CAS 失败的缓存草稿可释放；提交结果不明时保留，避免删除活动快照。
      if (cache && (!publishing || (error as { code?: string }).code === 'storage_conflict')) {
        void (async () => { for (const item of created) { try { await this.drive.storage.delete(item.key, item.revision) } catch { break } } })()
      }
      // 人工分片仍是恢复草稿的依据，绝不由缓存回收器删除。
      throw new SnapshotPublishError(structuredClone(draft), error)
    }
  }
}
