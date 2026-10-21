/** 用户命名书库：一次只绑定一个目录；表单保存后才启动该目录扫描。 */
import { isLibraryAbort, sourceLabel, type SourcesSnapshot } from '../library'
import type { UiContext } from './types'
import { createModal, showConfirmModal } from './modals'

export function renderShelves(container: HTMLElement, context: UiContext, prefix: string) {
  const snapshot = context.library.snapshot
  container.replaceChildren()
  const layout = document.createElement('div')
  layout.className = 'shelves-view-container'
  const header = document.createElement('div'), title = document.createElement('h2'), create = document.createElement('button')
  header.className = 'shelves-header'; title.textContent = '我的书库'
  create.type = 'button'; create.className = 'btn-primary'; create.id = `btn-${prefix}-create-shelf`; create.textContent = '创建书库'
  create.onclick = () => { void context.createShelf?.().catch(context.reportError) }
  header.append(title, create)
  const hint = document.createElement('p')
  hint.className = 'card-subtitle'; hint.textContent = '每个书库对应一个目录。创建后扫描该目录并保存索引，点击书库只显示它的图书与漫画。'
  const grid = document.createElement('div'); grid.className = 'shelves-grid'
  for (const source of snapshot.sources.config.sources) {
    const card = document.createElement('button'), name = document.createElement('strong'), path = document.createElement('span')
    card.type = 'button'; card.className = 'shelf-card'; card.dataset.sourceId = String(source.nodeId)
    name.textContent = sourceLabel(source); path.textContent = source.path; path.className = 'file-meta'
    card.append(name, path)
    card.onclick = () => { void context.openLibrary?.({ sourceId: source.nodeId }).catch(context.reportError) }
    grid.append(card)
  }
  if (!snapshot.sources.config.sources.length) {
    const empty = document.createElement('p'); empty.className = 'empty-state'
    empty.textContent = '还没有书库。请自己创建书库并选择一个目录；创建前不会扫描或显示网盘图书。'
    grid.append(empty)
  }
  layout.append(header, hint, grid); container.append(layout)
}

export function showShelfModal(context: UiContext, sourceId?: number): Promise<number | null> {
  if (context.signal.aborted) return Promise.resolve(null)
  return new Promise(resolve => {
    const source = sourceId === undefined ? undefined : context.library.snapshot.sources.config.sources.find(item => item.nodeId === sourceId)
    if (sourceId !== undefined && !source) { resolve(null); return }
    const lifetime = new AbortController(), signal = AbortSignal.any([lifetime.signal, context.signal])
    let settled = false
    const finish = (id: number | null) => {
      if (settled) return
      settled = true; cleanup(); lifetime.abort(); resolve(id)
    }
    const { dialog, cleanup } = createModal({ title: source ? '修改书库名称' : '创建书库', signal: context.signal, onCancel: () => finish(null) })
    const base: SourcesSnapshot = context.library.snapshot.sources
    const form = document.createElement('form'); form.className = 'modal-form'
    const nameLabel = document.createElement('label'), name = document.createElement('input')
    nameLabel.textContent = '书库名称'; name.type = 'text'; name.required = true; name.maxLength = 80; name.setAttribute('aria-label', '书库名称'); name.value = source?.name ?? ''
    nameLabel.append(name)
    const pathLabel = document.createElement('label'), path = document.createElement('input')
    pathLabel.textContent = '对应目录'; path.type = 'text'; path.required = true; path.setAttribute('aria-label', '对应目录'); path.placeholder = '例如 /图书/小说'; path.value = source?.path ?? ''; path.disabled = !!source
    pathLabel.append(path)
    const choose = document.createElement('button'); choose.type = 'button'; choose.className = 'btn-secondary'; choose.textContent = '选择目录'
    choose.hidden = !!source || !context.drive.ui.authorizeDirectory && !context.drive.ui.pickDirectory
    const error = document.createElement('p'); error.className = 'error-text'; error.setAttribute('role', 'alert'); error.hidden = true
    const actions = document.createElement('div'), cancel = document.createElement('button'), save = document.createElement('button')
    actions.className = 'modal-actions'; cancel.type = save.type = 'button'; cancel.className = 'btn-secondary'; cancel.textContent = '取消'
    save.className = 'btn-primary'; save.textContent = source ? '保存名称' : '创建并扫描'
    cancel.onclick = () => finish(null)
    let pending = false
    choose.onclick = async () => {
      if (pending) return
      pending = true; choose.disabled = save.disabled = true
      try {
        const selected = context.drive.ui.authorizeDirectory
          ? await context.drive.ui.authorizeDirectory(path.value || '/')
          : await context.drive.ui.pickDirectory(path.value || '/')
        if (!signal.aborted && selected) path.value = selected
      } catch (cause) {
        if (!signal.aborted) { error.textContent = cause instanceof Error ? cause.message : String(cause); error.hidden = false }
      } finally { pending = false; if (!signal.aborted) choose.disabled = save.disabled = false }
    }
    const submit = async () => {
      if (pending || signal.aborted || !form.reportValidity()) return
      pending = true; choose.disabled = save.disabled = true; error.hidden = true
      try {
        if (source) {
          await context.library.renameSource(source.nodeId, name.value, base, signal)
          finish(source.nodeId); return
        }
        const selected = path.value.trim()
        const confirmedRoot = selected === '/' && await showConfirmModal({ title: '根目录书库确认', message: '这个书库将扫描整个网盘。是否确认使用根目录？', confirmText: '确认使用根目录', signal })
        if (signal.aborted || selected === '/' && !confirmedRoot) return
        const added = await context.library.addSource(selected, { name: name.value, confirmedRoot, base, signal })
        save.textContent = '正在扫描并保存索引…'
        await added.scan
        signal.throwIfAborted()
        finish(added.source.nodeId)
      } catch (cause) {
        if (!signal.aborted && !isLibraryAbort(cause)) { error.textContent = `保存失败：${cause instanceof Error ? cause.message : String(cause)}`; error.hidden = false }
      } finally { pending = false; if (!signal.aborted) { choose.disabled = save.disabled = false; save.textContent = source ? '保存名称' : '创建并扫描' } }
    }
    save.onclick = () => { void submit() }
    form.onsubmit = event => { event.preventDefault(); void submit() }
    for (const input of [name, path]) input.onkeydown = event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); void submit() } }
    actions.append(cancel, save); form.append(nameLabel, pathLabel, choose, error, actions); dialog.append(form); name.focus()
  })
}
