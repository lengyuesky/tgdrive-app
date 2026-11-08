import { describe, expect, it, vi } from 'vitest'
import type { Drive } from '../sdk/types'
import { applyTheme, fullscreenOrder, immersiveRequest, ImmersiveSync, PLAYER_BACKGROUND, THEME_BACKGROUND } from './shell'

function sync(capabilities = ['ui.setImmersive', 'ui.immersiveBackground'], setImmersive = vi.fn(async () => {})) {
  const error = vi.fn()
  return { sync: new ImmersiveSync({ ui: { setImmersive } } as unknown as Pick<Drive, 'ui'>, { capabilities }, error), setImmersive, error }
}

describe('影视宿主沉浸与主题', () => {
  it('手机常驻沉浸并使用当前主题底色，播放时改为黑底；桌面只在播放时沉浸', () => {
    expect(immersiveRequest({ mobile: true, playing: false, dark: false })).toEqual({ active: true, background: THEME_BACKGROUND.light })
    expect(immersiveRequest({ mobile: true, playing: false, dark: true })).toEqual({ active: true, background: '#000000' })
    expect(immersiveRequest({ mobile: true, playing: true, dark: false })).toEqual({ active: true, background: PLAYER_BACKGROUND })
    expect(immersiveRequest({ mobile: false, playing: false, dark: true }).active).toBe(false)
    expect(immersiveRequest({ mobile: false, playing: true, dark: false })).toEqual({ active: true, background: PLAYER_BACKGROUND })
    expect(THEME_BACKGROUND.light).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('首页沉浸与播放沉浸合并为同一队列，不重复请求，播放结束恢复首页底色', async () => {
    const x = sync()
    await x.sync.update({ mobile: true, playing: false, dark: false })
    await x.sync.update({ mobile: true, playing: false, dark: false })
    expect(x.setImmersive).toHaveBeenCalledTimes(1)
    expect(x.setImmersive).toHaveBeenLastCalledWith(true, { background: '#f2f2f7' })
    await x.sync.update({ mobile: true, playing: true, dark: false })
    expect(x.setImmersive).toHaveBeenLastCalledWith(true, { background: '#000000' })
    // 播放结束不能退出沉浸，否则手机端宿主顶栏会突然出现。
    await x.sync.update({ mobile: true, playing: false, dark: true })
    expect(x.setImmersive).toHaveBeenLastCalledWith(true, { background: '#000000' })
    expect(x.setImmersive).not.toHaveBeenCalledWith(false, undefined)
    await x.sync.update({ mobile: true, playing: false, dark: false })
    expect(x.setImmersive).toHaveBeenLastCalledWith(true, { background: '#f2f2f7' })
    await x.sync.dispose()
    expect(x.setImmersive).toHaveBeenLastCalledWith(false, undefined)
    const calls = x.setImmersive.mock.calls.length
    await x.sync.update({ mobile: true, playing: true, dark: false })
    expect(x.setImmersive).toHaveBeenCalledTimes(calls)
  })

  it('桌面播放结束退出沉浸；宿主不支持背景色时不传 background，不支持沉浸时不调用', async () => {
    const x = sync(['ui.setImmersive'])
    await x.sync.update({ mobile: false, playing: false, dark: false })
    expect(x.setImmersive).toHaveBeenLastCalledWith(false, undefined)
    await x.sync.update({ mobile: false, playing: true, dark: false })
    expect(x.setImmersive).toHaveBeenLastCalledWith(true, undefined)
    await x.sync.update({ mobile: false, playing: false, dark: false })
    expect(x.setImmersive).toHaveBeenLastCalledWith(false, undefined)
    const none = sync([])
    await none.sync.update({ mobile: true, playing: true, dark: false }); await none.sync.dispose()
    expect(none.setImmersive).not.toHaveBeenCalled()
  })

  it('宿主拒绝后报告错误，相同状态可再次重试', async () => {
    const setImmersive = vi.fn().mockRejectedValueOnce(new Error('宿主忙')).mockResolvedValue(undefined)
    const x = sync(undefined, setImmersive)
    await x.sync.update({ mobile: true, playing: false, dark: false })
    expect(x.error).toHaveBeenCalledWith(expect.objectContaining({ message: '宿主忙' }))
    await x.sync.update({ mobile: true, playing: false, dark: false })
    expect(setImmersive).toHaveBeenCalledTimes(2)
  })

  it('根节点按主站深浅色切换 dark 类', () => {
    const root = document.createElement('html')
    applyTheme(root, true)
    expect(root.classList.contains('dark')).toBe(true); expect(root.style.colorScheme).toBe('dark')
    applyTheme(root, false)
    expect(root.classList.contains('dark')).toBe(false); expect(root.style.colorScheme).toBe('light')
  })
})

describe('影视全屏降级顺序', () => {
  const video = (native: boolean) => Object.assign(document.createElement('video'), native ? { webkitEnterFullscreen: () => {} } : {}) as HTMLVideoElement
  const element = (standard: boolean) => { const node = document.createElement('section'); Object.defineProperty(node, 'requestFullscreen', { value: standard ? async () => {} : undefined }); return node }
  const ready = (node: HTMLVideoElement, state: number) => { Object.defineProperty(node, 'readyState', { value: state }); return node }

  it('手机存在 iOS 原生视频全屏时优先使用，桌面仍优先标准全屏', () => {
    expect(fullscreenOrder(ready(video(true), 1), element(true), true)).toEqual(['native-video', 'element', 'page'])
    expect(fullscreenOrder(ready(video(true), 1), element(true), false)).toEqual(['element', 'native-video', 'page'])
    expect(fullscreenOrder(ready(video(true), 1), element(false), true)).toEqual(['native-video', 'page'])
  })

  it('视频尚无元数据或不支持原生全屏时降级到标准全屏或页面沉浸', () => {
    expect(fullscreenOrder(ready(video(true), 0), element(true), true)).toEqual(['element', 'page'])
    expect(fullscreenOrder(ready(video(false), 4), element(false), true)).toEqual(['page'])
  })
})
