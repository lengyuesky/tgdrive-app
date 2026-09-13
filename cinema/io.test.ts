import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Drive, FileEntry } from '../sdk/types'
import { MiB, RangeFile, ReadScheduler } from './io'
const file: FileEntry = { id: 9, name: '电影.mkv', path: '/电影.mkv', content_version: 'a'.repeat(64), size: 80 * MiB + 8, is_dir: false, favorite: false, created_at: 1, modified_at: 1 }
afterEach(() => vi.useRealTimers())
describe('客户端受控 Range 读取', () => {
  it('按 MiB 切分、复用缓存和并行读取，不把大电影整片加载', async () => {
    const readRange = vi.fn(async (_ref, offset, length) => new Uint8Array(length).fill(Math.floor(offset / MiB)))
    const drive = { files: { readRange } } as unknown as Drive
    const source = new RangeFile(drive, file, new AbortController().signal, new ReadScheduler())
    const [a, b] = await Promise.all([source.read(MiB - 2, MiB + 2), source.read(MiB, MiB + 4)])
    expect([...a]).toEqual([0,0,1,1]); expect([...b]).toEqual([1,1,1,1]); expect(readRange).toHaveBeenCalledTimes(2)
    expect(readRange.mock.calls.every(call => call[2] <= MiB)).toBe(true)
    await expect(source.read(0, 17 * MiB)).rejects.toThrow('16 MiB')
  })
  it('探测超预算拒绝继续扫描，播放时可解除预算但缓存仍有界', async () => {
    vi.useFakeTimers()
    const readRange = vi.fn(async (_ref, _offset, length) => new Uint8Array(length))
    const source = new RangeFile({ files: { readRange } } as unknown as Drive, file, new AbortController().signal, new ReadScheduler())
    const first = source.read(0, 16 * MiB); await vi.runAllTimersAsync(); await first
    await expect(source.read(16 * MiB, 16 * MiB + 1)).rejects.toThrow('索引')
    source.setBudget()
    for (let i = 16; i < 30; i++) { const task = source.read(i * MiB, i * MiB + 1); await vi.runAllTimersAsync(); await task }
    expect((source as any).cache.size).toBe(24)
    source.clear(); expect((source as any).cache.size).toBe(0)
  })
  it('单块响应截断、越界及取消不能伪装成功', async () => {
    const controller = new AbortController(), readRange = vi.fn(async () => new Uint8Array(1))
    const source = new RangeFile({ files: { readRange } } as unknown as Drive, file, controller.signal, new ReadScheduler())
    await expect(source.read(-1, 10)).rejects.toThrow('范围')
    await expect(source.read(0, 10)).rejects.toThrow('不完整')
    controller.abort(); await expect(source.read(0, 10)).rejects.toMatchObject({ name: 'AbortError' })
  })
  it('全应用最多四并发、每秒八次，等待期间可以取消', async () => {
    vi.useFakeTimers()
    const scheduler = new ReadScheduler(), controller = new AbortController(), times: number[] = []
    let active = 0, peak = 0
    const tasks = Array.from({ length: 20 }, () => scheduler.run(async () => {
      times.push(Date.now()); peak = Math.max(peak, ++active)
      await new Promise(resolve => setTimeout(resolve, 150)); active--
    }, controller.signal))
    await vi.runAllTimersAsync(); await Promise.all(tasks)
    expect(peak).toBeLessThanOrEqual(4)
    for (const time of times) expect(times.filter(t => t >= time && t < time + 1000).length).toBeLessThanOrEqual(8)
    controller.abort(); await expect(scheduler.run(async () => {}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
