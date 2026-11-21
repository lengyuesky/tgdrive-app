import { describe, expect, it, vi } from 'vitest'
import { Library } from './library'
import { body, fixture, json, movie, node } from './test-fixture'

describe('影视选集分页与页面生命周期', () => {
  it('仅请求一页选集，少于一百项仍保留服务器续页游标', async () => {
    const handler = vi.fn(request => json({ items: [node('3', '/影视/电影.mp4')], total: 10205, next_cursor: 'next-page' }))
    const { cinema, signal } = await fixture(handler), library = new Library(cinema)
    library.setScope('/影视')
    const page = await library.playlist(node('3', '/影视/电影.mp4'), movie.id, null, signal)
    expect(page.items).toHaveLength(1); expect(page.total).toBe(10205); expect(page.next_cursor).toBe('next-page')
    expect(handler).toHaveBeenCalledOnce(); expect(body(handler.mock.calls[0][0])).toMatchObject({ id: '3', library_id: movie.id, cursor: null, limit: 100 })
  })
  it('超过一万项仍按游标选择，不读取完整目录或截断为一万项', async () => {
    const handler = vi.fn(request => json({ items: [node('10205', '/影视/最后一集.mp4')], total: 10205, next_cursor: null }))
    const { cinema, signal } = await fixture(handler), library = new Library(cinema)
    library.setScope('/影视'); await library.playlist(node('3', '/影视/电影.mp4'), movie.id, 'after-ten-thousand', signal)
    expect(body(handler.mock.calls[0][0]).cursor).toBe('after-ten-thousand'); expect(handler).toHaveBeenCalledOnce()
  })
  it('没有取材范围时不枚举，切换范围后不能读取旧目录', async () => {
    const handler = vi.fn(() => json(null)), { cinema, signal } = await fixture(handler), library = new Library(cinema)
    await expect(library.playlist(node('3', '/影视/电影.mp4'), movie.id, null, signal)).rejects.toThrow('当前媒体库')
    expect(handler).not.toHaveBeenCalled(); library.setScope('/电视剧')
    await expect(library.playlist(node('3', '/影视/电影.mp4'), movie.id, null, signal)).rejects.toThrow('当前媒体库')
  })
  it('旧请求迟到时不能把切换范围后的选集回填到页面', async () => {
    let release!: (value: Response) => void
    const handler = vi.fn(() => new Promise<Response>(resolve => { release = resolve }))
    const { cinema, signal } = await fixture(handler), library = new Library(cinema)
    library.setScope('/影视')
    const pending = library.playlist(node('3', '/影视/电影.mp4'), movie.id, null, signal)
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce())
    library.setScope('/电视剧'); release(json({ items: [], total: 0, next_cursor: null }))
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})
// 原完整目录缓存和一万项上限的断言不再适用：页面没有全目录缓存，真实大目录与相邻选集由 backend/tests/page.rs 验证。
