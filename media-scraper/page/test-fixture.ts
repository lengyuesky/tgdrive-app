import { afterEach, vi } from 'vitest'
import { MemoryHost } from '@tgdrive/test-host'
import type { SeedNode } from '@tgdrive/test-host'
import type { FileNode, ScopeInfo, UiNotice } from '@tgdrive/page-sdk'
import { ScraperPage } from './controller'
import type { ScraperUi } from './controller'
import { FakeScraper } from './test-backend'
export { FakeScraper, actor, body, deferred, failure, json } from './test-backend'
export type { BackendRequest } from './test-backend'

const cleanups: (() => void)[] = [], hosts: MemoryHost[] = []
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0).reverse()) cleanup(); await Promise.all(hosts.splice(0).map(host => host.dispose())) })
export const cleanup = (callback: () => void) => cleanups.push(callback)
export async function fixture(options: { active?: boolean; scope?: 'all' | 'none' | 'read_only'; nodes?: SeedNode[]; initialDirectory?: boolean } = {}) {
  const fake = new FakeScraper()
  const host = await MemoryHost.create({ app: { id: 'media-scraper', name: '影视刮削', version: '1.0.0', generation: 'g1' }, files: { read: true, write: true }, scope: options.scope === 'none' ? { mode: 'none' } : { mode: 'all', access: options.scope === 'read_only' ? 'read_only' : 'read_write' }, nodes: [
    { id: '2', parent_id: '1', name: '影片', kind: 'directory' }, { id: '3', parent_id: '2', name: 'ABC-123.mp4', kind: 'file', bytes: [1, 2, 3] }, { id: '4', parent_id: '1', name: '其他', kind: 'directory' }, ...(options.nodes ?? []),
  ] }, { backend: fake.handle })
  hosts.push(host)
  if (options.scope === 'none') {
    await host.setScope({ mode: 'all', access: 'read_write' })
    fake.root = await host.stat({ by: 'id', id: '2' }); fake.video = await host.stat({ by: 'id', id: '3' })
    await host.setScope({ mode: 'none' })
  } else { fake.root = await host.stat({ by: 'id', id: '2' }); fake.video = await host.stat({ by: 'id', id: '3' }) }
  fake.settings = { revision: 'settings-1', backend_url: 'https://metatube.invalid/', token_configured: false, overwrite_nfo: false, overwrite_poster: false, directory: options.initialDirectory === false ? null : fake.root }
  if (options.active) fake.add(fake.makeRun())
  const notices = new Set<(notice: UiNotice) => void | Promise<void>>()
  const ui = {
    pickDirectory: vi.fn(async (): Promise<FileNode | null> => fake.root),
    requestScope: vi.fn(async (): Promise<ScopeInfo | null> => null),
    task: vi.fn(async () => {}),
    onNotice: (listener: (notice: UiNotice) => void | Promise<void>) => { notices.add(listener); return () => notices.delete(listener) },
  } satisfies ScraperUi
  const changed = vi.fn()
  const page = new ScraperPage(host, ui, { launch: { action: 'browse' } }, changed)
  cleanup(() => page.dispose())
  const notify = async (notice: UiNotice) => { for (const listener of notices) await listener(notice) }
  return { host, fake, ui, page, changed, notify }
}
