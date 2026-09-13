import type { Drive, FileEntry, RecordValue } from '../sdk/types'
import { sameContent, validProgress, type CinemaProgress } from './model'

/** 所有用户数据都经 CAS 写入；冲突保留待保存副本，绝不自动以更大时间覆盖。 */
export class ProgressStore {
  private record: RecordValue<CinemaProgress> | null = null
  private pending: CinemaProgress | null = null
  private running?: Promise<void>
  private timer?: ReturnType<typeof setTimeout>
  private conflict = false
  private stopped = false
  private ready = false
  private loaded = false
  readonly key: string
  constructor(private drive: Drive, readonly file: FileEntry, private status: (text: string, conflict: boolean) => void) { this.key = `progress:${file.id}` }
  async load() {
    this.record = await this.drive.storage.get<CinemaProgress>(this.key)
    this.loaded = true
    const value = this.record?.value
    return validProgress(value) && sameContent(value.file, this.file) ? value : null
  }
  restored() { this.ready = this.loaded }
  mark(value: CinemaProgress, immediate = false) {
    if (!this.ready || this.stopped || !validProgress(value)) return
    this.pending = structuredClone(value)
    if (this.conflict) return
    if (immediate) void this.flush()
    else if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.flush() }, 5000)
  }
  flush(): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined
    if (this.running) return this.running
    this.running = this.save().finally(() => { this.running = undefined })
    return this.running
  }
  private async save() {
    while (this.pending && !this.conflict) {
      const value = this.pending; this.pending = null
      try {
        this.record = await this.drive.storage.set(this.key, value, this.record?.revision ?? null)
        this.status('进度已同步', false)
      } catch (error) {
        this.pending ??= value
        this.conflict = (error as { code?: string }).code === 'storage_conflict'
        this.status(this.conflict ? '另一设备更新了进度，请选择保留哪一份' : '进度未同步，请重试或清理历史记录', this.conflict)
        return
      }
    }
  }
  async resolve(remote: boolean) {
    await this.running
    this.record = await this.drive.storage.get<CinemaProgress>(this.key)
    if (remote) this.pending = null
    this.conflict = false
    if (!remote) await this.flush()
    else this.status('已采用云端进度', false)
    const value = this.record?.value
    return validProgress(value) && sameContent(value.file, this.file) ? value : null
  }
  stop() { this.stopped = true; clearTimeout(this.timer) }
}
