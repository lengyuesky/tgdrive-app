/* 页面应用 SDK v2，兼容原握手；凭据只保留在宿主，二进制走票据数据面或消息通道。 */
(() => {
  let port
  let sequence = 0
  const pending = new Map()
  const listeners = new Map()
  const capabilities = new Set()
  const localWrites = new Map()
  const retryWaits = new Set()
  // 只调度只读 RPC；写入、生命周期和界面交互不被媒体读取占住。
  const readQueue = []
  let activeReads = 0, backgroundReads = 0, foregroundStreak = 0
  let closed = false
  const isRead = (method, params) => readMethods.has(method) || method === 'rpc.batch' && Array.isArray(params.calls) && params.calls.every(call => readMethods.has(call?.method))
  function drainReads() {
    while (!closed && activeReads < 4 && readQueue.length) {
      const foreground = readQueue.findIndex(task => !task.background)
      const background = backgroundReads < 2 ? readQueue.findIndex(task => task.background) : -1
      // 每八个前台任务给后台一次机会；后台最多占两槽，保留前台容量。
      const index = background >= 0 && (foreground < 0 || foregroundStreak >= 8) ? background : foreground
      if (index < 0) return
      const [task] = readQueue.splice(index, 1)
      task.cleanup()
      activeReads++
      if (task.background) { backgroundReads++; foregroundStreak = 0 }
      else foregroundStreak = Math.min(8, foregroundStreak + 1)
      task.run().then(task.resolve, task.reject).finally(() => {
        activeReads--
        if (task.background) backgroundReads--
        drainReads()
      })
    }
  }
  function scheduleRead(run, background, signal) {
    signal?.throwIfAborted()
    if (closed) return Promise.reject(new Error('应用已经关闭'))
    if (readQueue.length >= 128) return Promise.reject(Object.assign(new Error('应用读取队列已满，请稍后重试'), { code: 'sdk_queue_full' }))
    return new Promise((resolve, reject) => {
      const cancel = (error) => {
        const index = readQueue.indexOf(task)
        if (index < 0) return
        readQueue.splice(index, 1); task.cleanup(); reject(error)
        drainReads()
      }
      const abort = () => cancel(new DOMException('读取已取消', 'AbortError'))
      const timer = setTimeout(() => cancel(new Error('应用读取排队超时，请重试')), 30_000)
      const task = { run, background, resolve, reject, cancel, cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) } }
      signal?.addEventListener('abort', abort, { once: true })
      readQueue.push(task)
      drainReads()
    })
  }
  const readMethods = new Set(['files.search', 'files.searchPage', 'files.list', 'files.stat', 'files.readRange', 'files.readRanges', 'assets.read', 'storage.get', 'storage.list', 'settings.get', 'media.url', 'covers.get', 'covers.stats'])
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
    const retryable = isRead(method, params)
    const delays = [250, 750, 2000, 7000]
    for (let attempt = 0; ; attempt++) {
      try { return await sendRequest(method, params, options) }
      catch (error) {
        // 只处理宿主明确拒绝的限流；权限、网络错误和写入均交给调用者处理。
        if (!retryable || error?.code !== 'rate_limited' || attempt >= delays.length) throw error
        // 在原等待下限上增加至多 25% 抖动，避免一批请求同步重试。
        await waitForRetry(delays[attempt] * (1 + Math.random() * 0.25), options.signal)
      }
    }
  }
  function waitForRetry(delay, signal) {
    signal?.throwIfAborted()
    if (!port) return Promise.reject(new Error('应用已经关闭'))
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); retryWaits.delete(cancel); signal?.removeEventListener('abort', abort) }
      const cancel = () => { cleanup(); reject(new Error('应用已经关闭')) }
      const abort = () => { cleanup(); reject(new DOMException('读取已取消', 'AbortError')) }
      const timer = setTimeout(() => { cleanup(); resolve() }, delay)
      retryWaits.add(cancel)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }
  async function sendRequest(method, params = {}, options = {}) {
    const signal = options.signal
    signal?.throwIfAborted()
    await ready
    signal?.throwIfAborted()
    if (!port || closed) throw new Error('应用已经关闭')
    if (isRead(method, params)) {
      const background = options.priority === 'background' || options.priority !== 'foreground' && (method.startsWith('covers.') || method === 'media.url' && params.kind === 'thumbnail')
      return scheduleRead(() => transmit(method, params, options), background, signal)
    }
    return transmit(method, params, options)
  }
  function transmit(method, params, options) {
    const signal = options.signal
    const id = ++sequence
    return new Promise((resolve, reject) => {
      const cancel = (error) => {
        const task = pending.get(id)
        if (!task) return
        task.cleanup(); pending.delete(id)
        port?.postMessage({ type: 'cancel', id })
        reject(error)
      }
      if (closed || !port) { reject(new Error('应用已经关闭')); return }
      if (signal?.aborted) { reject(new DOMException('读取已取消', 'AbortError')); return }
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
  async function migrate(version, migration) {
    if (!capabilities.has('app.lifecycle')) { await migration(new AbortController().signal); return }
    const owner = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('')
    const invoke = (action, message = '') => request('app.lifecycle', { action, version, owner, message })
    const lease = await invoke('begin')
    if (!lease.needed) return
    const lifetime = new AbortController()
    let leaseError
    const timer = setInterval(() => { invoke('heartbeat').catch(error => { leaseError = error; lifetime.abort(error) }) }, 20_000)
    try { await migration(lifetime.signal); if (leaseError) throw leaseError; await invoke('complete') }
    catch (error) { await invoke('failed', String(error?.message || error).slice(0, 350)).catch(() => {}); throw error }
    finally { clearInterval(timer) }
  }
  window.tgdrive = Object.freeze({
    ready,
    lifecycle: Object.freeze({ migrate, report: (phase, message = '') => capabilities.has('app.lifecycle') ? request('ui.report', { phase, message: message.slice(0, 350) }) : Promise.resolve() }),
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
      url: async (pathOrRef, kind = 'preview', options) => (await request('media.url', typeof pathOrRef === 'string' ? { path: pathOrRef, kind } : { id: pathOrRef.id, content_version: pathOrRef.content_version, kind }, options)).url,
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
    ui: Object.freeze({
      authorizeDirectory: (initial = '/') => request('ui.authorizeDirectory', { initial }),
      showFile: (ref) => request('ui.showFile', { id: ref.id, content_version: ref.content_version }),
      fileDetails: (ref) => request('ui.fileDetails', { id: ref.id, content_version: ref.content_version }),
      setTitle: (title) => request('ui.setTitle', { title }),
      setExitMessage: (message) => request('ui.setExitMessage', { message }),
      task: (value) => request('ui.task', value),
      pickDirectory: (initial = '/') => request('ui.pickDirectory', { initial }), download: (path) => request('ui.download', { path }), close: () => request('ui.close'), setImmersive: (active, options) => request('ui.setImmersive', options === undefined ? { active } : { active, background: options.background }) }),
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(listener)
      return () => listeners.get(name)?.delete(listener)
    },
  })
  window.addEventListener('pagehide', () => {
    closed = true
    for (const task of [...readQueue]) task.cancel(new Error('应用已经关闭'))
    clearInterval(interval); clearTimeout(deadline); cancelPaint?.()
    window.removeEventListener('message', connect)
    rejectReady(new Error('应用已经关闭'))
    port?.close(); port = undefined
    for (const cancel of retryWaits) cancel()
    for (const task of pending.values()) { task.cleanup(); task.reject(new Error('应用已经关闭')) }
    pending.clear(); listeners.clear()
  })
})()
