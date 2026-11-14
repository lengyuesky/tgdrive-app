import type { Drive, FileEntry, Page, RecordValue, ScraperRecord, ScraperResult, ScraperSnapshot } from '../sdk/types'
import type { ItemState, RunItem, RunPhase } from './runner'

const RUN_PREFIX = 'scrape_run:', LOG_PREFIX = 'scrape_log:', PAGE_BYTES = 24 * 1024
const encoder = new TextEncoder()
const terminal = new Set<ItemState>(['done', 'skipped', 'failed'])
export interface RunCounts { total: number; done: number; skipped: number; failed: number; processed: number }
export interface RunSummary {
  kind: 'directory-scrape'; schema: 1; id: string; root_id: number; root_path: string
  created_at: number; updated_at: number; phase: RunPhase; message: string; counts: RunCounts
}
export interface SavedItem {
  index: number; number: string; files: ScraperSnapshot[]; state: ItemState; reason: string
  batch_id?: string; item_id?: string; result?: ScraperResult
  attempts: { provider: string; reason: string }[]
}
export interface DirectoryRecord extends RunSummary { items: SavedItem[]; recordIds: string[]; read_only: boolean; warning?: string }
type Event =
  | { type: 'file'; index: number; number: string; file: ScraperSnapshot }
  | { type: 'discovered'; groups: number; files: number }
  | { type: 'batch'; id: string }
  | { type: 'item'; index: number; state: ItemState; reason: string; batch_id?: string; item_id?: string; result?: ScraperResult }
  | { type: 'source'; index: number; provider: string; reason: string }
interface LogPage { kind: 'scrape-log'; schema: 1; run: string; page: number; events: Event[] }
interface Stamp { write_id: string }
export class JournalError extends Error {}

/** 每次写入使用固定写入标识和原 revision；响应丢失时先读回，绝不覆盖别人的 revision。 */
async function confirmedWrite<T extends object>(drive: Drive, key: string, value: T, previous: RecordValue<unknown> | null): Promise<RecordValue<T & Stamp>> {
  const stamped = { ...value, write_id: crypto.randomUUID() }, revision = previous?.revision ?? null
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await drive.storage.set(key, stamped, revision) }
    catch (error) {
      let saved: RecordValue<T & Stamp> | null
      try { saved = await drive.storage.get<T & Stamp>(key) }
      catch { throw new JournalError('刮削记录保存结果尚未确认，已停止后续操作。请检查连接后查看操作记录。') }
      if (saved?.value.write_id === stamped.write_id) return saved
      if ((saved?.revision ?? null) !== revision) throw new JournalError('刮削记录已被其他页面修改，已停止后续操作。')
      if (attempt === 2) throw new JournalError(`无法保存刮削记录：${error instanceof Error ? error.message : String(error)}`)
      await new Promise(resolve => setTimeout(resolve, 150 * 2 ** attempt))
    }
  }
  throw new JournalError('无法确认刮削记录')
}

async function listAll<T>(drive: Drive, prefix: string, signal?: AbortSignal): Promise<RecordValue<T>[]> {
  const records: RecordValue<T>[] = [], seen = new Set<string>()
  let cursor: string | null = null
  do {
    const page: Page & { records: RecordValue<T>[] } = await drive.storage.list<T>({ prefix, cursor, limit: 200 }, { signal })
    records.push(...page.records)
    cursor = page.has_more ? page.next_cursor : null
    if (page.has_more && (!cursor || seen.has(cursor))) throw new JournalError('操作记录分页已变化，请刷新记录')
    if (cursor) seen.add(cursor)
  } while (cursor)
  return records
}

/** 与宿主记录保持相同的 30 天期限，只在开始新任务时清理过期记录。 */
async function prune(drive: Drive) {
  const cutoff = Date.now() / 1000 - 30 * 86400
  const headers = await listAll<RunSummary>(drive, RUN_PREFIX)
  for (const header of headers) {
    if (header.value.kind !== 'directory-scrape' || header.value.updated_at >= cutoff) continue
    const pages = await listAll<LogPage>(drive, `${LOG_PREFIX}${header.value.id}:`)
    for (const page of pages) await drive.storage.delete(page.key, page.revision)
    await drive.storage.delete(header.key, header.revision)
  }
}

/** 分页追加诊断与结果，不保存可续跑的 owner；重新打开只读记录。 */
export class RunJournal {
  private header: RecordValue<RunSummary & Stamp> | null = null
  private tail: RecordValue<LogPage & Stamp> | null = null
  private sequence = 0
  private queue: Promise<unknown> = Promise.resolve()
  private broken = false
  private constructor(private drive: Drive, readonly summary: RunSummary) {}
  static async create(drive: Drive, root: FileEntry) {
    await prune(drive)
    const now = Date.now() / 1000
    const journal = new RunJournal(drive, {
      kind: 'directory-scrape', schema: 1, id: crypto.randomUUID(), root_id: root.id, root_path: root.path,
      created_at: now, updated_at: now, phase: 'scanning', message: '正在扫描目录及子目录…',
      counts: { total: 0, done: 0, skipped: 0, failed: 0, processed: 0 },
    })
    await journal.save('scanning', journal.summary.message, journal.summary.counts)
    return journal
  }
  private serial(action: () => Promise<void>): Promise<void> {
    const pending = this.queue.then(async () => {
      if (this.broken) throw new JournalError('刮削记录保存尚未确认，已停止后续操作。')
      try { await action() } catch (error) { this.broken = true; throw error }
    })
    this.queue = pending.catch(() => {})
    return pending
  }
  private append(events: Event[]) {
    return this.serial(async () => {
      let current = this.tail?.value.events.slice() ?? [], changed = false
      const value = () => ({ kind: 'scrape-log' as const, schema: 1 as const, run: this.summary.id, page: this.sequence, events: current })
      const flush = async () => {
        if (!changed) return
        this.tail = await confirmedWrite(this.drive, `${LOG_PREFIX}${this.summary.id}:${String(this.sequence).padStart(8, '0')}`, value(), this.tail)
        changed = false
      }
      for (const event of events) {
        if (encoder.encode(JSON.stringify(event)).length > PAGE_BYTES - 512) throw new JournalError('单项刮削记录过大，已停止后续操作。')
        if (encoder.encode(JSON.stringify({ ...value(), events: [...current, event] })).length > PAGE_BYTES) {
          await flush(); this.sequence++; this.tail = null; current = []
        }
        current.push(event); changed = true
      }
      await flush()
    })
  }
  async discovered(items: RunItem[]) {
    const events = items.flatMap((item, index): Event[] => [
      ...item.group.files.map(file => ({
        type: 'file' as const, index, number: item.group.number,
        file: { id: file.id, path: file.path, name: file.name, content_version: file.content_version },
      })),
      ...(item.state === 'waiting' ? [] : [{ type: 'item' as const, index, state: item.state, reason: item.reason }]),
    ])
    // 最后一页成功后才有完整标记；缺尾页不能当作一个更小的完整目录去重试。
    events.push({ type: 'discovered', groups: items.length, files: items.reduce((sum, item) => sum + item.group.files.length, 0) })
    await this.append(events)
  }
  batch(id: string) { return this.append([{ type: 'batch', id }]) }
  source(index: number, provider: string, reason: string) { return this.append([{ type: 'source', index, provider, reason }]) }
  item(index: number, item: RunItem, batch_id?: string) {
    const result = item.result && {
      organize: { state: item.result.organize.state }, nfo: { state: item.result.nfo.state },
      poster: { state: item.result.poster.state }, reason: item.result.reason,
    }
    return this.append([{ type: 'item', index, state: item.state, reason: item.reason, batch_id, item_id: item.plan?.id, result }])
  }
  save(phase: RunPhase, message: string, counts: RunCounts) {
    return this.serial(async () => {
      const value = { ...this.summary, phase, message, counts: { ...counts }, updated_at: Date.now() / 1000 }
      this.header = await confirmedWrite(this.drive, `${RUN_PREFIX}${this.summary.id}`, value, this.header)
      Object.assign(this.summary, value)
    })
  }
}

export async function listDirectoryRuns(drive: Drive, cursor?: string, signal?: AbortSignal) {
  const page = await drive.storage.list<RunSummary>({ prefix: RUN_PREFIX, cursor, limit: 30 }, { signal })
  return { ...page, records: page.records.filter(record => record.value.kind === 'directory-scrape' && record.value.schema === 1) }
}

export function directoryCounts(items: SavedItem[]): RunCounts {
  const count = (states: ItemState[]) => items.filter(item => states.includes(item.state)).reduce((sum, item) => sum + item.files.length, 0)
  return { total: items.reduce((sum, item) => sum + item.files.length, 0), done: count(['done']), skipped: count(['skipped']), failed: count(['failed']), processed: count(['done', 'skipped', 'failed']) }
}

export async function readDirectoryRun(drive: Drive, id: string, signal: AbortSignal): Promise<DirectoryRecord> {
  const header = await drive.storage.get<RunSummary>(`${RUN_PREFIX}${id}`, { signal })
  if (!header || header.value.kind !== 'directory-scrape' || header.value.schema !== 1) throw new Error('未找到这次目录刮削记录')
  const pages = await listAll<LogPage>(drive, `${LOG_PREFIX}${id}:`, signal)
  pages.sort((a, b) => a.value.page - b.value.page)
  const items = new Map<number, SavedItem>(), recordIds: string[] = []
  let discovered: { groups: number; files: number } | undefined
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index].value
    if (page.kind !== 'scrape-log' || page.run !== id || page.schema !== 1 || page.page !== index) throw new Error('刮削记录不完整，请查看旧版记录中的执行明细')
    for (const event of page.events) {
      if (event.type === 'batch') { if (!recordIds.includes(event.id)) recordIds.push(event.id); continue }
      if (event.type === 'discovered') { discovered = event; continue }
      let item = items.get(event.index)
      if (!item) { item = { index: event.index, number: '', files: [], state: 'waiting', reason: '', attempts: [] }; items.set(event.index, item) }
      if (event.type === 'file') { item.number = event.number; item.files.push(event.file) }
      else if (event.type === 'source') item.attempts.push({ provider: event.provider, reason: event.reason })
      else if (event.type === 'item') Object.assign(item, event)
    }
  }
  const found = [...items.values()].sort((a, b) => a.index - b.index)
  for (const item of found) {
    if (!terminal.has(item.state)) {
      item.state = 'stopped'
      item.reason ||= item.attempts.length ? item.attempts.map(attempt => `${attempt.provider}：${attempt.reason}`).join('；') : '尚未完成，重试时只处理未完成的视频'
    }
  }
  const counts = directoryCounts(found), complete = discovered?.groups === found.length && discovered.files === counts.total
  return { ...header.value, items: found, recordIds, counts, read_only: !complete, ...(!complete ? { warning: '目录清单尚未完整保存，请重新选择目录并开始刮削。当前记录仅供查看。' } : {}) }
}

/** 已发生的网盘步骤以宿主记录为准，页面日志缺少回执时也不能当作从未执行。 */
export function reconcileDirectoryRun(record: DirectoryRecord, host: ScraperRecord) {
  record.read_only ||= host.read_only
  for (const item of record.items) {
    if (item.batch_id !== host.id || !item.item_id) continue
    const actual = host.items.find(entry => entry.id === item.item_id)
    if (!actual) continue
    item.result = actual.result
    if (actual.status === 'done') { item.state = 'done'; item.reason = '' }
    else if (actual.status === 'needs_verification') { item.state = 'failed'; item.reason = actual.result.reason || '写入结果需要核实，重试时会先核实已有结果' }
    else if (!terminal.has(item.state) && actual.result.reason && actual.result.reason !== '请选择影视资料候选') item.reason = actual.result.reason
  }
  record.counts = directoryCounts(record.items)
}
