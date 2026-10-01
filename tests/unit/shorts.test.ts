import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import type { Drive } from '../../sdk/types'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const html = readFileSync(resolve(root, 'shorts/index.html'), 'utf8')
const script = readFileSync(resolve(root, 'shorts/app.js'), 'utf8')
afterEach(() => {
  window.dispatchEvent(new Event('pagehide'))
  vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren()
})
const settle = async () => { for (let step = 0; step < 20; step++) await Promise.resolve() }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
async function fixture(options: { poster?: Promise<string>; preview?: (path: string) => Promise<string>; autoplayError?: string } = {}) {
  document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML
  const video = document.querySelector('video')!
  let paused = true, hidden = false, time = 0
  Object.defineProperties(video, {
    paused: { get: () => paused }, readyState: { get: () => 4 }, duration: { get: () => 90 },
    currentTime: { get: () => time, set: (value: number) => { time = value } },
    buffered: { get: () => ({ length: 1, start: () => 0, end: () => 30 }) },
  })
  const play = vi.spyOn(video, 'play').mockImplementation(async () => {
    if (options.autoplayError) { const name = options.autoplayError; options.autoplayError = undefined; throw Object.assign(new Error(name), { name }) }
    paused = false; video.dispatchEvent(new Event('play')); video.dispatchEvent(new Event('playing'))
  })
  vi.spyOn(video, 'pause').mockImplementation(() => { paused = true; video.dispatchEvent(new Event('pause')) })
  vi.spyOn(video, 'load').mockImplementation(() => {})
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  vi.spyOn(Math, 'random').mockReturnValue(.99)
  const listeners = new Map<string, (value: unknown) => void>()
  const files = Array.from({ length: 4 }, (_, index) => ({ id: index + 1, content_version: 'a'.repeat(64), path: `/视频/${index}.mp4`, name: `${index}.mp4`, size: 1000, favorite: false }))
  const patch = vi.fn(async () => ({})), close = vi.fn(async () => {})
  const urls = vi.fn(async (ref: string | { id: number }, kind?: string) => {
    const path = typeof ref === 'string' ? ref : files.find(file => file.id === ref.id)!.path
    return kind === 'thumbnail' ? options.poster ?? '' : options.preview ? options.preview(path) : `https://media.invalid${path}`
  })
  window.tgdrive = {
    ready: Promise.resolve({ capabilities: [] }), media: { url: urls },
    files: { search: vi.fn(async () => ({ results: files })) },
    settings: { get: async () => ({ source_dir: '/视频', muted: true }), patch, open: vi.fn() },
    favorites: { set: vi.fn(async () => ({ favorite: true })) },
    ui: { close, download: vi.fn(), setImmersive: vi.fn() },
    on: (event: string, listener: (value: unknown) => void) => { listeners.set(event, listener); return () => listeners.delete(event) },
  } as unknown as Drive
  // 短视频以原生脚本发布，直接运行实际入口和实际 HTML，仅隔离媒体解码与宿主 SDK。
  window.eval(script)
  await settle()
  const click = async (id: string) => { document.getElementById(id)!.click(); await settle() }
  return { video, play, patch, urls, close, click,
    visibility: async (value: boolean) => { hidden = value; document.dispatchEvent(new Event('visibilitychange')); await settle() },
  }
}

it('封面请求迟迟未完成时，视频仍立即开始播放', async () => {
  const poster = deferred<string>()
  const { video, play } = await fixture({ poster: poster.promise })
  expect(video.getAttribute('src')).toContain('/0.mp4')
  expect(play).toHaveBeenCalledOnce()
  poster.resolve('https://media.invalid/poster.png'); await settle()
  expect(video.poster).toContain('poster.png')
})

it('用户暂停后切换声音不会重新播放', async () => {
  const { video, play, click } = await fixture()
  await click('video')
  expect(video.paused).toBe(true)
  play.mockClear()
  await click('mute')
  expect(video.muted).toBe(false)
  expect(video.paused).toBe(true)
  expect(play).not.toHaveBeenCalled()
})

it('快速切换后迟到的旧播放地址不能覆盖当前视频', async () => {
  const first = deferred<string>()
  const { video, click } = await fixture({ preview: path => path.endsWith('/0.mp4') ? first.promise : Promise.resolve(`https://media.invalid${path}`) })
  await click('next')
  expect(video.src).toContain('/1.mp4')
  first.resolve('https://media.invalid/0.mp4'); await settle()
  expect(video.src).toContain('/1.mp4')
  expect(document.getElementById('video-name')!.textContent).toBe('1.mp4')
})

it('只预取下一条地址并在切换时复用，不创建隐藏播放器', async () => {
  const { urls, click } = await fixture()
  const previews = () => urls.mock.calls.filter(([, kind]) => kind !== 'thumbnail')
  expect(previews()).toHaveLength(2)
  expect(document.querySelectorAll('video')).toHaveLength(1)
  await click('next')
  expect(previews()).toHaveLength(3)
  expect(previews().filter(([ref]) => typeof ref !== 'string' && ref.id === 2)).toHaveLength(1)
})

it('拖动进度时暂停解码，释放后只恢复原来正在播放的视频', async () => {
  const { video, click } = await fixture()
  const seek = document.getElementById('seek') as HTMLInputElement
  seek.dispatchEvent(new Event('pointerdown'))
  expect(video.paused).toBe(true)
  seek.value = '500'; seek.dispatchEvent(new Event('input'))
  expect(video.currentTime).toBe(45)
  expect(document.getElementById('playback-time')!.textContent).toBe('0:45 / 1:30')
  seek.dispatchEvent(new Event('change')); await settle()
  expect(video.paused).toBe(false)
  await click('video')
  seek.dispatchEvent(new Event('pointerdown'))
  seek.value = '750'; seek.dispatchEvent(new Event('input')); seek.dispatchEvent(new Event('change')); await settle()
  expect(video.currentTime).toBe(67.5)
  expect(video.paused).toBe(true)
})

it('前后台切换只恢复自动暂停的播放，不覆盖手动暂停', async () => {
  const { video, click, visibility } = await fixture()
  await visibility(true); expect(video.paused).toBe(true)
  await visibility(false); expect(video.paused).toBe(false)
  await click('video')
  await visibility(true); await visibility(false)
  expect(video.paused).toBe(true)
})

it('地址在后台才返回时不会偷偷播放，回到前台才继续', async () => {
  const first = deferred<string>()
  const { video, play, visibility } = await fixture({ preview: () => first.promise })
  await visibility(true)
  first.resolve('https://media.invalid/video.mp4'); await settle()
  expect(play).not.toHaveBeenCalled()
  await visibility(false)
  expect(video.paused).toBe(false)
})

it('播放失败显示重试入口，重试重新获取同一条视频地址', async () => {
  const { video, urls, click } = await fixture({ autoplayError: 'NotSupportedError' })
  expect(document.getElementById('play-error')!.hidden).toBe(false)
  expect(document.getElementById('buffering')!.hidden).toBe(true)
  expect(document.getElementById('play-error-message')!.textContent).toContain('不支持')
  await click('retry-video')
  expect(video.src).toContain('/0.mp4')
  expect(video.paused).toBe(false)
  expect(urls.mock.calls.filter(([ref, kind]) => typeof ref !== 'string' && ref.id === 1 && kind !== 'thumbnail')).toHaveLength(2)
})

it('自动播放被阻止时可手动继续，不显示格式错误', async () => {
  const { video, click } = await fixture({ autoplayError: 'NotAllowedError' })
  expect(document.getElementById('play-prompt')!.hidden).toBe(false)
  expect(document.getElementById('play-error')!.hidden).toBe(true)
  await click('play-prompt')
  expect(video.paused).toBe(false)
})

it('同一次滚轮惯性只切换一次，停顿后才接收下一次手势', async () => {
  await fixture()
  let now = 1000
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const wheel = () => document.getElementById('player')!.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, cancelable: true }))
  wheel()
  for (let i = 0; i < 8; i++) { now += 80; wheel() }
  await settle()
  expect(document.getElementById('video-name')!.textContent).toBe('1.mp4')
  now += 200; wheel(); await settle()
  expect(document.getElementById('video-name')!.textContent).toBe('2.mp4')
})

it('进度条和按钮获得焦点时不抢占它们的键盘操作', async () => {
  const { play } = await fixture()
  play.mockClear()
  document.getElementById('seek')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  document.getElementById('favorite')!.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
  await settle()
  expect(document.getElementById('video-name')!.textContent).toBe('0.mp4')
  expect(play).not.toHaveBeenCalled()
})

it('退出后清空媒体并忽略迟到地址，键盘监听也被移除', async () => {
  const first = deferred<string>()
  const { video, click, close } = await fixture({ preview: () => first.promise })
  await click('exit')
  first.resolve('https://media.invalid/video.mp4'); await settle()
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); await settle()
  expect(close).toHaveBeenCalledOnce()
  expect(video.hasAttribute('src')).toBe(false)
  expect(document.getElementById('video-name')!.textContent).toBe('0.mp4')
})
