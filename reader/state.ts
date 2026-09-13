/** 按记录进行 CAS 保存；保留未同步状态，绝不以过期进度覆盖另一设备。 */
import type { Drive, FileEntry, RecordValue } from '../sdk/types'
export interface Location { format: 'txt' | 'epub' | 'pdf' | 'comic'; index: number; offset?: number; ratio?: number; entry?: string; encoding?: string }
export interface Progress { file: FileEntry; title: string; location: Location }
export interface Preferences { theme: 'system' | 'light' | 'sepia' | 'dark'; fontSize: number; lineHeight: number; width: number; mode: 'scroll' | 'page'; direction: 'ltr' | 'rtl'; zoom: number }
export const defaults: Preferences = { theme: 'system', fontSize: 18, lineHeight: 1.8, width: 760, mode: 'scroll', direction: 'ltr', zoom: 1 }
const clamp = (value: unknown, min: number, max: number, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
export function preferences(raw: Partial<Preferences> | null | undefined): Preferences {
  const p = raw ?? {}
  return { theme: ['system','light','sepia','dark'].includes(p.theme ?? '') ? p.theme! : 'system', fontSize: clamp(p.fontSize, 12, 36, 18), lineHeight: clamp(p.lineHeight, 1.2, 2.8, 1.8), width: clamp(p.width, 360, 1400, 760), mode: p.mode === 'page' ? 'page' : 'scroll', direction: p.direction === 'rtl' ? 'rtl' : 'ltr', zoom: clamp(p.zoom, 0.5, 3, 1) }
}
export function validLocation(value: unknown): value is Location {
  if (!value || typeof value !== 'object') return false
  const loc = value as Location
  return ['txt','epub','pdf','comic'].includes(loc.format) && Number.isSafeInteger(loc.index) && loc.index >= 0
    && (loc.offset === undefined || Number.isSafeInteger(loc.offset) && loc.offset >= 0)
    && (loc.ratio === undefined || Number.isFinite(loc.ratio) && loc.ratio >= 0 && loc.ratio <= 1)
    && (loc.entry === undefined || typeof loc.entry === 'string' && loc.entry.length <= 4096)
    && (loc.encoding === undefined || ['utf-8','utf-16le','utf-16be','gb18030'].includes(loc.encoding))
}
export class ProgressStore {
  private record: RecordValue<Progress> | null = null
  private pending: Progress | null = null
  private running?: Promise<void>
  private timer?: ReturnType<typeof setTimeout>
  private conflict = false
  private stopped = false
  readonly key: string
  constructor(private drive: Drive, file: FileEntry, private status: (message: string, conflict: boolean) => void) { this.key = `progress:${file.id}` }
  async load() {
    this.record = await this.drive.storage.get<Progress>(this.key)
    const value = this.record?.value
    return value && validLocation(value.location) ? value : null
  }
  mark(progress: Progress, immediately = false) {
    if (this.stopped || !validLocation(progress.location)) return
    if (!this.pending && JSON.stringify(progress) === JSON.stringify(this.record?.value)) return
    this.pending = structuredClone(progress)
    if (this.conflict) return
    this.status('未同步', false)
    if (immediately) void this.flush()
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
        this.status('已同步', false)
      } catch (error) {
        this.pending ??= value
        this.conflict = (error as { code?: string }).code === 'storage_conflict'
        this.status(this.conflict ? '另一设备更新了阅读进度' : '未同步：保存失败，请重试', this.conflict)
        return
      }
    }
  }
  async resolve(useRemote: boolean) {
    await this.running
    const latest = await this.drive.storage.get<Progress>(this.key)
    this.record = latest
    if (useRemote) this.pending = null
    this.conflict = false
    this.status('已同步', false)
    if (!useRemote) await this.flush()
    return latest?.value
  }
  stop() { this.stopped = true; clearTimeout(this.timer) }
}
