/* 短视频只依赖公开的页面应用 SDK，可单独打包和更新。 */
(() => {
  const drive = window.tgdrive
  const get = (id) => document.getElementById(id)
  const video = get('video')
  const extensions = 'mp4,mov,m4v,mkv,webm,avi,wmv,flv,ts,mts,m2ts,3gp,ogv'
  let queue = []
  let index = 0
  let directory = '/'
  let muted = true
  let generation = 0
  let listGeneration = 0
  let wheelAt = 0
  let touchStart = null
  let touchMultiple = false
  const mobileQuery = window.matchMedia('(max-width: 767px), (pointer: coarse)')
  async function syncImmersive() {
    await drive.ready
    if (!disposed && typeof drive.ui.setImmersive === 'function') await drive.ui.setImmersive(mobileQuery.matches)
  }
  let messageTimer
  let disposed = false

  const current = () => queue[index]
  const hide = (id, value) => { get(id).hidden = value }
  const report = (error) => {
    if (disposed) return
    get('message').textContent = error instanceof Error ? error.message : String(error)
    hide('message', false)
    clearTimeout(messageTimer)
    messageTimer = setTimeout(() => hide('message', true), 4500)
  }
  const handle = (promise) => Promise.resolve(promise).catch(report)
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
    let value = bytes / 1024
    let unit = 0
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
    return `${value.toFixed(1)} ${units[unit]}`
  }
  function stopVideo() {
    generation++
    video.pause()
    video.removeAttribute('src')
    video.removeAttribute('poster')
    // 清空并重新加载，主动取消在途 Range 请求。
    video.load()
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
  async function play() {
    stopVideo()
    const active = generation
    const item = current()
    if (!item || disposed) return
    hide('player', false)
    hide('actions', false)
    hide('video-info', false)
    hide('buffering', false)
    hide('play-error', true)
    hide('play-prompt', true)
    get('video-name').textContent = item.name
    get('video-name').title = item.path
    get('video-meta').textContent = `${sizeText(item.size)} · ${index + 1} / ${queue.length}${queue.length === 2000 ? '（本次最多载入 2000 条）' : ''}`
    get('previous').disabled = queue.length < 2
    get('next').disabled = queue.length < 2
    syncFavorite()
    syncMute()
    try {
      const [url, poster] = await Promise.all([
        drive.media.url(item.path), drive.media.url(item.path, 'thumbnail').catch(() => ''),
      ])
      if (disposed || active !== generation) return
      if (poster) video.poster = poster
      video.src = url
      try { await video.play() }
      catch (error) {
        if (active !== generation || disposed) return
        if (error.name === 'NotAllowedError') { hide('buffering', true); hide('play-prompt', false) }
      }
    } catch (error) {
      if (active !== generation || disposed) return
      hide('buffering', true)
      hide('play-error', false)
      report(error)
    }
  }
  async function load() {
    const active = ++listGeneration
    stopVideo()
    queue = []
    for (const id of ['player', 'actions', 'video-info', 'empty', 'list-error']) hide(id, true)
    hide('loading-list', false)
    try {
      await drive.ready
      const settings = await drive.settings.get()
      if (disposed || active !== listGeneration) return
      directory = settings.source_dir || '/'
      muted = settings.muted !== false
      get('source-label').textContent = directory === '/' ? '整库' : directory
      get('source-label').title = directory
      const result = await drive.files.search({ under: directory, kind: 'file', extensions, limit: 2000 })
      if (disposed || active !== listGeneration) return
      queue = shuffled(result.results)
      index = 0
      hide('loading-list', true)
      if (queue.length) await play()
      else {
        get('empty-description').textContent = directory === '/' ? '向网盘添加视频，或选择其他取材文件夹。' : `${directory} 及子目录中没有视频。`
        hide('empty', false)
      }
      document.body.focus()
    } catch (error) {
      if (disposed || active !== listGeneration) return
      hide('loading-list', true)
      get('list-error-message').textContent = error.message
      hide('list-error', false)
    }
  }
  function go(delta) {
    if (queue.length < 2) return
    index = (index + delta + queue.length) % queue.length
    handle(play())
  }
  async function togglePlay() {
    if (!video.src) return
    if (video.paused) {
      try { await video.play(); hide('play-prompt', true) } catch (error) { report(error) }
    } else { video.pause(); hide('play-prompt', false) }
  }
  async function toggleMute() {
    if (get('mute').disabled) return
    get('mute').disabled = true
    const old = muted
    muted = !muted
    syncMute()
    try { await drive.settings.patch({ muted }); if (!muted && video.src) await video.play() }
    catch (error) { muted = old; syncMute(); report(error) }
    finally { get('mute').disabled = false }
  }
  async function favorite() {
    const item = current()
    if (!item || get('favorite').disabled) return
    get('favorite').disabled = true
    try {
      item.favorite = (await drive.favorites.set(item.path, !item.favorite)).favorite
      syncFavorite()
    } catch (error) { report(error) }
    finally { get('favorite').disabled = false }
  }
  get('exit').addEventListener('click', () => { stopVideo(); handle(drive.ui.close()) })
  get('favorite').addEventListener('click', () => handle(favorite()))
  get('mute').addEventListener('click', () => handle(toggleMute()))
  get('download').addEventListener('click', () => { if (current()) handle(drive.ui.download(current().path)) })
  get('shuffle').addEventListener('click', () => { if (queue.length) { queue = shuffled(queue); index = 0; handle(play()) } })
  get('previous').addEventListener('click', () => go(-1))
  get('next').addEventListener('click', () => go(1))
  get('skip-error').addEventListener('click', () => go(1))
  get('open-settings').addEventListener('click', () => handle(drive.settings.open()))
  get('retry-list').addEventListener('click', () => handle(load()))
  get('play-prompt').addEventListener('click', () => handle(togglePlay()))
  video.addEventListener('click', () => handle(togglePlay()))
  video.addEventListener('playing', () => { hide('buffering', true); hide('play-prompt', true) })
  video.addEventListener('waiting', () => { if (video.hasAttribute('src')) hide('buffering', false) })
  video.addEventListener('error', () => { if (video.hasAttribute('src')) { hide('buffering', true); hide('play-error', false) } })
  get('player').addEventListener('wheel', (event) => {
    event.preventDefault()
    if (performance.now() - wheelAt < 400 || Math.abs(event.deltaY) < 8) return
    wheelAt = performance.now()
    go(event.deltaY > 0 ? 1 : -1)
  }, { passive: false })
  get('player').addEventListener('touchstart', (event) => {
    if (event.target.closest('button, input, select')) { touchStart = null; return }
    if (event.touches.length !== 1) { touchMultiple = true; return }
    touchMultiple = false
    touchStart = { x: event.touches[0].clientX, y: event.touches[0].clientY }
  }, { passive: true })
  get('player').addEventListener('touchmove', (event) => { if (event.touches.length > 1) touchMultiple = true }, { passive: true })
  get('player').addEventListener('touchcancel', () => { touchStart = null; touchMultiple = false }, { passive: true })
  get('player').addEventListener('touchend', (event) => {
    if (event.touches.length) return
    const end = event.changedTouches[0]
    if (touchStart && end && !touchMultiple) {
      const dy = end.clientY - touchStart.y, dx = end.clientX - touchStart.x
      if (Math.abs(dy) > 60 && Math.abs(dy) > Math.abs(dx) * 1.4) go(dy < 0 ? 1 : -1)
    }
    touchStart = null
  }, { passive: true })
  document.addEventListener('keydown', (event) => {
    if (['INPUT', 'TEXTAREA'].includes(event.target.tagName)) return
    if (['ArrowDown', 'PageDown'].includes(event.key)) { event.preventDefault(); go(1) }
    else if (['ArrowUp', 'PageUp'].includes(event.key)) { event.preventDefault(); go(-1) }
    else if (event.key === ' ') { event.preventDefault(); handle(togglePlay()) }
    else if (event.key.toLowerCase() === 'm') handle(toggleMute())
    else if (event.key === 'Escape') handle(drive.ui.close())
  })
  drive.on('settings.changed', (settings) => {
    if ((settings.source_dir || '/') !== directory) handle(load())
    else { muted = settings.muted !== false; syncMute() }
  })
  window.addEventListener('pagehide', () => {
    disposed = true
    listGeneration++
    clearTimeout(messageTimer)
    stopVideo()
  })
  const onLayout = () => handle(syncImmersive())
  mobileQuery.addEventListener('change', onLayout)
  window.addEventListener('pagehide', () => mobileQuery.removeEventListener('change', onLayout), { once: true })
  document.addEventListener('visibilitychange', () => { if (document.hidden) { video.pause(); hide('play-prompt', false) } })
  handle(syncImmersive())
  handle(load())
})()
