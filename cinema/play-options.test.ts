import { afterEach, expect, it, vi } from 'vitest'
import { seriesOptions, SleepTimer } from './play-options'
afterEach(() => vi.useRealTimers())
it('本剧设置校验真实秒数并保留关闭跳过的默认值', () => {
  expect(seriesOptions(null)).toEqual({ schemaVersion: 1, intro: 0, outro: 0 })
  expect(seriesOptions({ schemaVersion: 1, intro: 90, outro: 120 }).intro).toBe(90)
  for (const intro of [-1, 601, NaN, Infinity, '90']) expect(() => seriesOptions({ schemaVersion: 1, intro, outro: 0 })).toThrow()
})
it('计时器暂停播放且只触发一次，重新设置会取消旧计时', () => {
  vi.useFakeTimers(); const stop = vi.fn(), timer = new SleepTimer(stop)
  timer.set(15); vi.advanceTimersByTime(14 * 60_000); expect(stop).not.toHaveBeenCalled()
  timer.set(30); vi.advanceTimersByTime(30 * 60_000); expect(stop).toHaveBeenCalledTimes(1)
  timer.check(true); expect(stop).toHaveBeenCalledTimes(1); timer.clear()
})
it('本集播完模式不受普通 timeupdate 影响，关闭设置不停止播放', () => {
  const stop = vi.fn(), timer = new SleepTimer(stop)
  timer.set(-1); expect(timer.check()).toBe(false); expect(timer.check(true)).toBe(true)
  timer.set(-1); timer.set(0); timer.check(true); expect(stop).toHaveBeenCalledTimes(1)
})
it('后台时钟跨过截止时间，恢复检查立即停止', () => {
  vi.useFakeTimers(); const stop = vi.fn(), timer = new SleepTimer(stop)
  timer.set(15); vi.setSystemTime(Date.now() + 16 * 60_000)
  expect(timer.check()).toBe(true); expect(stop).toHaveBeenCalledTimes(1); timer.clear()
})
