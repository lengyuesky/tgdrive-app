// @vitest-environment jsdom
/** 静态 new URL 会被 Vite 识别为页面资产，Node 工作进程路径不能走浏览器资产解析。 */
import { expect, it } from 'vitest'
import { MemoryHost } from '../src/index.js'

it('在 jsdom 中也能使用默认本地 worker 路径', async () => {
  const host = await MemoryHost.create({ app: { id: 'test', name: '测试', version: '1.0.0', generation: 'g1' }, files: { read: true, write: false }, scope: { mode: 'all', access: 'read_only' }, nodes: [] })
  try { expect((await host.kvGet('missing')).record).toBeNull() }
  finally { await host.dispose() }
})
