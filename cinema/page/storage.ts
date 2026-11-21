import type { FileNode } from '@tgdrive/page-sdk/contract'
import { CinemaClient, type CinemaRecord } from './client'
import { sameContent, validProgress, type CinemaProgress } from './model'

/** 观看位置由后端当前播放代次仲裁，不再用页面 KV 的 CAS 与飞牛进度形成两套权威。 */
export class ProgressStore {
  private record: CinemaRecord<CinemaProgress> | null = null
  private pending: CinemaProgress | null = null
  private running?: Promise<void>
  private starting?: Promise<void>
  private timer?: ReturnType<typeof setTimeout>
  private conflict = false
  private stopped = false
  private ready = false
  private loaded = false
  private playId?: string
  readonly key: string
  constructor(private cinema: CinemaClient, readonly file: FileNode, private status: (text: string, conflict: boolean) => void) { this.key = `progress:${file.id}` }
  async load(signal?: AbortSignal) {
    this.record = await this.cinema.progress(this.file.id, signal)
    this.loaded = true
    const value = this.record?.value
    return validProgress(value) && sameContent(value.file, this.file) ? value : null
  }
  /** 只在视频实际进入 playing 后调用；打开详情、容器探测或 loadedmetadata 都不夺取权威。 */
  restored(signal?: AbortSignal): Promise<void> {
    if (!this.loaded || this.stopped || this.conflict || this.ready) return Promise.resolve()
    this.starting ??= this.cinema.beginPlayback(this.file.id, signal).then(async value => {
      if (this.stopped) { await this.cinema.endPlayback(value.play_id, signal); return }
      this.playId = value.play_id; this.ready = true
    }).finally(() => { this.starting = undefined })
    return this.starting
  }
  mark(value: CinemaProgress, immediate = false) {
    if (!this.ready || this.stopped || !validProgress(value) || !sameContent(value.file, this.file)) return
    this.pending = structuredClone(value)
    if (this.conflict) return
    if (immediate) void this.flush()
    else if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.flush() }, 5000)
  }
  flush(signal?: AbortSignal): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined
    if (this.running) return this.running
    this.running = this.save(signal).finally(() => { this.running = undefined })
    return this.running
  }
  private async save(signal?: AbortSignal) {
    while (this.pending && !this.conflict && this.playId) {
      const value = this.pending; this.pending = null
      try {
        this.record = await this.cinema.save(this.key, value, this.record?.revision ?? null, signal, this.playId)
        this.status('进度已同步', false)
      } catch (error) {
        this.pending ??= value
        this.conflict = (error as { code?: string }).code === 'storage_conflict'
        this.status(this.conflict ? '另一播放会话更新了进度，请选择采用云端或明确保留本次' : '进度未同步，请重试', this.conflict)
        return
      }
    }
  }
  async resolve(remote: boolean, signal?: AbortSignal) {
    await this.running
    this.record = await this.cinema.progress(this.file.id, signal)
    if (this.playId) await this.cinema.endPlayback(this.playId, signal)
    this.playId = undefined; this.ready = false; this.conflict = false
    if (remote) { this.pending = null; this.status('已采用云端进度；继续播放后才重新取得进度权威', false) }
    else { await this.restored(signal); await this.flush(signal) }
    const value = this.record?.value
    return validProgress(value) && sameContent(value.file, this.file) ? value : null
  }
  stop() { this.stopped = true; clearTimeout(this.timer) }
  async close(signal?: AbortSignal) {
    this.stop()
    await this.starting
    await this.flush(signal)
    if (this.playId) { await this.cinema.endPlayback(this.playId, signal); this.playId = undefined }
  }
}
