import { describe, expect, it } from 'vitest'
import { chineseNumber, editWorkMetadata, groupingCandidates, mergeWorks, nextWorkUnit, parseComicName, reconcileWorks, reorderWork, resolvedMetadata, splitWork, validateWorks, resolveWork } from './grouping'
import { file, unit } from './test-fixtures'

const comic = (id: number, name: string) => unit(file(id, `/漫画/${name}`))
describe('文件名谨慎归组及稳定作品', () => {
  it('识别卷话章、Vol/v、Ch/c 和常见中文数字，不猜裸数字或模糊系列名', () => {
    for (const [text, expected] of [['十', 10], ['二十三', 23], ['一百零二', 102], ['两千零二', 2002], ['一万零三', 10003], ['〇二', 2]] as const) expect(chineseNumber(text)).toBe(expected)
    expect(chineseNumber('十一二')).toBeUndefined(); expect(chineseNumber('九'.repeat(10))).toBeUndefined()
    for (const name of ['星河 第十二卷.cbz', '星河 Vol.12.zip', '星河 v12.cbz']) expect(parseComicName(name)).toMatchObject({ series: '星河', volume: 12, explicit: true })
    for (const name of ['星河 第十二话.cbz', '星河 第十二章.cbz', '星河 Ch12.cbz', '星河 c12.zip']) expect(parseComicName(name)).toMatchObject({ series: '星河', number: 12, explicit: true })
    for (const name of ['星河 12.cbz', '星河2024.zip', '第12卷.cbz', '星河 v1.5.cbz', '星河 第1卷 [不明标记].cbz']) expect(parseComicName(name).explicit).toBe(false)
    const candidates = groupingCandidates([comic(1, '星河 第1卷.cbz'), comic(2, '星河传 第2卷.cbz'), comic(3, '星河2.cbz')])
    expect(candidates.every(group => group.units.length === 1)).toBe(true)
  })
  it('混放目录只归组严格一致系列，正篇自然序，番外独立不自动连读', () => {
    const units = [comic(1, '星河 第十卷.cbz'), comic(2, '星河 第2卷.cbz'), comic(3, '星河 第1卷.cbz'), comic(4, '别的 第1话.zip'), comic(5, '星河 番外 第1卷.cbz'), comic(6, '未归组001.cbz')]
    const works = reconcileWorks([], units, 'comics')
    const series = works.find(work => work.members.length === 3)!
    expect(series.members.map(member => member.unitId)).toEqual([3, 2, 1])
    expect(nextWorkUnit(series, 3)).toBe(2)
    expect(nextWorkUnit(series, 1)).toBeUndefined()
    expect(nextWorkUnit(series, 3, new Set([1, 3]))).toBeUndefined()
    expect(works.find(work => work.members[0]?.unitId === 5)).toMatchObject({ orderConfirmed: false, members: [{ unitId: 5, role: 'extra', firstIndexedAt: 10 }] })
    expect(works.find(work => work.members[0]?.unitId === 6)?.grouping).toBe('single')
    const refreshed = reconcileWorks(works, [...units].reverse(), 'comics')
    expect(refreshed.map(work => work.id)).toEqual(works.map(work => work.id))
    const extended = reconcileWorks(works, [...units, comic(7, '星河 第3卷.cbz')], 'comics').find(work => work.id === series.id)!
    expect(extended.members.map(member => member.unitId)).toEqual([3, 2, 7, 1])
  })
  it('重复卷号、语言版本冲突和卷话体系混合不自动归并；后来出现冲突禁止下一卷', () => {
    for (const names of [
      ['星河 第1卷.cbz', '星河 Vol1.zip'],
      ['星河 第1卷 [简体].cbz', '星河 第2卷 [繁体].cbz'],
      ['星河 第1卷 [初版].cbz', '星河 第2卷 [修订版].cbz'],
      ['星河 第1卷.cbz', '星河 第2话.zip'],
    ]) {
      const works = reconcileWorks([], names.map((name, index) => comic(index + 1, name)), 'comics')
      expect(works).toHaveLength(2); expect(works.every(work => !work.orderConfirmed && !!work.reviewReason)).toBe(true)
    }
    const units = [comic(1, '星河 第1卷.cbz'), comic(2, '星河 第2卷.cbz')], prior = reconcileWorks([], units, 'comics')
    const conflicted = reconcileWorks(prior, [...units, comic(3, '星河 第2卷.zip')], 'comics')
    expect(conflicted[0]!.id).toBe(prior[0]!.id)
    expect(nextWorkUnit(conflicted[0]!, 1)).toBeUndefined()
  })
  it('有效内嵌元数据优先于名称；人工清空或修正字段仍优先，图书始终一文件一作品', () => {
    const units = [comic(1, '模糊名1.cbz'), comic(2, '模糊名2.cbz')]
    const metadata = new Map([[1, { series: '内嵌系列', title: '内嵌标题', volume: 1, authors: ['甲'] }], [2, { series: '内嵌系列', volume: 2, authors: ['甲'] }]])
    const works = reconcileWorks([], units, 'comics', metadata)
    expect(works).toHaveLength(1); expect(works[0]!.orderConfirmed).toBe(true)
    expect(resolvedMetadata(units[0]!, works[0], metadata.get(1)).title).toBe('内嵌标题')
    const edited = editWorkMetadata(works, works[0]!.id, { title: '人工书名', authors: [], description: '' })
    expect(resolvedMetadata(units[0]!, edited[0], metadata.get(1))).toMatchObject({ title: '人工书名', authors: [], description: '' })
    const books = [unit(file(10, '/书/星河 第1卷.epub')), unit(file(11, '/书/星河 第2卷.pdf'))]
    const bookWorks = reconcileWorks([], books, 'books')
    expect(bookWorks).toHaveLength(2)
    expect(() => validateWorks([{ ...bookWorks[0]!, members: bookWorks.flatMap(work => work.members) }])).toThrow(expect.objectContaining({ code: 'invalid_work' }))
  })
  it('后发现的内嵌系列冲突使既有自动归组待确认，缓存丢失也不擅自恢复下一卷', () => {
    const units = [comic(1, '星河 第1卷.cbz'), comic(2, '星河 第2卷.cbz')], original = reconcileWorks([], units, 'comics')
    const conflicted = reconcileWorks(original, units, 'comics', new Map([[1, { series: '另一系列', volume: 1 }]]))
    expect(conflicted[0]!.id).toBe(original[0]!.id)
    expect(nextWorkUnit(conflicted[0]!, 1)).toBeUndefined()
    expect(nextWorkUnit(reconcileWorks(conflicted, units, 'comics')[0]!, 1)).toBeUndefined()
    const confirmed = reorderWork(conflicted, conflicted[0]!.id, conflicted[0]!.members)
    expect(nextWorkUnit(confirmed[0]!, 1)).toBe(2)
  })
  it('内嵌编号完整后可重分类合并已有自动作品，手工确认和修正的独立作品不被吞并', () => {
    const units = [comic(1, '原一 第1卷.cbz'), comic(2, '原一 第2卷.cbz'), comic(3, '原二 第1卷.cbz'), comic(4, '原二 第2卷.cbz')]
    const initial = reconcileWorks([], units, 'comics'), metadata = new Map(units.map((unit, index) => [unit.nodeId, { series: '正确系列', number: index + 1 }]))
    const merged = reconcileWorks(initial, units, 'comics', metadata), active = merged.filter(work => !work.redirectTo)
    expect(active).toHaveLength(1); expect(active[0]!.id).toBe(initial[0]!.id)
    expect(active[0]!.members.map(member => member.unitId)).toEqual([1, 2, 3, 4]); expect(active[0]!.orderConfirmed).toBe(true)
    expect(merged.find(work => work.id === initial[1]!.id)?.redirectTo).toBe(initial[0]!.id)
    expect(resolveWork(merged, initial[1]!.id)?.id).toBe(initial[0]!.id)
    expect(resolveWork(merged, '不存在')).toBeUndefined()
    const manual = reorderWork(initial, initial[0]!.id, initial[0]!.members)
    expect(reconcileWorks(manual, units, 'comics', metadata).filter(work => !work.redirectTo)).toHaveLength(2)
    const corrected = editWorkMetadata(initial, initial[1]!.id, { title: '人工独立标题' })
    expect(reconcileWorks(corrected, units, 'comics', metadata).find(work => work.id === initial[1]!.id)).toMatchObject({ overrides: { title: '人工独立标题' }, members: initial[1]!.members })
  })
  it('作品别名不能悬空或成环', () => {
    const works = reconcileWorks([], [comic(1, '一.cbz'), comic(2, '二.cbz')], 'comics')
    expect(() => validateWorks([{ ...works[0]!, members: [], redirectTo: 'f'.repeat(32) }])).toThrow('不存在')
    const cycle = [{ ...works[0]!, members: [], redirectTo: works[1]!.id }, { ...works[1]!, members: [], redirectTo: works[0]!.id }]
    expect(() => validateWorks(cycle)).toThrow('循环')
    expect(() => resolveWork(cycle, works[0]!.id)).toThrow('循环')
  })
  it('手工合并拆分排序可重复保存，刷新不覆盖；排序必须覆盖每个成员一次', () => {
    const units = [comic(1, '一.cbz'), comic(2, '二.cbz'), comic(3, '三.cbz')], initial = reconcileWorks([], units, 'comics')
    let merged = mergeWorks(initial, initial.map(work => work.id)), id = initial[0]!.id
    expect(merged.find(work => work.id === id)!.members).toHaveLength(3)
    expect(merged.filter(work => work.redirectTo === id)).toHaveLength(2)
    expect(nextWorkUnit(merged[0]!, 1)).toBeUndefined()
    expect(() => reorderWork(merged, id, [{ unitId: 1, role: 'main' }, { unitId: 1, role: 'main' }])).toThrow('每个成员一次')
    merged = reorderWork(merged, id, [{ unitId: 3, role: 'main' }, { unitId: 2, role: 'extra' }, { unitId: 1, role: 'main' }])
    expect(nextWorkUnit(merged[0]!, 3)).toBe(1)
    expect(nextWorkUnit(merged[0]!, 2)).toBeUndefined()
    const refreshed = reconcileWorks(merged, units, 'comics')
    expect(refreshed).toEqual(merged)
    const split = splitWork(merged, id, [[3, 2], [1]])
    expect(split.find(work => work.id === id)!.members.map(member => member.unitId)).toEqual([3, 2])
    expect(split.filter(work => !work.redirectTo).map(work => work.members.length)).toEqual([2, 1])
    expect(() => splitWork(merged, id, [[3], [3, 1]])).toThrow('每个原成员一次')
    expect(initial.every(work => work.members.length === 1)).toBe(true)
  })
})
