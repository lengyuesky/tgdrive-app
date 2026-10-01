/** 会话内复用完整状态；变更只重读对应键，失联后通过有效期重新校对。 */
import type { Drive, RecordValue } from '../../sdk/types'
import { LibraryError, type ReadingUnit } from './model'
import { emptyFlags, parseFlags, parseUnitState, readingFrom, validProgress, type CatalogReadingState } from './reading'

export class ReadingStateCache {
  private value?: CatalogReadingState
  private identity = ''
  private at = 0
  private dirty = new Set<string>()
  private epoch = 0
  private pending?: { identity: string; epoch: number; promise: Promise<CatalogReadingState> }
  constructor(private drive: Drive, private signal: AbortSignal) {}
  invalidate(key?: string) {
    this.epoch++
    if (!key || this.dirty.size >= 200) { this.value = undefined; this.dirty.clear() }
    else this.dirty.add(key)
  }
  async load(identity: string, units: readonly ReadingUnit[], read: () => Promise<CatalogReadingState>, signal: AbortSignal): Promise<CatalogReadingState> {
    signal.throwIfAborted(); this.signal.throwIfAborted()
    const epoch = this.epoch
    if (!this.pending || this.pending.identity !== identity || this.pending.epoch !== epoch) {
      const previous = this.identity === identity && Date.now() - this.at < 30_000 ? this.value : undefined
      const dirty = [...this.dirty]
      const promise = (async () => {
        const value = previous ? await this.update(previous, units, dirty) : await read()
        this.signal.throwIfAborted()
        if (this.epoch === epoch) { this.value = value; this.identity = identity; if (!previous) this.at = Date.now(); this.dirty.clear() }
        return value
      })()
      const pending = { identity, epoch, promise }
      this.pending = pending
      void promise.finally(() => { if (this.pending === pending) this.pending = undefined }).catch(() => {})
    }
    const promise = this.pending.promise
    // 一页取消等待不能取消另一页共用的请求；应用销毁仍会终止底层读取。
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      promise.then(value => {
        signal.removeEventListener('abort', abort)
        if (!signal.aborted) resolve(epoch === this.epoch ? structuredClone(value) : this.load(identity, units, read, signal))
      }, error => { signal.removeEventListener('abort', abort); reject(error) })
    })
  }
  private async update(previous: CatalogReadingState, units: readonly ReadingUnit[], dirty: string[]) {
    const value = structuredClone(previous), files = new Map(units.map(unit => [unit.nodeId, unit.file]))
    const ids = new Set<number>()
    for (const key of dirty) {
      if (key.startsWith('library:flags:')) {
        const id = key.slice('library:flags:'.length)
        if (!value.flagSnapshots.has(id)) continue
        const record = await this.drive.storage.get(key, { signal: this.signal })
        const flags = record ? parseFlags(record.value) : emptyFlags()
        value.flags.set(id, flags); value.flagSnapshots.set(id, { value: flags, revision: record?.revision ?? null })
      } else if (/^(progress:|library:reading:)\d+$/.test(key)) ids.add(Number(key.slice(key.lastIndexOf(':') + 1)))
    }
    for (const id of ids) {
      const file = files.get(id)
      if (!file) continue
      const [progress, state] = await Promise.all([this.drive.storage.get(`progress:${id}`, { signal: this.signal }), this.drive.storage.get(`library:reading:${id}`, { signal: this.signal })])
      if (progress && (!validProgress(progress.value) || progress.value.file.id !== id)) throw new LibraryError('unknown_progress', '阅读记录格式无效，请重试同步')
      value.readings.set(id, readingFrom(file, progress as RecordValue<import('./model').LibraryProgress> | null, state ? parseUnitState(state.value) : undefined))
    }
    return value
  }
}
