import { describe, expect, it, vi } from 'vitest'
import { ProgressStore, PreferenceStore, PreferenceSaveError, defaultPreferences, readerDefaultPreferences, parsePreferences, preferences, preferenceFormat, resolvePreferences, validLocation, type Preferences, type Progress } from './state'
import { memoryDrive } from './library/test-fixtures'
import type { Drive, FileEntry, RecordValue } from '../sdk/types'
const file: FileEntry = { id:2, name:'书.pdf',path:'/书.pdf',content_version:'a',size:10,is_dir:false,created_at:1,modified_at:1,favorite:false }
const progress = (index: number): Progress => ({file,title:'书',location:{format:'pdf',index}})
function storage() {
  let record: RecordValue<Progress> | null = null, revision = 0
  const set = vi.fn(async (key: string, value: Progress, expected: string | null) => {
    if ((record?.revision ?? null) !== expected) throw Object.assign(new Error('冲突'), {code:'storage_conflict'})
    record = { key, value:structuredClone(value), revision:String(++revision), updated_at:revision }
    return structuredClone(record)
  })
  const get = vi.fn(async () => structuredClone(record))
  const drive = {storage:{set,get}} as unknown as Drive
  return {drive,set,get, latest:()=>record}
}
describe('跨设备阅读记录', () => {
  it('未移动不重复保存，过期页面不能把新进度改回旧页', async () => {
    const mock = storage(), status = vi.fn()
    const first = new ProgressStore(mock.drive,file,status)
    await first.load(); first.mark(progress(1)); await first.flush()
    first.mark(progress(1)); await first.flush(); expect(mock.set).toHaveBeenCalledTimes(1)
    const second = new ProgressStore(mock.drive,file,vi.fn())
    expect((await second.load())!.location.index).toBe(1)
    second.mark(progress(2)); await second.flush()
    first.mark(progress(0)); await first.flush()
    expect(mock.latest()!.value.location.index).toBe(2)
    expect(status).toHaveBeenLastCalledWith('另一设备更新了阅读进度',true)
    await first.resolve(false)
    expect(mock.latest()!.value.location.index).toBe(0)
    first.stop(); second.stop()
  })
  it('使用云端丢弃待覆盖值，下一次保存基于最新修订标识', async () => {
    const mock = storage(), first = new ProgressStore(mock.drive,file,vi.fn()), second = new ProgressStore(mock.drive,file,vi.fn())
    await first.load(); await second.load()
    first.mark(progress(3)); await first.flush()
    second.mark(progress(1)); await second.flush()
    expect((await second.resolve(true))!.location.index).toBe(3)
    await second.flush(); expect(mock.latest()!.value.location.index).toBe(3)
    second.mark(progress(4)); await second.flush(); expect(mock.latest()!.value.location.index).toBe(4)
    first.stop(); second.stop()
  })
  it('网络失败保留待保存位置，重试后才显示已同步', async () => {
    const mock = storage(), status = vi.fn(), store = new ProgressStore(mock.drive,file,status)
    await store.load(); mock.set.mockRejectedValueOnce(new Error('断网'))
    store.mark(progress(5)); await store.flush()
    expect(status).toHaveBeenLastCalledWith('未同步：保存失败，请重试',false)
    await store.flush(); expect(mock.latest()!.value.location.index).toBe(5)
    store.stop()
  })
  it('不使用非法定位或无限字号等损坏配置', () => {
    expect(validLocation({format:'txt',index:-1})).toBe(false)
    expect(validLocation({format:'comic',index:1,ratio:Infinity})).toBe(false)
    expect(preferences({fontSize:Infinity,width:-2,theme:'bad' as never})).toMatchObject({fontSize:18,width:360,theme:'system'})
  })
})

describe('阅读馆 1.0.2 漫画适宽默认迁移', () => {
  const previousDefaults = () => {
    const value = defaultPreferences()
    value.text.mode = 'page'; value.comic.mode = 'single'; value.comic.fit = 'page'; value.pdf.fit = 'page'
    return value
  }

  it('首次默认适宽且不写空记录，旧默认用原修订号仅迁移一次，随后可保留用户选择的整页', async () => {
    const mock = memoryDrive(), store = new PreferenceStore(mock.drive, readerDefaultPreferences)
    expect((await store.load()).value).toMatchObject({ comicWidthDefault: 1, comic: { mode: 'single', fit: 'width', zoom: 1 } })
    expect(mock.set).not.toHaveBeenCalled()
    const value = previousDefaults(), original = mock.seed('preferences', value)
    const work = mock.seed('preferences:work:' + 'a'.repeat(32), { schemaVersion: 2, overrides: { comic: { fit: 'page', zoom: 1.5 } } })
    const progress = mock.seed('progress:2', { location: { format: 'comic', index: 4 } })
    const bookmark = mock.seed('bookmark:2:a', { title: '原书签' })
    const migrated = await store.load()
    expect(migrated).toMatchObject({ migrated: true, value: { ...value, comicWidthDefault: 1, comic: { ...value.comic, fit: 'width' } } })
    expect(migrated.revision).not.toBe(original.revision)
    expect(mock.set).toHaveBeenCalledExactlyOnceWith('preferences', migrated.value, original.revision, { signal: undefined })
    expect(await store.load()).toEqual({ ...migrated, migrated: false })
    expect(mock.set).toHaveBeenCalledTimes(1)
    expect(resolvePreferences(migrated.value, 'comic', (await store.loadWork('a'.repeat(32))).value)).toMatchObject({ fit: 'page', zoom: 1.5 })
    expect(mock.records.get(work.key)).toEqual(work)
    expect(mock.records.get(progress.key)).toEqual(progress); expect(mock.records.get(bookmark.key)).toEqual(bookmark)
    const chosen = await store.saveFormat(migrated, 'comic', { fit: 'page' })
    mock.set.mockClear()
    expect((await store.load()).value).toEqual(chosen.value)
    expect(chosen.value).toMatchObject({ comicWidthDefault: 1, comic: { fit: 'page' } })
    expect(mock.set).not.toHaveBeenCalled()
  })

  it.each([
    ['scroll', 'page', 1], ['double', 'page', 1], ['single', 'page', .75], ['single', 'width', 1],
  ] as const)('保留旧版自定义模式 %s、适配 %s、缩放 %s，不自动写回', async (mode, fit, zoom) => {
    const mock = memoryDrive(), store = new PreferenceStore(mock.drive, readerDefaultPreferences), value = previousDefaults()
    value.comic = { ...value.comic, mode, fit, zoom, direction: 'rtl', theme: 'dark' }
    const original = mock.seed('preferences', value), loaded = await store.load()
    expect(loaded.value.comic).toEqual(value.comic)
    expect(loaded.value.text).toEqual(value.text); expect(loaded.value.pdf).toEqual(value.pdf)
    expect(loaded.revision).toBe(original.revision); expect(loaded.migrated).toBe(false)
    expect(mock.records.get('preferences')).toEqual(original); expect(mock.set).not.toHaveBeenCalled()
  })

  it.each([undefined, 1])('旧 flat/V1 整页仍只在内存映射，不按 V2 默认迁移（%s）', async schemaVersion => {
    const mock = memoryDrive(), store = new PreferenceStore(mock.drive, readerDefaultPreferences)
    const original = mock.seed('preferences', { ...(schemaVersion === undefined ? {} : { schemaVersion }), mode: 'page', fit: 'page', zoom: 1 })
    expect((await store.load()).value.comic).toMatchObject({ mode: 'single', fit: 'page', zoom: 1 })
    expect(mock.records.get('preferences')).toEqual(original); expect(mock.set).not.toHaveBeenCalled()
  })

  it('迁移 CAS 冲突不重试、不覆盖另一设备的新偏好，保留适宽草稿', async () => {
    const mock = memoryDrive(), store = new PreferenceStore(mock.drive, readerDefaultPreferences), value = previousDefaults()
    const original = mock.seed('preferences', value)
    let remote: RecordValue | undefined
    mock.get.mockImplementationOnce(async () => {
      remote = mock.seed('preferences', { ...value, text: { ...value.text, fontSize: 31 } })
      return structuredClone(original)
    })
    await expect(store.load()).rejects.toMatchObject({ code: 'storage_conflict', key: 'preferences', draft: { comicWidthDefault: 1, comic: { fit: 'width' } } })
    expect(mock.set).toHaveBeenCalledTimes(1); expect(mock.records.get('preferences')).toEqual(remote)
  })

  it('迁移保存失败或取消不能冒充已同步，未知迁移标记不覆盖原记录', async () => {
    const mock = memoryDrive(), store = new PreferenceStore(mock.drive, readerDefaultPreferences)
    const original = mock.seed('preferences', previousDefaults())
    mock.set.mockRejectedValueOnce(new Error('配额不足'))
    await expect(store.load()).rejects.toMatchObject({ code: 'preferences_not_saved', draft: { comic: { fit: 'width' } } })
    expect(mock.records.get('preferences')).toEqual(original)
    mock.set.mockClear()
    const controller = new AbortController(), get = mock.get.getMockImplementation()!
    mock.get.mockImplementationOnce(async (key, options) => { const record = await get(key, options); controller.abort(); return record })
    await expect(store.load(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(mock.set).not.toHaveBeenCalled()
    for (const comicWidthDefault of [0, 2, '1', null]) {
      const bad = mock.seed('preferences', { ...previousDefaults(), comicWidthDefault })
      await expect(store.load()).rejects.toMatchObject({ code: 'unknown_preferences' })
      expect(mock.records.get('preferences')).toEqual(bad)
    }
    expect(mock.set).not.toHaveBeenCalled()
  })
})

describe('分格式与作品级阅读偏好', () => {
  const legacy: Preferences = { theme: 'sepia', fontSize: 23, lineHeight: 2, width: 900, mode: 'page', direction: 'rtl', zoom: 1.5 }
  const workId = 'a'.repeat(32), otherWorkId = 'b'.repeat(32)
  it.each([undefined, 1])('旧 flat/v1 只内存映射，保留字号、主题、方向、模式和 PDF 适宽', async schemaVersion => {
    const mock = memoryDrive(), raw = schemaVersion ? { schemaVersion, ...legacy } : legacy
    const original = mock.seed('preferences', raw), store = new PreferenceStore(mock.drive), snapshot = await store.load()
    expect(snapshot).toMatchObject({ revision: original.revision, migrated: true, value: {
      schemaVersion: 2, text: { mode: 'page', fontSize: 23, lineHeight: 2, theme: 'sepia', width: 900 },
      comic: { mode: 'single', direction: 'rtl', zoom: 1.5, fit: 'page', coverAlone: true, spreadOffset: 0 }, pdf: { fit: 'width', zoom: 1.5 },
    } })
    expect(resolvePreferences(snapshot.value, 'text')).toMatchObject({ font: 'serif', margin: 12, fontSize: 23, mode: 'page' })
    expect(resolvePreferences(snapshot.value, 'comic')).toMatchObject({ mode: 'single', direction: 'rtl' })
    expect(mock.set).not.toHaveBeenCalled(); expect(mock.records.get('preferences')).toEqual(original)
    expect(preferenceFormat('txt')).toBe('text'); expect(preferenceFormat('epub')).toBe('text')
    expect(preferenceFormat('comic')).toBe('comic'); expect(preferenceFormat('pdf')).toBe('pdf')
  })
  it('格式保存只更新目标格式，作品覆盖保持稀疏且清除后恢复当前默认', async () => {
    const mock = memoryDrive(), store = new PreferenceStore(mock.drive)
    const initial = await store.load()
    let base = await store.saveFormat(initial, 'text', { font: 'sans', margin: 30, fontSize: 25 })
    base = await store.saveFormat(base, 'comic', { mode: 'double', fit: 'page', direction: 'rtl', spreadOffset: 1 })
    expect(base.value.pdf).toEqual(defaultPreferences().pdf)
    expect(base.value.text).toMatchObject({ font: 'sans', margin: 30, fontSize: 25 })
    let work = await store.saveWork(await store.loadWork(workId), 'text', { fontSize: 28 })
    work = await store.saveWork(work, 'comic', { coverAlone: false })
    expect(work.value.overrides.text).toEqual({ fontSize: 28 })
    expect(resolvePreferences(base.value, 'text', work.value)).toMatchObject({ fontSize: 28, font: 'sans', margin: 30 })
    expect(resolvePreferences(base.value, 'comic', work.value)).toMatchObject({ mode: 'double', coverAlone: false, spreadOffset: 1 })
    expect(resolvePreferences(base.value, 'comic', (await store.loadWork(otherWorkId)).value).coverAlone).toBe(true)
    const cleared = await store.clearWork(work, 'text')
    expect(cleared.value.overrides).toEqual({ comic: { coverAlone: false } })
    expect(resolvePreferences(base.value, 'text', cleared.value).fontSize).toBe(25)
    expect(mock.remove).not.toHaveBeenCalled()
    expect(mock.records.get(`preferences:work:${workId}`)?.value).toEqual(cleared.value)
  })
  it('CAS 冲突保留草稿，不自动覆盖，重读确认后可只重试用户改动字段', async () => {
    const mock = memoryDrive(), first = new PreferenceStore(mock.drive), second = new PreferenceStore(mock.drive)
    const stale = await first.load(), latest = await second.saveFormat(await second.load(), 'text', { fontSize: 29 })
    const failure = await first.saveFormat(stale, 'comic', { mode: 'double' }).catch(error => error)
    expect(failure).toBeInstanceOf(PreferenceSaveError)
    expect(failure).toMatchObject({ code: 'storage_conflict', key: 'preferences', draft: { comic: { mode: 'double' } } })
    expect(mock.set).toHaveBeenCalledTimes(2)
    expect(mock.records.get('preferences')?.value).toEqual(latest.value)
    const saved = await first.saveFormat(await first.load(), 'comic', { mode: 'double' })
    expect(saved.value.text.fontSize).toBe(29); expect(saved.value.comic.mode).toBe('double')
    const workBase = await first.loadWork(workId)
    await second.saveWork(await second.loadWork(workId), 'pdf', { zoom: 2 })
    await expect(first.saveWork(workBase, 'pdf', { fit: 'page' })).rejects.toMatchObject({ code: 'storage_conflict', draft: { overrides: { pdf: { fit: 'page' } } } })
    const merged = await first.saveWork(await first.loadWork(workId), 'pdf', { fit: 'page' })
    expect(merged.value.overrides.pdf).toEqual({ zoom: 2, fit: 'page' })
  })
  it('未知版本、损坏记录、读取失败和非法 patch 均不写回默认值', async () => {
    const mock = memoryDrive(), store = new PreferenceStore(mock.drive)
    for (const value of [{ schemaVersion: 99 }, { schemaVersion: 2, ...legacy }, { ...defaultPreferences(), pdf: { fit: 'other', zoom: 1, theme: 'system' } }]) {
      mock.seed('preferences', value)
      await expect(store.load()).rejects.toMatchObject({ code: 'unknown_preferences' })
      expect(mock.records.get('preferences')?.value).toEqual(value)
    }
    mock.get.mockRejectedValueOnce(new Error('存储读取失败'))
    await expect(store.load()).rejects.toThrow('存储读取失败')
    mock.seed(`preferences:work:${workId}`, { schemaVersion: 3, overrides: {} })
    await expect(store.loadWork(workId)).rejects.toMatchObject({ code: 'unknown_preferences' })
    await expect(store.loadWork('../other')).rejects.toMatchObject({ code: 'invalid_work' })
    mock.records.delete('preferences')
    await expect(store.saveFormat(await store.load(), 'text', { margin: Infinity })).rejects.toMatchObject({ code: 'unknown_preferences' })
    expect(mock.set).not.toHaveBeenCalled()
  })
  it('配额失败返回未保存草稿；取消后的写入结果不能冒充已同步', async () => {
    const mock = memoryDrive(), store = new PreferenceStore(mock.drive), base = await store.load()
    mock.set.mockRejectedValueOnce(new Error('配额不足'))
    await expect(store.saveFormat(base, 'pdf', { zoom: 2 })).rejects.toMatchObject({ code: 'preferences_not_saved', draft: { pdf: { zoom: 2 } } })
    const controller = new AbortController(); controller.abort()
    await expect(store.saveFormat(base, 'pdf', { zoom: 2 }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(mock.set).toHaveBeenCalledTimes(1); expect(mock.records.size).toBe(0)
    expect(preferences({ ...legacy, mode: 'double', margin: 100, font: 'system' })).toMatchObject({ mode: 'double', margin: 64, font: 'system' })
    expect(parsePreferences(preferences(legacy)).comic.mode).toBe('single')
  })
})
