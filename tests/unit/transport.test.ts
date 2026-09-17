import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ByteTicketTransport, MessageChannelTransport, createTransport } from '../../reader/io'
import type { Drive, FileEntry } from '../../sdk/types'

const ref = { id: 7, content_version: 'a'.repeat(64) }
const file = { ...ref, path: '/影视/示例.mkv', name: '示例.mkv', is_dir: false, size: 4 * 1024 * 1024, created_at: 1, modified_at: 1, favorite: false } as FileEntry

function driveOf(overrides: Partial<Drive> = {}, capabilities: string[] = []): Drive {
  return {
    can: (name: string) => capabilities.includes(name),
    media: { url: vi.fn(), bytes: vi.fn(async () => ({ url: '/api/apps/media/ticket-1', expires_at: 4102444800 })) },
    files: { readRange: vi.fn(async () => new Uint8Array([9])), readRanges: vi.fn(), list: vi.fn(), searchPage: vi.fn(), stat: vi.fn(), search: vi.fn() },
    ...overrides,
  } as unknown as Drive
}

function rangeResponse(bytes: Uint8Array<ArrayBuffer>, offset: number, status = 206, contentRange?: string) {
  return new Response(bytes, {
    status,
    headers: {
      'Content-Length': String(bytes.length),
      'Content-Range': contentRange ?? `bytes ${offset}-${offset + bytes.length - 1}/4194304`,
    },
  })
}

beforeEach(() => { vi.stubGlobal('fetch', vi.fn()) })
afterEach(() => { vi.unstubAllGlobals() })

describe('字节传输层', () => {
  it('按能力选择数据面或消息通道，未声明能力时降级', () => {
    expect(createTransport(driveOf({}, ['media.bytes']))).toBeInstanceOf(ByteTicketTransport)
    expect(createTransport(driveOf({}, []))).toBeInstanceOf(MessageChannelTransport)
  })
  it('消息通道传输直接复用 readRange', async () => {
    const drive = driveOf()
    const transport = createTransport(drive)
    await transport.read(ref, 12, 8, new AbortController().signal)
    expect(drive.files.readRange).toHaveBeenCalledWith(ref, 12, 8, { signal: expect.any(AbortSignal) })
  })
  it('票据直连：206 与 Content-Range 严格校验后返回字节', async () => {
    const drive = driveOf({}, ['media.bytes'])
    const fetch = vi.fn(async () => rangeResponse(new Uint8Array([1, 2, 3, 4]), 16))
    vi.stubGlobal('fetch', fetch)
    const transport = new ByteTicketTransport(drive)
    const bytes = await transport.read(ref, 16, 4, new AbortController().signal)
    expect([...bytes]).toEqual([1, 2, 3, 4])
    expect(fetch).toHaveBeenCalledWith('/api/apps/media/ticket-1', {
      signal: expect.any(AbortSignal), credentials: 'omit', redirect: 'error',
      headers: { Range: 'bytes=16-19' },
    })
    expect(drive.media.bytes).toHaveBeenCalledTimes(1) // 票据缓存生效
  })
  it('票据过期返回 403 时丢弃缓存重签一次后成功', async () => {
    const drive = driveOf({}, ['media.bytes'])
    const urls = ['/api/apps/media/expired', '/api/apps/media/fresh']
    ;(drive.media.bytes as ReturnType<typeof vi.fn>).mockImplementation(async () => ({ url: urls.shift(), expires_at: 4102444800 }))
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('denied', { status: 403 }))
      .mockResolvedValueOnce(rangeResponse(new Uint8Array([7]), 0))
    vi.stubGlobal('fetch', fetch)
    const transport = new ByteTicketTransport(drive)
    const bytes = await transport.read(ref, 0, 1, new AbortController().signal)
    expect([...bytes]).toEqual([7])
    expect(drive.media.bytes).toHaveBeenCalledTimes(2)
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('Content-Range 与请求不符时中止，不给解码器喂错段', async () => {
    const drive = driveOf({}, ['media.bytes'])
    vi.stubGlobal('fetch', vi.fn(async () => rangeResponse(new Uint8Array([1, 2]), 0, 206, 'bytes 8-9/4194304')))
    const transport = new ByteTicketTransport(drive)
    await expect(transport.read(ref, 0, 2, new AbortController().signal)).rejects.toThrow('请求范围')
  })
  it('宿主未按 206 回包或票据地址非法时明确报错', async () => {
    const drive = driveOf({}, ['media.bytes'])
    vi.stubGlobal('fetch', vi.fn(async () => new Response('all', { status: 200, headers: { 'Content-Length': '3' } })))
    const transport = new ByteTicketTransport(drive)
    await expect(transport.read(ref, 0, 3, new AbortController().signal)).rejects.toThrow('200')
    const bad = driveOf({}, ['media.bytes'])
    ;(bad.media.bytes as ReturnType<typeof vi.fn>).mockResolvedValue({ url: 'https://evil.example/x', expires_at: 1 })
    await expect(new ByteTicketTransport(bad).read(ref, 0, 1, new AbortController().signal)).rejects.toThrow('票据')
  })
  it('中断信号在读取过程中生效', async () => {
    const drive = driveOf({}, ['media.bytes'])
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async () => {
      controller.abort()
      return rangeResponse(new Uint8Array([1]), 0)
    }))
    const transport = new ByteTicketTransport(drive)
    await expect(transport.read(ref, 0, 1, controller.signal)).rejects.toThrow()
  })
  it('RangeFile 走数据面时不再使用消息通道', async () => {
    const { RangeFile, MiB } = await import('../../reader/io')
    const drive = driveOf({}, ['media.bytes'])
    const payload = new Uint8Array(new ArrayBuffer(2 * MiB + 100)).fill(5)
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const range = /^bytes=(\d+)-(\d+)$/.exec(String(init.headers && (init.headers as Record<string, string>).Range))!
      const start = Number(range[1]), end = Number(range[2])
      return rangeResponse(payload.subarray(start, end + 1), start)
    }))
    const reader = new RangeFile(drive, file, new AbortController().signal, 64 * MiB)
    const bytes = await reader.read(10, 100)
    expect([...bytes]).toEqual([...payload.subarray(10, 110)])
    expect(drive.files.readRange).not.toHaveBeenCalled()
    reader.destroy()
  })
})
