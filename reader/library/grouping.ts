/** 只归并完全一致的系列名和明确编号；裸数字、冲突版本与重复编号均待确认。 */
import { natural } from '../io'
import type { BibliographicMetadata, ReadingUnit, Work, WorkMember } from './model'
import { LibraryError, newId, validId } from './model'
import { cleanMetadata, validateOverrides } from './metadata-value'

export interface ComicName {
  title: string
  series?: string
  seriesKey?: string
  volume?: number
  number?: number
  numbering?: 'volume' | 'chapter'
  extra: boolean
  edition: string
  explicit: boolean
  reason?: string
}
const numeral = '[0-9零〇一二两兩三四五六七八九十百千万萬]+'
export function chineseNumber(text: string): number | undefined {
  if (/^\d+$/.test(text)) { const n = Number(text); return Number.isSafeInteger(n) && n <= 1_000_000 ? n : undefined }
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  if ([...text].every(char => char in digits)) { const number = Number([...text].map(char => digits[char]).join('')); return Number.isSafeInteger(number) && number <= 1_000_000 ? number : undefined }
  let total = 0, section = 0, digit = 0, last = Infinity
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000, 萬: 10000 }
  for (const char of text) {
    if (char in digits) { if (digit) return undefined; digit = digits[char]!; continue }
    const unit = units[char]
    if (!unit) return undefined
    if (unit === 10000) { if (total) return undefined; total = (section + digit || 1) * unit; section = 0; digit = 0; last = Infinity }
    else { if (unit >= last) return undefined; section += (digit || 1) * unit; digit = 0; last = unit }
  }
  const result = total + section + digit
  return result <= 1_000_000 ? result : undefined
}
export const normalizeSeries = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim()
const extras = /番外|外[传傳篇]|特[别別]篇|\b(?:extra|special|omake)\b/i
const editionTokens = /(?:\[(.*?)\]|【(.*?)】|\((.*?)\)|（(.*?)）)/g
function editionInfo(name: string) {
  const editions: string[] = []
  const stripped = name.replace(editionTokens, (whole, ...parts: string[]) => {
    const token = parts.slice(0, 4).find(Boolean)?.trim() ?? ''
    if (/简[体中]|簡[體中]|繁[体中體]|中文|汉化|漢化|日[文语語版]|英[文语語版]|\b(?:en|eng|english|jp|jpn|ja|zh|cn|raw)\b|版|修[订訂]|重制|重製/i.test(token)) {
      editions.push(normalizeSeries(token)); return ' '
    }
    return whole
  })
  const suffix = stripped.match(/(?:简体|簡體|繁体|繁體|中文版|英文版|日文版|修订版|修訂版|完全版|典藏版|重制版|重製版)$/)
  if (suffix) editions.push(normalizeSeries(suffix[0]))
  return { name: suffix ? stripped.slice(0, -suffix[0].length) : stripped, edition: editions.sort().join('|') }
}
export function parseComicName(filename: string): ComicName {
  const title = filename.replace(/\.(?:cbz|zip)$/i, '').normalize('NFKC').trim()
  const edition = editionInfo(title), name = edition.name, extra = extras.test(name)
  const markers: { at: number; end: number; value?: number; kind: 'volume' | 'chapter' }[] = []
  for (const match of name.matchAll(new RegExp(`第\\s*(${numeral})\\s*([卷话話章])`, 'g'))) markers.push({ at: match.index!, end: match.index! + match[0].length, value: chineseNumber(match[1]!), kind: match[2] === '卷' ? 'volume' : 'chapter' })
  for (const [label, kind] of [['vol(?:ume)?\\.?|v', 'volume'], ['ch(?:apter)?\\.?|c', 'chapter']] as const) {
    for (const match of name.matchAll(new RegExp(`(?:^|[\\s._-])(?:${label})\\s*(${numeral})(?!\\.\\d)(?=$|[\\s._()【】\\[\\]-])`, 'gi'))) markers.push({ at: match.index!, end: match.index! + match[0].length, value: chineseNumber(match[1]!), kind })
  }
  markers.sort((a, b) => a.at - b.at)
  const first = markers[0], series = first ? name.slice(0, first.at).replace(/[\s._-]+$/, '').trim() : undefined
  const base: ComicName = { title, series, seriesKey: series ? normalizeSeries(series) : undefined, extra, edition: edition.edition, explicit: false }
  if (!first || !series || markers.some(marker => marker.value === undefined) || markers.filter(marker => marker.kind === 'volume').length > 1 || markers.filter(marker => marker.kind === 'chapter').length > 1) return { ...base, reason: '缺少明确系列名及卷话编号，需人工确认' }
  if (/[\[\]【】()（）]/.test(name.slice(markers.at(-1)!.end))) return { ...base, reason: '编号后的附加标记含义不明，需人工确认' }
  const volume = markers.find(marker => marker.kind === 'volume')?.value, number = markers.find(marker => marker.kind === 'chapter')?.value
  return { ...base, volume, number, numbering: number === undefined ? 'volume' : 'chapter', explicit: true }
}
export function comicName(unit: ReadingUnit, metadata?: BibliographicMetadata): ComicName {
  const named = parseComicName(unit.file.name), embedded = cleanMetadata(metadata)
  if (embedded.series && (embedded.volume !== undefined || embedded.number !== undefined)) {
    return { ...named, series: embedded.series, seriesKey: normalizeSeries(embedded.series), volume: embedded.volume, number: embedded.number,
      numbering: embedded.number === undefined ? 'volume' : 'chapter', edition: embedded.language ?? named.edition, explicit: true, reason: undefined }
  }
  return named
}
const orderKey = (name: ComicName) => `${name.volume ?? ''}:${name.number ?? ''}`
const compareName = (a: ComicName, b: ComicName) => (a.volume ?? 0) - (b.volume ?? 0) || (a.number ?? 0) - (b.number ?? 0) || natural(a.title, b.title)
export interface GroupCandidate { units: ReadingUnit[]; names: ComicName[]; seriesKey?: string; safe: boolean; reason?: string }
export function groupingCandidates(units: readonly ReadingUnit[], metadata = new Map<number, BibliographicMetadata>()): GroupCandidate[] {
  const groups = new Map<string, { unit: ReadingUnit; name: ComicName }[]>(), singles: GroupCandidate[] = []
  for (const unit of units) {
    const name = comicName(unit, metadata.get(unit.nodeId))
    if (!name.explicit || !name.seriesKey || name.extra) { singles.push({ units: [unit], names: [name], safe: false, reason: name.extra ? '番外独立，不参与自动连读' : name.reason }); continue }
    const group = groups.get(name.seriesKey) ?? []; group.push({ unit, name }); groups.set(name.seriesKey, group)
  }
  for (const [seriesKey, group] of groups) {
    const reason = new Set(group.map(item => item.name.edition)).size > 1 ? '语言或版本标记冲突，需人工确认'
      : new Set(group.map(item => item.name.numbering)).size > 1 ? '卷话编号体系不同，需人工确认'
      : new Set(group.map(item => orderKey(item.name))).size !== group.length ? '存在重复卷话编号，需人工确认' : undefined
    group.sort((a, b) => compareName(a.name, b.name))
    singles.push({ units: group.map(item => item.unit), names: group.map(item => item.name), seriesKey, safe: !reason, reason })
  }
  return singles
}
export function parseWork(raw: unknown): Work {
  const work = raw as Work | null
  if (!work || !/^[a-f0-9]{32}$/.test(work.id) || !['books', 'comics'].includes(work.kind) || !Array.isArray(work.members)
    || work.members.length > 2000 || !work.members.every(member => member && validId(member.unitId) && ['main', 'extra'].includes(member.role) && (member.firstIndexedAt === undefined || Number.isFinite(member.firstIndexedAt) && member.firstIndexedAt >= 0))
    || new Set(work.members.map(member => member.unitId)).size !== work.members.length
    || !['single', 'automatic', 'manual'].includes(work.grouping) || typeof work.orderConfirmed !== 'boolean'
    || !Number.isFinite(work.firstIndexedAt) || work.firstIndexedAt < 0 || !work.members.length && !work.redirectTo
    || work.kind === 'books' && work.members.length > 1
    || work.redirectTo !== undefined && (!/^[a-f0-9]{32}$/.test(work.redirectTo) || work.members.length > 0)
    || work.seriesKey !== undefined && (typeof work.seriesKey !== 'string' || work.seriesKey.length > 4096)
    || work.reviewReason !== undefined && (typeof work.reviewReason !== 'string' || work.reviewReason.length > 300)) throw new LibraryError('invalid_work', '作品快照损坏，未覆盖人工整理数据')
  return { ...structuredClone(work), overrides: validateOverrides(work.overrides) }
}
export function validateWorks(works: readonly Work[]): Work[] {
  const parsed = works.map(parseWork), ids = new Set<string>(), members = new Set<number>()
  for (const work of parsed) {
    if (ids.has(work.id) || work.members.some(member => members.has(member.unitId))) throw new LibraryError('invalid_work', '作品或成员标识重复')
    ids.add(work.id); work.members.forEach(member => members.add(member.unitId))
  }
  for (const work of parsed) {
    let current = work, seen = new Set<string>()
    while (current.redirectTo) {
      if (seen.has(current.id)) throw new LibraryError('invalid_work', '作品合并指针循环')
      seen.add(current.id)
      const next = parsed.find(item => item.id === current.redirectTo)
      if (!next) throw new LibraryError('invalid_work', '作品合并目标不存在')
      current = next
    }
  }
  return parsed
}

/** 自动归组可在内嵌信息明确后合并既有单项；保留主 ID 和旧别名，人工整理不被刷新改写。 */
export function reconcileWorks(previous: readonly Work[], units: readonly ReadingUnit[], kind: Work['kind'], metadata = new Map<number, BibliographicMetadata>()): Work[] {
  const works = validateWorks(previous), assigned = new Set(works.flatMap(work => work.members.map(member => member.unitId)))
  const make = (members: ReadingUnit[], names?: ComicName[], seriesKey?: string, reason?: string): Work => ({ id: newId(), kind,
    members: members.map((unit, i) => ({ unitId: unit.nodeId, role: names?.[i]?.extra ? 'extra' : 'main', firstIndexedAt: unit.firstIndexedAt })),
    firstIndexedAt: Math.min(...members.map(unit => unit.firstIndexedAt)), grouping: members.length > 1 ? 'automatic' : 'single', seriesKey,
    orderConfirmed: kind === 'books' || !reason && !!names?.every(name => name.explicit && !name.extra), reviewReason: reason, overrides: {} })
  if (kind === 'books') { for (const unit of units) if (!assigned.has(unit.nodeId)) works.push(make([unit])); return works }
  const byId = new Map(units.map(unit => [unit.nodeId, unit]))
  for (const work of works) {
    if (work.grouping !== 'automatic') continue
    const known = work.members.flatMap(member => byId.has(member.unitId) ? [byId.get(member.unitId)!] : [])
    if (!known.length) continue
    const candidates = groupingCandidates(known, metadata)
    if (known.length !== work.members.length || candidates.length !== 1 || !candidates[0]!.safe || candidates[0]!.seriesKey !== work.seriesKey) {
      work.orderConfirmed = false; work.reviewReason = '成员或内嵌信息与既有归组不一致，请人工确认顺序'
    }
  }
  for (const group of groupingCandidates(units, metadata)) {
    const pending = group.units.filter(unit => !assigned.has(unit.nodeId))
    const existing = works.filter(work => !work.redirectTo && work.members.some(member => group.units.some(unit => unit.nodeId === member.unitId)))
    if (!group.safe) {
      for (const work of existing) if (work.grouping !== 'manual') { work.orderConfirmed = false; work.reviewReason = group.reason }
      for (const unit of pending) works.push(make([unit], [comicName(unit, metadata.get(unit.nodeId))], group.seriesKey, group.reason))
    } else if (!existing.length) {
      if (pending.length) works.push(make(pending, group.names, group.seriesKey))
    } else if (existing.every(work => work.grouping !== 'manual' && work.members.every(member => group.units.some(unit => unit.nodeId === member.unitId)))
      && (existing.length === 1 || existing.every(work => !Object.keys(work.overrides).length))) {
      existing.sort((a, b) => a.firstIndexedAt - b.firstIndexedAt)
      const work = existing[0]!, previousMembers = new Map(existing.flatMap(item => item.members.map(member => [member.unitId, member] as const)))
      const uncertain = existing.find(item => item.grouping === 'automatic' && !item.orderConfirmed)
      const embeddedOrder = group.units.every(unit => { const value = cleanMetadata(metadata.get(unit.nodeId)); return !!value.series && (value.volume !== undefined || value.number !== undefined) })
      work.members = group.units.map(unit => ({ unitId: unit.nodeId, role: 'main', firstIndexedAt: previousMembers.get(unit.nodeId)?.firstIndexedAt ?? unit.firstIndexedAt }))
      work.firstIndexedAt = Math.min(...existing.map(item => item.firstIndexedAt), ...group.units.map(unit => unit.firstIndexedAt))
      work.seriesKey = group.seriesKey; work.grouping = work.members.length > 1 ? 'automatic' : 'single'
      work.orderConfirmed = !uncertain || embeddedOrder
      work.reviewReason = work.orderConfirmed ? undefined : uncertain?.reviewReason
      // 别名保留原收藏/想读引用；不能为了归组删除这些记录或创建新的主作品标识。
      for (const other of existing.slice(1)) { other.members = []; other.redirectTo = work.id; other.grouping = 'automatic' }
    } else for (const unit of pending) works.push(make([unit], [comicName(unit, metadata.get(unit.nodeId))], group.seriesKey, '已有人工整理或部分成员，合并需确认'))
    pending.forEach(unit => assigned.add(unit.nodeId))
  }
  return validateWorks(works)
}
/** 详情路由可能仍持有合并前 ID，必须先沿别名解析到当前主作品。 */
export function resolveWork(works: readonly Work[], id: string): Work | undefined {
  let work = works.find(work => work.id === id)
  if (!work?.redirectTo) return work
  const byId = new Map(works.map(work => [work.id, work])), seen = new Set<string>()
  while (work?.redirectTo) {
    if (seen.has(work.id)) throw new LibraryError('invalid_work', '作品别名形成循环')
    seen.add(work.id); work = byId.get(work.redirectTo)
    if (!work) throw new LibraryError('invalid_work', '作品别名指向不存在的作品')
  }
  return work
}
export function nextWorkUnit(work: Work, current: number, available?: ReadonlySet<number>): number | undefined {
  if (!work.orderConfirmed) return undefined
  const index = work.members.findIndex(member => member.unitId === current)
  if (index < 0 || work.members[index]!.role === 'extra') return undefined
  const next = work.members.slice(index + 1).find(member => member.role === 'main')
  return next && (!available || available.has(next.unitId)) ? next.unitId : undefined
}
export function mergeWorks(previous: readonly Work[], ids: readonly string[]): Work[] {
  const works = validateWorks(previous), selected = ids.map(id => works.find(work => work.id === id && !work.redirectTo))
  if (ids.length < 2 || new Set(ids).size !== ids.length || selected.some(work => !work || work.kind !== 'comics')) throw new LibraryError('invalid_merge', '请选择至少两个漫画作品合并；图书保持一文件一作品')
  const target = selected[0]!
  target.members = selected.flatMap(work => work!.members); target.grouping = 'manual'; target.orderConfirmed = false; target.reviewReason = '合并后请确认成员顺序'
  target.firstIndexedAt = Math.min(...selected.map(work => work!.firstIndexedAt))
  for (const work of selected.slice(1)) { work!.members = []; work!.redirectTo = target.id; work!.grouping = 'manual' }
  return validateWorks(works)
}
/** 第一组保留原作品标记，其余为新作品；各卷阅读进度和书签均保留。这不是撤销历史合并。 */
export function splitWork(previous: readonly Work[], id: string, groups: readonly (readonly number[])[]): Work[] {
  const works = validateWorks(previous), target = works.find(work => work.id === id && !work.redirectTo)
  if (!target || groups.length < 2 || groups.some(group => !group.length) || !sameMembers(target.members.map(member => member.unitId), groups.flat())) throw new LibraryError('invalid_split', '拆分必须且只能包含每个原成员一次')
  const original = target.members
  groups.forEach((ids, index) => {
    const work: Work = { ...structuredClone(target), id: index ? newId() : target.id, members: ids.map(id => original.find(member => member.unitId === id)!), grouping: 'manual', orderConfirmed: false, reviewReason: '拆分后请确认成员顺序' }
    if (index) works.push(work); else Object.assign(target, work)
  })
  return validateWorks(works)
}
function sameMembers(a: readonly number[], b: readonly number[]) { return a.length === b.length && new Set(b).size === b.length && b.every(id => a.includes(id)) }
export function reorderWork(previous: readonly Work[], id: string, members: readonly WorkMember[]): Work[] {
  const works = validateWorks(previous), target = works.find(work => work.id === id && !work.redirectTo)
  if (!target || !sameMembers(target.members.map(member => member.unitId), members.map(member => member.unitId))) throw new LibraryError('invalid_order', '排序必须且只能包含每个成员一次')
  target.members = members.map(member => ({ ...member, firstIndexedAt: target.members.find(previous => previous.unitId === member.unitId)?.firstIndexedAt ?? target.firstIndexedAt }))
  target.grouping = 'manual'; target.orderConfirmed = true; target.reviewReason = undefined
  return validateWorks(works)
}
export function editWorkMetadata(previous: readonly Work[], id: string, overrides: BibliographicMetadata): Work[] {
  const works = validateWorks(previous), target = works.find(work => work.id === id && !work.redirectTo)
  if (!target) throw new LibraryError('invalid_work', '作品不存在')
  target.overrides = validateOverrides(overrides)
  return works
}
export function resolvedMetadata(unit: ReadingUnit, work?: Work, embedded?: BibliographicMetadata): BibliographicMetadata {
  const name = parseComicName(unit.file.name)
  const named: BibliographicMetadata = { title: work && work.members.length > 1 && name.explicit ? name.series : unit.file.name.replace(/\.(?:txt|epub|pdf|cbz|zip)$/i, '') }
  return { ...named, ...cleanMetadata(embedded), ...(work?.overrides ?? {}) }
}
