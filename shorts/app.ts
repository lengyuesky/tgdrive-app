import { createPageApp } from '@tgdrive/page-sdk'
import type { FileNode, MediaUrl, PageContext, PageUi, HostClient, ScopeInfo } from '@tgdrive/page-sdk'
import { icon } from '@tgdrive/ui'
import { RandomQueue } from './queue'
import { DATA_VERSION_KEY, FAVORITES_PREFIX, SETTINGS_KEY, FavoritesStore, SettingsStore, initializeData, reference, contentType, sourceIdentity, within, type FavoriteSnapshot, type SettingsSnapshot, type Source } from './state'

export type ShortsUi = Pick<PageUi, 'setImmersive' | 'setTitle' | 'pickDirectory' | 'requestScope' | 'task' | 'close' | 'onNotice' | 'beforeClose'>
export interface ShortsRuntime { host: HostClient; ui: ShortsUi; context: PageContext; dispose(): void }
const aborted = (error: unknown) => (error as { name?: string })?.name === 'AbortError'
export function sizeText(size: string) {
  const bytes = BigInt(size)
  if (bytes < 1024n) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB'], number = Number(bytes)
  let value = number / 1024, unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value.toFixed(1)} ${units[unit]}`
}
export function clock(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--'
  const value = Math.floor(seconds), hours = Math.floor(value / 3600)
  return `${hours ? `${hours}:` : ''}${String(Math.floor(value / 60) % 60).padStart(hours ? 2 : 1, '0')}:${String(value % 60).padStart(2, '0')}`
}

/** 纯页面短视频：随机接口取材，业务设置与收藏只存本应用 KV。 */
export function startShorts(runtime: ShortsRuntime = createPageApp()) {
  const { host, ui, context } = runtime
  const get = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const node = document.getElementById(id)
    if (!node) throw new Error(`短视频页面缺少控件 ${id}`)
    return node as T
  }
  const video = get<HTMLVideoElement>('video'), seek = get<HTMLInputElement>('seek'), lifetime = new AbortController()
  const queue = new RandomQueue(), settingsStore = new SettingsStore(host), favorites = new FavoritesStore(host)
  const subscriptions: (() => void)[] = [], writes = new Set<Promise<unknown>>()
  const listen = <T extends Event>(target: EventTarget, event: string, listener: (event: T) => void, options: AddEventListenerOptions = {}) => target.addEventListener(event, listener as EventListener, { ...options, signal: lifetime.signal })
  const mobile = window.matchMedia('(max-width: 767px), (pointer: coarse)')
  let settings: SettingsSnapshot | undefined, source: Source = { type: 'all' }, scope: ScopeInfo | undefined
  let initialized = false, launchPending = true, loading = false, disposed = false, closing = false, filesDirty = false, syncPending = false
  let listGeneration = 0, generation = 0, moveIntent = 0, listCancelled = false, taskActive = false
  let listController = new AbortController(), mediaController: AbortController | undefined, filling: Promise<void> | undefined, checkingChanges: Promise<void> | undefined
  let changeCursor: string | null = null, muted = true, wantsPlay = true, scrubbing = false, resumeAfterSeek = false
  let messageTimer: ReturnType<typeof setTimeout> | undefined, bufferingTimer: ReturnType<typeof setTimeout> | undefined
  let prepared: { key: string; at: number; promise: Promise<MediaUrl>; controller: AbortController; value?: MediaUrl } | undefined, warmedGeneration = -1
  let wheelAt = -Infinity, wheelTotal = 0, wheelConsumed = false, touchStart: { x: number; y: number } | null = null, touchMultiple = false, suppressClickUntil = 0
  let favorite: FavoriteSnapshot | undefined, modal: HTMLElement | undefined, modalFocus: HTMLElement | null = null
  let readyResolve!: () => void
  const ready = new Promise<void>(resolve => { readyResolve = resolve })
  const current = () => queue.current
  const hide = (id: string, value: boolean) => { get(id).hidden = value }
  const key = (file: FileNode) => `${file.id}:${file.content_version}`
  const report = (error: unknown) => {
    if (disposed || closing || aborted(error)) return
    get('message').textContent = error instanceof Error ? error.message : '操作未能完成，请重试'
    hide('message', false); clearTimeout(messageTimer); messageTimer = setTimeout(() => hide('message', true), 4500)
  }
  const handle = (promise: Promise<unknown>) => { void promise.catch(report) }
  const save = async <T>(promise: Promise<T>): Promise<T> => { writes.add(promise); try { return await promise } finally { writes.delete(promise) } }
  function syncProgress() {
    const duration = video.duration, time = video.currentTime || 0, known = video.hasAttribute('src') && Number.isFinite(duration) && duration > 0
    seek.disabled = !known
    if (!scrubbing) seek.value = String(known ? Math.min(1000, time / duration * 1000) : 0)
    get('played-progress').style.width = `${Number(seek.value) / 10}%`
    let buffered = 0
    if (known) for (let index = 0; index < video.buffered.length; index++) if (video.buffered.start(index) <= time && video.buffered.end(index) >= time) buffered = video.buffered.end(index) / duration * 100
    get('buffered-progress').style.width = `${Math.min(100, buffered)}%`
    get('playback-time').textContent = `${clock(known ? time : 0)} / ${known ? clock(duration) : '--:--'}`
    seek.setAttribute('aria-valuetext', known ? `${clock(time)}，共 ${clock(duration)}` : '正在读取时长')
  }
  function syncPlay() {
    const paused = !wantsPlay || video.paused
    get('play-toggle').setAttribute('aria-label', paused ? '播放视频' : '暂停视频'); get('play-toggle').dataset.state = paused ? 'paused' : 'playing'
  }
  function buffering(value: boolean) {
    clearTimeout(bufferingTimer); hide('buffering', true)
    if (value) bufferingTimer = setTimeout(() => { if (!disposed && wantsPlay && !document.hidden && get('play-error').hidden) hide('buffering', false) }, 220)
  }
  function stopVideo() {
    generation++; mediaController?.abort(); mediaController = undefined
    scrubbing = false; resumeAfterSeek = false; buffering(false); video.pause()
    video.removeAttribute('src'); video.removeAttribute('poster'); delete video.dataset.fileId; video.load()
    seek.value = '0'; seek.disabled = true; syncProgress()
  }
  function clearPrepared(abort = true) { if (abort) prepared?.controller.abort(); prepared = undefined }
  function syncFavorite() {
    const selected = !!favorite?.value, button = get<HTMLButtonElement>('favorite')
    button.disabled = favorite === undefined; button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected))
    button.querySelector('.label')!.textContent = favorite === undefined ? '读取收藏' : selected ? '已收藏' : '收藏'
  }
  function syncQueue() {
    const file = current()
    if (file) get('video-meta').textContent = `${queue.index + 1} / ${queue.items.length} · ${sizeText(file.size)}${queue.more ? ' · 更多视频待取材' : ''}`
    for (const id of ['previous', 'next', 'skip-error']) get<HTMLButtonElement>(id).disabled = queue.items.length < 2 && !queue.more
  }
  function syncMute() { video.muted = muted; get('mute').querySelector('.label')!.textContent = muted ? '静音中' : '有声'; get('mute').setAttribute('aria-pressed', String(!muted)) }
  function syncSource() { const label = source.type === 'all' ? '全部授权目录 · 更换' : source.path; get('source-label').querySelector('.source-text')!.textContent = label; get('source-label').title = `取材范围：${label}` }
  function fail(error: unknown) {
    wantsPlay = false; buffering(false); hide('play-prompt', true); hide('play-error', false)
    get('play-error-message').textContent = (error as { name?: string })?.name === 'NotSupportedError' || video.error?.code === 4 ? '浏览器暂不支持这个视频格式，可以下载后查看或切换下一个。' : '视频加载失败，请重试或切换下一个。'
    syncPlay()
  }
  async function attemptPlay(active = generation) {
    if (disposed || closing || active !== generation || !wantsPlay || document.hidden || scrubbing || modal || !video.hasAttribute('src')) return
    try { await video.play(); if (disposed || active !== generation) return; if (!wantsPlay || document.hidden || modal) video.pause() }
    catch (error) { if (disposed || active !== generation || aborted(error)) return; buffering(false); if ((error as { name?: string }).name === 'NotAllowedError') hide('play-prompt', false); else fail(error) }
    syncPlay()
  }
  async function readableDirectory(id: string, signal: AbortSignal) {
    let directory: FileNode
    try { directory = await host.stat({ by: 'id', id }, { signal }) }
    catch (error) {
      if ((error as { code?: string }).code !== 'scope_denied') throw error
      const granted = await ui.requestScope({ reason: '短视频需要读取所选目录及子目录。请选择允许访问的目录。', preferred_access: 'read_only' }, { signal })
      if (!granted) return null
      directory = await host.stat({ by: 'id', id }, { signal })
    }
    if (directory.kind !== 'directory') throw new Error('取材节点不是目录')
    return directory
  }
  async function resolveSource(signal: AbortSignal) {
    if (source.type === 'directory') {
      const selected = source, directory = await host.stat({ by: 'id', id: selected.id }, { signal })
      signal.throwIfAborted()
      if (sourceIdentity(source) !== sourceIdentity(selected)) throw new DOMException('取材范围已变化', 'AbortError')
      if (directory.kind !== 'directory') throw new Error('取材目录不可用，未回退到授权全盘')
      source = { type: 'directory', id: directory.id, path: directory.path }
    }
    syncSource()
    return source.type === 'directory' ? [source.id] : []
  }
  function warmNext() {
    if (disposed || document.hidden || warmedGeneration === generation) return
    const file = queue.items[queue.index + 1] ?? (!queue.more && queue.items.length > 1 ? queue.items[0] : undefined)
    if (!file) return
    warmedGeneration = generation; clearPrepared()
    const controller = new AbortController(), signal = AbortSignal.any([lifetime.signal, controller.signal])
    const next: NonNullable<typeof prepared> = { key: key(file), at: Date.now(), controller, promise: host.mediaUrl({ file: reference(file), representation: 'original', disposition: 'inline', content_type: contentType(file) }, { signal }) }
    prepared = next
    void next.promise.then(value => { next.value = value }).catch(() => { if (prepared === next) prepared = undefined })
  }
  async function refreshFavorite(file: FileNode, active: number, signal: AbortSignal) {
    try { const record = await favorites.load(file.id, signal); if (active === generation && !signal.aborted) { favorite = record; syncFavorite() } }
    catch (error) { if (active === generation && !signal.aborted) report(error) }
  }
  async function play(fresh = false) {
    const next = prepared
    clearPrepared(false); stopVideo()
    const active = generation, initial = current()
    if (!initial || disposed || closing) { next?.controller.abort(); return }
    mediaController = new AbortController(); const signal = AbortSignal.any([lifetime.signal, mediaController.signal])
    wantsPlay = true; favorite = undefined
    for (const id of ['player', 'actions', 'video-info']) hide(id, false)
    hide('play-error', true); hide('play-prompt', true); buffering(true)
    get('video-name').textContent = initial.name; get('video-name').dataset.fileId = initial.id
    syncQueue(); syncFavorite(); syncMute(); syncPlay()
    try {
      const file = await host.stat({ by: 'id', id: initial.id, ...(fresh ? {} : { content_version: initial.content_version }) }, { signal })
      reference(file)
      await resolveSource(signal); signal.throwIfAborted()
      if (source.type === 'directory' && !within(file.path, source.path)) throw new Error('视频已经移出取材目录，请重新取材')
      if (active !== generation) return
      queue.items[queue.index] = file; queue.markViewed(file.id)
      get('video-name').textContent = file.name; get('video-name').title = file.path; get('video-name').dataset.fileId = file.id; syncQueue()
      handle(refreshFavorite(file, active, signal))
      if (queue.more && queue.remaining < 6) handle(fillQueue())
      // 缩略图仅指原文件附带表示，独立于起播；没有附件时不产生无用的 404 请求。
      if (file.has_thumbnail) void host.mediaUrl({ file: reference(file), representation: 'thumbnail', disposition: 'inline' }, { signal }).then(poster => { if (active === generation && !signal.aborted) video.poster = poster.url }).catch(() => {})
      const cached = !fresh && next?.key === key(file) && Date.now() - next.at < 30_000 && (!next.value || next.value.expires_at > Date.now() + 5000)
      if (!cached) next?.controller.abort()
      const request = { file: reference(file), representation: 'original' as const, disposition: 'inline' as const, content_type: contentType(file) }
      const grant = await (cached ? next.promise : fresh ? host.renewMediaUrl(request, { signal }) : host.mediaUrl(request, { signal }))
      signal.throwIfAborted(); if (active !== generation) return
      // 契约票据是以 / 开头的同源相对路径，直接用于媒体元素，不拼接绝对基地址。
      video.src = grant.url; video.dataset.fileId = file.id; await attemptPlay(active)
    } catch (error) { next?.controller.abort(); if (active === generation && !disposed && !aborted(error)) { report(error); fail(error) } }
  }
  async function task(state: 'running' | 'completed' | 'cancelled' | 'failed') { await ui.task({ id: 'shorts-sampling', title: '短视频随机取材', completed: state === 'completed' ? 1 : 0, total: 1, state, cancellable: state === 'running' }).catch(() => {}) }
  async function fillQueue(showTask = false) {
    if (disposed || closing || !queue.more) return
    if (filling) return filling
    const active = listGeneration, signal = AbortSignal.any([lifetime.signal, listController.signal])
    const pending = (async () => {
      if (showTask) { taskActive = true; void task('running') }
      try {
        const roots = await resolveSource(signal), response = await queue.sample(host, roots, signal)
        signal.throwIfAborted(); if (active !== listGeneration) return
        queue.append(response.items); syncQueue()
        if (showTask) await task('completed')
      } catch (error) { if (showTask && active === listGeneration) await task(signal.aborted ? 'cancelled' : 'failed'); throw error }
      finally { if (showTask && active === listGeneration) taskActive = false }
    })()
    filling = pending
    try { await pending } finally { if (filling === pending) filling = undefined }
  }
  async function load(useLaunch = launchPending) {
    if (disposed || closing) return
    let launchStarted = false
    moveIntent++; const active = ++listGeneration
    listController.abort(); listController = new AbortController(); const signal = AbortSignal.any([lifetime.signal, listController.signal])
    stopVideo(); clearPrepared(); queue.reset(); filling = undefined; favorite = undefined; filesDirty = false; listCancelled = false; loading = true
    for (const id of ['player', 'actions', 'video-info', 'empty', 'list-error']) hide(id, true)
    hide('loading-list', false)
    try {
      if (!initialized) { await initializeData(host, signal); await host.runtimeInfo({ signal }); initialized = true }
      const loadedSettings = await settingsStore.load(signal); signal.throwIfAborted(); if (active !== listGeneration) return
      settings = loadedSettings; muted = settings.value.muted
      const loadedScope = await host.scope({ signal }); signal.throwIfAborted(); if (active !== listGeneration) return
      scope = loadedScope; source = settings.value.source
      const checkpoint = await host.changes({ cursor: null, limit: 200 }, { signal }); signal.throwIfAborted(); if (active !== listGeneration) return
      changeCursor = checkpoint.next_cursor
      if (useLaunch && context.launch.action === 'open') {
        const selected = context.launch.file, file = await host.stat({ by: 'id', id: selected.id, ...(selected.kind === 'file' ? { content_version: selected.content_version } : {}) }, { signal })
        const directory = file.kind === 'directory' ? file : await host.stat({ by: 'id', id: file.parent_id! }, { signal })
        source = { type: 'directory', id: directory.id, path: directory.path }
        if (file.kind === 'file') {
          reference(file); queue.reset(file); syncSource(); hide('loading-list', true); readyResolve(); launchStarted = true; handle(play()); await fillQueue(true)
        } else await fillQueue(true)
      } else await fillQueue(true)
      signal.throwIfAborted(); if (active !== listGeneration) return
      launchPending = false; hide('loading-list', true); readyResolve()
      if (queue.items.length && !launchStarted) handle(play())
      else if (!queue.items.length) { get('empty-description').textContent = source.type === 'all' ? '授权目录内没有视频，请添加视频或更换取材范围。' : `${source.path} 及子目录中没有视频。`; hide('empty', false) }
    } catch (error) {
      if (disposed || closing || active !== listGeneration || signal.aborted && !listCancelled) return
      hide('loading-list', true); get('list-error-message').textContent = listCancelled ? '随机取材已取消，可重新加载或更换目录。' : error instanceof Error ? error.message : '随机取材未能完成'
      hide('list-error', queue.items.length > 0); report(error); readyResolve()
    } finally {
      if (active === listGeneration) { loading = false; if (syncPending) { syncPending = false; handle(synchronize()) } }
    }
  }
  async function go(delta: number) {
    if (disposed || closing || modal) return
    const intent = ++moveIntent
    if (filesDirty) { await load(false); return }
    if (delta > 0 && queue.index === queue.items.length - 1 && queue.more) { const active = listGeneration; await fillQueue(); if (active !== listGeneration || intent !== moveIntent || disposed) return }
    if (queue.items.length < 2) return
    queue.move(delta); await play()
  }
  async function togglePlay() {
    if (disposed || !video.hasAttribute('src')) return
    if (!get('play-error').hidden) { await play(true); return }
    wantsPlay = video.paused
    if (wantsPlay) { hide('play-prompt', true); await attemptPlay() } else { video.pause(); buffering(false); hide('play-prompt', false) }
    syncPlay()
  }
  async function saveSettings(value: SettingsSnapshot['value']) {
    if (!settings) throw new Error('设置尚未读取，请先重新加载')
    try { settings = await save(settingsStore.save(settings, value, lifetime.signal)); return settings }
    catch (error) { try { settings = await settingsStore.load(lifetime.signal); muted = settings.value.muted; syncMute() } catch { settings = undefined }; throw error }
  }
  async function toggleMute() {
    const button = get<HTMLButtonElement>('mute')
    if (disposed || button.disabled || !settings) return
    button.disabled = true; const old = muted; muted = !muted; syncMute()
    try { await saveSettings({ ...settings.value, muted }) }
    catch (error) { if (!disposed) { muted = settings?.value.muted ?? old; syncMute(); report(error) } }
    finally { if (!disposed) button.disabled = false }
  }
  async function toggleFavorite() {
    const file = current(), base = favorite, button = get<HTMLButtonElement>('favorite'), active = generation
    if (disposed || !file || !base || button.disabled) return
    button.disabled = true
    try { const saved = await save(favorites.set(file, base, !base.value, lifetime.signal)); if (active === generation) { favorite = saved; syncFavorite() } }
    catch (error) { if (active === generation) await refreshFavorite(file, active, lifetime.signal); report(error) }
    finally { if (active === generation && !disposed) button.disabled = favorite === undefined }
  }
  function beginSeek() { if (seek.disabled || scrubbing) return; resumeAfterSeek = wantsPlay && !video.paused; scrubbing = true; video.pause(); buffering(false) }
  function finishSeek() { if (!scrubbing) return; scrubbing = false; if (resumeAfterSeek) handle(attemptPlay()); resumeAfterSeek = false; syncProgress(); syncPlay() }
  async function chooseDirectory() {
    if (!settings) throw new Error('设置尚未读取，请先重新加载')
    const button = get<HTMLButtonElement>('source-label'); if (button.disabled) return; button.disabled = true
    try {
      const selected = await ui.pickDirectory(source.type === 'directory' ? { initial_id: source.id } : {}, { signal: lifetime.signal })
      if (!selected) return
      const directory = await readableDirectory(selected.id, lifetime.signal)
      if (!directory || disposed) return
      await saveSettings({ ...settings.value, source: { type: 'directory', id: directory.id, path: directory.path } }); closeModal(false); await load(false)
    } finally { if (!disposed) button.disabled = false }
  }
  async function allSources() {
    if (!settings) throw new Error('设置尚未读取，请先重新加载')
    if ((await host.scope({ signal: lifetime.signal })).scope.mode === 'none' && !await ui.requestScope({ reason: '请为短视频选择允许读取的目录，全部取材只包含这些已授权目录。', preferred_access: 'read_only' }, { signal: lifetime.signal })) return
    await saveSettings({ ...settings.value, source: { type: 'all' } }); closeModal(false); await load(false)
  }
  function closeModal(resume = true) { modal?.remove(); modal = undefined; modalFocus?.focus(); modalFocus = null; if (resume && wantsPlay) handle(attemptPlay()) }
  function dialog(title: string) {
    closeModal(false); modalFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const overlay = document.createElement('div'), body = document.createElement('section'), header = document.createElement('header'), heading = document.createElement('h2'), close = document.createElement('button')
    overlay.className = 'shorts-modal'; body.className = 'shorts-dialog'; body.dataset.theme = document.documentElement.dataset.hostTheme ?? context.theme; body.setAttribute('role', 'dialog'); body.setAttribute('aria-modal', 'true'); body.setAttribute('aria-label', title)
    heading.textContent = title; close.type = 'button'; close.innerHTML = icon('close'); close.setAttribute('aria-label', '关闭面板'); close.onclick = () => closeModal()
    header.append(heading, close); body.append(header); overlay.append(body); get('shorts-root').append(overlay); modal = overlay
    overlay.onclick = event => { if (event.target === overlay) closeModal() }; video.pause(); buffering(false); close.focus()
    return body
  }
  function fileInfo() {
    const file = current(); if (!file) return
    const body = dialog('文件信息'), details = document.createElement('p'); details.className = 'file-information'; details.textContent = `${file.name}\n${file.path}\n节点：${file.id}\n大小：${sizeText(file.size)}\n内容版本：${file.content_version}`; body.append(details)
  }
  function showSettings() {
    const body = dialog('取材与收藏设置'), sourceText = document.createElement('p'), actions = document.createElement('div'), title = document.createElement('h3'), list = document.createElement('div'), more = document.createElement('button')
    sourceText.textContent = `当前取材：${source.type === 'all' ? '全部授权目录' : source.path}`; actions.className = 'settings-actions'
    const action = (text: string, work: () => Promise<unknown>) => { const button = document.createElement('button'); button.type = 'button'; button.textContent = text; button.onclick = () => { button.disabled = true; handle(work().finally(() => { button.disabled = false })) }; actions.append(button); return button }
    action('更换取材目录', chooseDirectory); action('全部授权目录', allSources)
    let sound!: HTMLButtonElement
    sound = action(muted ? '开启声音' : '静音播放', async () => { await toggleMute(); sound.textContent = muted ? '开启声音' : '静音播放' })
    title.textContent = '我的收藏'; list.id = 'favorite-items'; list.className = 'favorite-list'; more.type = 'button'; more.textContent = '下一页收藏'; more.hidden = true
    const previous = document.createElement('button'); previous.type = 'button'; previous.textContent = '上一页收藏'; previous.disabled = true
    body.append(sourceText, actions, title, list, previous, more)
    let cursor: string | null = null, nextCursor: string | null = null, busy = false
    const history: (string | null)[] = []
    const loadFavorites = async () => {
      if (busy) return; busy = true; more.disabled = true; previous.disabled = true
      try {
        const page = await favorites.page(cursor, lifetime.signal)
        if (!body.isConnected) return
        list.replaceChildren()
        for (const record of page.records) {
          const row = document.createElement('div'), open = document.createElement('button'), remove = document.createElement('button'), name = document.createElement('strong'), path = document.createElement('span')
          row.className = 'favorite-row'; open.type = 'button'; open.className = 'favorite-open'; name.textContent = record.value.name; path.textContent = record.value.path; open.append(name, path)
          open.onclick = () => {
            const intent = ++moveIntent
            handle((async () => {
              const file = await host.stat({ by: 'id', id: record.value.id }, { signal: lifetime.signal }); reference(file)
              const parent = await host.stat({ by: 'id', id: file.parent_id! }, { signal: lifetime.signal })
              if (!body.isConnected || disposed || closing || intent !== moveIntent) return
              listGeneration++; listController.abort(); listController = new AbortController(); filling = undefined
              source = { type: 'directory', id: parent.id, path: parent.path }
              closeModal(false); queue.reset(file); clearPrepared(); await play(true); handle(fillQueue())
            })())
          }
          remove.type = 'button'; remove.textContent = '取消收藏'; remove.onclick = () => { remove.disabled = true; handle(save(host.kvDelete(record.key, { revision: record.revision }, { signal: lifetime.signal })).then(() => { row.remove(); if (current()?.id === record.value.id) { favorite = { value: null, revision: null }; syncFavorite() } }).finally(() => { remove.disabled = false })) }
          row.append(open, remove); list.append(row)
        }
        if (page.next_cursor && page.next_cursor === cursor) throw new Error('收藏分页游标没有推进')
        nextCursor = page.next_cursor; more.hidden = nextCursor === null; previous.disabled = !history.length
        if (!list.children.length) list.textContent = '还没有应用收藏，播放时点心形按钮添加。'
      } catch (error) { if (body.isConnected) { const message = document.createElement('p'); message.textContent = '收藏读取失败，可关闭面板后重试。'; list.append(message); report(error) } }
      finally { busy = false; more.disabled = false }
    }
    more.onclick = () => { if (!nextCursor || busy) return; history.push(cursor); if (history.length > 100) history.shift(); cursor = nextCursor; handle(loadFavorites()) }
    previous.onclick = () => { if (!history.length || busy) return; cursor = history.pop()!; handle(loadFavorites()) }
    handle(loadFavorites())
  }
  async function consumeChanges() {
    if (checkingChanges) return checkingChanges
    const active = listGeneration, signal = AbortSignal.any([lifetime.signal, listController.signal])
    const work = (async () => {
      if (!changeCursor) { filesDirty = true; return }
      const before = source
      await resolveSource(signal)
      const seen = new Set<string>()
      for (;;) {
        const page = await host.changes({ cursor: changeCursor, limit: 200 }, { signal }); signal.throwIfAborted(); if (active !== listGeneration) return
        if (page.reset_required) { filesDirty = true; changeCursor = page.next_cursor; return }
        for (const change of page.changes) {
          if (source.type === 'all' || change.type === 'removed') filesDirty = true
          else if (change.type === 'upsert' && within(change.node.path, source.path)) filesDirty = true
          else if (change.type === 'subtree_invalidated' && (change.id === source.id || change.current && within(change.current.path, source.path) || change.previous_path && (within(change.previous_path, source.path) || before.type === 'directory' && within(change.previous_path, before.path)))) filesDirty = true
        }
        changeCursor = page.next_cursor
        if (!page.has_more) return
        if (seen.has(changeCursor)) throw new Error('文件变更游标没有推进')
        seen.add(changeCursor)
      }
    })()
    checkingChanges = work
    try { await work } catch (error) { if (!signal.aborted && active === listGeneration && !disposed) { filesDirty = true; if (['scope_changed', 'cursor_expired'].includes((error as { code?: string }).code ?? '')) await load(false); else report(error) } }
    finally { if (checkingChanges === work) checkingChanges = undefined }
  }
  async function synchronize() {
    if (disposed || closing) return
    if (loading) { syncPending = true; return }
    const active = listGeneration, next = await settingsStore.load(lifetime.signal), latest = await host.scope({ signal: lifetime.signal })
    if (disposed || active !== listGeneration) return
    const changed = settings && sourceIdentity(next.value.source) !== sourceIdentity(settings.value.source) || scope && latest.revision !== scope.revision
    settings = next; scope = latest; muted = next.value.muted; syncMute(); filesDirty = true
    if (changed) await load(false)
    else if (current()) await refreshFavorite(current()!, generation, lifetime.signal)
  }
  async function events() {
    try {
      for await (const event of host.events({ signal: lifetime.signal })) {
        if (closing) continue
        if (event.event === 'files.changed') handle(consumeChanges())
        else if (event.event === 'scope.changed') { stopVideo(); handle(load(false)) }
        else if (event.event === 'sync.required') handle(synchronize())
        else if (event.event === 'app.changed') { stopVideo(); dispose() }
        else if (event.event === 'kv.changed') {
          const data = event.data as { key?: string; revision?: string }
          if (data?.key === SETTINGS_KEY && data.revision !== settings?.revision) {
            const next = await settingsStore.load(lifetime.signal)
            if (settings && sourceIdentity(next.value.source) !== sourceIdentity(settings.value.source)) { settings = next; handle(load(false)) }
            else { settings = next; muted = next.value.muted; syncMute() }
          } else if (data?.key === FAVORITES_PREFIX + current()?.id && current()) handle(refreshFavorite(current()!, generation, lifetime.signal))
          else if (data?.key === DATA_VERSION_KEY) { try { await initializeData(host, lifetime.signal) } catch (error) { report(error); dispose() } }
        }
      }
    } catch (error) { if (!disposed && !lifetime.signal.aborted) report(error) }
  }
  async function close() { if (disposed || closing) return; closing = true; stopVideo(); listController.abort(); clearPrepared(); try { await ui.close() } finally { dispose() } }
  function dispose() { if (disposed) return; disposed = true; readyResolve(); listGeneration++; listController.abort(); lifetime.abort(); clearPrepared(); closeModal(false); subscriptions.splice(0).forEach(off => off()); clearTimeout(messageTimer); stopVideo(); runtime.dispose() }
  async function immersive() { if (!disposed) await ui.setImmersive({ active: mobile.matches, ...(mobile.matches ? { background: '#000000' } : {}) }) }

  listen(get('exit'), 'click', () => handle(close()))
  listen(get('favorite'), 'click', () => handle(toggleFavorite()))
  listen(get('mute'), 'click', () => handle(toggleMute()))
  listen(get('download'), 'click', () => { const file = current(); if (file) handle(host.mediaUrl({ file: reference(file), representation: 'original', disposition: 'attachment', filename: file.name, content_type: contentType(file), ttl_seconds: 300 }, { signal: lifetime.signal }).then(grant => { if (!disposed) { const link = document.createElement('a'); link.href = grant.url; link.download = file.name; link.click() } })) })
  listen(get('shuffle'), 'click', () => handle(load(false)))
  for (const id of ['previous', 'next', 'skip-error']) listen(get(id), 'click', () => handle(go(id === 'previous' ? -1 : 1)))
  listen(get('retry-video'), 'click', () => handle(play(true)))
  listen(get('retry-list'), 'click', () => handle(load()))
  listen(get('open-settings'), 'click', showSettings)
  listen(get('source-label'), 'click', () => handle(chooseDirectory()))
  listen(get('settings'), 'click', showSettings); listen(get('file-info'), 'click', fileInfo)
  for (const id of ['play-prompt', 'play-toggle']) listen(get(id), 'click', () => handle(togglePlay()))
  listen(video, 'click', () => { if (performance.now() >= suppressClickUntil) handle(togglePlay()) })
  listen(video, 'playing', () => { if (!wantsPlay || document.hidden || scrubbing || modal) { video.pause(); return }; buffering(false); hide('play-prompt', true); hide('play-error', true); syncPlay(); syncProgress(); warmNext() })
  listen(video, 'pause', syncPlay); listen(video, 'waiting', () => { if (video.hasAttribute('src') && wantsPlay && !scrubbing) buffering(true) }); listen(video, 'error', () => { if (video.hasAttribute('src') && video.error) fail(video.error) })
  for (const event of ['loadedmetadata', 'durationchange', 'timeupdate', 'progress']) listen(video, event, syncProgress)
  listen(seek, 'pointerdown', beginSeek); listen(seek, 'input', () => { if (!seek.disabled && Number.isFinite(video.duration)) { video.currentTime = Number(seek.value) / 1000 * video.duration; syncProgress() } }); listen(seek, 'change', finishSeek)
  listen(window, 'pointerup', finishSeek); listen(window, 'pointercancel', finishSeek)
  listen<WheelEvent>(get('player'), 'wheel', event => {
    if (modal || Math.abs(event.deltaY) <= Math.abs(event.deltaX) || event.ctrlKey) return
    event.preventDefault(); const now = performance.now(); if (now - wheelAt > 180) { wheelTotal = 0; wheelConsumed = false }; wheelAt = now
    if (wheelConsumed) return
    wheelTotal += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1)
    if (Math.abs(wheelTotal) < 48) return
    wheelConsumed = true; handle(go(wheelTotal > 0 ? 1 : -1))
  }, { passive: false })
  listen<TouchEvent>(get('player'), 'touchstart', event => { if ((event.target as Element)?.closest('button,input,select')) { touchStart = null; return }; if (event.touches.length !== 1) { touchMultiple = true; return }; touchMultiple = false; touchStart = { x: event.touches[0]!.clientX, y: event.touches[0]!.clientY } }, { passive: true })
  listen<TouchEvent>(get('player'), 'touchmove', event => { if (event.touches.length > 1) touchMultiple = true }, { passive: true })
  listen(get('player'), 'touchcancel', () => { touchStart = null; touchMultiple = false }, { passive: true })
  listen<TouchEvent>(get('player'), 'touchend', event => { if (event.touches.length) return; const end = event.changedTouches[0]; if (touchStart && end && !touchMultiple) { const dy = end.clientY - touchStart.y, dx = end.clientX - touchStart.x; if (Math.abs(dy) > 60 && Math.abs(dy) > Math.abs(dx) * 1.4) { suppressClickUntil = performance.now() + 400; handle(go(dy < 0 ? 1 : -1)) } }; touchStart = null }, { passive: true })
  listen<KeyboardEvent>(document, 'keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); if (modal) closeModal(); else handle(close()); return }
    if (modal) { if (event.key === 'Tab') { const nodes = [...modal.querySelectorAll<HTMLElement>('button:not(:disabled),input,select,[tabindex="0"]')]; const first = nodes[0], last = nodes.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() } }; return }
    if (event.target instanceof Element && event.target.closest('button,input,textarea,select,a,[contenteditable="true"]') || event.altKey || event.ctrlKey || event.metaKey) return
    if (['ArrowDown', 'PageDown', 'ArrowUp', 'PageUp'].includes(event.key)) { event.preventDefault(); if (!event.repeat) handle(go(['ArrowDown', 'PageDown'].includes(event.key) ? 1 : -1)) }
    else if (event.key === ' ') { event.preventDefault(); if (!event.repeat) handle(togglePlay()) }
    else if (event.key.toLowerCase() === 'm' && !event.repeat) handle(toggleMute())
    else if (['ArrowLeft', 'ArrowRight'].includes(event.key) && !seek.disabled) { event.preventDefault(); video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + (event.key === 'ArrowRight' ? 5 : -5))); syncProgress() }
  })
  listen(window, 'pagehide', dispose); listen(mobile, 'change', () => handle(immersive()))
  listen(document, 'visibilitychange', () => { if (document.hidden) { finishSeek(); video.pause(); buffering(false) } else if (wantsPlay) handle(attemptPlay()); syncPlay() })
  subscriptions.push(ui.onNotice(notice => {
    if (notice.event === 'ui.theme_changed') { document.documentElement.dataset.hostTheme = notice.data.theme; modal?.querySelector<HTMLElement>('.shorts-dialog')?.setAttribute('data-theme', notice.data.theme) }
    else if (notice.event === 'ui.task_cancel' && notice.data.task_id === 'shorts-sampling' && taskActive) { listCancelled = true; listController.abort() }
  }))
  subscriptions.push(ui.beforeClose(async signal => {     closing = true; stopVideo(); listController.abort(); if (signal.aborted) return
    let abort!: () => void
    try { await Promise.race([Promise.allSettled([...writes]), new Promise<void>(resolve => { abort = resolve; signal.addEventListener('abort', abort, { once: true }) })]) }
    finally { signal.removeEventListener('abort', abort) }
  }))
  get('settings').querySelector('.symbol')!.innerHTML = icon('settings')
  get('file-info').querySelector('.symbol')!.innerHTML = icon('page')
  document.title = context.app.name; document.documentElement.dataset.hostTheme = context.theme
  handle(ui.setTitle({ title: context.app.name })); handle(immersive()); handle(events()); handle(load())
  return { ready, dispose, refresh: () => load(false) }
}
