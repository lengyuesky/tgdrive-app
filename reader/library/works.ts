/** 人工归组和标题修正独立于所有可回收缓存。 */
import type { Drive } from '../../sdk/types'
import { LibraryError, type Work } from './model'
import { parseWork, validateWorks } from './grouping'
import { ShardedStore, type ShardedSnapshot } from './snapshot'

export interface WorksMeta { schemaVersion: 1 }
export type WorksSnapshot = ShardedSnapshot<Work, WorksMeta>
const parseMeta = (raw: unknown): WorksMeta => {
  if (!raw || (raw as WorksMeta).schemaVersion !== 1) throw new LibraryError('unknown_works', '作品记录版本未知，未覆盖人工整理数据')
  return { schemaVersion: 1 }
}
export class WorksStore {
  private store: ShardedStore<Work, WorksMeta>
  constructor(drive: Drive) { this.store = new ShardedStore(drive, 'library:works', parseWork, parseMeta, () => ({ schemaVersion: 1 })) }
  async load(signal?: AbortSignal): Promise<WorksSnapshot> { const snapshot = await this.store.load(signal); return { ...snapshot, rows: validateWorks(snapshot.rows) } }
  save(draft: WorksSnapshot, signal?: AbortSignal, beforePublish?: () => Promise<void> | void) {
    return this.store.save({ ...draft, rows: validateWorks(draft.rows) }, signal, beforePublish)
  }
}
