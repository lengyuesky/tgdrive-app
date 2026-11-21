import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer, request } from 'node:http'
import { chown, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { BACKEND_READY_PATH, CONTEXT_ARGUMENT, CONTRACT_VERSION, FORWARD_CONTEXT_HEADER, LIMITS, SELF_API_BASE } from './contract.js'

// 只在隔离 Linux 容器中使用；不是宿主，也不会连接 Telegram 或创建正式账号。
assert.equal(process.platform, 'linux')
const manifest = JSON.parse(await readFile(process.argv[3], 'utf8'))
assert.equal(manifest.id, 'cinema')
const directory = await mkdtemp('/tmp/cinema-backend-check-'), uid = 65534, gid = 65534
for (const path of ['state', 'cache', 'tmp', 'run/backend']) {
  const absolute = join(directory, path)
  await mkdir(absolute, { recursive: true }); await chown(absolute, uid, gid); await chmod(absolute, 0o750)
}
await chown(directory, 0, gid); await chmod(directory, 0o750)
await chown(join(directory, 'run'), 0, gid); await chmod(join(directory, 'run'), 0o750)
const context = { contract: CONTRACT_VERSION, app: { id: manifest.id, name: manifest.name, version: manifest.version, generation: 'generation-1' }, run_id: 'run-1', host_socket: join(directory, 'run/host.sock'), listen_socket: join(directory, 'run/backend/backend.sock'), data_dir: directory, database_path: join(directory, 'state/app.sqlite3'), cache_dir: join(directory, 'cache'), temp_dir: join(directory, 'tmp'), ffmpeg_path: '/usr/bin/ffmpeg', ffprobe_path: '/usr/bin/ffprobe', limits: { memory_bytes: String(LIMITS.DEFAULT_BACKEND_MEMORY_BYTES), cpu_millis: LIMITS.DEFAULT_BACKEND_CPU_MILLIS, pids: LIMITS.DEFAULT_BACKEND_PIDS, open_files: LIMITS.DEFAULT_BACKEND_OPEN_FILES, cache_bytes: String(LIMITS.DEFAULT_BACKEND_CACHE_BYTES), database_bytes: String(LIMITS.DEFAULT_BACKEND_DATABASE_BYTES), enforced: { memory: false, cpu: false, pids: false, open_files: false } } }
const scope = { revision: 'scope-1', scope: { mode: 'none' }, roots: [] }
const host = createServer((request, response) => {
  assert.equal(request.headers.host, 'tgdrive'); assert.equal(request.headers.authorization, undefined); assert.equal(request.headers.cookie, undefined)
  response.setHeader('Content-Type', 'application/json')
  if (request.method === 'GET' && request.url === `${SELF_API_BASE}/scope`) response.end(JSON.stringify(scope))
  else { response.statusCode = 403; response.end(JSON.stringify({ error: { code: 'caller_not_allowed', message: '启动探测只提供空的只读授权', request_id: 'probe' } })) }
})
host.listen(context.host_socket); await once(host, 'listening'); await chown(context.host_socket, 0, gid); await chmod(context.host_socket, 0o660)
const file = join(directory, 'run/context.json')
await writeFile(file, JSON.stringify(context), { mode: 0o440 }); await chown(file, 0, gid)
const child = spawn(process.argv[2], [CONTEXT_ARGUMENT, file], { uid, gid, cwd: '/', env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', HOME: join(directory, 'state'), TMPDIR: join(directory, 'tmp') }, stdio: ['ignore', 'pipe', 'pipe'] })
let stderr = ''; child.stdout.resume(); child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-LIMITS.MAX_HEADER_BYTES) })
function http(path, headers = {}, method = 'GET', value) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: context.listen_socket, path, method, headers: { ...headers, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) }, agent: false }, response => {
      let body = ''; response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk; if (body.length > LIMITS.MAX_JSON_RESPONSE_BYTES) req.destroy(new Error('探测响应超限')) })
      response.on('end', () => resolve({ status: response.statusCode, body: body ? JSON.parse(body) : null }))
    })
    req.setTimeout(5000, () => req.destroy(new Error('启动探测请求超时'))); req.on('error', reject)
    req.end(value === undefined ? undefined : JSON.stringify(value))
  })
}
function forward(caller, entry, path) {
  const origin = 'https://test.invalid'
  return { [FORWARD_CONTEXT_HEADER]: Buffer.from(JSON.stringify({ contract: CONTRACT_VERSION, app_id: context.app.id, caller, entry, request_id: 'request-1', original_uri: entry === 'page' ? `${SELF_API_BASE}/backend${path}` : path, public_origin: origin, public_base_url: entry === 'page' ? `${origin}${SELF_API_BASE}/backend` : origin, client_ip: null })).toString('base64url') }
}
try {
  const deadline = Date.now() + LIMITS.BACKEND_READY_SECONDS * 1000
  let ready
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`影视后端提前退出：${child.exitCode}；${stderr}`)
    try { ready = await http(BACKEND_READY_PATH); if (ready.status === 200) break } catch {}
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.equal(ready?.status, 200)
  for (const [key, value] of Object.entries({ contract: CONTRACT_VERSION, app_id: context.app.id, version: context.app.version, generation: context.app.generation, run_id: context.run_id })) assert.deepEqual(ready.body[key], value)
  assert.equal((await stat(context.listen_socket)).uid, uid)
  assert.equal((await http('/owner/config')).status, 401)
  const config = await http('/owner/config', forward('owner', 'page', '/owner/config'))
  assert.equal(config.status, 200); assert.equal(config.body.running, false); assert.equal(config.body.account_configured, false); assert.deepEqual(config.body.libraries, [])
  const catalog = await http('/owner/catalog', forward('owner', 'page', '/owner/catalog'), 'POST', { raw_files: true, limit: 48 })
  assert.equal(catalog.status, 200); assert.deepEqual(catalog.body.items, [])
  assert.equal((await http('/owner/service/start', forward('owner', 'page', '/owner/service/start'), 'POST', { revision: config.body.revision })).status, 400)
  const external = await http('/v/api/v1/user/info', { ...forward('external', 'root', '/v/api/v1/user/info'), Authorization: 'Bearer synthetic-invalid-token' })
  assert.equal(external.status, 401)
  assert.equal((await http('/trimcon', forward('external', 'root', '/trimcon'))).status, 401)
  assert.equal((await http('/owner/config', forward('external', 'root', '/owner/config'))).status, 401)
  assert.equal((await http(BACKEND_READY_PATH, forward('external', 'root', BACKEND_READY_PATH))).status, 403)
  const stopped = once(child, 'exit'); child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), LIMITS.BACKEND_STOP_SECONDS * 1000)
  const [code, signal] = await stopped; clearTimeout(timer)
  assert.equal(code, 0); assert.equal(signal, null); assert.ok((await stat(context.database_path)).size > 0)
  let listenerClosed = false; try { await http(BACKEND_READY_PATH) } catch { listenerClosed = true }
  assert.equal(listenerClosed, true)
  process.stdout.write(JSON.stringify({ ready: ready.body, uid, owner_status: config.status, owner_catalog_status: catalog.status, initial_service_running: false, unconfigured_start_status: 400, external_unauthenticated_status: external.status, forwarded_internal_status: 403, graceful_stop: true, listener_closed: true, host: 'isolated-read-only-fixture', real_host_tested: false, official_client_tested: false }) + '\n')
} finally {
  if (child.exitCode === null) child.kill('SIGKILL')
  await new Promise(resolve => host.close(resolve)); await rm(directory, { recursive: true, force: true })
}
