import { mkdir, readFile, rename } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPages } from './build-pages.mjs'
import { buildCinema } from './build-cinema.mjs'
import { buildMediaScraper } from './build-media-scraper.mjs'
import { applications, createOutput, exists, generateCatalog, parseOptions, verifyPackages, writeJson } from './pipeline.mjs'

export const buildOptions = {
  '--output': { name: 'output' },
  '--target': { name: 'target' },
  '--reuse-native': { name: 'nativeRoot' },
  '--catalog-state': { name: 'stateDirectory' },
  '--repository': { name: 'repository' },
  '--probe': { name: 'probe', boolean: true },
}

/** 统一入口仅编排既有构建器；分架构 runner 构建后由 catalog-packages 汇总。 */
export async function buildAll(output, options = {}) {
  const target = options.target ?? 'all'
  if (!['all', 'web', 'linux-amd64', 'linux-arm64'].includes(target)) throw new Error('构建目标无效')
  const destination = await createOutput(output)
  const logDirectory = resolve(destination, 'logs')
  const packageDirectory = resolve(destination, 'packages')
  await mkdir(packageDirectory)
  const previousLogs = process.env.TGAPP_PIPELINE_LOG_DIR
  process.env.TGAPP_PIPELINE_LOG_DIR = logDirectory
  const packages = [], nativeBuilds = []
  try {
    if (target === 'all' || target === 'web') packages.push(...await buildPages(['reader', 'shorts'], resolve(destination, 'pages')))
    if (target !== 'web') {
      const targets = target === 'all' ? ['linux-amd64', 'linux-arm64'] : [target]
      for (const [id, builder] of [['cinema', buildCinema], ['media-scraper', buildMediaScraper]]) {
        const native = {}
        for (const selected of targets) {
          const reused = options.nativeRoot && resolve(options.nativeRoot, id, selected)
          if (reused && await exists(reused)) native[selected] = reused
          nativeBuilds.push({ id, target: selected, rebuilt: !native[selected], directory: native[selected] ?? resolve(destination, id, `native-${selected}`) })
        }
        packages.push(...await builder(resolve(destination, id), native, { targets }))
      }
    }
    for (let index = 0; index < packages.length; index++) {
      const path = resolve(packageDirectory, basename(packages[index]))
      await rename(packages[index], path); packages[index] = path
    }
    const reports = await verifyPackages(packages, logDirectory, target)
    let catalog
    if (target === 'all') catalog = await generateCatalog(packages, resolve(destination, 'catalog'), logDirectory, options)
    if (options.probe && target !== 'web') {
      const { probePackages } = await import('./probe-packages.mjs')
      await probePackages(reports.filter(report => report.backend), resolve(destination, 'probes'), logDirectory)
    }
    const versions = Object.fromEntries(await Promise.all(applications.map(async app => [app.id, JSON.parse(await readFile(new URL(`../${app.id}/app.json`, import.meta.url), 'utf8')).version])))
    const result = { target, versions, packages: reports, nativeBuilds, catalog: catalog && resolve(catalog.directory, 'catalog.json') }
    await writeJson(resolve(destination, 'build-result.json'), result)
    process.stdout.write(`构建完成：${reports.length} 个包；${catalog ? '目录已通过 catalog-check' : '分目标产物，目录由汇总任务生成'}\n`)
    return { directory: destination, packageDirectory, ...result }
  } finally {
    if (previousLogs === undefined) delete process.env.TGAPP_PIPELINE_LOG_DIR
    else process.env.TGAPP_PIPELINE_LOG_DIR = previousLogs
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseOptions(process.argv.slice(2), buildOptions)
  await buildAll(options.output, options)
}
