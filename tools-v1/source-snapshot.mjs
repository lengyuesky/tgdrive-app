import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cp, copyFile, mkdtemp, mkdir } from 'node:fs/promises'
import { dirname, relative, resolve, basename, join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

/** 只拷贝应用工作区的 Rust 本地包，不碰旧应用、宿主、生产配置或依赖缓存。 */
export async function createRustSnapshot(root) {
  const cargo = resolve(homedir(), '.cargo/bin/cargo')
  const { stdout } = await promisify(execFile)(cargo, ['metadata', '--locked', '--no-deps', '--format-version', '1', '--manifest-path', resolve(root, 'Cargo.toml')], { cwd: root, maxBuffer: 32 * 1024 * 1024 })
  const metadata = JSON.parse(stdout)
  const snapshot = await mkdtemp(join(tmpdir(), 'app-rust-source-'))
  for (const name of ['Cargo.toml', 'Cargo.lock', 'LICENSE']) await copyFile(resolve(root, name), resolve(snapshot, name))
  for (const pkg of metadata.packages.filter(pkg => pkg.source === null)) {
    const source = dirname(pkg.manifest_path)
    const path = relative(root, source)
    if (!path || path.startsWith('..')) throw new Error('原生依赖必须位于当前应用仓库内')
    const destination = resolve(snapshot, path)
    await mkdir(dirname(destination), { recursive: true })
    await cp(source, destination, { recursive: true, filter: path => !['node_modules', 'target', 'dist', '.git', '.DS_Store'].includes(basename(path)) && !/^\.env(?:\.|$)/.test(basename(path)) })
  }
  return snapshot
}
