import { describe, expect, it } from 'vitest'
import type { Drive, FileEntry, ScraperRecord } from '../../sdk/types'
import { RunJournal, readDirectoryRun, reconcileDirectoryRun } from '../../media-scraper/journal'
import { groups } from '../../media-scraper/model'
import type { RunItem } from '../../media-scraper/runner'
import { memoryStorage } from '../helpers/media-scraper-storage'

const root: FileEntry = { id: 1, name: '影片', path: '/影片', is_dir: true, size: 0, content_version: 'a'.repeat(64), created_at: 1, modified_at: 1, favorite: false }
const video = (id: number, name: string): FileEntry => ({ ...root, id, name, path: `/影片/${name}`, is_dir: false })
const item = (files = [video(2, 'ABC-123.mp4')]): RunItem => ({ group: groups(files)[0], state: 'waiting', reason: '' })
const signal = () => new AbortController().signal
const host = () => { const storage = memoryStorage(); return { storage, drive: { storage: storage.api } as unknown as Drive } }

describe('目录刮削持久记录', () => {
  it('大量中文长路径分多页保存，重新打开保留全部视频与同组格式', async () => {
    const { drive, storage } = host(), journal = await RunJournal.create(drive, root)
    const items = Array.from({ length: 500 }, (_, index) => item([video(index + 2, `${'目录'.repeat(100)}-ABC-${index + 100}.mp4`)]))
    items.push(item([video(1002, 'DEF-456.mp4'), video(1003, 'DEF-456.mkv')]))
    await journal.discovered(items)
    items[500].state = 'done'; await journal.item(500, items[500], 'batch-id')
    const reopened = await readDirectoryRun(drive, journal.summary.id, signal())
    expect(reopened.items).toHaveLength(501)
    expect(reopened.counts).toMatchObject({ total: 502, done: 2 })
    expect(reopened.items[0].files[0].path).toBe(items[0].group.files[0].path)
    expect([...storage.rows.values()].filter(row => row.key.startsWith('scrape_log:')).length).toBeGreaterThan(10)
    for (const row of storage.rows.values()) expect(new TextEncoder().encode(JSON.stringify(row.value)).length).toBeLessThanOrEqual(32768)
  })
  it('下一来源仍在等待时关闭，已经观察到的来源错误仍然可以读到', async () => {
    const { drive } = host(), journal = await RunJournal.create(drive, root)
    await journal.discovered([item()]); await journal.batch('first-batch')
    await journal.source(0, 'FANZA', '资料接口返回 HTTP 503')
    const reopened = await readDirectoryRun(drive, journal.summary.id, signal())
    expect(reopened.recordIds).toEqual(['first-batch'])
    expect(reopened.items[0]).toMatchObject({ state: 'stopped', reason: 'FANZA：资料接口返回 HTTP 503' })
    expect(JSON.stringify(reopened)).not.toContain('owner')
  })
  it('写入成功但响应丢失时读回相同写入标识，避免把已保存误判为丢失', async () => {
    const { drive, storage } = host(), save = storage.api.set.getMockImplementation()!
    storage.api.set.mockImplementationOnce(async (...args) => { await save(...args); throw new Error('响应中断') })
    const journal = await RunJournal.create(drive, root)
    expect(storage.api.set).toHaveBeenCalledOnce()
    await journal.discovered([item()])
    expect((await readDirectoryRun(drive, journal.summary.id, signal())).items).toHaveLength(1)
  })
  it('CAS 冲突不能读取新 revision 后覆盖另一个页面写入的内容', async () => {
    const { drive, storage } = host(), save = storage.api.set.getMockImplementation()!
    storage.api.set.mockImplementationOnce(async (key, value, revision) => {
      await save(key, { ...(value as object), write_id: 'other-writer', message: '另一个页面的内容' }, revision)
      throw new Error('revision 冲突')
    })
    await expect(RunJournal.create(drive, root)).rejects.toThrow('其他页面修改')
    expect(storage.api.set).toHaveBeenCalledOnce()
    expect([...storage.rows.values()][0].value).toMatchObject({ message: '另一个页面的内容' })
  })
  it('保存和读回都失败时明确中断，后续写入不会继续尝试', async () => {
    const { drive, storage } = host(), journal = await RunJournal.create(drive, root)
    storage.api.set.mockRejectedValue(new Error('连接中断')); storage.api.get.mockRejectedValue(new Error('连接中断'))
    await expect(journal.discovered([item()])).rejects.toThrow('保存结果尚未确认')
    const calls = storage.api.set.mock.calls.length
    await expect(journal.batch('must-not-run')).rejects.toThrow('保存尚未确认')
    expect(storage.api.set).toHaveBeenCalledTimes(calls)
  })
  it('日志页面缺失时拒绝将残缺清单当成完整可重试结果', async () => {
    const { drive, storage } = host(), journal = await RunJournal.create(drive, root)
    await journal.discovered(Array.from({ length: 200 }, (_, index) => item([video(index + 2, `${'长目录'.repeat(50)}-ABC-${index + 100}.mp4`)])))
    const first = [...storage.rows.keys()].find(key => key.startsWith('scrape_log:') && key.endsWith(':00000000'))!
    storage.rows.delete(first)
    await expect(readDirectoryRun(drive, journal.summary.id, signal())).rejects.toThrow('记录不完整')
  })
  it('扫描清单缺少尾页时仍可查看已保存部分，但禁止按截断清单重试', async () => {
    const { drive, storage } = host(), journal = await RunJournal.create(drive, root)
    await journal.discovered(Array.from({ length: 200 }, (_, index) => item([video(index + 2, `${'长目录'.repeat(50)}-ABC-${index + 100}.mp4`)])))
    const pages = [...storage.rows.keys()].filter(key => key.startsWith('scrape_log:')).sort()
    storage.rows.delete(pages.at(-1)!)
    const reopened = await readDirectoryRun(drive, journal.summary.id, signal())
    expect(reopened.items.length).toBeLessThan(200)
    expect(reopened.read_only).toBe(true); expect(reopened.warning).toContain('清单尚未完整保存')
  })
  it('宿主已完成但页面回执未保存时按真实步骤补正计数，恢复记录保持只读', async () => {
    const { drive } = host(), journal = await RunJournal.create(drive, root), pending = item([video(2, 'ABC-123.mp4'), video(3, 'ABC-123.mkv')])
    pending.state = 'ready'; pending.plan = { id: 'host-item', ready: true, needs_candidate: false, files: [] }
    await journal.discovered([pending]); await journal.batch('batch'); await journal.item(0, pending, 'batch')
    const reopened = await readDirectoryRun(drive, journal.summary.id, signal())
    const actual: ScraperRecord = { id: 'batch', root_id: root.id, root_path: root.path, status: 'completed', message: '', read_only: true, has_more: false, next_after: null, items: [{ id: 'host-item', position: 0, files: [], status: 'done', result: { organize: { state: 'done' }, nfo: { state: 'done' }, poster: { state: 'kept' }, reason: '' } }] }
    reconcileDirectoryRun(reopened, actual)
    expect(reopened.counts).toMatchObject({ total: 2, done: 2, processed: 2 })
    expect(reopened.read_only).toBe(true)
    expect(reopened.items[0].result?.poster.state).toBe('kept')
  })
  it('仅清理超过三十天的记录和对应日志，新的任务完整保留', async () => {
    const { drive, storage } = host(), old = await RunJournal.create(drive, root)
    await old.discovered([item()])
    const header = storage.rows.get(`scrape_run:${old.summary.id}`)!
    Object.assign(header.value as object, { updated_at: Date.now() / 1000 - 31 * 86400 })
    const fresh = await RunJournal.create(drive, root)
    expect([...storage.rows.keys()].some(key => key.includes(old.summary.id))).toBe(false)
    expect(storage.rows.has(`scrape_run:${fresh.summary.id}`)).toBe(true)
  })
})
