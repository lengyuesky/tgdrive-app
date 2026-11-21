import { afterEach } from 'vitest'
import { MemoryHost } from '@tgdrive/test-host'
import type { FakeBackend, SeedNode } from '@tgdrive/test-host'
import type { FileNode } from '@tgdrive/page-sdk/contract'
import { parseJson } from '@tgdrive/page-sdk'
import { CinemaClient, type CinemaLibrary, type Configuration, type ServiceStatus } from './client'

const hosts: MemoryHost[] = []
afterEach(async () => { await Promise.all(hosts.splice(0).map(host => host.dispose())) })
export const movie: CinemaLibrary = { id: '1'.repeat(32), name: '电影', kind: 'movie', root_id: '2', path: '/影视', authorized: true }
export const series: CinemaLibrary = { id: '2'.repeat(32), name: '电视剧', kind: 'tv', root_id: '10', path: '/电视剧', authorized: true }
export const configuration = (libraries = [movie, series], revision = 'r1'): Configuration => ({ revision, username: '', account_configured: false, running: false, libraries, index: { state: 'ready', error: '', entries: 2 } })
export const serviceStatus = (running = false): ServiceStatus => ({ running, index: { state: 'ready', error: '', entries: 2 }, covers: { ready: 2, pending: 0, failed: 0, retrying: 0, errors: [] }, limits: {} })
export function node(id: string, path: string, kind: 'file' | 'directory' = 'file', size = '100'): FileNode {
  return { id, parent_id: '2', path, name: path.split('/').pop()!, kind, size: kind === 'directory' ? '0' : size, content_version: kind === 'file' ? 'v1' : null, revision: 'r1', children_revision: kind === 'directory' ? 'children-1' : null, has_thumbnail: false, created_at: 1, modified_at: 1 }
}
export function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }) }
export function failure(code = 'storage_conflict', message = '其他客户端更改了记录', status = 409) { return json({ error: { code, message, request_id: 'test' } }, status) }
export function body(request: Parameters<FakeBackend>[0]): Record<string, unknown> { return request.options.body ? parseJson(String(request.options.body)) as Record<string, unknown> : {} }
export async function fixture(backend: FakeBackend = () => json(null), nodes: SeedNode[] = []) {
  const host = await MemoryHost.create({ app: { id: 'cinema', name: '影视', version: '1.0.0', generation: 'g1' }, files: { read: true, write: false }, scope: { mode: 'all', access: 'read_only' }, nodes: [
    { id: '2', parent_id: '1', name: '影视', kind: 'directory' },
    { id: '3', parent_id: '2', name: '电影.mp4', kind: 'file', bytes: [1, 2, 3, 4] },
    { id: '10', parent_id: '1', name: '电视剧', kind: 'directory' },
    { id: '11', parent_id: '10', name: '剧.S01E01.mkv', kind: 'file', bytes: [5, 6, 7, 8] }, ...nodes,
  ] }, { backend })
  hosts.push(host)
  return { host, cinema: new CinemaClient(host), signal: new AbortController().signal }
}
