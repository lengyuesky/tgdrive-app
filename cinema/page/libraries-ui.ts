import type { PageUi } from '@tgdrive/page-sdk'
import { isAbort } from './io'
import { LibrariesStore, LibraryAccess, newLibraryId, parseLibraries, type CinemaLibrary, type LibrariesSnapshot } from './libraries'

/** 编辑命名媒体库；选择目录与授予只读范围是两个明确的主人操作。 */
export class LibraryManager {
  private dialog = document.getElementById('library-edit-dialog') as HTMLDialogElement
  private fields = document.getElementById('library-fields') as HTMLFieldSetElement
  private name = document.getElementById('library-name') as HTMLInputElement
  private kind = document.getElementById('library-kind') as HTMLSelectElement
  private path = document.getElementById('library-path') as HTMLOutputElement
  private status = document.getElementById('library-edit-status')!
  private saveButton = document.getElementById('library-save') as HTMLButtonElement
  private cancelButton = document.getElementById('library-cancel') as HTMLButtonElement
  private controller = new AbortController()
  private snapshot: LibrariesSnapshot | null = null
  private editingId: string | null = null
  private id = ''
  private binding: Pick<CinemaLibrary, 'root_id' | 'path' | 'authorized'> | null = null
  private writing = false
  private pending?: Promise<void>
  constructor(private ui: Pick<PageUi, 'pickDirectory' | 'requestScope'>, private store: LibrariesStore, private access: LibraryAccess,
    private changed: (snapshot: LibrariesSnapshot) => Promise<void>, private message: (text: string) => void, private confirm: (title: string, description: string) => Promise<boolean>) {
    const save = () => { if (this.saveButton.disabled || this.pending || !this.name.reportValidity()) return; this.pending = this.save().finally(() => { this.pending = undefined }) }
    this.saveButton.addEventListener('click', save)
    this.name.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); save() } })
    document.getElementById('library-pick')!.addEventListener('click', () => { void this.pick() })
    this.cancelButton.addEventListener('click', () => this.close())
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.close() })
  }
  private busy(active: boolean) { this.fields.disabled = active; this.saveButton.disabled = active; this.cancelButton.disabled = this.writing }
  private close() { if (this.writing) return; this.controller.abort(); this.dialog.close() }
  async edit(library?: CinemaLibrary) {
    if (this.pending) return
    this.controller.abort(); this.controller = new AbortController()
    const signal = this.controller.signal
    this.editingId = library?.id ?? null; this.id = library?.id ?? newLibraryId(); this.snapshot = null; this.binding = null
    this.name.value = ''; this.kind.value = 'movie'; this.path.value = '尚未选择文件夹'; this.status.textContent = '正在读取媒体库设置…'
    document.getElementById('library-edit-title')!.textContent = library ? '编辑媒体库' : '新建媒体库'
    if (!this.dialog.open) this.dialog.showModal()
    this.busy(true)
    try {
      this.snapshot = await this.store.load(signal)
      const current = this.snapshot.config.libraries.find(item => item.id === this.editingId)
      if (this.editingId && !current) throw new Error('此媒体库已被另一设备删除，请关闭后重新创建')
      if (current) { this.name.value = current.name; this.kind.value = current.kind; this.binding = { root_id: current.root_id, path: current.path, authorized: current.authorized }; this.path.value = current.path ?? '原文件夹不可用，请重新选择' }
      this.status.textContent = ''; this.busy(false); this.name.focus()
    } catch (error) { if (!signal.aborted) this.status.textContent = `${(error as Error).message}；请取消后重试。` }
  }
  private async pick() {
    const signal = this.controller.signal
    this.busy(true); this.status.textContent = ''
    try {
      const node = await this.ui.pickDirectory({ initial_id: this.binding?.root_id }, { signal })
      signal.throwIfAborted()
      if (node) {
        let binding: Pick<CinemaLibrary, 'root_id' | 'path' | 'authorized'>
        try { binding = await this.access.directory({ by: 'id', id: node.id }, signal) }
        catch (error) {
          if (!['scope_denied', 'not_found'].includes((error as { code?: string }).code ?? '')) throw error
          const scope = await this.ui.requestScope({ reason: `请给影视授予所选媒体库目录的只读访问权限。选择目录不会自动授权。`, preferred_access: 'read_only' }, { signal })
          if (!scope) throw new Error('尚未授予目录访问权限，媒体库未保存')
          binding = await this.access.directory({ by: 'id', id: node.id }, signal)
        }
        this.binding = binding; this.path.value = binding.path ?? ''
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
      const current = await this.access.directory({ by: 'id', id: this.binding.root_id }, signal)
      const draft: CinemaLibrary = { ...current, id: this.id, name: this.name.value, kind: this.kind.value === 'tv' ? 'tv' : 'movie' }
      const items = this.snapshot.config.libraries
      const config = parseLibraries({ libraries: this.editingId ? items.map(item => item.id === this.editingId ? draft : item) : [...items, draft] })
      if (current.path === '/' && !await this.confirm('将整个已授权网盘加入媒体库？', '根目录包含已授权网盘中的全部子文件夹。后端将建立媒体索引，但不会自动开启对外服务；取消则保留表单。')) return
      signal.throwIfAborted(); this.status.textContent = '正在保存…'
      const saved = await this.store.save(config, this.snapshot.revision, signal)
      this.dialog.close(); this.message('媒体库已保存，后端正在增量整理；对外服务不会自动启动'); await this.changed(saved)
    } catch (error) {
      if (signal.aborted || isAbort(error)) return
      if ((error as { code?: string }).code === 'storage_conflict') {
        this.snapshot = null
        try { this.snapshot = await this.store.load(signal); this.status.textContent = '另一设备更改了媒体库，已读取最新配置。草稿已保留，请确认后再次保存。' }
        catch { if (!signal.aborted) this.status.textContent = '无法读取最新配置，草稿仍保留；尚未覆盖云端数据。' }
      } else this.status.textContent = `${(error as Error).message}；请求未完成，请核对后重试。`
    } finally { this.writing = false; if (!signal.aborted) { this.busy(false); this.saveButton.disabled = !this.snapshot } }
  }
  async remove(library: CinemaLibrary) { if (this.pending) return; this.pending = this.removeLibrary(library).finally(() => { this.pending = undefined }); await this.pending }
  private async removeLibrary(library: CinemaLibrary) {
    try {
      const snapshot = await this.store.load(), current = snapshot.config.libraries.find(item => item.id === library.id)
      if (!current) { await this.changed(snapshot); this.message('此媒体库已删除'); return }
      if (!await this.confirm(`删除媒体库“${current.name}”？`, '仅删除媒体库配置，不删除原文件、收藏或观看历史。库外记录会隐藏，重新加入时按文件身份和内容版本恢复。旧飞牛连接需要重新登录。')) return
      const saved = await this.store.save({ libraries: snapshot.config.libraries.filter(item => item.id !== current.id) }, snapshot.revision)
      await this.changed(saved); this.message('媒体库已删除，原文件和观看记录均保留')
    } catch (error) {
      if ((error as { code?: string }).code === 'storage_conflict') { try { await this.changed(await this.store.load()) } catch { /* 读取失败不继续删除。 */ } this.message('另一设备更改了媒体库，本次没有删除，请确认最新设置后重试') }
      else this.message((error as Error).message)
    }
  }
  flush() { return this.pending ?? Promise.resolve() }
  stop() { this.controller.abort() }
}
