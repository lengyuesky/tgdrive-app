import { afterEach, describe, expect, it } from 'vitest'
import { MemoryHost } from '../src/index.js'
import type { MemoryConfig } from '../src/index.js'
import type { FileQuery } from '@tgdrive/page-sdk/contract'
import { CACHE_TICKET_BASE, MEDIA_TICKET_BASE } from '@tgdrive/page-sdk/contract'

const clients: MemoryHost[] = []
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.dispose())) })
const config: MemoryConfig = { app: { id: 'example', name: '示例', version: '1.0.0', generation: 'g1' }, files: { read: true, write: true }, scope: { mode: 'selected', directories: [{ directory_id: '2', access: 'read_write' }] }, has_backend: false, nodes: [{ id: '2', parent_id: '1', name: '授权', kind: 'directory' }, { id: '3', parent_id: '2', name: 'file.bin', kind: 'file', bytes: [0, 1, 2, 3, 4] }, { id: '4', parent_id: '1', name: '外部', kind: 'directory' }, { id: '5', parent_id: '4', name: '秘密.bin', kind: 'file', bytes: [99] }] }
async function host() { const client = await MemoryHost.create(config); clients.push(client); return client }
function query(): FileQuery { return { roots: [], recursive: true, filter: { kind: 'file', extensions: [], include_hidden: false }, sort: 'id', order: 'asc', limit: 1 } }

it('工作进程未构建时明确报错，不触发 cargo 或测试超时', async () => {
  await expect(MemoryHost.create(config, { workerPath: '/不存在/tgdrive-test-worker' })).rejects.toThrow('测试工作进程未构建或不可执行')
})

describe('页面测试使用真实 Rust 契约规则而不是运行宿主', () => {
  it('内存文件授权、Range 与条件响应', async () => {
    const client = await host()
    const file = await client.stat({ by: 'id', id: '3' })
    const reference = { id: file.id, content_version: file.content_version! }
    expect(await client.readRange(reference, { offset: '1', length: '3' })).toEqual(Uint8Array.of(1, 2, 3))
    await expect(client.stat({ by: 'id', id: '5' })).rejects.toMatchObject({ code: 'scope_denied' })
    await expect(client.bytes(reference, { range: 'bytes=0-1,3-4' })).rejects.toMatchObject({ code: 'range_not_satisfiable' })
    expect((await client.bytes(reference, { ifNoneMatch: `W/"v${file.content_version}"` })).status).toBe(304)
    await client.setScope({ mode: 'none' })
    await expect(client.bytes(reference, { ifNoneMatch: '*' })).rejects.toMatchObject({ code: 'scope_denied' })
  })
  it('游标绑定查询与授权，授权根更名仍跟随 ID', async () => {
    const client = await host()
    await client.addNode({ id: '6', parent_id: '2', name: 'second.bin', kind: 'file', bytes: [1] })
    const first = await client.query(query())
    expect(first.next_cursor).not.toBeNull()
    const next = await client.query({ ...query(), cursor: first.next_cursor })
    expect(next.scan_cursor).toBe(first.scan_cursor)
    await expect(client.query({ ...query(), limit: 2, cursor: first.next_cursor })).rejects.toMatchObject({ code: 'invalid_cursor' })
    await client.changeNode({ id: '2', name: '改名' })
    expect((await client.stat({ by: 'id', id: '3' })).path).toBe('/改名/file.bin')
    await expect(client.query({ ...query(), cursor: first.next_cursor })).rejects.toMatchObject({ code: 'scope_changed' })
  })
  it('KV CAS 并发、null 与 ABA 完全由同一核心判定', async () => {
    const client = await host()
    expect((await client.kvGet('state')).record).toBeNull()
    const initial = await client.kvPut('state', { value: null, condition: { type: 'absent' } })
    expect((await client.kvGet('state')).record?.value).toBeNull()
    const writes = await Promise.allSettled([client.kvPut('state', { value: 1, condition: { type: 'revision', revision: initial.revision } }), client.kvPut('state', { value: 2, condition: { type: 'revision', revision: initial.revision } })])
    expect(writes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const current = (await client.kvGet('state')).record!
    await client.kvDelete('state', { revision: current.revision })
    const recreated = await client.kvPut('state', { value: 3, condition: { type: 'absent' } })
    expect(recreated.revision).not.toBe(initial.revision)
    await expect(client.kvDelete('state', { revision: initial.revision })).rejects.toMatchObject({ code: 'storage_conflict' })
  })
  it('条件事务、上传不可见、回执核实及缓存源失效', async () => {
    const client = await host()
    const revision = (await client.scope()).revision
    const upload = await client.createUpload('page-upload-create-key', { target: { type: 'create', parent_id: '2', name: 'created.bin' }, size: '2', scope_revision: revision })
    expect((await client.uploadBody(upload.id, Uint8Array.of(7, 8))).state).toBe('ready')
    await expect(client.stat({ by: 'path', path: '/授权/created.bin' })).rejects.toMatchObject({ code: 'not_found' })
    const request = { scope_revision: revision, assertions: [], operations: [{ type: 'commit_upload' as const, operation_id: 'commit', upload_id: upload.id }] }
    const receipt = await client.mutate('page-upload-commit-key', request)
    expect(await client.mutate('page-upload-commit-key', request)).toEqual(receipt)
    const file = await client.stat({ by: 'id', id: receipt.results[0].node_id })
    await client.cachePut('object', Uint8Array.of(1), 'application/octet-stream', { metadata: null, sources: [{ id: file.id, content_version: file.content_version! }] })
    expect((await client.cacheLookup({ keys: ['object'] })).hits).toHaveLength(1)
    await client.changeNode({ id: file.id, bytes: [9] })
    expect((await client.cacheLookup({ keys: ['object'] })).hits).toHaveLength(0)
    await client.setScope({ mode: 'none' })
    expect(await client.mutationReceipt('page-upload-commit-key')).toEqual(receipt)
  })
  it('媒体与缓存签发同源相对票据路径，直接读取这些路径且不保留绝对地址兼容层', async () => {
    const client = await host(), node = await client.stat({ by: 'id', id: '3' })
    const file = { id: node.id, content_version: node.content_version! }
    const media = await client.mediaUrl({ file, representation: 'original', disposition: 'inline' })
    expect(media.url.startsWith(MEDIA_TICKET_BASE + '/')).toBe(true)
    const bytes = await client.readTicket(media.url, { range: 'bytes=1-2' })
    expect([...new Uint8Array(await new Response(bytes.body).arrayBuffer())]).toEqual([1, 2])
    await expect(client.readTicket('https://test.invalid' + media.url)).rejects.toMatchObject({ code: 'not_found' })
    await client.cachePut('object', Uint8Array.of(7, 8), 'application/octet-stream', { metadata: null, sources: [file] })
    const hit = (await client.cacheLookup({ keys: ['object'] })).hits[0]!
    expect(hit.url.startsWith(CACHE_TICKET_BASE + '/')).toBe(true)
    const cached = await client.readTicket(hit.url)
    expect([...new Uint8Array(await new Response(cached.body).arrayBuffer())]).toEqual([7, 8])
  })
  it('初始事件和重启缺口都要求同步，后端替身只接收 owner 上下文且没有页面令牌', async () => {
    const client = await MemoryHost.create(config, { backend: request => {
      expect(request.context.caller).toBe('owner'); expect(request.context.entry).toBe('page')
      expect(new Headers(request.options.headers).get('Authorization')).toBeNull()
      return new Response('应用业务')
    } }); clients.push(client)
    const events = client.events()[Symbol.asyncIterator]()
    expect((await events.next()).value?.event).toBe('sync.required')
    await client.restart()
    expect((await events.next()).value?.event).toBe('sync.required')
    await events.return(undefined)
    expect(await (await client.backend('/owner', { headers: { Authorization: 'must-not-forward' } })).text()).toBe('应用业务')
  })
})
