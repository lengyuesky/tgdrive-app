import { describe, expect, it, vi } from 'vitest'
import { LIMITS } from '@tgdrive/page-sdk/contract'
import { RandomQueue, SAMPLE_SIZE, BACKTRACK_LIMIT } from './queue'
import { fileId, fixture } from './test-fixtures'

const signal = () => new AbortController().signal

describe('全授权范围的索引随机取材', () => {
  it('一万个视频只请求随机接口，不建立全盘列表，能够取得前 2000 项之外的文件', async () => {
    const x = await fixture({ paged: 10000, thumbnail: false, start: false, source: { type: 'all' } })
    const query = vi.spyOn(x.host, 'query'), list = vi.spyOn(x.host, 'list'), queue = new RandomQueue()
    const result = await queue.sample(x.host, [], signal())
    expect(result.items).toHaveLength(SAMPLE_SIZE); expect(result.items.some(file => Number(file.id) > 2000)).toBe(true)
    expect(x.random).toHaveBeenCalledWith({ roots: [], filter: { kind: 'file', extensions: expect.arrayContaining(['mp4', 'webm']), include_hidden: false }, limit: SAMPLE_SIZE, exclude_ids: [] }, expect.anything())
    expect(query).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled()
  }, 120_000)
  it('目录 ID 取材不越出所选目录，授权仍由内存宿主执行', async () => {
    const x = await fixture({ start: false, nodes: [{ id: '900', parent_id: '1', name: '其他', kind: 'directory' }, { id: '901', parent_id: '900', name: '其他.mp4', kind: 'file', bytes: [] }] })
    const queue = new RandomQueue(), own = await queue.sample(x.host, ['1000000'], signal())
    expect(own.items.map(file => file.id)).not.toContain('901')
    await x.host.setScope({ mode: 'selected', directories: [{ directory_id: '1000000', access: 'read_only' }] })
    await expect(queue.sample(x.host, ['900'], signal())).rejects.toMatchObject({ code: 'scope_denied' })
  })
  it('已有排队项和 512 条近期记录的并集也不超过排除预算，优先保护排队内容', async () => {
    const x = await fixture({ paged: 1000, start: false }), queue = new RandomQueue()
    queue.items = x.files.slice(0, 100)
    for (let index = 100; index < 800; index++) queue.markViewed(fileId(index))
    await queue.sample(x.host, ['1000000'], signal())
    const request = x.random.mock.calls.at(-1)![0]
    expect(request.exclude_ids).toHaveLength(LIMITS.MAX_RANDOM_EXCLUSIONS)
    expect(request.exclude_ids.slice(0, 100)).toEqual(queue.items.map(file => file.id))
    expect(new Set(request.exclude_ids).size).toBe(LIMITS.MAX_RANDOM_EXCLUSIONS)
  })
  it('同页重复、排除项返回和非视频明确拒绝，不把无效响应发布到队列', async () => {
    const x = await fixture({ start: false }), queue = new RandomQueue(), file = x.files[0]!, scope_revision = (await x.host.scope()).revision
    x.random.mockResolvedValueOnce({ items: [file, file], scope_revision }); await expect(queue.sample(x.host, [], signal())).rejects.toThrow('无效或重复')
    queue.items = [file]; x.random.mockResolvedValueOnce({ items: [file], scope_revision }); await expect(queue.sample(x.host, [], signal())).rejects.toThrow('无效或重复')
    queue.items = []; x.random.mockResolvedValueOnce({ items: [{ ...file, name: '不是视频.txt' }], scope_revision }); await expect(queue.sample(x.host, [], signal())).rejects.toThrow('无效或重复')
    expect(queue.items).toEqual([])
  })
  it('小库全落入近期排除时用另一份筛选允许回看，不误报库里没有视频', async () => {
    const x = await fixture({ start: false }), queue = new RandomQueue()
    for (const file of x.files) queue.markViewed(file.id)
    expect((await queue.sample(x.host, ['1000000'], signal())).items).toHaveLength(4)
    expect(x.random).toHaveBeenCalledTimes(2)
    expect(x.random.mock.calls[0]![0].exclude_ids).toHaveLength(4); expect(x.random.mock.calls[1]![0].exclude_ids).toEqual([])
  })
  it('回看裁剪只移除已走过的队列前缀，不丢当前项或未来项', async () => {
    const x = await fixture({ paged: 180, start: false }), queue = new RandomQueue()
    queue.items = x.files.slice(0, 132); queue.index = 126
    const current = queue.current!.id
    queue.append(x.files.slice(132, 164))
    expect(queue.index).toBe(BACKTRACK_LIMIT); expect(queue.current!.id).toBe(current); expect(queue.items.at(-1)!.id).toBe(x.files[163]!.id)
    expect(queue.items.length).toBe(138)
  })
})
