import { describe, expect, it, vi } from 'vitest'
import { actor, body, deferred, fixture, json } from './test-fixture'
import type { Detail } from './model'

const initialize = async (test: Awaited<ReturnType<typeof fixture>>) => test.page.initialize({ observe: false })
describe('分页操作记录与迟到读取', () => {
  it('同毫秒创建的记录按完整游标分页，字节短页不会被误认为末页，只保留当前页', async () => {
    const test = await fixture(); test.fake.pageSize = 2
    for (let index = 0; index < 65; index++) test.fake.add(test.fake.makeRun('completed', undefined, { created_at: 42 }))
    await initialize(test); await test.page.loadHistory('reset')
    const found = new Set<string>()
    for (;;) {
      expect(test.page.history.length).toBeLessThanOrEqual(2)
      for (const run of test.page.history) { expect(found.has(run.id)).toBe(false); found.add(run.id) }
      if (test.page.historyCursor.next === null) break
      await test.page.loadHistory('next')
    }
    expect(found.size).toBe(65); expect(test.page.history).toHaveLength(1)
    await test.page.loadHistory('previous'); expect(test.page.historyCursor.page).toBe(32); expect(test.page.history).toHaveLength(2)
    await test.page.loadHistory('reset'); expect(test.page.historyCursor.page).toBe(1)
  })
  it('结果页超过一百项仍能翻到全部项目，计数使用后端的视频数而不是当前页行数', async () => {
    const test = await fixture(); test.fake.pageSize = 2
    const run = test.fake.makeRun('completed', undefined, { counts: { total: 116, processed: 116, done: 116, skipped: 0, failed: 0 } })
    const items = Array.from({ length: 115 }, (_, index) => test.fake.makeItem(run, index, 'done'))
    items[0].files = [test.fake.video, { ...test.fake.video, id: '5', name: 'ABC-123.mkv' }]
    test.fake.add(run, items); await initialize(test)
    const found = new Set<string>()
    for (;;) {
      expect(test.page.items.length).toBeLessThanOrEqual(2)
      for (const item of test.page.items) { expect(found.has(item.id)).toBe(false); found.add(item.id) }
      if (test.page.itemCursor.next === null) break
      await test.page.loadItems('next')
    }
    expect(found.size).toBe(115); expect(test.page.run?.counts.done).toBe(116)
    await test.page.loadItems('previous'); expect(test.page.items).toHaveLength(2)
  })
  it('明细中的步骤、演员和来源错误各自分页，不丢长原因、不把所有页追加到内存', async () => {
    const test = await fixture(); test.fake.pageSize = 2
    const run = test.fake.add(test.fake.makeRun('completed')), item = test.fake.items.get(run.id)![0]
    const detail: Detail = { item, steps: Array.from({ length: 7 }, (_, index) => ({ id: `step-${index}`, role: 'nfo', state: 'done', name: `资料${index}.nfo`, message: '', file: null })), next_step: null, actors: Array.from({ length: 7 }, (_, index) => actor(index)), next_actor: null, attempts: Array.from({ length: 7 }, (_, index) => ({ sequence: index + 1, stage: 'detail', provider: `Provider${index}`, reason: '完整来源失败原因。'.repeat(2000) })), next_attempt: null }
    test.fake.details.set(item.id, detail); await initialize(test); await test.page.openDetail(item.id)
    await test.page.loadDetail(item.id, 'next', 'actor')
    expect(test.page.detail?.actors.map(actor => actor.data.name)).toEqual(['演员2', '演员3'])
    expect(test.page.detail?.steps[0].id).toBe('step-0'); expect(test.page.detail?.attempts[0].sequence).toBe(1)
    const names: Record<string, Set<string | number>> = { step: new Set(), actor: new Set(['演员0', '演员1']), attempt: new Set() }
    for (const part of ['step', 'actor', 'attempt'] as const) {
      for (;;) {
        const current = test.page.detail!
        const rows = part === 'step' ? current.steps.map(step => step.id) : part === 'actor' ? current.actors.map(actor => actor.data.name) : current.attempts.map(attempt => attempt.sequence)
        for (const row of rows) names[part].add(row)
        expect(current.steps.length).toBeLessThanOrEqual(2); expect(current.actors.length).toBeLessThanOrEqual(2); expect(current.attempts.length).toBeLessThanOrEqual(2)
        if (test.page.detailCursor[part].next === null) break
        await test.page.loadDetail(item.id, 'next', part)
      }
    }
    expect(Object.values(names).map(names => names.size)).toEqual([7, 7, 7])
    expect(test.page.detail?.attempts[0].reason).toBe('完整来源失败原因。'.repeat(2000))
    const actorRequest = test.fake.requests.find(request => request.path === '/owner/detail' && body(request).actor_after === 2)!
    expect(body(actorRequest)).toMatchObject({ after: null, attempt_after: null, actor_after: 2 })
  })
  it('打开另一个任务后旧结果迟到不会覆盖新任务或混进新页', async () => {
    const test = await fixture(); await initialize(test)
    const old = test.fake.add(test.fake.makeRun('completed')), current = test.fake.add(test.fake.makeRun('completed'))
    const response = deferred<Response>(); let snapshot!: Response
    test.fake.override = (request, next) => request.path === '/owner/items' && body(request).run_id === old.id ? (snapshot = next(), response.promise) : next()
    const reading = test.page.openRun(old)
    await vi.waitFor(() => expect(snapshot).toBeDefined())
    await test.page.openRun(current); response.resolve(snapshot)
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' })
    expect(test.page.run?.id).toBe(current.id); expect(test.page.items.every(item => item.run_id === current.id)).toBe(true)
  })
  it('刷新记录使旧页失效，取消后的迟到页不重新填回列表', async () => {
    const test = await fixture(); await initialize(test)
    const response = deferred<Response>(); let snapshot!: Response, count = 0
    test.fake.override = (request, next) => request.path === '/owner/history' && count++ === 0 ? (snapshot = next(), response.promise) : next()
    const reading = test.page.loadHistory('reset')
    await vi.waitFor(() => expect(snapshot).toBeDefined())
    const run = test.fake.add(test.fake.makeRun('completed')); await test.page.loadHistory('reset')
    response.resolve(snapshot); await expect(reading).rejects.toMatchObject({ name: 'AbortError' })
    expect(test.page.history.map(run => run.id)).toEqual([run.id])
  })
  it('关闭明细取消读取，迟到演员和步骤不重新打开面板', async () => {
    const test = await fixture({ active: true }); await initialize(test)
    const item = test.page.items[0], response = deferred<Response>(); let snapshot!: Response
    test.fake.override = (request, next) => request.path === '/owner/detail' ? (snapshot = next(), response.promise) : next()
    const reading = test.page.openDetail(item.id)
    await vi.waitFor(() => expect(snapshot).toBeDefined())
    test.page.closeDetail(); response.resolve(snapshot)
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' })
    expect(test.page.detail).toBeNull(); expect(test.page.detailLoading).toBe(false)
  })
  it('结果游标不推进时拒绝换页，当前数据与页码不被失败请求清空', async () => {
    const test = await fixture(); test.fake.pageSize = 1
    const run = test.fake.makeRun('completed'); test.fake.add(run, [test.fake.makeItem(run, 0), test.fake.makeItem(run, 1)])
    await initialize(test); const first = test.page.items[0]
    test.fake.override = (request, next) => request.path === '/owner/items' ? json({ run, items: [first], next_after: 0 }) : next()
    await expect(test.page.loadItems('next')).rejects.toThrow('游标没有推进')
    expect(test.page.items[0].id).toBe(first.id); expect(test.page.itemCursor.page).toBe(1); expect(test.page.itemsLoading).toBe(false)
  })
  it('记录请求失败时保留已有结果，不把读取失败当作旧记录已消失', async () => {
    const test = await fixture(); test.fake.add(test.fake.makeRun('completed')); await initialize(test); await test.page.loadHistory('reset')
    const previous = test.page.history
    test.fake.override = (request, next) => { if (request.path === '/owner/history') throw new Error('合成记录离线'); return next() }
    await expect(test.page.loadHistory('reset')).rejects.toThrow('合成记录离线')
    expect(test.page.history).toBe(previous); expect(test.page.historyLoading).toBe(false)
  })
  it('人物补充不足仍展示后端的成功状态，不由页面重新推断影片失败', async () => {
    const test = await fixture(), run = test.fake.makeRun('completed', undefined, { counts: { total: 1, processed: 1, done: 1, skipped: 0, failed: 0 } })
    test.fake.add(run, [test.fake.makeItem(run, 0, 'done', { actors_summary: '演员头像 1/3，未匹配 1，查询超时 1', reason: '演员头像 1/3，未匹配 1，查询超时 1', steps: [{ role: 'nfo', state: 'done' }, { role: 'poster', state: 'kept' }] })])
    await initialize(test)
    expect(test.page.run?.counts).toMatchObject({ done: 1, failed: 0 })
    expect(test.page.items[0]).toMatchObject({ state: 'done', actors_summary: expect.stringContaining('查询超时 1') })
  })
})
