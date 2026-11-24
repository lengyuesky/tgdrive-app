import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer, request } from 'node:http'
import { chown, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BACKEND_READY_PATH, CONTEXT_ARGUMENT, CONTRACT_VERSION, FORWARD_CONTEXT_HEADER, LIMITS, SELF_API_BASE } from '../../contract/types/contract.ts'

export { BACKEND_READY_PATH, CONTRACT_VERSION, SELF_API_BASE }
export async function until(check, message, seconds = LIMITS.BACKEND_READY_SECONDS) {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(message)
}

/** 仅用于隔离 Linux 容器：root 测试驱动、独立 UID 的真实应用进程及本地 Unix 假宿主。 */
export async function backendProbe(executable, manifestFile, appId, handler) {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0)
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
  assert.equal(manifest.id, appId)
  const directory = await mkdtemp('/tmp/backend-probe-'), uid = 65534, gid = 65534
  for (const path of ['state', 'cache', 'tmp', 'run/backend']) {
    const absolute = join(directory, path)
    await mkdir(absolute, { recursive: true }); await chown(absolute, uid, gid); await chmod(absolute, 0o750)
  }
  await chown(directory, 0, gid); await chmod(directory, 0o750)
  await chown(join(directory, 'run'), 0, gid); await chmod(join(directory, 'run'), 0o750)
  const context = { contract: CONTRACT_VERSION, app: { id: manifest.id, name: manifest.name, version: manifest.version, generation: 'probe-generation' }, run_id: 'probe-round-1', host_socket: join(directory, 'run/host.sock'), listen_socket: join(directory, 'run/backend/backend.sock'), data_dir: directory, database_path: join(directory, 'state/app.sqlite3'), cache_dir: join(directory, 'cache'), temp_dir: join(directory, 'tmp'), ffmpeg_path: '/usr/bin/ffmpeg', ffprobe_path: '/usr/bin/ffprobe', limits: { memory_bytes: String(LIMITS.DEFAULT_SHARED_BACKEND_MEMORY_BYTES), cpu_millis: LIMITS.DEFAULT_SHARED_BACKEND_CPU_MILLIS, enforced: { memory: false, cpu: false } } }
  const host = createServer((request, response) => {
    assert.equal(request.headers.host, 'tgdrive'); assert.equal(request.headers.authorization, undefined); assert.equal(request.headers.cookie, undefined)
    response.setHeader('Content-Type', 'application/json')
    void Promise.resolve(handler(request, response, context)).catch(error => { process.stderr.write(`隔离假宿主异常：${error.message}\n`); response.destroy(error) })
  })
  host.listen(context.host_socket); await once(host, 'listening')
  await chown(context.host_socket, 0, gid); await chmod(context.host_socket, 0o660)
  const file = join(directory, 'run/context.json')
  const children = new Set()
  const running = candidate => candidate?.pid !== undefined && candidate.exitCode === null && candidate.signalCode === null
  let child, spawnError, stderr = ''
  function http(path, caller, entry = 'page', method = 'GET', value) {
    let headers = {}
    if (caller) {
      const origin = 'https://test.invalid', base = entry === 'page' ? `${SELF_API_BASE}/backend` : entry === 'prefix' ? `/admin/api/apps/v1/services/${appId}` : ''
      headers = { [FORWARD_CONTEXT_HEADER]: Buffer.from(JSON.stringify({ contract: CONTRACT_VERSION, app_id: appId, caller, entry, request_id: 'probe-request', original_uri: base + path, public_origin: origin, public_base_url: origin + base, client_ip: null })).toString('base64url') }
    }
    return new Promise((resolve, reject) => {
      const req = request({ socketPath: context.listen_socket, path, method, headers: { ...headers, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) }, agent: false }, response => {
        let bytes = 0, body = ''; response.setEncoding('utf8')
        response.on('data', chunk => { bytes += Buffer.byteLength(chunk); body += chunk; if (bytes > LIMITS.MAX_JSON_RESPONSE_BYTES) req.destroy(new Error('探测响应超过读取预算')) })
        response.on('end', () => { try { resolve({ status: response.statusCode, body: body ? JSON.parse(body) : null }) } catch (error) { reject(error) } })
        response.on('error', reject)
      })
      req.setTimeout(5000, () => req.destroy(new Error('后端探测请求超时'))); req.on('error', reject)
      req.end(value === undefined ? undefined : JSON.stringify(value))
    })
  }
  async function launch(round = 'probe-round-1') {
    if (running(child)) throw new Error('旧探测进程尚未退出')
    try { const socket = await stat(context.listen_socket); assert.equal(socket.isSocket(), true); assert.equal(socket.uid, uid); await rm(context.listen_socket) } catch (error) { if (error.code !== 'ENOENT') throw error }
    context.run_id = round; stderr = ''; spawnError = undefined
    await writeFile(file, JSON.stringify(context), { mode: 0o440 }); await chown(file, 0, gid)
    child = spawn(executable, [CONTEXT_ARGUMENT, file], { uid, gid, cwd: '/', env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', HOME: join(directory, 'state'), TMPDIR: join(directory, 'tmp') }, stdio: ['ignore', 'pipe', 'pipe'] })
    child.on('error', error => { spawnError = error })
    children.add(child); child.stdout.resume(); child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-LIMITS.MAX_HEADER_BYTES) })
    await once(child, 'spawn')
    let ready
    await until(async () => {
      if (spawnError) throw spawnError
      if (!running(child)) throw new Error(`应用后端提前退出：${child.exitCode ?? child.signalCode}；${stderr}`)
      try { ready = await http(BACKEND_READY_PATH); return ready.status === 200 } catch { return false }
    }, '应用后端未能在就绪预算内启动')
    for (const [key, value] of Object.entries({ contract: CONTRACT_VERSION, app_id: appId, version: manifest.version, generation: context.app.generation, run_id: round })) assert.deepEqual(ready.body[key], value)
    assert.equal((await stat(context.listen_socket)).uid, uid)
    return ready.body
  }
  async function terminate() {
    const pid = child.pid
    const descendants = (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')).trim()
    const exited = once(child, 'exit'); child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), LIMITS.BACKEND_STOP_SECONDS * 1000)
    const [code, signal] = await exited; clearTimeout(timer)
    assert.equal(code, 0); assert.equal(signal, null); assert.ok((await stat(context.database_path)).size > 0)
    let closed = false; try { await http(BACKEND_READY_PATH) } catch { closed = true }
    assert.equal(closed, true)
    for (const descendant of descendants.split(/\s+/).filter(Boolean)) await assert.rejects(stat(`/proc/${descendant}`), error => error.code === 'ENOENT')
    await assert.rejects(stat(`/proc/${pid}`), error => error.code === 'ENOENT')
    return { graceful_stop: true, listener_closed: true, descendants_reclaimed: true, os_child_processes: descendants ? descendants.split(/\s+/).length : 0 }
  }
  async function dispose() {
    for (const process of children) if (running(process)) { const exited = once(process, 'exit'); process.kill('SIGKILL'); await exited }
    host.closeAllConnections(); await new Promise(resolve => host.close(resolve)); await rm(directory, { recursive: true, force: true })
  }
  return { uid, context, http, launch, terminate, dispose }
}
