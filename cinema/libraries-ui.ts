import type { Drive } from '../sdk/types'
import { isAbort } from './io'
import { LibrariesStore, LibraryAccess, newLibraryId, parseLibraries, type CinemaLibrary, type LibrariesSnapshot } from './libraries'

/** 表单只编辑配置；保存成功返回媒体库入口，不隐式打开或扫描新目录。 */
export class LibraryManager {
  private dialog = document.getElementById('library-edit-dialog') as HTMLDialogElement
  private fields = document.getElementById('library-fields') as HTMLFieldSetElement
  private name = document.getElementById('library-name') as HTMLInputElement
  private path = document.getElementById('library-path') as HTMLOutputElement
  private status = document.getElementById('library-edit-status')!
  private saveButton = document.getElementById('library-save') as HTMLButtonElement
  private cancelButton = document.getElementById('library-cancel') as HTMLButtonElement
  private controller = new AbortController()
  private snapshot: LibrariesSnapshot | null = null
  private editingId: string | null = null
  private id = ''
  private binding: Pick<CinemaLibrary, 'directoryId' | 'directoryPath'> | null = null
  private writing = false
  private pending?: Promise<void>
  constructor(private drive: Drive, private store: LibrariesStore, private access: LibraryAccess,
    private changed: (snapshot: LibrariesSnapshot) => Promise<void>,
    private message: (text: string) => void,
    private confirm: (title: string, description: string) => Promise<boolean>) {
    const save = () => {
      if (this.saveButton.disabled || this.pending || !this.name.reportValidity()) return
      this.pending = this.save().finally(() => { this.pending = undefined })
    }
    // 沙箱不授予 allow-forms；按钮和回车直接执行 SDK 操作，不触发原生表单提交。
    this.saveButton.addEventListener('click', save)
    this.name.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); save() }
    })
    document.getElementById('library-pick')!.addEventListener('click', () => { void this.pick() })
    this.cancelButton.addEventListener('click', () => this.close())
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.close() })
  }
  private busy(active: boolean) { this.fields.disabled = active; this.saveButton.disabled = active; this.cancelButton.disabled = this.writing }
  private close() {
    if (this.writing) return
    this.controller.abort(); this.dialog.close()
  }
  async edit(library?: CinemaLibrary) {
    if (this.pending) return
    this.controller.abort(); this.controller = new AbortController()
    const signal = this.controller.signal
    this.editingId = library?.id ?? null; this.id = library?.id ?? newLibraryId(); this.snapshot = null; this.binding = null
    this.name.value = ''; this.path.value = '尚未选择文件夹'; this.status.textContent = '正在读取媒体库设置…'
    document.getElementById('library-edit-title')!.textContent = library ? '编辑媒体库' : '新建媒体库'
    if (!this.dialog.open) this.dialog.showModal()
    this.busy(true)
    try {
      this.snapshot = await this.store.load(signal)
      const current = this.snapshot.config.libraries.find(item => item.id === this.editingId)
      if (this.editingId && !current) throw new Error('此媒体库已被另一设备删除，请关闭后重新创建')
      if (current) {
        this.name.value = current.name
        this.binding = { directoryId: current.directoryId, directoryPath: current.directoryPath }
        this.path.value = current.directoryPath
      }
      this.status.textContent = ''; this.busy(false); this.name.focus()
    } catch (error) { if (!signal.aborted) this.status.textContent = `${(error as Error).message}；请取消后重试。` }
  }
  private async pick() {
    const signal = this.controller.signal
    this.busy(true); this.status.textContent = ''
    try {
      const path = await this.drive.ui.pickDirectory(this.binding?.directoryPath ?? '/')
      signal.throwIfAborted()
      if (path !== null) {
        this.binding = await this.access.directory({ path }, signal)
        this.path.value = this.binding.directoryPath
      }
    } catch (error) { if (!signal.aborted) this.status.textContent = (error as Error).message }
    finally { if (!signal.aborted) this.busy(false) }
  }
  private async save() {
    if (!this.snapshot || !this.binding) { this.status.textContent = '请先选择文件夹'; return }
    const signal = this.controller.signal
    this.writing = true; this.busy(true); this.status.textContent = ''
    try {
      if (this.editingId && !this.snapshot.config.libraries.some(item => item.id === this.editingId)) throw new Error('此媒体库已被另一设备删除，请关闭后重新创建')
      const draft: CinemaLibrary = { ...this.binding, id: this.id, name: this.name.value }
      const items = this.snapshot.config.libraries
      const config = parseLibraries({ schemaVersion: 1, libraries: this.editingId ? items.map(item => item.id === this.editingId ? draft : item) : [...items, draft] })
      const current = await this.access.directory({ id: draft.directoryId }, signal)
      if (current.directoryPath === '/' && !await this.confirm('将整个网盘加入媒体库？', '根目录包含整个网盘及其子文件夹中的视频。只有进入此媒体库时才加载；确认后保存，取消则保留表单。')) return
      signal.throwIfAborted()
      Object.assign(config.libraries.find(item => item.id === this.id)!, current)
      this.status.textContent = '正在保存…'
      const saved = await this.store.save(config, this.snapshot.revision, signal)
      this.dialog.close(); this.message('媒体库已保存，进入该库后才会加载视频')
      await this.changed(saved)
    } catch (error) {
      if (signal.aborted || isAbort(error)) return
      if ((error as { code?: string }).code === 'storage_conflict') {
        // 保留名称和绑定草稿；用户再次保存才会使用新的修订号。
        this.snapshot = null
        try {
          this.snapshot = await this.store.load(signal)
          this.status.textContent = '另一设备更改了媒体库，已读取最新配置。草稿已保留，请确认后再次保存。'
        } catch { if (!signal.aborted) this.status.textContent = '无法读取最新配置，草稿仍保留，请取消后重试；尚未覆盖云端数据。' }
      } else this.status.textContent = `${(error as Error).message}；尚未保存，请重试。`
    } finally {
      this.writing = false
      if (!signal.aborted) { this.busy(false); this.saveButton.disabled = !this.snapshot }
    }
  }
  async remove(library: CinemaLibrary) {
    if (this.pending) return
    this.pending = this.removeLibrary(library).finally(() => { this.pending = undefined })
    await this.pending
  }
  private async removeLibrary(library: CinemaLibrary) {
    try {
      const snapshot = await this.store.load()
      const current = snapshot.config.libraries.find(item => item.id === library.id)
      if (!current) { await this.changed(snapshot); this.message('此媒体库已删除'); return }
      if (!await this.confirm(`删除媒体库“${current.name}”？`, '仅删除媒体库配置，不删除原文件、收藏或观看历史。库外记录将隐藏，重新加入对应目录后可以恢复显示。')) return
      const saved = await this.store.save({ schemaVersion: 1, libraries: snapshot.config.libraries.filter(item => item.id !== current.id) }, snapshot.revision)
      await this.changed(saved); this.message('媒体库已删除，原文件和观看记录均保留')
    } catch (error) {
      if ((error as { code?: string }).code === 'storage_conflict') {
        try { await this.changed(await this.store.load()) } catch { /* 刷新失败也不继续删除，下一次操作仍需重新读取。 */ }
        this.message('另一设备更改了媒体库，本次没有删除，请确认最新设置后重试')
      } else this.message((error as Error).message)
    }
  }
  flush() { return this.pending }
  stop() { this.controller.abort() }
}
