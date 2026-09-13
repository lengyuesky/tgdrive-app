import { describe, expect, it } from 'vitest'
import type { FileEntry } from '../sdk/types'
import { coverCandidates, episode, naturalOrder, preferences, sameContent, subtitleFiles, timeText, title, validProgress, VIDEO_EXTENSIONS } from './model'
export const file = (name: string, id = 1): FileEntry => ({ id, name, path: `/影视/${name}`, content_version: 'a'.repeat(64), is_dir: false, size: 1234, favorite: false, created_at: 1, modified_at: 1 })
describe('影视元数据与偏好', () => {
  it('识别常见中文与季度集号，自然排序并保留不规则名称', () => {
    expect(episode('片名 S02E003.mkv')).toEqual([2, 3])
    expect(episode('故事 第 12 集.mp4')).toEqual([0, 12])
    expect(episode('故事 E02.mkv')).toEqual([0, 2])
    expect(['第10集.mp4', '第2集.mp4', '第1集.mp4'].map(file).sort(naturalOrder).map(f => f.name)).toEqual(['第1集.mp4', '第2集.mp4', '第10集.mp4'])
    expect(title('故事.S01E01.1080p.x264.mkv')).toBe('故事 S01E01')
    expect(VIDEO_EXTENSIONS).toContain('avi')
  })
  it('按本地海报优先级筛选，不接受 SVG 或不相关字幕', () => {
    const video = file('故事.mp4'), list = ['cover.png', '故事.jpg', 'poster.webp', 'backdrop.jpg', '故事.svg'].map(file)
    expect(coverCandidates(video, list).map(f => f.name)).toEqual(['故事.jpg', 'poster.webp', 'cover.png'])
    expect(coverCandidates(video, list, true)[0].name).toBe('backdrop.jpg')
    expect(subtitleFiles(video, ['故事.zh.srt','别的故事.srt','故事.ass','故事2.vtt'].map(file)).map(f => f.name)).toEqual(['故事.ass','故事.zh.srt'])
  })
  it('进度和偏好拒绝无效数据，内容替换不沿用旧引用', () => {
    expect(validProgress({ file: file('a'), seconds: NaN, duration: 4, completed: false })).toBe(false)
    expect(validProgress({ file: file('a'), seconds: 3, duration: 4, completed: false })).toBe(true)
    expect(sameContent(file('a'), { ...file('b'), content_version: 'b' })).toBe(false)
    expect(preferences({ speed: 50, subtitleOffset: -100, subtitleSize: NaN, fit: 'wrong' as any })).toMatchObject({ speed: 2, subtitleOffset: -10, subtitleSize: 22, fit: 'contain' })
    expect(timeText(3661)).toBe('1:01:01'); expect(timeText(Infinity)).toBe('0:00')
  })
})
