import { expect, it, vi } from 'vitest'
import { SAMPLE_SIZE, BACKTRACK_LIMIT } from './queue'
import { deferred, fileId, fixture, settle } from './test-fixtures'

it('封面请求迟迟未完成时，视频仍立即开始播放，票据可直接使用相对路径', async () => {
  const poster = deferred<string>(), x = await fixture({ poster: poster.promise })
  expect(x.video.getAttribute('src')).toBe(x.issued.get(fileId(0))![0]); expect(x.video.getAttribute('src')).toMatch(/^\/admin\//)
  expect(x.play).toHaveBeenCalledOnce()
  poster.resolve('/admin/api/apps/v1/media/poster'); await settle()
  expect(x.video.getAttribute('poster')).toBe('/admin/api/apps/v1/media/poster')
})

it('用户暂停后切换声音不会重新播放，偏好保存到应用 KV', async () => {
  const x = await fixture(); await x.click('video'); expect(x.video.paused).toBe(true); x.play.mockClear()
  await x.click('mute'); expect(x.video.muted).toBe(false); expect(x.video.paused).toBe(true); expect(x.play).not.toHaveBeenCalled()
  expect(x.kvPut.mock.calls.some(([key, request]) => key === 'shorts:settings' && (request.value as { muted: boolean }).muted === false)).toBe(true)
})

it('快速切换后迟到的旧播放地址不能覆盖当前视频', async () => {
  const first = deferred<string>()
  const x = await fixture({ preview: path => path.endsWith('/0.mp4') ? first.promise : Promise.resolve('/admin/api/apps/v1/media/next') })
  await vi.waitFor(() => expect(x.urls.mock.calls.some(([request]) => request.file.id === fileId(0) && request.representation === 'original')).toBe(true))
  await x.click('next'); expect(x.video.getAttribute('src')).toBe('/admin/api/apps/v1/media/next')
  first.resolve('/admin/api/apps/v1/media/late-first'); await settle()
  expect(x.video.getAttribute('src')).toBe('/admin/api/apps/v1/media/next'); expect(document.getElementById('video-name')!.textContent).toBe('1.mp4')
})

it('只预取下一条地址并在切换时复用，不创建隐藏播放器', async () => {
  const x = await fixture(), previews = () => x.urls.mock.calls.filter(([request]) => request.representation === 'original')
  expect(previews()).toHaveLength(2); expect(document.querySelectorAll('video')).toHaveLength(1)
  await x.click('next'); expect(previews()).toHaveLength(3)
  expect(previews().filter(([request]) => request.file.id === fileId(1))).toHaveLength(1)
})

it('拖动进度时暂停解码，释放后只恢复原来正在播放的视频', async () => {
  const x = await fixture(), seek = document.getElementById('seek') as HTMLInputElement
  seek.dispatchEvent(new Event('pointerdown')); expect(x.video.paused).toBe(true)
  seek.value = '500'; seek.dispatchEvent(new Event('input')); expect(x.video.currentTime).toBe(45)
  expect(document.getElementById('playback-time')!.textContent).toBe('0:45 / 1:30')
  seek.dispatchEvent(new Event('change')); await settle(); expect(x.video.paused).toBe(false)
  await x.click('video'); seek.dispatchEvent(new Event('pointerdown')); seek.value = '750'; seek.dispatchEvent(new Event('input')); seek.dispatchEvent(new Event('change')); await settle()
  expect(x.video.currentTime).toBe(67.5); expect(x.video.paused).toBe(true)
})

it('前后台切换只恢复自动暂停的播放，不覆盖手动暂停', async () => {
  const x = await fixture(); await x.visibility(true); expect(x.video.paused).toBe(true)
  await x.visibility(false); expect(x.video.paused).toBe(false)
  await x.click('video'); await x.visibility(true); await x.visibility(false); expect(x.video.paused).toBe(true)
})

it('地址在后台才返回时不会偷偷播放，回到前台才继续', async () => {
  const first = deferred<string>(), x = await fixture({ preview: () => first.promise })
  await vi.waitFor(() => expect(x.urls.mock.calls.some(([request]) => request.representation === 'original')).toBe(true))
  await x.visibility(true); first.resolve('/admin/api/apps/v1/media/background'); await x.loaded()
  expect(x.play).not.toHaveBeenCalled(); await x.visibility(false); expect(x.video.paused).toBe(false)
})

it('播放失败显示重试入口，重试显式重新签发同一条视频地址', async () => {
  const x = await fixture({ autoplayError: 'NotSupportedError' })
  expect(document.getElementById('play-error')!.hidden).toBe(false); expect(document.getElementById('buffering')!.hidden).toBe(true)
  expect(document.getElementById('play-error-message')!.textContent).toContain('不支持')
  await x.click('retry-video'); await vi.waitFor(() => expect(x.video.paused).toBe(false))
  expect(x.video.dataset.fileId).toBe(fileId(0))
  expect(x.urls.mock.calls.filter(([request]) => request.file.id === fileId(0) && request.representation === 'original')).toHaveLength(2)
})

it('自动播放被阻止时可手动继续，不显示格式错误', async () => {
  const x = await fixture({ autoplayError: 'NotAllowedError' })
  expect(document.getElementById('play-prompt')!.hidden).toBe(false); expect(document.getElementById('play-error')!.hidden).toBe(true)
  await x.click('play-prompt'); expect(x.video.paused).toBe(false)
})

it('同一次滚轮惯性只切换一次，停顿后才接收下一次手势', async () => {
  const x = await fixture(); let now = 1000; vi.spyOn(performance, 'now').mockImplementation(() => now)
  const wheel = () => document.getElementById('player')!.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, cancelable: true }))
  wheel(); for (let index = 0; index < 8; index++) { now += 80; wheel() }
  await vi.waitFor(() => expect(document.getElementById('video-name')!.textContent).toBe('1.mp4')); await x.loaded()
  now += 200; wheel(); await vi.waitFor(() => expect(document.getElementById('video-name')!.textContent).toBe('2.mp4')); await x.loaded()
})

it('进度条和按钮获得焦点时不抢占它们的键盘操作', async () => {
  const x = await fixture(); x.play.mockClear()
  document.getElementById('seek')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  document.getElementById('favorite')!.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })); await settle()
  expect(document.getElementById('video-name')!.textContent).toBe('0.mp4'); expect(x.play).not.toHaveBeenCalled()
})

it('退出后清空媒体并忽略迟到地址，键盘监听也被移除', async () => {
  const first = deferred<string>(), x = await fixture({ preview: () => first.promise })
  await vi.waitFor(() => expect(x.urls.mock.calls.some(([request]) => request.representation === 'original')).toBe(true))
  await x.click('exit'); first.resolve('/admin/api/apps/v1/media/late'); await settle()
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); await settle()
  expect(x.close).toHaveBeenCalledOnce(); expect(x.video.hasAttribute('src')).toBe(false); expect(document.getElementById('video-name')!.textContent).toBe('0.mp4')
})

it('超过 2000 个视频连续切换仍只随机取材，近期回看和排除集合始终有界', async () => {
  const x = await fixture({ paged: 2005, thumbnail: false }), query = vi.spyOn(x.host, 'query'), list = vi.spyOn(x.host, 'list')
  expect(x.random).toHaveBeenCalledOnce(); expect(x.random.mock.calls[0]![0].limit).toBe(SAMPLE_SIZE)
  const viewed = new Set<string>()
  for (let index = 0; index < 2001; index++) { viewed.add(x.video.dataset.fileId!); await x.click('next') }
  expect([...viewed].some(id => Number(id) > 2000)).toBe(true)
  const text = document.getElementById('video-meta')!.textContent!
  expect(Number(text.split('/')[1]!.trim().split(' ')[0])).toBeLessThanOrEqual(BACKTRACK_LIMIT + SAMPLE_SIZE + 6)
  expect(x.random.mock.calls.length).toBeGreaterThan(30)
  expect(x.random.mock.calls.every(([request]) => request.exclude_ids.length <= 512 && new Set(request.exclude_ids).size === request.exclude_ids.length)).toBe(true)
  expect(query).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled()
}, 120_000)

it('无关文件变更不打断取材，相关变更在下一次切换用随机接口核对', async () => {
  const x = await fixture()
  await x.host.addNode({ id: '900', parent_id: '1', name: '其他', kind: 'directory' })
  await x.host.addNode({ id: '901', parent_id: '900', name: '其他.mp4', kind: 'file', bytes: [] })
  const before = x.changes.mock.calls.length
  await x.emitEvent('files.changed', {})
  await vi.waitFor(() => expect(x.changes.mock.calls.length).toBeGreaterThan(before)); await x.changes.mock.results.at(-1)!.value; await settle()
  await x.click('next'); expect(x.random).toHaveBeenCalledOnce(); expect(x.video.dataset.fileId).toBe(fileId(1))
  await x.host.addNode({ id: '902', parent_id: '1000000', name: '新增.mp4', kind: 'file', bytes: [] })
  const previous = x.changes.mock.calls.length; await x.emitEvent('files.changed', {})
  await vi.waitFor(() => expect(x.changes.mock.calls.length).toBeGreaterThan(previous)); await x.changes.mock.results.at(-1)!.value; await settle()
  expect(x.random).toHaveBeenCalledOnce(); await x.click('next'); expect(x.random.mock.calls.length).toBeGreaterThan(1)
})

it.each(['next', 'previous'] as const)('随机续填等待中以最后一次 %s 操作为准，不连跳或被旧请求拉回', async direction => {
  const x = await fixture({ paged: 75 }), waiting = deferred(), requested = deferred()
  let nextId = ''
  x.random.mockImplementationOnce(async (...args) => { const page = await x.native.random(...args); page.items.sort((a, b) => Number(a.id) - Number(b.id)); nextId = page.items[0]!.id; requested.resolve(); await waiting.promise; return page })
  const positions = [x.video.dataset.fileId!]
  for (let index = 0; index < SAMPLE_SIZE - 1; index++) { await x.click('next'); positions.push(x.video.dataset.fileId!) }
  await requested.promise; const old = x.video.dataset.fileId
  await x.click('next', false); await x.click(direction, false); waiting.resolve()
  const expected = direction === 'next' ? nextId : positions.at(-2)
  await vi.waitFor(() => expect(document.getElementById('video-name')?.dataset.fileId).toBe(expected)); await x.loaded()
  expect(x.video.dataset.fileId).not.toBe(old)
})
