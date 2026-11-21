import { describe, expect, it } from 'vitest'
import { contentRef, episode, isNumberedMovie, naturalOrder, preferences, sameContent, sizeText, timeText, title, validProgress, VIDEO_EXTENSIONS } from './model'
import { node } from './test-fixture'
const file = (name: string, id = '3') => node(id, `/影视/${name}`)

describe('影视显示元数据与偏好', () => {
  it('显示中文与季度集号，自然排序保留不规则名称，不据此替代后端条目归属', () => {
    expect(episode('片名 S02E003.mkv')).toEqual([2, 3]); expect(episode('故事 第 12 集.mp4')).toEqual([0, 12]); expect(episode('故事 E02.mkv')).toEqual([0, 2])
    expect(['第10集.mp4', '第2集.mp4', '第1集.mp4'].map(name => file(name)).sort(naturalOrder).map(file => file.name)).toEqual(['第1集.mp4', '第2集.mp4', '第10集.mp4'])
    expect(title('故事.S01E01.1080p.x264.mkv')).toBe('故事 S01E01'); expect(VIDEO_EXTENSIONS).toContain('avi')
  })
  it('进度与偏好拒绝无效数据，替换内容不继承旧引用', () => {
    expect(validProgress({ file: file('a'), seconds: NaN, duration: 4, completed: false })).toBe(false)
    expect(validProgress({ file: file('a'), seconds: 3, duration: 4, completed: false })).toBe(true)
    expect(sameContent(file('a'), { ...file('b'), content_version: 'v2' })).toBe(false)
    expect(preferences({ speed: 50, subtitleOffset: -100, subtitleSize: NaN, fit: 'wrong' as 'contain' })).toMatchObject({ speed: 2, subtitleOffset: -10, subtitleSize: 22, fit: 'contain' })
    expect(timeText(3661)).toBe('1:01:01'); expect(timeText(Infinity)).toBe('0:00')
  })
  it('文件身份和大小保留十进制字符串，超出 JavaScript 安全整数也不丢精度', () => {
    const max = file('大文件.mp4', '9223372036854775807')
    expect(contentRef(max)).toEqual({ id: '9223372036854775807', content_version: 'v1' })
    expect(validProgress({ file: max, seconds: 3, duration: 4, completed: false })).toBe(true)
    expect(sizeText('1073741824')).toBe('1.0 GiB')
    expect(sizeText('9223372036854775807')).toBe('8388607.9 TiB')
  })
  it('同番号电影独立播放，已有明确剧集资料时不误停自动连播', () => {
    expect(isNumberedMovie(file('ABC-001-part1.mp4'))).toBe(true)
    expect(isNumberedMovie(file('ABC-001.S01E01.mp4'))).toBe(false)
    expect(isNumberedMovie(file('影片.mp4'), { kind: 'movie', number: 'ABC-001' })).toBe(true)
    expect(isNumberedMovie(file('ABC-001.mp4'), { kind: 'episodedetails' })).toBe(false)
  })
})
// 原页面的海报优先级与字幕同行关联断言移到 backend/tests/index.rs，避免保留两套业务解析。
