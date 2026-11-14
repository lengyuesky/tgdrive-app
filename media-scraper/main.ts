import './style.css'
import type { FileEntry, ScraperCandidate, ScraperHandle, ScraperPreview, ScraperRecord, ScraperHistory } from '../sdk/types'
import { VIDEO_EXTENSIONS, groups, parent, stem, foldName, sharedCompanion, normalizedNumber, reference, uniqueExact, stateName, type Group } from './model'

const drive = window.tgdrive, scrape = drive.scraper!
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const text = (id: string, value: string) => { $(id).textContent = value }
const show = (id: string, visible: boolean) => { $(id).hidden = !visible }
const input = (id: string) => $<HTMLInputElement>(id)
const button = (id: string) => $<HTMLButtonElement>(id)
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, body = '', className = '') => { const result = document.createElement(tag); result.textContent = body; result.className = className; return result }
const taskId = (batch: ScraperHandle) => `scrape-${batch.id.toLowerCase()}`
const lifetime = new AbortController()
const mobileQuery = window.matchMedia('(max-width:700px), (pointer:coarse)')
let dark = false
let root: FileEntry | undefined, page = 0, cursors: (string | null)[] = [null], nextCursor: string | null = null
let pageGroups: Group[] = [], draft: ScraperHandle | undefined, preparing = false, running = false, stopping = false, userStopped = false, scanBusy = false
let scanController = new AbortController(), previewController = new AbortController(), executionController = new AbortController()
let cancelPromise: Promise<void> | undefined, heartbeat: ReturnType<typeof setInterval> | undefined, notice: ReturnType<typeof setTimeout>
let currentRecord: ScraperRecord | undefined, historyCursor: string | undefined, savedUrl = ''
const selected = new Map<string, Group>(), plans = new Map<string, ScraperPreview>(), sourceChoices = new Map<string, ScraperCandidate>()
const dirtyGroups = new Set<string>()
const posterCache = new Map<string, Promise<string>>()
interface Folder { files: FileEntry[]; shared: FileEntry[] }
let folderCache = new Map<string, Promise<Folder>>()
function message(error: unknown) { if ((error as Error)?.name === 'AbortError') return; text('message', error instanceof Error ? error.message : String(error)); show('message', true); clearTimeout(notice); notice = setTimeout(() => show('message', false), 6000) }
async function syncImmersion(){
  if(lifetime.signal.aborted||!drive.can('ui.setImmersive'))return
  await drive.ui.setImmersive(mobileQuery.matches,drive.can('ui.immersiveBackground')?{background:dark?'#10131a':'#f3f5f8'}:undefined)
}
function on(id: string, event: string, action: (event: Event) => unknown) { $(id).addEventListener(event, event => { try { void Promise.resolve(action(event)).catch(message) } catch (error) { message(error) } }) }
function setTab(tab: string) {
  for (const value of ['scrape','history','connection']) show(`${value}-view`, value === tab)
  document.querySelectorAll<HTMLElement>('[data-tab]').forEach(item => { item.classList.toggle('active', item.dataset.tab === tab); item.setAttribute('aria-current', item.dataset.tab === tab ? 'page' : 'false') })
  if (tab === 'history') void loadHistory(true).catch(message)
}
function controls() {
  const busy = preparing || running || stopping || scanBusy
  for (const id of ['choose','scan','authorize','select-page','refresh-mode','update-nfo','update-poster','previous','next-page','save-connection','check-connection']) ($(id) as HTMLButtonElement | HTMLInputElement).disabled = busy
  button('scan').disabled = busy || !root
  button('previous').disabled = busy || page === 0
  button('next-page').disabled = busy || !nextCursor
  button('preview').disabled = busy || !selected.size
  const ready = [...plans.values()].filter(plan => plan.ready).length
  button('execute').disabled = busy || !draft || !ready || dirtyGroups.size > 0
  button('execute').textContent = ready ? `确认执行 ${ready} 组整理与刮削` : '确认整理并刮削'
  button('cancel').disabled = !running && !stopping
  button('discard-preview').disabled = running
  document.querySelectorAll<HTMLInputElement>('#backend-url,#backend-token,#clear-token').forEach(element => { element.disabled = busy })
  document.querySelectorAll<HTMLButtonElement | HTMLInputElement>('#plans button,#plans input').forEach(element => { element.disabled = busy })
  text('selected-count', `已选择 ${selected.size} 组 · ${[...selected.values()].reduce((sum, group) => sum + group.files.length, 0)} 个视频`)
  document.querySelectorAll<HTMLInputElement>('#videos input').forEach(element => { element.disabled = busy })
}
async function abandon() {
  if (running) throw new Error('请先停止当前批次，再关闭或重新生成预览')
  previewController.abort(); plans.clear(); sourceChoices.clear(); dirtyGroups.clear(); show('preview-panel', false)
  const previous = draft; draft = undefined
  if (previous && !running) await scrape.stop(previous).catch(() => {})
  controls()
}
async function selectDirectory() {
  const path = await drive.ui.pickDirectory(root?.path ?? '/')
  if (path == null) return
  const directory = await drive.files.stat({ path })
  if (!directory.is_dir) throw new Error('请选择网盘目录')
  await abandon(); root = directory; selected.clear(); cursors = [null]; page = 0
  text('directory', root.path); await scanPage()
}
async function scanPage() {
  if (!root) return
  scanController.abort(); scanController = new AbortController(); scanBusy = true; controls()
  const signal = scanController.signal
  text('scan-status', '正在递归读取视频列表…')
  try {
    const result = await drive.files.searchPage({ under: root.path, kind: 'file', extensions: VIDEO_EXTENSIONS, limit: 100, cursor: cursors[page] }, { signal })
    signal.throwIfAborted(); nextCursor = result.has_more ? result.next_cursor : null
    pageGroups = groups(result.results).map(group => selected.get(group.key) ?? group)
    renderVideos(); text('page-label', `第 ${page + 1} 页`)
    text('scan-status', result.results.length ? '勾选需要处理的视频组，番号可修改；预览会核对同名视频及配套文件。' : '此页没有视频。')
  } finally { if (!signal.aborted) { scanBusy = false; controls() } }
}
function renderVideos() {
  $('videos').replaceChildren()
  for (const group of pageGroups) {
    const row = node('article', '', 'video-row'), choose = node('input'), info = node('div'), label = node('label', '作品番号')
    choose.type = 'checkbox'; choose.checked = selected.has(group.key); choose.setAttribute('aria-label', `选择视频组：${group.files.map(file => file.name).join('、')}`)
    choose.onchange = () => { group.selected = choose.checked; if (choose.checked) selected.set(group.key, group); else selected.delete(group.key); void abandon().catch(message); controls() }
    info.append(node('p', group.files.map(file => file.name).join('、'), 'file-name'), node('p', parent(group.files[0].path), 'file-path'))
    const number = node('input'); number.type = 'text'; number.value = group.number; number.placeholder = '无法识别时请填写'; number.maxLength = 100
    number.setAttribute('aria-label', `${group.files[0].name} 的番号`)
    number.onchange = () => { group.number = number.value.trim().toUpperCase(); group.candidate = undefined; void abandon().catch(message) }
    label.append(number); row.append(choose, info, label); $('videos').append(row)
  }
  input('select-page').checked = !!pageGroups.length && pageGroups.every(group => selected.has(group.key))
}
async function folder(group: Group): Promise<Folder> {
  const path = parent(group.files[0].path)
  let task = folderCache.get(path)
  if (!task) {
    task = (async () => {
      const files: FileEntry[] = []; let cursor: string | null = null; const seen = new Set<string>()
      do {
        const result = await drive.files.list({ path, limit: 200, cursor }, { signal: previewController.signal })
        files.push(...result.entries.filter(file => !file.is_dir)); cursor = result.has_more ? result.next_cursor : null
        if (cursor) { if (seen.has(cursor)) throw new Error('目录分页游标重复，请重新扫描'); seen.add(cursor) }
      } while (cursor)
      const videoStems = new Set(files.filter(file => VIDEO_EXTENSIONS.includes(file.name.split('.').pop()?.toLowerCase() ?? '')).map(file => foldName(stem(file.name))))
      const shared = files.filter(file => sharedCompanion(file.name,videoStems))
      return { files, shared }
    })()
    folderCache.set(path, task)
  }
  return task
}
function workKey(group: Group) { return plans.get(group.key)?.target_path ?? `${parent(group.files[0].path)}/${normalizedNumber(group.number)}` }
async function makePreview(group: Group, auto = true): Promise<ScraperPreview> {
  const handle = draft
  if (!handle) throw new Error('请先创建预览')
  const siblings = await folder(group), base = foldName(stem(group.files[0].name))
  group.files = siblings.files.filter(file => VIDEO_EXTENSIONS.includes(file.name.split('.').pop()?.toLowerCase() ?? '') && foldName(stem(file.name)) === base)
  if (!group.files.length) throw new Error('所选视频已不在原目录，请重新扫描')
  const request = () => scrape.preview({ batch: handle, files: group.files.map(reference), number: group.number,
    candidate: group.candidate ?? null, refresh: input('refresh-mode').checked, update_nfo: input('update-nfo').checked, update_poster: input('update-poster').checked, shared_ids: group.sharedIds }, { signal: previewController.signal })
  let plan = await request(); previewController.signal.throwIfAborted()
  if (draft?.id !== handle.id) throw new DOMException('旧预览已关闭', 'AbortError')
  plans.set(group.key, plan)
  dirtyGroups.delete(group.key)
  if (plan.needs_candidate && auto) {
    const saved = sourceChoices.get(workKey(group))
    const candidates = saved ? [saved] : await scrape.search(group.number, { signal: previewController.signal })
    const candidate = saved ?? uniqueExact(candidates, group.number)
    if (candidate) {
      group.candidate = candidate; group.number = candidate.number; sourceChoices.set(workKey(group), candidate)
      plan = await request(); plans.set(group.key, plan)
    } else { renderPlan(group, plan, candidates); return plan }
  }
  renderPlan(group, plan); return plan
}
async function preview() {
  if (!root || !selected.size) return
  await abandon(); draft = await scrape.create(reference(root)); cancelPromise = undefined
  previewController = new AbortController(); folderCache = new Map(); preparing = true; controls()
  show('preview-panel', true); $('plans').replaceChildren(); text('preview-status', '正在检查位置、配套文件与资料候选…'); text('execution-status', '')
  try {
    for (const group of selected.values()) {
      previewController.signal.throwIfAborted()
      await makePreview(group)
    }
    text('preview-status', `预览完成：${[...plans.values()].filter(plan => plan.ready).length} 组可执行。标为待处理的组会保留。`)
  } finally { preparing = false; controls() }
}
function planCard(group: Group): HTMLElement {
  let card = [...$('plans').children].find(element => (element as HTMLElement).dataset.key === group.key) as HTMLElement | undefined
  if (!card) { card = node('article', '', 'plan-card'); card.dataset.key = group.key; $('plans').append(card) }
  card.replaceChildren(); return card
}
function renderPlan(group: Group, plan: ScraperPreview, candidates?: ScraperCandidate[]) {
  const card = planCard(group)
  card.append(node('p', group.files.map(file => file.name).join('、'), 'files'))
  if (plan.target_path) card.append(node('p', `目标：${plan.target_path}`, 'path'))
  if (plan.moving?.length) card.append(node('p', `同行文件：${plan.moving.map(file => file.name).join('、')}`, 'details-line'))
  for (const [name, artifact] of [['NFO',plan.nfo],['海报',plan.poster]] as const) if (artifact) card.append(node('p', `${name}：${({ keep:'保留已有',create:'补齐',replace:'覆盖' })[artifact.action]} · ${artifact.name}`, 'details-line'))
  if (plan.candidate) card.append(node('p', `资料来源：${plan.candidate.provider} · ${plan.candidate.number} · ${plan.candidate.title}`, 'details-line'))
  card.append(node('p', plan.error ?? (plan.ready ? '预览已就绪' : '等待选择资料候选'), plan.ready ? 'status-ready' : 'status-error'))
  const reload = node('button', '更新本组预览'); reload.disabled = running
  reload.onclick = () => { void (async () => { preparing = true; controls(); try { await makePreview(group); text('preview-status','已更新本组，请核对后执行。') } finally { preparing = false; controls() } })().catch(message) }
  card.append(reload)
  void folder(group).then(({ shared }) => {
    if (!card.isConnected || running || !shared.length) return
    const detail = node('details', '', 'shared-files'); detail.append(node('summary', `选择共用配套文件（${shared.length} 项，不会自动携带）`))
    let displayed = 0; const list = node('div'), more = node('button', '更多配套文件')
    const append = () => {
      for (const file of shared.slice(displayed, displayed + 100)) {
        const label = node('label'), checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = group.sharedIds.includes(file.id)
        checkbox.onchange = () => { group.sharedIds = checkbox.checked ? [...new Set([...group.sharedIds,file.id])] : group.sharedIds.filter(id => id !== file.id); dirtyGroups.add(group.key); button('execute').disabled = true; text('preview-status','配套文件选择已变化，请更新本组预览。') }
        label.append(checkbox, document.createTextNode(file.name)); list.append(label)
      }
      displayed += 100; more.hidden = displayed >= shared.length
    }
    more.onclick = append; append(); detail.append(list,more); card.append(detail)
  }).catch(() => {})
  if (candidates) {
    if (!candidates.length) card.append(node('p', '后端未找到该番号，请检查输入或稍后手动重试。', 'details-line'))
    const list = node('div', '', 'candidate-list'), more = node('button', '更多候选'); let count = 0
    const append = () => {
      for (const candidate of candidates.slice(count, count + 12)) {
        const choice = node('button', '', 'candidate'), copy = node('span'), image = node('img'); image.alt = ''; image.hidden = true
        copy.append(node('span', candidate.title || candidate.number, 'candidate-title'), node('small', `${candidate.provider} · ${candidate.number}`)); choice.append(image,copy)
        choice.onclick = () => { void (async () => {
          group.candidate = candidate; group.number = candidate.number; sourceChoices.set(workKey(group),candidate)
          preparing = true; controls()
          try { for (const related of selected.values()) if (related.key === group.key || workKey(related) === workKey(group)) { related.candidate = candidate; related.number = candidate.number; await makePreview(related,false) } }
          finally { preparing = false; controls() }
        })().catch(message) }
        const key = `${candidate.provider}:${candidate.id}`
        let task = posterCache.get(key)
        if (!task) { task = scrape.poster(candidate,{signal:previewController.signal}); posterCache.set(key,task) }
        void task.then(data => { if (image.isConnected && /^data:image\/jpeg;base64,/.test(data)) { image.src = data; image.hidden = false } }).catch(() => {})
        list.append(choice)
      }
      count += 12; more.hidden = count >= candidates.length
    }
    more.onclick = append; append(); card.append(list,more)
  }
}
async function execute() {
  if (!draft || running || preparing) return
  const batch = draft
  preparing = true; controls()
  try { await scrape.begin(batch); running = true } finally { preparing = false; controls() }
  cancelPromise = undefined; userStopped = false; stopping = false; executionController = new AbortController(); controls()
  const completed = new Set<string>(), total = [...plans.values()].filter(plan => plan.ready).length
  let taskState: 'done' | 'cancelled' | 'failed' = 'cancelled'
  heartbeat = setInterval(() => { void scrape.heartbeat(batch).catch(error => { void cancel(false).finally(() => message(error)) }) }, 5000)
  await drive.ui.setExitMessage?.('关闭页面会停止后续刮削步骤，已完成的整理和资料会保留。')
  try {
    for (;;) {
      if (!running || executionController.signal.aborted) break
      const result = await scrape.next(batch,{signal:executionController.signal})
      if (result.status === 'done' && result.item_id) completed.add(result.item_id)
      if (result.result) text('execution-status', `整理：${stateName(result.result.organize.state)} · NFO：${stateName(result.result.nfo.state)} · 海报：${stateName(result.result.poster.state)}${result.result.reason ? ` · ${result.result.reason}` : ''}`)
      if (result.done) { taskState=completed.size===total?'done':'failed'; text('execution-status','可执行项目已结束；待处理或待核实项目可在操作记录中查看。'); break }
      if (result.paused) { taskState='failed'; text('execution-status', result.result?.reason ?? '批次已暂停，请查看操作记录。'); break }
      await drive.ui.task?.({id:taskId(batch),title:'影视整理与刮削',completed:completed.size,total,state:'running'})
    }
  } catch (error) {
    if ((error as Error)?.name !== 'AbortError') { taskState='failed'; text('execution-status','请求中断，请从操作记录核实结果后手动继续。'); message(error) }
    await cancel(false)
  } finally {
    running = false; clearInterval(heartbeat); heartbeat = undefined
    if (!stopping && draft?.id===batch.id) draft=undefined
    controls()
    if(!stopping)await drive.ui.setExitMessage?.('')
    await drive.ui.task?.({id:taskId(batch),title:stopping?'影视刮削正在停止':'影视整理与刮削',completed:completed.size,total,state:stopping?'running':userStopped?'cancelled':taskState})
    await loadHistory(true)
  }
}
function cancel(manual = true): Promise<void> {
  if (!cancelPromise) cancelPromise = (async () => {
    userStopped ||= manual && (running || stopping)
    running = false; stopping = true; clearInterval(heartbeat); heartbeat = undefined; controls()
    const batch = draft
    try {
      if (batch) {
        let result = await scrape.stop(batch)
        if(!result.stopped)text('execution-status','正在停止在途步骤，请从操作记录核实最终结果。')
        for(let attempt=0;!result.stopped&&attempt<10;attempt++){
          await new Promise(resolve=>setTimeout(resolve,250))
          result=await scrape.stop(batch)
        }
        stopping=!result.stopped
        text('execution-status', result.stopped ? '后续操作已停止，已完成结果保留。' : '正在停止在途步骤，请从操作记录核实最终结果。')
        if(result.stopped){executionController.abort();if(draft?.id===batch.id)draft=undefined}
      }else stopping=false
    } catch (error) { text('execution-status','停止请求未获确认，请从操作记录核实最终结果。'); throw error }
    finally { if(stopping)cancelPromise=undefined;controls() }
  })()
  return cancelPromise
}
function renderHistory(entries: ScraperHistory[]) {
  for (const entry of entries) {
    const card = node('article', '', 'history-card'), info = node('div'), open = node('button', '查看结果')
    info.append(node('p', `${stateName(entry.status)} · ${entry.completed}/${entry.total} 组`, 'file-name'),node('p',entry.root_path,'file-path'),node('time',new Date(entry.created_at*1000).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})))
    if (entry.message) info.append(node('p',entry.message,'details-line'))
    open.onclick = () => { void openRecord(entry.id).catch(message) }; card.append(info,open); $('history').append(card)
  }
}
async function loadHistory(reset: boolean) {
  if (reset) { historyCursor = undefined; $('history').replaceChildren() }
  const result = await scrape.records({cursor:historyCursor,limit:30},{signal:lifetime.signal})
  renderHistory(result.records); historyCursor = result.next_cursor ?? undefined; show('more-history',result.has_more)
  text('history-status', $('history').children.length ? '' : '暂无操作记录。')
}
async function openRecord(id: string) {
  let record = await scrape.record({id},{signal:lifetime.signal})
  while (record.has_more && record.next_after != null) {
    const next = await scrape.record({id,after:record.next_after},{signal:lifetime.signal})
    record = {...record,items:[...record.items,...next.items],has_more:next.has_more,next_after:next.next_after}
  }
  currentRecord = record; show('record-panel',true); $('record-items').replaceChildren()
  text('record-status', `${stateName(record.status)} · ${record.message}`)
  for (const item of record.items) {
    const row = node('article','','record-row'), steps = node('div','','steps')
    row.append(node('p',item.files.map(file=>file.name).join('、'),'file-name'),node('p',item.target_path ?? item.files[0]?.path ?? '', 'file-path'))
    for (const [title,step] of [['整理',item.result.organize],['NFO',item.result.nfo],['海报',item.result.poster]] as const) steps.append(node('span',`${title}：${stateName(step?.state ?? 'pending')}`))
    row.append(steps); if (item.result.reason) row.append(node('p',item.result.reason,'details-line')); $('record-items').append(row)
  }
  const active = ['running','stopping'].includes(record.status), uncertain = record.items.some(item=>item.status==='needs_verification')
  button('verify-record').disabled = active || record.read_only || !uncertain
  button('continue-record').disabled = active || record.read_only || uncertain || !record.items.some(item=>item.status!=='done')
  if (record.read_only) text('record-status','恢复记录仅供查看，请从目录刮削重新扫描，再预览需要执行的项目。')
}
async function continueRecord() {
  const record = currentRecord
  if (!record) return
  if (record.read_only) throw new Error('恢复记录仅供查看，请重新扫描目录')
  const directory = await drive.files.stat({id:record.root_id})
  if (!directory.is_dir || directory.path!==record.root_path) throw new Error('原刮削目录已改变，请重新选择目录并扫描')
  await abandon(); root = directory; selected.clear()
  for (const item of record.items.filter(item=>item.status!=='done')) {
    const files: FileEntry[] = []
    for (const file of item.files) { try { const current = await drive.files.stat({id:file.id}); if (!current.is_dir && (directory.path==='/' || current.path.startsWith(`${directory.path}/`))) files.push(current) } catch { /* 不存在或已撤权的文件不会续操作。 */ } }
    for (const group of groups(files)) { group.selected=true; if (item.number) group.number=item.number; selected.set(group.key,group) }
  }
  if (!selected.size) throw new Error('未找到仍在授权目录内的未完成视频，请重新扫描')
  input('refresh-mode').checked=false; input('update-nfo').checked=true; input('update-poster').checked=true; show('refresh-options',false)
  text('directory',directory.path); setTab('scrape'); await preview()
}
async function loadConnection() {
  const config = await scrape.config({signal:lifetime.signal}); savedUrl=config.backend_url; input('backend-url').value=savedUrl
  text('token-status', config.token_configured?'已配置 Token，回读不显示原值。':'尚未配置 Token。')
}
on('choose','click',selectDirectory)
on('scan','click',async()=>{await abandon();selected.clear();page=0;cursors=[null];await scanPage()})
on('authorize','click',()=>drive.settings.open())
on('previous','click',async()=>{page--;await scanPage()})
on('next-page','click',async()=>{if(nextCursor){cursors[++page]=nextCursor;await scanPage()}})
on('select-page','change',async()=>{for(const group of pageGroups){group.selected=input('select-page').checked;if(group.selected)selected.set(group.key,group);else selected.delete(group.key)}await abandon();renderVideos();controls()})
on('refresh-mode','change',async()=>{show('refresh-options',input('refresh-mode').checked);await abandon()})
on('update-nfo','change',abandon);on('update-poster','change',abandon)
on('preview','click',preview);on('execute','click',execute);on('cancel','click',()=>cancel());on('discard-preview','click',abandon)
on('reload-history','click',()=>loadHistory(true));on('more-history','click',()=>loadHistory(false))
on('verify-record','click',async()=>{if(currentRecord){await scrape.verify(currentRecord.id);await openRecord(currentRecord.id)}})
on('continue-record','click',continueRecord)
async function saveConnection(){
  if(running)return
  if(!input('backend-url').reportValidity())return
  await abandon(); const token=input('clear-token').checked?'':input('backend-token').value||undefined
  const config=await scrape.configure(input('backend-url').value,token); savedUrl=config.backend_url; input('backend-url').value=savedUrl; input('backend-token').value='';input('clear-token').checked=false;posterCache.clear()
  for(const group of new Set([...selected.values(),...pageGroups]))group.candidate=undefined
  text('token-status',config.token_configured?'已配置 Token，回读不显示原值。':'尚未配置 Token。');text('connection-status','连接配置已保存。')
}
on('save-connection','click',saveConnection)
on('connection-form','keydown',event=>{if((event as KeyboardEvent).key==='Enter'){event.preventDefault();return saveConnection()}})
on('check-connection','click',async()=>{
  if(input('backend-url').value.trim()!==savedUrl)throw new Error('请先保存新的连接地址，再检查资料源')
  text('connection-status','正在检查已保存的后端…');const providers=await scrape.providers({signal:lifetime.signal});$('providers').replaceChildren(...providers.map(provider=>node('span',provider)));text('connection-status',`连接正常，后端列出 ${providers.length} 个资料源；各来源的搜索可用性以实际查询为准。`)
})
on('exit','click',()=>drive.ui.close())
document.querySelectorAll<HTMLElement>('[data-tab]').forEach(item=>item.onclick=()=>setTab(item.dataset.tab!))
drive.on('beforeClose',async()=>{await cancel();if(draft&&!running)await scrape.stop(draft).catch(()=>{});if(drive.can('ui.setImmersive'))await drive.ui.setImmersive(false);scanController.abort();previewController.abort();lifetime.abort()})
drive.on('task.cancel',(value: {id?: string} | undefined)=>{if(draft&&value?.id===taskId(draft))void cancel().catch(message)})
window.addEventListener('pagehide',()=>{running=false;clearInterval(heartbeat);executionController.abort();scanController.abort();previewController.abort();lifetime.abort()},{once:true})
drive.on('theme.changed',(value:unknown)=>{dark=typeof value==='boolean'?value:!!(value as {dark?:boolean})?.dark;document.documentElement.dataset.theme=dark?'dark':'light';void syncImmersion().catch(message)})
drive.on('settings.changed',()=>{void(async()=>{await abandon();for(const group of new Set([...selected.values(),...pageGroups]))group.candidate=undefined;posterCache.clear();await loadConnection()})().catch(message)})
mobileQuery.addEventListener('change',()=>{void syncImmersion().catch(message)})
async function boot(){
  try{
    const context=await drive.ready;dark=context.dark;document.documentElement.dataset.theme=dark?'dark':'light'
    if(!scrape||!drive.can('scraper.service'))throw new Error('影视刮削需要宿主 0.3.10 或更高版本，请升级宿主后重新打开。')
    await loadConnection();await syncImmersion();show('app',true);show('boot',false);controls()
  }catch(error){text('boot-status',error instanceof Error?error.message:String(error));show('boot-retry',true)}
}
on('boot-retry','click',boot);void boot()
