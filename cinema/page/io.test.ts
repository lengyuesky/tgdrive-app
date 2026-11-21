import { describe, expect, it, vi } from 'vitest'
import { MiB, RangeFile } from './io'
import { fixture } from './test-fixture'

// 原固定四并发／每秒八次调度已删除；并发、取消和 Range 线上规则由 SDK 自身回归验证。
describe('客户端受控 Range 读取', () => {
  it('真实测试宿主按内容版本读取，重复窗口复用块，不读取整片', async () => {
    const { host, signal } = await fixture(), file = await host.stat({ by: 'id', id: '3' })
    const read = vi.spyOn(host, 'readRange'), source = new RangeFile(host, file, signal)
    expect([...await source.read(0, 2)]).toEqual([1, 2]); expect([...await source.read(2, 4)]).toEqual([3, 4])
    expect(read).toHaveBeenCalledOnce()
    expect(read).toHaveBeenCalledWith({ id: '3', content_version: file.content_version }, { offset: '0', length: '4' }, { signal })
  })
  it('按 MiB 切分并合并同块读取，单次请求不能超过解析预算', async () => {
    const { host, signal } = await fixture(), file = { ...await host.stat({ by: 'id', id: '3' }), size: String(80 * MiB + 8) }
    const read = vi.spyOn(host, 'readRange').mockImplementation(async (_file, window) => new Uint8Array(Number(window.length)).fill(Number(BigInt(window.offset) / BigInt(MiB))))
    const source = new RangeFile(host, file, signal)
    const [a, b] = await Promise.all([source.read(MiB - 2, MiB + 2), source.read(MiB, MiB + 4)])
    expect([...a]).toEqual([0, 0, 1, 1]); expect([...b]).toEqual([1, 1, 1, 1]); expect(read).toHaveBeenCalledTimes(2)
    await expect(source.read(0, 17 * MiB)).rejects.toThrow('16 MiB')
  })
  it('探测超预算停止，播放可解除总预算但缓存仍只保留二十四块', async () => {
    const { host, signal } = await fixture(), file = { ...await host.stat({ by: 'id', id: '3' }), size: String(80 * MiB) }
    vi.spyOn(host, 'readRange').mockImplementation(async (_file, window) => new Uint8Array(Number(window.length)))
    const source = new RangeFile(host, file, signal)
    await source.read(0, 16 * MiB)
    await expect(source.read(16 * MiB, 16 * MiB + 1)).rejects.toThrow('索引')
    source.setBudget()
    for (let index = 16; index < 30; index++) await source.read(index * MiB, index * MiB + 1)
    expect((source as unknown as { cache: Map<number, Uint8Array> }).cache.size).toBe(24)
    source.clear(); expect((source as unknown as { cache: Map<number, Uint8Array> }).cache.size).toBe(0)
  })
  it('越界、截断和取消都不能伪装成功；大于安全偏移的文件不转成浮点数', async () => {
    const { host } = await fixture(), file = await host.stat({ by: 'id', id: '3' }), controller = new AbortController()
    const source = new RangeFile(host, file, controller.signal)
    await expect(source.read(-1, 2)).rejects.toThrow('范围')
    vi.spyOn(host, 'readRange').mockResolvedValueOnce(new Uint8Array(1))
    await expect(source.read(0, 2)).rejects.toThrow('不完整')
    controller.abort(); await expect(source.read(0, 2)).rejects.toMatchObject({ name: 'AbortError' })
    expect(() => new RangeFile(host, { ...file, size: '9223372036854775807' }, new AbortController().signal)).toThrow('安全偏移')
  })
})
