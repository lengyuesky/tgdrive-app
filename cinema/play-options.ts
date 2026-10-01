export interface SeriesOptions { schemaVersion: 1; intro: number; outro: number }
export function seriesOptions(raw: unknown): SeriesOptions {
  if (raw === null || raw === undefined) return { schemaVersion: 1, intro: 0, outro: 0 }
  const value = raw as SeriesOptions
  if (value.schemaVersion !== 1 || ![value.intro, value.outro].every(n => Number.isFinite(n) && n >= 0 && n <= 600)) throw new Error('本剧跳过设置损坏，请重新读取后重试')
  return { schemaVersion: 1, intro: value.intro, outro: value.outro }
}
/** 截止时间使用绝对时钟，后台节流后回前台仍能立即停止。 */
export class SleepTimer {
  private timer?: ReturnType<typeof setTimeout>
  private deadline = 0
  private endOfEpisode = false
  stopped = false
  constructor(private stopPlayback: () => void) {}
  set(minutes: number) {
    this.clear(); this.stopped = false
    this.endOfEpisode = minutes === -1
    if (minutes > 0 && minutes <= 120) { this.deadline = Date.now() + minutes * 60_000; this.timer = setTimeout(() => this.check(), minutes * 60_000) }
  }
  check(ended = false) {
    if (!this.stopped && (this.deadline > 0 && Date.now() >= this.deadline || ended && this.endOfEpisode)) { this.clear(); this.stopped = true; this.stopPlayback() }
    return this.stopped
  }
  clear() { clearTimeout(this.timer); this.timer = undefined; this.deadline = 0; this.endOfEpisode = false }
}
