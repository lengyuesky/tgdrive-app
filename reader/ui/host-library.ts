/** 全库文件分页：宿主维护索引；只驻留当前页，不把作品元数据筛选冒充全库查询。 */
import type { HostLibraryPage, HostLibraryQuery, RecordValue } from '../../sdk/types'
import { parseUnit, contentKind, scopeFormats, type LibraryScope, type ReadingUnit } from '../library/model'
import { ViewportCoverLoader, sourceLabel } from '../library'
import type { UiContext } from './types'

const POSITION_KEY = 'library:host-position:v1'
interface Position { schemaVersion: 1; query: HostLibraryQuery; page: number }
function position(raw: unknown, kind: UiContext['kind'], roots: number[]): Position | undefined {
  const p = raw as Position | undefined, q = p?.query
  if (!p || p.schemaVersion !== 1 || !Number.isSafeInteger(p.page) || p.page < 1 || !q || !['all', 'books', 'comics'].includes(q.kind) || kind !== 'all' && q.kind !== kind
    || !Array.isArray(q.roots) || !q.roots.length || q.roots.some(id => !roots.includes(id))
    || q.roots.length > 16 || (q.q !== undefined && (typeof q.q !== 'string' || q.q.length > 255))
    || (q.cursor !== undefined && q.cursor !== null && (typeof q.cursor !== 'string' || q.cursor.length > 8192))
    || (q.sort !== 'title' && q.sort !== 'added') || q.limit !== 40
    || (q.format !== undefined && !scopeFormats(q.kind).includes(q.format as ReadingUnit['format']))) return
  return { schemaVersion: 1, page: p.page, query: { roots: [...q.roots], kind: q.kind, q: q.q, format: q.format, sort: q.sort, limit: 40, cursor: q.cursor } }
}

export class HostLibraryView {
  private lifetime = new AbortController()
  private request?: AbortController
  private generation = 0
  private coverLoader?: ViewportCoverLoader
  private query: HostLibraryQuery
  private page = 1
  private next: string | null = null
  private history: { cursor: string | null; page: number }[] = []
  private record: RecordValue<unknown> | null = null
  private storageHealthy = true
  private saving = Promise.resolve()
  private unsubscribers: (() => void)[] = []
  private validPage = false
  private readonly positionKey: string
  constructor(private container: HTMLElement, private context: UiContext, private back: () => void, private sourceId?: number) {
    this.positionKey = POSITION_KEY + (sourceId === undefined ? '' : ':source:' + sourceId)
    this.query = { kind: context.kind, roots: this.roots(), sort: 'title', limit: 40, cursor: null }
  }
  private roots() { return this.context.library.snapshot.sources.config.sources.filter(source => this.sourceId === undefined || source.nodeId === this.sourceId).map(source => source.nodeId).sort((a, b) => a - b) }
  private get<T extends HTMLElement = HTMLElement>(id: string): T { return this.container.querySelector<T>(`#host-${id}`)! }
  private status(message: string) { this.get('status').textContent = message }
  async render() {
    const signal = AbortSignal.any([this.lifetime.signal, this.context.signal])
    this.container.innerHTML = `<div class="library-view-container">
      <div class="library-toolbar">
        <div class="toolbar-search-row">
          <button id="host-back" type="button" class="btn-link">返回已整理书库</button>
          <input id="host-search" type="search" aria-label="全库文件名搜索" placeholder="搜索全库文件名…" />
          <button id="host-apply" type="button" class="btn-primary">查询</button>
          <button id="host-refresh" type="button" class="btn-refresh">从首页刷新</button>
        </div>
        <div class="toolbar-filters-row">
          ${this.context.kind === 'all' ? '<select id="host-kind" aria-label="全库内容类型"><option value="all">全部书漫</option><option value="books">图书</option><option value="comics">漫画</option></select>' : ''}
          <select id="host-source" aria-label="全库来源"><option value="">全部已添加来源</option></select>
          <select id="host-format" aria-label="全库格式"><option value="">全部格式</option></select>
          <select id="host-sort" aria-label="全库排序"><option value="title">按文件名</option><option value="added">按文件创建时间</option></select>
        </div>
      </div>
      <p id="host-description">全库索引由宿主实时维护，无需在页面扫描；包含子目录，不受 2000 项整理上限限制。这里只按文件名与格式查询；作者、作品分组和阅读状态筛选请返回已整理书库。</p>
      <p id="host-status" class="library-status-msg" role="status"></p>
      <p id="host-save-status" role="status"></p>
      <button id="host-retry" type="button" class="btn-primary" hidden>重试本页</button>
      <div id="host-items" class="library-grid" role="list"></div>
      <div class="library-pagination">
        <button id="host-prev" type="button" class="btn-page" disabled>上一页</button>
        <span id="host-page" class="page-indicator"></span>
        <button id="host-next" type="button" class="btn-page" disabled>下一页</button>
      </div>
    </div>`
    this.get('back').onclick = () => { this.destroy(); this.back() }
    const source = this.get<HTMLSelectElement>('source')
    for (const item of this.context.library.snapshot.sources.config.sources) {
      const option = document.createElement('option'); option.value = String(item.nodeId); option.textContent = item.name ? sourceLabel(item) : item.path; source.append(option)
    }
    if (this.sourceId !== undefined) {
      source.value = String(this.sourceId); source.hidden = true
      this.get('description').textContent = '只分页查询当前书库绑定的目录及子目录，不聚合其他书库。创建时已扫描并保存应用索引；此视图用于继续查找超过整理上限的目录文件。'
      this.get<HTMLInputElement>('search').placeholder = '搜索这个书库的文件名…'
    }
    const kind = this.get<HTMLSelectElement>('kind')
    if (kind) kind.onchange = () => { this.fillFormats(kind.value as LibraryScope); this.apply() }
    this.get('apply').onclick = () => this.apply()
    this.get('refresh').onclick = () => this.apply()
    this.get('search').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); this.apply() } }
    this.get('retry').onclick = () => { void this.load() }
    this.get('prev').onclick = () => {
      const previous = this.history.pop(); if (!previous) return
      this.query.cursor = previous.cursor; this.page = previous.page; void this.load()
    }
    this.get('next').onclick = () => {
      if (!this.next || !this.validPage) return
      this.history.push({ cursor: this.query.cursor ?? null, page: this.page })
      if (this.history.length > 100) this.history.shift()
      this.query.cursor = this.next; this.page++; void this.load()
    }
    for (const event of ['files.changed', 'scope.changed', 'sync.hint']) {
      this.unsubscribers.push(this.context.drive.on(event, () => {
        this.generation++; this.request?.abort(); this.coverLoader?.clear(); this.validPage = false
        this.get('items').replaceChildren(); this.get('items').setAttribute('aria-busy', 'false')
        this.get<HTMLButtonElement>('next').disabled = true; this.get<HTMLButtonElement>('prev').disabled = true
        this.get('retry').hidden = true
        this.status('文件或权限已变化，请从首页刷新；旧浏览位置不会跳过校验。')
      }))
    }
    this.status('正在读取浏览位置…')
    try {
      this.record = await this.context.drive.storage.get(this.positionKey, { signal })
      if (signal.aborted) return
      const saved = position(this.record?.value, this.context.kind, this.roots())
      if (saved) { this.query = saved.query; this.page = saved.page }
    } catch (error) {
      if (signal.aborted) return
      this.storageHealthy = false
      this.get('save-status').textContent = '浏览位置读取失败，本次不覆盖已有位置。'
    }
    if (signal.aborted) return
    this.get<HTMLInputElement>('search').value = this.query.q ?? ''
    if (kind) kind.value = this.query.kind
    this.fillFormats(this.query.kind)
    source.value = this.query.roots.length === 1 ? String(this.query.roots[0]) : ''
    this.get<HTMLSelectElement>('format').value = this.query.format ?? ''
    this.get<HTMLSelectElement>('sort').value = this.query.sort ?? 'title'
    await this.load()
  }
  private apply() {
    const selected = this.sourceId === undefined ? this.get<HTMLSelectElement>('source').value : String(this.sourceId)
    this.query = { roots: selected ? [Number(selected)] : this.roots(), kind: this.get<HTMLSelectElement>('kind')?.value as LibraryScope || this.context.kind, q: this.get<HTMLInputElement>('search').value.trim(),
      format: this.get<HTMLSelectElement>('format').value || undefined, sort: this.get<HTMLSelectElement>('sort').value === 'added' ? 'added' : 'title', limit: 40, cursor: null }
    this.page = 1; this.history = []; void this.load()
  }
  private fillFormats(kind: LibraryScope) {
    const select = this.get<HTMLSelectElement>('format')
    select.replaceChildren(new Option('全部格式', ''))
    for (const format of scopeFormats(kind)) select.append(new Option(format === 'images' ? '图片目录' : format.toUpperCase(), format))
  }
  private async load() {
    this.request?.abort(); this.request = new AbortController()
    const signal = AbortSignal.any([this.request.signal, this.lifetime.signal, this.context.signal]), active = ++this.generation
    const current = () => !signal.aborted && active === this.generation
    const query = structuredClone(this.query), pageNumber = this.page
    this.context.librarySelectionChanged?.({
      kind: query.kind === 'all' ? undefined : query.kind,
      format: query.format as ReadingUnit['format'] | undefined,
      sourceId: query.roots.length === 1 ? query.roots[0] : undefined,
      groupId: undefined,
    })
    this.validPage = false; this.next = null
    this.coverLoader?.destroy(); this.coverLoader = undefined
    this.get('items').replaceChildren(); this.get('items').setAttribute('aria-busy', 'true')
    this.get('retry').hidden = true
    this.get<HTMLButtonElement>('next').disabled = true; this.get<HTMLButtonElement>('prev').disabled = true
    this.get('page').textContent = `第 ${pageNumber} 页`
    this.status('正在加载全库文件…')
    if (!query.roots.length) { this.status('请先在阅读馆添加来源目录。'); this.get('items').setAttribute('aria-busy', 'false'); return }
    try {
      const result = await this.context.drive.library!.page(query, { signal })
      if (!current()) return
      const units = this.validate(result, query)
      this.next = result.next_cursor; this.validPage = true
      if (typeof IntersectionObserver !== 'undefined') this.coverLoader = new ViewportCoverLoader(this.context.library.covers, signal)
      for (const unit of units) this.get('items').append(this.card(unit))
      this.status(units.length ? '已加载当前页；浏览位置会自动保存。' : '当前来源没有匹配的阅读文件。')
      this.get<HTMLButtonElement>('next').disabled = !this.next
      this.get<HTMLButtonElement>('prev').disabled = !this.history.length
      // 串行 CAS 保存；迟到页面不覆盖新页，多设备冲突后停止覆盖并提示。
      this.saving = this.saving.then(async () => {
        if (!current() || !this.storageHealthy) return
        try {
          const record = await this.context.drive.storage.set(this.positionKey, { schemaVersion: 1, query, page: pageNumber }, this.record?.revision ?? null, { signal: this.lifetime.signal })
          this.record = record
        } catch {
          this.storageHealthy = false
          if (!this.lifetime.signal.aborted) this.get('save-status').textContent = '浏览位置未同步或已被其他页面更新；当前页仍可阅读，未覆盖远端位置。'
        }
      })
      await this.saving
    } catch (error) {
      if (!current()) return
      this.get('items').replaceChildren()
      const changed = (error as { code?: string }).code === 'reading_index_changed'
      this.status(changed ? '文件树已变化，旧位置已失效，请点击“从首页刷新”。' : '本页加载失败，筛选和浏览位置已保留。')
      this.get('retry').hidden = changed
      this.get<HTMLButtonElement>('prev').disabled = changed || !this.history.length
      this.context.reportError(error)
    } finally { if (current()) this.get('items').setAttribute('aria-busy', 'false') }
  }
  private validate(result: HostLibraryPage, query: HostLibraryQuery): ReadingUnit[] {
    if (!result || typeof result.revision !== 'string' || result.revision.length > 128 || !Array.isArray(result.entries) || result.entries.length > 40
      || typeof result.has_more !== 'boolean' || (result.next_cursor !== null && (typeof result.next_cursor !== 'string' || !result.next_cursor || result.next_cursor.length > 8192))
      || result.has_more !== (result.next_cursor !== null) || result.next_cursor && result.next_cursor === query.cursor) throw new Error('宿主全库分页返回无效')
    const units = result.entries.map(item => {
      if (!item || !Array.isArray(item.source_ids) || item.source_ids.some(id => !query.roots.includes(id))) throw new Error('宿主返回了来源外的阅读文件')
      const unit = parseUnit({ nodeId: item.file?.id, file: item.file, format: item.format, sourceIds: item.source_ids, firstIndexedAt: item.file?.created_at })
      if (query.kind !== 'all' && contentKind(unit.format) !== query.kind || query.format && unit.format !== query.format) throw new Error('宿主返回了筛选范围外的阅读文件')
      return unit
    })
    if (new Set(units.map(unit => unit.nodeId)).size !== units.length) throw new Error('宿主全库分页包含重复节点')
    return units
  }
  private card(unit: ReadingUnit) {
    const card = document.createElement('button'); card.type = 'button'; card.className = 'library-card'; card.dataset.fileId = String(unit.nodeId)
    const wrapper = document.createElement('div'); wrapper.className = 'card-cover'
    const art = document.createElement('div'); art.className = 'cover-art'
    const initial = document.createElement('span'); initial.className = 'cover-initial'; initial.textContent = unit.file.name.slice(0, 1)
    const mark = document.createElement('span'); mark.className = 'file-mark'; mark.textContent = unit.format === 'images' ? '目录' : unit.format.toUpperCase()
    art.append(initial, mark); wrapper.append(art)
    const info = document.createElement('div'); info.className = 'card-info'
    const title = document.createElement('strong'); title.className = 'card-title'; title.textContent = unit.file.name
    const path = document.createElement('span'); path.className = 'file-meta'; path.textContent = unit.file.path
    info.append(title, path); card.append(wrapper, info)
    this.coverLoader?.observe(art, unit)
    card.onclick = () => { if (this.validPage) void this.context.openReader(unit.nodeId).catch(this.context.reportError) }
    return card
  }
  destroy() {
    this.generation++; this.lifetime.abort(); this.request?.abort(); this.coverLoader?.destroy()
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe()
  }
}
