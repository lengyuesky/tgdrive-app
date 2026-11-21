import { describe, expect, it, vi } from 'vitest'
import { applyTheme, fullscreenOrder, immersiveRequest, ImmersiveSync, PLAYER_BACKGROUND, THEME_BACKGROUND } from './shell'

function sync(setImmersive = vi.fn(async () => {})) { const error = vi.fn(); return { sync: new ImmersiveSync({ setImmersive }, error), setImmersive, error } }
describe('影视沉浸与主题', () => {
  it('手机常驻沉浸并跟随主题，播放改黑底；桌面只在播放时沉浸', () => {
    expect(immersiveRequest({ mobile: true, playing: false, dark: false })).toEqual({ active: true, background: THEME_BACKGROUND.light })
    expect(immersiveRequest({ mobile: true, playing: false, dark: true })).toEqual({ active: true, background: '#000000' })
    expect(immersiveRequest({ mobile: true, playing: true, dark: false })).toEqual({ active: true, background: PLAYER_BACKGROUND })
    expect(immersiveRequest({ mobile: false, playing: false, dark: true }).active).toBe(false)
    expect(THEME_BACKGROUND.light).toMatch(/^#[0-9a-f]{6}$/)
  })
  it('外观请求按顺序合并，不重复发送；播放结束与离开页面正确恢复', async () => {
    const item = sync()
    await item.sync.update({ mobile: true, playing: false, dark: false }); await item.sync.update({ mobile: true, playing: false, dark: false })
    expect(item.setImmersive).toHaveBeenCalledOnce(); expect(item.setImmersive).toHaveBeenLastCalledWith({ active: true, background: '#f2f2f7' })
    await item.sync.update({ mobile: true, playing: true, dark: false }); expect(item.setImmersive).toHaveBeenLastCalledWith({ active: true, background: '#000000' })
    await item.sync.update({ mobile: false, playing: false, dark: false }); expect(item.setImmersive).toHaveBeenLastCalledWith({ active: false, background: '#f2f2f7' })
    await item.sync.dispose(); expect(item.setImmersive).toHaveBeenLastCalledWith({ active: false })
    const count = item.setImmersive.mock.calls.length
    await item.sync.update({ mobile: true, playing: true, dark: false }); expect(item.setImmersive).toHaveBeenCalledTimes(count)
  })
  it('宿主拒绝后显示错误，相同外观可以再次请求', async () => {
    const callback = vi.fn().mockRejectedValueOnce(new Error('宿主忙')).mockResolvedValue(undefined), item = sync(callback)
    await item.sync.update({ mobile: true, playing: false, dark: false }); expect(item.error).toHaveBeenCalledOnce()
    await item.sync.update({ mobile: true, playing: false, dark: false }); expect(callback).toHaveBeenCalledTimes(2)
  })
  it('根节点与原生控件跟随宿主深浅色', () => {
    const root = document.createElement('html'); applyTheme(root, true)
    expect(root.classList.contains('dark')).toBe(true); expect(root.style.colorScheme).toBe('dark')
    applyTheme(root, false); expect(root.classList.contains('dark')).toBe(false); expect(root.style.colorScheme).toBe('light')
  })
})
describe('影视全屏降级', () => {
  const video = (native: boolean, state = 1) => { const node = Object.assign(document.createElement('video'), native ? { webkitEnterFullscreen: () => {} } : {}); Object.defineProperty(node, 'readyState', { value: state }); return node }
  const element = (standard: boolean) => { const node = document.createElement('section'); Object.defineProperty(node, 'requestFullscreen', { value: standard ? async () => {} : undefined }); return node }
  it('手机优先原生视频全屏，桌面仍优先标准全屏', () => {
    expect(fullscreenOrder(video(true), element(true), true)).toEqual(['native-video', 'element', 'page'])
    expect(fullscreenOrder(video(true), element(true), false)).toEqual(['element', 'native-video', 'page'])
    expect(fullscreenOrder(video(true), element(false), true)).toEqual(['native-video', 'page'])
  })
  it('未就绪或不支持全屏时仍可使用页面沉浸', () => {
    expect(fullscreenOrder(video(true, 0), element(true), true)).toEqual(['element', 'page'])
    expect(fullscreenOrder(video(false, 4), element(false), true)).toEqual(['page'])
  })
})
// 旧宿主的 ui.immersiveBackground 分离能力已经删除；第 1 版统一接收完整 ImmersiveRequest。
