import type { FileNode, HostClient, PageContext, PageUi, ScopeInfo, TaskProgress } from '@tgdrive/page-sdk'
import { ScraperApi, ScraperError } from './api'
import { active, retryable, stateName } from './model'
import type { Detail, DetailCursors, DetailPart, HistoryCursor, Item, Run, Settings, SettingsDraft, Status } from './model'
import { RecordCursor } from './pagination'
import type { PageAction } from './pagination'

export type ScraperUi = Pick<PageUi, 'pickDirectory' | 'requestScope' | 'task' | 'onNotice'>
const within = (root: string, path: string) => root === '/' || path === root || path.startsWith(`${root}/`)
export function directoryAccess(scope: ScopeInfo | null, directory: FileNode | null): 'none' | 'read_only' | 'read_write' {
  if (!scope || !directory) return 'none'
  const grants = scope.roots.filter(root => root.node && within(root.node.path, directory.path))
  return grants.some(root => root.access === 'read_write') ? 'read_write' : grants.some(root => root.access === 'read_only') ? 'read_only' : 'none'
}
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

/** 页面只选择范围、发送用户命令和观察。扫描、联网、写入与核实均在后端。 */
export class ScraperPage {
  readonly api: ScraperApi
  readonly historyCursor = new RecordCursor<HistoryCursor>()
  readonly itemCursor = new RecordCursor<number>()
  readonly detailCursor = { step: new RecordCursor<number>(), actor: new RecordCursor<number>(), attempt: new RecordCursor<number>() }
  settings: Settings | null = null
  scope: ScopeInfo | null = null
  directory: FileNode | null = null
  activeRun: Run | null = null
  latestRun: Run | null = null
  run: Run | null = null
  history: Run[] = []
  items: Item[] = []
  detail: Detail | null = null
  tab: 'scrape' | 'history' | 'connection' = 'scrape'
  ready = false
  preparing = false
  starting = false
  stopping = false
  saving = false
  historyLoading = false
  itemsLoading = false
  detailLoading = false
  settingsStale = false
  message = ''
  observationError = ''
  private readonly lifetime = new AbortController()
  private setup: AbortController | null = null
  private scopeEpoch = 0
  private granting = false
  private statusAbort: AbortController | null = null
  private statusPromise: Promise<void> | null = null
  private startPromise: Promise<Run> | null = null
  private stopPromise: Promise<void> | null = null
  private historyAbort: AbortController | null = null
  private itemsAbort: AbortController | null = null
  private detailAbort: AbortController | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private eventStarted = false
  private taskStamp = ''
  private readonly removeNotice: () => void

  constructor(readonly host: HostClient, readonly ui: ScraperUi, private readonly context: Pick<PageContext, 'launch'>, private readonly changed: () => void = () => {}) {
    this.api = new ScraperApi(host)
    this.removeNotice = ui.onNotice(notice => {
      if (notice.event === 'ui.task_cancel' && this.activeRun?.id === notice.data.task_id) void this.stop().catch(error => this.fail(error))
    })
  }
  get closed(): boolean { return this.lifetime.signal.aborted }
  get busy(): boolean { return active(this.activeRun) || this.preparing || this.starting || this.stopping || this.saving }
  get canRetry(): boolean { return retryable(this.run) && !this.busy }
  get access(): 'none' | 'read_only' | 'read_write' { return directoryAccess(this.scope, this.directory) }
  private signal(controller: AbortController): AbortSignal { return AbortSignal.any([this.lifetime.signal, controller.signal]) }
  private update(): void { if (!this.closed) { this.changed(); this.reportTask() } }
  fail(error: unknown): void { if (!this.closed && (error as Error)?.name !== 'AbortError') { this.message = errorText(error); this.update() } }
  clearMessage(): void { this.message = ''; this.update() }
  private invalidateStatus(): void { this.statusAbort?.abort(); this.itemsAbort?.abort(); this.detailAbort?.abort(); this.statusPromise = null; clearTimeout(this.timer) }
  private applyScope(scope: ScopeInfo): void {
    const changed = this.scope?.revision !== scope.revision
    if (changed) { this.scopeEpoch++; if (!this.granting) this.setup?.abort() }
    this.scope = scope
    if (changed && this.directory && directoryAccess(scope, this.directory) === 'none') this.directory = null
  }
  private applyStatus(status: Status): void {
    this.settings = status.settings
    this.activeRun = status.active
    this.latestRun = status.latest
    const current = status.active ?? status.latest
    if (!this.run && current) this.selectRun(current)
    else if (this.run?.id === status.active?.id) this.run = status.active
    else if (this.run?.id === status.latest?.id) this.run = status.latest
    this.history = this.history.map(row => row.id === status.active?.id ? status.active : row.id === status.latest?.id ? status.latest : row)
    this.observationError = ''
  }
  async initialize(options: { observe?: boolean } = {}): Promise<void> {
    await this.refresh(true)
    if (this.closed) return
    const initial = this.context.launch.action === 'open' && this.context.launch.file.kind === 'directory' ? this.context.launch.file : this.settings?.directory ?? (this.scope?.roots.length === 1 ? this.scope.roots[0].node : null)
    if (!this.directory && initial) {
      if (directoryAccess(this.scope, initial) !== 'none') {
        try { this.directory = await this.host.stat({ by: 'id', id: initial.id }, { signal: this.lifetime.signal }) }
        catch (error) { this.fail(error) }
      }
    }
    if (this.closed) return
    this.ready = true; this.update()
    if (options.observe !== false) void this.watchEvents()
  }
  async refresh(withScope = true): Promise<void> {
    if (this.closed) return
    if (this.statusPromise) return this.statusPromise
    const controller = new AbortController(), signal = this.signal(controller)
    this.statusAbort = controller
    const pending = (async () => {
      const [status, scope] = await Promise.all([this.api.status(signal), withScope ? this.host.scope({ signal }) : Promise.resolve(null)])
      signal.throwIfAborted()
      if (scope) this.applyScope(scope)
      const previous = this.run?.id
      this.applyStatus(status); this.update()
      if (this.run && (previous !== this.run.id || this.tab === 'scrape')) await this.loadItems(previous === this.run.id ? 'refresh' : 'reset')
      signal.throwIfAborted()
      if (this.detail && active(this.run)) await this.loadDetail(this.detail.item.id)
    })()
    this.statusPromise = pending
    try { await pending }
    finally {
      if (this.statusPromise === pending) { this.statusPromise = null; this.statusAbort = null; this.schedulePoll() }
    }
  }
  private schedulePoll(): void {
    clearTimeout(this.timer)
    // 静止页面不反复唤醒 on_demand 后端；任务活动由后端 keepalive 续期。
    if (this.closed || !active(this.activeRun)) return
    this.timer = setTimeout(() => {
      void this.refresh(false).catch(error => {
        if (!this.closed && (error as Error)?.name !== 'AbortError') { this.observationError = `进度观察暂时中断：${errorText(error)}。页面故障不会停止后台任务，可刷新状态。`; this.update() }
      })
    }, 1500)
  }
  async watchEvents(): Promise<void> {
    if (this.eventStarted || this.closed) return
    this.eventStarted = true
    try {
      for await (const event of this.host.events({ signal: this.lifetime.signal })) {
        if (this.closed) break
        try {
          if (event.event === 'scope.changed' || event.event === 'sync.required') {
            await this.refresh(true)
          } else if (event.event === 'backend.changed' && active(this.activeRun)) await this.refresh(false)
          else if (event.event === 'app.changed') { this.message = '应用安装或启用状态已变化，请从应用中心重新打开'; this.update() }
        } catch (error) { if ((error as Error)?.name !== 'AbortError') throw error }
      }
    } catch (error) {
      if (!this.closed) { this.observationError = `事件观察暂时不可用：${errorText(error)}。可手动刷新，正在进行的任务仍由后端推进。`; this.update() }
    } finally { this.eventStarted = false }
  }
  async choose(): Promise<void> {
    if (this.busy || this.closed) return
    const controller = new AbortController(), signal = this.signal(controller)
    this.setup = controller; this.preparing = true; this.update()
    try {
      const selected = await this.ui.pickDirectory({ initial_id: this.directory?.id ?? null }, { signal })
      signal.throwIfAborted()
      if (!selected) return
      if (selected.kind !== 'directory') throw new Error('请选择网盘目录')
      const scope = await this.host.scope({ signal })
      signal.throwIfAborted()
      // 选择本身不授予权限；未授权的候选仅展示，开始时另请主人确认读写范围。
      this.scope = scope; this.directory = selected
      if (directoryAccess(scope, selected) !== 'none') {
        const fresh = await this.host.stat({ by: 'id', id: selected.id }, { signal })
        signal.throwIfAborted(); this.directory = fresh
      }
    } finally { if (this.setup === controller) this.setup = null; this.preparing = false; this.update() }
  }
  async authorize(): Promise<void> {
    if (this.busy || this.closed) return
    const controller = new AbortController(), signal = this.signal(controller)
    this.setup = controller; this.preparing = true; this.granting = true; this.update()
    try {
      const result = await this.ui.requestScope({ reason: '影视刮削需要在你确认的目录内整理视频、移动明确关联的配套文件并写入 NFO、海报和演员头像；不会删除文件。', preferred_access: 'read_write' }, { signal })
      signal.throwIfAborted()
      if (!result) return
      const scope = await this.host.scope({ signal })
      signal.throwIfAborted()
      this.scope = scope; this.scopeEpoch++
      if (!this.directory && scope.roots.length === 1) this.directory = scope.roots[0].node
      if (this.directory && directoryAccess(scope, this.directory) === 'none') this.directory = null
    } finally { this.granting = false; if (this.setup === controller) this.setup = null; this.preparing = false; this.update() }
  }
  async start(retry: Run | null = null): Promise<void> {
    if (this.busy || this.closed || !this.settings) return
    if (retry && !retryable(retry)) return
    const selected = retry?.root ?? this.directory
    if (!selected) throw new Error('请先选择刮削目录')
    const controller = new AbortController(), signal = this.signal(controller)
    this.setup = controller; this.preparing = true; this.message = ''; this.update()
    try {
      let scope = await this.host.scope({ signal })
      signal.throwIfAborted()
      if (directoryAccess(scope, selected) !== 'read_write') {
        this.granting = true
        try {
          const grant = await this.ui.requestScope({ reason: '开始刮削前，请确认所选目录及子目录的读写授权，用于整理视频和补齐影视资料；应用不会删除文件。', preferred_access: 'read_write' }, { signal })
          signal.throwIfAborted()
          if (!grant) return
          scope = await this.host.scope({ signal })
          signal.throwIfAborted()
          this.scope = scope
        } finally { this.granting = false }
      }
      if (directoryAccess(scope, selected) !== 'read_write') throw new Error('所选目录尚未获得读写授权，未开始任务')
      const fresh = await this.host.stat({ by: 'id', id: selected.id }, { signal })
      signal.throwIfAborted()
      if (fresh.kind !== 'directory' || fresh.path !== selected.path) throw new Error('原目录身份或位置已变化，请重新选择目录')
      this.scope = scope; this.directory = fresh
      this.invalidateStatus()
      this.preparing = false; this.starting = true; this.update()
      // 取消准备可阻止创建；已发送的创建命令只由后端记录判断，关闭页面不会撤销任务。
      const epoch = this.scopeEpoch
      const pending = this.api.start(crypto.randomUUID(), fresh.id, retry?.id ?? null, this.lifetime.signal)
      this.startPromise = pending
      try {
        const result = await pending
        if (this.closed) return
        this.latestRun = result; this.activeRun = active(result) ? result : null
        this.selectRun(result); this.tab = 'scrape'
        if (this.scopeEpoch !== epoch) this.message = '授权在启动期间已变化，请查看任务当前状态；后端会逐步骤核对授权'
        await this.loadItems('reset').catch(error => { if ((error as Error)?.name !== 'AbortError') throw error })
      } catch (error) {
        if (!this.closed) {
          await this.refresh(true).catch(() => {})
          throw error
        }
      } finally { if (this.startPromise === pending) this.startPromise = null }
    } finally {
      if (this.setup === controller) this.setup = null
      this.preparing = false; this.starting = false; this.update(); this.schedulePoll()
    }
  }
  async stop(): Promise<void> {
    if (this.closed) return
    if (this.stopPromise) return this.stopPromise
    this.setup?.abort()
    const starting = this.startPromise
    const previous = this.activeRun
    if (!starting && !active(previous)) return
    this.stopping = true; this.invalidateStatus(); this.update()
    const pending = (async () => {
      let target = previous
      if (starting) {
        try { target = await starting }
        catch { const status = await this.api.status(this.lifetime.signal); this.applyStatus(status); target = status.active }
      }
      if (this.closed || !target || !active(target)) return
      const result = await this.api.stop(target.id, this.lifetime.signal)
      if (this.closed) return
      this.invalidateStatus()
      this.latestRun = result
      if (!this.activeRun || this.activeRun.id === result.id) this.activeRun = active(result) ? result : null
      if (this.run?.id === result.id) this.run = result
      this.message = result.state === 'stopping' ? '正在停止，等待在途写入收尾或核实；已完成文件保留。' : '任务已停止，已完成文件保留。'
    })()
    this.stopPromise = pending
    try { await pending }
    finally { if (this.stopPromise === pending) this.stopPromise = null; this.stopping = false; this.update(); this.schedulePoll() }
  }
  async save(draft: SettingsDraft, token: string | null, revision = this.settings?.revision): Promise<Settings | null> {
    if (this.busy || this.closed || !this.settings || !revision) return null
    if (revision !== this.settings.revision || this.settingsStale) throw new ScraperError('设置已被其他页面修改，请先重新读取设置再保存', 'storage_conflict', 409)
    this.invalidateStatus()
    this.saving = true; this.message = ''; this.update()
    try {
      const result = await this.api.configure(revision, draft, token, this.lifetime.signal)
      if (this.closed) return null
      this.settings = result; this.settingsStale = false; this.message = '设置已保存。Token 不会回读到页面。'; this.update()
      return result
    } catch (error) {
      if ((error as ScraperError)?.code === 'storage_conflict') this.settingsStale = true
      throw error
    } finally { this.saving = false; this.update() }
  }
  async reloadSettings(): Promise<void> { await this.refresh(true); this.settingsStale = false; this.update() }
  private selectRun(run: Run): void {
    if (this.run?.id !== run.id) {
      this.itemsAbort?.abort(); this.items = []; this.itemCursor.clear(); this.closeDetail()
    }
    this.run = run
  }
  async openRun(run: Run): Promise<void> {
    this.selectRun(run); this.tab = 'scrape'; this.update(); await this.loadItems('reset')
  }
  async setTab(tab: 'scrape' | 'history' | 'connection'): Promise<void> {
    this.tab = tab; this.update()
    if (tab === 'history') await this.loadHistory('reset')
    else if (tab === 'scrape') await this.refresh(true)
  }
  async loadHistory(action: PageAction = 'refresh'): Promise<void> {
    if (this.closed || action === 'next' && this.historyCursor.next === null || action === 'previous' && !this.historyCursor.hasPrevious) return
    this.historyAbort?.abort()
    const controller = new AbortController(), signal = this.signal(controller), after = this.historyCursor.request(action)
    this.historyAbort = controller; this.historyLoading = true; this.update()
    try {
      const page = await this.api.history(after, signal)
      signal.throwIfAborted()
      this.historyCursor.accept(action, after, page.next_cursor)
      this.history = page.records; this.update()
    } finally { if (this.historyAbort === controller) { this.historyAbort = null; this.historyLoading = false; this.update() } }
  }
  async loadItems(action: PageAction = 'refresh'): Promise<void> {
    if (this.closed || !this.run || action === 'next' && this.itemCursor.next === null || action === 'previous' && !this.itemCursor.hasPrevious) return
    this.itemsAbort?.abort()
    const controller = new AbortController(), signal = this.signal(controller), after = this.itemCursor.request(action), id = this.run.id
    this.itemsAbort = controller; this.itemsLoading = true; this.update()
    try {
      const page = await this.api.items(id, after, signal)
      signal.throwIfAborted()
      if (this.run?.id !== id || page.run.id !== id || page.items.some(item => item.run_id !== id)) throw new Error('结果页与当前任务不符，请重新打开记录')
      this.itemCursor.accept(action, after, page.next_after)
      this.items = page.items; this.run = page.run; this.update()
    } finally { if (this.itemsAbort === controller) { this.itemsAbort = null; this.itemsLoading = false; this.update() } }
  }
  async openDetail(id: string): Promise<void> {
    this.closeDetail(); await this.loadDetail(id, 'reset')
  }
  async loadDetail(id: string, action: PageAction = 'refresh', part?: DetailPart): Promise<void> {
    if (this.closed) return
    if (part && (action === 'next' && this.detailCursor[part].next === null || action === 'previous' && !this.detailCursor[part].hasPrevious)) return
    this.detailAbort?.abort()
    const controller = new AbortController(), signal = this.signal(controller)
    this.detailAbort = controller; this.detailLoading = true; this.update()
    const cursors: DetailCursors = { step: this.detailCursor.step.after, actor: this.detailCursor.actor.after, attempt: this.detailCursor.attempt.after }
    if (action === 'reset') cursors.step = cursors.actor = cursors.attempt = null
    else if (part) cursors[part] = this.detailCursor[part].request(action)
    try {
      const detail = await this.api.detail(id, cursors, signal)
      signal.throwIfAborted()
      if (detail.item.id !== id || detail.item.run_id !== this.run?.id) throw new Error('执行明细与当前项目不符，请重新打开记录')
      for (const name of ['step', 'actor', 'attempt'] as const) this.detailCursor[name].accept(action === 'reset' ? 'reset' : name === part ? action : 'refresh', cursors[name], detail[`next_${name}`])
      this.detail = detail; this.update()
    } finally { if (this.detailAbort === controller) { this.detailAbort = null; this.detailLoading = false; this.update() } }
  }
  closeDetail(): void {
    this.detailAbort?.abort(); this.detail = null; this.detailLoading = false
    for (const cursor of Object.values(this.detailCursor)) cursor.clear()
    this.update()
  }
  private reportTask(): void {
    const run = this.activeRun ?? this.latestRun
    if (!run) return
    const task: TaskProgress = { id: run.id, title: `影视刮削 · ${stateName(run.state)}`, completed: run.counts.processed, ...(run.scan_complete ? { total: run.counts.total } : {}), state: active(run) ? 'running' : run.state === 'completed' ? 'completed' : run.state === 'cancelled' ? 'cancelled' : 'failed', cancellable: active(run) && run.state !== 'stopping' }
    const stamp = JSON.stringify(task)
    if (stamp === this.taskStamp) return
    this.taskStamp = stamp
    void this.ui.task(task, { signal: this.lifetime.signal }).catch(() => {})
  }
  /** 退出只取消本页面读取与观察；不发送停止，不持久化业务数据。 */
  dispose(): void {
    if (this.closed) return
    this.lifetime.abort(); this.setup?.abort(); clearTimeout(this.timer); this.removeNotice()
  }
}
