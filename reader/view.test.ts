import { afterEach, expect, it, vi } from 'vitest'
import { canvasThumbnail, type ReaderView } from './view'

// 旧实现不必补 capabilities、loadNavigation、thumbnail 或末端字段。
const oldView: ReaderView = {
  title: '旧阅读器', sections: [], open: async () => {}, current: () => ({ format: 'txt', index: 0 }),
  navigationState: () => ({ sectionIndex: 0, sectionCount: 0, canPrevious: false, canNext: false }),
  turn: async () => {}, go: async () => {}, restore: async () => {}, configure: async () => {}, destroy: () => {},
}
afterEach(() => vi.unstubAllGlobals())
function canvas() {
  const element = document.createElement('canvas'); element.width = 160; element.height = 240
  const created = vi.fn(() => 'blob:thumbnail'), released = vi.fn()
  vi.stubGlobal('URL', { createObjectURL: created, revokeObjectURL: released })
  let callback: BlobCallback | undefined
  vi.spyOn(element, 'toBlob').mockImplementation(next => { callback = next })
  return { element, created, released, finish: (value: Blob | null = new Blob(['图片'], { type: 'image/png' })) => callback!(value) }
}
it('可选阅读契约保持旧 mock 兼容', () => {
  expect(oldView.capabilities).toBeUndefined(); expect(oldView.navigationState().atEnd).toBeUndefined()
})
it('编码后的缩略图可重复释放，取消已完成的请求也会释放 URL', async () => {
  const fixture = canvas(), controller = new AbortController(), pending = canvasThumbnail(fixture.element, controller.signal)
  fixture.finish(); const result = await pending
  expect(result).toMatchObject({ url: 'blob:thumbnail', width: 160, height: 240 })
  result.release(); result.release(); controller.abort()
  expect(fixture.released).toHaveBeenCalledExactlyOnceWith('blob:thumbnail')
  const next = new AbortController(), other = canvasThumbnail(fixture.element, next.signal)
  fixture.finish(); await other; next.abort()
  expect(fixture.released).toHaveBeenCalledTimes(2)
})
it('编码途中取消立即拒绝，迟到回调不创建 URL', async () => {
  const fixture = canvas(), controller = new AbortController(), pending = canvasThumbnail(fixture.element, controller.signal)
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort(); await rejected; fixture.finish()
  expect(fixture.created).not.toHaveBeenCalled(); expect(fixture.released).not.toHaveBeenCalled()
})
it('尺寸、空编码结果和 URL 创建失败都有真实错误而非未处理回调', async () => {
  const fixture = canvas(), controller = new AbortController()
  fixture.element.width = 321
  await expect(canvasThumbnail(fixture.element, controller.signal)).rejects.toThrow('尺寸')
  fixture.element.width = 160
  const empty = canvasThumbnail(fixture.element, controller.signal); fixture.finish(null)
  await expect(empty).rejects.toThrow('生成')
  fixture.created.mockImplementationOnce(() => { throw new Error('URL 不可用') })
  const failed = canvasThumbnail(fixture.element, controller.signal); fixture.finish()
  await expect(failed).rejects.toThrow('URL 不可用')
})
