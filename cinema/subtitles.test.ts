import { describe, expect, it } from 'vitest'
import { cleanText, parseSubtitles, timestamp } from './subtitles'
import { vint } from './matroska'

describe('字幕文本解析与安全边界', () => {
  it('读取带 BOM 的 SRT、VTT 和多行中文', () => {
    const srt = '\uFEFF1\r\n00:00:01,500 --> 00:00:04,000\r\n你好\r\n第二行\r\n\r\n2\r\n00:00:07,000 --> 00:00:09,000\r\n下一句'
    expect(parseSubtitles(srt, 'srt')).toEqual([{ start: 1.5, end: 4, text: '你好\n第二行' }, { start: 7, end: 9, text: '下一句' }])
    expect(parseSubtitles('WEBVTT\n\nNOTE 忽略\n\n00:01.000 --> 00:04.000 align:start\n内容', 'vtt')).toEqual([{ start: 1, end: 4, text: '内容' }])
  })
  it('ASS 保留文本和逗号，不执行样式、HTML 或附件', () => {
    const ass = '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:05.50,Default,,0,0,0,,{\\pos(1,2)}你好,世界\\N<b>下一行</b>'
    expect(parseSubtitles(ass, 'ass')).toEqual([{ start: 1, end: 5.5, text: '你好,世界\n下一行' }])
    expect(cleanText('<img src=x onerror=alert(1)>字幕 &lt;b&gt;')).toBe('字幕 <b>')
  })
  it('拒绝超限，过滤损坏时间戳', () => {
    expect(timestamp('x:22')).toBeNaN()
    expect(parseSubtitles('1\n00:03 --> 00:01\n倒序', 'srt')).toEqual([])
    expect(() => parseSubtitles('x'.repeat(8 * 1024 * 1024 + 1), 'srt')).toThrow('8 MiB')
    expect(() => parseSubtitles('00:01 --> 00:02\nx\n\n'.repeat(50001), 'vtt')).toThrow('50000')
  })
  it('EBML 有界整数、未知长度及截断检查', () => {
    expect(vint(new Uint8Array([0x81]), 0)).toMatchObject({ value: 1, length: 1, unknown: false })
    expect(vint(new Uint8Array([0xff]), 0).unknown).toBe(true)
    expect(vint(new Uint8Array([0x1a,0x45,0xdf,0xa3]), 0, true).value).toBe(0x1a45dfa3)
    expect(() => vint(new Uint8Array([0]), 0)).toThrow()
    expect(() => vint(new Uint8Array([0x40]), 0)).toThrow('截断')
  })
})
