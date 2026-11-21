import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { request } from 'node:http'
import { mkdtemp, mkdir, chown, chmod, writeFile, stat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { CONTRACT_VERSION, CONTEXT_ARGUMENT, BACKEND_READY_PATH, FORWARD_CONTEXT_HEADER, LIMITS, SELF_API_BASE } from './contract.js'

const directory = await mkdtemp('/tmp/app-backend-check-')
const uid = 65534, gid = 65534
for (const path of ['state', 'cache', 'tmp', 'run/backend']) { const absolute = join(directory, path); await mkdir(absolute, { recursive: true }); await chown(absolute, uid, gid); await chmod(absolute, 0o750) }
await chown(directory, 0, gid); await chmod(directory, 0o750); await chown(join(directory, 'run'), 0, gid); await chmod(join(directory, 'run'), 0o750)
const context = { contract: CONTRACT_VERSION, app: { id: 'example-backend', name: '示例', version: '1.0.0', generation: 'generation-1' }, run_id: 'run-1', host_socket: join(directory, 'run/host.sock'), listen_socket: join(directory, 'run/backend/backend.sock'), data_dir: directory, database_path: join(directory, 'state/app.sqlite3'), cache_dir: join(directory, 'cache'), temp_dir: join(directory, 'tmp'), ffmpeg_path: '/usr/bin/ffmpeg', ffprobe_path: '/usr/bin/ffprobe', limits: { memory_bytes: String(LIMITS.DEFAULT_BACKEND_MEMORY_BYTES), cpu_millis: LIMITS.DEFAULT_BACKEND_CPU_MILLIS, pids: LIMITS.DEFAULT_BACKEND_PIDS, open_files: LIMITS.DEFAULT_BACKEND_OPEN_FILES, cache_bytes: String(LIMITS.DEFAULT_BACKEND_CACHE_BYTES), database_bytes: String(LIMITS.DEFAULT_BACKEND_DATABASE_BYTES), enforced: { memory: false, cpu: false, pids: false, open_files: false } } }
const file = join(directory, 'run/context.json'); await writeFile(file, JSON.stringify(context), { mode: 0o440 }); await chown(file, 0, gid)
const child = spawn(process.argv[2], [CONTEXT_ARGUMENT, file], { uid, gid, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', HOME: join(directory, 'state'), TMPDIR: join(directory, 'tmp') }, stdio: ['ignore', 'pipe', 'pipe'] })
let stderr = ''; child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-LIMITS.MAX_HEADER_BYTES) }); child.stdout.resume()
function http(path, headers = {}) { return new Promise((resolve, reject) => { const req = request({ socketPath: context.listen_socket, path, method: 'GET', headers, agent: false }, response => { let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk }); response.on('end', () => resolve({ status: response.statusCode, body })) }); req.on('error', reject); req.end() }) }
function forward(caller, entry, original) { return { [FORWARD_CONTEXT_HEADER]: Buffer.from(JSON.stringify({ contract: CONTRACT_VERSION, app_id: context.app.id, caller, entry, request_id: 'request-1', original_uri: original, public_base_url: entry === 'page' ? `https://test.invalid${SELF_API_BASE}/backend` : 'https://test.invalid', client_ip: null })).toString('base64url') } }
try {
  const deadline = Date.now() + LIMITS.BACKEND_READY_SECONDS * 1000
  let ready
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`应用后端提前退出：${child.exitCode}；${stderr}`)
    try { ready = await http(BACKEND_READY_PATH); if (ready.status === 200) break } catch {}
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.equal(ready?.status, 200)
  const value = JSON.parse(ready.body)
  for (const [key, expected] of Object.entries({ app_id: context.app.id, version: context.app.version, generation: context.app.generation, run_id: context.run_id, contract: CONTRACT_VERSION })) assert.deepEqual(value[key], expected)
  assert.equal((await stat(context.listen_socket)).uid, uid)
  assert.equal((await http('/owner/config')).status, 401)
  assert.equal((await http('/owner/config', forward('owner', 'page', `${SELF_API_BASE}/backend/owner/config`))).status, 200)
  assert.equal((await http('/file', { ...forward('external', 'root', '/file'), Authorization: 'Bearer fake-host-token', Cookie: 'tgdrive_session=fake' })).status, 401)
  assert.equal((await http(BACKEND_READY_PATH, forward('external', 'root', BACKEND_READY_PATH))).status, 403)
  const stopped = once(child, 'exit'); child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), LIMITS.BACKEND_STOP_SECONDS * 1000)
  const [code, signal] = await stopped; clearTimeout(timer)
  assert.equal(code, 0); assert.equal(signal, null); assert.ok((await stat(context.database_path)).size > 0)
  process.stdout.write(JSON.stringify({ ready: value, uid, owner_status: 200, external_status: 401, forwarded_internal_status: 403, graceful_stop: true }) + '\n')
} finally { if (child.exitCode === null) child.kill('SIGKILL'); await rm(directory, { recursive: true, force: true }) }
