import { createServer } from 'vite'
import { ViteNodeServer } from 'vite-node/server'
import { ViteNodeRunner } from 'vite-node/client'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 使用现有转换器加载测试依赖，不读取 Vite 配置或环境文件。
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const server = await createServer({ root, configFile: false, envDir: false, logLevel: 'error', server: { hmr: false, watch: null } })
try {
  await server.environments.client.pluginContainer.buildStart({})
  const node = new ViteNodeServer(server)
  const runner = new ViteNodeRunner({ root, base: server.config.base, fetchModule: id => node.fetchModule(id), resolveId: (id, importer) => node.resolveId(id, importer) })
  await runner.executeId('/@vite/env')
  await runner.executeFile(resolve(root, 'cinema/page/browser-probe.mjs'))
} finally { await server.close() }
