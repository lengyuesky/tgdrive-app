import './style.css'
import './libraries.css'
import type { FileEntry, RecordValue } from '../sdk/types'
import { VIDEO_EXTENSIONS, extension, isVideo, naturalOrder, parentPath, preferences, sizeText, subtitleFiles, timeText, title, validProgress, type CinemaFavorite, type CinemaPreferences, type CinemaProgress } from './model'
import { ReadScheduler, RangeFile, isAbort } from './io'
import { Library, ArtLoader } from './library'
import { ProgressStore } from './storage'
import { LibrariesStore, LibraryAccess, requireDirectory, withinDirectory, type CinemaLibrary, type LibrariesSnapshot, type SavedVideo, filesChangeAffectsLibraries } from './libraries'
import { LibraryManager } from './libraries-ui'
import { PlaybackSession, type PlaybackInfo } from './media'
import { Captions, readSubtitle, type SubtitleTrack } from './subtitles'

const drive = window.tgdrive
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const show = (id: string, visible: boolean) => { $(id).hidden = !visible }
const text = (id: string, value: string) => { $(id).textContent = value }
const value = (id: string) => $<HTMLInputElement>(id).value
const icons: Record<string, string> = {
  home: 'M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z',
  grid: 'M3 3h7v7H3Zm11 0h7v7h-7ZM3 14h7v7H3Zm11 0h7v7h-7Z',
  heart: 'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4v5l3 2',
  folder: 'M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z',
  settings: 'M4 7h16M4 17h16M8 4v6m8 4v6',
  back: 'm10 5-7 7 7 7M3 12h18', refresh: 'M20 7v5h-5m-11 5v-5h5M5 8a8 8 0 0 1 13-3l2 3M4 16l2 3a8 8 0 0 0 13-3',
  play: 'm8 4 13 8-13 8Z', pause: 'M7 4v16M17 4v16', info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 8v6m0-10v1',
  search: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5 12 6 6', film: 'M4 3h16v18H4ZM4 8h16M4 16h16M8 3v18M16 3v18',
  close: 'm6 6 12 12M6 18 18 6', download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5', rewind: 'M11 5 2 12l9 7Zm10 0-9 7 9 7Z', forward: 'm3 5 9 7-9 7Zm10 0 9 7-9 7Z',
  previous: 'M4 4v16M20 5 7 12l13 7Z', next: 'M20 4v16M4 5l13 7-13 7Z', volume: 'M3 9h4l5-5v16l-5-5H3Zm13-2a7 7 0 0 1 0 10m3-13a11 11 0 0 1 0 16',
  pip: 'M3 3h18v18H3Zm9 9h7v6h-7Z', fullscreen: 'M3 9V3h6m6 0h6v6M3 15v6h6m6 0h6v-6',
}
function icon(name: string) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), path = document.createElementNS(svg.namespaceURI, 'path')
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); path.setAttribute('d', icons[name] ?? icons.film); svg.append(path); return svg
}
document.querySelectorAll<HTMLElement>('[data-icon]').forEach(node => node.replaceChildren(icon(node.dataset.icon!)))
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', body = '') { const node = document.createElement(tag); node.className = className; node.textContent = body; return node }
let toastTimer: ReturnType<typeof setTimeout>
function toast(message: string) { text('toast', message); show('toast', true); clearTimeout(toastTimer); toastTimer = setTimeout(() => show('toast', false), 5500) }
function report(error: unknown) { if (!isAbort(error)) toast(error instanceof Error ? error.message : String(error)) }
function handle(task: unknown) { void Promise.resolve(task).catch(report) }
function on(id: string, event: string, callback: (event: Event) => unknown) { $(id).addEventListener(event, event => { try { handle(callback(event)) } catch (error) { report(error) } }) }
const scheduler = new ReadScheduler(), library = new Library(drive)
const librariesStore = new LibrariesStore(drive), access = new LibraryAccess(drive, scheduler)
let pageController = new AbortController(), detailController = new AbortController(), playController = new AbortController()
let art: ArtLoader | undefined, detailArt: ArtLoader | undefined
let view: 'home' | 'library' | 'favorites' | 'history' = 'home'
let configSnapshot: LibrariesSnapshot | null = null, activeLibraryId: string | null = null, currentRoot: CinemaLibrary | null = null
let detailLibraryId: string | undefined, playingRoot: CinemaLibrary | null = null, playingLibraryId: string | undefined
let navigationGeneration = 0, directory: string | null = null, directoryMode = false, query = '', format = ''
const libraryProblems = new Map<string, string>(), knownPaths = new Map<number, string>()
let cursors: (string | null)[] = [null], pageIndex = 0, nextCursor: string | null = null
let currentFiles: FileEntry[] = [], heroFile: FileEntry | undefined, selected: FileEntry | undefined
let episodes: FileEntry[] = [], episodesComplete = true, episodePage = 0
let pref = preferences(null), prefRecord: RecordValue<CinemaPreferences> | null = null, prefSaving = Promise.resolve()
let favoriteRecord: RecordValue<CinemaFavorite> | null = null
let session: PlaybackSession | undefined, store: ProgressStore | undefined, playing: FileEntry | undefined, queue: FileEntry[] = []
let playGeneration = 0, startIntent = 0, restored = false, duration = 0, subtitleTracks: SubtitleTrack[] = [], subtitleController = new AbortController()
let captionWindowAt = -Infinity, captionLoading = false, selectedSubtitle = '', restoredAudio: number | undefined
let subtitleExplicit = false, failedPlayback = false
let previousFocus: HTMLElement | null = null, nextTimer: ReturnType<typeof setInterval> | undefined
const video = $<HTMLVideoElement>('video'), captions = new Captions(video)
const detail = $<HTMLDialogElement>('detail'), player = $('player')
function showPlayer(visible: boolean) {
  show('player', visible)
  document.querySelectorAll<HTMLElement>('.sidebar, #main, .bottom-nav').forEach(node => { node.inert = visible })
}
const clearHistory = element('button', 'clear-history', '清空历史')
clearHistory.hidden = true; $('section-title').parentElement!.append(clearHistory)
let confirmation: ((value: boolean) => void) | undefined
function confirmAction(message: string, description: string) {
  if (confirmation) return Promise.resolve(false)
  text('confirm-title', message); text('confirm-text', description); $<HTMLDialogElement>('confirm-dialog').showModal()
  return new Promise<boolean>(resolve => { confirmation = resolve })
}
function finishConfirm(ok: boolean) { $<HTMLDialogElement>('confirm-dialog').close(); confirmation?.(ok); confirmation = undefined }
on('confirm-ok', 'click', () => finishConfirm(true)); on('confirm-cancel', 'click', () => finishConfirm(false))
on('confirm-dialog', 'cancel', event => { event.preventDefault(); finishConfirm(false) })
const manager = new LibraryManager(drive, librariesStore, access, async snapshot => {
  configSnapshot = snapshot; libraryProblems.clear(); await navigate('library')
}, toast, confirmAction)

function poster(file: FileEntry, removable?: () => unknown, progress?: CinemaProgress) {
  const card = element('article', 'poster-card'), button = element('button', 'poster-button'), image = element('div', 'poster-art')
  image.style.setProperty('--hue', String(230 + file.id * 37 % 100)); image.append(element('span', 'poster-initial', title(file.name).slice(0, 4)))
  image.append(element('span', 'poster-format', file.is_dir ? '合集目录' : extension(file.name).toUpperCase()))
  const hover = element('span', 'poster-play'); hover.append(icon(file.is_dir ? 'folder' : 'play')); image.append(hover)
  button.append(image, element('h3', '', file.is_dir ? file.name : title(file.name)), element('p', '', file.is_dir ? '打开目录，发现更多' : `${sizeText(file.size)} · ${parentPath(file.path).split('/').pop() || '网盘'}`))
  button.title = file.path; button.setAttribute('aria-label', `${file.is_dir ? '打开目录' : '查看影视'}：${file.name}`)
  button.onclick = () => handle(file.is_dir ? browseDirectory(file.path) : openDetail(file))
  card.append(button)
  if (!file.is_dir) art?.observe(image, file)
  if (progress) { const bar = element('div', 'progress-track'), fill = element('i'); fill.style.width = `${Math.min(100, progress.seconds / Math.max(1, progress.duration) * 100)}%`; bar.append(fill); card.append(bar) }
  if (removable) { const remove = element('button', 'poster-remove', '移除'); remove.setAttribute('aria-label', `移除记录：${file.name}`); remove.onclick = () => handle(removable()); card.append(remove) }
  return card
}
function resetPages() { pageIndex = 0; cursors = [null]; nextCursor = null }
async function navigate(next: typeof view, libraryId: string | null = null) {
  const generation = ++navigationGeneration
  pageController.abort(); art?.clear(); closeDetail()
  await closePlayer(false)
  if (generation !== navigationGeneration) return
  view = next; activeLibraryId = libraryId; currentRoot = null; directory = null; directoryMode = false; query = ''; format = ''
  episodes = []; episodesComplete = false; heroFile = undefined; library.setScope(null); resetPages()
  $<HTMLInputElement>('search').value = ''; $<HTMLSelectElement>('format').value = ''
  await loadPage()
}
async function browseDirectory(path: string) {
  requireDirectory(currentRoot?.directoryPath ?? null, path)
  directoryMode = true; directory = path; resetPages(); await loadPage()
}
function closeDetail() { if (detail.open) detail.close(); detailController.abort(); detailArt?.clear(); previousFocus?.isConnected && previousFocus.focus() }
function renderLibraries(snapshot: LibrariesSnapshot) {
  currentRoot = null; library.setScope(null)
  show('library-navigation', false); show('search-form', false); show('breadcrumbs', false); show('libraries', true); show('new-library', true)
  text('section-title', '我的媒体库'); text('source-label', `${snapshot.config.libraries.length} 个媒体库`); $('source-label').title = ''
  text('list-status', '选择一个媒体库后才加载其中的视频，不会自动扫描整个网盘。')
  for (const item of snapshot.config.libraries) {
    const card = element('article', 'library-card'), button = element('button', 'library-enter'), actions = element('div', 'library-card-actions')
    card.dataset.libraryId = item.id
    button.setAttribute('aria-label', `进入媒体库：${item.name}`)
    button.append(icon('folder'), element('h3', '', item.name), element('p', '', knownPaths.get(item.directoryId) ?? item.directoryPath), element('small', '', libraryProblems.get(item.id) ? '文件夹不可用，请重新选择' : '包含子文件夹 · 点击进入'))
    button.onclick = () => handle(navigate('library', item.id))
    const edit = element('button', '', '编辑'), remove = element('button', 'library-delete', '删除')
    edit.setAttribute('aria-label', `编辑媒体库：${item.name}`); remove.setAttribute('aria-label', `删除媒体库：${item.name}`)
    edit.onclick = () => handle(manager.edit(item)); remove.onclick = () => handle(manager.remove(item))
    actions.append(edit, remove); card.append(button, actions); $('libraries').append(card)
  }
  show('empty', !snapshot.config.libraries.length); show('empty-source', true)
  text('empty-title', '尚未创建媒体库'); text('empty-text', '创建一个媒体库，例如“电影”，选择对应文件夹。进入该库后才会加载视频，旧的影视文件夹设置不会自动启用。')
}
async function loadPage() {
  pageController.abort(); pageController = new AbortController()
  const signal = pageController.signal, recordView = view === 'favorites' || view === 'history', activeId = activeLibraryId, previousRoot = currentRoot
  closeDetail(); art?.clear(); currentRoot = null; library.setScope(null)
  document.querySelectorAll<HTMLElement>('[data-nav]').forEach(button => { const active = button.dataset.nav === view; button.classList.toggle('active', active); button.setAttribute('aria-current', active ? 'page' : 'false') })
  currentFiles = []; heroFile = undefined; nextCursor = null; $('items').replaceChildren(); $('libraries').replaceChildren(); $('continue-items').replaceChildren()
  for (const id of ['empty', 'hero', 'continue-section', 'libraries', 'search-form', 'breadcrumbs', 'previous-page', 'next-page']) show(id, false)
  show('library-navigation', !!activeId); show('new-library', !recordView && !activeId)
  text('page-label', ''); text('source-label', ''); $('source-label').title = ''; text('list-status', '正在读取媒体库设置…')
  $('main').scrollTop = 0
  text('page-title', { home: '今晚，看点什么？', library: '我的媒体库', favorites: '把喜欢，留在身边', history: '每一次相遇，都有记录' }[view])
  text('section-title', recordView ? view === 'history' ? '观看历史' : '我的收藏' : '我的媒体库')
  clearHistory.hidden = view !== 'history'
  try {
    const snapshot = await librariesStore.load(signal)
    signal.throwIfAborted(); configSnapshot = snapshot
    if (!recordView && !activeId) { renderLibraries(snapshot); return }
    if (activeId && !snapshot.config.libraries.some(item => item.id === activeId)) {
      activeLibraryId = null; resetPages(); renderLibraries(snapshot); toast('此媒体库已删除，请重新选择'); return
    }
    const resolved = await access.roots(snapshot.config, signal, activeId ?? undefined)
    signal.throwIfAborted()
    for (const root of resolved.roots) { knownPaths.set(root.directoryId, root.directoryPath); libraryProblems.delete(root.id) }
    for (const item of resolved.unavailable) libraryProblems.set(item.library.id, item.message)
    const notes: string[] = []
    let records: SavedVideo<CinemaProgress | CinemaFavorite>[] = []
    if (recordView) {
      if (resolved.unavailable.length) notes.push('部分媒体库文件夹不可用，相关记录暂不显示，请在媒体库设置中重新选择。')
      const page = await access.savedPage<CinemaProgress | CinemaFavorite>(resolved.roots, view === 'history' ? 'progress:' : 'favorite:', cursors[pageIndex], 48, signal)
      signal.throwIfAborted()
      records = page.entries; currentFiles = records.map(entry => entry.file); nextCursor = page.has_more ? page.next_cursor : null
      if (page.failed) notes.push('部分记录暂时无法验证，请刷新重试。')
      text('source-label', '仅显示媒体库内的记录')
      art = new ArtLoader(drive, library, scheduler, signal, true, resolved.roots.map(root => root.directoryPath))
    } else {
      const root = resolved.roots[0]
      if (!root) throw new Error('媒体库文件夹不可用，请点击“设置当前媒体库”重新选择文件夹')
      currentRoot = root; library.setScope(root.directoryPath)
      if (previousRoot && (previousRoot.directoryId !== root.directoryId || previousRoot.directoryPath !== root.directoryPath)) { resetPages(); directory = null }
      if (!directory || !withinDirectory(directory, root.directoryPath)) directory = root.directoryPath
      text('page-title', root.name); text('section-title', directoryMode ? '目录浏览' : `${root.name} · 全部视频`)
      text('source-label', root.directoryPath); $('source-label').title = root.directoryPath
      show('search-form', true); show('breadcrumbs', directoryMode)
      if (directoryMode) {
        const path = directory, back = element('button', '', '‹ 上一级')
        back.disabled = path === root.directoryPath; back.onclick = () => handle(browseDirectory(parentPath(path)))
        $('breadcrumbs').replaceChildren(back, element('span', 'muted', path))
        const page = await access.list(root, path, cursors[pageIndex], signal)
        signal.throwIfAborted(); currentFiles = page.entries; nextCursor = page.has_more ? page.next_cursor : null
      } else {
        const extensions = format === 'others' ? VIDEO_EXTENSIONS.filter(e => !['mp4','mkv','webm','mov'].includes(e)) : format ? [format] : VIDEO_EXTENSIONS
        const page = await access.search(root, { q: query, extensions, cursor: cursors[pageIndex] }, signal)
        signal.throwIfAborted(); currentFiles = page.results; nextCursor = page.has_more ? page.next_cursor : null
      }
      art = new ArtLoader(drive, library, scheduler, signal)
    }
    signal.throwIfAborted()
    for (let i = 0; i < currentFiles.length; i++) {
      const file = currentFiles[i], record = records[i]?.record
      const progress = record && validProgress(record.value) && record.value.file.content_version === file.content_version ? record.value : undefined
      $('items').append(poster(file, record ? async () => { await drive.storage.delete(record.key, record.revision, { signal }); signal.throwIfAborted(); await loadPage() } : undefined, progress))
    }
    if (!currentFiles.length && nextCursor) notes.push(recordView ? '本页没有媒体库内的记录，可以继续翻页；库外记录仅隐藏，未删除。' : '本页没有视频，可以继续翻页查找。')
    text('list-status', notes.join(' ')); show('empty', !currentFiles.length && !nextCursor)
    text('empty-title', recordView ? '暂无媒体库内的记录' : query ? '暂时没有找到这部影片' : '此媒体库还没有视频')
    text('empty-text', recordView ? '收藏和历史只显示已配置媒体库中的视频。库外记录仍保留，重新加入对应目录后可恢复显示。' : query ? '试试更短的文件名；搜索仅在当前媒体库中进行。' : '向绑定文件夹及其子文件夹添加视频，然后刷新；也可以修改媒体库绑定的文件夹。')
    show('empty-source', !snapshot.config.libraries.length)
    show('previous-page', pageIndex > 0); show('next-page', !!nextCursor)
    text('page-label', currentFiles.length || pageIndex || nextCursor ? `第 ${pageIndex + 1} 页 · ${currentFiles.length} 项` : '')
    if (!recordView && currentRoot && !directoryMode && !query && !format && pageIndex === 0) await homeSections(currentRoot, signal)
  } catch (error) {
    if (!signal.aborted) { text('list-status', `${(error as Error).message}；可点击右上角刷新重试。`); show('empty', false) }
  }
}
async function homeSections(root: CinemaLibrary, signal: AbortSignal) {
  const recent = await access.savedPage<CinemaProgress>([root], 'progress:', null, 12, signal)
  signal.throwIfAborted()
  const progress = recent.entries.filter(entry => !entry.record.value.completed && entry.record.value.seconds > 0 && entry.record.value.file.content_version === entry.file.content_version)
  $('continue-items').replaceChildren()
  for (const entry of progress.slice(0, 3)) {
    const p = entry.record.value, file = entry.file, button = element('button', 'continue-card'), image = element('span', 'continue-art'), copy = element('span', 'continue-copy')
    image.append(icon('play')); copy.append(element('strong', '', title(file.name)), element('small', '', `${timeText(p.seconds)} / ${timeText(p.duration)}`))
    const bar = element('span', 'progress-track'), fill = element('i'); fill.style.width = `${Math.min(100, p.seconds / Math.max(1, p.duration) * 100)}%`; bar.append(fill); copy.append(bar)
    button.append(image, copy); button.onclick = () => handle(startPlayback(file)); button.setAttribute('aria-label', `继续观看：${file.name}`); $('continue-items').append(button)
  }
  if (recent.failed) text('list-status', '部分观看记录暂时无法验证，可刷新重试。')
  show('continue-section', progress.length > 0)
  heroFile = progress[0]?.file ?? currentFiles.find(isVideo)
  if (heroFile) {
    text('hero-title', title(heroFile.name)); text('hero-meta', `${extension(heroFile.name).toUpperCase()}  /  ${sizeText(heroFile.size)}  /  ${root.name}`)
    show('hero', true); art?.observe($('hero').querySelector('.hero-art') as HTMLElement, heroFile, true)
  }
}
async function scopedVideo(file: FileEntry, signal: AbortSignal, requiredId = activeLibraryId ?? undefined) {
  const snapshot = await librariesStore.load(signal)
  return access.video(snapshot.config, file.id, signal, requiredId)
}
async function downloadVideo(file: FileEntry, requiredId: string | undefined, signal: AbortSignal) {
  const current = await scopedVideo(file, signal, requiredId)
  signal.throwIfAborted(); await drive.ui.download(current.file.path)
}
async function openDetail(file: FileEntry) {
  detailController.abort(); detailController = new AbortController(); detailArt?.clear()
  const signal = detailController.signal
  selected = file; detailLibraryId = activeLibraryId ?? undefined; episodes = []; episodesComplete = false; episodePage = 0; favoriteRecord = null
  previousFocus = document.activeElement as HTMLElement
  if (!detail.open) detail.showModal()
  text('detail-title', title(file.name)); text('detail-meta', `${extension(file.name).toUpperCase()} · ${sizeText(file.size)}`); text('detail-path', file.path)
  text('detail-progress', ''); text('detail-status', '正在整理同目录合集…'); text('episode-count', '')
  $('episodes').replaceChildren(); $('detail-poster').replaceChildren(); show('episodes-prev', false); show('episodes-next', false)
  const image = element('div', 'poster-art'); image.style.setProperty('--hue', String(230 + file.id * 37 % 100)); image.append(element('span', 'poster-initial', title(file.name).slice(0, 4)))
  $('detail-poster').append(image)
  for (const id of ['detail-play', 'detail-restart', 'detail-download', 'detail-favorite']) $<HTMLButtonElement>(id).disabled = true
  try {
    const { file: current, library: root } = await scopedVideo(file, signal, detailLibraryId)
    signal.throwIfAborted(); selected = current; detailLibraryId = root.id
    text('detail-title', title(current.name)); text('detail-meta', `${extension(current.name).toUpperCase()} · ${sizeText(current.size)}`); text('detail-path', current.path)
    library.setScope(root.directoryPath)
    detailArt = new ArtLoader(drive, library, scheduler, signal); detailArt.observe(image, current)
    for (const id of ['detail-play', 'detail-restart', 'detail-download']) $<HTMLButtonElement>(id).disabled = false
    const [progress, favorite] = await Promise.all([drive.storage.get<CinemaProgress>(`progress:${current.id}`, { signal }), drive.storage.get<CinemaFavorite>(`favorite:${current.id}`, { signal })])
    signal.throwIfAborted(); favoriteRecord = favorite; updateFavorite()
    const p = progress?.value
    const resumable = validProgress(p) && p.file.content_version === current.content_version && !p.completed && p.seconds > 0
    $('detail-play').querySelector('span:last-child')!.textContent = resumable ? '继续观看' : '立即播放'
    text('detail-progress', resumable ? `上次看到 ${timeText(p.seconds)} · 总时长 ${timeText(p.duration)}` : validProgress(p) && p.completed ? '已看完 · 可以再次回味' : '')
    const list = await library.directory(parentPath(current.path), signal, true)
    signal.throwIfAborted(); episodes = list.files.filter(item => isVideo(item) && withinDirectory(item.path, root.directoryPath)).sort(naturalOrder); episodesComplete = list.complete
    text('detail-status', list.complete ? '' : '此目录超过 10000 项，只展示已整理部分；自动连播已禁用，请用目录分页选择。')
    text('episode-count', `${episodes.length} 个视频`); renderEpisodes()
  } catch (error) { if (!signal.aborted) text('detail-status', `文件不可用或加载失败：${(error as Error).message}`) }
}
function renderEpisodes() {
  $('episodes').replaceChildren()
  for (const file of episodes.slice(episodePage * 100, (episodePage + 1) * 100)) {
    const button = element('button', file.id === selected?.id ? 'selected' : '', file.name)
    button.title = file.path; button.onclick = () => handle(startPlayback(file, false, episodesComplete ? episodes : [])); $('episodes').append(button)
  }
  show('episodes-prev', episodePage > 0); show('episodes-next', (episodePage + 1) * 100 < episodes.length)
}
function updateFavorite() {
  const button = $<HTMLButtonElement>('detail-favorite'); button.disabled = false
  button.setAttribute('aria-pressed', String(!!favoriteRecord)); button.querySelector('span:last-child')!.textContent = favoriteRecord ? '已收藏' : '收藏'
}
async function toggleFavorite() {
  if (!selected) return
  const original = selected, button = $<HTMLButtonElement>('detail-favorite'), previous = favoriteRecord, signal = detailController.signal
  button.disabled = true
  try {
    const { file } = await scopedVideo(original, signal, detailLibraryId)
    if (previous) { await drive.storage.delete(previous.key, previous.revision, { signal }); signal.throwIfAborted(); favoriteRecord = null }
    else { const saved = await drive.storage.set(`favorite:${file.id}`, { file }, null, { signal }); signal.throwIfAborted(); favoriteRecord = saved }
  } catch (error) {
    if (!signal.aborted && (error as { code?: string }).code === 'storage_conflict') {
      const saved = await drive.storage.get<CinemaFavorite>(`favorite:${original.id}`, { signal }); signal.throwIfAborted(); favoriteRecord = saved
    }
    throw error
  } finally { if (!signal.aborted && selected?.id === original.id) updateFavorite() }
}

function applyPreferences() {
  video.playbackRate = pref.speed; video.style.objectFit = pref.fit; video.style.setProperty('--subtitle-size', `${pref.subtitleSize}px`)
  $<HTMLSelectElement>('speed').value = String(pref.speed); $<HTMLSelectElement>('fit').value = pref.fit
  $<HTMLInputElement>('subtitle-size').value = String(pref.subtitleSize); $<HTMLInputElement>('subtitle-offset').value = String(pref.subtitleOffset)
  $<HTMLSelectElement>('encoding').value = pref.encoding; $<HTMLInputElement>('autoplay').checked = pref.autoplay; captions.shift(pref.subtitleOffset)
}
function savePreferences() {
  applyPreferences()
  const next = { ...pref }
  prefSaving = prefSaving.then(async () => {
    try { prefRecord = await drive.storage.set('preferences', next, prefRecord?.revision ?? null) }
    catch (error) {
      if ((error as { code?: string }).code === 'storage_conflict') { prefRecord = await drive.storage.get<CinemaPreferences>('preferences'); pref = preferences(prefRecord?.value); applyPreferences(); toast('另一设备更改了播放偏好，已读取最新设置，请重新调整') }
      else report(error)
    }
  })
  return prefSaving
}
function persist(immediate = false) {
  if (!playing || !store || !restored || !session?.canSave || !Number.isFinite(video.currentTime)) return
  store.mark({ file: playing, seconds: video.currentTime, duration, completed: video.ended || duration > 0 && video.currentTime / duration >= .95, subtitle: selectedSubtitle, audio: session.selectedAudio }, immediate)
}
function syncStatus(message: string, conflict: boolean) {
  text('sync-status', message); show('sync-remote', conflict); show('sync-local', conflict); show('sync-retry', !conflict && message.includes('未同步'))
}
async function immersive(active: boolean) {
  const context = await drive.ready
  if (context.capabilities?.includes('ui.setImmersive')) await drive.ui.setImmersive(active, active && context.capabilities.includes('ui.immersiveBackground') ? { background: '#07070b' } : undefined)
}
async function startPlayback(file: FileEntry, restart = false, suppliedQueue?: FileEntry[]) {
  const intent = ++startIntent, requiredId = playing ? playingLibraryId : detail.open ? detailLibraryId : activeLibraryId ?? undefined
  navigationGeneration++
  // 尚未整理完成的详情会传入空数组，不能将其当作已经确定的完整选集。
  const providedQueue = suppliedQueue?.some(e => e.id === file.id) ? suppliedQueue : undefined
  const previousQueue = providedQueue ?? (episodesComplete && episodes.some(e => e.id === file.id) ? episodes : [file])
  await closePlayer(false, true)
  if (intent !== startIntent) return
  const active = ++playGeneration
  playController = new AbortController(); const signal = playController.signal
  playing = file; playingLibraryId = requiredId; playingRoot = null; queue = previousQueue; restored = false; duration = 0; selectedSubtitle = ''; restoredAudio = undefined; subtitleTracks = []; subtitleExplicit = false; failedPlayback = false
  closeDetail(); art?.clear(); pageController.abort(); showPlayer(true); player.focus()
  text('playing-title', title(file.name)); text('play-mode', '正在准备播放…'); text('play-message', '正在读取视频信息…'); show('play-message', true)
  show('big-play', false); show('play-options', false); syncStatus('', false); text('current-time', '0:00'); text('duration', '0:00'); $<HTMLInputElement>('seek').value = '0'
  $('subtitle').replaceChildren(new Option('关闭字幕', '')); $('audio').replaceChildren(new Option('默认音轨', ''))
  $<HTMLButtonElement>('previous-episode').disabled = queue.findIndex(e => e.id === file.id) <= 0
  $<HTMLButtonElement>('next-episode').disabled = queue.findIndex(e => e.id === file.id) >= queue.length - 1
  try {
    await immersive(true); signal.throwIfAborted()
    const { file: current, library: root } = await scopedVideo(file, signal, requiredId)
    signal.throwIfAborted(); playing = current; playingRoot = root; playingLibraryId = root.id; text('playing-title', title(current.name))
    library.setScope(root.directoryPath)
    const retainQueue = providedQueue?.every(item => parentPath(item.path) === parentPath(current.path) && withinDirectory(item.path, root.directoryPath))
    queue = retainQueue ? providedQueue! : [current]
    $<HTMLButtonElement>('previous-episode').disabled = queue.findIndex(item => item.id === current.id) <= 0
    $<HTMLButtonElement>('next-episode').disabled = queue.findIndex(item => item.id === current.id) >= queue.length - 1
    store = new ProgressStore(drive, current, (message, conflict) => { if (active === playGeneration) syncStatus(message, conflict) })
    let progress: CinemaProgress | null = null
    try { progress = await store.load() } catch { syncStatus('无法读取历史，暂不保存进度；请关闭并重试', false) }
    signal.throwIfAborted()
    selectedSubtitle = progress?.subtitle ?? ''; subtitleExplicit = progress?.subtitle !== undefined; restoredAudio = progress?.audio
    const target = !restart && progress && !progress.completed ? progress.seconds : 0
    const sessionStore = store
    session = new PlaybackSession(drive, current, video, scheduler, {
      info: info => { if (active === playGeneration) updateInfo(info) },
      ready: () => { if (active !== playGeneration) return; restored = true; sessionStore.restored(); show('play-message', false); applyPreferences(); handle(loadSelectedSubtitle()); },
      error: message => { if (active !== playGeneration) return; failedPlayback = true; text('play-message', message); show('play-message', true); show('big-play', true); video.pause() },
      note: message => { if (active === playGeneration) toast(message) },
    })
    applyPreferences(); await session.start(target, restoredAudio)
    signal.throwIfAborted()
    void library.directory(parentPath(current.path), signal, true).then(({ files, complete }) => {
      if (active !== playGeneration) return
      if (!retainQueue) {
        queue = complete ? files.filter(item => isVideo(item) && withinDirectory(item.path, root.directoryPath)).sort(naturalOrder) : [current]
        $<HTMLButtonElement>('previous-episode').disabled = queue.findIndex(f => f.id === current.id) <= 0
        $<HTMLButtonElement>('next-episode').disabled = queue.findIndex(f => f.id === current.id) >= queue.length - 1
      }
      subtitleTracks = [...subtitleFiles(current, files).map(f => ({ key: `file:${f.id}`, label: f.name, file: f })), ...subtitleTracks.filter(t => t.embeddedId !== undefined)]
      updateSubtitleOptions()
    }).catch(error => { if (!signal.aborted) report(error) })
  } catch (error) { if (active === playGeneration && !signal.aborted) { failedPlayback = true; text('play-message', (error as Error).message); show('play-message', true); show('big-play', true) } }
}
function updateInfo(info: PlaybackInfo) {
  duration = info.duration; text('duration', timeText(duration)); text('play-mode', info.mode)
  $<HTMLInputElement>('seek').max = String(duration || 100); $<HTMLInputElement>('seek').disabled = !info.seekable || !duration
  $('audio').replaceChildren(...(info.audio.length ? info.audio.map(a => new Option(a.label, String(a.id))) : [new Option('默认音轨（浏览器不支持网页切轨）', '')]))
  if (restoredAudio !== undefined && info.audio.some(a => a.id === restoredAudio)) $<HTMLSelectElement>('audio').value = String(restoredAudio)
  $<HTMLSelectElement>('audio').disabled = !info.audio.length
  subtitleTracks = [...subtitleTracks.filter(t => t.file), ...info.subtitles]; updateSubtitleOptions()
}
function updateSubtitleOptions() {
  $('subtitle').replaceChildren(new Option('关闭字幕', ''), ...subtitleTracks.map(track => new Option(track.label, track.key)))
  if (!subtitleExplicit && !selectedSubtitle) selectedSubtitle = subtitleTracks.find(t => t.file || t.codec?.startsWith('S_TEXT/'))?.key ?? ''
  // 外挂字幕和内嵌轨异步到达，不能因另一批先到而抹掉已保存的选择。
  if (!subtitleTracks.some(t => t.key === selectedSubtitle)) return
  $<HTMLSelectElement>('subtitle').value = selectedSubtitle
  if (restored && session?.canSave) handle(loadSelectedSubtitle())
}
async function loadSelectedSubtitle() {
  subtitleController.abort(); subtitleController = new AbortController()
  const signal = AbortSignal.any([playController.signal, subtitleController.signal]), track = subtitleTracks.find(t => t.key === selectedSubtitle)
  captions.clear(); captionWindowAt = -Infinity; captionLoading = false
  if (!track) return
  if (track.file) {
    const current = await access.stat({ id: track.file.id }, signal)
    requireDirectory(playingRoot?.directoryPath ?? null, current.path)
    if (current.content_version !== track.file.content_version || parentPath(current.path) !== parentPath(playing!.path)) throw new Error('字幕已移动或内容改变，请重新打开影片')
    const file = new RangeFile(drive, current, signal, scheduler)
    const cues = await readSubtitle(file, pref.encoding); file.clear(); signal.throwIfAborted(); captions.set(cues, pref.subtitleOffset)
  } else await refreshEmbedded(true)
}
async function refreshEmbedded(force = false) {
  const track = subtitleTracks.find(t => t.key === selectedSubtitle), activeSession = session, currentTime = video.currentTime
  if (!track?.embeddedId || !activeSession || captionLoading || !restored || (!force && currentTime >= captionWindowAt - 5 && currentTime < captionWindowAt + 20)) return
  captionLoading = true
  const generation = playGeneration, choice = selectedSubtitle, subtitleSignal = subtitleController.signal
  try {
    const cues = await activeSession.embedded(track, currentTime)
    if (subtitleSignal.aborted || generation !== playGeneration || choice !== selectedSubtitle || session !== activeSession) return
    captions.set(cues, pref.subtitleOffset); captionWindowAt = currentTime
  } catch (error) { if (!isAbort(error) && !subtitleSignal.aborted && generation === playGeneration) { captionWindowAt = currentTime; toast((error as Error).message) } }
  finally { if (generation === playGeneration && subtitleController.signal === subtitleSignal) captionLoading = false }
}
async function seek(seconds: number) {
  if (!session) return
  const activeSession = session, generation = playGeneration
  cancelNext(); captions.clear(); captionWindowAt = -Infinity
  try { await activeSession.seek(seconds) }
  catch (error) {
    if (isAbort(error) || generation !== playGeneration || session !== activeSession) return
    failedPlayback = true; text('play-message', `${(error as Error).message}；可重新点击播放重试`); show('play-message', true); throw error
  }
  if (generation !== playGeneration || session !== activeSession) return
  if (activeSession.currentInfo.mode === '原生播放') { persist(true); handle(loadSelectedSubtitle()) }
}
async function closePlayer(reload = true, keepIntent = false) {
  if (!keepIntent) startIntent++
  if (player.hidden && !session && !playing) return
  cancelNext(); persist(true)
  const oldStore = store
  restored = false; playGeneration++; subtitleController.abort(); playController.abort()
  session?.stop(); session = undefined; captions.clear(); oldStore?.stop(); store = undefined
  if (document.pictureInPictureElement) await document.exitPictureInPicture().catch(() => {})
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => {})
  showPlayer(false); show('play-options', false); player.classList.remove('css-fullscreen'); playing = undefined; playingRoot = null; playingLibraryId = undefined
  await Promise.all([oldStore?.flush(), immersive(false)])
  if (reload) { await loadPage(); $('main').focus() }
}
async function togglePlay() {
  cancelNext()
  if ((!session || failedPlayback || video.error) && playing) return startPlayback(playing, false, queue)
  if (video.paused) await session?.play(); else video.pause()
}
async function goEpisode(delta: number) { const index = queue.findIndex(f => f.id === playing?.id), file = queue[index + delta]; if (file) await startPlayback(file, false, queue) }
function cancelNext() { clearInterval(nextTimer); nextTimer = undefined; show('next-countdown', false) }
function ended() {
  persist(true)
  cancelNext()
  if (!pref.autoplay || queue.findIndex(f => f.id === playing?.id) >= queue.length - 1) return
  let remaining = 5; show('next-countdown', true); text('countdown-text', `${remaining} 秒后播放下一集`)
  nextTimer = setInterval(() => { remaining--; text('countdown-text', `${remaining} 秒后播放下一集`); if (!remaining) { cancelNext(); handle(goEpisode(1)) } }, 1000)
}
async function fullscreen() {
  if (document.fullscreenElement) { await document.exitFullscreen(); return }
  if (player.classList.contains('css-fullscreen')) { player.classList.remove('css-fullscreen'); $('fullscreen').setAttribute('aria-label', '全屏播放'); return }
  if (player.requestFullscreen) { try { await player.requestFullscreen(); return } catch { /* 拒绝后继续降级，不影响正常播放。 */ } }
  const v = video as HTMLVideoElement & { webkitEnterFullscreen?: () => void }
  if (v.webkitEnterFullscreen && v.readyState) { try { v.webkitEnterFullscreen(); return } catch { /* 使用页面沉浸。 */ } }
  player.classList.add('css-fullscreen'); $('fullscreen').setAttribute('aria-label', '退出全屏'); toast('已进入页面沉浸，可使用返回或退出全屏按钮离开')
}

for (const button of document.querySelectorAll<HTMLElement>('[data-nav]')) button.onclick = () => handle(navigate(button.dataset.nav as typeof view))
document.querySelector('.brand')!.addEventListener('click', event => { event.preventDefault(); handle(navigate('home')) })
for (const id of ['source','empty-source','new-library']) on(id, 'click', () => manager.edit())
for (const id of ['settings','mobile-source','library-back']) on(id, 'click', () => navigate('library'))
on('library-edit-current', 'click', () => { const item = configSnapshot?.config.libraries.find(item => item.id === activeLibraryId); if (item) return manager.edit(item) })
for (const id of ['exit','mobile-exit']) on(id, 'click', async () => { await closePlayer(false); await manager.flush(); await drive.ui.close() })
on('refresh', 'click', () => { closeDetail(); library.clear(); resetPages(); return loadPage() })
on('directory-mode', 'click', () => { if (!currentRoot) return; directoryMode = !directoryMode; directory = currentRoot.directoryPath; resetPages(); return loadPage() })
function searchInLibrary() { if (!currentRoot) return; query = value('search').trim(); format = value('format'); directoryMode = false; resetPages(); return loadPage() }
on('search-submit', 'click', searchInLibrary)
on('search', 'keydown', event => { const key = event as KeyboardEvent; if (key.key === 'Enter' && !key.isComposing) { event.preventDefault(); return searchInLibrary() } })
on('format', 'change', () => { if (!currentRoot) return; format = value('format'); directoryMode = false; resetPages(); return loadPage() })
on('next-page', 'click', () => { if (nextCursor) { cursors[++pageIndex] = nextCursor; return loadPage() } })
on('previous-page', 'click', () => { if (pageIndex) { pageIndex--; return loadPage() } })
on('hero-play', 'click', () => heroFile && startPlayback(heroFile)); on('hero-detail', 'click', () => heroFile && openDetail(heroFile))
on('detail-close', 'click', closeDetail)
on('detail', 'cancel', event => { event.preventDefault(); closeDetail(); previousFocus?.focus() })
on('detail-play', 'click', () => selected && startPlayback(selected, false, episodesComplete ? episodes : []))
on('detail-restart', 'click', () => selected && startPlayback(selected, true, episodesComplete ? episodes : []))
on('detail-favorite', 'click', toggleFavorite)
on('detail-download', 'click', () => selected && downloadVideo(selected, detailLibraryId, detailController.signal))
on('episodes-prev', 'click', () => { if (episodePage) { episodePage--; renderEpisodes() } })
on('episodes-next', 'click', () => { episodePage++; renderEpisodes() })
clearHistory.onclick = () => handle((async () => {
  if (!await confirmAction('清空观看历史？', '将删除全部观看进度，包括库外隐藏记录，其他设备也会同步；不删除原视频、媒体库配置或收藏。')) return
  let deleted = 0
  while (deleted < 10000) {
    const page = await drive.storage.list({ prefix: 'progress:', limit: 100 })
    if (!page.records.length) break
    for (const record of page.records) { await drive.storage.delete(record.key, record.revision); deleted++; await new Promise(resolve => setTimeout(resolve, 120)) }
  }
  toast('观看历史已清空'); await loadPage()
})())
on('player-back', 'click', () => closePlayer())
on('player-download', 'click', () => playing && downloadVideo(playing, playingLibraryId, playController.signal))
on('big-play', 'click', togglePlay); on('toggle-play', 'click', togglePlay)
on('rewind', 'click', () => seek(video.currentTime - 10)); on('forward', 'click', () => seek(video.currentTime + 10))
on('seek', 'change', () => seek(Number(value('seek'))))
on('previous-episode', 'click', () => goEpisode(-1)); on('next-episode', 'click', () => goEpisode(1))
on('mute', 'click', () => { video.muted = !video.muted; $('mute').setAttribute('aria-pressed', String(video.muted)) })
on('volume', 'input', () => { video.volume = Number(value('volume')); video.muted = false })
on('speed', 'change', () => { pref.speed = Number(value('speed')); return savePreferences() })
on('fit', 'change', () => { pref.fit = value('fit') === 'cover' ? 'cover' : 'contain'; return savePreferences() })
on('autoplay', 'change', () => { pref.autoplay = $<HTMLInputElement>('autoplay').checked; if (!pref.autoplay) cancelNext(); return savePreferences() })
on('subtitle-size', 'change', () => { pref.subtitleSize = Number(value('subtitle-size')); return savePreferences() })
on('subtitle-offset', 'change', () => { pref.subtitleOffset = Math.max(-10, Math.min(10, Number(value('subtitle-offset')) || 0)); return savePreferences() })
on('subtitle', 'change', async () => { selectedSubtitle = value('subtitle'); subtitleExplicit = true; persist(true); await loadSelectedSubtitle() })
on('encoding', 'change', async () => { pref.encoding = value('encoding') === 'gb18030' ? 'gb18030' : 'utf-8'; await savePreferences(); await loadSelectedSubtitle() })
on('audio', 'change', async () => {
  if (!session) return
  persist(true)
  const activeSession = session, generation = playGeneration, previous = session.selectedAudio
  restoredAudio = Number(value('audio'))
  try { await activeSession.selectAudio(restoredAudio) }
  catch (error) {
    if (isAbort(error) || generation !== playGeneration || session !== activeSession) return
    failedPlayback = true; restoredAudio = previous; text('play-message', `${(error as Error).message}；可重新选择音轨或点击播放重试`); show('play-message', true); throw error
  }
})
on('options-toggle', 'click', () => show('play-options', $('play-options').hidden)); on('options-close', 'click', () => show('play-options', false))
on('cancel-next', 'click', cancelNext); on('fullscreen', 'click', fullscreen)
show('pip', !!document.pictureInPictureEnabled)
on('pip', 'click', async () => { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await video.requestPictureInPicture() })
on('sync-retry', 'click', () => store?.flush())
on('sync-remote', 'click', async () => { const remote = await store?.resolve(true); if (remote) await seek(remote.seconds) })
on('sync-local', 'click', () => store?.resolve(false))
video.addEventListener('timeupdate', () => {
  text('current-time', timeText(video.currentTime)); if (document.activeElement !== $('seek')) $<HTMLInputElement>('seek').value = String(video.currentTime)
  persist(); handle(refreshEmbedded())
})
video.addEventListener('playing', () => { show('big-play', false); show('play-message', false); $('toggle-play').replaceChildren(icon('pause')) })
video.addEventListener('pause', () => { show('big-play', true); $('toggle-play').replaceChildren(icon('play')); persist(true) })
video.addEventListener('waiting', () => { if (restored && !video.paused) { text('play-message', '正在缓冲…'); show('play-message', true) } })
video.addEventListener('ended', ended)
video.addEventListener('click', () => handle(togglePlay()))
let touch: { x: number; y: number; at: number } | undefined, tap: { side: number; at: number } | undefined
$('stage').addEventListener('touchstart', event => { if (event.touches.length !== 1 || (event.target as HTMLElement).closest('button,input,select')) { touch = undefined; return } touch = { x: event.touches[0].clientX, y: event.touches[0].clientY, at: Date.now() } }, { passive: true })
$('stage').addEventListener('touchmove', event => { if (event.touches.length !== 1 || touch && (Math.abs(event.touches[0].clientX - touch.x) > 18 || Math.abs(event.touches[0].clientY - touch.y) > 18)) touch = undefined }, { passive: true })
$('stage').addEventListener('touchcancel', () => { touch = undefined; tap = undefined }, { passive: true })
$('stage').addEventListener('touchend', event => {
  if (!touch || event.touches.length || Date.now() - touch.at > 280) { touch = undefined; return }
  const box = $('stage').getBoundingClientRect(), ratio = (touch.x - box.left) / box.width, side = ratio < .35 ? -1 : ratio > .65 ? 1 : 0
  if (side && tap?.side === side && Date.now() - tap.at < 350) { handle(seek(video.currentTime + side * 10)); tap = undefined }
  else tap = { side, at: Date.now() }
  touch = undefined
}, { passive: true })
player.addEventListener('keydown', event => {
  if (event.isComposing || event.defaultPrevented) return
  if (event.key === 'Tab') {
    const controls = Array.from(player.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href],[tabindex]')).filter(node => node.tabIndex >= 0 && !node.matches(':disabled') && node.getClientRects().length > 0)
    const first = controls[0], last = controls.at(-1)
    if (!first) { event.preventDefault(); player.focus() }
    else if (event.shiftKey && (document.activeElement === first || document.activeElement === player)) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault(); event.stopPropagation()
    if (!$('play-options').hidden) { show('play-options', false); $('options-toggle').focus() }
    else if (player.classList.contains('css-fullscreen')) handle(fullscreen())
    else if (!document.fullscreenElement) handle(closePlayer())
    return
  }
  if ((event.target as HTMLElement).closest('input,select,textarea,[contenteditable=true]')) return
  if ((event.target as HTMLElement).closest('button') && [' ', 'Enter'].includes(event.key)) return
  const actions: Record<string, () => unknown> = { ' ': togglePlay, ArrowLeft: () => seek(video.currentTime - 10), ArrowRight: () => seek(video.currentTime + 10), ArrowUp: () => { video.volume = Math.min(1, video.volume + .1) }, ArrowDown: () => { video.volume = Math.max(0, video.volume - .1) }, m: () => { video.muted = !video.muted }, f: fullscreen }
  const action = actions[event.key] ?? actions[event.key.toLowerCase()]
  if (action) { event.preventDefault(); handle(action()) }
})
document.addEventListener('visibilitychange', () => { if (document.hidden && !document.pictureInPictureElement) { video.pause(); persist(true) } })
drive.on('beforeClose', async () => { persist(true); const pending = store?.flush(); restored = false; session?.stop(); session = undefined; pageController.abort(); detailController.abort(); playController.abort(); await Promise.all([pending, manager.flush(), prefSaving]) })

// —— 宿主事件：跨设备进度、媒体库与文件树变化时去抖刷新列表 ——
let hostEventTimer: ReturnType<typeof setTimeout> | undefined
const inPlayback = () => !!session || !$('player').hidden
const dialogOpen = () => !!document.querySelector('dialog[open]')
function refreshLists() {
  if (hostEventTimer) clearTimeout(hostEventTimer)
  hostEventTimer = setTimeout(() => {
    hostEventTimer = undefined
    // 播放、详情、编辑或确认弹窗打开时不打扰，关闭后既有流程会刷新。
    if (inPlayback() || dialogOpen()) return
    handle(loadPage())
  }, 800)
}
drive.on('storage.changed', (value) => {
  const key = typeof (value as { key?: string })?.key === 'string' ? (value as { key: string }).key : ''
  if (key !== 'media-libraries' && !key.startsWith('progress:') && !key.startsWith('favorite:')) return
  // 自身写入经服务端回流时不重拉，避免打断当前操作。
  if (drive.storage.wroteRecently?.(key)) return
  refreshLists()
})
drive.on('files.changed', (value) => {
  // 新宿主附带变更目录：与任何媒体库文件夹无关的变化不刷新；旧宿主无参数时照常刷新。
  const paths = (value as { paths?: unknown } | undefined)?.paths
  if (configSnapshot && !filesChangeAffectsLibraries(configSnapshot.config.libraries, paths)) return
  refreshLists()
})
drive.on('sync.hint', refreshLists)
drive.on('scope.changed', refreshLists)
window.addEventListener('pagehide', () => { pageController.abort(); detailController.abort(); playController.abort(); subtitleController.abort(); manager.stop(); session?.stop(); store?.stop(); art?.clear(); detailArt?.clear(); library.setScope(null); cancelNext(); clearTimeout(toastTimer) }, { once: true })
async function boot() {
  await drive.ready
  const saved = await drive.storage.get<CinemaPreferences>('preferences')
  prefRecord = saved; pref = preferences(saved?.value); applyPreferences()
  show('app', true); show('boot-status', false); await loadPage()
}
void boot().catch(error => text('boot-status', `影院暂时无法打开：${(error as Error).message}。请从应用中心重新打开。`))
