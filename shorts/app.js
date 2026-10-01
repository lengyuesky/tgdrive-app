/* 短视频只依赖公开的页面应用 SDK，可单独打包和更新。 */
(() => {
  const drive = window.tgdrive
  const get = (id) => document.getElementById(id)
  const video = get('video'), seek = get('seek')
  const extensions = 'mp4,mov,m4v,mkv,webm,avi,wmv,flv,ts,mts,m2ts,3gp,ogv'
  const lifetime = new AbortController()
  const listen = (target, event, listener, options = {}) => target.addEventListener(event, listener, { ...options, signal: lifetime.signal })
  const mobileQuery = window.matchMedia('(max-width: 767px), (pointer: coarse)')
  let cursor = null, more = false, filling, filesDirty = false
  const recent = new Set(), cursors = new Set(), subscriptions = []
  let queue = [], index = 0, directory = '/', muted = true
  let generation = 0, listGeneration = 0, disposed = false, listController
  let wantsPlay = true, scrubbing = false, resumeAfterSeek = false
  let messageTimer, bufferingTimer, prepared, warmedGeneration = -1
  let wheelAt = -Infinity, wheelTotal = 0, wheelConsumed = false
  let touchStart = null, touchMultiple = false, suppressClickUntil = 0
  const current = () => queue[index]
  const hide = (id, value) => { get(id).hidden = value }
  const report = (error) => {
    if (disposed || error?.name === 'AbortError') return
    get('message').textContent = error instanceof Error ? error.message : String(error)
    hide('message', false)
    clearTimeout(messageTimer)
    messageTimer = setTimeout(() => hide('message', true), 4500)
  }
  const handle = (promise) => Promise.resolve(promise).catch(report)
  const mediaRef = (item) => item.content_version ? { id: item.id, content_version: item.content_version } : item.path
  const itemKey = (item) => `${item.id}:${item.content_version || item.path}`
  async function syncImmersive() {
    const context = await drive.ready
    if (!disposed && context.capabilities?.includes('ui.setImmersive') && typeof drive.ui.setImmersive === 'function') {
      await drive.ui.setImmersive(mobileQuery.matches)
    }
  }
  function shuffled(items) {
    const result = items.slice()
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[result[i], result[j]] = [result[j], result[i]]
    }
    return result
  }
  function sizeText(bytes) {
    if (bytes < 1024) return `${bytes} B`
    const units = ['KiB', 'MiB', 'GiB', 'TiB']
    let value = bytes / 1024, unit = 0
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
    return `${value.toFixed(1)} ${units[unit]}`
  }
  function clock(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '--:--'
    const value = Math.floor(seconds), hours = Math.floor(value / 3600)
    return `${hours ? `${hours}:` : ''}${String(Math.floor(value / 60) % 60).padStart(hours ? 2 : 1, '0')}:${String(value % 60).padStart(2, '0')}`
  }
  function syncProgress() {
    const duration = video.duration, time = video.currentTime || 0
    const ready = video.hasAttribute('src') && Number.isFinite(duration) && duration > 0
    seek.disabled = !ready
    if (!scrubbing) seek.value = String(ready ? Math.min(1000, time / duration * 1000) : 0)
    get('played-progress').style.width = `${Number(seek.value) / 10}%`
    let buffered = 0
    if (ready) for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= time && video.buffered.end(i) >= time) buffered = video.buffered.end(i) / duration * 100
    }
    get('buffered-progress').style.width = `${Math.min(100, buffered)}%`
    get('playback-time').textContent = `${clock(ready ? time : 0)} / ${ready ? clock(duration) : '--:--'}`
    seek.setAttribute('aria-valuetext', ready ? `${clock(time)}，共 ${clock(duration)}` : '正在读取时长')
  }
  function syncPlay() {
    const paused = !wantsPlay || video.paused
    get('play-toggle').setAttribute('aria-label', paused ? '播放视频' : '暂停视频')
    get('play-toggle').firstElementChild.textContent = paused ? '▶' : 'Ⅱ'
  }
  function buffering(value) {
    clearTimeout(bufferingTimer)
    hide('buffering', true)
    // 短暂切换不闪烁转圈提示，只有确实在等待时才显示。
    if (value) bufferingTimer = setTimeout(() => {
      if (!disposed && wantsPlay && !document.hidden && get('play-error').hidden) hide('buffering', false)
    }, 220)
  }
  function stopVideo() {
    generation++
    scrubbing = false; resumeAfterSeek = false
    buffering(false)
    video.pause()
    video.removeAttribute('src'); video.removeAttribute('poster')
    // 立即取消旧视频的 Range 读取，迟到的票据与封面由 generation 拦截。
    video.load()
    seek.value = '0'; seek.disabled = true
    syncProgress()
  }
  function syncFavorite() {
    const favorite = Boolean(current()?.favorite)
    get('favorite').classList.toggle('selected', favorite)
    get('favorite').setAttribute('aria-pressed', String(favorite))
    get('favorite').querySelector('.symbol').textContent = favorite ? '★' : '☆'
    get('favorite').querySelector('.label').textContent = favorite ? '已收藏' : '收藏'
  }
  function syncMute() {
    video.muted = muted
    get('mute').querySelector('.symbol').textContent = muted ? '静' : '声'
    get('mute').querySelector('.label').textContent = muted ? '静音中' : '有声'
    get('mute').setAttribute('aria-pressed', String(!muted))
  }
  function fail(error) {
    wantsPlay = false
    buffering(false)
    hide('play-prompt', true); hide('play-error', false)
    get('play-error-message').textContent = error?.name === 'NotSupportedError' || video.error?.code === 4
      ? '浏览器暂不支持这个视频格式，可以下载后查看或切换下一个。'
      : '视频加载失败，请重试或切换下一个。'
    syncPlay()
  }
  async function attemptPlay(active = generation) {
    if (disposed || active !== generation || !wantsPlay || document.hidden || scrubbing || !video.hasAttribute('src')) return
    try {
      await video.play()
      if (disposed || active !== generation) return
      if (!wantsPlay || document.hidden) video.pause()
    } catch (error) {
      if (disposed || active !== generation || error.name === 'AbortError') return
      buffering(false)
      if (error.name === 'NotAllowedError') hide('play-prompt', false)
      else fail(error)
    }
    syncPlay()
  }
  function warmNext() {
    if (disposed || document.hidden || queue.length < 2 || warmedGeneration === generation) return
    warmedGeneration = generation
    const item = queue[(index + 1) % queue.length]
    // 只预取下一条的短期播放地址，不创建隐藏播放器、不下载下一段视频。
    const next = { key: itemKey(item), at: Date.now(), promise: drive.media.url(mediaRef(item)) }
    prepared = next
    next.promise.catch(() => { if (prepared === next) prepared = undefined })
  }
  async function play(fresh = false) {
    stopVideo()
    const active = generation, item = current()
    if (!item || disposed) return
    wantsPlay = true
    hide('player', false); hide('actions', false); hide('video-info', false)
    hide('play-error', true); hide('play-prompt', true)
    buffering(true)
    get('video-name').textContent = item.name
    get('video-name').title = item.path
    get('video-meta').textContent = `${index + 1} / ${queue.length} · ${sizeText(item.size)}${more ? ' · 更多视频待载入' : ''}`
    for (const id of ['previous', 'next', 'skip-error']) get(id).disabled = queue.length < 2 && !more
    recent.delete(itemKey(item)); recent.add(itemKey(item)); if (recent.size > 512) recent.delete(recent.values().next().value)
    if (more && queue.length - index < 6) handle(fillQueue())
    syncFavorite(); syncMute(); syncPlay()
    const cached = !fresh && prepared?.key === itemKey(item) && Date.now() - prepared.at < 30_000 ? prepared.promise : undefined
    prepared = undefined
    // 封面完全独立于视频启动；失败或迟到不能拖住首帧，更不能覆盖已经切换的视频。
    drive.media.url(mediaRef(item), 'thumbnail').then(poster => {
      if (!disposed && active === generation && poster) video.poster = poster
    }).catch(() => {})
    try {
      const url = await (cached || drive.media.url(mediaRef(item)))
      if (disposed || active !== generation) return
      video.src = url
      await attemptPlay(active)
    } catch (error) {
      if (active !== generation || disposed) return
      fail(error)
    }
  }
  async function load() {
    const active = ++listGeneration
    listController?.abort(); listController = new AbortController()
    const signal = AbortSignal.any([lifetime.signal, listController.signal])
    stopVideo(); queue = []; prepared = undefined; cursor = null; more = true; filling = undefined; filesDirty = false; cursors.clear()
    for (const id of ['player', 'actions', 'video-info', 'empty', 'list-error']) hide(id, true)
    hide('loading-list', false)
    try {
      await drive.ready
      if (disposed || active !== listGeneration) return
      const settings = await drive.settings.get()
      if (disposed || active !== listGeneration) return
      directory = settings.source_dir || '/'; muted = settings.muted !== false
      get('source-label').textContent = directory === '/' ? '整库 · 更换' : directory
      get('source-label').title = `取材文件夹：${directory}，点击更换`
      index = 0
      await fillQueue()
      if (disposed || active !== listGeneration) return
      hide('loading-list', true)
      if (queue.length) await play()
      else {
        get('empty-description').textContent = directory === '/' ? '向网盘添加视频，或选择其他取材文件夹。' : `${directory} 及子目录中没有视频。`
        hide('empty', false)
      }
    } catch (error) {
      if (disposed || active !== listGeneration || error.name === 'AbortError') return
      hide('loading-list', true)
      get('list-error-message').textContent = error.message
      hide('list-error', false)
    }
  }
  async function fillQueue() {
    if (disposed || !more) return
    if (filling) return filling
    const active = listGeneration, signal = AbortSignal.any([lifetime.signal, listController.signal])
    const task = (async () => {
      const params = { under: directory, kind: 'file', extensions: extensions.split(','), limit: 200, cursor }
      const paged = typeof drive.files.searchPage === 'function'
      const result = await (paged ? drive.files.searchPage(params, { signal }) : drive.files.search({ ...params, extensions, limit: 2000 }, { signal }))
      if (disposed || active !== listGeneration) return
      if (result.has_more && (!result.next_cursor || cursors.has(result.next_cursor))) throw new Error('视频列表已变化，请重新加载')
      more = paged && result.has_more === true; cursor = result.next_cursor || null
      if (cursor) { cursors.add(cursor); if (cursors.size > 64) cursors.delete(cursors.values().next().value) }
      const known = new Set(queue.map(itemKey)), fresh = shuffled(result.results).filter(item => !known.has(itemKey(item)))
      // 新内容排在近期看过的内容之前；旧队列最多保留 100 条用于回看。
      queue.push(...fresh.filter(item => !recent.has(itemKey(item))), ...fresh.filter(item => recent.has(itemKey(item))))
      if (index > 100) { queue.splice(0, index - 100); index = 100 }
      for (const id of ['previous', 'next', 'skip-error']) get(id).disabled = queue.length < 2 && !more
    })()
    filling = task
    try { await task } finally { if (filling === task) filling = undefined }
  }
  async function go(delta) {
    if (disposed) return
    if (filesDirty) { await load(); return }
    if (delta > 0 && index === queue.length - 1 && more) {
      const active = listGeneration
      await fillQueue()
      if (disposed || active !== listGeneration) return
    }
    if (queue.length < 2) return
    index = (index + delta + queue.length) % queue.length
    await play()
  }
  async function togglePlay() {
    if (disposed || !video.hasAttribute('src')) return
    if (!get('play-error').hidden) { await play(true); return }
    wantsPlay = video.paused
    if (wantsPlay) { hide('play-prompt', true); await attemptPlay() }
    else { video.pause(); buffering(false); hide('play-prompt', false) }
    syncPlay()
  }
  async function toggleMute() {
    if (disposed || get('mute').disabled) return
    get('mute').disabled = true
    const old = muted
    muted = !muted; syncMute()
    try { await drive.settings.patch({ muted }) }
    catch (error) { if (!disposed) { muted = old; syncMute(); report(error) } }
    finally { if (!disposed) get('mute').disabled = false }
  }
  async function favorite() {
    const item = current()
    if (disposed || !item || get('favorite').disabled) return
    get('favorite').disabled = true
    try {
      item.favorite = (await drive.favorites.set(item.path, !item.favorite)).favorite
      if (!disposed) syncFavorite()
    } catch (error) { report(error) }
    finally { if (!disposed) get('favorite').disabled = false }
  }
  function beginSeek() {
    if (seek.disabled || scrubbing) return
    resumeAfterSeek = wantsPlay && !video.paused; scrubbing = true
    video.pause(); buffering(false)
  }
  function finishSeek() {
    if (!scrubbing) return
    scrubbing = false
    if (resumeAfterSeek) handle(attemptPlay())
    resumeAfterSeek = false; syncProgress(); syncPlay()
  }
  function dispose() {
    if (disposed) return
    disposed = true; listGeneration++; prepared = undefined
    listController?.abort(); lifetime.abort(); unsubscribe(); subscriptions.forEach(off => off())
    clearTimeout(messageTimer); stopVideo()
  }
  async function close() { dispose(); await drive.ui.close() }
  listen(get('exit'), 'click', () => handle(close()))
  listen(get('favorite'), 'click', () => handle(favorite()))
  listen(get('mute'), 'click', () => handle(toggleMute()))
  listen(get('download'), 'click', () => { if (current()) handle(drive.ui.download(current().path)) })
  listen(get('shuffle'), 'click', () => {
    if (queue.length < 2) return
    const previous = current()
    queue = shuffled(queue)
    if (queue[0] === previous) [queue[0], queue[1]] = [queue[1], queue[0]]
    index = 0; handle(play())
  })
  listen(get('previous'), 'click', () => handle(go(-1)))
  listen(get('next'), 'click', () => handle(go(1)))
  listen(get('skip-error'), 'click', () => handle(go(1)))
  listen(get('retry-video'), 'click', () => handle(play(true)))
  for (const id of ['open-settings', 'source-label']) listen(get(id), 'click', () => handle(drive.settings.open()))
  listen(get('retry-list'), 'click', () => handle(load()))
  for (const id of ['play-prompt', 'play-toggle']) listen(get(id), 'click', () => handle(togglePlay()))
  listen(video, 'click', () => { if (performance.now() >= suppressClickUntil) handle(togglePlay()) })
  listen(video, 'playing', () => {
    if (!wantsPlay || document.hidden || scrubbing) { video.pause(); return }
    buffering(false); hide('play-prompt', true); hide('play-error', true)
    syncPlay(); syncProgress(); warmNext()
  })
  listen(video, 'pause', syncPlay)
  listen(video, 'waiting', () => { if (video.hasAttribute('src') && wantsPlay && !scrubbing) buffering(true) })
  listen(video, 'error', () => { if (video.hasAttribute('src') && video.error) fail(video.error) })
  for (const event of ['loadedmetadata', 'durationchange', 'timeupdate', 'progress']) listen(video, event, syncProgress)
  listen(seek, 'pointerdown', beginSeek)
  listen(seek, 'input', () => {
    if (seek.disabled || !Number.isFinite(video.duration)) return
    video.currentTime = Number(seek.value) / 1000 * video.duration
    syncProgress()
  })
  listen(seek, 'change', finishSeek)
  listen(window, 'pointerup', finishSeek)
  listen(window, 'pointercancel', finishSeek)
  listen(get('player'), 'wheel', event => {
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX) || event.ctrlKey) return
    event.preventDefault()
    const now = performance.now()
    if (now - wheelAt > 180) { wheelTotal = 0; wheelConsumed = false }
    wheelAt = now
    if (wheelConsumed) return
    wheelTotal += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1)
    if (Math.abs(wheelTotal) < 48) return
    wheelConsumed = true; handle(go(wheelTotal > 0 ? 1 : -1))
  }, { passive: false })
  listen(get('player'), 'touchstart', event => {
    if (event.target.closest('button, input, select')) { touchStart = null; return }
    if (event.touches.length !== 1) { touchMultiple = true; return }
    touchMultiple = false
    touchStart = { x: event.touches[0].clientX, y: event.touches[0].clientY }
  }, { passive: true })
  listen(get('player'), 'touchmove', event => { if (event.touches.length > 1) touchMultiple = true }, { passive: true })
  listen(get('player'), 'touchcancel', () => { touchStart = null; touchMultiple = false }, { passive: true })
  listen(get('player'), 'touchend', event => {
    if (event.touches.length) return
    const end = event.changedTouches[0]
    if (touchStart && end && !touchMultiple) {
      const dy = end.clientY - touchStart.y, dx = end.clientX - touchStart.x
      if (Math.abs(dy) > 60 && Math.abs(dy) > Math.abs(dx) * 1.4) { suppressClickUntil = performance.now() + 400; handle(go(dy < 0 ? 1 : -1)) }
    }
    touchStart = null
  }, { passive: true })
  listen(document, 'keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); handle(close()); return }
    if (event.target.closest('button,input,textarea,select,a,[contenteditable="true"]') || event.altKey || event.ctrlKey || event.metaKey) return
    if (['ArrowDown', 'PageDown', 'ArrowUp', 'PageUp'].includes(event.key)) {
      event.preventDefault(); if (!event.repeat) handle(go(['ArrowDown', 'PageDown'].includes(event.key) ? 1 : -1))
    } else if (event.key === ' ') { event.preventDefault(); if (!event.repeat) handle(togglePlay()) }
    else if (event.key.toLowerCase() === 'm' && !event.repeat) handle(toggleMute())
    else if (['ArrowLeft', 'ArrowRight'].includes(event.key) && !seek.disabled) {
      event.preventDefault(); video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + (event.key === 'ArrowRight' ? 5 : -5))); syncProgress()
    }
  })
  const unsubscribe = drive.on('settings.changed', settings => {
    if ((settings.source_dir || '/') !== directory) handle(load())
    else { muted = settings.muted !== false; syncMute() }
  })
  subscriptions.push(drive.on('files.changed', value => {
    const paths = value?.paths
    if (!Array.isArray(paths) || paths.some(path => directory === '/' || path === directory || path.startsWith(directory + '/') || directory.startsWith(path === '/' ? '/' : path + '/'))) filesDirty = true
  }))
  subscriptions.push(drive.on('sync.hint', () => { filesDirty = true }))
  subscriptions.push(drive.on('scope.changed', () => handle(load())))
  listen(window, 'pagehide', dispose)
  listen(mobileQuery, 'change', () => handle(syncImmersive()))
  listen(document, 'visibilitychange', () => {
    if (document.hidden) { finishSeek(); video.pause(); buffering(false) }
    else if (wantsPlay) handle(attemptPlay())
    syncPlay()
  })
  handle(syncImmersive()); handle(load())
})()
