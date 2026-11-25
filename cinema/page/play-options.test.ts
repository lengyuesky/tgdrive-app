// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { renderVersionOptions, selectedVersion, seriesOptions, SleepTimer } from './play-options'
import type { CinemaVersions } from './client'
import { node } from './test-fixture'
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

function movieVersions(defaultMedia = 'a'.repeat(32)): CinemaVersions {
  return { item_guid: 'd'.repeat(32), representative_media_guid: 'a'.repeat(32), default_media_guid: defaultMedia, versions: [
    { media_guid: 'a'.repeat(32), name: '4K 中字', file: node('3', '/影视/A-4K.mp4') },
    { media_guid: 'b'.repeat(32), name: '1080P 第1段', file: node('4', '/影视/B-1080P-part1.mp4') },
    { media_guid: 'c'.repeat(32), name: '1080P 第2段', file: node('5', '/影视/B-1080P-part2.mp4') },
  ] }
}
it('没有播放记录时选后端指定的代表版本，而不是武断地取数组首项', () => {
  const page = movieVersions('b'.repeat(32)); page.representative_media_guid = page.default_media_guid
  expect(selectedVersion(page).file.id).toBe('4')
})
it('默认选最近播放版本，手动选择其他版本仍准确定位到自己的文件', () => {
  const page = movieVersions('c'.repeat(32))
  expect(selectedVersion(page).file.id).toBe('5')
  expect(selectedVersion(page, 'b'.repeat(32))).toMatchObject({ name: '1080P 第1段', file: { id: '4' } })
  expect(selectedVersion(page, 'a'.repeat(32)).file.id).toBe('3')
  expect(() => selectedVersion(page, '已删除的版本')).toThrow('已不存在')
})
it('版本控件保留后端的稳定分段顺序，切换后选中准确的媒体身份', () => {
  const select = document.createElement('select'), page = movieVersions('c'.repeat(32))
  renderVersionOptions(select, page)
  expect([...select.options].map(option => option.text)).toEqual(['4K 中字', '1080P 第1段', '1080P 第2段'])
  expect(select.value).toBe('c'.repeat(32)); expect(select.disabled).toBe(false)
  const selected = renderVersionOptions(select, page, 'b'.repeat(32))
  expect(select.value).toBe(selected.media_guid); expect(selected.file.id).toBe('4')
})
it('单文件仍显示去掉扩展名的文件名，不提供无意义的版本切换', () => {
  const page = movieVersions(), first = page.versions[0]!
  first.name = '未刮削的影片'; page.versions = [first]
  const select = document.createElement('select')
  renderVersionOptions(select, page)
  expect(select.options[0]!.text).toBe('未刮削的影片'); expect(select.disabled).toBe(true)
})
