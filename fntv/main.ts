import '../ui/base.css'
import './style.css'
import { icon, type IconName } from '../ui/icons'
import { applyTheme, ImmersiveSync, MOBILE_QUERY } from '../cinema/shell'
import type { FntvConfig, FntvLibrary, FntvService, FntvStatus } from '../sdk/types'

const drive = window.tgdrive
function element<T extends HTMLElement>(id: string): T { const value = document.getElementById(id); if (!value) throw new Error('页面控件缺失'); return value as T }
let service: FntvService
let config: FntvConfig
let picked: { id: number; path: string } | undefined
let busy = false
let accountEdited = false
let renderedLibraries: string | undefined
let messageTimer: ReturnType<typeof setTimeout> | undefined

// 页面较长，操作结果用浮动提示；成功提示自动消失，错误保留到下一条消息。
function message(text: string, error = false) {
  const view = element('message'); view.textContent = text; view.classList.toggle('error', error); view.hidden = !text
  clearTimeout(messageTimer)
  if (text && !error) messageTimer = setTimeout(() => { view.hidden = true }, 4000)
}
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
  const startHint = element('start-hint')
  const missing = [fresh.account_configured ? '' : '设置影视账号', fresh.libraries.some(l => l.authorized) ? '' : '添加媒体库'].filter(Boolean)
  startHint.textContent = !status.running && missing.length ? `启动前还需：${missing.join('、')}` : ''
  startHint.hidden = !startHint.textContent
  // 轮询内容不变时不重建列表，否则手机上按下与抬起之间按钮被替换会丢点击。
  const librariesKey = JSON.stringify(fresh.libraries)
  if (librariesKey === renderedLibraries) return
  renderedLibraries = librariesKey
  const container = element('libraries'); container.replaceChildren()
  if (!fresh.libraries.length) { const hint = document.createElement('p'); hint.className = 'empty'; hint.textContent = '还没有媒体库。先选择目录，再添加媒体库。'; container.append(hint) }
  for (const library of fresh.libraries) {
    const row = document.createElement('div'); row.className = 'library'
    row.insertAdjacentHTML('afterbegin', icon('folder'))
    const content = document.createElement('div'); content.className = 'library-text'; const title = document.createElement('strong'); title.textContent = library.name
    const detail = document.createElement('span'); detail.textContent = `${library.kind === 'movie' ? '电影' : '电视剧'} · ${library.authorized ? library.path : '目录授权已失效'}`
    detail.classList.toggle('invalid', !library.authorized)
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

function copyAddress() {
  // 宿主 iframe 未授予 clipboard-write，只能选中文本后走 execCommand；失败时保留选中供手动复制。
  const address = element<HTMLInputElement>('address')
  address.focus(); address.setSelectionRange(0, address.value.length)
  let copied = false
  try { copied = document.execCommand('copy') } catch { /* 浏览器拒绝时按未复制提示。 */ }
  if (copied) { address.setSelectionRange(0, 0); address.blur() }
  message(copied ? '连接地址已复制。' : '无法自动复制，请长按地址手动复制。', !copied)
}

async function connectShell() {
  const context = await drive.ready
  const media = window.matchMedia(MOBILE_QUERY)
  const shell = new ImmersiveSync(drive, context, () => {})
  let dark = context.dark
  // 手机打开即隐藏宿主顶栏，由本页顶栏提供返回入口。
  const sync = () => { applyTheme(document.documentElement, dark); void shell.update({ mobile: media.matches, playing: false, dark }) }
  sync()
  drive.on('theme.changed', value => { dark = !!(value as { dark?: boolean } | undefined)?.dark; sync() })
  media.addEventListener('change', sync)
  element('exit').addEventListener('click', () => void shell.dispose().then(() => drive.ui.close()))
  window.addEventListener('pagehide', () => void shell.dispose(), { once: true })
}

async function initialize() {
  for (const target of document.querySelectorAll<HTMLElement>('[data-icon]')) target.insertAdjacentHTML('afterbegin', icon(target.dataset.icon as IconName))
  await connectShell()
  if (!drive.fntv || !drive.can('fntv.service')) throw new Error('当前宿主不支持影视服务能力，请升级至支持此插件的宿主。')
  service = drive.fntv
  await drive.lifecycle?.migrate(1, async () => {})
  element<HTMLInputElement>('address').value = new URL(window.location.href).origin
  element('copy-address').addEventListener('click', copyAddress)
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
