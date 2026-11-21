import { describe, expect, it, vi } from 'vitest'
import { deferred, fixture, json } from './test-fixture'

describe('授权和命令的观察竞态', () => {
  it('本次主人授权产生的 scope.changed 不误取消刚确认的开始操作', async () => {
    const test = await fixture({ scope: 'none', initialDirectory: false }); await test.page.initialize({ observe: false }); await test.page.choose()
    const scopes = vi.spyOn(test.host, 'scope'), events = test.page.watchEvents()
    await vi.waitFor(() => expect(scopes).toHaveBeenCalled()); await test.page.refresh(true)
    test.ui.requestScope.mockImplementation(async () => {
      const scope = await test.host.setScope({ mode: 'selected', directories: [{ directory_id: '2', access: 'read_write' }] })
      await vi.waitFor(() => expect(test.page.scope?.revision).toBe(scope.revision))
      return scope
    })
    await test.page.start()
    expect(test.page.activeRun).not.toBeNull(); expect(test.fake.requests.filter(request => request.path === '/owner/runs')).toHaveLength(1)
    test.page.dispose(); await events
  })
  it('用户命令取消旧状态读取时，事件循环仍继续观察后来的授权变化', async () => {
    const test = await fixture(); await test.page.initialize({ observe: false })
    const late = deferred<Response>(), old = json(test.fake.status()); let waiting = false
    test.fake.override = (request, next) => { if (request.path === '/owner/status' && !waiting) { waiting = true; return late.promise } return next() }
    const events = test.page.watchEvents()
    await vi.waitFor(() => expect(waiting).toBe(true))
    await test.page.start(); late.resolve(old)
    await test.host.setScope({ mode: 'none' })
    await vi.waitFor(() => expect(test.page.scope?.scope.mode).toBe('none'))
    expect(test.page.directory).toBeNull(); expect(test.page.observationError).toBe('')
    test.page.dispose(); await events
  })
  it('保存设置后迟到旧状态不会覆盖新 revision 或回读旧配置', async () => {
    const test = await fixture(); await test.page.initialize({ observe: false })
    const late = deferred<Response>(), old = json(test.fake.status())
    test.fake.override = (request, next) => request.path === '/owner/status' ? late.promise : next()
    const reading = test.page.refresh(false)
    await vi.waitFor(() => expect(test.fake.requests.filter(request => request.path === '/owner/status')).toHaveLength(2))
    const settings = await test.page.save({ backend_url: 'https://new.invalid/', overwrite_nfo: true, overwrite_poster: false }, null)
    late.resolve(old); await expect(reading).rejects.toMatchObject({ name: 'AbortError' })
    expect(test.page.settings?.revision).toBe(settings?.revision); expect(test.page.settings?.backend_url).toBe('https://new.invalid/')
  })
  it('停止后迟到旧结果页不会把已显示的正在停止回退为刮削中', async () => {
    const test = await fixture({ active: true }); await test.page.initialize({ observe: false })
    const late = deferred<Response>(); let old!: Response
    test.fake.override = (request, next) => request.path === '/owner/items' ? (old = next(), late.promise) : next()
    const reading = test.page.loadItems()
    await vi.waitFor(() => expect(old).toBeDefined()); await test.page.stop()
    late.resolve(old); await expect(reading).rejects.toMatchObject({ name: 'AbortError' })
    expect(test.page.run?.state).toBe('stopping'); expect(test.page.activeRun?.state).toBe('stopping')
  })
})
