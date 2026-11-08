import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Drive, FntvConfig, FntvCoverStatus, FntvLibrary, FntvService } from '../../sdk/types'
import page from '../../fntv/index.html?raw'

function field<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id)
  if (!value) throw new Error(`缺少测试控件 ${id}`)
  return value as T
}

async function boot(context: { dark: boolean; capabilities: string[] } = { dark: false, capabilities: [] }) {
  const events = new Map<string, (value?: unknown) => unknown>()
  const setImmersive = vi.fn(async (_active: boolean, _options?: { background: string }) => {})
  const close = vi.fn(async () => {})
  let config: FntvConfig = { username: '', account_configured: false, running: false, libraries: [] }
  let covers: FntvCoverStatus | undefined
  const status = () => ({ running: config.running, probe_available: true, index: { state: 'ready' as const, entries: 0, error: '' }, covers })
  const account = vi.fn(async (username: string, _password: string) => {
    config = { ...config, username, account_configured: true }
    return { ok: true as const }
  })
  const libraries = vi.fn(async (rows: FntvLibrary[]) => {
    config = { ...config, libraries: rows.map(row => ({ ...row, id: row.id || 'synthetic-library', authorized: true, path: '/合成电影' })) }
    return { ok: true as const, libraries: structuredClone(config.libraries) }
  })
  const refresh = vi.fn(async () => status().index)
  const service: FntvService = {
    config: async () => structuredClone(config), account, libraries, status: async () => status(),
    start: async () => { config.running = true; return { ok: true, running: true } },
    stop: async () => { config.running = false; return { ok: true, running: false } },
    refresh,
  }
  vi.stubGlobal('tgdrive', {
    ready: Promise.resolve(context), can: (capability: string) => capability === 'fntv.service', fntv: service,
    on: (name: string, callback: (value?: unknown) => unknown) => { events.set(name, callback); return () => {} },
    ui: { authorizeDirectory: async () => '/合成电影', setImmersive, close },
    files: { stat: async () => ({ id: 2, is_dir: true, name: '合成电影', path: '/合成电影' }) },
  } as unknown as Drive)
  vi.stubGlobal('matchMedia', () => ({ matches: mobile, addEventListener() {}, removeEventListener() {} }))
  document.body.innerHTML = new DOMParser().parseFromString(page, 'text/html').body.innerHTML
  await import('../../fntv/main')
  await vi.waitFor(() => expect(field('account-state').textContent).toBe('尚未设置账号'))
  return { account, libraries, refresh, setImmersive, close, events, setCovers: (value: FntvCoverStatus) => { covers = value } }
}

let mobile = false
beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); mobile = false })
afterEach(() => {
  window.dispatchEvent(new Event('pagehide'))
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals()
  document.body.innerHTML = ''
  document.documentElement.className = ''
})

it('账号和媒体库按钮无需原生表单提交即可保存，密码清空后能主动启动', async () => {
  const { account, libraries } = await boot()
  const nativeSubmit = vi.fn()
  field('account-form').addEventListener('submit', nativeSubmit)
  field<HTMLInputElement>('username').value = 'synthetic-user'
  field<HTMLInputElement>('password').value = 'Synthetic-Only-Password'
  field('save-account').click()
  await vi.waitFor(() => expect(field('account-state').textContent).toBe('已设置独立影视账号'))
  expect(account).toHaveBeenCalledExactlyOnceWith('synthetic-user', 'Synthetic-Only-Password')
  expect(nativeSubmit).not.toHaveBeenCalled()
  expect(field<HTMLInputElement>('password').value).toBe('')

  field('pick-directory').click()
  await vi.waitFor(() => expect(field<HTMLButtonElement>('add-library').disabled).toBe(false))
  field<HTMLInputElement>('library-name').value = '我的电影'
  field('add-library').click()
  await vi.waitFor(() => expect(field('libraries').textContent).toContain('我的电影'))
  expect(libraries).toHaveBeenCalledExactlyOnceWith([{ id: '', name: '我的电影', kind: 'movie', root_id: 2 }])
  expect(field<HTMLButtonElement>('start').disabled).toBe(false)
  field('start').click()
  await vi.waitFor(() => expect(field('service-state').textContent).toBe('服务运行中'))

  field<HTMLInputElement>('username').value = '正在编辑的账号'
  field('username').dispatchEvent(new Event('input', { bubbles: true }))
  await vi.advanceTimersByTimeAsync(3000)
  expect(field<HTMLInputElement>('username').value).toBe('正在编辑的账号')
  expect(account).toHaveBeenCalledTimes(1)
})

it('无效字段不写入宿主，输入框回车保存且进行中不会重复提交', async () => {
  const { account } = await boot()
  field('save-account').click()
  expect(account).not.toHaveBeenCalled()
  field<HTMLInputElement>('username').value = 'synthetic-enter'
  field<HTMLInputElement>('password').value = 'Synthetic-Only-Password'
  const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  field('password').dispatchEvent(enter)
  field('save-account').click()
  expect(enter.defaultPrevented).toBe(true)
  await vi.waitFor(() => expect(field('account-state').textContent).toBe('已设置独立影视账号'))
  expect(account).toHaveBeenCalledTimes(1)
})

it('轮询显示封面状态和安全的失败原因，沿用刷新媒体库重试且兼容旧宿主', async () => {
  const { refresh, setCovers } = await boot()
  expect(field('cover-state').textContent).toBe('自动补封面需要更新宿主。')
  setCovers({ ready: 2, pending: 1, failed: 1, retrying: 1, bytes: 1024, limit_bytes: 256 * 1024 * 1024, frame_available: true,
    errors: [{ title: '<img src=x onerror=alert(1)>', reason: '上游存储暂时不可用', retry_at: 1 }] })
  await vi.advanceTimersByTimeAsync(3000)
  expect(field('cover-state').textContent).toContain('已就绪 2 · 待补 1 · 失败 1')
  expect(field('cover-errors').hidden).toBe(false)
  expect(field('cover-error-list').textContent).toContain('<img src=x onerror=alert(1)>：上游存储暂时不可用；稍后自动重试')
  expect(field('cover-error-list').querySelector('img')).toBeNull()
  expect([...document.querySelectorAll('button')].some(button => button.textContent?.includes('重试'))).toBe(false)
  field('refresh').click()
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
  await vi.waitFor(() => expect(field('message').textContent).toContain('后台继续补齐缺图封面'))
})

it('启动按钮不可用时说明缺少的步骤，配置齐全后提示消失', async () => {
  const { account, libraries } = await boot()
  expect(field<HTMLButtonElement>('start').disabled).toBe(true)
  expect(field('start-hint').textContent).toBe('启动前还需：设置影视账号、添加媒体库')
  await account('synthetic-user', 'Synthetic-Only-Password')
  await vi.advanceTimersByTimeAsync(3000)
  expect(field('start-hint').textContent).toBe('启动前还需：添加媒体库')
  await libraries([{ id: '', name: '我的电影', kind: 'movie', root_id: 2 }])
  await vi.advanceTimersByTimeAsync(3000)
  expect(field('start-hint').hidden).toBe(true)
})

it('轮询内容不变时不重建媒体库列表，避免触摸中的按钮被替换', async () => {
  const { libraries } = await boot()
  await libraries([{ id: '', name: '我的电影', kind: 'movie', root_id: 2 }])
  await vi.advanceTimersByTimeAsync(3000)
  const row = field('libraries').querySelector('.library')
  expect(row).not.toBeNull()
  await vi.advanceTimersByTimeAsync(3000)
  expect(field('libraries').querySelector('.library')).toBe(row)
})

it('主题跟随主站，手机沉浸并由本页返回网盘', async () => {
  mobile = true
  const { setImmersive, close, events } = await boot({ dark: true, capabilities: ['ui.setImmersive', 'ui.immersiveBackground'] })
  expect(document.documentElement.classList.contains('dark')).toBe(true)
  expect(setImmersive).toHaveBeenCalledWith(true, { background: '#000000' })
  events.get('theme.changed')?.({ dark: false })
  expect(document.documentElement.classList.contains('dark')).toBe(false)
  await vi.waitFor(() => expect(setImmersive).toHaveBeenCalledWith(true, { background: '#f2f2f7' }))
  field('exit').click()
  await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1))
  expect(setImmersive).toHaveBeenLastCalledWith(false, undefined)
})

it('桌面不请求沉浸', async () => {
  const { setImmersive } = await boot({ dark: false, capabilities: ['ui.setImmersive'] })
  expect(setImmersive).not.toHaveBeenCalledWith(true, expect.anything())
  expect(setImmersive.mock.calls.every(call => call[0] === false)).toBe(true)
})

it('复制连接地址：成功提示后自动消失，失败时提示手动复制', async () => {
  await boot()
  const execCommand = vi.fn(() => true)
  document.execCommand = execCommand
  field('copy-address').click()
  expect(execCommand).toHaveBeenCalledWith('copy')
  expect(field('message').textContent).toBe('连接地址已复制。')
  await vi.advanceTimersByTimeAsync(4000)
  expect(field('message').hidden).toBe(true)
  execCommand.mockReturnValue(false)
  field('copy-address').click()
  expect(field('message').textContent).toContain('手动复制')
  await vi.advanceTimersByTimeAsync(4000)
  expect(field('message').hidden).toBe(false)
})
