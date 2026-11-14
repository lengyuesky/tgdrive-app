import './style.css'
import type { FileEntry, ScraperHistory, ScraperRecord } from '../sdk/types'
import { resultReason, stateName } from './model'
import { DirectoryScrape, readRecord, type RunItem } from './runner'

const drive = window.tgdrive, scrape = drive.scraper!
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const text = (id: string, value: string) => { if ($(id).textContent !== value) $(id).textContent = value }
const show = (id: string, visible: boolean) => { $(id).hidden = !visible }
const input = (id: string) => $<HTMLInputElement>(id)
const button = (id: string) => $<HTMLButtonElement>(id)
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, body = '', className = '') => { const element = document.createElement(tag); element.textContent = body; element.className = className; return element }
const lifetime = new AbortController(), mobileQuery = window.matchMedia('(max-width:700px), (pointer:coarse)')
let runner: DirectoryScrape
let root: FileEntry | undefined, dark = false, configuring = false, preparing = false, savedUrl = ''
let setup = new AbortController(), currentRecord: ScraperRecord | undefined, historyCursor: string | undefined
let notice: ReturnType<typeof setTimeout>, visibleResults = 100, renderedItems: RunItem[] | undefined
const resultRows = new Map<string, { row: HTMLElement; state: HTMLElement; reason: HTMLElement }>()
function message(error: unknown) {
  if ((error as Error)?.name === 'AbortError' || lifetime.signal.aborted) return
  text('message', resultReason(error instanceof Error ? error.message : String(error))); show('message', true)
  clearTimeout(notice); notice = setTimeout(() => show('message', false), 6000)
}
function on(id: string, event: string, action: (event: Event) => unknown) {
  $(id).addEventListener(event, event => { try { void Promise.resolve(action(event)).catch(message) } catch (error) { message(error) } })
}
async function syncImmersion() {
  if (!lifetime.signal.aborted && drive.can('ui.setImmersive')) await drive.ui.setImmersive(mobileQuery.matches, drive.can('ui.immersiveBackground') ? { background: dark ? '#10131a' : '#f3f5f8' } : undefined)
}
function setTab(tab: string) {
  for (const name of ['scrape', 'history', 'connection']) show(`${name}-view`, name === tab)
  document.querySelectorAll<HTMLElement>('[data-tab]').forEach(item => {
    item.classList.toggle('active', item.dataset.tab === tab); item.setAttribute('aria-current', item.dataset.tab === tab ? 'page' : 'false')
  })
  if (tab === 'history') void loadHistory(true).catch(message)
}
function controls() {
  const busy = preparing || configuring || !!runner?.busy
  for (const id of ['choose', 'authorize', 'refresh-mode', 'update-nfo', 'update-poster', 'backend-url', 'backend-token', 'clear-token', 'save-connection', 'check-connection', 'continue-record', 'retry-run']) ($(id) as HTMLButtonElement | HTMLInputElement).disabled = busy
  button('start').disabled = busy || !root
  button('cancel').disabled = !preparing && !runner?.busy
  show('cancel', preparing || !!runner?.busy)
  if (currentRecord) button('continue-record').disabled = busy || currentRecord.read_only || ['running', 'stopping'].includes(currentRecord.status) || !currentRecord.items.some(item => item.status !== 'done')
}
const itemNames = { waiting: '等待处理', checking: '正在检查', ready: '等待刮削', running: '正在刮削', done: '已完成', skipped: '已跳过', failed: '失败', stopped: '未完成' }
function render() {
  if (!runner || lifetime.signal.aborted) return
  if (renderedItems !== runner.items) { renderedItems = runner.items; visibleResults = 100; resultRows.clear(); $('results').replaceChildren() }
  const counts = runner.counts
  show('progress-panel', runner.phase !== 'idle')
  text('execution-status', runner.status); text('current-file', runner.current)
  text('total-count', String(counts.total)); text('done-count', String(counts.done)); text('skipped-count', String(counts.skipped)); text('failed-count', String(counts.failed))
  text('progress-label', runner.phase === 'scanning' ? `已发现 ${counts.total} 个视频` : `已处理 ${counts.processed} / ${counts.total} 个视频`)
  const progress = $<HTMLProgressElement>('progress')
  if (runner.phase === 'scanning') progress.removeAttribute('value')
  else { progress.max = Math.max(1, counts.total); progress.value = counts.processed }
  for (const item of runner.items.slice(0, visibleResults)) {
    let saved = resultRows.get(item.group.key)
    if (!saved) {
      const row = node('article', '', 'result-row'), copy = node('div'), state = node('span', '', 'result-state'), reason = node('p', '', 'result-reason')
      copy.append(node('p', item.group.files.map(file => file.name).join('、'), 'file-name'), node('p', item.group.files[0].path, 'file-path'), reason)
      row.append(copy, state); $('results').append(row); saved = { row, state, reason }; resultRows.set(item.group.key, saved)
    }
    saved.row.dataset.state = item.state; saved.state.textContent = itemNames[item.state]; saved.reason.textContent = item.reason
  }
  show('results-panel', !!runner.items.length); show('more-results', runner.items.length > visibleResults)
  show('retry-run', !runner.busy && runner.items.some(item => item.state !== 'done'))
  controls()
}
async function selectDirectory() {
  const path = await drive.ui.pickDirectory(root?.path ?? '/')
  if (path == null) return
  const directory = await drive.files.stat({ path }, { signal: lifetime.signal })
  if (!directory.is_dir) throw new Error('请选择网盘目录')
  root = directory; text('directory', directory.path); controls()
}
async function freshFiles(ids: number[], directory: FileEntry, signal: AbortSignal) {
  const files: FileEntry[] = []
  for (const id of new Set(ids)) {
    signal.throwIfAborted()
    try {
      const file = await drive.files.stat({ id }, { signal })
      if (!file.is_dir && (directory.path === '/' || file.path.startsWith(`${directory.path}/`))) files.push(file)
    } catch { signal.throwIfAborted() /* 已删除、移出范围或不可访问的视频直接跳过。 */ }
  }
  return files
}
async function verifyBeforeRetry(record: ScraperRecord) {
  if (record.read_only) throw new Error('恢复记录仅供查看，请选择目录重新刮削')
  if (['running', 'stopping'].includes(record.status)) throw new Error('原任务尚未停止，请稍后重试')
  if (record.items.some(item => item.status === 'needs_verification')) await scrape.verify(record.id)
}
async function start(retry = false, record?: ScraperRecord) {
  if (runner.busy || preparing || configuring || !root) return
  preparing = true; setup = new AbortController(); controls()
  const signal = setup.signal, expected = root
  try {
    const directory = await drive.files.stat({ id: expected.id }, { signal })
    if (!directory.is_dir || directory.path !== expected.path) throw new Error('所选目录已变化，请重新选择')
    let files: FileEntry[] | undefined
    if (retry) {
      if (record) await verifyBeforeRetry(record)
      else for (const id of runner.recordIds) { signal.throwIfAborted(); await verifyBeforeRetry(await readRecord(drive, id, signal)) }
      const ids = record ? record.items.filter(item => item.status !== 'done').flatMap(item => item.files.map(file => file.id)) : runner.items.filter(item => item.state !== 'done').flatMap(item => item.group.files.map(file => file.id))
      files = await freshFiles(ids, directory, signal)
      if (!files.length) throw new Error('未找到仍在所选目录中的未完成视频')
    }
    signal.throwIfAborted(); preparing = false
    const refresh = !retry && input('refresh-mode').checked
    await runner.start(directory, { refresh, update_nfo: !refresh || input('update-nfo').checked, update_poster: !refresh || input('update-poster').checked }, files)
  } finally { preparing = false; controls() }
}
async function stop() { setup.abort(); await runner?.stop(); controls() }
function renderHistory(entries: ScraperHistory[]) {
  for (const entry of entries) {
    const card = node('article', '', 'history-card'), copy = node('div'), open = node('button', '查看结果')
    copy.append(node('p', `${stateName(entry.status)} · 已完成 ${entry.completed}/${entry.total} 项`, 'file-name'), node('p', entry.root_path, 'file-path'), node('time', new Date(entry.created_at * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })))
    open.onclick = () => { void openRecord(entry.id).catch(message) }; card.append(copy, open); $('history').append(card)
  }
}
async function loadHistory(reset: boolean) {
  if (reset) { historyCursor = undefined; $('history').replaceChildren(); show('record-panel', false); currentRecord = undefined }
  const result = await scrape.records({ cursor: historyCursor, limit: 30 }, { signal: lifetime.signal })
  renderHistory(result.records); historyCursor = result.next_cursor ?? undefined; show('more-history', result.has_more)
  text('history-status', $('history').children.length ? '' : '暂无刮削记录。')
}
async function openRecord(id: string) {
  const record = await readRecord(drive, id, lifetime.signal)
  currentRecord = record; show('record-panel', true); $('record-items').replaceChildren()
  text('record-status', record.read_only ? '恢复记录仅供查看，请选择目录重新刮削。' : `${stateName(record.status)}${record.message ? ` · ${resultReason(record.message)}` : ''}`)
  for (const item of record.items) {
    const row = node('article', '', 'record-row'), steps = node('div', '', 'steps')
    row.append(node('p', item.files.map(file => file.name).join('、'), 'file-name'), node('p', item.target_path ?? item.files[0]?.path ?? '', 'file-path'))
    steps.append(node('span', stateName(item.status)))
    for (const [title, step] of [['整理', item.result.organize], ['NFO', item.result.nfo], ['海报', item.result.poster]] as const) steps.append(node('span', `${title}：${stateName(step?.state || 'pending')}`))
    row.append(steps); if (item.result.reason) row.append(node('p', resultReason(item.result.reason), 'result-reason')); $('record-items').append(row)
  }
  controls()
}
async function continueRecord() {
  const record = currentRecord
  if (!record) return
  const directory = await drive.files.stat({ id: record.root_id }, { signal: lifetime.signal })
  if (!directory.is_dir || directory.path !== record.root_path) throw new Error('原目录已变化，请重新选择目录')
  root = directory; text('directory', directory.path); setTab('scrape'); await start(true, record)
}
async function loadConnection() {
  const config = await scrape.config({ signal: lifetime.signal }); savedUrl = config.backend_url; input('backend-url').value = savedUrl
  text('token-status', config.token_configured ? '已配置 Token。' : '未配置 Token，使用后端的匿名访问。')
}
async function saveConnection() {
  if (runner.busy || configuring || !input('backend-url').reportValidity()) return
  configuring = true; controls()
  try {
    const token = input('clear-token').checked ? '' : input('backend-token').value || undefined
    const config = await scrape.configure(input('backend-url').value, token)
    savedUrl = config.backend_url; input('backend-url').value = savedUrl; input('backend-token').value = ''; input('clear-token').checked = false
    text('token-status', config.token_configured ? '已配置 Token。' : '未配置 Token，使用后端的匿名访问。'); text('connection-status', '连接配置已保存。')
  } finally { configuring = false; controls() }
}
on('choose', 'click', selectDirectory)
on('authorize', 'click', () => drive.settings.open())
on('start', 'click', () => start())
on('cancel', 'click', stop)
on('retry-run', 'click', () => start(true))
on('more-results', 'click', () => { visibleResults += 100; render() })
on('refresh-mode', 'change', () => show('refresh-options', input('refresh-mode').checked))
on('reload-history', 'click', () => loadHistory(true))
on('more-history', 'click', () => loadHistory(false))
on('continue-record', 'click', continueRecord)
on('save-connection', 'click', saveConnection)
on('connection-form', 'keydown', event => { if ((event as KeyboardEvent).key === 'Enter') { event.preventDefault(); return saveConnection() } })
on('check-connection', 'click', async () => {
  if (input('backend-url').value.trim() !== savedUrl) throw new Error('请先保存新的连接地址')
  text('connection-status', '正在检查连接…')
  const providers = await scrape.providers({ signal: lifetime.signal })
  $('providers').replaceChildren(...providers.map(provider => node('span', provider))); text('connection-status', `连接正常，共 ${providers.length} 个资料源。`)
})
on('exit', 'click', () => drive.ui.close())
document.querySelectorAll<HTMLElement>('[data-tab]').forEach(item => { item.onclick = () => setTab(item.dataset.tab!) })
drive.on('beforeClose', async () => {
  await stop(); if (drive.can('ui.setImmersive')) await drive.ui.setImmersive(false); lifetime.abort()
})
window.addEventListener('pagehide', () => { setup.abort(); void runner?.stop().catch(() => {}); lifetime.abort() }, { once: true })
drive.on('theme.changed', (value: unknown) => { dark = typeof value === 'boolean' ? value : !!(value as { dark?: boolean })?.dark; document.documentElement.dataset.theme = dark ? 'dark' : 'light'; void syncImmersion().catch(message) })
drive.on('settings.changed', () => { void (async () => { await stop(); root = undefined; text('directory', '请选择目录'); await loadConnection(); controls() })().catch(message) })
mobileQuery.addEventListener('change', () => { void syncImmersion().catch(message) })
async function boot() {
  try {
    const context = await drive.ready; dark = context.dark; document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    if (!scrape || !drive.can('scraper.service')) throw new Error('影视刮削需要宿主 0.3.10 或更高版本，请升级宿主后重新打开。')
    runner = new DirectoryScrape(drive, render)
    await loadConnection(); await syncImmersion()
    // 刚授权的唯一目录或从网盘打开的目录直接带入；打开应用不会自动执行。
    const initial = context.launch?.file.is_dir ? context.launch.file.path : context.scope?.mode === 'selected' && context.scope.paths.length === 1 ? context.scope.paths[0] : undefined
    if (initial) {
      try { const directory = await drive.files.stat({ path: initial }, { signal: lifetime.signal }); if (directory.is_dir) root = directory } catch { /* 目录已变化时由用户重新选择。 */ }
    }
    text('directory', root?.path ?? '请选择目录'); show('app', true); show('boot', false); controls()
  } catch (error) { text('boot-status', error instanceof Error ? error.message : String(error)); show('boot-retry', true) }
}
on('boot-retry', 'click', boot); void boot()
