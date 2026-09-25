/* 页面应用 SDK v2，兼容原握手；凭据只保留在宿主，二进制走票据数据面或消息通道。 */
(() => {
  let port
  let sequence = 0
  const pending = new Map()
  const listeners = new Map()
  const capabilities = new Set()
  const localWrites = new Map()
  let resolveReady
  let rejectReady
  let cancelPaint
  function whenPainted(callback) {
    let frame
    const cleanup = () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      document.removeEventListener('visibilitychange', visibilityChanged)
      cancelPaint = undefined
    }
    const finish = () => { cleanup(); callback() }
    const visibilityChanged = () => { if (document.visibilityState !== 'visible') finish() }
    cancelPaint = cleanup
    if (document.visibilityState !== 'visible') { finish(); return }
    document.addEventListener('visibilitychange', visibilityChanged)
    // 等待沙箱自身完成首次绘制；宿主已绘制并不代表跨进程子页面已能接收输入。
    frame = requestAnimationFrame(() => { frame = requestAnimationFrame(finish) })
  }
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  ready.catch(() => {})
  const announce = () => window.parent.postMessage({ channel: 'tgdrive-app-v1', type: 'ready' }, '*')
  const interval = setInterval(announce, 400)
  const deadline = setTimeout(() => {
    clearInterval(interval)
    if (!port) rejectReady(new Error('请从 tgdrive 应用中心打开此应用'))
  }, 12_000)
  function connect(event) {
    if (port || event.source !== window.parent || event.data?.channel !== 'tgdrive-app-v1'
      || event.data?.type !== 'connect' || !event.ports[0]) return
    port = event.ports[0]
    clearInterval(interval); clearTimeout(deadline)
    window.removeEventListener('message', connect)
    port.onmessage = ({ data }) => {
      if (data?.type === 'response') {
        const task = pending.get(data.id)
        if (!task) return
        task.cleanup(); pending.delete(data.id)
        if (data.error) task.reject(Object.assign(new Error(data.error), { code: data.code, status: data.status }))
        else task.resolve(data.result)
      } else if (data?.type === 'event') {
        for (const listener of listeners.get(data.name) ?? []) Promise.resolve().then(() => listener(data.value)).catch(() => {})
      } else if (data?.type === 'closing') {
        Promise.allSettled(Array.from(listeners.get('beforeClose') ?? [], (listener) => Promise.resolve().then(listener)))
          .then(() => port?.postMessage({ type: 'closed', id: data.id }))
      }
    }
    port.start()
    const context = Object.freeze(event.data.context)
    for (const item of context?.capabilities ?? []) capabilities.add(item)
    whenPainted(() => { if (port) resolveReady(context) })
  }
  window.addEventListener('message', connect)
  announce()
  async function request(method, params = {}, options = {}) {
    const signal = options.signal
    signal?.throwIfAborted()
    await ready
    signal?.throwIfAborted()
    if (!port) throw new Error('应用已经关闭')
    const id = ++sequence
    return new Promise((resolve, reject) => {
      const cancel = (error) => {
        const task = pending.get(id)
        if (!task) return
        task.cleanup(); pending.delete(id)
        port?.postMessage({ type: 'cancel', id })
        reject(error)
      }
      const abort = () => cancel(new DOMException('读取已取消', 'AbortError'))
      const timeout = setTimeout(() => cancel(new Error('应用请求超时，请重试')), method.startsWith('ui.') ? 300_000 : 30_000)
      const cleanup = () => { clearTimeout(timeout); signal?.removeEventListener('abort', abort) }
      pending.set(id, { resolve, reject, cleanup })
      signal?.addEventListener('abort', abort, { once: true })
      try { port.postMessage({ type: 'request', id, method, params }) }
      catch (error) { cleanup(); pending.delete(id); reject(error) }
    })
  }
  /** 记录本页写入过的键：服务端事件回声与此重叠时可判定为自身写入，不触发重拉。 */
  function noteWrite(key) {
    if (typeof key === 'string' && key) {
      if (localWrites.size >= 128) localWrites.delete(localWrites.keys().next().value)
      localWrites.set(key, Date.now())
    }
  }
  window.tgdrive = Object.freeze({
    ready,
    /** 能力探测：旧宿主不声明新能力，插件据此降级到消息通道读取。 */
    can: (capability) => capabilities.has(capability),
    files: Object.freeze({
      search: (params = {}, options) => request('files.search', params, options),
      list: (params, options) => request('files.list', params, options),
      searchPage: (params = {}, options) => request('files.searchPage', params, options),
      stat: (ref, options) => request('files.stat', ref, options),
      readRange: (ref, offset, length, options) => request('files.readRange', { ref, offset, length }, options),
      readRanges: (ref, ranges, options) => request('files.readRanges', { ref, ranges }, options),
    }),
    assets: Object.freeze({ read: (path, options) => request('assets.read', { path }, options) }),
    storage: Object.freeze({
      get: (key, options) => request('storage.get', { key }, options),
      set: (key, value, expected_revision = null, options) => request('storage.set', { key, value, expected_revision }, options).then((record) => { noteWrite(key); return record }),
      delete: (key, expected_revision, options) => request('storage.delete', { key, expected_revision }, options).then((result) => { noteWrite(key); return result }),
      list: (params = {}, options) => request('storage.list', params, options),
      /** 近期内本页是否写入过该键；用于抑制自身写入经服务端事件回流。 */
      wroteRecently: (key, windowMs = 5000) => { const at = localWrites.get(key); return at !== undefined && Date.now() - at < windowMs },
    }),
    media: Object.freeze({
      url: async (pathOrRef, kind = 'preview') => (await request('media.url', typeof pathOrRef === 'string' ? { path: pathOrRef, kind } : { id: pathOrRef.id, content_version: pathOrRef.content_version, kind })).url,
      /** 获取字节数据面票据；需要宿主声明 media.bytes 能力，凭票据直连 Range 读取。 */
      bytes: (ref, options) => request('media.url', { id: ref.id, content_version: ref.content_version, kind: 'bytes' }, options),
    }),
    /** 批量调用：一次往返执行多项服务端能力，逐项返回 { result } 或 { error }（Error 带 code/status）；需宿主声明 rpc.batch 能力。 */
    batch: (calls, options) => request('rpc.batch', { calls }, options).then((response) => (Array.isArray(response?.results) ? response.results : []).map((item) => (
      item && typeof item === 'object' && typeof item.error === 'string'
        ? { error: Object.assign(new Error(item.error), { code: item.code, status: item.status }) }
        : { result: item && typeof item === 'object' ? item.result : undefined }
    ))),
    /** 封面缓存：生成好的封面小图存进服务器封面库，下次直接取用；需宿主声明 covers 能力。 */
    covers: Object.freeze({
      get: (keys, options) => request('covers.get', { keys }, options).then((response) => (Array.isArray(response?.covers) ? response.covers : [])),
      put: (key, data, meta = null, options) => request('covers.put', meta == null ? { key, data } : { key, data, meta }, options),
      delete: (keys, options) => request('covers.delete', { keys }, options),
      stats: (options) => request('covers.stats', {}, options),
    }),
    favorites: Object.freeze({ set: (path, favorite) => request('favorites.set', { path, favorite }) }),
    settings: Object.freeze({ get: () => request('settings.get'), patch: (values) => request('settings.patch', values), open: () => request('ui.openSettings') }),
    ui: Object.freeze({ pickDirectory: (initial = '/') => request('ui.pickDirectory', { initial }), download: (path) => request('ui.download', { path }), close: () => request('ui.close'), setImmersive: (active, options) => request('ui.setImmersive', options === undefined ? { active } : { active, background: options.background }) }),
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(listener)
      return () => listeners.get(name)?.delete(listener)
    },
  })
  window.addEventListener('pagehide', () => {
    clearInterval(interval); clearTimeout(deadline); cancelPaint?.()
    window.removeEventListener('message', connect)
    rejectReady(new Error('应用已经关闭'))
    port?.close(); port = undefined
    for (const task of pending.values()) { task.cleanup(); task.reject(new Error('应用已经关闭')) }
    pending.clear(); listeners.clear()
  })
})()
