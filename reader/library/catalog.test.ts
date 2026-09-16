import { describe, expect, it } from 'vitest'
import { queryLibrary } from './catalog'
import { reconcileWorks } from './grouping'
import { file, unit } from './test-fixtures'
import type { UnitReading } from './model'

describe('queryLibrary 整理范围内的筛选和排序', () => {
  it('只搜索名称和作者，不检索简介或正文；支持格式、来源、状态与独立标志', () => {
    const units = [unit(file(2, '/书/第一部.epub'), [1], 10), unit(file(3, '/另库/第二部.pdf'), [4], 20)], works = reconcileWorks([], units, 'books')
    const metadata = new Map([[2, { title: '长中文书名', authors: ['同名作者'], description: '只在简介出现' }]])
    const readings = new Map<number, UnitReading>([[2, { nodeId: 2, status: 'read', updatedAt: 30, versionChanged: false }]])
    const flags = new Map([[works[0]!.id, { schemaVersion: 1 as const, wantToRead: true, favorite: false }]])
    const input = { units, works, metadata, readings, flags, complete: false }
    const page = queryLibrary(input, { query: '作者', format: 'epub', sourceId: 1, status: 'read', wantToRead: true, favorite: false })
    expect(page.items.map(item => item.units[0]!.nodeId)).toEqual([2])
    expect(page.scopeLabel).toContain('仅已整理范围'); expect(page.complete).toBe(false)
    expect(queryLibrary(input, { query: '只在简介出现' }).items).toEqual([])
    expect(queryLibrary(input, { sort: 'added' }).items.map(item => item.units[0]!.nodeId)).toEqual([3, 2])
    expect(queryLibrary(input, { sort: 'recent' }).items.map(item => item.units[0]!.nodeId)).toEqual([2, 3])
    const first = queryLibrary(input, { limit: 1 })
    expect(first).toMatchObject({ total: 2, nextOffset: 1 })
  })
  it('作品/文件视图和未归组均可见；范围外未知成员不会被汇总为整部已读', () => {
    const units = [unit(file(2, '/漫画/星河 第1卷.cbz')), unit(file(3, '/漫画/星河 第2卷.zip')), unit(file(4, '/漫画/模糊001.cbz'))]
    const works = reconcileWorks([], units, 'comics')
    const readings = new Map<number, UnitReading>([[2, { nodeId: 2, status: 'read', updatedAt: 10, versionChanged: false }]])
    const input = { units, works, readings, complete: true }
    expect(queryLibrary(input).items).toHaveLength(2)
    expect(queryLibrary(input, { view: 'files' }).items).toHaveLength(3)
    expect(queryLibrary(input).items.find(item => item.units[0]!.nodeId === 4)?.ungrouped).toBe(true)
    const partial = queryLibrary({ ...input, units: [units[0]!] }).items[0]!
    expect(partial.reading).toMatchObject({ status: 'reading', percent: undefined })
    expect(queryLibrary(input, { view: 'files', status: 'read' }).items.map(item => item.units[0]!.nodeId)).toEqual([2])
  })
  it('图书文件的明确卷名不会因一文件一作品规则被截成系列标题', () => {
    const units = [unit(file(2, '/书/星河 第1卷.epub'))], works = reconcileWorks([], units, 'books')
    expect(queryLibrary({ units, works, complete: true }).items[0]!.metadata.title).toBe('星河 第1卷')
  })
})
