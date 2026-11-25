import { parseJson } from '@tgdrive/page-sdk'
import type { FileNode } from '@tgdrive/page-sdk'
import type { FakeBackend } from '@tgdrive/test-host'
import type { Actor, Detail, HistoryCursor, Item, Run, Settings, Status } from './model'

export type BackendRequest = Parameters<FakeBackend>[0]
export const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
export const failure = (code = 'storage_conflict', message = '设置被其他页面修改', status = 409) => json({ error: { code, message, request_id: 'test' } }, status)
export const body = (request: BackendRequest): Record<string, unknown> => request.options.body ? parseJson(String(request.options.body)) as Record<string, unknown> : {}
export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
export function actor(index: number): Actor { return { data: { name: `演员${index}`, role: '', order: index, thumb: '', biography: `人物简介${index}`, provider: '', id: '' }, state: 'unmatched', message: '没有唯一精确同名资料', image_step: null } }

/** 单测和真实沙箱渲染共用页面协议假服务；不模拟扫描、MetaTube 或文件写入。 */
export class FakeScraper {
  root!: FileNode
  video!: FileNode
  settings!: Settings
  readonly runs = new Map<string, Run>()
  readonly items = new Map<string, Item[]>()
  readonly details = new Map<string, Detail>()
  readonly requests: BackendRequest[] = []
  activeId: string | null = null
  latestId: string | null = null
  pageSize = 30
  token: string | null = null
  sequence = 0
  override: ((request: BackendRequest, next: () => Response) => Response | Promise<Response>) | null = null
  makeRun(state = 'running', id = (++this.sequence).toString().padStart(32, '0'), values: Partial<Run> = {}): Run {
    return { id, root: this.root, scope_revision: 'scope-1', state, message: `正在处理 ABC-123 · ${this.video.name}`, created_at: 1700000000000 + this.sequence, updated_at: 1700000000000 + this.sequence, scan_complete: true, counts: { total: 1, processed: 0, done: 0, skipped: 0, failed: 0 }, retry_of: null, ...values }
  }
  makeItem(run: Run, position = 0, state = 'processing', values: Partial<Item> = {}): Item {
    return { id: `${run.id}-${position}`, run_id: run.id, position, files: [this.video], number: 'ABC-123', state, reason: '', target_id: null, actors_summary: '', variant: '', steps: [], ...values }
  }
  add(run: Run, items: Item[] = [this.makeItem(run)]): Run {
    this.runs.set(run.id, run); this.items.set(run.id, items); this.latestId = run.id; this.activeId = ['scanning', 'running', 'stopping'].includes(run.state) ? run.id : null
    return run
  }
  status(): Status { return { settings: this.settings, active: this.activeId ? this.runs.get(this.activeId)! : null, latest: this.latestId ? this.runs.get(this.latestId)! : null } }
  handle = (request: BackendRequest): Response | Promise<Response> => {
    this.requests.push(request)
    const next = () => this.response(request)
    return this.override ? this.override(request, next) : next()
  }
  private response(request: BackendRequest): Response {
    const input = body(request)
    if (request.path === '/owner/status') return json(this.status())
    if (request.path === '/owner/settings') {
      if (this.activeId) return failure('invalid_operation', '任务运行时不能修改设置', 400)
      if (input.revision !== this.settings.revision) return failure()
      if (input.token !== null) this.token = String(input.token) || null
      this.settings = { ...this.settings, revision: `settings-${++this.sequence}`, backend_url: String(input.backend_url), overwrite_nfo: Boolean(input.overwrite_nfo), overwrite_poster: Boolean(input.overwrite_poster), token_configured: this.token !== null }
      return json(this.settings)
    }
    if (request.path === '/owner/runs') {
      if (this.activeId) return failure('invalid_operation', '同一时间只能运行一个任务', 400)
      const run = this.add(this.makeRun('scanning', undefined, { scan_complete: false, message: '', retry_of: input.retry_of as string | null }))
      this.settings = { ...this.settings, directory: run.root }
      return json(run, 202)
    }
    if (request.path === '/owner/stop') {
      const run = this.runs.get(String(input.run_id))
      if (!run) return failure('not_found', '任务不存在', 404)
      if (['scanning', 'running', 'stopping'].includes(run.state)) this.runs.set(run.id, { ...run, state: 'stopping', message: '正在停止，等待在途写入收尾或核实' })
      return json(this.runs.get(run.id))
    }
    if (request.path === '/owner/history') {
      const cursor = input.cursor as HistoryCursor | null, limit = Math.min(Number(input.limit), this.pageSize)
      const rows = [...this.runs.values()].sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id)).filter(run => !cursor || run.created_at < cursor.created_at || run.created_at === cursor.created_at && run.id < cursor.id)
      const records = rows.slice(0, limit), last = records.at(-1)
      return json({ records, next_cursor: records.length < rows.length && last ? { created_at: last.created_at, id: last.id } : null })
    }
    if (request.path === '/owner/items') {
      const id = String(input.run_id), after = Number(input.after ?? -1), limit = Math.min(Number(input.limit), this.pageSize)
      const rows = (this.items.get(id) ?? []).filter(item => item.position > after), items = rows.slice(0, limit)
      return json({ run: this.runs.get(id), items, next_after: items.length < rows.length ? items.at(-1)?.position ?? null : null })
    }
    if (request.path === '/owner/detail') {
      const id = String(input.item_id), existing = this.details.get(id)
      const item = [...this.items.values()].flat().find(item => item.id === id)
      if (!item) return failure('not_found', '项目不存在', 404)
      const limit = Math.min(Number(input.limit), this.pageSize), step = Number(input.after ?? 0), actor = Number(input.actor_after ?? 0), attempt = Number(input.attempt_after ?? 0)
      const steps = existing?.steps ?? [], actors = existing?.actors ?? [], attempts = existing?.attempts ?? []
      return json({ item, steps: steps.slice(step, step + limit), next_step: step + limit < steps.length ? step + limit : null, actors: actors.slice(actor, actor + limit), next_actor: actor + limit < actors.length ? actor + limit : null, attempts: attempts.slice(attempt, attempt + limit), next_attempt: attempt + limit < attempts.length ? attempt + limit : null })
    }
    return failure('not_found', '应用接口不存在', 404)
  }
}
