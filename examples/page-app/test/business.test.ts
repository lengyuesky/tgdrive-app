import { expect, it } from 'vitest'
import { MemoryHost } from '@tgdrive/test-host'
import { choose, files } from '../page/business.js'

it('页面业务只使用内存客户端，不启动宿主', async () => {
  const host = await MemoryHost.create({ app: { id: 'example-page', name: '示例', version: '1.0.0', generation: 'g1' }, files: { read: true, write: false }, scope: { mode: 'all', access: 'read_only' }, nodes: [{ id: '2', parent_id: '1', name: '示例.bin', kind: 'file', bytes: [1, 2, 3, 4] }] })
  try {
    const page = await files(host)
    expect(page.items).toHaveLength(1)
    expect(await choose(host, page.items[0])).toEqual(Uint8Array.of(1, 2, 3, 4))
    expect((await host.kvGet('last-file')).record?.value).toEqual({ id: '2', content_version: page.items[0].content_version })
  } finally { await host.dispose() }
})
