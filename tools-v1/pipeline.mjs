import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { CATALOG_FORMAT } from '../contract/types/contract.ts'
import { assertNewOutput } from './output.mjs'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const applications = [
  { id: 'reader', targets: ['web'] },
  { id: 'shorts', targets: ['web'] },
  { id: 'cinema', targets: ['linux-amd64', 'linux-arm64'] },
  { id: 'media-scraper', targets: ['linux-amd64', 'linux-arm64'] },
]
export const buildTargets = ['all', 'web', 'linux-amd64', 'linux-arm64']
export const cargo = resolve(homedir(), '.cargo/bin/cargo')
export const cargoTarget = resolve(process.env.CARGO_TARGET_DIR ?? resolve(root, 'target'))
export const tgapp = resolve(cargoTarget, 'debug/tgapp')
let sequence = 0

/** 顶层管线只接受仓库外的新目录，真实路径检查也拒绝目录链接绕回源码。 */
export async function createOutput(output) {
  if (!output) throw new Error('必须明确提供仓库外的新输出目录')
  const destination = await assertNewOutput(root, output)
  await mkdir(dirname(destination), { recursive: true })
  const canonical = join(await realpath(dirname(destination)), basename(destination))
  const source = await realpath(root)
  if (canonical === source || canonical.startsWith(source + sep)) throw new Error('管线输出必须位于源码仓库之外')
  await mkdir(destination)
  return destination
}

export async function exists(path) {
  try { await lstat(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

/** 命令完整日志留在隔离目录，终端只报告状态；不要用它记录凭据或签名下载地址。 */
export async function runLogged(program, args, logDirectory, options = {}) {
  await mkdir(logDirectory, { recursive: true })
  const label = options.label ?? basename(program)
  const log = resolve(logDirectory, `${String(++sequence).padStart(3, '0')}-${label.replace(/[^a-zA-Z0-9_-]/g, '-')}.log`)
  const file = await open(log, 'wx')
  let code
  try {
    code = await new Promise((resolvePromise, reject) => {
      const { label: _, ...spawnOptions } = options
      const child = spawn(program, args, { cwd: root, ...spawnOptions, stdio: ['ignore', file.fd, file.fd] })
      child.once('error', reject)
      child.once('close', (status, signal) => resolvePromise(status ?? `signal-${signal}`))
    })
  } finally { await file.close() }
  if (code !== 0) {
    const text = await readFile(log, 'utf8')
    process.stderr.write(text.split('\n').slice(-18).join('\n') + '\n')
    throw new Error(`${label} 失败（${code}），完整日志：${log}`)
  }
  process.stdout.write(`${label} 通过；日志 ${log}\n`)
  return log
}

/** tgapp 的输出都是本地公开包元数据；捕获 JSON，不把整份清单重复打到终端。 */
export async function tool(args, logDirectory) {
  await mkdir(logDirectory, { recursive: true })
  const stdout = resolve(logDirectory, `${String(++sequence).padStart(3, '0')}-tgapp-${args[0]}.json`)
  const stderr = stdout + '.stderr'
  const out = await open(stdout, 'wx'), err = await open(stderr, 'wx')
  let code
  try {
    code = await new Promise((resolvePromise, reject) => {
      const child = spawn(tgapp, args, { cwd: root, stdio: ['ignore', out.fd, err.fd] })
      child.once('error', reject)
      child.once('close', (status, signal) => resolvePromise(status ?? `signal-${signal}`))
    })
  } finally { await out.close(); await err.close() }
  if (code !== 0) throw new Error(`tgapp ${args[0]} 拒绝输入：${(await readFile(stderr, 'utf8')).trim().slice(-1800)}`)
  return JSON.parse(await readFile(stdout, 'utf8'))
}

export async function ensureTool(logDirectory) {
  await runLogged(cargo, ['build', '--locked', '--manifest-path', resolve(root, 'Cargo.toml'), '--target-dir', cargoTarget, '--package', 'tgdrive-app-tools', '--bin', 'tgapp'], logDirectory, { label: 'build-tgapp' })
}

export async function packagePaths(directory) {
  const names = (await readdir(directory)).filter(name => name.endsWith('.tgapp')).sort()
  if (!names.length) throw new Error('包目录中没有 .tgapp 文件')
  return names.map(name => resolve(directory, name))
}

export function expectedPairs(target = 'all') {
  if (!buildTargets.includes(target)) throw new Error('构建目标只能是 all、web、linux-amd64 或 linux-arm64')
  return applications.flatMap(app => app.targets.filter(value => target === 'all' || value === target).map(value => `${app.id}/${value}`)).sort()
}

/** 只接受四款正式应用及本轮源码的版本；示例和多余目标不能进入发布管线。 */
export async function verifyPackages(packages, logDirectory, target = 'all') {
  const reports = []
  for (const path of packages) {
    const report = await tool(['verify', path], logDirectory)
    if (basename(path) !== report.filename) throw new Error('包文件名与清单及目标不符')
    const app = applications.find(app => app.id === report.manifest.id)
    if (!app) throw new Error('目录只接受四款正式应用，不接受示例')
    const manifest = JSON.parse(await readFile(resolve(root, app.id, 'app.json'), 'utf8'))
    if (manifest.version !== report.manifest.version) throw new Error(`${app.id} 的构建产物不是本轮源码版本`)
    reports.push({ ...report, path: resolve(path) })
  }
  const actual = reports.map(report => `${report.manifest.id}/${report.package.target}`).sort()
  if (JSON.stringify(actual) !== JSON.stringify(expectedPairs(target))) throw new Error('包集必须恰好覆盖所选目标的全部正式应用，不能缺失、重复或夹带额外包')
  return reports
}

/** 发布根状态必须自洽；只有空目录首次启动才允许没有历史，不能从非空目录重建历史。 */
async function publisherState(stateDirectory, repository, destination, logDirectory) {
  const checked = await tool(['catalog-check', resolve(stateDirectory, 'catalog.json')], logDirectory)
  if (checked.incompatible.length || checked.catalog.repository !== repository) throw new Error('既有目录属于其他仓库或含当前工具不能改写的契约版本')
  const previous = checked.catalog
  const source = resolve(stateDirectory, 'catalog-history.json')
  if (!await exists(source)) {
    if (previous.entries.length) throw new Error('非空目录缺少发布历史；不得自动重建历史继续发布')
    return { previous, history: { repository, entries: [] }, historyExists: false }
  }
  const metadata = await lstat(source)
  if (!metadata.isFile() || metadata.nlink !== 1) throw new Error('发布历史必须是普通文件，不能使用链接')
  const validation = await createOutput(resolve(destination, 'history-validation'))
  await copyFile(source, resolve(validation, 'catalog-history.json'), constants.COPYFILE_EXCL)
  // 用同一契约工具严格读取历史 JSON 与所有绑定；临时空目录只用于格式验证，不修改发布状态。
  await tool(['catalog', repository, validation], logDirectory)
  const history = JSON.parse(await readFile(resolve(validation, 'catalog-history.json'), 'utf8'))
  for (const entry of previous.entries) {
    const known = history.entries.find(value => value.manifest.id === entry.manifest.id && value.manifest.version === entry.manifest.version)
    if (!known) throw new Error('现有目录绑定没有记录在发布历史中；不得自动补造历史')
    if (!isDeepStrictEqual(known.manifest, entry.manifest)) throw new Error('发布历史与现有目录清单矛盾')
    for (const [target, artifact] of Object.entries(entry.packages)) {
      if (!isDeepStrictEqual(known.packages[target], artifact)) throw new Error('发布历史与现有目录包绑定矛盾')
    }
  }
  return { previous, history, historyExists: true }
}

/** 历史和目录先复制到隔离输出，再交给契约工具做状态转移；不在源码根目录生成。 */
export async function generateCatalog(packages, output, logDirectory, options = {}) {
  const destination = await createOutput(output)
  const repository = options.repository ?? 'lengyuesky/tgdrive-app'
  let state = { previous: { format: CATALOG_FORMAT, repository, entries: [] }, history: { repository, entries: [] } }
  if (options.stateDirectory) {
    state = await publisherState(options.stateDirectory, repository, destination, logDirectory)
    await copyFile(resolve(options.stateDirectory, 'catalog.json'), resolve(destination, 'catalog.json'), constants.COPYFILE_EXCL)
    if (state.historyExists) await copyFile(resolve(options.stateDirectory, 'catalog-history.json'), resolve(destination, 'catalog-history.json'), constants.COPYFILE_EXCL)
  }
  const catalog = await tool(['catalog', repository, destination, ...packages], logDirectory)
  await tool(['catalog-check', resolve(destination, 'catalog.json')], logDirectory)
  return { directory: destination, catalog, previous: state.previous, history: state.history }
}

export async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
}

export function parseOptions(args, allowed) {
  const options = {}
  for (let index = 0; index < args.length; index++) {
    const key = args[index]
    if (!Object.hasOwn(allowed, key) || Object.hasOwn(options, allowed[key].name)) throw new Error(`未知或重复参数：${key}`)
    const { name, boolean } = allowed[key]
    if (boolean) options[name] = true
    else {
      const value = args[++index]
      if (!value || value.startsWith('--')) throw new Error(`${key} 缺少参数`)
      options[name] = value
    }
  }
  return options
}
