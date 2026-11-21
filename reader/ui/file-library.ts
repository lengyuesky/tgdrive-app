/** 通用文件分页视图：两路按名称或时间归并，当前位置与 CAS 保存都由应用管理。 */
import type { FileNode, JsonValue, KvRecord, NodeId } from '@tgdrive/page-sdk'
import { kvCondition } from '../records'
import { discoverPage, validDiscoveryCursor, type DiscoveryCursor, type DiscoveryQuery } from '../library/discovery'
import { parseUnit, contentKind, scopeFormats, unitFormat, within, type LibraryScope, type ReadingUnit } from '../library/model'
import { ViewportCoverLoader, sourceLabel } from '../library'
import type { UiContext } from './types'
const POSITION_KEY = 'reader:browse:v1'
interface Position { schemaVersion: 1; query: DiscoveryQuery; page: number }
function position(raw: unknown, kind: LibraryScope, roots: NodeId[]): Position | undefined {
  const value = raw as Position | null, query = value?.query
  if (!value || value.schemaVersion !== 1 || !Number.isSafeInteger(value.page) || value.page < 1 || !query || !['all', 'books', 'comics'].includes(query.kind)
    || kind !== 'all' && kind !== query.kind || !Array.isArray(query.roots) || !query.roots.length || query.roots.some(id => !roots.includes(id))
    || !['name', 'created_at', 'modified_at'].includes(query.sort) || query.limit !== 40
    || query.q !== undefined && (typeof query.q !== 'string' || new TextEncoder().encode(query.q).length > 255)
    || query.format !== undefined && !scopeFormats(query.kind).includes(query.format)
    || query.cursor != null && !validDiscoveryCursor(query.cursor)) return undefined
  return structuredClone(value)
}
export class FileLibraryView {
  private lifetime = new AbortController()
  private request?: AbortController
  private generation = 0
  private coverLoader?: ViewportCoverLoader
  private query: DiscoveryQuery
  private page = 1
  private next: DiscoveryCursor | null = null
  private history: { cursor: DiscoveryCursor | null; page: number }[] = []
  private record: KvRecord | null = null
  private storageHealthy = true
  private saving = Promise.resolve()
  private unsubscribers: (() => void)[] = []
  private validPage = false
  private readonly positionKey: string
  constructor(private container: HTMLElement, private context: UiContext, private back: () => void, private sourceId?: NodeId) {
    this.positionKey = POSITION_KEY + (sourceId === undefined ? '' : ':source:' + sourceId)
    this.query = { kind: context.kind, roots: this.roots(), sort: 'name', limit: 40, cursor: null }
  }
  private roots() { return this.context.library.snapshot.sources.config.sources.filter(source => this.sourceId === undefined || source.nodeId === this.sourceId).map(source => source.nodeId) }
  private get<T extends HTMLElement = HTMLElement>(id: string): T { return this.container.querySelector<T>(`#host-${id}`)! }
  private status(message: string) { this.get('status').textContent = message }
  async render() {
    const signal = AbortSignal.any([this.lifetime.signal, this.context.signal])
    this.container.innerHTML = `<div class="library-view-container">
      <div class="library-toolbar">
        <div class="toolbar-search-row"><button id="host-back" type="button" class="btn-link">返回已整理书库</button><input id="host-search" type="search" aria-label="全库文件名搜索" placeholder="搜索这个书库的文件名…" /><button id="host-apply" type="button" class="btn-primary">查询</button><button id="host-refresh" type="button" class="btn-refresh">从首页刷新</button></div>
        <div class="toolbar-filters-row">
          ${this.context.kind === 'all' ? '<select id="host-kind" aria-label="全库内容类型"><option value="all">全部书漫</option><option value="books">图书</option><option value="comics">漫画</option></select>' : ''}
          <select id="host-source" aria-label="全库来源"><option value="">全部已添加来源</option></select><select id="host-format" aria-label="全库格式"><option value="">全部格式</option></select><select id="host-sort" aria-label="全库排序"><option value="name">按文件名</option><option value="created_at">按文件创建时间</option><option value="modified_at">按文件修改时间</option></select>
        </div>
      </div>
      <p id="host-description">只分页查询所选书库目录及子目录。宿主仅筛选通用文件属性；书籍格式与直属图片目录在应用内组织。作者、作品分组和阅读状态筛选请返回已整理书库。</p>
      <p id="host-status" class="library-status-msg" role="status"></p><p id="host-save-status" role="status"></p><button id="host-retry" type="button" class="btn-primary" hidden>重试本页</button><div id="host-items" class="library-grid" role="list"></div><div class="library-pagination"><button id="host-prev" type="button" class="btn-page" disabled>上一页</button><span id="host-page" class="page-indicator"></span><button id="host-next" type="button" class="btn-page" disabled>下一页</button></div>
    </div>`
    this.get('back').onclick = () => { this.destroy(); this.back() }
    const source = this.get<HTMLSelectElement>('source')
    for (const item of this.context.library.snapshot.sources.config.sources) source.append(new Option(sourceLabel(item), item.nodeId))
    if (this.sourceId !== undefined) { source.value = this.sourceId; source.hidden = true }
    const kind = this.get<HTMLSelectElement>('kind')
    if (kind) kind.onchange = () => { this.fillFormats(kind.value as LibraryScope); this.apply() }
    this.get('apply').onclick = () => this.apply(); this.get('refresh').onclick = () => this.apply()
    this.get('search').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); this.apply() } }
    this.get('retry').onclick = () => { void this.load() }
    this.get('prev').onclick = () => { const previous = this.history.pop(); if (!previous) return; this.query.cursor = previous.cursor; this.page = previous.page; void this.load() }
    this.get('next').onclick = () => {
      if (!this.next || !this.validPage) return
      this.history.push({ cursor: structuredClone(this.query.cursor ?? null), page: this.page }); if (this.history.length > 100) this.history.shift()
      this.query.cursor = structuredClone(this.next); this.page++; void this.load()
    }
    for (const name of ['files.changed', 'scope.changed', 'sync.required']) this.unsubscribers.push(this.context.onHostEvent(name, () => {
      this.generation++; this.request?.abort(); this.coverLoader?.clear(); this.validPage = false
      this.get('items').replaceChildren(); this.get('items').setAttribute('aria-busy', 'false')
      this.get<HTMLButtonElement>('next').disabled = this.get<HTMLButtonElement>('prev').disabled = true; this.get('retry').hidden = true
      this.status('文件或权限已变化，请从首页刷新；旧分页位置不再直接采用。')
    }))
    this.status('正在读取浏览位置…')
    try {
      this.record = (await this.context.host.kvGet(this.positionKey, { signal })).record
      if (signal.aborted) return
      const saved = position(this.record?.value, this.context.kind, this.roots())
      if (this.record && !saved) throw new Error('浏览位置版本未知')
      if (saved) { this.query = saved.query; this.page = saved.page }
    } catch { if (signal.aborted) return; this.storageHealthy = false; this.get('save-status').textContent = '浏览位置读取失败，本次不覆盖已有位置。' }
    const configured = this.roots()
    if (!configured.length || this.query.roots.some(id => !configured.includes(id))) {
      this.query.roots = configured; this.query.cursor = null; this.page = 1; this.history = []
    }
    this.get<HTMLInputElement>('search').value = this.query.q ?? ''; if (kind) kind.value = this.query.kind
    this.fillFormats(this.query.kind); source.value = this.query.roots.length === 1 ? this.query.roots[0]! : ''
    this.get<HTMLSelectElement>('format').value = this.query.format ?? ''; this.get<HTMLSelectElement>('sort').value = this.query.sort
    await this.load()
  }
  private apply() {
    const selected = this.sourceId ?? this.get<HTMLSelectElement>('source').value
    this.query = { roots: selected ? [selected] : this.roots(), kind: this.get<HTMLSelectElement>('kind')?.value as LibraryScope || this.context.kind, q: this.get<HTMLInputElement>('search').value.trim(), format: this.get<HTMLSelectElement>('format').value as ReadingUnit['format'] || undefined, sort: this.get<HTMLSelectElement>('sort').value as DiscoveryQuery['sort'], limit: 40, cursor: null }
    this.page = 1; this.history = []; void this.load()
  }
  private fillFormats(kind: LibraryScope) { const select = this.get<HTMLSelectElement>('format'); select.replaceChildren(new Option('全部格式', '')); for (const format of scopeFormats(kind)) select.append(new Option(format === 'images' ? '图片目录' : format.toUpperCase(), format)) }
  private async load() {
    this.request?.abort(); this.request = new AbortController()
    const signal = AbortSignal.any([this.request.signal, this.lifetime.signal, this.context.signal]), active = ++this.generation
    const current = () => !signal.aborted && active === this.generation
    const query = structuredClone(this.query), pageNumber = this.page
    this.context.librarySelectionChanged?.({ kind: query.kind === 'all' ? undefined : query.kind, format: query.format, sourceId: query.roots.length === 1 ? query.roots[0] : undefined, groupId: undefined })
    this.validPage = false; this.next = null; this.coverLoader?.destroy(); this.coverLoader = undefined
    this.get('items').replaceChildren(); this.get('items').setAttribute('aria-busy', 'true'); this.get('retry').hidden = true
    this.get<HTMLButtonElement>('next').disabled = this.get<HTMLButtonElement>('prev').disabled = true
    this.get('page').textContent = `第 ${pageNumber} 页`; this.status('正在加载目录文件…')
    if (!query.roots.length) { this.status('请先创建书库并绑定目录。'); this.get('items').setAttribute('aria-busy', 'false'); return }
    try {
      const result = await discoverPage(this.context.host, query, signal), roots = await this.context.library.access.roots(signal)
      if (!current()) return
      const units = result.items.map(file => this.unit(file, query, roots.roots.filter(root => query.roots.includes(root.source.nodeId)).map(root => ({ id: root.source.nodeId, path: root.file.path }))))
      this.next = result.next_cursor; this.validPage = true
      if (typeof IntersectionObserver !== 'undefined') this.coverLoader = new ViewportCoverLoader(this.context.library.covers, signal)
      for (const unit of units) this.get('items').append(this.card(unit))
      this.status(units.length ? '已加载当前页；浏览位置会自动保存。' : '当前书库没有匹配的阅读文件。')
      this.get<HTMLButtonElement>('next').disabled = !this.next; this.get<HTMLButtonElement>('prev').disabled = !this.history.length
      this.saving = this.saving.then(async () => {
        if (!current() || !this.storageHealthy) return
        try { this.record = await this.context.host.kvPut(this.positionKey, { value: { schemaVersion: 1, query, page: pageNumber } as unknown as JsonValue, condition: kvCondition(this.record?.revision) }, { signal: this.lifetime.signal }) }
        catch { this.storageHealthy = false; if (!this.lifetime.signal.aborted) this.get('save-status').textContent = '浏览位置未同步或已被其他页面更新；当前页仍可阅读，未覆盖远端位置。' }
      })
      await this.saving
    } catch (error) {
      if (!current()) return
      this.get('items').replaceChildren()
      const changed = ['scope_changed', 'cursor_expired', 'invalid_cursor', 'page_changed'].includes((error as { code?: string }).code ?? '')
      this.status(changed ? '分页位置已失效，请点击“从首页刷新”。' : '本页加载失败，筛选和浏览位置已保留。'); this.get('retry').hidden = changed
      this.get<HTMLButtonElement>('prev').disabled = changed || !this.history.length; this.context.reportError(error)
    } finally { if (current()) this.get('items').setAttribute('aria-busy', 'false') }
  }
  private unit(file: FileNode, query: DiscoveryQuery, roots: { id: NodeId; path: string }[]): ReadingUnit {
    const format = unitFormat(file, query.kind)
    if (!format || query.format && format !== query.format || query.kind !== 'all' && contentKind(format) !== query.kind) throw new Error('通用查询返回了不支持的阅读格式')
    return parseUnit({ nodeId: file.id, file, format, sourceIds: roots.filter(root => within(file.path, root.path)).map(root => root.id), firstIndexedAt: file.created_at })
  }
  private card(unit: ReadingUnit) {
    const card = document.createElement('button'); card.type = 'button'; card.className = 'library-card'; card.dataset.fileId = unit.nodeId
    const wrapper = document.createElement('div'); wrapper.className = 'card-cover'
    const art = document.createElement('div'); art.className = 'cover-art'
    const initial = document.createElement('span'); initial.className = 'cover-initial'; initial.textContent = unit.file.name.slice(0, 1)
    const mark = document.createElement('span'); mark.className = 'file-mark'; mark.textContent = unit.format === 'images' ? '目录' : unit.format.toUpperCase()
    art.append(initial, mark); wrapper.append(art)
    const info = document.createElement('div'); info.className = 'card-info'
    const title = document.createElement('strong'); title.className = 'card-title'; title.textContent = unit.file.name
    const path = document.createElement('span'); path.className = 'file-meta'; path.textContent = unit.file.path
    info.append(title, path); card.append(wrapper, info); this.coverLoader?.observe(art, unit)
    card.onclick = () => { if (this.validPage) void this.context.openReader(unit.nodeId).catch(this.context.reportError) }
    return card
  }
  destroy() { this.generation++; this.lifetime.abort(); this.request?.abort(); this.coverLoader?.destroy(); for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe() }
}
