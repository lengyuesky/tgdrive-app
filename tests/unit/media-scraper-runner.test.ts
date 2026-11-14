import { describe, expect, it, vi } from 'vitest'
import type { CallOptions, Drive, FileEntry, ScraperCandidate, ScraperHandle, ScraperPrepare, ScraperPreview, ScraperService } from '../../sdk/types'
import { DirectoryScrape, scanDirectory, currentRecords } from '../../media-scraper/runner'
import { stem } from '../../media-scraper/model'
import { memoryStorage } from '../helpers/media-scraper-storage'
import { readDirectoryRun } from '../../media-scraper/journal'

const file = (id: number, name: string, path = `/影片/${name}`): FileEntry => ({ id, name, path, is_dir: false, size: 50, content_version: 'a'.repeat(64), created_at: 1, modified_at: 1, favorite: false })
const root = { ...file(1, '影片', '/影片'), is_dir: true }
const options = { refresh: false, update_nfo: true, update_poster: true }
const candidate = (number: string): ScraperCandidate => ({ provider: 'Fixture', id: number, number, title: '合成影片' })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function fixture(files: FileEntry[]) {
  let count = 0
  const ready = new Map<string, Map<string, ScraperPreview>>(), writes: number[] = [], events: string[] = []
  const searchPage = vi.fn(async ({ cursor }: { cursor?: string | null }) => {
    events.push(`scan:${cursor ?? 'first'}`)
    const at = cursor ? Number(cursor) : 0, results = files.slice(at, at + 100), more = at + 100 < files.length
    return { results, has_more: more, next_cursor: more ? String(at + 100) : null }
  })
  const api = {
    create: vi.fn(async () => {
      const id = `batch-${++count}`; events.push(`create:${id}`); ready.set(id, new Map())
      return { id, owner: 'owner' }
    }),
    preview: vi.fn(async (input: ScraperPrepare): Promise<ScraperPreview> => {
      const source = files.find(file => file.id === input.files[0].id)!
      const result: ScraperPreview = {
        id: `item-${source.id}`, ready: !!input.candidate, needs_candidate: !!input.number && !input.candidate,
        files: input.files.map(ref => ({ ...ref, name: files.find(file => file.id === ref.id)!.name })),
        target_path: `/影片/${input.number}`, candidate: input.candidate,
        nfo: { action: 'create', name: `${stem(source.name)}.nfo`, existing: null },
        poster: { action: 'create', name: `${stem(source.name)}.jpg`, existing: null },
        ...(!input.number ? { error: '无法识别番号' } : {}),
      }
      if (result.ready) ready.get(input.batch.id)!.set(result.id, result)
      return result
    }),
    search: vi.fn(async (number: string) => [candidate(number)]),
    begin: vi.fn(async (batch: ScraperHandle) => { events.push(`begin:${batch.id}`); return { ok: true as const } }),
    next: vi.fn(async (batch: ScraperHandle, _options?: CallOptions): ReturnType<ScraperService['next']> => {
      const pending = ready.get(batch.id)!, plan = pending.values().next().value
      if (!plan) return { done: true }
      pending.delete(plan.id); writes.push(...plan.files.map(file => file.id))
      return { done: false, item_id: plan.id, status: 'done', result: { organize: { state: 'done' }, nfo: { state: 'done' }, poster: { state: 'done' }, reason: '' } }
    }),
    heartbeat: vi.fn(async () => ({ ok: true as const })),
    stop: vi.fn(async (batch: ScraperHandle) => { ready.delete(batch.id); return { stopped: true, status: 'cancelled' } }),
  }
  const storage = memoryStorage(), stat = vi.fn(async () => root)
  const drive = { files: { searchPage, stat }, scraper: api, storage: storage.api } as unknown as Drive
  return { drive, api, searchPage, stat, writes, events, ready, storage }
}

describe('目录一键刮削', () => {
  it.each(['查询', '详情'])('%s偶发 HTTP 500 时自动重试一次，成功后直接完成', async stage => {
    const host = fixture([file(2, 'ABC-123.mp4')])
    if (stage === '查询') host.api.search.mockRejectedValueOnce(new Error('接口返回 HTTP 500'))
    else {
      const preview = host.api.preview.getMockImplementation()!
      let failed = false
      host.api.preview.mockImplementation(async input => {
        if (input.candidate && !failed) { failed = true; throw new Error('接口返回 HTTP 500') }
        return preview(input)
      })
    }
    const job = new DirectoryScrape(host.drive, () => {})
    await job.start(root, options)
    expect(host.writes).toEqual([2]); expect(job.counts).toMatchObject({ done: 1, skipped: 0, failed: 0 })
    const saved = await readDirectoryRun(host.drive, job.journal!.summary.id, new AbortController().signal)
    expect(saved.items[0].attempts).toHaveLength(1); expect(saved.items[0].attempts[0].reason).toContain('HTTP 500')
    if (stage === '查询') expect(host.api.search).toHaveBeenCalledTimes(2)
    else expect(host.api.preview.mock.calls.filter(([input]) => input.candidate)).toHaveLength(2)
  })
  it('持续查询失败只重试一次，仍处理后续影片', async () => {
    const host = fixture([file(2, 'ABC-123.mp4'), file(3, 'DEF-456.mp4')])
    host.api.search.mockImplementation(async number => { if (number === 'ABC-123') throw new Error('HTTP 503'); return [candidate(number)] })
    const job = new DirectoryScrape(host.drive, () => {})
    await job.start(root, options)
    expect(host.api.search.mock.calls.filter(([number]) => number === 'ABC-123')).toHaveLength(2)
    expect(host.writes).toEqual([3]); expect(job.counts).toMatchObject({ done: 1, failed: 1 })
  })
  it('大量来源失败的摘要不会超出存储单条上限，完整原因分页保存并继续下一部', async () => {
    const host = fixture([file(2, 'ABC-123.mp4'), file(3, 'DEF-456.mp4')]), preview = host.api.preview.getMockImplementation()!
    host.api.search.mockImplementation(async number => number === 'ABC-123'
      ? Array.from({ length: 100 }, (_, index) => ({ ...candidate(number), provider: `Provider${index}` }))
      : [candidate(number)])
    host.api.preview.mockImplementation(async input => {
      if (input.number === 'ABC-123' && input.candidate) throw new Error(`详情格式无效：${'合成原因'.repeat(100)}`)
      return preview(input)
    })
    const job = new DirectoryScrape(host.drive, () => {})
    await job.start(root, options)
    expect(host.writes).toEqual([3]); expect(job.phase).toBe('completed')
    const saved = await readDirectoryRun(host.drive, job.journal!.summary.id, new AbortController().signal)
    expect(saved.items[0].attempts).toHaveLength(100)
    expect(saved.items[0].reason).toContain('另有 97 次来源失败')
  })
  it('自动重试等待期间停止，不再发出下一次来源请求', async () => {
    const host = fixture([file(2, 'ABC-123.mp4')])
    host.api.search.mockRejectedValue(new Error('HTTP 503'))
    const job = new DirectoryScrape(host.drive, () => {}), work = job.start(root, options)
    await vi.waitFor(() => expect(job.status).toContain('正在重试'))
    await job.stop(); await work
    expect(host.api.search).toHaveBeenCalledOnce(); expect(host.api.begin).not.toHaveBeenCalled(); expect(job.phase).toBe('stopped')
  })
  it('第一部影片先完成写入，后续影片的慢查询不能让它一直等待', async () => {
    const host = fixture([file(2, 'ABC-123.mp4'), file(3, 'DEF-456.mp4')]), later = deferred<ScraperCandidate[]>()
    host.api.search.mockImplementation(number => number === 'DEF-456' ? later.promise : Promise.resolve([candidate(number)]))
    const job = new DirectoryScrape(host.drive, () => {}), work = job.start(root, options)
    await vi.waitFor(() => expect(host.api.search).toHaveBeenCalledWith('DEF-456', expect.anything()))
    const completedBeforeLaterSearch = [...host.writes]
    later.resolve([candidate('DEF-456')]); await work
    expect(completedBeforeLaterSearch).toEqual([2])
    expect(host.writes).toEqual([2, 3])
  })
  it('一部影片的海报失败保留已写 NFO，其他番号继续完成', async () => {
    const host = fixture([file(2, 'ABC-123.mp4'), file(3, 'DEF-456.mp4'), file(4, 'XYZ-789.mp4')])
    const next = host.api.next.getMockImplementation()!
    host.api.next.mockImplementation(async (batch, options) => host.ready.get(batch.id)?.values().next().value?.files[0].id === 3
      ? { done: false, paused: true, item_id: 'item-3', status: 'pending', result: { organize: { state: 'done' }, nfo: { state: 'done' }, poster: { state: 'pending' }, reason: '海报来源返回 HTTP 503' } }
      : next(batch, options))
    const job = new DirectoryScrape(host.drive, () => {})
    await job.start(root, options)
    expect(host.writes).toEqual([2, 4])
    expect(job.counts).toMatchObject({ done: 2, failed: 1, skipped: 0 })
    expect(job.items[1].reason).toContain('HTTP 503')
    expect(job.phase).toBe('completed')
    const signals = host.api.next.mock.calls.filter(([batch]) => batch.id !== 'batch-2').map(([, options]) => options!.signal!)
    expect(signals.every(signal => !signal.aborted)).toBe(true)
    const saved = await readDirectoryRun(host.drive, job.journal!.summary.id, new AbortController().signal)
    expect(saved.items[1].result).toMatchObject({ nfo: { state: 'done' }, poster: { state: 'pending' } })
  })
  it('启动写入前已经保存任务与项目标识，记录中不保存 owner', async () => {
    const host = fixture([file(2, 'ABC-123.mp4')]), job = new DirectoryScrape(host.drive, () => {})
    let persisted = false
    host.api.begin.mockImplementation(async batch => {
      const saved = await readDirectoryRun(host.drive, job.journal!.summary.id, new AbortController().signal)
      persisted = saved.recordIds.includes(batch.id) && saved.items[0].item_id === 'item-2'
      expect(saved.items[0].batch_id).toBe(batch.id)
      expect([...host.storage.rows.values()].some(row => JSON.stringify(row.value).includes('"owner"'))).toBe(false)
      return { ok: true }
    })
    await job.start(root, options)
    expect(persisted).toBe(true); expect(host.writes).toEqual([2])
  })
  it('保存批次标识无法确认时停止该批，不能继续写入视频', async () => {
    const host = fixture([file(2, 'ABC-123.mp4'), file(3, 'DEF-456.mp4')])
    const save = host.storage.api.set.getMockImplementation()!
    host.storage.api.set.mockImplementation(async (key, value, revision) => {
      if (JSON.stringify(value).includes('"type":"batch"')) {
        host.storage.api.get.mockRejectedValue(new Error('连接中断'))
        throw new Error('记录写入无回执')
      }
      return save(key, value, revision)
    })
    const job = new DirectoryScrape(host.drive, () => {})
    await job.start(root, options)
    expect(host.api.begin).not.toHaveBeenCalled(); expect(host.writes).toEqual([])
    expect(host.api.stop).toHaveBeenCalledOnce(); expect(job.status).toContain('保存结果尚未确认')
  })
  it('某来源失败后下一来源仍在查询，重开记录已经能看到实际错误', async () => {
    const host = fixture([file(2, 'ABC-123.mp4')]), later = deferred<ScraperPreview>()
    host.api.search.mockResolvedValue([{ ...candidate('ABC-123'), provider: 'First' }, { ...candidate('ABC-123'), provider: 'Second' }])
    const preview = host.api.preview.getMockImplementation()!
    host.api.preview.mockImplementation(async input => {
      if (input.candidate?.provider === 'First') throw new Error('详情 HTTP 503')
      if (input.candidate?.provider === 'Second') return later.promise
      return preview(input)
    })
    const job = new DirectoryScrape(host.drive, () => {}), work = job.start(root, options)
    await vi.waitFor(() => expect(host.api.preview.mock.calls.some(([input]) => input.candidate?.provider === 'Second')).toBe(true))
    const saved = await readDirectoryRun(host.drive, job.journal!.summary.id, new AbortController().signal)
    expect(saved.items[0].attempts).toEqual([{ provider: 'First', reason: '详情 HTTP 503' }])
    await job.stop(); later.reject(new Error('页面已关闭')); await work
    expect(host.api.begin).not.toHaveBeenCalled()
  })
  it('目录身份变化或授权失效时停止整次任务，不能只当成单个来源失败', async () => {
    const changed = fixture([file(2, 'ABC-123.mp4'), file(3, 'DEF-456.mp4')])
    changed.stat.mockResolvedValueOnce(root).mockResolvedValue({ ...root, path: '/已移动' })
    const first = new DirectoryScrape(changed.drive, () => {})
    await first.start(root, options)
    expect(changed.writes).toEqual([2]); expect(first.phase).toBe('failed'); expect(first.status).toContain('目录已变化')
    const denied = fixture([file(2, 'ABC-123.mp4'), file(3, 'DEF-456.mp4')])
    denied.api.search.mockRejectedValue(Object.assign(new Error('授权已撤销'), { status: 403 }))
    const second = new DirectoryScrape(denied.drive, () => {})
    await second.start(root, options)
    expect(denied.api.search).toHaveBeenCalledOnce(); expect(denied.writes).toEqual([]); expect(second.phase).toBe('failed')
  })
  it('上一个批次迟到的心跳错误不能停止正在处理的下一部影片', async () => {
    vi.useFakeTimers()
    try {
      const host = fixture([file(2, 'ABC-123.mp4'), file(3, 'DEF-456.mp4')])
      const first = deferred<void>(), second = deferred<void>(), heartbeat = deferred<{ ok: true }>()
      const next = host.api.next.getMockImplementation()!
      host.api.next.mockImplementation(async (batch, options) => {
        if (host.ready.get(batch.id)?.size) await (batch.id === 'batch-1' ? first.promise : second.promise)
        return next(batch, options)
      })
      host.api.heartbeat.mockReturnValue(heartbeat.promise)
      const job = new DirectoryScrape(host.drive, () => {}), work = job.start(root, options)
      await vi.waitFor(() => expect(host.api.next).toHaveBeenCalledOnce())
      await vi.advanceTimersByTimeAsync(5000)
      expect(host.api.heartbeat).toHaveBeenCalledOnce()
      first.resolve()
      await vi.waitFor(() => expect(host.api.next.mock.calls.some(([batch]) => batch.id === 'batch-2')).toBe(true))
      heartbeat.reject(new Error('上一批已结束'))
      await vi.advanceTimersByTimeAsync(0)
      expect(host.api.stop).not.toHaveBeenCalled(); expect(job.busy).toBe(true)
      second.resolve(); await work
      expect(host.writes).toEqual([2, 3]); expect(job.phase).toBe('completed')
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })
  it('暂停后的错误日志保存较慢时不再心跳旧批，保存后继续其他影片', async () => {
    vi.useFakeTimers()
    try {
      const host = fixture([file(2, 'ABC-123.mp4'), file(3, 'DEF-456.mp4')]), logging = deferred<void>()
      const next = host.api.next.getMockImplementation()!, save = host.storage.api.set.getMockImplementation()!
      let blocked = false
      host.api.next.mockImplementation(async (batch, options) => batch.id === 'batch-1'
        ? { done: false, paused: true, item_id: 'item-2', status: 'pending', result: { organize: { state: 'done' }, nfo: { state: 'done' }, poster: { state: 'pending' }, reason: '海报 HTTP 503' } }
        : next(batch, options))
      host.api.heartbeat.mockRejectedValue(new Error('该批次租约已结束'))
      host.storage.api.set.mockImplementation(async (key, value, revision) => {
        if (JSON.stringify(value).includes('"state":"failed"')) { blocked = true; await logging.promise }
        return save(key, value, revision)
      })
      const job = new DirectoryScrape(host.drive, () => {}), work = job.start(root, options)
      await vi.waitFor(() => expect(blocked).toBe(true))
      await vi.advanceTimersByTimeAsync(5100)
      expect(host.api.heartbeat).not.toHaveBeenCalled()
      logging.resolve(); await work
      expect(host.writes).toEqual([3]); expect(job.counts).toMatchObject({ done: 1, failed: 1 }); expect(job.phase).toBe('completed')
    } finally { vi.useRealTimers() }
  })
  it('同号分段已经写入后重建批次，后续分段不能换到另一资料源', async () => {
    const host = fixture([file(2, 'ABC-123-CD1.mp4'), file(3, 'ABC-123-CD2.mp4'), file(4, 'ABC-123-CD3.mp4')])
    const preview = host.api.preview.getMockImplementation()!, next = host.api.next.getMockImplementation()!
    host.api.search.mockResolvedValue([{ ...candidate('ABC-123'), provider: 'First' }, { ...candidate('ABC-123'), provider: 'Second' }])
    host.api.preview.mockImplementation(async input => {
      if (input.batch.id === 'batch-2' && input.candidate?.provider === 'First') throw new Error('原来源暂不可用')
      return preview(input)
    })
    host.api.next.mockImplementation(async (batch, options) => host.ready.get(batch.id)?.values().next().value?.files[0].id === 3
      ? { done: false, paused: true, item_id: 'item-3', status: 'pending', result: { organize: { state: 'done' }, nfo: { state: 'done' }, poster: { state: 'pending' }, reason: '海报 HTTP 503' } }
      : next(batch, options))
    const job = new DirectoryScrape(host.drive, () => {})
    await job.start(root, options)
    expect(host.writes).toEqual([2]); expect(job.counts).toMatchObject({ done: 1, failed: 2 })
    expect(host.api.preview.mock.calls.filter(([input]) => input.batch.id === 'batch-2' && input.candidate).map(([input]) => input.candidate!.provider)).toEqual(['First'])
  })
  it('读完超过一页的递归结果才开始写入，同基本名的跨页视频一起处理', async () => {
    const files = Array.from({ length: 100 }, (_, index) => file(index + 2, `ABC-${100 + index}.mp4`, `/影片/子目录/ABC-${100 + index}.mp4`))
    files.push(file(102, 'ABC-100.mkv', '/影片/子目录/ABC-100.mkv'))
    const host = fixture(files), job = new DirectoryScrape(host.drive, () => {})
    await job.start(root, options)
    expect(host.events.slice(0, 3)).toEqual(['scan:first', 'scan:100', 'create:batch-1'])
    expect(host.searchPage).toHaveBeenCalledTimes(2)
    expect(host.api.preview.mock.calls[0][0].files.map(file => file.id)).toEqual([2, 102])
    expect(new Set(host.writes)).toEqual(new Set(files.map(file => file.id)))
    expect(job.counts).toEqual({ total: 101, done: 101, skipped: 0, failed: 0, processed: 101 })
    expect(job.phase).toBe('completed')
  })
  it('同番号多个资料源自动采用，不能识别或无匹配的项目才跳过', async () => {
    const host = fixture([file(2, '没有番号.mp4'), file(3, 'ABC-123.mp4'), file(4, 'DEF-456.mp4'), file(5, 'XYZ-789.mp4')])
    host.api.search.mockImplementation(async number => number === 'ABC-123' ? [candidate(number), { ...candidate(number), provider: 'Another' }] : number === 'DEF-456' ? [] : [candidate(number), candidate('OTHER-100')])
    const job = new DirectoryScrape(host.drive, () => {})
    await job.start(root, options)
    expect(host.writes).toEqual([3, 5])
    expect(job.counts).toMatchObject({ done: 2, skipped: 2, failed: 0 })
    expect(host.api.search).not.toHaveBeenCalledWith('', expect.anything())
    expect(host.api.preview.mock.calls.filter(([input]) => input.candidate).map(([input]) => input.files[0].id)).toEqual([3, 5])
  })
  it('SONE-614 标准目录的 FANZA 和 JAV321 同号结果可以正常刮削', async () => {
    const video = file(2, 'SONE-614.mp4', '/视频/AV/SONE-614/SONE-614.mp4')
    const directory = { ...root, path: '/视频/AV/SONE-614', name: 'SONE-614' }
    const host = fixture([video])
    host.stat.mockResolvedValue(directory)
    const matches = ['FANZA', 'JAV321'].map(provider => ({ provider, id: 'sone00614', number: 'SONE-614', title: '同一影片' }))
    host.api.search.mockResolvedValue(matches)
    const job = new DirectoryScrape(host.drive, () => {})
    await job.start(directory, options)
    expect(host.writes).toEqual([video.id])
    expect(job.counts).toMatchObject({ done: 1, skipped: 0, failed: 0 })
    expect(host.api.preview.mock.calls.find(([input]) => input.candidate)?.[0].candidate).toEqual(matches[0])
  })
  it.each(['异常', '404', '番号不符'])('第一来源%s后尝试第二个同号来源，同一影片分段复用成功来源', async failure => {
    const host = fixture([file(2, 'SONE-614.mp4'), file(3, 'SONE-614-CD1.mp4')])
    const matches = ['FANZA', 'JAV321'].map(provider => ({ provider, id: 'sone00614', number: 'SONE-614', title: '同一影片' }))
    host.api.search.mockResolvedValue(matches)
    const preview = host.api.preview.getMockImplementation()!
    host.api.preview.mockImplementation(async input => {
      if (input.candidate?.provider === 'FANZA') {
        if (failure === '异常') throw new Error('接口返回 HTTP 503')
        return { id: `item-${input.files[0].id}`, ready: false, needs_candidate: false, files: [], error: failure === '404' ? '文件不存在' : '选定候选的番号与本组不一致' }
      }
      return preview(input)
    })
    const job = new DirectoryScrape(host.drive, () => {})
    await job.start(root, options)
    expect(host.writes).toEqual([2, 3])
    expect(job.counts).toMatchObject({ done: 2, skipped: 0, failed: 0 })
    expect(host.api.preview.mock.calls.filter(([input]) => input.candidate).map(([input]) => [input.files[0].id, input.candidate!.provider])).toEqual([[2, 'FANZA'], [2, 'JAV321'], [3, 'JAV321']])
    expect(host.api.search).toHaveBeenCalledOnce()
  })
  it('全部精确来源不可用时记录来源失败，后续影片仍能完成', async () => {
    const host = fixture([file(2, 'SONE-614.mp4'), file(3, 'ABC-123.mp4')])
    host.api.search.mockImplementation(async number => number === 'SONE-614' ? ['FANZA', 'JAV321'].map(provider => ({ ...candidate(number), provider })) : [candidate(number)])
    const preview = host.api.preview.getMockImplementation()!
    host.api.preview.mockImplementation(async input => {
      if (input.candidate && input.number === 'SONE-614') throw new Error('连接失败')
      return preview(input)
    })
    const job = new DirectoryScrape(host.drive, () => {})
    await job.start(root, options)
    expect(host.writes).toEqual([3]); expect(job.counts).toMatchObject({ done: 1, failed: 1, skipped: 0 })
    expect(job.items[0].reason).toContain('FANZA'); expect(job.items[0].reason).toContain('JAV321')
  })
  it('同号某组计划响应丢失后重建批次，剩余分段重新采用同一来源', async () => {
    const host = fixture([file(2, 'SONE-614.mp4'), file(3, 'SONE-614-CD1.mp4'), file(4, 'SONE-614-CD2.mp4')])
    host.api.search.mockImplementation(async number => ['FANZA', 'JAV321'].map(provider => ({ ...candidate(number), provider })))
    const preview = host.api.preview.getMockImplementation()!
    host.api.preview.mockImplementation(async input => {
      if (input.batch.id === 'batch-1' && input.candidate?.provider === 'FANZA') throw new Error('首轮来源暂不可用')
      if (input.files[0].id === 4) throw new Error('此分段检查失败')
      return preview(input)
    })
    const job = new DirectoryScrape(host.drive, () => {})
    await job.start(root, options)
    expect(host.writes).toEqual([2, 3])
    expect(host.api.begin).toHaveBeenCalledExactlyOnceWith({ id: 'batch-2', owner: 'owner' })
    const selected = host.api.preview.mock.calls.filter(([input]) => !!input.candidate).map(([input]) => [input.batch.id, input.files[0].id, input.candidate!.provider])
    expect(selected).toEqual([
      ['batch-1', 2, 'FANZA'], ['batch-1', 2, 'JAV321'], ['batch-1', 3, 'JAV321'],
      ['batch-2', 2, 'FANZA'], ['batch-2', 3, 'FANZA'],
    ])
    expect(job.counts).toMatchObject({ done: 2, failed: 1, skipped: 0 })
  })
  it('候选预览已保存但响应丢失时，放弃旧批次后不能误执行该项目', async () => {
    const host = fixture([file(2, 'SONE-614.mp4'), file(3, 'ABC-123.mp4')])
    host.api.search.mockImplementation(async number => number === 'SONE-614' ? ['FANZA', 'JAV321'].map(provider => ({ ...candidate(number), provider })) : [candidate(number)])
    const preview = host.api.preview.getMockImplementation()!
    host.api.preview.mockImplementation(async input => {
      const result = await preview(input)
      if (input.candidate && input.number === 'SONE-614') throw new Error('保存候选后响应中断')
      return result
    })
    const job = new DirectoryScrape(host.drive, () => {})
    await job.start(root, options)
    expect(host.writes).toEqual([3])
    expect(host.api.stop).toHaveBeenCalledExactlyOnceWith({ id: 'batch-1', owner: 'owner' })
    expect(host.api.begin).toHaveBeenCalledExactlyOnceWith({ id: 'batch-2', owner: 'owner' })
    expect(job.counts).toMatchObject({ done: 1, failed: 1, skipped: 0 })
  })
  it('尝试第一来源期间停止，迟到的错误不能触发下一来源', async () => {
    const host = fixture([file(2, 'SONE-614.mp4')]), response = deferred<ScraperPreview>()
    host.api.search.mockResolvedValue(['FANZA', 'JAV321'].map(provider => ({ ...candidate('SONE-614'), provider })))
    const preview = host.api.preview.getMockImplementation()!
    host.api.preview.mockImplementation(input => input.candidate ? response.promise : preview(input))
    const job = new DirectoryScrape(host.drive, () => {}), work = job.start(root, options)
    await vi.waitFor(() => expect(host.api.preview.mock.calls.some(([input]) => !!input.candidate)).toBe(true))
    await job.stop(); response.resolve({ id: 'item-2', ready: false, needs_candidate: false, files: [], error: '来源不可用' }); await work
    expect(host.api.preview.mock.calls.filter(([input]) => !!input.candidate)).toHaveLength(1)
    expect(host.api.begin).not.toHaveBeenCalled(); expect(job.phase).toBe('stopped')
  })
  it('全部不确定时正常结束，不启动写入批次', async () => {
    const host = fixture([file(2, '未知.mp4')]), job = new DirectoryScrape(host.drive, () => {})
    await job.start(root, options)
    expect(job.phase).toBe('completed'); expect(job.counts.skipped).toBe(1)
    expect(host.api.begin).not.toHaveBeenCalled(); expect(host.api.create).not.toHaveBeenCalled()
  })
  it('一条查询失败不会阻塞其他视频，也不会执行已失败项目的旧计划', async () => {
    const host = fixture([file(2, 'ABC-123.mp4'), file(3, 'DEF-456.mp4')])
    host.api.search.mockImplementation(async number => { if (number === 'ABC-123') throw new Error('此来源不可用'); return [candidate(number)] })
    const job = new DirectoryScrape(host.drive, () => {})
    await job.start(root, options)
    expect(job.counts).toMatchObject({ done: 1, failed: 1 }); expect(host.writes).toEqual([3])
    expect(host.api.stop).toHaveBeenCalledWith({ id: 'batch-1', owner: 'owner' })
    expect(host.api.begin).toHaveBeenCalledExactlyOnceWith({ id: 'batch-2', owner: 'owner' })
  })
  it('跨组海报命名相互影响时跳过冲突项目，其余项目继续', async () => {
    const host = fixture([file(2, 'ABC-123.mp4'), file(3, 'ABC-123-poster.mp4'), file(4, 'DEF-456.mp4')])
    const preview = host.api.preview.getMockImplementation()!
    host.api.preview.mockImplementation(async input => {
      const result = await preview(input)
      if (input.files[0].id === 2 && result.poster) result.poster.name = 'ABC-123-poster.jpg'
      return result
    })
    const job = new DirectoryScrape(host.drive, () => {})
    await job.start(root, options)
    expect(job.items.slice(0, 2).map(item => item.state)).toEqual(['skipped', 'skipped'])
    expect(host.writes).toEqual([4])
  })
  it('创建任务尚未返回时停止，会等待句柄后收尾，不能随后开始写入', async () => {
    const host = fixture([file(2, 'ABC-123.mp4')]), created = deferred<ScraperHandle>()
    host.api.create.mockImplementation(() => created.promise)
    const job = new DirectoryScrape(host.drive, () => {}), work = job.start(root, options)
    await vi.waitFor(() => expect(host.api.create).toHaveBeenCalledOnce())
    const stopping = job.stop(); created.resolve({ id: 'late-batch', owner: 'owner' })
    await Promise.all([work, stopping])
    expect(host.api.stop).toHaveBeenCalledWith({ id: 'late-batch', owner: 'owner' })
    expect(host.api.begin).not.toHaveBeenCalled(); expect(host.api.next).not.toHaveBeenCalled(); expect(job.phase).toBe('stopped')
  })
  it('启动请求尚未返回时关闭，等待启动结果后停止，不调用下一步', async () => {
    const host = fixture([file(2, 'ABC-123.mp4')]), begun = deferred<{ ok: true }>()
    host.api.begin.mockImplementation(() => begun.promise)
    const job = new DirectoryScrape(host.drive, () => {}), work = job.start(root, options)
    await vi.waitFor(() => expect(host.api.begin).toHaveBeenCalledOnce())
    const stopping = job.stop(); begun.resolve({ ok: true })
    await Promise.all([work, stopping])
    expect(host.api.stop).toHaveBeenCalledOnce(); expect(host.api.next).not.toHaveBeenCalled(); expect(job.phase).toBe('stopped')
  })
  it('查询中关闭后，即使旧查询返回唯一结果也不会继续计划或写入', async () => {
    const host = fixture([file(2, 'ABC-123.mp4')]), found = deferred<ScraperCandidate[]>()
    host.api.search.mockImplementation(() => found.promise)
    const job = new DirectoryScrape(host.drive, () => {}), work = job.start(root, options)
    await vi.waitFor(() => expect(host.api.search).toHaveBeenCalledOnce())
    await job.stop(); found.resolve([candidate('ABC-123')]); await work
    expect(host.api.preview).toHaveBeenCalledOnce(); expect(host.api.begin).not.toHaveBeenCalled(); expect(job.phase).toBe('stopped')
  })
  it('扫描过程中停止，晚到的下一页不会创建任务', async () => {
    const host = fixture([file(2, 'ABC-123.mp4')]), page = deferred<Awaited<ReturnType<Drive['files']['searchPage']>>>()
    host.searchPage.mockImplementation(() => page.promise)
    const job = new DirectoryScrape(host.drive, () => {}), work = job.start(root, options)
    await job.stop(); page.resolve({ results: [file(2, 'ABC-123.mp4')], has_more: false, next_cursor: null }); await work
    expect(host.api.create).not.toHaveBeenCalled(); expect(job.phase).toBe('stopped')
  })
  it('停止在途写入时先取得宿主停止回执，再关闭步骤请求', async () => {
    const host = fixture([file(2, 'ABC-123.mp4')]), step = deferred<Awaited<ReturnType<ScraperService['next']>>>(), receipt = deferred<{ stopped: boolean; status: string }>()
    host.api.next.mockImplementation(() => step.promise); host.api.stop.mockImplementation(() => receipt.promise)
    const job = new DirectoryScrape(host.drive, () => {}), work = job.start(root, options)
    await vi.waitFor(() => expect(host.api.next).toHaveBeenCalledOnce())
    const signal = host.api.next.mock.calls[0][1]!.signal!, stopping = job.stop()
    expect(signal.aborted).toBe(false); expect(job.phase).toBe('stopping')
    receipt.resolve({ stopped: true, status: 'cancelled' }); await stopping
    expect(signal.aborted).toBe(true)
    step.resolve({ done: false, paused: true }); await work
    expect(job.phase).toBe('stopped'); expect(host.api.next).toHaveBeenCalledOnce()
  })
  it('宿主返回写入结果不明时停止整次目录任务，不在后台重试', async () => {
    const host = fixture([file(2, 'ABC-123.mp4'), file(3, 'DEF-456.mp4')])
    host.api.next.mockResolvedValue({ done: false, paused: true, item_id: 'item-2', status: 'needs_verification', result: { organize: { state: 'done' }, nfo: { state: 'done' }, poster: { state: 'uploading' }, reason: '海报写入需要核实' } })
    const job = new DirectoryScrape(host.drive, () => {})
    await job.start(root, options)
    expect(host.api.next).toHaveBeenCalledOnce(); expect(host.api.stop).toHaveBeenCalledOnce()
    expect(job.phase).toBe('failed'); expect(job.status).toContain('海报写入需要核实')
    expect(job.items.map(item => item.state)).toEqual(['failed', 'stopped'])
  })
  it('空目录无需创建批次', async () => {
    const host = fixture([]), job = new DirectoryScrape(host.drive, () => {})
    await job.start(root, options)
    expect(job.phase).toBe('completed'); expect(host.api.create).not.toHaveBeenCalled()
  })
})

describe('完整目录扫描边界', () => {
  it('核实历史前先让宿主恢复过期批次，避免异常关闭后的 running 永远阻止手动重试', async () => {
    const host = fixture([]), order: string[] = []
    let status = 'running'
    host.drive.scraper!.records = vi.fn(async () => { order.push('recover'); status = 'interrupted'; return { records: [], has_more: false, next_cursor: null } })
    host.drive.scraper!.record = vi.fn(async () => { order.push('record'); return { id: 'expired', root_id: 1, root_path: root.path, status, message: '', read_only: false, items: [], has_more: false, next_after: null } })
    const records = []
    for await (const record of currentRecords(host.drive, ['expired'], new AbortController().signal)) records.push(record)
    expect(order).toEqual(['recover', 'record']); expect(records[0].status).toBe('interrupted')
  })
  it('分页游标重复或缺失时结束扫描，防止循环或只处理第一页', async () => {
    for (const cursor of [null, 'same']) {
      const host = fixture([file(2, 'ABC-123.mp4')])
      host.searchPage.mockResolvedValue({ results: [file(2, 'ABC-123.mp4')], has_more: true, next_cursor: cursor })
      await expect(scanDirectory(host.drive, root, new AbortController().signal, () => {})).rejects.toThrow('目录列表已变化')
      expect(host.searchPage.mock.calls.length).toBeLessThanOrEqual(2)
    }
  })
  it('拒绝范围之外的扫描结果', async () => {
    const host = fixture([file(2, 'ABC-123.mp4', '/其他/ABC-123.mp4')])
    await expect(scanDirectory(host.drive, root, new AbortController().signal, () => {})).rejects.toThrow('超出所选目录')
  })
})
