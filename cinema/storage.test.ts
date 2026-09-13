import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Drive, FileEntry } from '../sdk/types'
import { ProgressStore } from './storage'
import type { CinemaProgress } from './model'
const file: FileEntry = { id: 1, content_version: 'a'.repeat(64), name: '电影.mp4', path: '/电影.mp4', size: 100, is_dir: false, created_at: 1, modified_at: 1, favorite: false }
const progress = (seconds: number): CinemaProgress => ({ file, seconds, duration: 100, completed: false })
function setup() {
  const get = vi.fn().mockResolvedValue(null), set = vi.fn().mockImplementation(async (key, value) => ({ key, value, revision: 'new', updated_at: 1 })), status = vi.fn()
  const drive = { storage: { get, set } } as unknown as Drive
  return { get, set, status, store: new ProgressStore(drive, file, status) }
}
afterEach(() => vi.useRealTimers())
describe('影视 CAS 进度保存', () => {
  it('恢复前不保存，正常播放五秒节流并在暂停时立即写入', async () => {
    vi.useFakeTimers(); const s = setup()
    await s.store.load(); s.store.mark(progress(0), true); await s.store.flush(); expect(s.set).not.toHaveBeenCalled()
    s.store.restored(); s.store.mark(progress(3)); s.store.mark(progress(4))
    await vi.advanceTimersByTimeAsync(5000)
    expect(s.set).toHaveBeenCalledWith('progress:1', progress(4), null)
    s.store.mark(progress(6), true); await s.store.flush()
    expect(s.set).toHaveBeenLastCalledWith('progress:1', progress(6), 'new')
  })
  it('CAS 冲突不自动覆盖，用户明确保留本次后使用最新修订号', async () => {
    const s = setup(); await s.store.load(); s.store.restored()
    s.set.mockRejectedValueOnce({ code: 'storage_conflict' })
    s.store.mark(progress(20), true); await s.store.flush()
    expect(s.status).toHaveBeenLastCalledWith(expect.stringContaining('另一设备'), true)
    s.store.mark(progress(10)); await s.store.flush(); expect(s.set).toHaveBeenCalledTimes(1)
    s.get.mockResolvedValue({ key: 'progress:1', value: progress(50), revision: 'remote', updated_at: 2 })
    await s.store.resolve(false)
    expect(s.set).toHaveBeenLastCalledWith('progress:1', progress(10), 'remote')
  })
  it('云端选择丢弃待保存副本；覆盖文件不续播旧内容', async () => {
    const s = setup()
    s.get.mockResolvedValue({ key: 'progress:1', value: { ...progress(60), file: { ...file, content_version: 'b'.repeat(64) } }, revision: 'remote' })
    expect(await s.store.load()).toBeNull()
    s.store.restored(); s.set.mockRejectedValueOnce({ code: 'storage_conflict' })
    s.store.mark(progress(2), true); await s.store.flush(); expect(await s.store.resolve(true)).toBeNull()
    await s.store.flush(); expect(s.set).toHaveBeenCalledTimes(1)
  })
  it('读取历史失败时不产生危险新写入；退出保存未完成副本', async () => {
    const s = setup(); s.get.mockRejectedValueOnce(new Error('离线'))
    await expect(s.store.load()).rejects.toThrow('离线'); s.store.restored(); s.store.mark(progress(1), true); await s.store.flush(); expect(s.set).not.toHaveBeenCalled()
    await s.store.load(); s.store.restored(); s.store.mark(progress(3)); s.store.stop(); await s.store.flush(); expect(s.set).toHaveBeenCalledOnce()
  })
})
