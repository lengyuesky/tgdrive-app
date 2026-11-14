import type { Drive, FileEntry, ScraperCandidate, ScraperHandle, ScraperPreview, ScraperRecord, ScraperResult } from '../sdk/types'
import { VIDEO_EXTENSIONS, groups, normalizedNumber, reference, resultReason, sharedCompanion, foldName, stem, exactCandidates, type Group } from './model'
import { JournalError, RunJournal } from './journal'

export type ItemState = 'waiting' | 'checking' | 'ready' | 'running' | 'done' | 'skipped' | 'failed' | 'stopped'
export interface RunItem { group: Group; state: ItemState; reason: string; plan?: ScraperPreview; candidate?: ScraperCandidate; result?: ScraperResult }
export interface RunOptions { refresh: boolean; update_nfo: boolean; update_poster: boolean }
export type RunPhase = 'idle' | 'scanning' | 'checking' | 'running' | 'stopping' | 'completed' | 'stopped' | 'failed'
const reason = (error: unknown) => resultReason(error instanceof Error ? error.message : String(error))
const sourceReasons = (errors: string[]) => errors.slice(0, 3).join('；') + (errors.length > 3 ? `；另有 ${errors.length - 3} 次来源失败，详见操作记录` : '')
const fatal = (error: unknown) => {
  const failure = error as { code?: string; status?: number }
  return error instanceof JournalError || failure?.status === 401 || failure?.status === 403 || failure?.code === 'app_changed'
}
const transient = (error: unknown) => {
  const failure = error as { code?: string; status?: number }
  return failure?.code === 'rate_limited' || failure?.status === 429 || /HTTP\s*(?:429|5\d\d)|超时|连接失败|连接中断|响应中断|网络|timeout|failed to fetch/i.test(reason(error))
}
function retryDelay(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted()
    const cancelled = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancelled); resolve() }, 800)
    signal.addEventListener('abort', cancelled, { once: true })
  })
}

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

/** 页面逐番号推进；同号各组同批检查目标关系，文件仍按各自原目录整理。 */
export class DirectoryScrape {
  phase: RunPhase = 'idle'
  items: RunItem[] = []
  scanned = 0
  status = ''
  current = ''
  batch?: ScraperHandle
  recordIds: string[] = []
  journal?: RunJournal
  settled: Promise<void> = Promise.resolve()
  private finish?: () => void
  private controller = new AbortController()
  private executionController = new AbortController()
  private mutation?: Promise<unknown>
  private stopPromise?: Promise<void>
  private batchStop?: Promise<void>
  private heartbeat?: ReturnType<typeof setInterval>
  private generation = 0
  private active = false
  private indexes = new Map<RunItem, number>()
  private sources = new Map<string, Promise<ScraperCandidate[]>>()
  private sourceChoices = new Map<string, ScraperCandidate>()
  private sourcePins = new Map<string, ScraperCandidate>()
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
  private async saveItem(item: RunItem) { await this.journal!.item(this.indexes.get(item)!, item, this.batch?.id); this.update() }
  private async create(root: FileEntry) {
    this.check()
    const fresh = await this.drive.files.stat({ id: root.id }, { signal: this.controller.signal })
    if (!fresh.is_dir || fresh.path !== root.path) throw new Error('所选目录已变化，请重新选择')
    this.check(); this.sourceChoices.clear(); this.executionController = new AbortController()
    this.mutation = this.scrape.create(reference(fresh)).then(async batch => {
      this.batch = batch; this.recordIds.push(batch.id)
      // 批次标识必须先确认保存，随后才能 begin/next；不会把 owner 写入可恢复记录。
      await this.journal!.batch(batch.id)
    })
    try { await this.mutation } finally { this.mutation = undefined }
    this.check()
  }
  async start(root: FileEntry, options: RunOptions, retryFiles?: FileEntry[]): Promise<void> {
    if (this.busy) return
    this.settled = new Promise(resolve => { this.finish = resolve })
    this.active = true; this.phase = 'scanning'; this.items = []; this.scanned = 0; this.current = ''
    this.controller = new AbortController(); this.executionController = new AbortController(); this.stopPromise = undefined; this.batchStop = undefined
    this.batch = undefined; this.recordIds = []; this.journal = undefined; this.sources.clear(); this.sourcePins.clear(); this.indexes.clear()
    this.status = '正在扫描目录及子目录…'; this.update()
    try {
      this.journal = await RunJournal.create(this.drive, root); this.check()
      const found = retryFiles ? groups(retryFiles) : await scanDirectory(this.drive, root, this.controller.signal, count => { this.scanned = count; this.update() })
      this.check()
      this.items = found.map(group => ({ group, state: group.number ? 'waiting' : 'skipped', reason: group.number ? '' : '文件名和所在目录中没有唯一可识别的番号' }))
      this.items.forEach((item, index) => this.indexes.set(item, index))
      this.scanned = found.reduce((sum, group) => sum + group.files.length, 0)
      await this.journal.discovered(this.items); this.check()
      await this.journal.save('checking', '正在逐部刮削…', this.counts)
      const units = new Map<string, RunItem[]>()
      for (const item of this.items) {
        const key = normalizedNumber(item.group.number)
        if (!key) continue
        const unit = units.get(key) ?? []; unit.push(item); units.set(key, unit)
      }
      for (const unit of units.values()) {
        this.check(); await this.runUnit(root, unit, options)
        await this.journal.save(this.phase, this.status, this.counts)
      }
      this.check(); this.phase = 'completed'; this.current = ''
      this.status = found.length ? `刮削完成：成功 ${this.counts.done}，跳过 ${this.counts.skipped}，失败 ${this.counts.failed}。` : '目录中没有支持的视频。'
    } catch (error) {
      const failed = !this.controller.signal.aborted, message = failed ? reason(error) : this.status
      try { await this.stop() } catch { /* 未确认停止时保留停止状态和再次停止入口。 */ }
      if (!this.awaitingStop) {
        this.phase = failed ? 'failed' : 'stopped'
        this.status = failed ? `刮削已停止：${message}` : '已停止刮削，已完成的结果保留。'
      }
    } finally {
      this.clearHeartbeat()
      for (const item of this.items) if (['waiting', 'checking', 'ready', 'running'].includes(item.state)) item.state = 'stopped'
      try { await this.journal?.save(this.phase, this.status, this.counts) }
      catch (error) { this.status = `${this.status} ${reason(error)}`; if (this.phase === 'completed') this.phase = 'failed' }
      this.active = false; this.update(); this.finish?.(); this.finish = undefined
    }
  }
  private async runUnit(root: FileEntry, unit: RunItem[], options: RunOptions) {
    let pending = unit
    while (pending.length) {
      await this.create(root)
      this.phase = 'checking'
      let rebuild = false
      for (const item of pending) {
        this.check(); this.current = item.group.files.map(file => file.name).join('、')
        item.state = 'checking'; item.reason = ''; item.plan = undefined; item.candidate = undefined; item.result = undefined
        this.status = `正在检查 ${item.group.number} 的已有资料…`; this.update()
        try { await this.prepare(item, options) }
        catch (error) {
          this.check(); item.state = 'failed'; item.reason = reason(error)
          if (fatal(error)) { await this.saveItem(item); throw error }
          rebuild = true
        }
        await this.saveItem(item)
      }
      const ready = pending.filter(item => item.state === 'ready'), conflicts = new Set<RunItem>()
      for (const item of ready) {
        const related = ready.filter(other => other.plan?.target_path === item.plan?.target_path)
        const bases = new Set(related.flatMap(other => other.group.files.map(file => foldName(stem(file.name)))))
        const names = [item.plan?.nfo, item.plan?.poster].filter(artifact => artifact && artifact.action !== 'keep').map(artifact => artifact!.name)
        names.push(...(item.plan?.moving ?? []).map(file => file.name))
        if (bases.size > 1 && names.some(name => sharedCompanion(name, bases))) for (const other of related) conflicts.add(other)
      }
      for (const item of conflicts) {
        item.state = 'skipped'; item.reason = '配套资料同时关联多个视频，无法确定归属'; rebuild = true; await this.saveItem(item)
      }
      pending = ready.filter(item => item.state === 'ready')
      if (!pending.length) { await this.stopCurrentBatch(); return }
      if (rebuild) { await this.stopCurrentBatch(); continue }
      await this.execute(pending)
      pending = pending.filter(item => item.state === 'ready' || item.state === 'running')
    }
  }
  private async prepare(item: RunItem, options: RunOptions) {
    const { group } = item, signal = this.controller.signal
    const request = (candidate?: ScraperCandidate) => this.scrape.preview({ batch: this.batch!, files: group.files.map(reference), number: group.number, candidate: candidate ?? null, shared_ids: [], ...options }, { signal })
    item.plan = await request(); this.check()
    if (item.plan.needs_candidate) {
      const key = normalizedNumber(group.number), chosen = this.sourcePins.get(key) ?? this.sourceChoices.get(key)
      let candidates = chosen ? [chosen] : undefined
      if (!candidates) {
        this.status = `正在查询 ${group.number} 的影视资料…`; this.update()
        let source = this.sources.get(key)
        if (!source) {
          source = (async () => {
            try { return await this.scrape.search(group.number, { signal }) }
            catch (error) {
              this.check(); if (fatal(error) || !transient(error)) throw error
              await this.journal!.source(this.indexes.get(item)!, '搜索', reason(error))
              this.status = `${group.number} 查询暂时失败，正在重试…`; this.update()
              await retryDelay(signal); this.check()
              return this.scrape.search(group.number, { signal })
            }
          })()
          this.sources.set(key, source)
        }
        try { candidates = exactCandidates(await source, group.number) }
        catch (error) {
          this.sources.delete(key); if (fatal(error)) throw error
          throw new Error(`查询 ${group.number} 失败：${reason(error)}`, { cause: error })
        }
        this.check()
      }
      if (!candidates.length) { item.state = 'skipped'; item.reason = `未找到 ${group.number} 的匹配资料`; return }
      const errors: string[] = [], retry: ScraperCandidate[] = []
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt) {
          if (!retry.length) break
          this.status = `${group.number} 的资料源暂时失败，正在重试…`; this.update()
          await retryDelay(signal)
        }
        for (const candidate of attempt ? retry : candidates) {
          this.check(); this.status = `正在${attempt ? '重试' : '读取'} ${group.number} 的资料（${candidate.provider}）…`; this.update()
          let failure: string, retryable = false
          try {
            const plan = await request(candidate); this.check()
            if (plan.ready) {
              item.candidate = candidate; item.plan = plan; this.sourceChoices.set(key, candidate)
              item.state = 'ready'; item.reason = ''; return
            }
            failure = reason(plan.error ?? '未返回可用资料'); retryable = transient(plan.error)
          } catch (error) {
            this.check(); if (fatal(error)) throw error
            failure = reason(error); retryable = transient(error)
          }
          if (!attempt && retryable) retry.push(candidate)
          const detail = `${attempt ? '重试后仍失败：' : ''}${failure}`
          errors.push(`${candidate.provider}：${detail}`); item.reason = sourceReasons(errors)
          await this.journal!.source(this.indexes.get(item)!, candidate.provider, detail)
          this.update()
        }
      }
      throw new Error(`${group.number} 的匹配来源暂不可用（${sourceReasons(errors)}）`)
    }
    item.state = item.plan.ready ? 'ready' : 'skipped'
    item.reason = item.plan.ready ? '' : resultReason(item.plan.error ?? '无法确定该视频的资料或文件归属')
  }
  private clearHeartbeat() { clearInterval(this.heartbeat); this.heartbeat = undefined; this.generation++ }
  private async execute(items: RunItem[]) {
    const batch = this.batch!, generation = ++this.generation
    this.check(); this.mutation = this.scrape.begin(batch)
    try { await this.mutation } finally { this.mutation = undefined }
    this.check(); this.phase = 'running'; this.status = '正在整理视频并写入 NFO、海报…'; this.update()
    let heartbeatPending = false
    this.heartbeat = setInterval(() => {
      if (heartbeatPending) return
      heartbeatPending = true
      void this.scrape.heartbeat(batch).catch(error => {
        if (this.generation !== generation || this.batch?.id !== batch.id) return
        this.status = reason(error); void this.stop().catch(() => {})
      }).finally(() => { heartbeatPending = false })
    }, 5000)
    const byId = new Map(items.map(item => [item.plan!.id, item]))
    try {
      for (;;) {
        this.check()
        const next = items.find(item => item.state === 'ready' || item.state === 'running')
        if (next) { next.state = 'running'; this.current = next.group.files.map(file => file.name).join('、'); this.update() }
        const result = await this.scrape.next(batch, { signal: this.executionController.signal })
        this.check()
        // 宿主在暂停/完成时已结束租约，保存日志期间不能再向该批发送心跳。
        if (result.done || result.paused || result.status === 'needs_verification') this.clearHeartbeat()
        const item = result.item_id ? byId.get(result.item_id) : undefined
        if (item) {
          item.result = result.result; item.reason = resultReason(result.result?.reason ?? '')
          if (item.candidate && [result.result?.organize.state, result.result?.nfo.state, result.result?.poster.state].includes('done')) {
            // 同号已有步骤提交后，后续分段即使重建批次也不能悄悄混用另一来源。
            this.sourcePins.set(normalizedNumber(item.group.number), item.candidate)
          }
          if (result.status === 'done') item.state = 'done'
          else if (result.status === 'needs_user') item.state = 'skipped'
          else if (result.paused || result.status === 'needs_verification') item.state = 'failed'
          // 中间步骤已由宿主持久保存；这里只追加终态，减少大目录日志与往返次数。
          if (['done', 'skipped', 'failed'].includes(item.state)) await this.saveItem(item)
        }
        this.update()
        if (result.done) { this.batch = undefined; return }
        if (result.paused || result.status === 'needs_verification') {
          if (!item || result.status === 'needs_verification' || [result.result?.nfo.state, result.result?.poster.state].includes('uploading')) {
            throw new Error(item?.reason || '写入结果尚未确认，请在记录中核实后重试')
          }
          // 宿主已返回确定的单项失败；先确认收尾，再处理其余影片。
          await this.stopCurrentBatch(); this.check(); return
        }
      }
    } finally { if (this.generation === generation) this.clearHeartbeat() }
  }
  private stopCurrentBatch(): Promise<void> {
    if (this.batchStop) return this.batchStop
    this.clearHeartbeat()
    const stopping = (async () => {
      await this.mutation?.catch(() => {})
      const batch = this.batch
      if (batch) {
        let result = await this.scrape.stop(batch)
        for (let attempt = 0; !result.stopped && attempt < 10; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 250)); result = await this.scrape.stop(batch)
        }
        if (!result.stopped) throw new Error('在途操作尚未确认停止，请稍后查看记录或再次停止')
        if (this.batch?.id === batch.id) this.batch = undefined
      }
      this.executionController.abort()
    })()
    this.batchStop = stopping
    void stopping.finally(() => { if (this.batchStop === stopping) this.batchStop = undefined }).catch(() => {})
    return stopping
  }
  stop(): Promise<void> {
    if (!this.busy && !this.batch) return Promise.resolve()
    if (this.stopPromise) return this.stopPromise
    this.controller.abort(); this.clearHeartbeat()
    this.phase = 'stopping'; this.status = '正在停止刮削…'; this.update()
    this.stopPromise = (async () => {
      try {
        // create / begin 不可取消；等返回后再停止，写入请求也只在宿主回执后取消。
        await this.stopCurrentBatch()
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

/** 宿主列表会恢复已过期租约；单条 record/verify 不触发恢复，必须先读取列表。 */
export async function* currentRecords(drive: Drive, ids: string[], signal: AbortSignal) {
  if (!ids.length) return
  await drive.scraper!.records({ limit: 1 }, { signal })
  for (const id of new Set(ids)) { signal.throwIfAborted(); yield await readRecord(drive, id, signal) }
}
