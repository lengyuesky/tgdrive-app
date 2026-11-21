import { spawn } from 'node:child_process'
import { copyFile, chmod, mkdir, open, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createOutput, ensureTool, packagePaths, parseOptions, root, runLogged, tool, verifyPackages, writeJson } from './pipeline.mjs'

async function extract(packagePath, member, destination) {
  await mkdir(resolve(destination, '..'), { recursive: true })
  const file = await open(destination, 'wx')
  try {
    await new Promise((resolvePromise, reject) => {
      const child = spawn('unzip', ['-p', packagePath, member], { cwd: root, stdio: ['ignore', file.fd, 'pipe'] })
      let error = ''; child.stderr.on('data', chunk => { error = (error + chunk).slice(-1200) })
      child.once('error', reject)
      child.once('close', code => code === 0 ? resolvePromise() : reject(new Error(`已核验包的 ${member} 提取失败：${error}`)))
    })
  } finally { await file.close() }
}

/** 运行包内真实 ELF；解出的数据与可信探测脚本分别挂载，不从归档目录加载解释器代码。 */
export async function probePackages(reports, output, logDirectory) {
  const destination = await createOutput(output)
  const driver = resolve(destination, 'driver')
  await mkdir(resolve(driver, 'tools-v1/native'), { recursive: true })
  await mkdir(resolve(driver, 'contract/types'), { recursive: true })
  const contract = resolve(root, 'contract/types/contract.ts')
  await copyFile(contract, resolve(driver, 'contract/types/contract.ts'))
  await writeFile(resolve(driver, 'tools-v1/native/contract.js'), stripTypeScriptTypes(await readFile(contract, 'utf8')))
  for (const name of ['backend-probe.mjs', 'cinema-probe.mjs', 'media-scraper-probe.mjs']) await copyFile(resolve(root, 'tools-v1/native', name), resolve(driver, 'tools-v1/native', name))
  const results = []
  for (const report of reports) {
    if (!report.backend) continue
    const id = report.manifest.id, target = report.package.target
    if (!['cinema', 'media-scraper'].includes(id) || !['linux-amd64', 'linux-arm64'].includes(target)) throw new Error('容器探测只接受正式后端包')
    await tool(['verify', report.path], logDirectory)
    const data = resolve(destination, `${id}-${target}`)
    await mkdir(data)
    await extract(report.path, 'backend/app', resolve(data, 'backend/app'))
    await extract(report.path, 'app.json', resolve(data, 'app.json'))
    await chmod(resolve(data, 'backend/app'), 0o755)
    await tool(['elf', resolve(data, 'backend/app'), target], logDirectory)
    if (!(await stat(resolve(data, 'app.json'))).size) throw new Error('探测清单为空')
    const architecture = target.slice('linux-'.length)
    await runLogged('docker', ['run', '--rm', '--platform', `linux/${architecture}`, ...(process.env.TGAPP_OFFLINE_BUILD === '1' ? ['--pull', 'never'] : []), '--read-only', '--network', 'none',
      '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'FOWNER', '--cap-add', 'KILL', '--cap-add', 'SETUID', '--cap-add', 'SETGID', '--cap-add', 'DAC_OVERRIDE',
      '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '512m',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=192m',
      '--mount', `type=bind,source=${await realpath(data)},target=/app,readonly`,
      '--mount', `type=bind,source=${await realpath(driver)},target=/probe,readonly`,
      '--workdir', '/probe', 'node:22.22.0-bookworm-slim', 'node', `/probe/tools-v1/native/${id}-probe.mjs`, '/app/backend/app', '/app/app.json'],
    logDirectory, { label: `probe-${id}-${target}`, timeout: 180000 })
    results.push({ id, target, verifiedPackage: report.path, isolatedContainer: true, realHostTested: false })
  }
  await writeJson(resolve(destination, 'probes.json'), results)
  process.stdout.write(`隔离容器探测通过：${results.length} 个后端包\n`)
  return results
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseOptions(process.argv.slice(2), { '--packages': { name: 'packages' }, '--output': { name: 'output' }, '--target': { name: 'target' } })
  if (!options.packages) throw new Error('必须指定包目录')
  const target = options.target ?? 'all'
  const output = await createOutput(options.output)
  const logDirectory = resolve(output, 'logs')
  await ensureTool(logDirectory)
  const reports = await verifyPackages(await packagePaths(options.packages), logDirectory, target)
  await probePackages(reports, resolve(output, 'probes'), logDirectory)
}
