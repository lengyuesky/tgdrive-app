/** 两个独立插件共用的书库和阅读外壳，只依赖公开 SDK。 */
import type { Drive, FileEntry, RecordValue, Search } from '../sdk/types'
import { extension, isImage, isAbort, gate } from './io'
import { ProgressStore, defaults, preferences, validLocation, type Location, type Preferences, type Progress } from './state'
import type { ReaderView, ViewContext } from './view'
import { ReaderChrome } from './chrome'
import './style.css'
export interface CoverLoader {
  observe(container: HTMLElement, file: FileEntry): void
  clear(): void
  destroy(): void
}
interface AppOptions {
  kind: 'books' | 'comics'
  create: (context: ViewContext) => Promise<ReaderView>
  createCoverLoader?: (drive: Drive, signal: AbortSignal) => CoverLoader
}
interface Bookmark { title: string; location: Location; content_version: string }
export async function startApp(options: AppOptions) {
  const drive: Drive = window.tgdrive
  const root = document.getElementById('app')!
  root.innerHTML = `
    <header class="app-header"><div class="brand"><span class="brand-mark" aria-hidden="true"></span><div><h1 id="app-title"></h1><p id="app-subtitle"></p></div></div><div class="header-actions"><button id="settings">目录设置</button><button id="close">返回网盘</button></div></header>
    <p id="notice" role="alert" hidden></p>
    <section id="library" class="library"><div class="library-tools"><div class="tabs"><button id="all" aria-pressed="true">内容库</button><button id="recent" aria-pressed="false">最近阅读</button></div><input id="search" type="search" placeholder="搜索文件名" aria-label="搜索文件名" /><button id="refresh">刷新</button></div><div class="source-line"><button id="up" hidden>上级目录</button><span id="source"></span><button id="read-folder" hidden>阅读本目录图片</button></div><div id="library-status" role="status"></div><div id="items" class="library-grid"></div><div class="pagination"><button id="page-previous" disabled>上一批</button><span id="batch">第 1 批</span><button id="page-next" disabled>下一批</button></div></section>
    <section id="reader" class="reader" hidden>
      <button id="reader-menu-toggle" class="focus-menu">显示阅读菜单</button>
      <button id="reader-backdrop" class="reader-backdrop" aria-label="关闭阅读面板" tabindex="-1" hidden></button>
      <div class="reader-toolbar"><button id="back">返回内容库</button><h2 id="book-title"></h2>
        <div id="reader-desktop-actions"><div id="reader-actions"><button id="toc-toggle" class="mobile-only">目录</button><button id="preferences-toggle">阅读设置</button><button id="bookmarks-toggle">书签</button></div></div>
        <button id="reader-more-toggle" class="mobile-only">更多</button>
        <div id="reader-more" class="reader-more" aria-label="更多操作"><div class="panel-heading mobile-only"><strong>更多操作</strong><button data-close-panel>关闭</button></div><button id="download">下载原文件</button><button id="reader-settings" class="mobile-only">目录设置</button><button id="reader-close" class="mobile-only">返回网盘</button></div>
      </div>
      <div id="preferences" class="preferences" aria-label="阅读设置" hidden><div class="panel-heading mobile-only"><strong>阅读设置</strong><button data-close-panel>关闭</button></div><label>主题<select id="theme"><option value="system">跟随主站</option><option value="light">明亮</option><option value="sepia">护眼</option><option value="dark">深色</option></select></label><label class="flow-option">字号<input id="font-size" type="range" min="12" max="36" step="1" /></label><label class="flow-option">行距<input id="line-height" type="range" min="1.2" max="2.8" step="0.1" /></label><label class="flow-option width-option">正文宽度<input id="width" type="range" min="360" max="1400" step="20" /></label><label id="encoding-option" hidden>文本编码<select id="encoding"><option value="utf-8">UTF-8</option><option value="utf-16le">UTF-16 LE</option><option value="utf-16be">UTF-16 BE</option><option value="gb18030">GB18030 / GBK</option></select></label><label id="mode-option" hidden>阅读模式<select id="mode"><option value="scroll">上下滚动</option><option value="page">单页翻页</option></select></label><label id="direction-option" hidden>翻页方向<select id="direction"><option value="ltr">从左到右</option><option value="rtl">从右到左</option></select></label><label id="zoom-option" hidden>缩放<select id="zoom"><option value="0.5">50%</option><option value="0.75">75%</option><option value="1">适合宽度</option><option value="1.25">125%</option><option value="1.5">150%</option><option value="2">200%</option><option value="3">300%</option></select></label></div>
      <div id="bookmarks" class="bookmarks-panel" aria-label="书签" hidden><div class="panel-heading mobile-only"><strong>书签</strong><button data-close-panel>关闭</button></div><div class="bookmark-tools"><input id="bookmark-name" maxlength="120" placeholder="书签名称（可选）" aria-label="书签名称" /><button id="add-bookmark">添加当前位置</button><button id="bookmark-more" hidden>更多书签</button></div><div id="bookmark-items"></div></div>
      <div id="conflict" class="conflict" role="alert" hidden><span>另一设备更新了进度，已暂停自动覆盖。</span><button id="use-cloud">使用已保存进度</button><button id="use-current">从当前页继续并保存</button></div>
      <div id="reading-status" role="status"></div><main id="viewport" class="reading-viewport" tabindex="0" aria-label="阅读内容"></main>
      <footer class="reader-footer"><div class="reader-footer-line"><button id="previous">上一页 / 章</button><div id="navigation" class="reader-navigation" aria-label="阅读目录"><div class="panel-heading mobile-only"><strong>阅读目录</strong><button data-close-panel>关闭</button></div><label>目录<select id="toc" aria-label="阅读目录"></select></label><label class="jump-label"><span id="jump-label">位置</span><input id="jump" type="number" min="1" aria-label="页码或章节" /></label><button id="jump-button">跳转</button></div><span id="position"></span><button id="next">下一页 / 章</button><span id="sync" role="status"></span><button id="retry-save">重试同步</button><button id="retry-reader" hidden>重试打开</button></div><div id="reader-footer-actions"></div></footer>
    </section>`
  const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
  const show = (id: string, visible: boolean) => { get(id).hidden = !visible }
  const text = (id: string, value: string) => { get(id).textContent = value }
  const bind = (id: string, action: () => unknown) => get(id).addEventListener('click', () => { try { Promise.resolve(action()).catch(report) } catch (error) { report(error) } })
  let noticeTimer: ReturnType<typeof setTimeout> | undefined
  let chrome: ReaderChrome | undefined
  let stopped = false
  const appLifecycle = new AbortController()
  const coverLoader = options.createCoverLoader?.(drive, appLifecycle.signal)
  function errorText(error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return /[\u3400-\u9fff]/.test(message) ? message : `读取失败：${message}。文件可能损坏或包含不支持的结构，可重试或下载原文件。`
  }
  function report(error: unknown) {
    if (isAbort(error) || stopped) return
    chrome?.reveal()
    text('notice', errorText(error)); show('notice', true)
    clearTimeout(noticeTimer); noticeTimer = setTimeout(() => show('notice', false), 7000)
  }
  const context = await drive.ready
  let dark = context.dark, prefs = { ...defaults }
  let source = '/', directory = '/', recent = false, query = ''
  let pages: (string | null)[] = [null], batch = 0, next: string | null = null
  let libraryController = new AbortController(), libraryGeneration = 0
  let bookController = new AbortController(), bookGeneration = 0
  let currentFile: FileEntry | undefined, view: ReaderView | undefined, store: ProgressStore | undefined, canSave = false, readerReady = false
  let navigationQueue = Promise.resolve()
  let bookmarkCursor: string | null = null
  const tocValues = new Map<string, Location>()
  let jumpDirty = false
  let prefQueue = Promise.resolve()
  const isBooks = options.kind === 'books'
  text('app-title', isBooks ? '图书' : '漫画')
  text('app-subtitle', isBooks ? '把网盘变成随身书房' : '按自己的节奏，翻开下一页')
  root.dataset.kind = options.kind
  document.title = context.name
  const pageGestures = () => {
    if (!view) return false
    const format = view.current().format
    if (format === 'comic') return prefs.mode === 'page' && prefs.zoom <= 1
    return format === 'pdf' ? prefs.zoom <= 1 && get('viewport').scrollWidth <= get('viewport').clientWidth + 2 : ['txt', 'epub'].includes(format) && prefs.mode === 'page'
  }
  chrome = new ReaderChrome(root, { immersive: true, drive, context, paged: pageGestures,
    turn: (delta) => {
      const actualDelta = (!isBooks && prefs.direction === 'rtl') ? (-delta as -1 | 1) : delta
      void navigate(() => view!.turn(actualDelta)).catch(report)
    }, error: report })
  const applyTheme = () => {
    document.body.dataset.theme = prefs.theme === 'system' ? dark ? 'dark' : 'light' : prefs.theme
    void chrome?.themeChanged()
  }
  function syncPreferences() {
    for (const [id, key] of Object.entries({ theme: 'theme', 'font-size': 'fontSize', 'line-height': 'lineHeight', width: 'width', mode: 'mode', direction: 'direction', zoom: 'zoom' })) get<HTMLInputElement>(id).value = String(prefs[key as keyof Preferences])
    get('viewport').dataset.mode = prefs.mode
    applyTheme()
  }
  function capture(immediate = false) {
    if (!view || !currentFile || !view.sections.length) return
    const location = view.current()
    const state = view.navigationState(), flow = ['txt', 'epub'].includes(location.format)
    text('position', flow && state.pageIndex !== undefined
      ? `本节 ${state.pageIndex + 1}/${state.pageCount} 页 · ${view.sections[state.sectionIndex]?.label ?? '正文'}`
      : `${location.index + 1} / ${view.sections.length}`)
    Object.assign(get('position').dataset, { section: String(state.sectionIndex), page: String(state.pageIndex ?? 0), pages: String(state.pageCount ?? 0) })
    get('viewport').dataset.swipe = String(pageGestures())
    text('jump-label', flow ? '章节 / 分段' : '页码')
    text('previous', flow && state.pageIndex === undefined ? '上一节' : '上一页')
    text('next', flow && state.pageIndex === undefined ? '下一节' : '下一页')
    if (!jumpDirty) get<HTMLInputElement>('jump').value = String(location.index + 1)
    get<HTMLInputElement>('jump').max = String(view.sections.length)
    const select = get<HTMLSelectElement>('toc')
    if (tocValues.get(select.value)?.index !== location.index) select.value = [...tocValues].find(([, target]) => target.index === location.index)?.[0] ?? ''
    get<HTMLButtonElement>('previous').disabled = !state.canPrevious
    get<HTMLButtonElement>('next').disabled = !state.canNext
    const encoding = (view as ReaderView & { encoding?: string }).encoding
    if (encoding) get<HTMLSelectElement>('encoding').value = encoding
    if (canSave && validLocation(location)) store?.mark({ file: currentFile, title: view.title, location }, immediate)
  }
  async function closeReader() {
    capture()
    const previous = store
    canSave = false; readerReady = false; bookGeneration++; bookController.abort(); view?.destroy(); previous?.stop()
    view = undefined; store = undefined; currentFile = undefined
    show('reader', false); show('library', true); show('preferences', false); show('bookmarks', false)
    await Promise.all([previous?.flush(), chrome?.leave()])
  }
  function toc() {
    const select = get<HTMLSelectElement>('toc'); select.replaceChildren(); tocValues.clear()
    if (!view) return
    const format = view.current().format
    const entries = view.navigation?.length ? view.navigation : view.sections.map((section, index) => ({ label: section.label, location: { format, index, entry: section.entry } }))
    entries.forEach((item, index) => { const option = document.createElement('option'); option.value = String(index); option.textContent = item.label; select.append(option); tocValues.set(option.value, item.location) })
  }
  async function openEntry(requested: FileEntry) {
    capture()
    coverLoader?.clear()
    const oldStore = store
    canSave = false; readerReady = false; bookController.abort(); view?.destroy(); oldStore?.stop()
    const flushed = oldStore?.flush()
    libraryController.abort(); libraryGeneration++
    view = undefined; store = undefined
    const active = ++bookGeneration
    bookController = new AbortController(); const signal = bookController.signal
    currentFile = requested
    show('library', false); show('reader', true); show('conflict', false); show('retry-reader', false); show('bookmarks', false)
    get('viewport').replaceChildren(); get('viewport').dataset.format = ''; get('viewport').dataset.mode = ''; get('viewport').dataset.swipe = 'false'; get('toc').replaceChildren()
    jumpDirty = false
    text('position', ''); text('book-title', requested.name); text('reading-status', '正在读取内容，请稍候…'); text('sync', '')
    let owned: ReaderView | undefined
    try {
      await chrome?.enter(); signal.throwIfAborted()
      const file = await drive.files.stat({ id: requested.id }, { signal }); signal.throwIfAborted()
      currentFile = file
      await flushed; signal.throwIfAborted()
      const activeStore = new ProgressStore(drive, file, (message, conflict) => { if (active === bookGeneration) {
        text('sync', message); show('conflict', conflict)
        if (conflict || message.includes('失败')) chrome?.reveal()
      } })
      store = activeStore
      const saved = await activeStore.load(); signal.throwIfAborted()
      const reading: ViewContext = { drive, file, signal, prefs, viewport: get('viewport'), navigate, changed: () => { if (active === bookGeneration) capture() }, error: (error) => { if (active === bookGeneration) report(error) } }
      owned = await options.create(reading); signal.throwIfAborted()
      view = owned
      const savedLocation = saved?.file?.content_version === file.content_version ? saved.location : undefined
      await owned.open(savedLocation); signal.throwIfAborted()
      if (reading.prefs !== prefs) await owned.configure(prefs)
      signal.throwIfAborted()
      if (active !== bookGeneration) return
      text('book-title', [owned.title, owned.author].filter(Boolean).join(' · ')); text('reading-status', ''); toc()
      const format = owned.current().format
      get('viewport').dataset.format = format
      get('viewport').dataset.mode = prefs.mode
      for (const el of document.querySelectorAll<HTMLElement>('.flow-option')) el.hidden = !['txt', 'epub'].includes(format)
      show('encoding-option', format === 'txt'); show('mode-option', ['txt','epub','comic'].includes(format)); show('direction-option', format === 'comic'); show('zoom-option', ['comic','pdf'].includes(format)); show('download', !file.is_dir)
      readerReady = true; canSave = true; capture(true); chrome?.opened()
    } catch (error) {
      owned?.destroy()
      if (active === bookGeneration && !isAbort(error)) {
        view = undefined; await chrome?.leave()
        text('reading-status', errorText(error)); show('retry-reader', true); report(error)
      }
    }
  }
  async function loadLibrary(reset = false) {
    libraryController.abort(); libraryController = new AbortController()
    const signal = libraryController.signal, active = ++libraryGeneration
    coverLoader?.clear()
    if (reset) { pages = [null]; batch = 0 }
    text('source', `${recent ? '最近阅读 · ' : ''}${directory === '/' ? '整库' : directory}`)
    show('up', !isBooks && directory !== source && !recent); show('read-folder', false)
    text('library-status', '正在加载…'); get('items').replaceChildren()
    get<HTMLButtonElement>('page-previous').disabled = true; get<HTMLButtonElement>('page-next').disabled = true
    get('all').setAttribute('aria-pressed', String(!recent)); get('recent').setAttribute('aria-pressed', String(recent))
    try {
      let items: FileEntry[] = [], followingCursor: string | null = null, hasPictures = false
      if (recent) {
        const records = await drive.storage.list<Progress>({ prefix: 'progress:', limit: 20, cursor: pages[batch] }, { signal })
        const resolved = await Promise.all(records.records.map((record) => gate.run(signal, async () => {
          const id = record.value?.file?.id
          if (!Number.isSafeInteger(id) || !validLocation(record.value?.location)) return null
          try { return await drive.files.stat({ id: id! }, { signal }) } catch (error) { if (isAbort(error)) throw error; return null }
        })))
        items = resolved.filter((file): file is FileEntry => !!file && (source === '/' || file.path === source || file.path.startsWith(`${source}/`)) && (!query || file.name.toLowerCase().includes(query.toLowerCase())))
        followingCursor = records.next_cursor
      } else if (isBooks || query) {
        const params: Search = { under: directory, kind: isBooks ? 'file' : 'all', extensions: isBooks ? ['txt','epub','pdf'] : ['cbz','zip'], q: query, limit: 60, cursor: pages[batch] }
        const result = await drive.files.searchPage(params, { signal }); items = result.results; followingCursor = result.next_cursor
      } else {
        const result = await drive.files.list({ path: directory, limit: 60, cursor: pages[batch] }, { signal })
        hasPictures = result.entries.some((file) => !file.is_dir && isImage(file.name))
        items = result.entries.filter((file) => file.is_dir || ['cbz','zip'].includes(extension(file.name)))
        followingCursor = result.next_cursor
      }
      signal.throwIfAborted(); if (active !== libraryGeneration) return
      next = followingCursor; show('read-folder', hasPictures)
      for (const file of items) {
        const card = document.createElement('button'); card.className = 'library-card'; card.dataset.fileId = String(file.id)
        if (isBooks) {
          const mark = document.createElement('span'), name = document.createElement('strong'), info = document.createElement('span')
          mark.className = 'file-mark'; mark.textContent = file.is_dir ? '目录' : extension(file.name).toUpperCase()
          name.textContent = file.name; info.className = 'file-meta'; info.textContent = file.path
          card.append(mark, name, info)
        } else {
          const cover = document.createElement('div'); cover.className = 'card-cover'
          const art = document.createElement('div'); art.className = 'cover-art'
          const initial = document.createElement('span'); initial.className = 'cover-initial'
          initial.textContent = file.name.slice(0, 1)
          const mark = document.createElement('span'); mark.className = 'file-mark'
          mark.textContent = file.is_dir ? '目录' : extension(file.name).toUpperCase()
          art.append(initial, mark); cover.append(art)
          const info = document.createElement('div'); info.className = 'card-info'
          const name = document.createElement('strong'); name.className = 'card-title'; name.textContent = file.name
          const meta = document.createElement('span'); meta.className = 'file-meta'; meta.textContent = file.path
          info.append(name, meta)
          card.append(cover, info)
          coverLoader?.observe(art, file)
        }
        card.addEventListener('click', () => {
          if (file.is_dir && !recent) { directory = file.path; query = ''; get<HTMLInputElement>('search').value = ''; void loadLibrary(true) }
          else void openEntry(file)
        })
        get('items').append(card)
      }
      text('library-status', items.length ? '' : recent ? '此范围还没有阅读记录。打开一本书或漫画试试。' : isBooks ? '没有匹配的 TXT、EPUB 或 PDF。可修改内容目录或搜索词。' : '这一批没有漫画目录或压缩包；有图片时可点击“阅读本目录图片”，也可继续翻批。')
      text('batch', `第 ${batch + 1} 批`)
      get<HTMLButtonElement>('page-previous').disabled = batch === 0; get<HTMLButtonElement>('page-next').disabled = !next
    } catch (error) { if (!isAbort(error) && active === libraryGeneration) { text('library-status', '内容库读取失败，可刷新或修改目录后重试。'); report(error) } }
  }
  async function bookmarks(reset = false) {
    const file = currentFile, active = bookGeneration
    if (!file) return
    if (reset) { bookmarkCursor = null; get('bookmark-items').replaceChildren() }
    const records = await drive.storage.list<Bookmark>({ prefix: `bookmark:${file.id}:`, limit: 100, cursor: bookmarkCursor })
    if (active !== bookGeneration) return
    for (const record of records.records) {
      if (!record.value || !validLocation(record.value.location) || record.value.content_version !== file.content_version) continue
      const row = document.createElement('div'); row.className = 'bookmark-row'
      const open = document.createElement('button'), name = document.createElement('input'), rename = document.createElement('button'), remove = document.createElement('button')
      name.value = typeof record.value.title === 'string' ? record.value.title.slice(0, 120) : '书签'; name.maxLength = 120; name.setAttribute('aria-label', '修改书签名称')
      open.textContent = `跳转到 ${record.value.location.index + 1}`; rename.textContent = '改名'; remove.textContent = '删除'
      open.onclick = () => { void navigate(() => view!.restore(record.value.location)).then(() => chrome?.closePanel()).catch(report) }
      rename.onclick = () => { void drive.storage.set(record.key, { ...record.value, title: name.value.trim() || '书签' }, record.revision).then(() => bookmarks(true)).catch(report) }
      remove.onclick = () => { void drive.storage.delete(record.key, record.revision).then(() => bookmarks(true)).catch(report) }
      row.append(name, open, rename, remove); get('bookmark-items').append(row)
    }
    bookmarkCursor = records.next_cursor; show('bookmark-more', !!bookmarkCursor)
  }
  function navigate(work: () => Promise<void>): Promise<void> {
    if (!view || !readerReady) return Promise.resolve()
    const active = bookGeneration, target = view
    const operation = navigationQueue.catch(() => {}).then(async () => {
      if (active !== bookGeneration || target !== view) return
      canSave = false
      try { await work() }
      finally { if (active === bookGeneration) { canSave = true; capture(true) } }
    })
    navigationQueue = operation
    return operation
  }
  function savePreference(patch: Partial<Preferences>) {
    prefs = preferences({ ...prefs, ...patch }); syncPreferences()
    if (view && readerReady) void navigate(() => view!.configure(prefs)).catch(report)
    prefQueue = prefQueue.catch(() => {}).then(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const latest = await drive.storage.get<Preferences>('preferences')
        try { await drive.storage.set('preferences', preferences({ ...latest?.value, ...patch }), latest?.revision ?? null); return }
        catch (error) { if ((error as { code?: string }).code !== 'storage_conflict' || attempt === 2) throw error }
      }
    })
    void prefQueue.catch(report)
  }
  const closeApp = async () => { capture(); await store?.flush(); await drive.ui.close() }
  bind('settings', () => drive.settings.open()); bind('close', closeApp)
  bind('reader-settings', () => { chrome?.closePanel(); return drive.settings.open() }); bind('reader-close', closeApp)
  bind('all', () => { recent = false; return loadLibrary(true) }); bind('recent', () => { recent = true; return loadLibrary(true) })
  bind('refresh', () => loadLibrary(true))
  bind('page-previous', () => { if (batch > 0) { batch--; return loadLibrary() } })
  bind('page-next', () => { if (next) { pages[++batch] = next; return loadLibrary() } })
  bind('up', () => { directory = directory.split('/').slice(0, -1).join('/') || '/'; return loadLibrary(true) })
  bind('read-folder', async () => openEntry(await drive.files.stat({ path: directory })))
  bind('back', async () => { await closeReader(); await loadLibrary(true) })
  bind('retry-reader', () => { if (currentFile) return openEntry(currentFile) })
  bind('download', () => { if (currentFile && !currentFile.is_dir) return drive.ui.download(currentFile.path) })
  bind('preferences-toggle', () => chrome?.togglePanel('preferences'))
  bind('bookmarks-toggle', async () => { if (chrome?.togglePanel('bookmarks')) await bookmarks(true) })
  bind('bookmark-more', () => bookmarks())
  bind('add-bookmark', async () => {
    if (!view || !currentFile || !canSave) return
    const file = currentFile, location = view.current(), active = bookGeneration
    const id = [...crypto.getRandomValues(new Uint8Array(16))].map((value) => value.toString(16).padStart(2, '0')).join('')
    await drive.storage.set(`bookmark:${file.id}:${id}`, { title: get<HTMLInputElement>('bookmark-name').value.trim() || view.sections[location.index]?.label || '书签', location, content_version: file.content_version } satisfies Bookmark)
    if (active === bookGeneration) { get<HTMLInputElement>('bookmark-name').value = ''; await bookmarks(true) }
  })
  bind('previous', () => navigate(() => view!.turn(-1)))
  bind('next', () => navigate(() => view!.turn(1)))
  get('jump').addEventListener('input', () => { jumpDirty = true })
  bind('jump-button', () => {
    const index = Number(get<HTMLInputElement>('jump').value) - 1
    jumpDirty = false
    return navigate(() => view!.go(index)).then(() => chrome?.closePanel())
  })
  get<HTMLSelectElement>('toc').addEventListener('change', () => {
    const target = tocValues.get(get<HTMLSelectElement>('toc').value)
    if (target) void navigate(() => view!.restore(target)).then(() => chrome?.closePanel()).catch(report)
  })
  bind('retry-save', () => { capture(); return store?.flush() })
  bind('use-cloud', async () => {
    const active = bookGeneration, remote = await store?.resolve(true)
    if (active !== bookGeneration || !view) return
    if (remote && validLocation(remote.location)) await navigate(() => view!.restore(remote.location))
  })
  bind('use-current', async () => { capture(); await store?.resolve(false) })
  for (const [id, key] of Object.entries({ theme:'theme', 'font-size':'fontSize', 'line-height':'lineHeight', width:'width', mode:'mode', direction:'direction', zoom:'zoom' })) {
    get(id).addEventListener('change', () => {
      const raw = get<HTMLInputElement>(id).value
      savePreference({ [key]: ['fontSize','lineHeight','width','zoom'].includes(key) ? Number(raw) : raw })
    })
  }
  get('encoding').addEventListener('change', () => {
    const reader = view as ReaderView & { setEncoding?: (value: string) => Promise<void> }
    if (reader?.setEncoding) void navigate(async () => { await reader.setEncoding!(get<HTMLSelectElement>('encoding').value); toc() }).catch(report)
  })
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  get('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { query = get<HTMLInputElement>('search').value.trim(); void loadLibrary(true) }, 300) })
  const onKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || (event.target as HTMLElement).closest('input,select,textarea,button,[role="link"],[role="dialog"],.flow-block-scroll') || !view || !readerReady) return
    let delta = ['ArrowRight','PageDown'].includes(event.key) ? 1 : ['ArrowLeft','PageUp'].includes(event.key) ? -1 : 0
    if (view.current().format === 'comic' && prefs.direction === 'rtl' && event.key.startsWith('Arrow')) delta *= -1
    if (delta) { event.preventDefault(); void navigate(() => view!.turn(delta as -1 | 1)).catch(report) }
  }
  document.addEventListener('keydown', onKey)
  const offTheme = drive.on('theme.changed', ({ dark: nextDark }) => { dark = nextDark; applyTheme() })
  const offSettings = drive.on('settings.changed', async (settings) => {
    const nextSource = typeof settings.source_dir === 'string' ? settings.source_dir : '/'
    if (nextSource !== source) { await closeReader(); if (stopped) return; source = nextSource; directory = source; await loadLibrary(true) }
  })
  const offClose = drive.on('beforeClose', async () => { capture(); await Promise.all([store?.flush(), prefQueue.catch(() => {})]) })
  const onVisibility = () => { if (document.hidden) { capture(); void store?.flush() } }
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', () => {
    stopped = true; canSave = false; bookGeneration++; libraryGeneration++
    appLifecycle.abort(); coverLoader?.destroy()
    libraryController.abort(); bookController.abort(); view?.destroy(); store?.stop(); chrome?.destroy()
    document.removeEventListener('keydown', onKey); document.removeEventListener('visibilitychange', onVisibility)
    offTheme(); offSettings(); offClose(); clearTimeout(searchTimer); clearTimeout(noticeTimer)
  }, { once: true })
  try {
    const [settings, saved] = await Promise.all([drive.settings.get(), drive.storage.get<Preferences>('preferences')])
    source = typeof settings.source_dir === 'string' ? settings.source_dir : '/'; directory = source
    prefs = preferences(saved?.value); syncPreferences(); await loadLibrary(true)
  } catch (error) { report(error); text('library-status', '初始化失败，请返回应用中心重新打开。') }
}
