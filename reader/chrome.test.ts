import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReaderChrome } from './chrome'
import type { Drive, ReadyContext } from '../sdk/types'

const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup())
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

function setup(desktopControls = true, mobile = false, supported = true) {
  document.body.innerHTML = `<div id="app">
    <main id="viewport" tabindex="0"></main><button id="back"></button>
    <button id="reader-menu-toggle"></button><button id="toc-toggle"></button><button id="reader-more-toggle"></button>
    <button id="reader-backdrop" hidden></button>
    <div id="reader-desktop-actions"><div id="reader-actions"></div></div><div id="reader-footer-actions"></div>
    <section id="preferences" hidden><button>关闭</button></section><section id="bookmarks" hidden><button>关闭</button></section>
    <section id="navigation" hidden><button>关闭</button></section><section id="reader-more" hidden><button>关闭</button></section>
  </div>`
  const root = document.getElementById('app')!
  const media = { matches: mobile, addEventListener: vi.fn(), removeEventListener: vi.fn() }
  vi.stubGlobal('matchMedia', vi.fn(() => media))
  document.body.style.setProperty('--bg', '#f5f6f2')
  const setImmersive = vi.fn(async () => {})
  const chrome = new ReaderChrome(root, {
    drive: { ui: { setImmersive } } as unknown as Drive,
    context: { capabilities: supported ? ['ui.setImmersive', 'ui.immersiveBackground'] : [] } as unknown as ReadyContext,
    immersive: true, desktopControls, paged: () => false, turn: vi.fn(), error: vi.fn(),
  })
  cleanups.push(() => chrome.destroy())
  return { chrome, root, media, setImmersive }
}

describe('阅读馆全屏阅读菜单', () => {
  it('桌面请求宿主全屏但保留桌面悬浮控件，显隐和面板不退出全屏，离开后恢复宿主', async () => {
    const x = setup()
    await x.chrome.enter(); x.chrome.opened()
    expect(x.root.classList.contains('reader-desktop')).toBe(true)
    expect(x.root.classList.contains('immersive')).toBe(false)
    expect(x.setImmersive).toHaveBeenCalledWith(true, { background: '#f5f6f2' })
    expect(x.root.dataset.controls).toBe('visible')
    x.chrome.toggle(); expect(x.root.dataset.controls).toBe('hidden')
    x.chrome.togglePanel('preferences'); expect(x.root.dataset.controls).toBe('visible')
    x.chrome.closePanel(); x.chrome.toggle()
    expect(x.setImmersive).toHaveBeenCalledTimes(1)
    document.body.style.setProperty('--bg', '#141d1c')
    await x.chrome.themeChanged()
    expect(x.setImmersive).toHaveBeenLastCalledWith(true, { background: '#141d1c' })
    await x.chrome.leave()
    expect(x.setImmersive).toHaveBeenLastCalledWith(false, undefined)
    expect(x.root.classList.contains('reader-desktop')).toBe(false)
  })

  it('阅读中桌面与手机切换只改变菜单布局，宿主不反复退出全屏', async () => {
    const x = setup()
    await x.chrome.enter(); x.chrome.opened()
    x.media.matches = true; x.media.addEventListener.mock.calls[0]![1]()
    expect(x.root.classList.contains('immersive')).toBe(true)
    expect(x.root.classList.contains('reader-desktop')).toBe(false)
    expect(x.root.dataset.controls).toBe('hidden')
    expect(document.getElementById('reader-actions')?.parentElement?.id).toBe('reader-footer-actions')
    x.media.matches = false; x.media.addEventListener.mock.calls[0]![1]()
    expect(x.root.classList.contains('reader-desktop')).toBe(true)
    expect(document.getElementById('reader-actions')?.parentElement?.id).toBe('reader-desktop-actions')
    await x.chrome.themeChanged()
    expect(x.setImmersive).toHaveBeenCalledTimes(1)
  })

  it('宿主未声明全屏能力时仍可使用本地阅读菜单，不调用缺失能力', async () => {
    const x = setup(true, false, false)
    await x.chrome.enter(); x.chrome.opened(); x.chrome.toggle()
    expect(x.root.dataset.controls).toBe('hidden')
    expect(x.setImmersive).not.toHaveBeenCalled()
  })

  it('兼容独立书漫桌面入口不改变原宿主模式，手机仍请求全屏并默认收起菜单', async () => {
    const desktop = setup(false)
    await desktop.chrome.enter(); desktop.chrome.opened()
    expect(desktop.setImmersive).not.toHaveBeenCalled()
    desktop.chrome.destroy()
    const mobile = setup(false, true)
    await mobile.chrome.enter(); mobile.chrome.opened()
    expect(mobile.setImmersive).toHaveBeenCalledWith(true, { background: '#f5f6f2' })
    expect(mobile.root.dataset.controls).toBe('hidden')
  })
})
