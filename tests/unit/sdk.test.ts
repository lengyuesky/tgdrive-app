import { runInNewContext } from 'node:vm'
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Drive } from '../../sdk/types'
import source from '../../sdk/tgdrive-sdk.js?raw'
type Listener = (event: any) => void
function events() {
  const listeners = new Map<string, Set<Listener>>()
  return {
    addEventListener: (name: string, listener: Listener) => {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name)!.add(listener)
    },
    removeEventListener: (name: string, listener: Listener) => { listeners.get(name)?.delete(listener) },
    emit: (name: string, value?: unknown) => { for (const listener of [...listeners.get(name) ?? []]) listener(value) },
    listeners,
  }
}
function boot(visibility: DocumentVisibilityState = 'visible') {
  const parent = { postMessage: vi.fn() }
  const window = { ...events(), parent, tgdrive: undefined as Drive | undefined }
  const document = { ...events(), visibilityState: visibility }
  const frames = new Map<number, FrameRequestCallback>()
  let sequence = 0
  const random = vi.fn(() => 0)
  const math = Object.create(Math); math.random = random
  runInNewContext(source, {
    Math: math,
    window, document, setInterval, clearInterval, setTimeout, clearTimeout, DOMException, AbortController, crypto: webcrypto,
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  })
  const port = { start: vi.fn(), close: vi.fn(), postMessage: vi.fn(), onmessage: undefined as ((event: { data: unknown }) => void) | undefined }
  const context = { id: 'books', name: '图书', version: '1.0.0', api_version: 2, dark: false }
  return {
    drive: window.tgdrive!, window, document, frames, port, context, random,
    connect: () => window.emit('message', { source: parent, data: { channel: 'tgdrive-app-v1', type: 'connect', context }, ports: [port] }),
    draw: () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback(0)) },
  }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('页面 SDK 的可交互就绪时序', () => {
  it('文件定位只发送稳定引用，迁移成功后才提交数据版本', async () => {
    const app = boot('hidden')
    Object.assign(app.context, { capabilities: ['app.lifecycle', 'ui.showFile'] })
    app.connect(); await app.drive.ready
    const locating = app.drive.ui.showFile!({ id: 42, content_version: 'v1', path: '/不应传递' } as any)
    await Promise.resolve()
    expect(app.port.postMessage).toHaveBeenLastCalledWith({ type: 'request', id: 1, method: 'ui.showFile', params: { id: 42, content_version: 'v1' } })
    app.port.onmessage!({ data: { type: 'response', id: 1, result: null } }); await locating
    const work = vi.fn().mockResolvedValue(undefined)
    const migration = app.drive.lifecycle!.migrate(1, work)
    await vi.advanceTimersByTimeAsync(0)
    const begin = app.port.postMessage.mock.calls.at(-1)![0]
    expect(begin.params).toMatchObject({ action: 'begin', version: 1 })
    expect(work).not.toHaveBeenCalled()
    app.port.onmessage!({ data: { type: 'response', id: begin.id, result: { needed: true } } })
    await vi.advanceTimersByTimeAsync(0)
    expect(work).toHaveBeenCalledOnce()
    const complete = app.port.postMessage.mock.calls.at(-1)![0]
    expect(complete.params).toMatchObject({ action: 'complete', version: 1, owner: begin.params.owner })
    app.port.onmessage!({ data: { type: 'response', id: complete.id, result: {} } })
    await migration
    app.window.emit('pagehide')
  })

  it('已完成的数据版本不重复执行迁移', async () => {
    const app = boot('hidden'); Object.assign(app.context, { capabilities: ['app.lifecycle'] }); app.connect(); await app.drive.ready
    const work = vi.fn(), promise = app.drive.lifecycle!.migrate(1, work)
    await vi.advanceTimersByTimeAsync(0)
    const begin = app.port.postMessage.mock.calls.at(-1)![0]
    app.port.onmessage!({ data: { type: 'response', id: begin.id, result: { needed: false } } })
    await promise; expect(work).not.toHaveBeenCalled(); app.window.emit('pagehide')
  })
  it('媒体地址兼容路径与稳定引用，不把引用对象塞入路径', async () => {
    const app = boot('hidden'); app.connect(); await app.drive.ready
    const legacy = app.drive.media.url('/电影.mp4', 'thumbnail')
    await Promise.resolve()
    expect(app.port.postMessage).toHaveBeenLastCalledWith({ type: 'request', id: 1, method: 'media.url', params: { path: '/电影.mp4', kind: 'thumbnail' } })
    app.port.onmessage!({ data: { type: 'response', id: 1, result: { url: '/api/apps/media/old' } } })
    await expect(legacy).resolves.toBe('/api/apps/media/old')
    const stable = app.drive.media.url({ id: 42, content_version: 'a'.repeat(64) })
    await Promise.resolve()
    expect(app.port.postMessage).toHaveBeenLastCalledWith({ type: 'request', id: 2, method: 'media.url', params: { id: 42, content_version: 'a'.repeat(64), kind: 'preview' } })
    app.port.onmessage!({ data: { type: 'response', id: 2, result: { url: '/api/apps/media/new' } } })
    await expect(stable).resolves.toBe('/api/apps/media/new')
    app.window.emit('pagehide')
  })
  it('就绪上下文可声明沉浸能力，请求仍只通过消息通道发送布尔参数', async () => {
    const app = boot('hidden')
    Object.assign(app.context, { capabilities: ['ui.setImmersive'] })
    app.connect()
    expect((await app.drive.ready).capabilities).toEqual(['ui.setImmersive'])
    const request = app.drive.ui.setImmersive(true)
    await Promise.resolve()
    expect(app.port.postMessage).toHaveBeenCalledWith({ type: 'request', id: 1, method: 'ui.setImmersive', params: { active: true } })
    app.port.onmessage!({ data: { type: 'response', id: 1, result: null } })
    await request
    app.window.emit('pagehide')
  })

  it('沉浸可选背景通过同一消息通道传递，不转发额外选项', async () => {
    const app = boot('hidden'); app.connect(); await app.drive.ready
    const request = app.drive.ui.setImmersive(true, { background: '#f4ebd6' })
    await Promise.resolve()
    expect(app.port.postMessage).toHaveBeenCalledWith({ type: 'request', id: 1, method: 'ui.setImmersive', params: { active: true, background: '#f4ebd6' } })
    app.port.onmessage!({ data: { type: 'response', id: 1, result: null } })
    await request; app.window.emit('pagehide')
  })

  it('收到通道后先绘制沙箱自身，再允许应用展示可交互内容', async () => {
    const app = boot(), ready = vi.fn()
    const waiting = app.drive.ready.then(ready)
    app.connect()
    expect(app.port.start).toHaveBeenCalledOnce()
    await Promise.resolve()
    expect(ready).not.toHaveBeenCalled()
    app.draw()
    await Promise.resolve()
    expect(ready).not.toHaveBeenCalled()
    app.draw()
    await waiting
    expect(ready).toHaveBeenCalledWith(app.context)
    expect(Object.isFrozen(app.context)).toBe(true)
    expect(app.frames.size).toBe(0)
    app.window.emit('pagehide')
  })

  it('后台页面不依赖动画帧即可完成握手', async () => {
    const app = boot('hidden')
    app.connect()
    await expect(app.drive.ready).resolves.toEqual(app.context)
    expect(app.frames.size).toBe(0)
    app.window.emit('pagehide')
  })

  it('绘制等待中转入后台会释放回调而不阻塞 SDK', async () => {
    const app = boot()
    app.connect(); app.draw()
    app.document.visibilityState = 'hidden'
    app.document.emit('visibilitychange')
    await expect(app.drive.ready).resolves.toEqual(app.context)
    expect(app.frames.size).toBe(0)
    expect(app.document.listeners.get('visibilitychange')?.size).toBe(0)
    app.window.emit('pagehide')
  })

  it('首次绘制前关闭页面会拒绝就绪并关闭通道', async () => {
    const app = boot()
    app.connect(); app.draw()
    app.window.emit('pagehide')
    await expect(app.drive.ready).rejects.toThrow('应用已经关闭')
    expect(app.frames.size).toBe(0)
    expect(app.port.close).toHaveBeenCalledOnce()
  })

  it('新的就绪等待不改变请求取消协议', async () => {
    const app = boot()
    app.connect(); app.draw(); app.draw()
    await app.drive.ready
    const controller = new AbortController()
    const request = app.drive.files.stat({ id: 2 }, { signal: controller.signal })
    await Promise.resolve()
    expect(app.port.postMessage).toHaveBeenCalledWith({ type: 'request', id: 1, method: 'files.stat', params: { id: 2 } })
    controller.abort()
    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    expect(app.port.postMessage).toHaveBeenLastCalledWith({ type: 'cancel', id: 1 })
    app.window.emit('pagehide')
  })
})

describe('SDK v2 新增能力', () => {
  it('能力探测按宿主声明返回，未声明的能力为 false', async () => {
    const app = boot('hidden')
    Object.assign(app.context, { capabilities: ['media.bytes', 'files.readRanges'] })
    app.connect(); await app.drive.ready
    expect(app.drive.can('media.bytes')).toBe(true)
    expect(app.drive.can('files.readRanges')).toBe(true)
    expect(app.drive.can('storage.events')).toBe(false)
    app.window.emit('pagehide')
  })
  it('批量段读一次请求带回所有分块', async () => {
    const app = boot('hidden'); app.connect(); await app.drive.ready
    const ref = { id: 3, content_version: 'a'.repeat(64) }
    const ranges = [{ offset: 0, length: 4 }, { offset: 9, length: 2 }]
    const request = app.drive.files.readRanges(ref, ranges)
    await Promise.resolve()
    expect(app.port.postMessage).toHaveBeenCalledWith({ type: 'request', id: 1, method: 'files.readRanges', params: { ref, ranges } })
    app.port.onmessage!({ data: { type: 'response', id: 1, result: [new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6])] } })
    const blocks = await request
    expect(blocks.map((part) => [...part])).toEqual([[1, 2, 3, 4], [5, 6]])
    app.window.emit('pagehide')
  })
  it('批量调用一次请求携带全部能力，逐项还原为结果或带码的错误', async () => {
    const app = boot('hidden'); app.connect(); await app.drive.ready
    const calls = [{ method: 'files.stat', params: { id: 1 } }, { method: 'app.ping' }, { method: 'files.stat', params: { id: 2 } }]
    const request = app.drive.batch(calls)
    await Promise.resolve()
    expect(app.port.postMessage).toHaveBeenCalledWith({ type: 'request', id: 1, method: 'rpc.batch', params: { calls } })
    app.port.onmessage!({ data: { type: 'response', id: 1, result: { results: [
      { result: { id: 1, path: '/a' } }, { result: null }, { error: '路径不存在', code: null, status: 404 },
    ] } } })
    const results = await request
    expect(results[0]).toEqual({ result: { id: 1, path: '/a' } })
    expect(results[1]).toEqual({ result: null })
    // SDK 在独立作用域运行，Error 构造器不同域，只核对形状。
    expect(results[2]!.error).toMatchObject({ message: '路径不存在', status: 404 })
    expect(results[2]!.result).toBeUndefined()
    app.window.emit('pagehide')
  })
  it('media.bytes 返回完整票据（含过期时间），media.url 保持只返回地址', async () => {
    const app = boot('hidden'); app.connect(); await app.drive.ready
    const ref = { id: 4, content_version: 'b'.repeat(64) }
    const grant = app.drive.media.bytes(ref)
    await Promise.resolve()
    expect(app.port.postMessage).toHaveBeenLastCalledWith({ type: 'request', id: 1, method: 'media.url', params: { id: 4, content_version: 'b'.repeat(64), kind: 'bytes' } })
    app.port.onmessage!({ data: { type: 'response', id: 1, result: { url: '/api/apps/media/grant', expires_at: 123 } } })
    await expect(grant).resolves.toEqual({ url: '/api/apps/media/grant', expires_at: 123 })
    const legacy = app.drive.media.url(ref)
    await Promise.resolve()
    app.port.onmessage!({ data: { type: 'response', id: 2, result: { url: '/api/apps/media/legacy', expires_at: 123 } } })
    await expect(legacy).resolves.toBe('/api/apps/media/legacy')
    app.window.emit('pagehide')
  })

  it('covers 能力按键批量读取、写入可选附加信息并返回命中列表', async () => {
    const app = boot('hidden'); app.connect(); await app.drive.ready
    const read = app.drive.covers.get(['unit:1', 'unit:2'])
    await Promise.resolve()
    expect(app.port.postMessage).toHaveBeenLastCalledWith({ type: 'request', id: 1, method: 'covers.get', params: { keys: ['unit:1', 'unit:2'] } })
    app.port.onmessage!({ data: { type: 'response', id: 1, result: { covers: [{ key: 'unit:1', data: 'data:image/webp;base64,AA==', meta: { h: 'x' }, updated_at: 1 }] } } })
    await expect(read).resolves.toEqual([{ key: 'unit:1', data: 'data:image/webp;base64,AA==', meta: { h: 'x' }, updated_at: 1 }])
    const plain = app.drive.covers.put('unit:1', 'data:image/webp;base64,AA==')
    await Promise.resolve()
    expect(app.port.postMessage).toHaveBeenLastCalledWith({ type: 'request', id: 2, method: 'covers.put', params: { key: 'unit:1', data: 'data:image/webp;base64,AA==' } })
    app.port.onmessage!({ data: { type: 'response', id: 2, result: { ok: true, bytes: 1, evicted: 0 } } })
    await plain
    const withMeta = app.drive.covers.put('unit:2', 'data:image/jpeg;base64,AA==', { h: 'y' })
    await Promise.resolve()
    expect(app.port.postMessage).toHaveBeenLastCalledWith({ type: 'request', id: 3, method: 'covers.put', params: { key: 'unit:2', data: 'data:image/jpeg;base64,AA==', meta: { h: 'y' } } })
    app.port.onmessage!({ data: { type: 'response', id: 3, result: { ok: true, bytes: 1, evicted: 0 } } })
    await withMeta
    const stats = app.drive.covers.stats()
    await Promise.resolve()
    expect(app.port.postMessage).toHaveBeenLastCalledWith({ type: 'request', id: 4, method: 'covers.stats', params: {} })
    app.port.onmessage!({ data: { type: 'response', id: 4, result: { entries: 2, bytes: 2, limit_bytes: 9, limit_entries: 9 } } })
    await expect(stats).resolves.toMatchObject({ entries: 2 })
    app.window.emit('pagehide')
  })

  it('storage.wroteRecently 标记本页写入，供事件回声抑制', async () => {
    const app = boot('hidden'); app.connect(); await app.drive.ready
    const write = app.drive.storage.set('progress:1', { page: 2 })
    await Promise.resolve()
    app.port.onmessage!({ data: { type: 'response', id: 1, result: { key: 'progress:1', value: { page: 2 }, revision: 'r1', updated_at: 1 } } })
    await write
    expect(app.drive.storage.wroteRecently('progress:1')).toBe(true)
    expect(app.drive.storage.wroteRecently('progress:2')).toBe(false)
    // 窗口可自定义：零窗口立即过期，长窗口仍算近期。
    expect(app.drive.storage.wroteRecently('progress:1', 0)).toBe(false)
    expect(app.drive.storage.wroteRecently('progress:1', 60_000)).toBe(true)
    // 失败的写入不标记（409 冲突等）。
    const failed = app.drive.storage.set('progress:3', {})
    await Promise.resolve()
    app.port.onmessage!({ data: { type: 'response', id: 2, error: '冲突', code: 'storage_conflict' } })
    await expect(failed).rejects.toThrow('冲突')
    expect(app.drive.storage.wroteRecently('progress:3')).toBe(false)
    app.window.emit('pagehide')
  })
})

describe('只读请求的有界优先级调度', () => {
  it('最多四个前台读取，释放槽位后按序发送；写入和关闭不排队', async () => {
    const app = boot('hidden'); app.connect(); await app.drive.ready
    const reads = Array.from({ length: 6 }, (_, id) => app.drive.files.stat({ id }).catch(error => error))
    await vi.advanceTimersByTimeAsync(0)
    expect(app.port.postMessage.mock.calls.map(([message]) => message.params.id)).toEqual([0, 1, 2, 3])
    const write = app.drive.storage.set('progress', 1).catch(error => error)
    const close = app.drive.ui.close().catch(error => error)
    await vi.advanceTimersByTimeAsync(0)
    expect(app.port.postMessage.mock.calls.slice(-2).map(([message]) => message.method)).toEqual(['storage.set', 'ui.close'])
    app.port.onmessage!({ data: { type: 'response', id: 1, result: { id: 0 } } })
    await vi.advanceTimersByTimeAsync(0)
    expect(app.port.postMessage.mock.calls.at(-1)![0].params.id).toBe(4)
    app.window.emit('pagehide')
    await Promise.all([...reads, write, close])
  })

  it('后台最多占两槽，前台优先且后台不会永久饥饿', async () => {
    const app = boot('hidden'); app.connect(); await app.drive.ready
    const results = Array.from({ length: 3 }, (_, id) => app.drive.media.url(`/预取${id}`, 'preview', { priority: 'background' }).catch(error => error))
    await vi.advanceTimersByTimeAsync(0)
    expect(app.port.postMessage).toHaveBeenCalledTimes(2)
    results.push(...Array.from({ length: 14 }, (_, id) => app.drive.files.stat({ id }).catch(error => error)))
    await vi.advanceTimersByTimeAsync(0)
    expect(app.port.postMessage.mock.calls.map(([message]) => message.method)).toEqual(['media.url', 'media.url', 'files.stat', 'files.stat'])
    // 留一个后台任务在途，另一个槽位应先让给前台。
    app.port.onmessage!({ data: { type: 'response', id: 1, result: { url: '/ok' } } })
    await vi.advanceTimersByTimeAsync(0)
    expect(app.port.postMessage.mock.calls.at(-1)![0].method).toBe('files.stat')
    for (let id = 3; id <= 8; id++) {
      app.port.onmessage!({ data: { type: 'response', id, result: {} } })
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(app.port.postMessage.mock.calls.at(-1)![0]).toMatchObject({ method: 'media.url', params: { path: '/预取2' } })
    app.window.emit('pagehide'); await Promise.all(results)
  })

  it('取消排队请求不发送请求或取消帧，关闭页面拒绝所有等待者', async () => {
    const app = boot('hidden'); app.connect(); await app.drive.ready
    const reads = Array.from({ length: 4 }, (_, id) => app.drive.files.stat({ id }).catch(error => error))
    const controller = new AbortController()
    const cancelled = app.drive.files.stat({ id: 99 }, { signal: controller.signal }).catch(error => error)
    const queued = app.drive.files.stat({ id: 100 }).catch(error => error)
    await vi.advanceTimersByTimeAsync(0); controller.abort()
    expect(await cancelled).toMatchObject({ name: 'AbortError' })
    expect(app.port.postMessage).toHaveBeenCalledTimes(4)
    app.window.emit('pagehide')
    expect((await queued).message).toContain('关闭')
    expect((await Promise.all(reads)).every(error => error.message.includes('关闭'))).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(app.port.postMessage).toHaveBeenCalledTimes(4)
  })

  it('队列容量和排队时间有界；已取消的信号不进入队列', async () => {
    const app = boot('hidden'); app.connect(); await app.drive.ready
    const reads = Array.from({ length: 132 }, (_, id) => app.drive.files.stat({ id }).catch(error => error))
    const overflow = app.drive.files.stat({ id: 999 }).catch(error => error)
    const controller = new AbortController(); controller.abort()
    const cancelled = app.drive.files.stat({ id: 1000 }, { signal: controller.signal }).catch(error => error)
    await vi.advanceTimersByTimeAsync(0)
    expect(await overflow).toMatchObject({ code: 'sdk_queue_full' })
    expect(await cancelled).toMatchObject({ name: 'AbortError' })
    expect(app.port.postMessage).toHaveBeenCalledTimes(4)
    app.window.emit('pagehide'); await Promise.all(reads)

    const waiting = boot('hidden'); waiting.connect(); await waiting.drive.ready
    const background = Array.from({ length: 3 }, (_, id) => waiting.drive.covers.get([String(id)]).catch(error => error))
    await vi.advanceTimersByTimeAsync(0)
    // 两个后台槽位持续占用；按时补入新任务，不让其他任务自身超时释放槽位。
    await vi.advanceTimersByTimeAsync(10_000)
    const expired = waiting.drive.covers.get(['expired']).catch(error => error)
    const foreground = Array.from({ length: 6 }, (_, id) => waiting.drive.files.stat({ id }).catch(error => error))
    await vi.advanceTimersByTimeAsync(10_000)
    waiting.port.onmessage!({ data: { type: 'response', id: 1, result: { covers: [] } } })
    waiting.port.onmessage!({ data: { type: 'response', id: 2, result: { covers: [] } } })
    await vi.advanceTimersByTimeAsync(10_000)
    // 第三项封面此时已经排队 30 秒，前台优先期间没有被发送。
    expect((await background[2]).message).toContain('排队超时')
    expect(waiting.port.postMessage.mock.calls.some(([message]) => message.params.keys?.[0] === '2')).toBe(false)
    waiting.window.emit('pagehide'); await Promise.all([...background, ...foreground, expired])
  })

  it('发送失败与在途取消均释放槽位', async () => {
    const app = boot('hidden'); app.connect(); await app.drive.ready
    app.port.postMessage.mockImplementationOnce(() => { throw new Error('通道失败') })
    const failed = app.drive.files.stat({ id: 0 }).catch(error => error)
    const controller = new AbortController()
    const cancelled = app.drive.files.stat({ id: 1 }, { signal: controller.signal }).catch(error => error)
    const reads = Array.from({ length: 4 }, (_, id) => app.drive.files.stat({ id: id + 2 }).catch(error => error))
    await vi.advanceTimersByTimeAsync(0)
    expect((await failed).message).toBe('通道失败')
    expect(app.port.postMessage.mock.calls.filter(([message]) => message.type === 'request')).toHaveLength(5)
    controller.abort(); await vi.advanceTimersByTimeAsync(0)
    expect(await cancelled).toMatchObject({ name: 'AbortError' })
    expect(app.port.postMessage.mock.calls.at(-1)![0]).toMatchObject({ method: 'files.stat', params: { id: 5 } })
    app.window.emit('pagehide'); await Promise.all(reads)
  })
})

describe('只读请求限流恢复', () => {
  it('抖动遵守原等待下限且退避期间释放槽位', async () => {
    const app = boot('hidden'); app.random.mockReturnValue(0.8); app.connect(); await app.drive.ready
    const reads = Array.from({ length: 5 }, (_, id) => app.drive.files.stat({ id }).catch(error => error))
    await vi.advanceTimersByTimeAsync(0)
    app.port.onmessage!({ data: { type: 'response', id: 1, error: '限流', code: 'rate_limited' } })
    await vi.advanceTimersByTimeAsync(299)
    expect(app.port.postMessage.mock.calls.at(-1)![0]).toMatchObject({ params: { id: 4 } })
    app.port.onmessage!({ data: { type: 'response', id: 2, result: {} } })
    await vi.advanceTimersByTimeAsync(1)
    expect(app.port.postMessage.mock.calls.at(-1)![0]).toMatchObject({ id: 6, params: { id: 0 } })
    app.window.emit('pagehide'); await Promise.all(reads)
  })

  it('按延迟退避并使用新编号重试，成功后返回真实结果', async () => {
    const app = boot('hidden'); app.connect(); await app.drive.ready
    const request = app.drive.files.stat({ id: 42 })
    await vi.advanceTimersByTimeAsync(0)
    app.port.onmessage!({ data: { type: 'response', id: 1, error: '请求过于频繁', code: 'rate_limited' } })
    await vi.advanceTimersByTimeAsync(249)
    expect(app.port.postMessage).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(app.port.postMessage).toHaveBeenLastCalledWith({ type: 'request', id: 2, method: 'files.stat', params: { id: 42 } })
    app.port.onmessage!({ data: { type: 'response', id: 2, result: { id: 42 } } })
    await expect(request).resolves.toEqual({ id: 42 })
    app.window.emit('pagehide')
  })

  it.each(['取消', '关闭'])('等待退避时%s立即结束，之后不再发送请求', async action => {
    const app = boot('hidden'); app.connect(); await app.drive.ready
    const controller = new AbortController()
    const request = app.drive.files.stat({ id: 42 }, { signal: controller.signal })
    const outcome = request.catch(error => error)
    await vi.advanceTimersByTimeAsync(0)
    app.port.onmessage!({ data: { type: 'response', id: 1, error: '请求过于频繁', code: 'rate_limited' } })
    await vi.advanceTimersByTimeAsync(0)
    if (action === '取消') controller.abort()
    else app.window.emit('pagehide')
    expect((await outcome).message).toContain(action === '取消' ? '取消' : '关闭')
    await vi.advanceTimersByTimeAsync(15000)
    expect(app.port.postMessage).toHaveBeenCalledTimes(1)
    app.window.emit('pagehide')
  })

  it('持续限流最多重试四次，写入限流与权限错误不自动重放', async () => {
    const app = boot('hidden'); app.connect(); await app.drive.ready
    const outcome = app.drive.files.stat({ id: 42 }).catch(error => error)
    await vi.advanceTimersByTimeAsync(0)
    for (const delay of [250, 750, 2000, 7000]) {
      const sent = app.port.postMessage.mock.calls.at(-1)![0]
      app.port.onmessage!({ data: { type: 'response', id: sent.id, error: '限流', code: 'rate_limited' } })
      await vi.advanceTimersByTimeAsync(delay)
    }
    const last = app.port.postMessage.mock.calls.at(-1)![0]
    app.port.onmessage!({ data: { type: 'response', id: last.id, error: '限流', code: 'rate_limited' } })
    expect((await outcome).code).toBe('rate_limited')
    expect(app.port.postMessage).toHaveBeenCalledTimes(5)
    for (const [promise, code] of [
      [app.drive.storage.set('x', 1).catch(error => error), 'rate_limited'],
      [app.drive.files.stat({ id: 1 }).catch(error => error), 'permission_denied'],
    ] as const) {
      await vi.advanceTimersByTimeAsync(0)
      const sent = app.port.postMessage.mock.calls.slice().reverse().find(call => call[0].method === (code === 'rate_limited' ? 'storage.set' : 'files.stat'))![0]
      app.port.onmessage!({ data: { type: 'response', id: sent.id, error: '失败', code } })
      expect((await promise).code).toBe(code)
    }
    await vi.advanceTimersByTimeAsync(15000)
    expect(app.port.postMessage).toHaveBeenCalledTimes(7)
    app.window.emit('pagehide')
  })
})

it.each([false, true])('批量请求仅在全部为只读能力时重试（包含写入：%s）', async writing => {
  const app = boot('hidden'); app.connect(); await app.drive.ready
  const outcome = app.drive.batch!([{ method: writing ? 'storage.set' : 'storage.get', params: { key: 'x' } }]).catch(error => error)
  await vi.advanceTimersByTimeAsync(0)
  app.port.onmessage!({ data: { type: 'response', id: 1, error: '限流', code: 'rate_limited' } })
  await vi.advanceTimersByTimeAsync(250)
  expect(app.port.postMessage).toHaveBeenCalledTimes(writing ? 1 : 2)
  if (!writing) app.port.onmessage!({ data: { type: 'response', id: 2, result: { results: [{ result: 42 }] } } })
  expect(await outcome).toEqual(writing ? expect.objectContaining({ code: 'rate_limited' }) : [{ result: 42 }])
  app.window.emit('pagehide')
})
