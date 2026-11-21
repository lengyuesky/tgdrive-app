import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPageApp, encodeJson, HostError, parseJson, readRange, SdkError } from '../src/index.js'
import { byteCount, validNodeId } from '../src/input.js'
import { Gate } from '../src/transport.js'
import { parseSse } from '../src/events.js'
import { LIMITS, SELF_API_BASE, UI_CHANNEL } from '../../contract/types/contract.js'
import type { FileNode, PageBootstrap, UiMessage } from '../../contract/types/contract.js'

const node: FileNode = { id: '2', parent_id: '1', name: '示例.bin', path: '/示例.bin', kind: 'file', size: '10', created_at: 1, modified_at: 1, revision: 'r1', content_version: 'v1', children_revision: null, has_thumbnail: false }
const apps: ReturnType<typeof createPageApp>[] = []
afterEach(() => { for (const app of apps.splice(0)) app.dispose(); vi.useRealTimers() })
function fixture(fetcher: typeof fetch, expiry = Date.now() + 3_600_000) {
  const target = new EventTarget()
  const messages: UiMessage[] = []
  const parent = { postMessage: (message: UiMessage, origin: string) => { expect(origin).toBe('https://example.invalid'); messages.push(message) } }
  const bootstrap: PageBootstrap = { contract: { major: 1, minor: 0 }, app: { id: 'example', name: '示例', version: '1.0.0', generation: 'g1' }, session_token: 'memory-token', expires_at: expiry, host_origin: 'https://example.invalid', api_base: SELF_API_BASE, backend_base: `${SELF_API_BASE}/backend`, ui_nonce: 'nonce1', theme: 'light', launch: { action: 'browse' } }
  const location = { href: `https://example.invalid/page/index.html#tgdrive=${encodeJson(bootstrap)}`, hash: `#tgdrive=${encodeJson(bootstrap)}` }
  const frame = Object.assign(target, { parent, location, history: { state: null, replaceState: (_state: unknown, _title: string, url: string) => { location.href = url; location.hash = '' } }, fetch: fetcher }) as unknown as Window
  const app = createPageApp({ frame, fetch: fetcher }); apps.push(app)
  const response = (id: string, value = { type: 'acknowledged' }) => {
    const event = new Event('message')
    Object.assign(event, { source: parent, origin: bootstrap.host_origin, data: { type: 'response', channel: UI_CHANNEL, nonce: bootstrap.ui_nonce, id, result: { status: 'ok', value } } })
    target.dispatchEvent(event)
  }
  return { app, frame, messages, response, parent, target, bootstrap }
}
function json(value: unknown, status = 200, headers?: HeadersInit) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...Object.fromEntries(new Headers(headers)) } }) }
function hostFailure(code: string, status: number) { return json({ error: { code, message: '请求未能完成', request_id: 'r1', retry_after_ms: 1 } }, status) }
function stream(text: string): ReadableStream<Uint8Array> { return new ReadableStream({ start(output) { output.enqueue(new TextEncoder().encode(text)); output.close() } }) }

describe('页面启动与直接 HTTP', () => {
  it('清掉地址片段，只在内存中用应用 Bearer；不暴露令牌到上下文或自己的后端', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => { expect(init?.credentials).toBe('omit'); expect(init?.redirect).toBe('error'); expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer memory-token'); return json(node) })
    const { app, frame } = fixture(fetcher as typeof fetch)
    expect(frame.location.hash).toBe('')
    expect(Object.hasOwn(app.context, 'session_token')).toBe(false)
    expect(await app.host.stat({ by: 'id', id: '2' })).toEqual(node)
    expect(fetcher.mock.calls[0][0]).toBe(`https://example.invalid${SELF_API_BASE}/files/stat`)
    const response = await app.host.backend('/owner/read', { headers: { Cookie: 'bad', 'X-Tgdrive-Context': 'bad' } })
    await response.body?.cancel()
    expect(new Headers(fetcher.mock.calls[1][1]?.headers).get('Cookie')).toBeNull()
    await expect(app.host.backend('/../../other')).rejects.toThrow('越界')
  })
  it('合并会话续签，先续签后进入请求槽，不因一批请求占满槽而死锁', async () => {
    let refreshes = 0
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith('/session/refresh')) { refreshes++; return json({ session_token: 'memory-token', expires_at: Date.now() + 3_600_000 }) }
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer memory-token')
      return json(node)
    })
    const { app } = fixture(fetcher as typeof fetch, Date.now() + 40_000)
    const results = await Promise.all(Array.from({ length: 40 }, () => app.host.stat({ by: 'id', id: '2' })))
    expect(results).toHaveLength(40); expect(refreshes).toBe(1)
  })
  it('过期会话不续签、不发请求；写失败也不自动重放', async () => {
    const fetcher = vi.fn(async () => hostFailure('rate_limited', 429))
    const { app } = fixture(fetcher as typeof fetch)
    await expect(app.host.kvPut('k', { value: null, condition: { type: 'absent' } })).rejects.toBeInstanceOf(HostError)
    expect(fetcher).toHaveBeenCalledTimes(1)
    const expired = fixture(fetcher as typeof fetch, Date.now() - 1).app
    await expect(expired.host.scope()).rejects.toMatchObject({ code: 'session_expired' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('只读 429 按提示有界重试，未知错误码保留通用分支', async () => {
    const fetcher = vi.fn(async () => fetcher.mock.calls.length < 3 ? hostFailure('rate_limited', 429) : json(node))
    const { app } = fixture(fetcher as typeof fetch)
    expect(await app.host.stat({ by: 'id', id: '2' })).toEqual(node)
    expect(fetcher).toHaveBeenCalledTimes(3)
    const future = fixture(vi.fn(async () => hostFailure('future_error', 409)) as unknown as typeof fetch).app
    await expect(future.host.scope()).rejects.toMatchObject({ code: 'future_error', status: 409 })
  })
})

describe('有界调度与 Range', () => {
  it('队列可取消，满队列拒绝，释放只执行一次', async () => {
    const gate = new Gate(1, 1)
    const signal = new AbortController()
    const release = await gate.acquire(signal.signal)
    const controller = new AbortController()
    const waiting = gate.acquire(controller.signal)
    await expect(gate.acquire(signal.signal)).rejects.toThrow('队列已满')
    controller.abort(new Error('已取消'))
    await expect(waiting).rejects.toThrow('已取消')
    release(); release()
    const next = await gate.acquire(signal.signal); next()
  })
  it('控制请求在响应正文消费前仍占槽，不仅限首响应头', async () => {
    let calls = 0
    const readers: ReadableStreamDefaultController<Uint8Array>[] = []
    const fetcher = vi.fn(async () => { calls++; return new Response(new ReadableStream<Uint8Array>({ start(output) { readers.push(output) } })) })
    const { app } = fixture(fetcher as typeof fetch)
    const pending = Array.from({ length: LIMITS.PAGE_CONTROL_CONCURRENCY + 1 }, () => app.host.stat({ by: 'id', id: '2' }))
    await vi.waitFor(() => expect(calls).toBe(LIMITS.PAGE_CONTROL_CONCURRENCY))
    const finish = (controller: ReadableStreamDefaultController<Uint8Array>) => { controller.enqueue(new TextEncoder().encode(JSON.stringify(node))); controller.close() }
    finish(readers[0])
    await vi.waitFor(() => expect(calls).toBe(LIMITS.PAGE_CONTROL_CONCURRENCY + 1))
    for (const reader of readers.slice(1)) finish(reader)
    await Promise.all(pending)
  })
  it('校验 206 区间、长度及实际正文；200 不当作小 Range', async () => {
    const { app } = fixture(vi.fn(async () => new Response(Uint8Array.of(2, 3, 4), { status: 206, headers: { 'Content-Range': 'bytes 2-4/10', 'Content-Length': '3' } })) as unknown as typeof fetch)
    expect(await app.host.readRange({ id: '2', content_version: 'v1' }, { offset: '2', length: '3' })).toEqual(Uint8Array.of(2, 3, 4))
    const wrong = fixture(vi.fn(async () => new Response(new Uint8Array(10), { status: 200 })) as unknown as typeof fetch).app
    await expect(wrong.host.readRange({ id: '2', content_version: 'v1' }, { offset: '2', length: '3' })).rejects.toThrow('拒绝整文件回退')
    const short = fixture(vi.fn(async () => new Response(Uint8Array.of(2), { status: 206, headers: { 'Content-Range': 'bytes 2-4/10', 'Content-Length': '3' } })) as unknown as typeof fetch).app
    await expect(short.host.readRange({ id: '2', content_version: 'v1' }, { offset: '2', length: '3' })).rejects.toThrow('截断')
    await expect(readRange({ bytes: async () => ({ status: 206, body: stream('x'), headers: new Headers({ 'Content-Length': '1' }) }) }, { id: '2', content_version: 'v1' }, { offset: '2', length: '3' })).rejects.toThrow()
  })
})

describe('界面消息与事件流', () => {
  it('界面通道同时验证父窗口、宿主源和 nonce，支持选择与取消通知', async () => {
    const { app, messages, response, target } = fixture(vi.fn(async () => json(node)) as unknown as typeof fetch)
    const notice = vi.fn(); app.ui.onNotice(notice)
    const title = app.ui.setTitle({ title: '新标题' })
    expect(messages[0]).toMatchObject({ channel: UI_CHANNEL, request: { method: 'ui.set_title' } })
    const bad = new Event('message'); Object.assign(bad, { source: null, origin: 'https://example.invalid', data: { ...messages[0], type: 'response', result: { status: 'ok', value: { type: 'acknowledged' } } } }); target.dispatchEvent(bad)
    response((messages[0] as Extract<UiMessage, { type: 'request' }>).id); await title
    const pick = app.ui.pickDirectory({})
    await expect(app.ui.requestScope({ reason: '选择目录', preferred_access: 'read_only' })).rejects.toThrow('只能打开一个')
    response((messages[1] as Extract<UiMessage, { type: 'request' }>).id, { type: 'directory', directory: null } as never)
    expect(await pick).toBeNull()
  })
  it('SSE 用 Bearer fetch，断线带游标重连，去重但推进未知事件和 sync.required', async () => {
    let connections = 0
    const event = (cursor: string, name: string) => `id: ${cursor}\nevent: host\ndata: ${JSON.stringify({ cursor, occurred_at: 1, event: name, data: { reason: 'initial' } })}\n\n`
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      connections++
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer memory-token')
      if (connections === 2) expect(new Headers(init?.headers).get('Last-Event-ID')).toBe('e1')
      return new Response(stream(connections === 1 ? event('e1', 'sync.required') : event('e1', 'sync.required') + event('e2', 'future.event')), { headers: { 'Content-Type': 'text/event-stream' } })
    })
    const { app } = fixture(fetcher as typeof fetch)
    const names: string[] = []
    for await (const item of app.host.events()) { names.push(item.event); if (names.length === 2) break }
    expect(names).toEqual(['sync.required', 'future.event']); expect(connections).toBe(2)
  })
  it('SSE 跨块 UTF-8 和 CRLF 不丢数据', async () => {
    const text = 'id: e1\r\ndata: {"文字":"示例"}\r\n\r\n'
    const bytes = new TextEncoder().encode(text)
    const body = new ReadableStream<Uint8Array>({ start(output) { for (const byte of bytes) output.enqueue(Uint8Array.of(byte)); output.close() } })
    const frames = []
    for await (const frame of parseSse(body)) frames.push(frame)
    expect(frames).toEqual([{ id: 'e1', data: '{"文字":"示例"}' }])
  })
})

it('大于请求上限的合法分页响应仍能读取，位置数组节点被拒绝', async () => {
  const page = { items: Array.from({ length: 200 }, (_, index) => ({ ...node, id: String(index + 2), path: '/' + 'a'.repeat(500) + '/' + node.name })), next_cursor: null, scan_cursor: 'scan-1', scope_revision: 'scope-1' }
  expect(JSON.stringify(page).length).toBeGreaterThan(LIMITS.MAX_JSON_REQUEST_BYTES)
  const { app } = fixture(vi.fn(async () => json(page)) as unknown as typeof fetch)
  const request = { roots: [], recursive: true, filter: { kind: 'file' as const, extensions: [], include_hidden: false }, sort: 'id' as const, order: 'asc' as const, limit: 200 }
  expect((await app.host.query(request)).items).toHaveLength(200)
  const invalid = fixture(vi.fn(async () => json({ ...page, items: [Object.values(node)] })) as unknown as typeof fetch).app
  await expect(invalid.host.query(request)).rejects.toThrow('类型形状')
})

it('主动关闭用同一令牌发 DELETE，而后端普通错误保留应用协议正文', async () => {
  const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }))
  const { app } = fixture(fetcher as unknown as typeof fetch)
  await app.closeSession()
  expect(fetcher.mock.calls[0][0]).toBe(`https://example.invalid${SELF_API_BASE}/session`)
  expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'DELETE', credentials: 'omit', redirect: 'error' })
  const proxy = fixture(vi.fn(async () => new Response('应用自定义错误', { status: 418 })) as unknown as typeof fetch).app
  const response = await proxy.host.backend('/custom')
  expect(response.status).toBe(418); expect(await response.text()).toBe('应用自定义错误')
})

it('在消费字节流之前取消，也立即释放读取槽', async () => {
  let calls = 0
  const { app } = fixture(vi.fn(async () => { calls++; return new Response(new ReadableStream<Uint8Array>({}), { headers: { 'Content-Length': '10' } }) }) as unknown as typeof fetch)
  const controllers = Array.from({ length: LIMITS.PAGE_BYTE_CONCURRENCY }, () => new AbortController())
  await Promise.all(controllers.map(controller => app.host.bytes({ id: '2', content_version: 'v1' }, { signal: controller.signal })))
  for (const controller of controllers) controller.abort()
  const response = await app.host.bytes({ id: '2', content_version: 'v1' })
  expect(calls).toBe(LIMITS.PAGE_BYTE_CONCURRENCY + 1)
  await response.body?.cancel()
})

it('标识和字节上界使用契约十进制字符串，不经过浮点数', () => {
  expect(validNodeId(LIMITS.MAX_NODE_ID)).toBe(true)
  expect(validNodeId(String(BigInt(LIMITS.MAX_NODE_ID) + 1n))).toBe(false)
  expect(byteCount(LIMITS.MAX_BYTE_COUNT)).toBe(BigInt(LIMITS.MAX_BYTE_COUNT))
  for (const value of ['01', '-1', String(BigInt(LIMITS.MAX_BYTE_COUNT) + 1n)]) expect(() => byteCount(value)).toThrow(SdkError)
})

it('UI 输入按生成常量校验字节长度、进度和不透明标识', async () => {
  const { app, messages, response } = fixture(vi.fn(async () => json(node)) as unknown as typeof fetch)
  await expect(app.ui.setTitle({ title: 'x'.repeat(LIMITS.MAX_UI_TITLE_BYTES + 1) })).rejects.toThrow('契约输入边界')
  await expect(app.ui.setImmersive({ active: true, background: '#fff' })).rejects.toThrow('契约输入边界')
  await expect(app.ui.pickDirectory({ initial_id: String(BigInt(LIMITS.MAX_NODE_ID) + 1n) })).rejects.toThrow('契约输入边界')
  await expect(app.ui.task({ id: 'task', title: '任务', completed: LIMITS.MAX_TASK_PROGRESS + 1, state: 'running', cancellable: false })).rejects.toThrow('契约输入边界')
  expect(messages).toHaveLength(0)
  const title = app.ui.setTitle({ title: 'x'.repeat(LIMITS.MAX_UI_TITLE_BYTES) })
  response((messages[0] as Extract<UiMessage, { type: 'request' }>).id)
  await title
})

it('严格 JSON 拒绝嵌套重复键、安全整数溢出和非对象的协议数据', () => {
  expect(parseJson('{"a":[1,null,"示例"],"__proto__":1}')).toEqual({ a: [1, null, '示例'], ['__proto__']: 1 })
  for (const text of ['{"a":1,"a":2}', '{"a":{"x":1,"x":2}}', '{"n":9007199254740993}', '{"n":1e999}', '{"s":"\\ud800"}', '{"x":1,}', '[1,]']) expect(() => parseJson(text)).toThrow(SdkError)
})
