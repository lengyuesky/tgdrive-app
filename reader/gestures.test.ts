import { afterEach, expect, it, vi } from 'vitest'
import { ReadingGestures } from './gestures'
let cleanup: () => void
function setup(paged = true) {
  const viewport = document.createElement('main'); document.body.append(viewport)
  const toggle = vi.fn(), turn = vi.fn()
  let controls = false, blocked = false, clock = 0
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  const gestures = new ReadingGestures(viewport, { enabled: () => !blocked, paged: () => paged, controls: () => controls, toggle, turn })
  cleanup = () => { gestures.destroy(); viewport.remove() }
  const send = (type: string, x: number, y = 100, id = 1, target: HTMLElement = viewport) => {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.assign(event, { pointerId: id, button: 0, clientX: x, clientY: y })
    target.dispatchEvent(event)
  }
  const tap = (x: number) => { send('pointerdown', x); clock += 50; send('pointerup', x) }
  return { viewport, toggle, turn, send, tap, controls: () => { controls = true }, block: () => { blocked = true }, time: (value: number) => { clock += value } }
}
afterEach(() => { cleanup?.(); window.getSelection()?.removeAllRanges(); vi.restoreAllMocks() })
it('中央点按显示菜单，隐藏状态两侧翻页，菜单显示时不会顺带翻页', () => {
  const app = setup()
  app.tap(500); expect(app.toggle).toHaveBeenCalledOnce()
  app.tap(100); app.tap(900); expect(app.turn.mock.calls).toEqual([[-1], [1]])
  app.controls(); app.tap(100); expect(app.toggle).toHaveBeenCalledTimes(2); expect(app.turn).toHaveBeenCalledTimes(2)
})
it('滚动模式保留边缘与纵向手势，只在中央轻点时唤出菜单', () => {
  const app = setup(false)
  app.tap(100); app.send('pointerdown', 500, 100); app.send('pointermove', 500, 300); app.send('pointerup', 500, 300)
  app.send('pointerdown', 800); app.send('pointerup', 300)
  expect(app.turn).not.toHaveBeenCalled(); expect(app.toggle).not.toHaveBeenCalled()
  app.tap(500); expect(app.toggle).toHaveBeenCalledOnce()
})
it('只有明显横向滑动翻页，长按、多指、取消、面板和链接都不触发', () => {
  const app = setup()
  app.send('pointerdown', 800); app.send('pointerup', 400); expect(app.turn).toHaveBeenLastCalledWith(1)
  app.send('pointerdown', 400); app.send('pointerup', 800); expect(app.turn).toHaveBeenLastCalledWith(-1)
  app.send('pointerdown', 500); app.time(500); app.send('pointerup', 500)
  app.send('pointerdown', 500); app.send('pointerdown', 700, 100, 2); app.send('pointerup', 700, 100, 2); app.send('pointerup', 500)
  app.send('pointerdown', 500); app.send('pointercancel', 500); app.send('pointerup', 500)
  const link = document.createElement('a'); link.textContent = '内部链接'; app.viewport.append(link)
  app.send('pointerdown', 500, 100, 1, link); app.send('pointerup', 500, 100, 1, link)
  app.block(); app.tap(900)
  expect(app.turn).toHaveBeenCalledTimes(2); expect(app.toggle).not.toHaveBeenCalled()
})
it('纵向滚动位移和已有选区不能误触发菜单', () => {
  const app = setup()
  app.send('pointerdown', 500); app.viewport.scrollTop = 50; app.send('pointerup', 500)
  app.viewport.textContent = '可以正常选择的正文'
  const range = document.createRange(); range.selectNodeContents(app.viewport); window.getSelection()?.addRange(range)
  app.tap(500); expect(app.toggle).not.toHaveBeenCalled(); expect(app.turn).not.toHaveBeenCalled()
})
