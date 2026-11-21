import type { PageUi } from '@tgdrive/page-sdk'
import type { ExternalServiceInfo } from '@tgdrive/page-sdk/contract'
import { CinemaClient, type Configuration, type ServiceStatus } from './client'
import { isAbort } from './io'

/** 平台入口、根地址归属与影视自己的开关分开显示，不从曾收到的请求推断当前归属。 */
export function connectionAddress(info: ExternalServiceInfo | null | undefined) {
  if (!info) return { root: '根地址归属尚未确认', address: null, prefix: null, available: false, note: '无法取得宿主入口状态，请重新读取。' }
  if (!info.declared) return { root: '应用未声明对外服务', address: null, prefix: info.prefix_path, available: false, note: '请在应用中心检查当前安装包。' }
  return {
    root: info.root_assigned ? '根地址当前归影视应用' : '根地址未分配给影视应用',
    address: info.root_assigned ? info.root_url : null,
    prefix: info.prefix_url ?? info.prefix_path,
    available: info.available,
    note: !info.root_assigned ? '飞牛官方客户端不保留路径前缀，请在应用中心把根地址分配给影视。' : !info.root_url ? '根地址已分配，但公开连接地址尚未确认；不会猜测地址。' : !info.available ? '平台当前不能转发对外请求；此地址不代表服务可用。' : '客户端使用此根地址和影视连接账号。服务须由你主动启动。',
  }
}

/** 管理账号、服务开关与实际入口；轮询只更新状态，不覆盖正在编辑的账号和密码。 */
export class ServiceManager {
  private dialog = document.getElementById('settings-dialog') as HTMLDialogElement
  private fields = document.getElementById('account-fields') as HTMLFieldSetElement
  private username = document.getElementById('service-username') as HTMLInputElement
  private password = document.getElementById('service-password') as HTMLInputElement
  private message = document.getElementById('settings-status')!
  private saveButton = document.getElementById('service-account-save') as HTMLButtonElement
  private startButton = document.getElementById('service-start') as HTMLButtonElement
  private stopButton = document.getElementById('service-stop') as HTMLButtonElement
  private closeButton = document.getElementById('settings-close') as HTMLButtonElement
  private controller = new AbortController()
  private configuration?: Configuration
  private accountRevision?: string
  private pending?: Promise<void>
  private reading?: Promise<void>
  private timer?: ReturnType<typeof setTimeout>
  private available = false
  constructor(private cinema: CinemaClient, private ui: Pick<PageUi, 'requestScope'>, private changed: () => Promise<void>, private notify: (text: string) => void) {
    const save = () => {
      if (this.pending || this.saveButton.disabled) return
      this.pending = this.saveAccount().finally(() => { this.pending = undefined; this.buttons() })
    }
    this.saveButton.addEventListener('click', save)
    for (const field of [this.username, this.password]) field.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); save() } })
    this.startButton.addEventListener('click', () => this.changeService(true))
    this.stopButton.addEventListener('click', () => this.changeService(false))
    this.closeButton.addEventListener('click', () => this.close())
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.close() })
    document.getElementById('service-refresh')!.addEventListener('click', () => { void this.read(false) })
    document.getElementById('service-authorize')!.addEventListener('click', () => {
      void this.ui.requestScope({ reason: '影视只读取你选定的媒体库目录和其中的视频、字幕、描述及图片。选择文件夹不等于授权。', preferred_access: 'read_only' }, { signal: this.controller.signal }).then(async () => { await this.read(false); await this.changed() }).catch(error => this.error(error))
    })
    document.getElementById('service-copy')!.addEventListener('click', () => {
      const input = document.getElementById('service-address') as HTMLInputElement
      if (!input.value) return
      input.focus(); input.select(); this.notify('已选中连接地址，可复制到飞牛客户端')
    })
  }
  private text(id: string, value: string) { document.getElementById(id)!.textContent = value }
  private buttons() {
    const writing = !!this.pending
    this.fields.disabled = writing; this.closeButton.disabled = writing
    this.saveButton.disabled = writing || !this.configuration
    this.startButton.disabled = writing || !this.available || !this.configuration?.account_configured || !this.configuration.libraries.some(library => library.authorized) || this.configuration.running
    this.stopButton.disabled = writing || !this.configuration?.running
  }
  private error(error: unknown) { if (!isAbort(error) && !this.controller.signal.aborted) this.message.textContent = error instanceof Error ? error.message : '设置请求未完成' }
  async open() {
    if (this.pending) return
    this.controller.abort(); await this.reading; this.controller = new AbortController(); this.configuration = undefined; this.accountRevision = undefined
    this.username.value = ''; this.password.value = ''; this.message.textContent = '正在读取影视服务设置…'
    this.buttons(); if (!this.dialog.open) this.dialog.showModal()
    await this.read(true)
  }
  private close() { if (this.pending) return; this.controller.abort(); clearTimeout(this.timer); this.password.value = ''; this.dialog.close() }
  dismiss() { if (this.pending) return false; this.close(); return true }
  refreshIfOpen() { if (this.dialog.open) return this.read(false); return Promise.resolve() }
  private read(initial: boolean): Promise<void> {
    if (this.reading) return this.reading
    this.reading = this.load(initial).finally(() => { this.reading = undefined })
    return this.reading
  }
  private async load(initial: boolean) {
    clearTimeout(this.timer)
    const signal = this.controller.signal
    try {
      const [config, status, runtime] = await Promise.all([this.cinema.configuration(signal), this.cinema.status(signal), this.cinema.runtime(signal)])
      signal.throwIfAborted(); this.configuration = config
      if (initial) { this.username.value = config.username; this.accountRevision = config.revision }
      const address = connectionAddress(runtime.external_service)
      this.available = address.available
      this.text('service-state', status.running ? '影视服务正在接收客户端连接' : '影视服务未接收新的客户端连接')
      const backendState = { ready: '就绪', starting: '正在启动', stopped: '已停止', failed: '启动失败' }
      this.text('service-backend', `应用后端：${runtime.backend ? backendState[runtime.backend.state] : '尚未确认'}`)
      this.text('service-root-state', address.root)
      this.text('service-address-note', address.note)
      const input = document.getElementById('service-address') as HTMLInputElement
      input.value = address.address ?? ''; input.placeholder = '尚未确认可供飞牛客户端连接的根地址'
      ;(document.getElementById('service-copy') as HTMLButtonElement).disabled = !address.address
      this.text('service-prefix', address.prefix ? `固定前缀：${address.prefix}（仅供支持路径前缀的客户端使用）` : '固定前缀尚未确认')
      this.text('service-account-state', config.account_configured ? `已配置影视连接账号：${config.username}` : '尚未配置影视连接账号；这不是宿主登录账号')
      const indexState: Record<string, string> = { idle: '等待建库', scanning: '正在整理', ready: '就绪', failed: '失败' }
      this.text('service-index', `索引：${indexState[status.index.state] ?? '尚未确认'} · ${status.index.entries} 个视频${status.index.error ? ` · ${status.index.error}` : ''}`)
      this.renderCovers(status)
      if (initial) this.message.textContent = ''
    } catch (error) { this.error(error) }
    finally {
      if (!signal.aborted) { this.buttons(); this.timer = setTimeout(() => { if (this.dialog.open && !this.pending) void this.read(false); else if (this.dialog.open) this.timer = setTimeout(() => { void this.read(false) }, 3000) }, 3000) }
    }
  }
  private renderCovers(status: ServiceStatus) {
    this.text('service-covers', `封面：已就绪 ${status.covers.ready} · 待补 ${status.covers.pending} · 失败 ${status.covers.failed} · 自动重试 ${status.covers.retrying}`)
    const errors = document.getElementById('service-cover-errors')!
    errors.replaceChildren(...status.covers.errors.map(error => { const item = document.createElement('li'); item.textContent = `${error.title}：${error.reason}`; return item }))
  }
  private async saveAccount() {
    const snapshot = this.configuration
    if (!snapshot) return
    const username = this.username.value.trim(), password = this.password.value
    if (!username || new TextEncoder().encode(username).length > 64 || /\p{Cc}/u.test(username) || new TextEncoder().encode(password).length < 8 || new TextEncoder().encode(password).length > 128 || /\p{Cc}/u.test(password)) { this.message.textContent = '账号需为 1–64 字节，密码需为 8–128 字节，不能包含控制字符'; return }
    this.fields.disabled = true; this.closeButton.disabled = true; this.saveButton.disabled = true; this.startButton.disabled = true; this.stopButton.disabled = true
    try {
      this.configuration = await this.cinema.account(this.accountRevision ?? snapshot.revision, username, password, this.controller.signal)
      this.accountRevision = this.configuration.revision
      this.password.value = ''; this.message.textContent = '影视连接账号已保存，旧客户端会话已撤销；客户端需要重新登录'
      await this.read(false)
    } catch (error) {
      this.error(error)
      // 只读核实最新修订，不重放写请求；草稿仍保留，下次保存必须由主人再次点击。
      try { this.configuration = await this.cinema.configuration(this.controller.signal); this.accountRevision = this.configuration.revision } catch { /* 请求结果仍不确定，不写默认配置。 */ }
      if ((error as { code?: string }).code === 'storage_conflict') this.message.textContent = '另一页面更改了设置，已读取最新修订。账号草稿已保留，请确认后再次保存。'
    }
  }
  private changeService(running: boolean) {
    if (this.pending || !this.configuration) return
    const snapshot = this.configuration
    this.pending = (async () => {
      this.buttons()
      try {
        this.configuration = await this.cinema.service(snapshot.revision, running, this.controller.signal)
        this.message.textContent = running ? '影视服务已主动启动' : '影视服务已停止，旧登录会话和读取租约已撤销'
        await this.read(false)
      } catch (error) { this.error(error); await this.read(false) }
    })().finally(() => { this.pending = undefined; this.buttons() })
    this.buttons()
  }
  flush() { return this.pending ?? Promise.resolve() }
  stop() { clearTimeout(this.timer); this.controller.abort(); this.password.value = '' }
}
