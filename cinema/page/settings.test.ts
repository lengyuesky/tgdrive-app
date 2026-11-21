import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExternalServiceInfo } from '@tgdrive/page-sdk/contract'
import { SERVICE_BASE } from '@tgdrive/page-sdk/contract'
import html from './index.html?raw'
import { ServiceManager, connectionAddress } from './settings'
import { body, configuration, failure, fixture, json, movie, serviceStatus } from './test-fixture'

const entrance = (changes: Partial<ExternalServiceInfo> = {}): ExternalServiceInfo => ({ declared: true, available: true, root_assigned: true, prefix_path: `${SERVICE_BASE}/cinema`, root_url: 'https://test.invalid', prefix_url: `https://test.invalid${SERVICE_BASE}/cinema`, ...changes })
const managers: ServiceManager[] = []
afterEach(() => { managers.splice(0).forEach(manager => manager.stop()); document.body.replaceChildren() })

describe('如实显示本应用对外入口', () => {
  it('未分配根地址时不把固定前缀推荐给飞牛客户端', () => {
    const value = connectionAddress(entrance({ root_assigned: false, root_url: null }))
    expect(value.address).toBeNull(); expect(value.root).toContain('未分配'); expect(value.note).toContain('不保留路径前缀')
    expect(value.prefix).toBe(`https://test.invalid${SERVICE_BASE}/cinema`)
  })
  it('平台不可转发和业务开关分别判断，根地址属于本应用也不能假称可用', () => {
    const value = connectionAddress(entrance({ available: false }))
    expect(value.address).toBe('https://test.invalid'); expect(value.available).toBe(false); expect(value.note).toContain('不能转发')
  })
  it('缺失入口或缺失公开源时显示尚未确认，不猜主机名', () => {
    expect(connectionAddress(null)).toMatchObject({ address: null, available: false })
    const value = connectionAddress(entrance({ root_url: null, prefix_url: null }))
    expect(value.address).toBeNull(); expect(value.note).toContain('尚未确认'); expect(value.prefix).toBe(`${SERVICE_BASE}/cinema`)
  })
  it('未声明对外服务时不显示可连接根地址', () => {
    expect(connectionAddress(entrance({ declared: false, root_assigned: false, root_url: null, prefix_url: null })).address).toBeNull()
  })
})
async function setup() {
  document.body.innerHTML = html
  const dialog = document.getElementById('settings-dialog') as HTMLDialogElement
  dialog.showModal = () => { dialog.open = true }; dialog.close = () => { dialog.open = false }
  const state = { config: configuration([movie]), entrance: entrance(), accountWrites: [] as Record<string, unknown>[], serviceWrites: [] as Record<string, unknown>[] }
  const result = await fixture(request => {
    const value = body(request)
    if (request.path === '/owner/config') return json(state.config)
    if (request.path === '/owner/status') return json(serviceStatus(state.config.running))
    if (request.path === '/owner/account') {
      state.accountWrites.push(value)
      if (value.revision !== state.config.revision) return failure()
      state.config = { ...state.config, revision: 'account-saved', username: String(value.username), account_configured: true }; return json(state.config)
    }
    if (request.path.startsWith('/owner/service/')) {
      state.serviceWrites.push(value)
      if (value.revision !== state.config.revision) return failure()
      state.config = { ...state.config, revision: `service-${state.serviceWrites.length}`, running: request.path.endsWith('/start') }; return json(state.config)
    }
    return json(null)
  })
  const original = result.host.runtimeInfo.bind(result.host)
  vi.spyOn(result.host, 'runtimeInfo').mockImplementation(async options => ({ ...await original(options), external_service: state.entrance }))
  const authorize = vi.fn(async () => null), changed = vi.fn(async () => {}), notify = vi.fn()
  const manager = new ServiceManager(result.cinema, { requestScope: authorize }, changed, notify); managers.push(manager)
  const username = document.getElementById('service-username') as HTMLInputElement, password = document.getElementById('service-password') as HTMLInputElement
  const save = document.getElementById('service-account-save') as HTMLButtonElement, start = document.getElementById('service-start') as HTMLButtonElement, stop = document.getElementById('service-stop') as HTMLButtonElement
  return { ...result, state, manager, username, password, save, start, stop, authorize, dialog }
}

describe('影视服务的设置交互', () => {
  it('安装与后端就绪都不自动启动，未配置账号时启动按钮禁用', async () => {
    const test = await setup(); await test.manager.open()
    expect(test.start.disabled).toBe(true); expect(test.stop.disabled).toBe(true); expect(test.state.serviceWrites).toHaveLength(0)
    expect(document.getElementById('service-state')!.textContent).toContain('未接收')
  })
  it('保存账号清空密码，回车不会原生提交；只有主动点击才启动和停止', async () => {
    const test = await setup(); await test.manager.open(); test.username.value = 'synthetic'; test.password.value = 'Synthetic-Only-Password'
    const event = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true, bubbles: true }); test.password.dispatchEvent(event); await test.manager.flush()
    expect(event.defaultPrevented).toBe(true); expect(test.password.value).toBe(''); expect(test.state.accountWrites).toHaveLength(1)
    expect(test.state.serviceWrites).toHaveLength(0); expect(test.start.disabled).toBe(false)
    test.start.click(); await test.manager.flush(); expect(test.state.config.running).toBe(true); expect(test.stop.disabled).toBe(false)
    test.stop.click(); await test.manager.flush(); expect(test.state.config.running).toBe(false); expect(test.state.serviceWrites).toHaveLength(2)
  })
  it('轮询保留账号草稿和旧编辑基线，远端修改后第一次保存不会静默覆盖', async () => {
    const test = await setup(); await test.manager.open(); test.username.value = 'draft'; test.password.value = 'Synthetic-Draft-Password'
    test.state.config = { ...test.state.config, revision: 'remote', username: 'remote', account_configured: true }
    await test.manager.refreshIfOpen()
    expect(test.username.value).toBe('draft'); expect(test.password.value).toBe('Synthetic-Draft-Password')
    test.save.click(); await test.manager.flush()
    expect(test.state.config.username).toBe('remote'); expect(test.state.accountWrites[0].revision).toBe('r1')
    expect(document.getElementById('settings-status')!.textContent).toContain('草稿已保留')
    test.save.click(); await test.manager.flush(); expect(test.state.config.username).toBe('draft'); expect(test.password.value).toBe('')
  })
  it('根归属变化后重新读取实际 RuntimeInfo，不显示旧根地址', async () => {
    const test = await setup(); await test.manager.open()
    expect((document.getElementById('service-address') as HTMLInputElement).value).toBe('https://test.invalid')
    test.state.entrance = entrance({ root_assigned: false, root_url: null }); await test.manager.refreshIfOpen()
    expect((document.getElementById('service-address') as HTMLInputElement).value).toBe('')
    expect(document.getElementById('service-root-state')!.textContent).toContain('未分配')
  })
  it('请求目录授权仅使用只读 UI 通道，取消不会自动开启服务', async () => {
    const test = await setup(); await test.manager.open(); document.getElementById('service-authorize')!.click()
    await vi.waitFor(() => expect(test.authorize).toHaveBeenCalledOnce())
    expect(test.authorize).toHaveBeenCalledWith({ reason: expect.any(String), preferred_access: 'read_only' }, { signal: expect.any(AbortSignal) })
    expect(test.state.serviceWrites).toHaveLength(0)
  })
  it('关闭设置清掉密码，不会停止已主动启用的服务；非法输入和重复保存不重放写请求', async () => {
    const test = await setup(); test.state.config.running = true; await test.manager.open()
    test.username.value = 'synthetic'; test.password.value = 'short'; test.save.click(); await test.manager.flush(); expect(test.state.accountWrites).toHaveLength(0)
    test.password.value = 'Synthetic-Only-Password'; test.save.click(); test.save.click(); await test.manager.flush(); expect(test.state.accountWrites).toHaveLength(1)
    test.password.value = 'private-draft'; test.manager.dismiss(); expect(test.password.value).toBe(''); expect(test.state.config.running).toBe(true); expect(test.state.serviceWrites).toHaveLength(0)
  })
})
