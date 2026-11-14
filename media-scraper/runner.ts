import type { Drive, FileEntry, ScraperCandidate, ScraperHandle, ScraperPreview, ScraperRecord } from '../sdk/types'
import { VIDEO_EXTENSIONS, groups, normalizedNumber, reference, resultReason, sharedCompanion, foldName, stem, uniqueExact, type Group } from './model'

export type ItemState = 'waiting' | 'checking' | 'ready' | 'running' | 'done' | 'skipped' | 'failed' | 'stopped'
export interface RunItem { group: Group; state: ItemState; reason: string; plan?: ScraperPreview; candidate?: ScraperCandidate }
export interface RunOptions { refresh: boolean; update_nfo: boolean; update_poster: boolean }
export type RunPhase = 'idle' | 'scanning' | 'checking' | 'running' | 'stopping' | 'completed' | 'stopped' | 'failed'

/** 先读完目录快照再写入，避免移动视频使后续搜索分页失效或漏项。 */
export async function scanDirectory(drive: Drive, root: FileEntry, signal: AbortSignal, progress: (count: number) => void): Promise<Group[]> {
  const files = new Map<number, FileEntry>(), seen = new Set<string>()
  let cursor: string | null = null
  do {
    signal.throwIfAborted()
    const page = await drive.files.searchPage({ under: root.path, kind: 'file', extensions: VIDEO_EXTENSIONS, limit: 100, cursor }, { signal })
    signal.throwIfAborted()
    for (const file of page.results) {
      if (file.is_dir || !(root.path === '/' || file.path.startsWith(`${root.path}/`))) throw new Error('扫描结果超出所选目录，请重新选择目录')
      files.set(file.id, file)
    }
    progress(files.size)
    cursor = page.has_more ? page.next_cursor : null
    if (page.has_more && (!cursor || seen.has(cursor))) throw new Error('目录列表已变化，请重新开始刮削')
    if (cursor) seen.add(cursor)
  } while (cursor)
  return groups([...files.values()])
}

/** 页面负责推进所有步骤；关闭页面或停止后不再发起下一步。 */
export class DirectoryScrape {
  phase: RunPhase = 'idle'
  items: RunItem[] = []
  scanned = 0
  status = ''
  current = ''
  batch?: ScraperHandle
  recordIds: string[] = []
  private controller = new AbortController()
  private executionController = new AbortController()
  private mutation?: Promise<unknown>
  private stopPromise?: Promise<void>
  private heartbeat?: ReturnType<typeof setInterval>
  private active = false
  private sources = new Map<string, Promise<ScraperCandidate[]>>()
  private readonly scrape

  constructor(private drive: Drive, private changed: () => void) {
    if (!drive.scraper) throw new Error('当前宿主不支持影视刮削')
    this.scrape = drive.scraper
  }
  get busy() { return this.active || this.phase === 'stopping' }
  private get awaitingStop() { return this.phase === 'stopping' }
  get counts() {
    const count = (states: ItemState[]) => this.items.filter(item => states.includes(item.state)).reduce((sum, item) => sum + item.group.files.length, 0)
    return { total: this.scanned, done: count(['done']), skipped: count(['skipped']), failed: count(['failed']), processed: count(['done', 'skipped', 'failed']) }
  }
  private update() { this.changed() }
  private check() { this.controller.signal.throwIfAborted() }
  private async create(root: FileEntry) {
    this.check()
    this.mutation = this.scrape.create(reference(root)).then(batch => { this.batch = batch; this.recordIds.push(batch.id) })
    try { await this.mutation } finally { this.mutation = undefined }
    this.check()
  }
  async start(root: FileEntry, options: RunOptions, retryFiles?: FileEntry[]): Promise<void> {
    if (this.busy) return
    this.active = true; this.phase = 'scanning'; this.items = []; this.scanned = 0; this.current = ''
    this.controller = new AbortController(); this.executionController = new AbortController(); this.stopPromise = undefined; this.batch = undefined; this.recordIds = []; this.sources.clear()
    this.status = '正在扫描目录及子目录…'; this.update()
    let failed = false
    try {
      const found = retryFiles ? groups(retryFiles) : await scanDirectory(this.drive, root, this.controller.signal, count => { this.scanned = count; this.update() })
      this.check()
      this.items = found.map(group => ({ group, state: 'waiting', reason: '' }))
      this.scanned = found.reduce((sum, group) => sum + group.files.length, 0)
      if (!found.length) { this.phase = 'completed'; this.status = '目录中没有支持的视频。'; return }
      let pending = this.items
      // 只有检查结果明确的项目进入执行批次；网络中断或跨组资料冲突时重建剩余批次。
      for (;;) {
        await this.create(root)
        this.phase = 'checking'
        let rebuild = false
        for (const item of pending) {
          this.check(); this.current = item.group.files.map(file => file.name).join('、')
          item.state = 'checking'; this.status = '正在识别视频和检查已有资料…'; this.update()
          try { await this.prepare(item, options) }
          catch (error) {
            this.check()
            item.state = 'failed'; item.reason = resultReason(error instanceof Error ? error.message : String(error))
            rebuild = true
          }
          this.update()
        }
        const ready = pending.filter(item => item.state === 'ready')
        for (const item of ready) {
          const related = ready.filter(other => other.plan?.target_path === item.plan?.target_path)
          const bases = new Set(related.flatMap(other => other.group.files.map(file => foldName(stem(file.name)))))
          if (bases.size > 1 && [item.plan?.nfo, item.plan?.poster].some(artifact => artifact && artifact.action !== 'keep' && sharedCompanion(artifact.name, bases))) {
            item.state = 'skipped'; item.reason = '配套资料同时关联多个视频，无法确定归属'; rebuild = true
          }
        }
        pending = ready.filter(item => item.state === 'ready')
        if (!pending.length) { await this.closeDraft(); break }
        if (!rebuild) { await this.execute(pending); break }
        // 本轮至少剔除一个失败或冲突项目；每次重建都缩小待处理范围。
        await this.closeDraft()
      }
      this.check()
      this.phase = 'completed'; this.current = ''
      this.status = `刮削完成：成功 ${this.counts.done}，跳过 ${this.counts.skipped}，失败 ${this.counts.failed}。`
    } catch (error) {
      failed = !this.controller.signal.aborted
      if (failed) this.status = resultReason(error instanceof Error ? error.message : String(error))
      const reason = this.status
      try { await this.stop() } catch { /* 未确认停止时保留停止状态和再次停止入口。 */ }
      if (!this.awaitingStop) {
        this.phase = failed ? 'failed' : 'stopped'
        this.status = failed ? `刮削已停止：${reason}` : '已停止刮削，已完成的结果保留。'
      }
    } finally {
      this.active = false; clearInterval(this.heartbeat); this.heartbeat = undefined
      for (const item of this.items) if (['waiting', 'checking', 'ready', 'running'].includes(item.state)) item.state = 'stopped'
      this.update()
    }
  }
  private async prepare(item: RunItem, options: RunOptions) {
    const { group } = item, signal = this.controller.signal
    const request = (candidate?: ScraperCandidate) => this.scrape.preview({ batch: this.batch!, files: group.files.map(reference), number: group.number, candidate: candidate ?? null, shared_ids: [], ...options }, { signal })
    item.plan = await request(); this.check()
    if (item.plan.needs_candidate) {
      const key = normalizedNumber(group.number)
      let source = this.sources.get(key)
      if (!source) { source = this.scrape.search(group.number, { signal }); this.sources.set(key, source) }
      let candidates: ScraperCandidate[]
      try { candidates = await source } catch (error) { this.sources.delete(key); throw error }
      this.check()
      const candidate = uniqueExact(candidates, group.number)
      if (!candidate) {
        item.state = 'skipped'; item.reason = candidates.length ? '未找到唯一的番号精确匹配' : '未找到匹配资料'; return
      }
      item.candidate = candidate; item.plan = await request(candidate); this.check()
    }
    item.state = item.plan.ready ? 'ready' : 'skipped'
    item.reason = item.plan.ready ? '' : resultReason(item.plan.error ?? '无法确定该视频的资料或文件归属')
  }
  private async execute(items: RunItem[]) {
    const batch = this.batch!
    this.check()
    this.mutation = this.scrape.begin(batch)
    try { await this.mutation } finally { this.mutation = undefined }
    this.check(); this.phase = 'running'; this.status = '正在刮削…'; this.update()
    this.heartbeat = setInterval(() => {
      void this.scrape.heartbeat(batch).catch(error => {
        this.status = resultReason(error instanceof Error ? error.message : String(error))
        void this.stop().catch(() => {})
      })
    }, 5000)
    const byId = new Map(items.map(item => [item.plan!.id, item]))
    for (;;) {
      this.check()
      const next = items.find(item => item.state === 'ready' || item.state === 'running')
      if (next) { next.state = 'running'; this.current = next.group.files.map(file => file.name).join('、'); this.update() }
      const result = await this.scrape.next(batch, { signal: this.executionController.signal })
      this.check()
      const item = result.item_id ? byId.get(result.item_id) : undefined
      if (item) {
        item.reason = resultReason(result.result?.reason ?? '')
        if (result.status === 'done') item.state = 'done'
        else if (result.status === 'needs_user') item.state = 'skipped'
        else if (result.paused || result.status === 'needs_verification') item.state = 'failed'
      }
      this.update()
      if (result.done) { this.batch = undefined; return }
      if (result.paused) throw new Error(resultReason(result.result?.reason ?? '服务连接中断，请稍后重试未完成项'))
    }
  }
  private async closeDraft() {
    this.check()
    if (this.batch) {
      const result = await this.scrape.stop(this.batch)
      if (!result.stopped) throw new Error('正在停止上一次检查，请稍后重试')
      this.batch = undefined
    }
    this.check()
  }
  stop(): Promise<void> {
    if (!this.busy && !this.batch) return Promise.resolve()
    if (this.stopPromise) return this.stopPromise
    this.controller.abort(); clearInterval(this.heartbeat); this.heartbeat = undefined
    this.phase = 'stopping'; this.status = '正在停止刮削…'; this.update()
    this.stopPromise = (async () => {
      try {
        // create / begin 没有取消参数，必须等返回后停止，避免关闭页面后才开始执行。
        await this.mutation?.catch(() => {})
        if (this.batch) {
          let result = await this.scrape.stop(this.batch)
          for (let attempt = 0; !result.stopped && attempt < 10; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 250))
            result = await this.scrape.stop(this.batch)
          }
          if (!result.stopped) { this.status = '正在停止在途操作，可再次点击停止或在记录中查看结果。'; return }
          this.batch = undefined
        }
        // 先让宿主核实在途写入，再关闭等待中的响应，避免丢失提交状态。
        this.executionController.abort()
        this.phase = 'stopped'; this.status = '已停止刮削，已完成的结果保留。'
      } catch (error) { this.status = '停止请求尚未确认，请重试停止或查看操作记录。'; throw error }
      finally { if (this.phase === 'stopping') this.stopPromise = undefined; this.update() }
    })()
    return this.stopPromise
  }
}

export async function readRecord(drive: Drive, id: string, signal: AbortSignal): Promise<ScraperRecord> {
  let record = await drive.scraper!.record({ id }, { signal })
  const seen = new Set<number>()
  while (record.has_more) {
    signal.throwIfAborted()
    const after = record.next_after
    if (after == null || seen.has(after)) throw new Error('记录分页已变化，请刷新记录')
    seen.add(after)
    const next = await drive.scraper!.record({ id, after }, { signal })
    record = { ...record, items: [...record.items, ...next.items], has_more: next.has_more, next_after: next.next_after }
  }
  return record
}
