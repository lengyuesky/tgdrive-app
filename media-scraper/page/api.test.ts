import { describe, expect, it, vi } from 'vitest'
import { ScraperApi } from './api'
import { actor, body, deferred, failure, fixture, json } from './test-fixture'

async function setup() { const test = await fixture(); return { ...test, api: new ScraperApi(test.host) } }
describe('刮削页面后端协议', () => {
  it('只经自己的后端代理，使用可信主人上下文，不调用旧服务或页面外网', async () => {
    const test = await setup(), fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('页面不能直连外站'))
    const status = await test.api.status()
    expect(status.settings.backend_url).toBe('https://metatube.invalid/')
    const request = test.fake.requests[0]
    expect(request.path).toBe('/owner/status'); expect(request.context).toMatchObject({ app_id: 'media-scraper', caller: 'owner', entry: 'page' })
    expect(new Headers(request.options.headers).get('Authorization')).toBeNull(); expect(fetch).not.toHaveBeenCalled()
  })
  it('Token 写入只在设置请求中，空值保留、空字符串清除，回读只显示配置状态', async () => {
    const test = await setup(), draft = { backend_url: 'https://metatube.invalid/', overwrite_nfo: true, overwrite_poster: false }
    let settings = await test.api.configure(test.fake.settings.revision, draft, 'synthetic-private-token')
    expect(settings.token_configured).toBe(true); expect(JSON.stringify(settings)).not.toContain('synthetic-private-token')
    settings = await test.api.configure(settings.revision, draft, null)
    expect(test.fake.token).toBe('synthetic-private-token')
    settings = await test.api.configure(settings.revision, draft, '')
    expect(settings.token_configured).toBe(false)
    expect(body(test.fake.requests[0])).toMatchObject({ token: 'synthetic-private-token', overwrite_nfo: true })
  })
  it('保留应用开放错误码和 HTTP 状态，未知错误码也有清晰通用提示', async () => {
    const test = await setup()
    test.fake.override = () => failure('future_business_code', '新的业务拒绝原因', 422)
    await expect(test.api.status()).rejects.toMatchObject({ code: 'future_business_code', status: 422, message: '新的业务拒绝原因' })
    test.fake.override = () => json({ information: '未规定格式' }, 503)
    await expect(test.api.status()).rejects.toMatchObject({ code: 'backend_error', status: 503, message: '刮削请求失败（HTTP 503）' })
  })
  it.each(['{"settings":{},"active":null,"latest":null}', '{"active":null,"active":null}', '<html>error</html>', '[1,2]'])('拒绝无效或重复键响应，不把缺失字段当默认状态：%s', async raw => {
    const test = await setup(); test.fake.override = () => new Response(raw)
    await expect(test.api.status()).rejects.toMatchObject({ code: 'invalid_backend_response' })
  })
  it('流式响应超过读取预算时取消流，不无限缓冲应用记录', async () => {
    const test = await setup(), cancel = vi.fn()
    test.fake.override = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024)); controller.enqueue(new Uint8Array(1)) }, cancel }))
    await expect(test.api.status()).rejects.toMatchObject({ code: 'payload_too_large', status: 413 })
    expect(cancel).toHaveBeenCalledOnce()
  })
  it('取消后的迟到响应不进入页面，未读正文被取消', async () => {
    const test = await setup(), response = deferred<Response>(), cancel = vi.fn(), controller = new AbortController()
    test.fake.override = () => response.promise
    const pending = test.api.status(controller.signal)
    await vi.waitFor(() => expect(test.fake.requests).toHaveLength(1))
    controller.abort()
    response.resolve(new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode(JSON.stringify(test.fake.status()))) }, cancel })))
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' }); expect(cancel).toHaveBeenCalledOnce()
  })
  it('后端命令响应丢失时不自动重放，包括 GET 状态也不在协议层重试', async () => {
    const test = await setup(); test.fake.override = () => { throw new Error('合成传输中断') }
    await expect(test.api.start('request-identifier-1', '2', null)).rejects.toThrow('合成传输中断')
    expect(test.fake.requests.filter(request => request.path === '/owner/runs')).toHaveLength(1)
  })
  it('文件步骤、演员和来源错误分别传游标，不把完整明细拉回页面', async () => {
    const test = await setup(), run = test.fake.add(test.fake.makeRun()), item = test.fake.items.get(run.id)![0]
    test.fake.details.set(item.id, { item, steps: [], next_step: null, actors: [actor(0)], next_actor: null, attempts: [], next_attempt: null })
    await test.api.detail(item.id, { step: 11, actor: 4, attempt: 8 })
    expect(body(test.fake.requests[0])).toEqual({ item_id: item.id, after: 11, actor_after: 4, attempt_after: 8, limit: 30 })
  })
})
