import { describe, expect, it, vi } from 'vitest'
import { DATA_VERSION_KEY, FAVORITES_PREFIX, SETTINGS_KEY } from './state'
import { deferred, fixture, settle } from './test-fixtures'

const other = [{ id: '900', parent_id: '1', name: '其他', kind: 'directory' as const }, { id: '901', parent_id: '900', name: '另一条.mp4', kind: 'file' as const, bytes: [] }]
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)!

describe('应用自己的取材、收藏与界面通道', () => {
  it('取材选择与授权分开，取消选择不保存，保存锚定目录 ID', async () => {
    const x = await fixture({ nodes: other }), before = (await x.host.kvGet(SETTINGS_KEY)).record
    await x.click('source-label'); expect((await x.host.kvGet(SETTINGS_KEY)).record).toEqual(before)
    vi.mocked(x.ui.pickDirectory).mockResolvedValueOnce(await x.native.stat({ by: 'id', id: '900' }))
    await x.click('source-label')
    await vi.waitFor(() => expect(document.getElementById('video-name')?.dataset.fileId).toBe('901')); await x.loaded()
    expect((await x.host.kvGet(SETTINGS_KEY)).record?.value).toMatchObject({ source: { type: 'directory', id: '900', path: '/其他' } })
    expect(x.ui.requestScope).not.toHaveBeenCalled()
  })
  it('读取所选目录被拒绝才请求主人授权，取消授权不回退全盘或覆盖设置', async () => {
    const x = await fixture({ nodes: other })
    const chosen = await x.native.stat({ by: 'id', id: '900' })
    await x.host.setScope({ mode: 'selected', directories: [{ directory_id: '1000000', access: 'read_only' }] })
    vi.mocked(x.ui.pickDirectory).mockResolvedValue(chosen)
    const before = (await x.host.kvGet(SETTINGS_KEY)).record
    await x.click('source-label'); await vi.waitFor(() => expect(x.ui.requestScope).toHaveBeenCalledOnce())
    expect((await x.host.kvGet(SETTINGS_KEY)).record).toEqual(before)
    vi.mocked(x.ui.requestScope).mockImplementationOnce(() => x.host.setScope({ mode: 'selected', directories: [{ directory_id: '1000000', access: 'read_only' }, { directory_id: '900', access: 'read_only' }] }))
    await x.click('source-label'); await vi.waitFor(() => expect(x.video.dataset.fileId).toBe('901'))
    expect(x.ui.requestScope).toHaveBeenLastCalledWith(expect.objectContaining({ preferred_access: 'read_only' }), expect.anything())
  })
  it('没有缩略图附件不签发无用缩略图地址，文件信息来自应用当前节点', async () => {
    const x = await fixture({ thumbnail: false })
    expect(x.urls.mock.calls.some(([request]) => request.representation === 'thumbnail')).toBe(false)
    await x.click('file-info')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('/视频/0.mp4')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('节点：2')
    expect([...document.querySelectorAll('button')].some(node => node.textContent?.includes('在文件中显示'))).toBe(false)
  })
  it('收藏在应用内保存与取消，跨页面重开仍能列出，不调用网盘收藏', async () => {
    const x = await fixture(); await x.click('favorite')
    expect((await x.host.kvGet(FAVORITES_PREFIX + '2')).record?.value).toMatchObject({ id: '2', name: '0.mp4' })
    await x.click('settings'); await vi.waitFor(() => expect(document.getElementById('favorite-items')?.textContent).toContain('0.mp4'))
    button('取消收藏').click(); await vi.waitFor(async () => expect((await x.host.kvGet(FAVORITES_PREFIX + '2')).record).toBeNull())
    expect('favorites' in x.host).toBe(false)
  })
  it('收藏列表每页只驻留 20 行，下一页和上一页使用 KV 游标，不按条数猜结束', async () => {
    const x = await fixture({ initialize: async host => { for (let index = 0; index < 45; index++) { const id = String(index + 100); await host.kvPut(FAVORITES_PREFIX + id, { value: { schemaVersion: 1, id, contentVersion: 'v1', name: `收藏${index}.mp4`, path: `/视频/收藏${index}.mp4`, addedAt: index }, condition: { type: 'absent' } }) } } })
    await x.click('settings'); await vi.waitFor(() => expect(document.querySelectorAll('.favorite-row')).toHaveLength(20))
    button('下一页收藏').click(); await vi.waitFor(() => expect(document.querySelector('.favorite-open')?.textContent).toContain('收藏20.mp4'))
    expect(document.querySelectorAll('.favorite-row')).toHaveLength(20)
    button('下一页收藏').click(); await vi.waitFor(() => expect(document.querySelectorAll('.favorite-row')).toHaveLength(5))
    expect(button('下一页收藏').hidden).toBe(true)
    button('上一页收藏').click(); await vi.waitFor(() => expect(document.querySelectorAll('.favorite-row')).toHaveLength(20))
    expect(x.kvList.mock.calls.every(([request]) => request.limit === 20)).toBe(true)
  })
  it('打开其他取材目录的收藏只建立临时父目录取材，不改持久设置', async () => {
    const x = await fixture({ nodes: other, initialize: async host => { const file = await host.stat({ by: 'id', id: '901' }); await host.kvPut(FAVORITES_PREFIX + file.id, { value: { schemaVersion: 1, id: file.id, contentVersion: file.content_version, name: file.name, path: file.path, addedAt: Date.now() }, condition: { type: 'absent' } }) } })
    const settings = (await x.host.kvGet(SETTINGS_KEY)).record
    await x.click('settings'); await vi.waitFor(() => expect(document.querySelector('.favorite-open')).not.toBeNull())
    document.querySelector<HTMLButtonElement>('.favorite-open')!.click()
    await vi.waitFor(() => expect(x.video.dataset.fileId).toBe('901')); expect((await x.host.kvGet(SETTINGS_KEY)).record).toEqual(settings)
  })
  it('移动取材目录仍跟随 ID，撤权清空媒体而不是继续显示旧播放能力', async () => {
    const x = await fixture(); await x.host.changeNode({ id: '1000000', name: '移动后' })
    await x.emitEvent('files.changed', {})
    await vi.waitFor(() => expect(document.getElementById('source-label')?.textContent).toContain('/移动后'))
    await x.host.setScope({ mode: 'none' }); await x.emitEvent('scope.changed', { revision: 'changed' })
    await vi.waitFor(() => expect(x.video.hasAttribute('src')).toBe(false))
    await vi.waitFor(() => expect(document.getElementById('list-error')?.hidden).toBe(false))
  })
  it('沉浸与主题走界面通道，关闭前等待已经发出的条件设置保存', async () => {
    const x = await fixture(); x.mobile.matches = true; x.mobile.dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect(x.ui.setImmersive).toHaveBeenLastCalledWith({ active: true, background: '#000000' }))
    await x.click('settings'); await x.emitUi({ event: 'ui.theme_changed', data: { theme: 'dark' } })
    expect(document.querySelector('.shorts-dialog')?.getAttribute('data-theme')).toBe('dark')
    document.querySelector<HTMLButtonElement>('[aria-label="关闭面板"]')!.click(); await settle()
    const waiting = deferred(), started = deferred(), write = x.kvPut.getMockImplementation()!
    x.kvPut.mockImplementationOnce(async (...args) => { started.resolve(); await waiting.promise; return write(...args) })
    await x.click('mute', false); await started.promise
    let complete = false
    const closing = x.emitUi({ event: 'ui.before_close', data: { close_id: 'close-1', deadline_ms: 2000 } }).then(() => { complete = true })
    await settle(); expect(complete).toBe(false); waiting.resolve(); await closing
    expect((await x.host.kvGet(SETTINGS_KEY)).record?.value).toMatchObject({ muted: false })
    expect(x.video.hasAttribute('src')).toBe(false)
  })
  it('随机取材任务可取消，迟到响应不显示旧视频，重新加载可恢复', async () => {
    const x = await fixture({ start: false }), started = deferred()
    x.random.mockImplementationOnce(async (_request, options) => { started.resolve(); return new Promise((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true })) })
    const loading = x.start(false); await started.promise
    await x.emitUi({ event: 'ui.task_cancel', data: { task_id: 'shorts-sampling' } }); await loading
    expect(x.video.hasAttribute('src')).toBe(false); expect(document.getElementById('list-error-message')?.textContent).toContain('已取消')
    await x.click('retry-list'); expect(x.video.hasAttribute('src')).toBe(true)
  })
  it('手机纵向手势只切换一次，尾随轻点不暂停，横向、多指与取消手势被忽略', async () => {
    const x = await fixture(), player = document.getElementById('player')!
    const touch = (type: string, touches: { clientX: number; clientY: number }[], changedTouches = touches) => { const event = new Event(type, { bubbles: true }); Object.defineProperties(event, { touches: { value: touches }, changedTouches: { value: changedTouches } }); player.dispatchEvent(event) }
    touch('touchstart', [{ clientX: 100, clientY: 400 }]); touch('touchend', [], [{ clientX: 105, clientY: 100 }])
    await vi.waitFor(() => expect(x.video.dataset.fileId).toBe('3')); await x.loaded(); x.video.click(); await settle(); expect(x.video.paused).toBe(false)
    touch('touchstart', [{ clientX: 100, clientY: 400 }, { clientX: 110, clientY: 400 }]); touch('touchend', [], [{ clientX: 100, clientY: 100 }])
    touch('touchstart', [{ clientX: 100, clientY: 400 }]); touch('touchend', [], [{ clientX: 400, clientY: 390 }])
    touch('touchstart', [{ clientX: 100, clientY: 400 }]); touch('touchcancel', []); touch('touchend', [], [{ clientX: 100, clientY: 100 }])
    await settle(); expect(x.video.dataset.fileId).toBe('3')
  })
  it('未知宿主事件被忽略，键盘快进只调整播放位置不切视频', async () => {
    const x = await fixture(), before = x.random.mock.calls.length
    await x.emitEvent('future.host.event', { unknown: true })
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })); await settle()
    expect(x.video.currentTime).toBe(5); expect(x.video.dataset.fileId).toBe('2'); expect(x.random).toHaveBeenCalledTimes(before)
  })
  it('关闭收藏面板后迟到 stat 不再打开旧收藏，设置冲突不重放覆盖', async () => {
    const x = await fixture({ nodes: other, initialize: async host => { const file = await host.stat({ by: 'id', id: '901' }); await host.kvPut(FAVORITES_PREFIX + file.id, { value: { schemaVersion: 1, id: file.id, contentVersion: file.content_version, name: file.name, path: file.path, addedAt: Date.now() }, condition: { type: 'absent' } }) } })
    await x.click('settings'); await vi.waitFor(() => expect(document.querySelector('.favorite-open')).not.toBeNull())
    const waiting = deferred(), started = deferred(), stat = x.stat.getMockImplementation()!
    x.stat.mockImplementationOnce(async (...args) => { const file = await stat(...args); started.resolve(); await waiting.promise; return file })
    document.querySelector<HTMLButtonElement>('.favorite-open')!.click(); await started.promise
    document.querySelector<HTMLButtonElement>('[aria-label="关闭面板"]')!.click(); waiting.resolve(); await settle()
    expect(x.video.dataset.fileId).toBe('2')
    const before = (await x.host.kvGet(SETTINGS_KEY)).record!
    await x.native.kvPut(SETTINGS_KEY, { value: { schemaVersion: 1, source: { type: 'all' }, muted: true }, condition: { type: 'revision', revision: before.revision } })
    await x.click('mute'); expect(x.video.muted).toBe(true)
    expect((await x.host.kvGet(SETTINGS_KEY)).record?.value).toMatchObject({ source: { type: 'all' }, muted: true })
    expect(document.getElementById('message')?.textContent).toContain('storage_conflict')
  })
  it('未知应用数据版本停止启动，不创建默认设置或读取原文件', async () => {
    const x = await fixture({ start: false, initialize: async host => { await host.kvPut(DATA_VERSION_KEY, { value: 99, condition: { type: 'absent' } }) } })
    await x.start(false)
    expect(document.getElementById('list-error-message')?.textContent).toContain('数据版本未知')
    expect(x.random).not.toHaveBeenCalled(); expect(x.urls).not.toHaveBeenCalled(); expect(x.kvPut).not.toHaveBeenCalled()
  })
})
