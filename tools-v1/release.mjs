import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cargo, createOutput, parseOptions, root, writeJson } from './pipeline.mjs'
import { executeRelease, prepareRelease } from './release-core.mjs'
import { GitHubRemote } from './release-github.mjs'
import { rehearseRelease } from './release-offline.mjs'

async function offlineBuild(run) {
  const required = (await readFile(resolve(root, 'rust-toolchain.toml'), 'utf8')).match(/^channel = "([0-9]+\.[0-9]+\.[0-9]+)"$/m)?.[1]
  const { stdout } = await promisify(execFile)(resolve(cargo, '..', 'rustup'), ['toolchain', 'list'], { cwd: root })
  if (!required || !stdout.split('\n').some(line => line.startsWith(`${required}-`) || line.startsWith(`${required} `))) throw new Error('离线演练要求提前安装仓库固定 Rust 工具链；不会自动联网下载')
  const overrides = { CARGO_NET_OFFLINE: 'true', TGAPP_OFFLINE_BUILD: '1', RUSTUP_TOOLCHAIN: required, npm_config_offline: 'true', npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false' }
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]))
  Object.assign(process.env, overrides)
  try { return await run() } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** 默认永远离线；真实写入必须同时有 --publish 与 main 手动工作流的受限环境。 */
export async function release(options) {
  if (options.publish && options.dryRun) throw new Error('--publish 与 --dry-run 不能同时使用')
  const output = await createOutput(options.output)
  const repository = options.repository ?? 'lengyuesky/tgdrive-app'
  const source = options.source ?? process.env.GITHUB_SHA
  // 在构建前就拒绝任何不符合手动发布环境的真实发布请求。
  const remote = options.publish ? new GitHubRemote(repository, source) : null
  const run = async () => {
    const built = options.packages ? null : await (await import('./build-all.mjs')).buildAll(resolve(output, 'build'), { nativeRoot: options.nativeRoot, probe: options.probe, repository })
    const packages = options.packages ?? built.packageDirectory
    if (!options.publish) {
      process.stdout.write('开始离线发布演练：不会请求 GitHub、创建 Release、标签或 Git 提交\n')
      return rehearseRelease(packages, resolve(output, 'rehearsal'), { repository, stateDirectory: options.stateDirectory })
    }
    const prepared = await prepareRelease(packages, resolve(output, 'publish'), { repository, stateDirectory: options.stateDirectory ?? root })
    const result = await executeRelease(prepared, remote, source)
    await writeJson(resolve(output, 'published.json'), { ...result, mode: 'publish', source, repository })
    return result
  }
  return options.publish ? run() : offlineBuild(run)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseOptions(process.argv.slice(2), {
    '--output': { name: 'output' }, '--packages': { name: 'packages' },
    '--reuse-native': { name: 'nativeRoot' }, '--catalog-state': { name: 'stateDirectory' },
    '--repository': { name: 'repository' }, '--source': { name: 'source' },
    '--probe': { name: 'probe', boolean: true }, '--publish': { name: 'publish', boolean: true }, '--dry-run': { name: 'dryRun', boolean: true },
  })
  await release(options)
}
