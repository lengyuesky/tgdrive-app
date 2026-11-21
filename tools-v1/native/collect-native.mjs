import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const packageName = process.argv[2]
const target = readFileSync('/rust-target', 'utf8')
if (!packageName) throw new Error('必须提供应用后端 crate 名称')
const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--format-version', '1', '--filter-platform', target], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }))
const app = metadata.packages.find(pkg => pkg.name === packageName)
if (!app) throw new Error('找不到应用后端 crate')
const bins = app.targets.filter(target => target.kind.includes('bin'))
if (bins.length !== 1) throw new Error('示例构建要求应用恰好提供一个可执行入口')
execFileSync('cargo', ['build', '--locked', '--release', '--target', target, '--package', packageName, '--bin', bins[0].name], { stdio: 'inherit', env: { ...process.env, CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER: 'musl-gcc', CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER: 'musl-gcc' } })
mkdirSync('/out/backend', { recursive: true })
copyFileSync(`/out/target/${target}/release/${bins[0].name}`, '/out/backend/app')
const packageTarget = target.startsWith('x86_64') ? 'linux-amd64' : 'linux-arm64'
execFileSync('cargo', ['run', '--locked', '--release', '--target', target, '--package', 'tgdrive-app-tools', '--bin', 'tgapp', '--', 'elf', '/out/backend/app', packageTarget], { stdio: 'inherit', env: { ...process.env, CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER: 'musl-gcc', CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER: 'musl-gcc' } })

// 只随包携带实际正常依赖及其许可，不把测试替身、宿主或构建工具带入应用。
const byId = new Map(metadata.packages.map(pkg => [pkg.id, pkg]))
const nodes = new Map(metadata.resolve.nodes.map(node => [node.id, node]))
const visited = new Set()
function visit(id) {
  if (visited.has(id)) return
  visited.add(id)
  for (const dependency of nodes.get(id)?.deps ?? []) if (dependency.dep_kinds.some(kind => kind.kind === null)) visit(dependency.pkg)
}
visit(app.id)
const workspaceLicense = join(metadata.workspace_root, 'LICENSE')
if (!existsSync(workspaceLicense) || !statSync(workspaceLicense).isFile()) throw new Error('冻结源码缺少第一方根 LICENSE')
copyFileSync(workspaceLicense, '/out/LICENSE')
const notice = ['应用后端按 Linux musl 静态链接构建。', '同仓库第一方代码采用 MIT 许可，原文见 LICENSE 与各第一方依赖许可目录。', '本目录保留正常 Rust 依赖的原始许可文本；构建工具和测试替身不随应用分发。', 'SQLite C 源码与 Rust 标准库也包含在许可说明中。', '']
for (const id of [...visited].sort()) {
  const pkg = byId.get(id)
  const source = dirname(pkg.manifest_path)
  const destination = `/out/licenses/${pkg.name}-${pkg.version}`
  mkdirSync(destination, { recursive: true })
  let files = readdirSync(source).filter(name => /^(?:LICENSE|COPYING|NOTICE|UNLICENSE)(?:[._-].*)?$/i.test(name) && statSync(join(source, name)).isFile())
  if (pkg.source === null) {
    if (pkg.license !== 'MIT') throw new Error(`第一方包必须声明仓库 MIT 许可：${pkg.name} ${pkg.version}`)
    copyFileSync(workspaceLicense, join(destination, 'LICENSE'))
    files = ['LICENSE']
  } else if (files.length) {
    for (const name of files.sort()) copyFileSync(join(source, name), join(destination, name))
  } else throw new Error(`依赖缺少原始许可文件，不能继续分发：${pkg.name} ${pkg.version}`)
  notice.push(`${pkg.name} ${pkg.version}：${pkg.license ?? '见许可文件'}；${files.sort().join(', ')}`)
  if (pkg.name === 'libsqlite3-sys') {
    const header = join(source, 'sqlite3', 'sqlite3.h')
    if (existsSync(header)) {
      const text = readFileSync(header, 'utf8')
      const end = text.indexOf('*/')
      if (end < 0 || end > 4096) throw new Error('无法确认内置 SQLite 的许可头')
      writeFileSync(join(destination, 'sqlite-public-domain.txt'), text.slice(0, end + 2) + '\n')
    }
  }
}
const sysroot = execFileSync('rustc', ['--print', 'sysroot'], { encoding: 'utf8' }).trim()
let copiedRust = false
for (const directory of [sysroot, join(sysroot, 'share/doc/rust'), join(sysroot, 'share/doc/rust/html')]) {
  if (!existsSync(directory)) continue
  for (const name of readdirSync(directory)) if (/^(?:LICENSE(?:[._-].*)?|COPYRIGHT|copyright\.html)$/i.test(name) && statSync(join(directory, name)).isFile()) {
    mkdirSync('/out/licenses/rust', { recursive: true })
    copyFileSync(join(directory, name), join('/out/licenses/rust', basename(name)))
    copiedRust = true
  }
}
if (!copiedRust) throw new Error('Rust 工具链缺少标准库许可文件')
const muslCopyright = '/usr/share/doc/musl/copyright'
if (!existsSync(muslCopyright) || !statSync(muslCopyright).isFile()) throw new Error('musl 静态 C 运行库缺少原始许可说明')
mkdirSync('/out/licenses/musl', { recursive: true })
copyFileSync(muslCopyright, '/out/licenses/musl/copyright')
notice.push('musl 静态 C 运行库：MIT；部分组件采用 BSD、ISC、宽松许可或公有领域，完整声明见 licenses/musl/copyright。')
writeFileSync('/out/NOTICE', notice.join('\n') + '\n')
writeFileSync('/out/build-info.json', JSON.stringify({ target, rust: execFileSync('rustc', ['--version'], { encoding: 'utf8' }).trim(), package: app.name, version: app.version }, null, 2) + '\n')
