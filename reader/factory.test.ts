import { describe, expect, it } from 'vitest'
import { createReader } from './factory'
import { TextReader } from './formats/text'
import { EpubReader } from './formats/epub'
import { PdfReader } from './formats/pdf'
import { ComicReader } from './formats/comic'
import { file, memoryHost, signal } from './library/test-fixtures'
import { readerDefaultPreferences, resolvePreferences } from './state'
import { LIMITS } from './io'
import type { ViewContext } from './view'

const context = async (name: string, isDir = false, size = 0): Promise<ViewContext> => ({
  host: (await memoryHost()).host, file: file(2, `/阅读/${name}`, isDir, 'v1', size), signal: signal(),
  viewport: document.createElement('div'), prefs: resolvePreferences(readerDefaultPreferences(), 'text'),
  navigate: work => work(), changed: () => {}, error: () => {},
})

describe('统一阅读器工厂', () => {
  it.each([['正文.TXT', TextReader], ['电子书.epub', EpubReader], ['文档.pdf', PdfReader], ['漫画.CBZ', ComicReader], ['漫画.zip', ComicReader]] as const)('%s 使用现有解析器', async (name, Reader) => {
    const reader = await createReader(await context(name))
    try { expect(reader).toBeInstanceOf(Reader) } finally { reader.destroy() }
  })
  it('带 .txt 后缀的真实目录仍交给图片目录解析器', async () => {
    const reader = await createReader(await context('图片.txt', true))
    try { expect(reader).toBeInstanceOf(ComicReader) } finally { reader.destroy() }
  })
  it('不支持的格式和超限图书在解析前明确失败', async () => {
    await expect(createReader(await context('电影.mp4'))).rejects.toThrow('支持 TXT')
    await expect(createReader(await context('巨型.txt', false, LIMITS.txt + 1))).rejects.toThrow('64 MiB')
  })
})
