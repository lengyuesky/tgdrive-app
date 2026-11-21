import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LibraryDraft } from './client'
import { LibrariesStore, LibraryAccess } from './libraries'
import { LibraryManager } from './libraries-ui'
import { body, configuration, failure, fixture, json, movie, series } from './test-fixture'

async function setup(libraries = [movie]) {
  document.body.innerHTML = `<dialog id="library-edit-dialog"><h2 id="library-edit-title"></h2><fieldset id="library-fields"><input id="library-name" required /><select id="library-kind"><option value="movie">电影库</option><option value="tv">电视剧库</option></select><output id="library-path"></output><button id="library-pick" type="button">选择</button></fieldset><p id="library-edit-status"></p><button id="library-cancel" type="button">取消</button><button id="library-save" type="button">保存</button></dialog>`
  const dialog = document.getElementById('library-edit-dialog') as HTMLDialogElement
  dialog.showModal = () => { dialog.open = true }; dialog.close = () => { dialog.open = false }
  const state = { config: configuration(libraries), offline: false }, saves: Record<string, unknown>[] = []
  const result = await fixture(request => {
    const value = body(request)
    if (request.path === '/owner/config') return state.offline ? failure('backend_unavailable', '离线', 503) : json(state.config)
    if (request.path === '/owner/files/stat') return result.host.stat(value as Parameters<typeof result.host.stat>[0]).then(node => json(node))
    if (request.path === '/owner/libraries') {
      saves.push(value)
      if (value.revision !== state.config.revision) return failure()
      state.config = { ...state.config, revision: 'saved', libraries: (value.libraries as LibraryDraft[]).map(item => ({ ...item, authorized: true, path: item.root_id === '1' ? '/' : item.root_id === '2' ? '/影视' : '/电视剧' })) }
      return json(state.config)
    }
    return json(null)
  })
  const ui = { pickDirectory: vi.fn(async () => result.host.stat({ by: 'id', id: '1' })), requestScope: vi.fn(async () => null) }
  const changed = vi.fn(async () => {}), message = vi.fn(), confirm = vi.fn(async () => false)
  const manager = new LibraryManager(ui, new LibrariesStore(result.cinema), new LibraryAccess(result.cinema), changed, message, confirm)
  return { manager, state, saves, ui, changed, confirm, dialog, name: document.getElementById('library-name') as HTMLInputElement, kind: document.getElementById('library-kind') as HTMLSelectElement, save: document.getElementById('library-save') as HTMLButtonElement, status: document.getElementById('library-edit-status')! }
}
afterEach(() => document.body.replaceChildren())

describe('媒体库设置表单', () => {
  it('名称和电影／电视剧类型都能保存，回车不触发原生表单提交', async () => {
    const test = await setup(); await test.manager.edit(movie)
    test.name.value = '珍藏影视'; test.kind.value = 'tv'
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }); test.name.dispatchEvent(enter); await test.manager.flush()
    expect(enter.defaultPrevented).toBe(true); expect(test.state.config.libraries[0]).toMatchObject({ name: '珍藏影视', kind: 'tv', root_id: '2' })
    expect(test.dialog.open).toBe(false); expect(test.changed).toHaveBeenCalledOnce()
  })
  it('CAS 冲突保留草稿，第二次确认时合并最新快照中的其他媒体库', async () => {
    const test = await setup(); await test.manager.edit(movie); test.name.value = '珍藏电影'
    test.state.config = { ...test.state.config, libraries: [movie, series], revision: 'remote' }
    test.save.click(); await test.manager.flush()
    expect(test.status.textContent).toContain('另一设备'); expect(test.name.value).toBe('珍藏电影'); expect(test.dialog.open).toBe(true)
    test.save.click(); await test.manager.flush()
    expect(test.state.config.libraries).toHaveLength(2); expect(test.state.config.libraries[0].name).toBe('珍藏电影')
    expect(test.saves.map(value => value.revision)).toEqual(['r1', 'remote'])
  })
  it('远端删除正在编辑的媒体库后，重试不会偷偷重新创建', async () => {
    const test = await setup(); await test.manager.edit(movie); test.name.value = '仍在编辑'
    test.state.config = { ...test.state.config, libraries: [], revision: 'remote' }
    test.save.click(); await test.manager.flush(); test.save.click(); await test.manager.flush()
    expect(test.status.textContent).toContain('已被另一设备删除'); expect(test.state.config.libraries).toEqual([]); expect(test.saves).toHaveLength(1)
  })
  it('读取失败禁用保存但保留取消，不写入默认配置', async () => {
    const test = await setup(); test.state.offline = true; await test.manager.edit(movie)
    expect(test.save.disabled).toBe(true); expect(test.status.textContent).toContain('离线')
    expect((document.getElementById('library-cancel') as HTMLButtonElement).disabled).toBe(false)
    test.save.click(); expect(test.saves).toHaveLength(0)
  })
  it('选择根目录需要再次确认，取消保留表单，确认后才写入', async () => {
    const test = await setup([]); await test.manager.edit(); test.name.value = '全盘'
    document.getElementById('library-pick')!.click()
    await vi.waitFor(() => expect((document.getElementById('library-path') as HTMLOutputElement).value).toBe('/'))
    test.save.click(); await test.manager.flush(); expect(test.confirm).toHaveBeenCalledOnce(); expect(test.saves).toHaveLength(0); expect(test.dialog.open).toBe(true)
    test.confirm.mockResolvedValue(true); test.save.click(); await test.manager.flush()
    expect(test.state.config.libraries[0]).toMatchObject({ name: '全盘', root_id: '1', path: '/' })
  })
})
