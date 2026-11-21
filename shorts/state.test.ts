import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryHost } from '@tgdrive/test-host'
import { DATA_VERSION_KEY, FAVORITES_PREFIX, SETTINGS_KEY, SettingsStore, FavoritesStore, defaults, initializeData, parseFavorite, parseSettings } from './state'

const clients = new Set<MemoryHost>()
afterEach(async () => { await Promise.all([...clients].map(client => client.dispose())); clients.clear() })
async function host() { const client = await MemoryHost.create({ now: Date.now(), app: { id: 'shorts', name: '短视频', version: '2.0.0', generation: 'g1' }, files: { read: true, write: false }, scope: { mode: 'all', access: 'read_only' }, nodes: [{ id: '2', parent_id: '1', name: '视频', kind: 'directory' }, { id: '3', parent_id: '2', name: '示例.mp4', kind: 'file', bytes: [1] }] }); clients.add(client); return client }
const signal = () => new AbortController().signal

describe('短视频应用数据与条件写入', () => {
  it('首次默认只读取设置，独立数据版本的并发初始化只条件新建', async () => {
    const client = await host(), settings = new SettingsStore(client), write = vi.spyOn(client, 'kvPut')
    expect(await settings.load(signal())).toEqual({ value: defaults(), revision: null }); expect(write).not.toHaveBeenCalled()
    await Promise.all([initializeData(client, signal()), initializeData(client, signal())])
    expect((await client.kvGet(DATA_VERSION_KEY)).record?.value).toBe(1)
    expect(write.mock.calls.every(([key, request]) => key === DATA_VERSION_KEY && request.condition.type === 'absent')).toBe(true)
  })
  it('未知数据版本和旧平面设置不映射、不迁移、不覆盖', async () => {
    const client = await host()
    const version = await client.kvPut(DATA_VERSION_KEY, { value: 99, condition: { type: 'absent' } })
    await expect(initializeData(client, signal())).rejects.toThrow('数据版本未知')
    expect((await client.kvGet(DATA_VERSION_KEY)).record).toEqual(version)
    const old = await client.kvPut(SETTINGS_KEY, { value: { source_dir: '/视频', muted: true }, condition: { type: 'absent' } })
    await expect(new SettingsStore(client).load(signal())).rejects.toThrow('设置版本未知')
    expect((await client.kvGet(SETTINGS_KEY)).record).toEqual(old)
  })
  it('设置保存冲突保留远端，重新读取后只显式重试用户改动', async () => {
    const client = await host(), one = new SettingsStore(client), two = new SettingsStore(client)
    const stale = await one.load(signal()), current = await two.save(await two.load(signal()), { ...defaults(), muted: false }, signal())
    await expect(one.save(stale, { ...stale.value, source: { type: 'directory', id: '2', path: '/视频' } }, signal())).rejects.toMatchObject({ code: 'storage_conflict' })
    expect(await one.load(signal())).toEqual(current)
    const fresh = await one.load(signal()), saved = await one.save(fresh, { ...fresh.value, source: { type: 'directory', id: '2', path: '/视频' } }, signal())
    expect(saved.value.muted).toBe(false)
  })
  it('应用收藏锚定字符串节点 ID，移动改名后仍存在，取消只做修订删除', async () => {
    const client = await host(), store = new FavoritesStore(client), file = await client.stat({ by: 'id', id: '3' })
    const favorite = await store.set(file, await store.load('3', signal()), true, signal())
    await client.changeNode({ id: '3', name: '改名.mp4' })
    expect(await store.load('3', signal())).toEqual(favorite)
    const changed = await client.stat({ by: 'id', id: '3' }), newest = await store.set(changed, favorite, true, signal())
    expect(newest.value).toMatchObject({ id: '3', name: '改名.mp4', addedAt: favorite.value!.addedAt })
    await expect(store.set(changed, favorite, false, signal())).rejects.toMatchObject({ code: 'storage_conflict' })
    await store.set(changed, newest, false, signal()); expect((await client.kvGet(FAVORITES_PREFIX + '3')).record).toBeNull()
  })
  it('收藏缺键和未知记录区分，ABA 冲突不能删除新一轮收藏', async () => {
    const client = await host(), store = new FavoritesStore(client), file = await client.stat({ by: 'id', id: '3' })
    expect(await store.load('3', signal())).toEqual({ value: null, revision: null })
    const old = await store.set(file, await store.load('3', signal()), true, signal())
    await store.set(file, old, false, signal()); const recreated = await store.set(file, await store.load('3', signal()), true, signal())
    await expect(store.set(file, old, false, signal())).rejects.toMatchObject({ code: 'storage_conflict' })
    expect(await store.load('3', signal())).toEqual(recreated)
    const invalid = await client.kvPut(FAVORITES_PREFIX + '3', { value: null, condition: { type: 'revision', revision: recreated.revision! } })
    await expect(store.load('3', signal())).rejects.toThrow('记录版本未知')
    expect((await client.kvGet(FAVORITES_PREFIX + '3')).record).toEqual(invalid)
  })
  it('收藏 KV 键集分页不按页内数量结束，所有条件与记录保留在应用命名空间', async () => {
    const client = await host(), store = new FavoritesStore(client)
    for (let index = 0; index < 45; index++) {
      const id = String(index + 100)
      await client.kvPut(FAVORITES_PREFIX + id, { value: { schemaVersion: 1, id, contentVersion: 'v1', name: `${index}.mp4`, path: `/视频/${index}.mp4`, addedAt: index }, condition: { type: 'absent' } })
    }
    const first = await store.page(null, signal()), second = await store.page(first.next_cursor, signal()), last = await store.page(second.next_cursor, signal())
    expect([first.records.length, second.records.length, last.records.length]).toEqual([20, 20, 5]); expect(last.next_cursor).toBeNull()
    expect(new Set([...first.records, ...second.records, ...last.records].map(record => record.value.id)).size).toBe(45)
  })
  it('目录和收藏字段必须是规范标识与纯文本，超范围、穿越和非法版本拒绝', () => {
    for (const id of ['0', '01', '9223372036854775808']) expect(() => parseSettings({ schemaVersion: 1, source: { type: 'directory', id, path: '/视频' }, muted: true })).toThrow()
    expect(() => parseSettings({ schemaVersion: 1, source: { type: 'directory', id: '2', path: '/视频/../其他' }, muted: true })).toThrow()
    expect(() => parseFavorite({ schemaVersion: 1, id: '3', contentVersion: '', name: 'a.mp4', path: '/a.mp4', addedAt: 1 })).toThrow()
    expect(() => parseFavorite({ schemaVersion: 1, id: '3', contentVersion: 'v1', name: 'a/b.mp4', path: '/a.mp4', addedAt: 1 })).toThrow()
    expect(parseSettings({ schemaVersion: 1, source: { type: 'directory', id: '9007199254740993', path: '/视频' }, muted: true }).source).toMatchObject({ id: '9007199254740993' })
  })
})
