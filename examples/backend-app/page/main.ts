import { createPageApp, parseJson, stringifyJson } from '@tgdrive/page-sdk'
import './style.css'

const app = createPageApp()
const output = document.querySelector<HTMLElement>('#output')!
const token = document.querySelector<HTMLInputElement>('#token')!
function key(): string { return [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join('') }
token.value = key()
function showError(error: unknown) { output.textContent = error instanceof Error ? error.message : '请求未能完成' }
async function call(path: string, method: 'GET' | 'POST' | 'PUT', value?: unknown) {
  const response = await app.host.backend(path, { method, headers: value === undefined ? undefined : { 'Content-Type': 'application/json' }, body: value === undefined ? undefined : stringifyJson(value) })
  if (!response.ok) { await response.body?.cancel(); throw new Error(`应用后端返回 ${response.status}`) }
  return parseJson(await response.text())
}
document.querySelector<HTMLButtonElement>('#configure')!.onclick = () => {
  void (async () => {
    const page = await app.host.query({ roots: [], recursive: true, filter: { kind: 'file', extensions: [], include_hidden: false }, sort: 'id', order: 'asc', limit: 1 })
    const file = page.items[0]
    if (!file?.content_version) throw new Error('请先给示例应用授权一个含文件的目录')
    await call('/owner/config', 'PUT', { file: { id: file.id, content_version: file.content_version }, token: token.value })
    output.textContent = `已配置 ${file.name}。外部客户端使用此应用服务令牌访问本入口的 /file；令牌不属于宿主登录。`
  })().catch(showError)
}
document.querySelector<HTMLButtonElement>('#directory')!.onclick = () => {
  void (async () => {
    const scope = await app.host.scope()
    const root = scope.roots.find(root => root.access === 'read_write' && root.node)
    if (!root) throw new Error('需要读写目录授权')
    const receipt = await call('/owner/directory', 'POST', { parent_id: root.directory_id, name: `示例-${Date.now()}`, idempotency_key: key() })
    output.textContent = stringifyJson(receipt)
  })().catch(showError)
}
void app.ui.setTitle({ title: app.context.app.name }).catch(showError)
