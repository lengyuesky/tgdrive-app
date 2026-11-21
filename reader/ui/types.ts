import type { ReaderUi, EventListener } from '../runtime'
import type { NodeId } from '@tgdrive/page-sdk'
/** 阅读馆界面通用类型、视图路由与桥接接口。 */
import type { HostClient } from '@tgdrive/page-sdk'
import type { ReaderView, ViewContext } from '../view'
import type { Location } from '../state'
import type {
  BibliographicMetadata,
  CatalogItem,
  LibrarySnapshot,
  ReadingLibrary,
  ReadingDisplayStatus,
  LibraryKind,
  LibraryScope,
  ReadingUnit,
  UnitFormat,
  Work,
  WorkFlags,
} from '../library'

export type UiView = 'home' | 'library' | 'detail' | 'me'

export interface LibraryFilterState {
  kind?: LibraryKind
  groupId?: string
  query: string
  format?: UnitFormat
  sourceId?: NodeId
  status?: ReadingDisplayStatus
  sort: 'title' | 'added' | 'recent'
  view: 'works' | 'files'
  offset: number
  scrollTop: number
}

export type LibrarySelection = Pick<LibraryFilterState, 'kind' | 'format' | 'sourceId' | 'groupId'>

export interface UiContext {
  host: HostClient
  ui: ReaderUi
  openSettings(): Promise<void>
  onHostEvent(name: string, listener: EventListener): () => void
  library: ReadingLibrary
  kind: LibraryScope
  signal: AbortSignal
  openReader: (nodeId: NodeId, location?: Location) => Promise<void>
  openDetail: (item: CatalogItem | { unit: ReadingUnit; work?: Work }) => void
  switchView: (view: UiView) => void
  createShelf?: () => Promise<void>
  editShelf?: (nodeId: NodeId) => Promise<void>
  openLibrary?: (selection: LibrarySelection) => Promise<void>
  librarySelectionChanged?: (selection: LibrarySelection) => void
  reportError: (error: unknown) => void
  createReader: (context: ViewContext) => Promise<ReaderView>
  closeApp: () => Promise<void>
}
