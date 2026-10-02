// 独立模拟宿主：仅绑定本机，文件由浏览器选择，存储只在本次页面内存中。
import { createServer } from 'node:http'
import { readFile, realpath } from 'node:fs/promises'
import { resolve, dirname, extname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateManifest } from '../catalog.mjs'
const root = await realpath(resolve(process.argv[2] ?? 'shorts'))
const toolsRoot = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(await readFile(resolve(root, 'app.json'), 'utf8')); validateManifest(manifest)
const port = Number(process.env.TGDRIVE_DEV_PORT ?? 4190)
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/manifest') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(manifest)); return }
    let path
    if (url.pathname === '/') path = resolve(toolsRoot, 'mock-host.html')
    else if (url.pathname === '/mock-host.js') path = resolve(toolsRoot, 'mock-host.js')
    else if (url.pathname === '/app/tgdrive-sdk.js') path = resolve(toolsRoot, '../sdk/tgdrive-sdk.js')
    else if (url.pathname.startsWith('/app/')) {
      path = await realpath(resolve(root, decodeURIComponent(url.pathname.slice(5))))
      if (!path.startsWith(root + sep)) throw new Error('路径越界')
    } else { res.writeHead(404); res.end(); return }
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' }
    res.setHeader('Content-Type', types[extname(path)] ?? 'application/octet-stream')
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'no-store')
    res.end(await readFile(path))
  } catch { res.writeHead(404); res.end('资源不存在') }
})
server.listen(port, '127.0.0.1', () => console.log(`模拟宿主：http://127.0.0.1:${port}；不连接真实网盘。`))
