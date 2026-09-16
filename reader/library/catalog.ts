/** 书库筛选与排序只作用于当前索引，不把不完整索引冒充全库搜索。 */
import type { BibliographicMetadata, ReadingStatus, ReadingUnit, UnitFormat, UnitReading, Work, WorkFlags } from './model'
import { sortTitle } from './model'
import { resolvedMetadata } from './grouping'
import { aggregateFlags, aggregateReading } from './reading'

export interface LibraryQuery {
  query?: string
  format?: UnitFormat
  sourceId?: number
  status?: ReadingStatus
  wantToRead?: boolean
  favorite?: boolean
  sort?: 'title' | 'added' | 'recent'
  offset?: number
  limit?: number
  view?: 'works' | 'files'
}
export interface CatalogItem {
  id: string
  work?: Work
  units: ReadingUnit[]
  metadata: BibliographicMetadata
  reading: ReturnType<typeof aggregateReading>
  flags: WorkFlags
  firstIndexedAt: number
  ungrouped: boolean
}
export function queryLibrary(input: {
  units: readonly ReadingUnit[]; works: readonly Work[]; complete: boolean
  metadata?: ReadonlyMap<number, BibliographicMetadata>; readings?: ReadonlyMap<number, UnitReading>; flags?: ReadonlyMap<string, WorkFlags>
}, query: LibraryQuery = {}) {
  const units = new Map(input.units.map(unit => [unit.nodeId, unit])), metadata = input.metadata ?? new Map(), readings = input.readings ?? new Map(), flags = input.flags ?? new Map()
  const workFor = new Map(input.works.flatMap(work => work.members.map(member => [member.unitId, work] as const)))
  const item = (members: ReadingUnit[], work?: Work, wholeWork = true): CatalogItem => {
    const first = members[0]!, meta = resolvedMetadata(first, work, metadata.get(first.nodeId))
    if (members.length > 1 && work?.overrides.title === undefined) meta.title = work?.overrides.series ?? metadata.get(first.nodeId)?.series ?? meta.title
    return { id: work?.id ?? `file:${first.nodeId}`, work, units: members, metadata: meta, reading: aggregateReading(wholeWork && work ? work.members.map(member => readings.get(member.unitId)) : members.map(unit => readings.get(unit.nodeId))),
      flags: work ? aggregateFlags(work, input.works, flags) : { schemaVersion: 1, wantToRead: false, favorite: false },
      firstIndexedAt: work?.firstIndexedAt ?? first.firstIndexedAt, ungrouped: !work || work.grouping === 'single' }
  }
  let items: CatalogItem[]
  if (query.view === 'files') items = input.units.map(unit => ({ ...item([unit], workFor.get(unit.nodeId), false), id: `file:${unit.nodeId}`, firstIndexedAt: unit.firstIndexedAt }))
  else {
    items = input.works.filter(work => !work.redirectTo).flatMap(work => {
      const members = work.members.flatMap(member => units.get(member.unitId) ? [units.get(member.unitId)!] : [])
      return members.length ? [item(members, work)] : []
    })
    items.push(...input.units.filter(unit => !workFor.has(unit.nodeId)).map(unit => item([unit])))
  }
  const needle = query.query?.normalize('NFKC').toLocaleLowerCase().trim()
  items = items.filter(item => (!needle || [item.metadata.title ?? '', ...(item.metadata.authors ?? []), ...item.units.map(unit => unit.file.name)].some(value => value.normalize('NFKC').toLocaleLowerCase().includes(needle)))
    && (!query.format || item.units.some(unit => unit.format === query.format))
    && (query.sourceId === undefined || item.units.some(unit => unit.sourceIds.includes(query.sourceId!)))
    && (!query.status || item.reading.status === query.status)
    && (query.wantToRead === undefined || item.flags.wantToRead === query.wantToRead)
    && (query.favorite === undefined || item.flags.favorite === query.favorite))
  items.sort((a, b) => (query.sort === 'added' ? b.firstIndexedAt - a.firstIndexedAt : query.sort === 'recent' ? b.reading.updatedAt - a.reading.updatedAt : sortTitle(a.metadata.title ?? '', b.metadata.title ?? '')) || a.id.localeCompare(b.id))
  const total = items.length, offset = Math.max(0, Math.floor(query.offset ?? 0)), limit = Math.max(1, Math.min(200, Math.floor(query.limit ?? 60)))
  return { items: items.slice(offset, offset + limit), total, nextOffset: offset + limit < total ? offset + limit : null,
    complete: input.complete, scopeLabel: input.complete ? '已整理书库' : '仅已整理范围；可切换文件视图继续查找' }
}
