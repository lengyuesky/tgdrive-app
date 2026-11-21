import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { ENDPOINTS } from '../../contract/types/contract.ts'
import { BACKEND_READY_PATH, SELF_API_BASE, backendProbe, until } from './backend-probe.mjs'

const root = { id: '2', parent_id: '1', name: '合成影片', path: '/合成影片', kind: 'directory', size: '0', content_version: null, revision: 'node-revision-1', children_revision: 'children-1', created_at: 1, modified_at: 1, has_thumbnail: false }
const scope = { revision: 'scope-1', scope: { mode: 'selected', directories: [{ directory_id: root.id, access: 'read_write' }] }, roots: [{ directory_id: root.id, access: 'read_write', node: root }] }
const keepalivePath = ENDPOINTS.find(endpoint => endpoint.name === 'backend.keepalive').path
const queryPath = ENDPOINTS.find(endpoint => endpoint.name === 'files.query').path
const statPath = ENDPOINTS.find(endpoint => endpoint.name === 'files.stat').path
const scopePath = ENDPOINTS.find(endpoint => endpoint.name === 'scope.read').path
const pendingQueries = new Set(), calls = []
let keepalives = 0, queryCount = 0
const probe = await backendProbe(process.argv[2], process.argv[3], 'media-scraper', async (request, response) => {
  calls.push(request.url)
  if (request.method === 'GET' && request.url === scopePath) response.end(JSON.stringify(scope))
  else if (request.method === 'POST' && request.url === statPath) {
    let text = ''; for await (const chunk of request) text += chunk
    const value = JSON.parse(text); assert.deepEqual(value, { by: 'id', id: root.id })
    response.end(JSON.stringify(root))
  } else if (request.method === 'POST' && request.url === keepalivePath) {
    keepalives++; response.statusCode = 204; response.end()
  } else if (request.method === 'POST' && request.url === queryPath) {
    queryCount++; pendingQueries.add(response)
    // 模拟长扫描，不提供视频，不让后端进入 MetaTube 或任何文件写入。
    request.resume(); response.on('close', () => pendingQueries.delete(response))
  } else {
    response.statusCode = 403; response.end(JSON.stringify({ error: { code: 'caller_not_allowed', message: '隔离启动探测不提供其它宿主能力', request_id: 'probe' } }))
  }
})
try {
  const ready = await probe.launch()
  assert.equal((await probe.http('/owner/status')).status, 401)
  const owner = await probe.http('/owner/status', 'owner')
  assert.equal(owner.status, 200); assert.equal(owner.body.active, null); assert.equal(owner.body.settings.token_configured, false)
  for (const entry of ['root', 'prefix']) assert.equal((await probe.http('/owner/status', 'external', entry)).status, 403)
  assert.equal((await probe.http(BACKEND_READY_PATH, 'owner')).status, 403)
  assert.equal((await probe.http(BACKEND_READY_PATH, 'external', 'root')).status, 403)
  const configured = await probe.http('/owner/settings', 'owner', 'page', 'PUT', { revision: owner.body.settings.revision, backend_url: 'http://127.0.0.1:9/', token: 'synthetic-private-token', overwrite_nfo: false, overwrite_poster: false })
  assert.equal(configured.status, 200); assert.equal(configured.body.token_configured, true); assert.equal(JSON.stringify(configured.body).includes('synthetic-private-token'), false)
  const started = await probe.http('/owner/runs', 'owner', 'page', 'POST', { request_id: randomUUID(), directory_id: root.id, retry_of: null })
  assert.equal(started.status, 202, JSON.stringify(started.body))
  await until(() => pendingQueries.size === 1 && keepalives > 0, '未观察到后台扫描和活动续期')
  assert.equal((await probe.http('/owner/status', 'owner')).body.active.id, started.body.id)
  const termination = await probe.terminate()
  await until(() => pendingQueries.size === 0, 'SIGTERM 后后台扫描连接未回收', 2)
  assert.ok(calls.every(path => [scopePath, statPath, keepalivePath, queryPath].includes(path)))
  const beforeRestart = queryCount
  await probe.launch('probe-round-2')
  const restarted = await probe.http('/owner/status', 'owner')
  assert.equal(restarted.status, 200); assert.equal(restarted.body.active, null)
  assert.equal(restarted.body.latest.id, started.body.id); assert.equal(restarted.body.latest.state, 'interrupted')
  assert.equal(queryCount, beforeRestart)
  await probe.terminate()
  process.stdout.write(JSON.stringify({ ready, uid: probe.uid, owner_status: owner.status, settings_status: configured.status, start_status: started.status, unforwarded_owner_status: 401, external_owner_status: 403, forwarded_internal_owner_status: 403, forwarded_internal_external_status: 403, keepalive_observed: keepalives > 0, background_scan_cancelled: pendingQueries.size === 0, ...termination, interrupted_after_restart: true, automatic_resume: false, metatube_contacted: false, real_host_tested: false }) + '\n')
} finally { await probe.dispose() }
