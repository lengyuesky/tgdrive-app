import { icon } from '@tgdrive/ui'
import { active, retryable, roleName, stateName, verificationNote } from './model'
import type { Item, Run, Settings } from './model'
import type { RecordCursor } from './pagination'
import type { ScraperPage } from './controller'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const text = (element: HTMLElement, value: string) => { if (element.textContent !== value) element.textContent = value }
const show = (id: string, visible: boolean) => { $(id).hidden = !visible }
const input = (id: string) => $<HTMLInputElement>(id)
const button = (id: string) => $<HTMLButtonElement>(id)
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, body = '', className = '') => { const element = document.createElement(tag); element.textContent = body; element.className = className; return element }
const date = (value: number) => new Date(value).toLocaleString('zh-CN')
interface ResultRow { row: HTMLElement; names: HTMLElement; path: HTMLElement; state: HTMLElement; steps: HTMLElement; reason: HTMLElement; actors: HTMLElement }
interface HistoryRow { row: HTMLElement; status: HTMLElement; counts: HTMLElement; path: HTMLElement; time: HTMLElement }

export class ScraperView {
  private readonly events = new AbortController()
  private readonly resultRows = new Map<string, ResultRow>()
  private readonly historyRows = new Map<string, HistoryRow>()
  private draftRevision: string | null = null
  private dirty = false
  private conflict = false
  private detailStamp = ''

  constructor(private readonly page: ScraperPage, private readonly exit: () => Promise<void>) {
    const back = document.createElement('span'); back.innerHTML = icon('back'); button('exit').prepend(back)
    const on = (id: string, action: (event: Event) => unknown, event = 'click') => $(id).addEventListener(event, value => {
      try { void Promise.resolve(action(value)).catch(error => page.fail(error)) } catch (error) { page.fail(error) }
    }, { signal: this.events.signal })
    on('exit', () => this.exit())
    on('choose', () => page.choose()); on('authorize', () => page.authorize())
    on('start', () => page.start()); on('cancel', () => page.stop())
    on('retry-run', () => page.start(page.run)); on('refresh-status', () => page.refresh(true))
    on('show-active', () => page.activeRun ? page.openRun(page.activeRun) : undefined)
    on('reload-history', () => page.loadHistory('reset'))
    on('history-prev', () => page.loadHistory('previous')); on('history-next', () => page.loadHistory('next'))
    on('results-prev', () => page.loadItems('previous')); on('results-next', () => page.loadItems('next'))
    on('close-detail', () => page.closeDetail())
    for (const part of ['step', 'actor', 'attempt'] as const) {
      on(`${part}-prev`, () => page.detail ? page.loadDetail(page.detail.item.id, 'previous', part) : undefined)
      on(`${part}-next`, () => page.detail ? page.loadDetail(page.detail.item.id, 'next', part) : undefined)
    }
    on('save-settings', () => this.save())
    on('reload-settings', async () => { await page.reloadSettings(); this.dirty = false; this.conflict = false; this.draftRevision = null; this.clearToken(); this.render() })
    on('dismiss-message', () => page.clearMessage())
    on('connection-form', event => { if ((event as KeyboardEvent).key === 'Enter') { event.preventDefault(); return this.save() } }, 'keydown')
    for (const id of ['backend-url', 'backend-token', 'clear-token', 'overwrite-nfo', 'overwrite-poster']) on(id, () => { this.dirty = true; if (id === 'clear-token' && input(id).checked) input('backend-token').value = ''; this.render() }, id === 'backend-url' || id === 'backend-token' ? 'input' : 'change')
    document.querySelectorAll<HTMLElement>('[data-tab]').forEach(tab => tab.addEventListener('click', () => {
      void page.setTab(tab.dataset.tab as typeof page.tab).catch(error => page.fail(error))
    }, { signal: this.events.signal }))
  }
  private clearToken(): void { input('backend-token').value = ''; input('clear-token').checked = false }
  private async save(): Promise<void> {
    if (button('save-settings').disabled || !input('backend-url').reportValidity()) return
    try {
      const settings = await this.page.save({ backend_url: input('backend-url').value.trim(), overwrite_nfo: input('overwrite-nfo').checked, overwrite_poster: input('overwrite-poster').checked }, input('clear-token').checked ? '' : input('backend-token').value || null, this.draftRevision ?? undefined)
      if (settings) { this.dirty = false; this.conflict = false; this.draftRevision = null }
    } finally { this.clearToken(); this.render() }
  }
  private settings(settings: Settings | null): void {
    if (!settings) return
    if (this.draftRevision !== settings.revision && !this.dirty) {
      input('backend-url').value = settings.backend_url
      input('overwrite-nfo').checked = settings.overwrite_nfo; input('overwrite-poster').checked = settings.overwrite_poster
      this.draftRevision = settings.revision; this.conflict = false
    } else if (this.draftRevision !== settings.revision) this.conflict = true
    text($('token-status'), settings.token_configured ? '已配置 Token。' : '未配置 Token，使用后端的匿名访问。')
    const busy = this.page.busy
    for (const id of ['backend-url', 'clear-token', 'overwrite-nfo', 'overwrite-poster']) input(id).disabled = busy
    input('backend-token').disabled = busy || input('clear-token').checked
    button('save-settings').disabled = busy || this.page.settingsStale || this.conflict
    button('reload-settings').disabled = this.page.saving
    text($('settings-status'), this.page.settingsStale || this.conflict ? '设置已被其他页面修改，草稿未覆盖对方设置。请点击「重新读取设置」，再确认要改的内容。' : active(this.page.activeRun) ? '任务结束后才能修改设置。' : this.page.saving ? '正在保存设置…' : '')
  }
  private pager(prefix: string, cursor: RecordCursor<unknown>, loading: boolean): void {
    button(`${prefix}-prev`).disabled = loading || !cursor.hasPrevious
    button(`${prefix}-next`).disabled = loading || cursor.next === null
    text($(`${prefix}-page`), `第 ${cursor.page} 页`)
  }
  private results(items: Item[]): void {
    const ids = new Set(items.map(item => item.id))
    for (const [id, entry] of this.resultRows) if (!ids.has(id)) { entry.row.remove(); this.resultRows.delete(id) }
    for (const [at, item] of items.entries()) {
      let entry = this.resultRows.get(item.id)
      if (!entry) {
        const row = node('article', '', 'result-row'), copy = node('div'), actions = node('div', '', 'result-actions')
        const names = node('p', '', 'file-name'), path = node('p', '', 'file-path'), steps = node('div', '', 'steps'), reason = node('p', '', 'result-reason'), actors = node('p', '', 'result-reason'), state = node('span', '', 'result-state'), open = node('button', '执行明细')
        open.type = 'button'; open.onclick = () => { void this.page.openDetail(item.id).catch(error => this.page.fail(error)) }
        copy.append(names, path, steps, reason, actors); actions.append(state, open); row.append(copy, actions)
        entry = { row, names, path, state, steps, reason, actors }; this.resultRows.set(item.id, entry)
      }
      text(entry.names, item.files.map(file => file.name).join('、')); text(entry.path, item.files[0]?.path ?? '')
      text(entry.state, stateName(item.state)); entry.row.dataset.state = item.state
      text(entry.steps, item.steps.map(step => `${roleName(step.role)}：${stateName(step.state)}`).join(' · '))
      text(entry.reason, item.reason); text(entry.actors, item.actors_summary === item.reason ? '' : item.actors_summary)
      // 按当前分页顺序移动已有行，不重建按钮；进度更新不抢走键盘焦点。
      const existing = $('results').children.item(at)
      if (existing !== entry.row) $('results').insertBefore(entry.row, existing)
    }
  }
  private history(records: Run[]): void {
    const ids = new Set(records.map(run => run.id))
    for (const [id, entry] of this.historyRows) if (!ids.has(id)) { entry.row.remove(); this.historyRows.delete(id) }
    for (const [at, run] of records.entries()) {
      let entry = this.historyRows.get(run.id)
      if (!entry) {
        const row = node('article', '', 'history-card'), copy = node('div'), status = node('p', '', 'file-name'), counts = node('p', '', 'hint'), path = node('p', '', 'file-path'), time = node('time'), open = node('button', '查看结果')
        open.type = 'button'; open.onclick = () => {
          const current = this.page.history.find(record => record.id === run.id)
          if (current) void this.page.openRun(current).catch(error => this.page.fail(error))
        }
        copy.append(status, counts, path, time); row.append(copy, open)
        entry = { row, status, counts, path, time }; this.historyRows.set(run.id, entry)
      }
      text(entry.status, `${stateName(run.state)} · 成功 ${run.counts.done} / ${run.counts.total} 个视频`)
      text(entry.counts, `跳过 ${run.counts.skipped} · 失败 ${run.counts.failed}`); text(entry.path, run.root.path); text(entry.time, date(run.created_at))
      const existing = $('history').children.item(at)
      if (existing !== entry.row) $('history').insertBefore(entry.row, existing)
    }
  }
  private details(): void {
    const detail = this.page.detail
    show('detail-panel', !!detail || this.page.detailLoading)
    text($('detail-status'), this.page.detailLoading ? '正在读取明细…' : detail ? `${stateName(detail.item.state)}${detail.item.reason ? ` · ${detail.item.reason}` : ''}` : '')
    if (!detail) { this.detailStamp = ''; for (const id of ['detail-steps', 'detail-actors', 'detail-attempts']) $(id).replaceChildren(); return }
    text($('detail-title'), detail.item.files.map(file => file.name).join('、'))
    const stamp = JSON.stringify(detail)
    if (stamp !== this.detailStamp) {
      this.detailStamp = stamp
      $('detail-steps').replaceChildren(...detail.steps.map(step => {
        const row = node('article', '', 'detail-row')
        row.append(node('p', `${roleName(step.role)}：${stateName(step.state)}`, 'file-name'), node('p', step.file?.path ?? step.name, 'file-path'))
        if (step.message) row.append(node('p', step.message, 'result-reason'))
        return row
      }))
      $('detail-actors').replaceChildren(...detail.actors.map(actor => {
        const row = node('article', '', 'detail-row')
        row.append(node('p', `${actor.data.name} · ${stateName(actor.state)}`, 'file-name'))
        if (actor.data.role) row.append(node('p', `角色：${actor.data.role}`, 'hint'))
        if (actor.data.thumb) row.append(node('p', `已提交头像：${actor.data.thumb}`, 'file-path'))
        if (actor.message) row.append(node('p', actor.message, 'result-reason'))
        if (actor.data.biography) row.append(node('p', actor.data.biography, 'biography'))
        return row
      }))
      $('detail-attempts').replaceChildren(...detail.attempts.map(attempt => {
        const row = node('article', '', 'detail-row')
        row.append(node('p', `${roleName(attempt.stage)} · ${attempt.provider}`, 'file-name'), node('p', attempt.reason, 'result-reason'))
        return row
      }))
      for (const [id, empty] of [['detail-steps', '本页没有文件步骤。'], ['detail-actors', '本页没有演员资料。'], ['detail-attempts', '本页没有来源错误。']]) if (!$(id).children.length) $(id).append(node('p', empty, 'hint'))
    }
    for (const part of ['step', 'actor', 'attempt'] as const) this.pager(part, this.page.detailCursor[part], this.page.detailLoading)
  }
  render(): void {
    const page = this.page
    if (page.closed) return
    show('app', page.ready); show('boot', !page.ready)
    for (const tab of ['scrape', 'history', 'connection'] as const) show(`${tab}-view`, tab === page.tab)
    document.querySelectorAll<HTMLElement>('[data-tab]').forEach(tab => { tab.classList.toggle('active', tab.dataset.tab === page.tab); tab.setAttribute('aria-current', tab.dataset.tab === page.tab ? 'page' : 'false') })
    text($('directory'), page.directory?.path ?? '请选择目录')
    text($('scope-status'), page.access === 'read_write' ? '所选目录已获得读写授权。' : page.access === 'read_only' ? '所选目录仅有读取授权，开始前需确认读写范围。' : '选择目录不会授予权限，开始前需确认目录读写范围。')
    for (const id of ['choose', 'authorize']) button(id).disabled = page.busy || !page.ready
    button('start').disabled = page.busy || !page.ready || !page.directory
    show('cancel', page.preparing || page.starting || active(page.activeRun)); button('cancel').disabled = page.stopping
    text(button('cancel'), page.preparing ? '取消准备' : page.starting ? '停止待启动任务' : page.stopping ? '正在请求停止…' : '停止刮削')
    button('refresh-status').disabled = page.starting || page.stopping
    show('show-active', !!page.activeRun && page.activeRun.id !== page.run?.id)
    show('progress-panel', !!page.run); show('results-panel', !!page.run)
    const run = page.run
    if (run) {
      text($('execution-status'), stateName(run.state)); text($('run-time'), date(run.created_at)); text($('run-directory'), run.root.path)
      text($('current-file'), run.message || (run.state === 'scanning' ? '正在扫描目录及子目录…' : ''))
      const progress = $<HTMLProgressElement>('progress')
      if (!run.scan_complete) progress.removeAttribute('value')
      else { progress.max = Math.max(1, run.counts.total); progress.value = run.counts.processed }
      const label = !run.scan_complete ? `已发现 ${run.counts.total} 个视频，正在核对目录` : `已处理 ${run.counts.processed} / ${run.counts.total} 个视频`
      text($('progress-label'), label); progress.title = label
      for (const [id, count] of [['total-count', run.counts.total], ['done-count', run.counts.done], ['skipped-count', run.counts.skipped], ['failed-count', run.counts.failed]] as const) text($(id), String(count))
      const uncertain = run.state === 'interrupted' || page.items.some(item => item.state === 'needs_verification' || item.steps.some(step => ['unknown', 'committing', 'uploading', 'creating'].includes(step.state)))
      show('verification-note', uncertain); text($('verification-note'), verificationNote)
      show('retry-run', retryable(run)); button('retry-run').disabled = !page.canRetry
      text($('results-empty'), page.items.length ? '' : !run.scan_complete ? active(run) ? '完整扫描结束后逐部展示结果。' : '扫描尚未完成，任务不会自动续跑；重试会重新核对目录。' : run.counts.total === 0 ? '目录中没有支持的视频。' : '本页暂无结果，可刷新状态。')
    }
    text($('results-loading'), page.itemsLoading ? '正在读取结果…' : '')
    this.results(page.items); this.pager('results', page.itemCursor, page.itemsLoading)
    this.history(page.history); this.pager('history', page.historyCursor, page.historyLoading)
    text($('history-status'), page.historyLoading ? '正在读取操作记录…' : page.history.length ? '' : '暂无刮削记录。')
    button('reload-history').disabled = page.historyLoading
    this.settings(page.settings); this.details()
    text($('observation-error'), page.observationError); show('observation-error', !!page.observationError)
    text($('message-text'), page.message); show('message', !!page.message)
  }
  dispose(): void { this.events.abort(); this.clearToken() }
}
