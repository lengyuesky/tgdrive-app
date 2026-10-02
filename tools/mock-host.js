// 模拟公开 SDK 契约；不提供生产接口或真实凭据。
const frame = document.getElementById('app'), status = document.getElementById('status')
const records = new Map(), files = new Map(), pending = new Map()
let settings = {}
let port, manifest, dark = false, nextFile = 2, schema = 0, lastTask
const root = { id: 1, content_version: 'root', path: '/', name: '测试文件', is_dir: true, size: 0, created_at: 0, modified_at: 0, favorite: false }
function entry(id) { if (id === 1) return root; const item = files.get(id); if (!item) throw new Error('文件不存在'); return item.entry }
function resolveFile(ref) { const file = ref.id != null ? entry(ref.id) : ref.path === '/' ? root : [...files.values()].find(item => item.entry.path === ref.path)?.entry; if (!file || ref.content_version && ref.content_version !== file.content_version) throw new Error('文件身份已改变'); return file }
function send(name, value) { port?.postMessage({ type: 'event', name, value }) }
async function invoke(method, p) {
  switch (method) {
    case 'app.ping': return { ok: true }
    case 'app.lifecycle': { const needed = schema !== p.version; if (p.action === 'complete') schema = p.version; return { needed, version: schema } }
    case 'settings.get': return { ...settings }
    case 'settings.patch': { for (const key of Object.keys(p)) if (!manifest.settings.some(item => item.key === key)) throw new Error('未声明的设置'); settings = { ...settings, ...p }; send('settings.changed', settings); return { ...settings } }
    case 'files.stat': return resolveFile(p)
    case 'files.list': case 'files.searchPage': {
      const offset = Number(p.cursor || 0), limit = p.limit || 200
      const entries = [...files.values()].map(item => item.entry).filter(file => !p.q || file.name.includes(p.q)).filter(file => !p.extensions?.length || p.extensions.includes(file.name.split('.').pop().toLowerCase()))
      return { entries: entries.slice(offset, offset + limit), results: entries.slice(offset, offset + limit), path: '/', total: entries.length, has_more: offset + limit < entries.length, next_cursor: offset + limit < entries.length ? String(offset + limit) : null }
    }
    case 'files.readRange': { const file = resolveFile(p.ref); return new Uint8Array(await files.get(file.id).file.slice(p.offset, p.offset + p.length).arrayBuffer()) }
    case 'files.readRanges': return Promise.all(p.ranges.map(range => invoke('files.readRange', { ref: p.ref, ...range })))
    case 'media.url': { const file = resolveFile(p); return { url: files.get(file.id).url } }
    case 'storage.get': return records.get(p.key) ?? null
    case 'storage.set': case 'storage.delete': {
      const old = records.get(p.key)
      if ((old?.revision ?? null) !== p.expected_revision) throw Object.assign(new Error('数据已被修改'), { status: 409, code: 'storage_conflict' })
      const record = { key: p.key, value: p.value, revision: crypto.randomUUID(), updated_at: Math.floor(Date.now() / 1000) }
      if (method === 'storage.delete') records.delete(p.key); else records.set(p.key, record)
      send('storage.changed', { key: p.key }); return method === 'storage.delete' ? { ok: true } : record
    }
    case 'storage.list': { const all = [...records.values()].filter(r => r.key.startsWith(p.prefix || '')); const offset = Number(p.cursor || 0), limit = p.limit || 200; return { records: all.slice(offset, offset + limit), has_more: offset + limit < all.length, next_cursor: offset + limit < all.length ? String(offset + limit) : null } }
    case 'rpc.batch': return { results: await Promise.all(p.calls.map(async call => { try { return { result: await invoke(call.method, call.params || {}) } } catch (e) { return { error: e.message, status: e.status } } })) }
    case 'ui.pickDirectory': case 'ui.authorizeDirectory': return confirm('允许测试应用读取当前选择的测试文件？') ? '/' : null
    case 'ui.showFile': case 'ui.fileDetails': status.textContent = JSON.stringify(resolveFile(p)); return null
    case 'ui.setTitle': document.title = p.title; return null
    case 'ui.task': lastTask = p.id; status.textContent = `${p.title}：${p.completed}（${p.state}）`; return null
    case 'ui.report': status.textContent = p.phase === 'ready' ? '应用已就绪' : p.message; return null
    case 'ui.setImmersive': case 'ui.setExitMessage': case 'ui.openSettings': return null
    case 'ui.close': status.textContent = '应用请求关闭'; return null
    case 'covers.get': return { covers: [] }
    case 'covers.put': case 'covers.delete': return { ok: true }
    case 'covers.stats': return { entries: 0, bytes: 0, limit_bytes: 0, limit_entries: 0 }
    default: throw new Error(`模拟宿主尚未实现 ${method}`)
  }
}
window.addEventListener('message', event => {
  if (event.source !== frame.contentWindow || event.origin !== 'null' || event.data?.type !== 'ready' || event.data.channel !== 'tgdrive-app-v1' || port) return
  const channel = new MessageChannel(); port = channel.port1
  port.onmessage = async ({ data }) => {
    if (data.type === 'cancel') { pending.delete(data.id); return }
    if (data.type !== 'request') return
    pending.set(data.id, true)
    try { const result = await invoke(data.method, data.params); if (pending.has(data.id)) port.postMessage({ type: 'response', id: data.id, result }) }
    catch (error) { if (pending.has(data.id)) port.postMessage({ type: 'response', id: data.id, error: error.message, code: error.code, status: error.status }) }
    finally { pending.delete(data.id) }
  }
  frame.contentWindow.postMessage({ channel: 'tgdrive-app-v1', type: 'connect', context: { id: manifest.id, name: manifest.name, version: manifest.version, api_version: 2, dark, data_schema: manifest.integration?.data_schema, scope: { mode: 'selected', paths: ['/'] }, capabilities: ['rpc.batch', 'covers', 'app.lifecycle', 'ui.authorizeDirectory', 'ui.showFile', 'ui.fileDetails', 'ui.task', 'ui.setTitle', 'ui.setImmersive'] } }, '*', [channel.port2])
  status.textContent = '应用已连接'
})
document.getElementById('files').onchange = event => {
  for (const file of event.target.files) { const id = nextFile++; files.set(id, { file, url: URL.createObjectURL(file), entry: { ...root, id, content_version: `sample-${id}`, path: '/' + file.name, name: file.name, size: file.size, is_dir: false } }) }
  send('files.changed', { paths: ['/'] })
}
document.getElementById('theme').onclick = () => { dark = !dark; send('theme.changed', { dark }) }
document.getElementById('cancel').onclick = () => { if (lastTask) send('task.cancel', { id: lastTask }) }
document.getElementById('reload').onclick = () => { port?.close(); port = undefined; pending.clear(); frame.src = '/app/' + manifest.entry }
fetch('/manifest').then(r => r.json()).then(value => { manifest = value; settings = Object.fromEntries(manifest.settings.map(item => [item.key, item.default])); frame.src = '/app/' + manifest.entry }).catch(error => { status.textContent = error.message })
