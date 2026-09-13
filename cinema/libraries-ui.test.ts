import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Drive, FileEntry, RecordValue } from '../sdk/types'
import { LibrariesStore, LibraryAccess, type CinemaLibraries, type CinemaLibrary } from './libraries'
import { LibraryManager } from './libraries-ui'
import { ReadScheduler } from './io'

const movie: CinemaLibrary = { id: 'movie', name: '电影', directoryId: 10, directoryPath: '/电影' }
function setup(libraries = [movie]) {
  document.body.innerHTML = `<dialog id="library-edit-dialog"><h2 id="library-edit-title"></h2><form id="library-form"><fieldset id="library-fields"><input id="library-name" required /><output id="library-path"></output><button id="library-pick" type="button">选择</button></fieldset><p id="library-edit-status"></p><button id="library-cancel" type="button">取消</button><button id="library-save" type="button">保存</button></form></dialog>`
  const dialog = document.getElementById('library-edit-dialog') as HTMLDialogElement
  dialog.showModal = () => { dialog.open = true }; dialog.close = () => { dialog.open = false }
  const state: { record: RecordValue<CinemaLibraries> } = { record: { key: 'media-libraries', value: { schemaVersion: 1, libraries }, revision: 'r1', updated_at: 1 } }
  const get = vi.fn(async () => structuredClone(state.record))
  const set = vi.fn(async (key: string, value: CinemaLibraries, revision: string) => {
    if (revision !== state.record.revision) throw { code: 'storage_conflict' }
    state.record = { key, value: structuredClone(value), revision: 'saved', updated_at: 3 }
    return structuredClone(state.record)
  })
  const stat = vi.fn(async ({ id }: { id?: number; path?: string }): Promise<FileEntry> => ({ id: id ?? 1, path: id === 10 ? '/电影' : '/', name: '目录', is_dir: true, content_version: 'v1', size: 0, created_at: 1, modified_at: 1, favorite: false }))
  const pickDirectory = vi.fn().mockResolvedValue('/')
  const drive = { storage: { get, set }, files: { stat }, ui: { pickDirectory } } as unknown as Drive
  const changed = vi.fn().mockResolvedValue(undefined), message = vi.fn(), confirm = vi.fn().mockResolvedValue(false)
  const manager = new LibraryManager(drive, new LibrariesStore(drive), new LibraryAccess(drive, new ReadScheduler()), changed, message, confirm)
  const name = document.getElementById('library-name') as HTMLInputElement
  const save = document.getElementById('library-save') as HTMLButtonElement
  const status = document.getElementById('library-edit-status')!
  return { manager, state, get, set, stat, changed, confirm, dialog, name, save, status }
}
afterEach(() => { document.body.replaceChildren() })

describe('媒体库设置表单', () => {
  it('只改名称也能保存，不被旧目录绑定中的名称覆盖；回车不提交原生表单', async () => {
    const s = setup(); await s.manager.edit(movie)
    s.name.value = '珍藏电影'
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    s.name.dispatchEvent(enter); await s.manager.flush()
    expect(enter.defaultPrevented).toBe(true)
    expect(s.state.record.value.libraries).toEqual([{ ...movie, name: '珍藏电影' }])
    expect(s.dialog.open).toBe(false); expect(s.changed).toHaveBeenCalledOnce()
  })
  it('CAS 冲突保留草稿，第二次确认时合并最新快照中的其他库', async () => {
    const s = setup(); await s.manager.edit(movie)
    s.name.value = '珍藏电影'
    const series = { ...movie, id: 'series', name: '电视剧', directoryId: 20, directoryPath: '/电视剧' }
    s.state.record = { ...s.state.record, value: { schemaVersion: 1, libraries: [movie, series] }, revision: 'remote' }
    s.save.click(); await s.manager.flush()
    expect(s.status.textContent).toContain('另一设备'); expect(s.name.value).toBe('珍藏电影')
    expect(s.state.record.value.libraries[0].name).toBe('电影')
    expect(s.dialog.open).toBe(true)
    s.save.click(); await s.manager.flush()
    expect(s.state.record.value.libraries).toEqual([{ ...movie, name: '珍藏电影' }, series])
    expect(s.set.mock.calls.map(call => call[2])).toEqual(['r1', 'remote'])
  })
  it('远端删除当前编辑的库后，不会在重试时偷偷重新创建', async () => {
    const s = setup(); await s.manager.edit(movie)
    s.name.value = '仍在编辑'
    s.state.record = { ...s.state.record, value: { schemaVersion: 1, libraries: [] }, revision: 'remote' }
    s.save.click(); await s.manager.flush()
    s.save.click(); await s.manager.flush()
    expect(s.status.textContent).toContain('已被另一设备删除')
    expect(s.state.record.value.libraries).toEqual([])
    expect(s.set).toHaveBeenCalledOnce()
  })
  it('配置读取失败时禁用保存，保留取消入口，不写入默认配置', async () => {
    const s = setup(); s.get.mockRejectedValueOnce(new Error('离线'))
    await s.manager.edit(movie)
    expect(s.save.disabled).toBe(true); expect(s.status.textContent).toContain('离线')
    expect((document.getElementById('library-cancel') as HTMLButtonElement).disabled).toBe(false)
    s.save.click(); expect(s.set).not.toHaveBeenCalled()
  })
  it('选择根目录必须单独确认，拒绝确认保留表单，确认后才写入', async () => {
    const s = setup([]); await s.manager.edit()
    s.name.value = '全盘'
    document.getElementById('library-pick')!.click()
    await vi.waitFor(() => expect((document.getElementById('library-path') as HTMLOutputElement).value).toBe('/'))
    s.save.click(); await s.manager.flush()
    expect(s.confirm).toHaveBeenCalledOnce(); expect(s.set).not.toHaveBeenCalled(); expect(s.dialog.open).toBe(true)
    s.confirm.mockResolvedValue(true)
    s.save.click(); await s.manager.flush()
    expect(s.set).toHaveBeenCalledOnce(); expect(s.state.record.value.libraries[0]).toMatchObject({ name: '全盘', directoryPath: '/', directoryId: 1 })
  })
})
