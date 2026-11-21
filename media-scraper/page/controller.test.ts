import { describe, expect, it, vi } from 'vitest'
import { ScraperPage } from './controller'
import { body, cleanup, deferred, failure, fixture, json } from './test-fixture'

const initialize = async (test: Awaited<ReturnType<typeof fixture>>) => test.page.initialize({ observe: false })
describe('后台任务的页面观察与用户命令', () => {
  it('打开只读取状态与授权，带入上次目录但绝不自动创建任务', async () => {
    const test = await fixture(); await initialize(test)
    expect(test.page.directory?.id).toBe('2'); expect(test.page.ready).toBe(true)
    expect(test.fake.requests.map(request => request.path)).toEqual(['/owner/status'])
    expect(test.ui.task).not.toHaveBeenCalled()
  })
  it('关闭页面不停止正在运行的任务，重新打开接上同一任务并可停止', async () => {
    const first = await fixture({ active: true }); await initialize(first)
    const id = first.page.activeRun!.id; first.page.dispose()
    expect(first.fake.activeId).toBe(id); expect(first.fake.requests.some(request => request.path === '/owner/stop')).toBe(false)
    const second = await fixture(); second.fake.override = request => first.fake.handle(request)
    await initialize(second)
    expect(second.page.activeRun?.id).toBe(id); expect(second.page.run?.id).toBe(id)
    await second.page.stop()
    expect(second.page.run?.state).toBe('stopping')
    expect(first.fake.requests.filter(request => request.path === '/owner/runs')).toHaveLength(0)
    expect(first.fake.requests.filter(request => request.path === '/owner/stop')).toHaveLength(1)
  })
  it('启动只有一次后端命令，同一时间不能重复开始或修改设置', async () => {
    const test = await fixture(); await initialize(test)
    await test.page.start(); await test.page.start()
    expect(test.page.activeRun?.state).toBe('scanning')
    expect(test.fake.requests.filter(request => request.path === '/owner/runs')).toHaveLength(1)
    await test.page.save({ backend_url: 'https://new.invalid/', overwrite_nfo: true, overwrite_poster: true }, null)
    expect(test.fake.requests.filter(request => request.path === '/owner/settings')).toHaveLength(0)
    expect(test.ui.task).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'running', cancellable: true }), expect.anything())
  })
  it('开始请求尚未返回时停止，先取得任务身份再停止，不创建第二个任务', async () => {
    const test = await fixture(); await initialize(test)
    const response = deferred<Response>(); let accepted!: Response
    test.fake.override = (request, next) => request.path === '/owner/runs' ? (accepted = next(), response.promise) : next()
    const starting = test.page.start()
    await vi.waitFor(() => expect(test.page.starting).toBe(true))
    const stopping = test.page.stop()
    expect(test.fake.requests.some(request => request.path === '/owner/stop')).toBe(false)
    response.resolve(accepted); await Promise.all([starting, stopping])
    expect(test.fake.requests.filter(request => request.path === '/owner/runs')).toHaveLength(1)
    expect(test.fake.requests.filter(request => request.path === '/owner/stop')).toHaveLength(1)
    expect(test.page.activeRun?.state).toBe('stopping')
  })
  it('开始命令已被接收但关页面时，只退出观察，迟到创建结果不触发停止', async () => {
    const test = await fixture(); await initialize(test)
    const response = deferred<Response>(); let accepted!: Response
    test.fake.override = (request, next) => request.path === '/owner/runs' ? (accepted = next(), response.promise) : next()
    const starting = test.page.start()
    await vi.waitFor(() => expect(test.fake.activeId).not.toBeNull())
    test.page.dispose(); const before = test.changed.mock.calls.length
    response.resolve(accepted); await starting
    expect(test.fake.activeId).not.toBeNull(); expect(test.fake.requests.some(request => request.path === '/owner/stop')).toBe(false)
    expect(test.changed).toHaveBeenCalledTimes(before)
  })
  it('创建结果丢失后重新读状态，不换请求标识重复启动', async () => {
    const test = await fixture(); await initialize(test)
    test.fake.override = (request, next) => { if (request.path === '/owner/runs') { next(); throw new Error('合成创建响应丢失') } return next() }
    await expect(test.page.start()).rejects.toThrow('合成创建响应丢失')
    expect(test.page.activeRun?.id).toBe(test.fake.activeId)
    expect(test.fake.requests.filter(request => request.path === '/owner/runs')).toHaveLength(1)
    expect(test.fake.requests.filter(request => request.path === '/owner/status')).toHaveLength(2)
  })
  it('并发停止合并为一次用户命令，停止失败不伪装为已停止', async () => {
    const test = await fixture({ active: true }); await initialize(test)
    const response = deferred<Response>()
    test.fake.override = (request, next) => request.path === '/owner/stop' ? response.promise : next()
    const one = test.page.stop(), two = test.page.stop()
    await vi.waitFor(() => expect(test.fake.requests.filter(request => request.path === '/owner/stop')).toHaveLength(1))
    response.resolve(failure('backend_unavailable', '停止响应未确认', 503))
    await expect(one).rejects.toThrow('停止响应未确认'); await expect(two).rejects.toThrow('停止响应未确认')
    expect(test.page.activeRun?.state).toBe('running'); expect(test.page.message).not.toContain('任务已停止')
  })
  it('停止前发出的迟到状态不能把正在停止回退成运行中', async () => {
    const test = await fixture({ active: true }); await initialize(test)
    const response = deferred<Response>(), snapshot = json(test.fake.status())
    test.fake.override = (request, next) => request.path === '/owner/status' ? response.promise : next()
    const reading = test.page.refresh(false)
    await vi.waitFor(() => expect(test.fake.requests.filter(request => request.path === '/owner/status')).toHaveLength(2))
    await test.page.stop(); response.resolve(snapshot)
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' })
    expect(test.page.activeRun?.state).toBe('stopping')
  })
  it('任务运行时有界轮询，任务结束后停止轮询，不让空闲页面永久唤醒后端', async () => {
    const test = await fixture({ active: true }); await initialize(test)
    vi.useFakeTimers(); await test.page.refresh(false)
    const before = test.fake.requests.length
    await vi.advanceTimersByTimeAsync(1500)
    await vi.waitFor(() => expect(test.fake.requests.length).toBeGreaterThan(before))
    // 先等正在轮询的旧快照应用完，下一次刷新才读取后端刚结束的状态。
    await test.page.refresh(false)
    const current = test.fake.runs.get(test.fake.activeId!)!
    test.fake.runs.set(current.id, { ...current, state: 'completed', message: '刮削已完成', counts: { total: 1, processed: 1, done: 1, failed: 0, skipped: 0 } }); test.fake.activeId = null
    await test.page.refresh(false); expect(test.page.activeRun).toBeNull()
    const count = test.fake.requests.length; await vi.advanceTimersByTimeAsync(10000)
    expect(test.fake.requests).toHaveLength(count)
    expect(test.ui.task).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'completed', completed: 1, total: 1, cancellable: false }), expect.anything())
  })
  it('观察失败只给提示，不停止后端；下一次读取能重新看到进度', async () => {
    const test = await fixture({ active: true }); await initialize(test)
    test.fake.override = (request, next) => request.path === '/owner/status' ? failure('backend_unavailable', '合成离线', 503) : next()
    await expect(test.page.refresh(false)).rejects.toThrow('合成离线')
    expect(test.page.activeRun?.state).toBe('running'); expect(test.fake.requests.some(request => request.path === '/owner/stop')).toBe(false)
    test.fake.override = null; await test.page.refresh(false)
    expect(test.page.observationError).toBe('')
  })
  it('宿主任务取消只停止匹配的当前任务，迟到旧任务取消不影响新任务', async () => {
    const test = await fixture({ active: true }); await initialize(test)
    await test.notify({ event: 'ui.task_cancel', data: { task_id: 'old-task' } })
    expect(test.fake.requests.some(request => request.path === '/owner/stop')).toBe(false)
    await test.notify({ event: 'ui.task_cancel', data: { task_id: test.page.activeRun!.id } })
    await vi.waitFor(() => expect(test.page.activeRun?.state).toBe('stopping'))
    expect(test.fake.requests.filter(request => request.path === '/owner/stop')).toHaveLength(1)
  })
  it('中断不会自动续跑，手动重试携带原任务身份，核实由后端完成', async () => {
    const test = await fixture(), run = test.fake.add(test.fake.makeRun('interrupted', undefined, { counts: { total: 1, processed: 1, done: 0, skipped: 0, failed: 1 } }))
    test.fake.items.set(run.id, [test.fake.makeItem(run, 0, 'needs_verification')]); await initialize(test)
    expect(test.page.canRetry).toBe(true); expect(test.fake.requests.some(request => request.path === '/owner/runs')).toBe(false)
    await test.page.start(test.page.run)
    const requests = test.fake.requests.filter(request => request.path === '/owner/runs')
    expect(requests).toHaveLength(1); expect(body(requests[0])).toMatchObject({ retry_of: run.id, directory_id: '2' })
    expect(Object.keys(body(requests[0])).sort()).toEqual(['directory_id', 'request_id', 'retry_of'])
  })
  it('设置 CAS 冲突后不自动换 revision 重放，明确要求重新读取', async () => {
    const test = await fixture(); await initialize(test)
    test.fake.settings = { ...test.fake.settings, revision: 'remote-settings', backend_url: 'https://remote.invalid/' }
    await expect(test.page.save({ backend_url: 'https://draft.invalid/', overwrite_nfo: true, overwrite_poster: true }, null)).rejects.toMatchObject({ code: 'storage_conflict' })
    expect(test.page.settingsStale).toBe(true)
    expect(test.fake.requests.filter(request => request.path === '/owner/settings')).toHaveLength(1)
    await test.page.reloadSettings(); expect(test.page.settings?.backend_url).toBe('https://remote.invalid/'); expect(test.page.settingsStale).toBe(false)
  })
  it('业务持久数据从不写页面存储或宿主 KV，也不由页面操作文件', async () => {
    const test = await fixture(); await initialize(test)
    const methods = ['kvPut', 'kvDelete', 'mutate', 'createUpload', 'uploadBody'] as const
    const spies = methods.map(method => vi.spyOn(test.host, method))
    const storage = vi.spyOn(localStorage, 'setItem')
    await test.page.save({ backend_url: 'https://metatube.invalid/', overwrite_nfo: true, overwrite_poster: false }, 'synthetic-token')
    await test.page.start(); await test.page.stop()
    for (const spy of spies) expect(spy).not.toHaveBeenCalled(); expect(storage).not.toHaveBeenCalled()
  })
})

describe('目录选择、授权与取消边界', () => {
  it('目录选择使用节点 ID，选择不等于授权，开始另经主人确认读写范围', async () => {
    const test = await fixture({ scope: 'none', initialDirectory: false }); await initialize(test)
    await test.page.choose()
    expect(test.ui.pickDirectory).toHaveBeenCalledWith({ initial_id: null }, expect.anything())
    expect(test.page.directory?.id).toBe('2'); expect(test.page.access).toBe('none'); expect(test.ui.requestScope).not.toHaveBeenCalled()
    test.ui.requestScope.mockImplementation(() => test.host.setScope({ mode: 'selected', directories: [{ directory_id: '2', access: 'read_write' }] }))
    await test.page.start()
    expect(test.ui.requestScope).toHaveBeenCalledWith(expect.objectContaining({ preferred_access: 'read_write' }), expect.anything())
    expect(test.page.activeRun).not.toBeNull()
  })
  it('主人取消授权或只读授权时绝不创建刮削任务', async () => {
    const test = await fixture({ scope: 'read_only' }); await initialize(test)
    await test.page.start()
    expect(test.ui.requestScope).toHaveBeenCalledOnce(); expect(test.fake.requests.some(request => request.path === '/owner/runs')).toBe(false)
    test.ui.requestScope.mockImplementation(() => test.host.scope())
    await expect(test.page.start()).rejects.toThrow('尚未获得读写授权')
    expect(test.fake.requests.some(request => request.path === '/owner/runs')).toBe(false)
  })
  it('取消目录选择保留原目录，准备期间停止后迟到选择不能重新带入或启动', async () => {
    const test = await fixture(); await initialize(test)
    test.ui.pickDirectory.mockResolvedValueOnce(null); await test.page.choose(); expect(test.page.directory?.id).toBe('2')
    const response = deferred<ReturnType<typeof test.fake.makeRun>['root'] | null>(); test.ui.pickDirectory.mockImplementation(() => response.promise)
    const choosing = test.page.choose(); await test.page.stop(); response.resolve(await test.host.stat({ by: 'id', id: '4' }))
    await expect(choosing).rejects.toMatchObject({ name: 'AbortError' })
    expect(test.page.directory?.id).toBe('2'); expect(test.page.preparing).toBe(false)
    expect(test.fake.requests.some(request => request.path === '/owner/runs')).toBe(false)
  })
  it('准备开始期间目录移动时阻止创建，原任务重试也不能静默换范围', async () => {
    const test = await fixture(); await initialize(test)
    await test.host.changeNode({ id: '2', name: '已移动' })
    await expect(test.page.start()).rejects.toThrow('身份或位置已变化')
    expect(test.fake.requests.some(request => request.path === '/owner/runs')).toBe(false)
  })
  it('宿主授权事件重读真实范围，取消在途选择，迟到旧节点不会恢复已撤销授权', async () => {
    const test = await fixture(); await initialize(test)
    const scopes = vi.spyOn(test.host, 'scope'), events = test.page.watchEvents(); cleanup(() => { void events })
    await vi.waitFor(() => expect(scopes).toHaveBeenCalled())
    await test.page.refresh(true)
    const late = deferred<typeof test.fake.root>(), stat = vi.spyOn(test.host, 'stat')
    stat.mockImplementationOnce(() => late.promise)
    const choosing = test.page.choose()
    await vi.waitFor(() => expect(stat).toHaveBeenCalledOnce())
    await test.host.setScope({ mode: 'none' })
    await vi.waitFor(() => expect(test.page.scope?.scope.mode).toBe('none'))
    late.resolve(test.fake.root); await expect(choosing).rejects.toMatchObject({ name: 'AbortError' })
    expect(test.page.directory).toBeNull(); expect(test.fake.requests.some(request => request.path === '/owner/runs')).toBe(false)
    test.page.dispose(); await events
  })
  it('重开时已被撤销的上次目录不自动当作有效选择', async () => {
    const test = await fixture({ scope: 'none' }); await initialize(test)
    expect(test.page.directory).toBeNull(); expect(test.page.access).toBe('none')
  })
  it('从网盘打开的目录优先于保存目录，但仍只观察，不自动执行', async () => {
    const test = await fixture(), other = await test.host.stat({ by: 'id', id: '4' })
    const page = new ScraperPage(test.host, test.ui, { launch: { action: 'open', file: other } }); cleanup(() => page.dispose())
    await page.initialize({ observe: false })
    expect(page.directory?.id).toBe('4'); expect(test.fake.requests.some(request => request.path === '/owner/runs')).toBe(false)
  })
})
