import { describe, expect, it, vi } from 'vitest'
import { ProgressStore, PreferenceStore, PreferenceSaveError, defaultPreferences, readerDefaultPreferences, parsePreferences, preferences, preferenceFormat, resolvePreferences, validLocation, type Progress } from './state'
import { file, memoryHost } from './library/test-fixtures'
import type { ValueRecord } from './records'
async function storage() {
  const source = file(2, '/书.pdf', false, 'v1', 10), mock = await memoryHost([source])
  return { ...mock, source, progress: (index: number): Progress => ({ file: source, title: '书', location: { format: 'pdf', index } }), latest: async () => (await mock.host.kvGet('progress:2')).record as unknown as ValueRecord<Progress> | null }
}
describe('跨页面阅读记录', () => {
  it('未移动不重复保存，过期页面不能把新进度改回旧页', async () => {
    const mock = await storage(), status = vi.fn(), first = new ProgressStore(mock.host, mock.source, status)
    await first.load(); first.mark(mock.progress(1)); await first.flush()
    first.mark(mock.progress(1)); await first.flush(); expect(mock.set).toHaveBeenCalledTimes(1)
    const second = new ProgressStore(mock.host, mock.source, vi.fn())
    expect((await second.load())!.location.index).toBe(1)
    second.mark(mock.progress(2)); await second.flush(); first.mark(mock.progress(0)); await first.flush()
    expect((await mock.latest())!.value.location.index).toBe(2)
    expect(status).toHaveBeenLastCalledWith('另一设备更新了阅读进度', true)
    await first.resolve(false); expect((await mock.latest())!.value.location.index).toBe(0)
    first.stop(); second.stop()
  })
  it('采用云端位置后丢弃本地待覆盖值，再保存必须使用最新修订', async () => {
    const mock = await storage(), first = new ProgressStore(mock.host, mock.source, vi.fn()), second = new ProgressStore(mock.host, mock.source, vi.fn())
    await first.load(); await second.load(); first.mark(mock.progress(3)); await first.flush()
    second.mark(mock.progress(1)); await second.flush(); expect((await second.resolve(true))!.location.index).toBe(3)
    await second.flush(); expect((await mock.latest())!.value.location.index).toBe(3)
    second.mark(mock.progress(4)); await second.flush(); expect((await mock.latest())!.value.location.index).toBe(4)
    first.stop(); second.stop()
  })
  it('网络失败保留待保存位置，重试后才显示已同步', async () => {
    const mock = await storage(), status = vi.fn(), store = new ProgressStore(mock.host, mock.source, status)
    await store.load(); mock.set.mockRejectedValueOnce(new Error('断网'))
    store.mark(mock.progress(5)); await store.flush(); expect(status).toHaveBeenLastCalledWith('未同步：保存失败，请重试', false)
    await store.flush(); expect((await mock.latest())!.value.location.index).toBe(5); store.stop()
  })
  it('确认的进度再更新历史，历史失败不重放进度，关闭信号传到派生保存', async () => {
    const mock = await storage(), status = vi.fn(), saved = vi.fn(async () => { throw new Error('历史配额不足') })
    const store = new ProgressStore(mock.host, mock.source, status, saved), controller = new AbortController()
    await store.load(); store.mark(mock.progress(6)); await store.flush(controller.signal)
    expect((await mock.latest())!.value.location.index).toBe(6)
    expect(saved).toHaveBeenCalledWith(expect.objectContaining({ key: 'progress:2' }), controller.signal)
    expect(status).toHaveBeenLastCalledWith('进度已保存，历史整理暂不可用', false)
    await store.flush(); expect(mock.set).toHaveBeenCalledOnce(); store.stop()
  })
  it('非法位置和无限排版值不会进入记录', () => {
    expect(validLocation({ format: 'txt', index: -1 })).toBe(false); expect(validLocation({ format: 'comic', index: 1, ratio: Infinity })).toBe(false)
    expect(preferences({ fontSize: Infinity, width: -2, theme: 'bad' as never })).toMatchObject({ fontSize: 18, width: 360, theme: 'system' })
  })
})
describe('新平台阅读偏好与数据版本', () => {
  it('首次默认文字分页、漫画单页适宽、PDF 适页，只读取而不写空偏好', async () => {
    const mock = await memoryHost(), store = new PreferenceStore(mock.host, readerDefaultPreferences)
    expect((await store.load()).value).toMatchObject({ schemaVersion: 2, text: { mode: 'page' }, comic: { mode: 'single', fit: 'width' }, pdf: { fit: 'page' } })
    expect(mock.set).not.toHaveBeenCalled()
  })
  it.each([['scroll', 'page', 1], ['double', 'page', 1], ['single', 'page', .75], ['single', 'width', 1]] as const)('当前版本自定义漫画 %s/%s/%s 只读保留，不擅自写回默认', async (mode, fit, zoom) => {
    const mock = await memoryHost(), store = new PreferenceStore(mock.host), value = defaultPreferences()
    value.comic = { ...value.comic, mode, fit, zoom, direction: 'rtl', theme: 'dark' }
    const original = await mock.seed('preferences', value), loaded = await store.load()
    expect(loaded.value).toEqual(value); expect(loaded.revision).toBe(original.revision); expect(mock.set).not.toHaveBeenCalled()
  })
  it.each([undefined, 1, 99])('不迁移旧平面记录或未知版本 %s，不覆盖原值', async schemaVersion => {
    const mock = await memoryHost(), store = new PreferenceStore(mock.host), value = { ...(schemaVersion === undefined ? {} : { schemaVersion }), mode: 'page', fit: 'page', zoom: 1 }
    const original = await mock.seed('preferences', value)
    await expect(store.load()).rejects.toMatchObject({ code: 'unknown_preferences' })
    expect((await mock.host.kvGet('preferences')).record).toEqual(original); expect(mock.set).not.toHaveBeenCalled()
  })
  it('格式映射不依赖旧持久数据格式', () => {
    expect(preferenceFormat('txt')).toBe('text'); expect(preferenceFormat('epub')).toBe('text'); expect(preferenceFormat('comic')).toBe('comic'); expect(preferenceFormat('pdf')).toBe('pdf')
  })
})
describe('分格式与作品级阅读偏好', () => {
  const workId = 'a'.repeat(32), otherWorkId = 'b'.repeat(32)
  it('格式保存仅更新目标格式，作品覆盖稀疏，清除后恢复当前默认', async () => {
    const mock = await memoryHost(), store = new PreferenceStore(mock.host)
    let base = await store.saveFormat(await store.load(), 'text', { font: 'sans', margin: 30, fontSize: 25 })
    base = await store.saveFormat(base, 'comic', { mode: 'double', fit: 'page', direction: 'rtl', spreadOffset: 1 })
    expect(base.value.pdf).toEqual(defaultPreferences().pdf); expect(base.value.text).toMatchObject({ font: 'sans', margin: 30, fontSize: 25 })
    let work = await store.saveWork(await store.loadWork(workId), 'text', { fontSize: 28 }); work = await store.saveWork(work, 'comic', { coverAlone: false })
    expect(work.value.overrides.text).toEqual({ fontSize: 28 }); expect(resolvePreferences(base.value, 'text', work.value)).toMatchObject({ fontSize: 28, font: 'sans', margin: 30 })
    expect(resolvePreferences(base.value, 'comic', work.value)).toMatchObject({ mode: 'double', coverAlone: false, spreadOffset: 1 })
    expect(resolvePreferences(base.value, 'comic', (await store.loadWork(otherWorkId)).value).coverAlone).toBe(true)
    const cleared = await store.clearWork(work, 'text'); expect(cleared.value.overrides).toEqual({ comic: { coverAlone: false } }); expect(resolvePreferences(base.value, 'text', cleared.value).fontSize).toBe(25)
    expect(mock.remove).not.toHaveBeenCalled(); expect((await mock.host.kvGet(`preferences:work:${workId}`)).record?.value).toEqual(cleared.value)
  })
  it('CAS 冲突保留草稿，重读后只重试用户改动，不自动覆盖', async () => {
    const mock = await memoryHost(), first = new PreferenceStore(mock.host), second = new PreferenceStore(mock.host)
    const stale = await first.load(), latest = await second.saveFormat(await second.load(), 'text', { fontSize: 29 })
    const failure = await first.saveFormat(stale, 'comic', { mode: 'double' }).catch(error => error)
    expect(failure).toBeInstanceOf(PreferenceSaveError); expect(failure).toMatchObject({ code: 'storage_conflict', key: 'preferences', draft: { comic: { mode: 'double' } } })
    expect(mock.set).toHaveBeenCalledTimes(2); expect((await mock.host.kvGet('preferences')).record?.value).toEqual(latest.value)
    const saved = await first.saveFormat(await first.load(), 'comic', { mode: 'double' }); expect(saved.value.text.fontSize).toBe(29); expect(saved.value.comic.mode).toBe('double')
    const workBase = await first.loadWork(workId); await second.saveWork(await second.loadWork(workId), 'pdf', { zoom: 2 })
    await expect(first.saveWork(workBase, 'pdf', { fit: 'page' })).rejects.toMatchObject({ code: 'storage_conflict', draft: { overrides: { pdf: { fit: 'page' } } } })
    const merged = await first.saveWork(await first.loadWork(workId), 'pdf', { fit: 'page' }); expect(merged.value.overrides.pdf).toEqual({ zoom: 2, fit: 'page' })
  })
  it('损坏、未知版本、读取失败和非法 patch 不写默认值', async () => {
    const mock = await memoryHost(), store = new PreferenceStore(mock.host)
    for (const value of [{ schemaVersion: 99 }, { schemaVersion: 2, mode: 'page' }, { ...defaultPreferences(), pdf: { fit: 'other', zoom: 1, theme: 'system' } }]) {
      await mock.seed('preferences', value); await expect(store.load()).rejects.toMatchObject({ code: 'unknown_preferences' }); expect((await mock.host.kvGet('preferences')).record?.value).toEqual(value)
    }
    mock.get.mockRejectedValueOnce(new Error('存储读取失败')); await expect(store.load()).rejects.toThrow('存储读取失败')
    await mock.seed(`preferences:work:${workId}`, { schemaVersion: 3, overrides: {} }); await expect(store.loadWork(workId)).rejects.toMatchObject({ code: 'unknown_preferences' }); await expect(store.loadWork('../other')).rejects.toMatchObject({ code: 'invalid_work' })
    const current = (await mock.host.kvGet('preferences')).record!; await mock.host.kvDelete(current.key, { revision: current.revision })
    await expect(store.saveFormat(await store.load(), 'text', { margin: Infinity })).rejects.toMatchObject({ code: 'unknown_preferences' }); expect(mock.set).not.toHaveBeenCalled()
  })
  it('配额失败与关闭期限取消均保留未保存草稿', async () => {
    const mock = await memoryHost(), store = new PreferenceStore(mock.host), base = await store.load()
    mock.set.mockRejectedValueOnce(new Error('配额不足')); await expect(store.saveFormat(base, 'pdf', { zoom: 2 })).rejects.toMatchObject({ code: 'preferences_not_saved', draft: { pdf: { zoom: 2 } } })
    const controller = new AbortController(); controller.abort(); await expect(store.saveFormat(base, 'pdf', { zoom: 2 }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(mock.set).toHaveBeenCalledTimes(1); expect(mock.records.size).toBe(0)
    expect(() => parsePreferences({ schemaVersion: 3 })).toThrow()
  })
})
