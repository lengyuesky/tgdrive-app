// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { numbers, groups, inferNumber, uniqueExact, sharedCompanion } from '../../media-scraper/model'
import { Descriptions, parseNfo, NFO_LIMIT } from '../../cinema/metadata'
import { coverCandidates, isNumberedMovie } from '../../cinema/model'
import { validateManifest } from '../../catalog.mjs'
import manifest from '../../media-scraper/app.json?raw'
import type { Drive, FileEntry } from '../../sdk/types'

const file = (name: string, id = 2, path = `/待整理/${name}`): FileEntry => ({id,name,path,is_dir:false,size:1024,content_version:'a'.repeat(64),created_at:1,modified_at:1,favorite:false})
describe('番号识别、自动匹配与共用文件范围', () => {
  it('识别常见番号和分段后缀，画质及电视剧季集不单独成为番号', () => {
    expect(numbers('ipx-001-4K.mp4')).toEqual(['IPX-001'])
    expect(numbers('IPX001-CD1.mkv')).toEqual(['IPX-001'])
    expect(numbers('FC2-PPV-1234567.mp4')).toEqual(['FC2-PPV-1234567'])
    expect(numbers('200GANA-1234.mp4')).toEqual(['200GANA-1234'])
    expect(numbers('123456_001.mp4')).toEqual(['123456_001'])
    expect(numbers('S01E03.1080p.H265.mkv')).toEqual([])
    expect(inferNumber(file('未知.mkv',2,'/待整理/ABC-123/未知.mkv'))).toBe('ABC-123')
    expect(inferNumber(file('ABC-123-DEF-456.mp4'))).toBe('')
  })
  it('同目录同基本名的扩展名版本分成同一组，分段保留独立组', () => {
    const result = groups([file('ABC-123.mp4'),file('ABC-123.mkv',3),file('ABC-123-CD1.mp4',4)])
    expect(result.map(group=>group.files.length)).toEqual([2,1])
    expect(result[0].files.map(file=>file.id)).toEqual([2,3])
  })
  it('采用唯一精确候选，忽略模糊结果；多个精确来源直接跳过', () => {
    const one = {provider:'A',id:'a1',number:'ABC-123',title:'影片'}
    expect(uniqueExact([one],'abc123')).toEqual(one)
    expect(uniqueExact([one,{...one,provider:'B'}],'ABC-123')).toBeUndefined()
    expect(uniqueExact([{...one,number:'ABC-124'}],'ABC-123')).toBeUndefined()
    expect(uniqueExact([one,{...one,id:'other',number:'ABC-124'}],'ABC-123')).toEqual(one)
    expect(uniqueExact([one,one],'ABC-123')).toEqual(one)
  })
  it('字幕语言后缀和海报别名同时匹配多个视频时列为共用文件', () => {
    const videos=new Set(['abc-123','abc-123.zh','abc-123-poster'])
    expect(sharedCompanion('ABC-123.zh.srt',videos)).toBe(true)
    expect(sharedCompanion('ABC-123-poster.jpg',videos)).toBe(true)
    expect(sharedCompanion('ABC-123-poster.nfo',videos)).toBe(false)
    expect(sharedCompanion('FOLDER.JPEG',videos)).toBe(true)
    expect(sharedCompanion('ABC-123.en.srt',videos)).toBe(false)
  })
})
describe('两端刮削资料消费契约', () => {
  it('缺少 NFO 的番号版本也不会自动连播，明确季集命名仍保持剧集行为', () => {
    expect(isNumberedMovie(file('ABC-123-4K.mp4'))).toBe(true)
    expect(isNumberedMovie(file('movie.mp4',2,'/ABC-123/movie.mp4'))).toBe(true)
    expect(isNumberedMovie(file('S01E03.mp4',2,'/ABC-123/S01E03.mp4'))).toBe(false)
    expect(isNumberedMovie(file('ABC-123.mp4'),{kind:'episodedetails'})).toBe(false)
  })
  it('完整读取超过旧 4 KiB 的中文简介，XML 实体只解码一次', () => {
    const overview = '原始中文长简介。'.repeat(3000)
    const value = parseNfo(new TextEncoder().encode(`<movie><num>ABC-123</num><title>甲 &amp; 乙</title><plot><![CDATA[${overview}]]></plot><year>2025</year><originaltitle>&amp;lt;</originaltitle></movie>`))
    expect(value).toMatchObject({title:'甲 & 乙',overview,year:'2025',number:'ABC-123',originalTitle:'&lt;'})
  })
  it('拒绝外部实体、非法 XML 和超过统一预算的资料', () => {
    for (const xml of ['<!DOCTYPE movie [<!ENTITY x SYSTEM "file:///private-test">]><movie/>','<movie><title>缺少闭合</movie>',`<movie><plot>${'a'.repeat(NFO_LIMIT)}</plot></movie>`]) expect(parseNfo(new TextEncoder().encode(xml))).toBeUndefined()
  })
  it('专属 -poster JPEG 优先，基本名资料和目录共用资料保持统一顺序', () => {
    const video = file('ABC-123.mp4')
    const images = [file('poster.jpg',10),file('ABC-123.jpg',11),file('ABC-123-poster.jpg',12),file('folder.jpg',13)]
    expect(coverCandidates(video,images).map(image=>image.id)).toEqual([12,11,10,13])
  })
  it('目录分页中的大写专属 NFO 优先于第一页的共用资料', async () => {
    const video = file('ABC-123.mp4'), shared = file('movie.nfo', 10), specific = file('ABC-123.NFO', 11)
    const bytes = new TextEncoder().encode('<movie><title>专属标题</title></movie>')
    const list = vi.fn(async ({ cursor }: { cursor?: string | null }) => cursor
      ? { entries: [specific], has_more: false, next_cursor: null }
      : { entries: [video, shared], has_more: true, next_cursor: 'second' })
    const readRange = vi.fn(async (source: FileEntry) => { expect(source.id).toBe(specific.id); return bytes })
    const drive = { files: { list, stat: async ({ id }: { id: number }) => [video, shared, specific].find(source => source.id === id)!, readRange } } as unknown as Drive
    expect(await new Descriptions(drive).load(video, new AbortController().signal)).toMatchObject({ title: '专属标题' })
    expect(list).toHaveBeenCalledTimes(2)
    expect(readRange).toHaveBeenCalledTimes(1)
  })
  it('读取期间配套文件移出目录时不展示已取回的旧资料', async () => {
    const video = file('ABC-123.mp4'), source = file('ABC-123.nfo', 10)
    let moved = false
    const drive = { files: {
      list: async () => ({ entries: [source], has_more: false, next_cursor: null }),
      stat: async ({ id }: { id: number }) => id === video.id ? video : { ...source, path: moved ? '/其他目录/ABC-123.nfo' : source.path },
      readRange: async () => { moved = true; return new TextEncoder().encode('<movie><title>旧标题</title></movie>') },
    } } as unknown as Drive
    expect(await new Descriptions(drive).load(video, new AbortController().signal)).toBeUndefined()
  })
  it('只有固定刮削应用、足够宿主版本和明确权限能够声明写入能力', () => {
    const source = JSON.parse(manifest)
    expect(()=>validateManifest(source)).not.toThrow()
    for (const patch of [{id:'reader'},{api_version:1},{min_host_version:'0.3.9'},{permissions:['files.read','scraper.service']}]) expect(()=>validateManifest({...source,...patch})).toThrow()
  })
})
