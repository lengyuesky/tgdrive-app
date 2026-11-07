import './style.css'
import type { FntvConfig, FntvLibrary, FntvService, FntvStatus } from '../sdk/types'

const drive = window.tgdrive
function element<T extends HTMLElement>(id: string): T { const value = document.getElementById(id); if (!value) throw new Error('页面控件缺失'); return value as T }
let service: FntvService
let config: FntvConfig
let picked: { id: number; path: string } | undefined
let busy = false
let accountEdited = false

function message(text: string, error = false) { const view = element('message'); view.textContent = text; view.classList.toggle('error', error); view.hidden = !text }
async function update() {
  const [fresh, status] = await Promise.all([service.config(), service.status()])
  config = fresh
  if (!accountEdited) element<HTMLInputElement>('username').value = fresh.username
  element('account-state').textContent = fresh.account_configured ? '已设置独立影视账号' : '尚未设置账号'
  element('service-state').textContent = status.running ? '服务运行中' : '服务已停止'
  element('service-state').classList.toggle('running', status.running)
  element('start').hidden = status.running; element('stop').hidden = !status.running
  element<HTMLButtonElement>('start').disabled = !fresh.account_configured || !fresh.libraries.some(l => l.authorized) || !status.probe_available
  const states: Record<FntvStatus['index']['state'], string> = { idle: '等待创建媒体库', scanning: '正在整理媒体库', ready: `已整理 ${status.index.entries} 条视频`, failed: status.index.error || '媒体库整理失败，请刷新重试' }
  element('index-state').textContent = !status.probe_available ? '宿主媒体探测组件不可用，请检查宿主安装。' : states[status.index.state]
  const covers = status.covers
  element('cover-state').textContent = covers
    ? `封面：已就绪 ${covers.ready} · 待补 ${covers.pending} · 失败 ${covers.failed}${covers.retrying ? `（${covers.retrying} 条将自动重试）` : ''}`
    : '自动补封面需要更新宿主。'
  const failures = element('cover-error-list'); failures.replaceChildren()
  for (const error of covers?.errors ?? []) {
    const row = document.createElement('li'); row.textContent = `${error.title}：${error.reason}${error.retry_at ? '；稍后自动重试' : '；可刷新媒体库重试'}`
    failures.append(row)
  }
  element('cover-errors').hidden = !covers?.errors.length
  const container = element('libraries'); container.replaceChildren()
  if (!fresh.libraries.length) { const hint = document.createElement('p'); hint.textContent = '还没有媒体库。先选择目录，再添加媒体库。'; container.append(hint) }
  for (const library of fresh.libraries) {
    const row = document.createElement('div'); row.className = 'library'
    const content = document.createElement('div'); const title = document.createElement('strong'); title.textContent = library.name
    const detail = document.createElement('span'); detail.textContent = `${library.kind === 'movie' ? '电影' : '电视剧'} · ${library.authorized ? library.path : '目录授权已失效'}`
    content.append(title, detail)
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '移除'; remove.setAttribute('aria-label', `移除媒体库 ${library.name}`)
    remove.addEventListener('click', () => void action(async () => { await service.libraries(clean(fresh.libraries.filter(l => l.id !== library.id))); message('已移除媒体库。相关旧连接已失效，观看记录仍保留。') }))
    row.append(content, remove); container.append(row)
  }
}
function clean(libraries: FntvLibrary[]): FntvLibrary[] { return libraries.map(({ id, name, kind, root_id }) => ({ id, name, kind, root_id })) }
async function action(work: () => Promise<void>) {
  if (busy) return
  busy = true
  try { await work(); await update() } catch (error) { message(error instanceof Error ? error.message : '操作失败，请稍后重试', true) }
  finally { busy = false }
}

// 页面沙箱不允许原生表单导航；按钮直接调用宿主，保留字段校验和回车操作。
function bindForm(formId: string, buttonId: string, work: () => Promise<void>) {
  const form = element<HTMLFormElement>(formId)
  const run = () => { if (!busy && form.reportValidity()) void action(work) }
  element(buttonId).addEventListener('click', run)
  form.addEventListener('submit', event => { event.preventDefault(); run() })
  form.addEventListener('keydown', event => {
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) { event.preventDefault(); run() }
  })
}

async function initialize() {
  await drive.ready
  if (!drive.fntv || !drive.can('fntv.service')) throw new Error('当前宿主不支持影视服务能力，请升级至支持此插件的宿主。')
  service = drive.fntv
  await drive.lifecycle?.migrate(1, async () => {})
  element<HTMLInputElement>('address').value = new URL(window.location.href).origin
  await update()
  element('username').addEventListener('input', () => { accountEdited = true })
  bindForm('account-form', 'save-account', async () => {
    const username = element<HTMLInputElement>('username').value.trim(); const password = element<HTMLInputElement>('password')
    await service.account(username, password.value); password.value = ''; accountEdited = false; message('影视账号已保存。已有客户端请重新登录。')
  })
  element('pick-directory').addEventListener('click', () => void action(async () => {
    const path = await drive.ui.authorizeDirectory?.('/')
    if (!path) return
    const node = await drive.files.stat({ path }); if (!node.is_dir) throw new Error('请选择网盘目录')
    picked = { id: node.id, path }; element('picked-directory').textContent = path
    element<HTMLButtonElement>('add-library').disabled = false
    if (!element<HTMLInputElement>('library-name').value) element<HTMLInputElement>('library-name').value = node.name || '我的媒体库'
  }))
  bindForm('library-form', 'add-library', async () => {
    if (!picked) throw new Error('请先选择并授权目录')
    const library: FntvLibrary = { id: '', name: element<HTMLInputElement>('library-name').value.trim(), kind: element<HTMLSelectElement>('library-kind').value as 'movie' | 'tv', root_id: picked.id }
    await service.libraries([...clean(config.libraries), library]); picked = undefined
    element<HTMLInputElement>('library-name').value = ''; element('picked-directory').textContent = '尚未选择目录'; element<HTMLButtonElement>('add-library').disabled = true
    message('媒体库已保存。准备好后主动启动服务。')
  })
  element('start').addEventListener('click', () => void action(async () => { await service.start(); message('服务已启动，可以在客户端添加连接。') }))
  element('stop').addEventListener('click', () => void action(async () => { await service.stop(); message('服务已停止，旧登录和进行中的传输已中止。') }))
  element('refresh').addEventListener('click', () => void action(async () => { await service.refresh(); message('媒体库已刷新。服务运行时会在后台继续补齐缺图封面。') }))
  await drive.lifecycle?.report('ready')
  const timer = setInterval(() => { if (!busy && document.visibilityState === 'visible') void update().catch(() => {}) }, 3000)
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true })
}
initialize().catch(error => message(error instanceof Error ? error.message : '服务管理页加载失败', true))
