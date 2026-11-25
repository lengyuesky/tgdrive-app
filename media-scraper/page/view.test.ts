import { describe, expect, it, vi } from 'vitest'
import { PageUi } from '@tgdrive/page-sdk'
import type { PageContext, UiMessage, UiValue } from '@tgdrive/page-sdk'
import { ScraperPage } from './controller'
import { ScraperView } from './view'
import html from './index.html?raw'
import { actor, body, cleanup, failure, fixture } from './test-fixture'

const input = (id: string) => document.getElementById(id) as HTMLInputElement
const button = (id: string) => document.getElementById(id) as HTMLButtonElement
async function setup(options: Parameters<typeof fixture>[0] = {}) {
  const test = await fixture(options)
  document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML
  cleanup(() => document.body.replaceChildren())
  const exit = vi.fn(async () => {})
  const view = new ScraperView(test.page, exit); cleanup(() => view.dispose())
  test.changed.mockImplementation(() => view.render())
  await test.page.initialize({ observe: false }); view.render()
  return { ...test, view, exit }
}
const edit = (id: string, value: string) => { input(id).value = value; input(id).dispatchEvent(new Event('input', { bubbles: true })) }
describe('刮削页面界面行为', () => {
  it('保留目录、操作记录、设置流程，明确关闭页面不停且没有旧服务入口', async () => {
    const test = await setup()
    expect(document.getElementById('app')!.hidden).toBe(false)
    expect(document.body.textContent).toContain('关闭页面不会停止')
    expect(document.body.textContent).not.toContain('查看旧版记录')
    expect(document.querySelector('form')).toBeNull(); expect(document.querySelector('a[href^="http"]')).toBeNull()
    button('exit').click(); await vi.waitFor(() => expect(test.exit).toHaveBeenCalledOnce())
    expect(test.fake.requests.some(request => request.path === '/owner/stop')).toBe(false)
  })
  it('扫描进度不伪造百分比，完整扫描后显示后端视频计数和当前视频', async () => {
    const test = await setup()
    const scanning = test.fake.add(test.fake.makeRun('scanning', undefined, { scan_complete: false, counts: { total: 602, processed: 0, done: 0, skipped: 0, failed: 0 }, message: '' }))
    await test.page.refresh(false)
    expect(document.getElementById('progress')!.hasAttribute('value')).toBe(false)
    expect(document.getElementById('progress-label')!.textContent).toContain('已发现 602')
    test.fake.runs.set(scanning.id, { ...scanning, state: 'running', scan_complete: true, message: '正在处理 ABC-123 · ABC-123.mp4', counts: { total: 602, processed: 601, done: 2, skipped: 599, failed: 0 } })
    await test.page.refresh(false)
    expect(document.getElementById('done-count')!.textContent).toBe('2'); expect(document.getElementById('total-count')!.textContent).toBe('602')
    expect(document.getElementById('progress-label')!.textContent).toContain('601 / 602')
    expect(document.getElementById('current-file')!.textContent).toContain('ABC-123.mp4')
  })
  it('进度刷新保留当前结果按钮和键盘焦点，不每轮重建全部结果行', async () => {
    const test = await setup({ active: true })
    const open = document.querySelector<HTMLButtonElement>('#results button')!; open.focus()
    await test.page.refresh(false)
    expect(document.querySelector('#results button')).toBe(open); expect(document.activeElement).toBe(open)
  })
  it('回车保存设置但不原生提交，Token 清空后只显示配置状态', async () => {
    const test = await setup(); await test.page.setTab('connection')
    edit('backend-url', 'https://new.invalid/'); edit('backend-token', 'synthetic-private-token')
    input('overwrite-nfo').checked = true; input('overwrite-nfo').dispatchEvent(new Event('change'))
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    input('backend-token').dispatchEvent(enter)
    await vi.waitFor(() => expect(input('backend-token').value).toBe(''))
    expect(enter.defaultPrevented).toBe(true); expect(test.fake.settings.backend_url).toBe('https://new.invalid/')
    expect(test.fake.settings.overwrite_nfo).toBe(true)
    expect(document.getElementById('token-status')!.textContent).toBe('已配置 Token。')
    expect(document.body.innerHTML).not.toContain('synthetic-private-token')
    expect(body(test.fake.requests.find(request => request.path === '/owner/settings')!)).toMatchObject({ token: 'synthetic-private-token' })
  })
  it('保存失败也清空 Token 输入，不把网络失败当作已配置', async () => {
    const test = await setup(); edit('backend-token', 'synthetic-private-token')
    test.fake.override = (request, next) => request.path === '/owner/settings' ? failure('upstream_unavailable', '合成保存失败', 503) : next()
    button('save-settings').click()
    await vi.waitFor(() => expect(test.page.message).toContain('合成保存失败'))
    expect(input('backend-token').value).toBe(''); expect(document.getElementById('token-status')!.textContent).toContain('未配置 Token')
    expect(document.body.innerHTML).not.toContain('synthetic-private-token')
  })
  it('设置冲突保留草稿并禁用保存，显式重新读取后才可再次修改', async () => {
    const test = await setup(); edit('backend-url', 'https://draft.invalid/')
    test.fake.settings = { ...test.fake.settings, revision: 'remote-revision', backend_url: 'https://remote.invalid/', overwrite_poster: true }
    button('save-settings').click()
    await vi.waitFor(() => expect(test.page.settingsStale).toBe(true))
    expect(input('backend-url').value).toBe('https://draft.invalid/'); expect(button('save-settings').disabled).toBe(true)
    expect(document.getElementById('settings-status')!.textContent).toContain('草稿未覆盖对方设置')
    button('reload-settings').click()
    await vi.waitFor(() => expect(input('backend-url').value).toBe('https://remote.invalid/'))
    expect(input('overwrite-poster').checked).toBe(true); expect(button('save-settings').disabled).toBe(false)
    expect(test.fake.requests.filter(request => request.path === '/owner/settings')).toHaveLength(1)
  })
  it('清除 Token 显式发送空字符串，留空则不清除，运行时设置禁用', async () => {
    const test = await setup()
    test.fake.token = 'synthetic-existing'; test.fake.settings.token_configured = true; await test.page.refresh(false)
    button('save-settings').click(); await vi.waitFor(() => expect(test.fake.requests.some(request => request.path === '/owner/settings')).toBe(true)); await vi.waitFor(() => expect(test.page.saving).toBe(false))
    expect(test.fake.token).toBe('synthetic-existing')
    input('clear-token').checked = true; input('clear-token').dispatchEvent(new Event('change'))
    expect(input('backend-token').disabled).toBe(true)
    button('save-settings').click(); await vi.waitFor(() => expect(test.fake.token).toBeNull())
    expect(body(test.fake.requests.filter(request => request.path === '/owner/settings').at(-1)!)).toMatchObject({ token: '' })
    test.fake.add(test.fake.makeRun()); await test.page.refresh(false)
    expect(input('backend-url').disabled).toBe(true); expect(button('save-settings').disabled).toBe(true)
  })
  it('待核实如实显示，不解释成失败或自动重试；手动重试先交给后端核实', async () => {
    const test = await setup(), run = test.fake.makeRun('interrupted', undefined, { counts: { total: 1, processed: 1, done: 0, skipped: 0, failed: 1 } })
    test.fake.add(run, [test.fake.makeItem(run, 0, 'needs_verification', { reason: '本轮提交缺少终态证据', steps: [{ role: 'nfo', state: 'unknown' }] })]); await test.page.refresh(false)
    expect(document.getElementById('results')!.textContent).toContain('待核实')
    expect(document.getElementById('verification-note')!.hidden).toBe(false)
    expect(document.getElementById('verification-note')!.textContent).toContain('不代表写入失败')
    expect(document.getElementById('verification-note')!.textContent).toContain('失败计数包含待核实项')
    expect(test.fake.requests.some(request => request.path === '/owner/runs')).toBe(false)
    button('retry-run').click(); await vi.waitFor(() => expect(test.fake.requests.some(request => request.path === '/owner/runs')).toBe(true))
    expect(body(test.fake.requests.find(request => request.path === '/owner/runs')!)).toMatchObject({ retry_of: run.id })
  })
  it('记录和执行明细只渲染当前页，下一页替换旧行而不是无限追加', async () => {
    const test = await setup(); test.fake.pageSize = 2
    for (let index = 0; index < 7; index++) test.fake.add(test.fake.makeRun('completed'))
    await test.page.setTab('history'); expect(document.querySelectorAll('#history .history-card')).toHaveLength(2)
    button('history-next').click(); await vi.waitFor(() => expect(test.page.historyCursor.page).toBe(2))
    expect(document.querySelectorAll('#history .history-card')).toHaveLength(2)
    const run = test.page.history[0], item = test.fake.items.get(run.id)![0]
    test.fake.details.set(item.id, { item, steps: [], next_step: null, actors: Array.from({ length: 7 }, (_, index) => actor(index)), next_actor: null, attempts: [], next_attempt: null })
    document.querySelector<HTMLButtonElement>('#history button')!.click(); await vi.waitFor(() => expect(test.page.run?.id).toBe(run.id))
    await vi.waitFor(() => expect(document.querySelectorAll('#results .result-row')).toHaveLength(1))
    document.querySelector<HTMLButtonElement>('#results button')!.click(); await vi.waitFor(() => expect(document.querySelectorAll('#detail-actors .detail-row')).toHaveLength(2))
    button('actor-next').click(); await vi.waitFor(() => expect(test.page.detailCursor.actor.page).toBe(2))
    expect(document.querySelectorAll('#detail-actors .detail-row')).toHaveLength(2)
    expect(document.getElementById('detail-actors')!.textContent).toContain('演员2'); expect(document.getElementById('detail-actors')!.textContent).not.toContain('演员0')
  })
  it('结果行显示识别出的版本与分段，普通单个视频不多出一行', async () => {
    const test = await setup(), run = test.fake.makeRun('completed')
    test.fake.add(run, [
      test.fake.makeItem(run, 0, 'done', { files: [{ ...test.fake.video, name: 'ABC-123-A.mp4' }], variant: '第1段' }),
      test.fake.makeItem(run, 1, 'done', { files: [{ ...test.fake.video, name: 'ABC-123-4K-C.mp4' }], variant: '<b>4K 中字</b>' }),
      test.fake.makeItem(run, 2, 'done'),
    ]); await test.page.refresh(false)
    await vi.waitFor(() => expect(document.querySelectorAll('#results .result-row')).toHaveLength(3))
    const labels = [...document.querySelectorAll<HTMLElement>('#results .file-variant')]
    expect(labels.map(label => label.textContent)).toEqual(['ABC-123 · 第1段', 'ABC-123 · <b>4K 中字</b>', ''])
    expect(labels.map(label => label.hidden)).toEqual([false, false, true])
    expect(document.querySelector('#results b')).toBeNull()
  })
  it('文件名、演员姓名和错误原因仅作为文本，不生成 HTML、外站链接或图像请求', async () => {
    const test = await setup(), run = test.fake.makeRun('completed')
    test.fake.add(run, [test.fake.makeItem(run, 0, 'failed', { files: [{ ...test.fake.video, name: '<img src="https://external.invalid/">.mp4' }], reason: '<script>外站代码</script>' })]); await test.page.refresh(false)
    expect(document.getElementById('results')!.textContent).toContain('<img src="https://external.invalid/">.mp4')
    expect(document.getElementById('results')!.textContent).toContain('<script>外站代码</script>')
    expect(document.querySelector('#results img')).toBeNull(); expect(document.querySelector('#results script')).toBeNull()
  })
  it('扫描中断后的空结果明确不会自动续跑', async () => {
    const test = await setup(), run = test.fake.makeRun('interrupted', undefined, { scan_complete: false, message: '后端已中断' })
    test.fake.add(run, []); await test.page.refresh(false)
    expect(document.getElementById('results-empty')!.textContent).toContain('任务不会自动续跑')
    expect(document.getElementById('results-empty')!.textContent).toContain('重试会重新核对目录')
    expect(test.fake.requests.some(request => request.path === '/owner/runs')).toBe(false)
  })
  it('目录选择与授权实际使用 SDK 界面消息，而不是伪造授权或旧设置入口', async () => {
    const test = await setup({ scope: 'none', initialDirectory: false })
    const context: PageContext = { contract: { major: 1, minor: 0 }, app: { id: 'media-scraper', name: '影视刮削', version: '1.0.0', generation: 'g1' }, host_origin: 'https://host.invalid', api_base: '/admin/api/apps/v1/self', backend_base: '/admin/api/apps/v1/self/backend', ui_nonce: 'nonce-test', theme: 'light', launch: { action: 'browse' } }
    const ui = new PageUi(window, context); cleanup(() => ui.dispose())
    const messages: UiMessage[] = []
    vi.spyOn(window, 'postMessage').mockImplementation(value => {
      const message = value as UiMessage; messages.push(message)
      if (message.type !== 'request') return
      const reply = (value: UiValue) => window.dispatchEvent(new MessageEvent('message', { origin: context.host_origin, source: window, data: { type: 'response', channel: message.channel, nonce: message.nonce, id: message.id, result: { status: 'ok', value } } }))
      if (message.request.method === 'ui.pick_directory') queueMicrotask(() => reply({ type: 'directory', directory: test.fake.root }))
      else if (message.request.method === 'ui.request_scope') void test.host.setScope({ mode: 'selected', directories: [{ directory_id: '2', access: 'read_write' }] }).then(scope => reply({ type: 'authorization', scope }))
      else queueMicrotask(() => reply({ type: 'acknowledged' }))
    })
    const page = new ScraperPage(test.host, ui, context); cleanup(() => page.dispose())
    await page.initialize({ observe: false }); await page.choose()
    expect(page.access).toBe('none'); await page.start()
    expect(messages.filter(message => message.type === 'request').map(message => message.type === 'request' ? message.request.method : '')).toContain('ui.pick_directory')
    expect(messages.filter(message => message.type === 'request').map(message => message.type === 'request' ? message.request.method : '')).toContain('ui.request_scope')
    expect(page.activeRun).not.toBeNull()
  })
})
