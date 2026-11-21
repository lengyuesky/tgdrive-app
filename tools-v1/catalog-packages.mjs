import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createOutput, ensureTool, generateCatalog, packagePaths, parseOptions, verifyPackages, writeJson } from './pipeline.mjs'

/** 汇总任务重验全部下载产物、双架构完整清单与持久历史，不相信 Artifact 文件名。 */
export async function catalogPackages(packageDirectory, output, options = {}) {
  const destination = await createOutput(output)
  const logDirectory = resolve(destination, 'logs')
  await ensureTool(logDirectory)
  const packages = await packagePaths(packageDirectory)
  const reports = await verifyPackages(packages, logDirectory)
  const result = await generateCatalog(packages, resolve(destination, 'catalog'), logDirectory, options)
  await writeJson(resolve(destination, 'packages.json'), reports)
  process.stdout.write(`汇总通过：${reports.length} 个包；目录 ${resolve(result.directory, 'catalog.json')}\n`)
  return { ...result, reports }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseOptions(process.argv.slice(2), {
    '--packages': { name: 'packages' }, '--output': { name: 'output' },
    '--catalog-state': { name: 'stateDirectory' }, '--repository': { name: 'repository' },
  })
  if (!options.packages) throw new Error('必须指定全部包目录')
  await catalogPackages(options.packages, options.output, options)
}
