/* 页面应用 SDK v2，兼容原握手；凭据只保留在宿主，二进制通过消息通道传输。 */
(() => {
  let port
  let sequence = 0
  const pending = new Map()
  const listeners = new Map()
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
  window.tgdrive = Object.freeze({
    ready,
    files: Object.freeze({
      search: (params = {}, options) => request('files.search', params, options),
      list: (params, options) => request('files.list', params, options),
      searchPage: (params = {}, options) => request('files.searchPage', params, options),
      stat: (ref, options) => request('files.stat', ref, options),
      readRange: (ref, offset, length, options) => request('files.readRange', { ref, offset, length }, options),
    }),
    assets: Object.freeze({ read: (path, options) => request('assets.read', { path }, options) }),
    storage: Object.freeze({
      get: (key, options) => request('storage.get', { key }, options),
      set: (key, value, expected_revision = null, options) => request('storage.set', { key, value, expected_revision }, options),
      delete: (key, expected_revision, options) => request('storage.delete', { key, expected_revision }, options),
      list: (params = {}, options) => request('storage.list', params, options),
    }),
    media: Object.freeze({ url: async (pathOrRef, kind = 'preview') => (await request('media.url', typeof pathOrRef === 'string' ? { path: pathOrRef, kind } : { id: pathOrRef.id, content_version: pathOrRef.content_version, kind })).url }),
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
