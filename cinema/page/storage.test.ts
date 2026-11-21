import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CinemaProgress } from './model'
import type { CinemaRecord } from './client'
import { ProgressStore } from './storage'
import { body, failure, fixture, json } from './test-fixture'

afterEach(() => vi.useRealTimers())
async function setup() {
  const state: { record: CinemaRecord<CinemaProgress> | null; active: string; serial: number; fail?: boolean; offline?: boolean } = { record: null, active: '', serial: 0 }
  const calls: Array<Record<string, unknown>> = [], status = vi.fn()
  const { host, cinema } = await fixture(request => {
    const value = body(request)
    if (request.path === '/owner/storage/get') { if (state.offline) return failure('backend_unavailable', '离线', 503); return json(state.record) }
    if (request.path === '/owner/play/start') { state.active = `play${++state.serial}`; return json({ play_id: state.active }) }
    if (request.path === '/owner/play/quit') return json({ ok: true })
    if (request.path === '/owner/storage/set') {
      calls.push(value)
      if (state.fail || value.play_id !== state.active) return failure()
      state.record = { key: String(value.key), value: value.value as CinemaProgress, revision: `saved${calls.length}` }
      return json(state.record)
    }
    return json(null)
  })
  const file = await host.stat({ by: 'id', id: '3' }), progress = (seconds: number): CinemaProgress => ({ file, seconds, duration: 100, completed: false })
  return { state, calls, status, progress, store: new ProgressStore(cinema, file, status) }
}

describe('影视后端进度与播放权威', () => {
  it('恢复或详情查询不保存，实际起播后每五秒合并进度并在暂停时立即写', async () => {
    const test = await setup(); await test.store.load()
    test.store.mark(test.progress(0), true); await test.store.flush(); expect(test.calls).toHaveLength(0); expect(test.state.serial).toBe(0)
    await test.store.restored(); vi.useFakeTimers()
    test.store.mark(test.progress(3)); test.store.mark(test.progress(4)); await vi.advanceTimersByTimeAsync(5000); await test.store.flush()
    expect(test.calls[0]).toMatchObject({ key: 'progress:3', value: test.progress(4), revision: null, play_id: 'play1' })
    test.store.mark(test.progress(6), true); await test.store.flush()
    expect(test.calls[1]).toMatchObject({ value: test.progress(6), revision: 'saved1', play_id: 'play1' })
    test.store.stop()
  })
  it('新客户端取得权威后不自动覆盖，明确保留本次才重新取得代次', async () => {
    const test = await setup(); await test.store.load(); await test.store.restored()
    test.state.active = 'external'; test.state.record = { key: 'progress:3', value: test.progress(50), revision: 'remote' }
    test.store.mark(test.progress(20), true); await test.store.flush()
    expect(test.status).toHaveBeenLastCalledWith(expect.stringContaining('另一播放'), true)
    test.store.mark(test.progress(10)); await test.store.flush(); expect(test.calls).toHaveLength(1); expect(test.state.serial).toBe(1)
    await test.store.resolve(false)
    expect(test.state.serial).toBe(2); expect(test.calls[1]).toMatchObject({ value: test.progress(10), revision: 'remote', play_id: 'play2' })
    test.store.stop()
  })
  it('采用远端会丢弃待保存副本，替换文件不恢复旧版本的进度', async () => {
    const test = await setup()
    test.state.record = { key: 'progress:3', value: { ...test.progress(60), file: { ...test.progress(60).file, content_version: 'replaced' } }, revision: 'remote' }
    expect(await test.store.load()).toBeNull(); await test.store.restored()
    test.state.fail = true; test.store.mark(test.progress(2), true); await test.store.flush()
    expect(await test.store.resolve(true)).toBeNull(); await test.store.flush(); expect(test.calls).toHaveLength(1)
    test.store.stop()
  })
  it('历史读取失败不产生新进度，退出仍保存最后的待保存副本', async () => {
    const test = await setup(); test.state.offline = true
    await expect(test.store.load()).rejects.toThrow('离线'); await test.store.restored(); test.store.mark(test.progress(1), true); await test.store.flush()
    expect(test.calls).toHaveLength(0); expect(test.state.serial).toBe(0)
    test.state.offline = false; await test.store.load(); await test.store.restored()
    test.store.mark(test.progress(3)); await test.store.close(); expect(test.calls).toHaveLength(1)
  })
})
