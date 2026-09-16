/** 阅读馆界面通用类型、视图路由与桥接接口。 */
import type { Drive } from '../../sdk/types'
import type { ReaderView, ViewContext } from '../view'
import type { Location } from '../state'
import type {
  BibliographicMetadata,
  CatalogItem,
  LibrarySnapshot,
  ReadingLibrary,
  ReadingStatus,
  ReadingUnit,
  UnitFormat,
  Work,
  WorkFlags,
} from '../library'

export type UiView = 'home' | 'library' | 'detail' | 'me'

export interface LibraryFilterState {
  query: string
  format?: UnitFormat
  sourceId?: number
  status?: ReadingStatus
  sort: 'title' | 'added' | 'recent'
  view: 'works' | 'files'
  offset: number
  scrollTop: number
}

export interface UiContext {
  drive: Drive
  library: ReadingLibrary
  kind: 'books' | 'comics'
  signal: AbortSignal
  openReader: (nodeId: number, location?: Location) => Promise<void>
  openDetail: (item: CatalogItem | { unit: ReadingUnit; work?: Work }) => void
  switchView: (view: UiView) => void
  reportError: (error: unknown) => void
  createReader: (context: ViewContext) => Promise<ReaderView>
  closeApp: () => Promise<void>
}
