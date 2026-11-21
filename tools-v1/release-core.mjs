import { constants } from 'node:fs'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { createOutput, ensureTool, generateCatalog, packagePaths, tool, verifyPackages, writeJson } from './pipeline.mjs'

const identity = manifest => `${manifest.id}@${manifest.version}`
export const releaseDraftMarker = '[tgapp-release-v1]'

/** 发布只使用自己的冻结副本；历史校验必须在任何远端写入之前完成。 */
export async function prepareRelease(packageDirectory, output, options) {
  const destination = await createOutput(output)
  const logs = resolve(destination, 'logs')
  await ensureTool(logs)
  const frozen = resolve(destination, 'packages')
  await mkdir(frozen)
  for (const path of await packagePaths(packageDirectory)) await copyFile(path, resolve(frozen, basename(path)), constants.COPYFILE_EXCL)
  const packages = await packagePaths(frozen)
  const reports = await verifyPackages(packages, logs)
  const candidate = await generateCatalog(packages, resolve(destination, 'catalog'), logs, options)
  return { directory: destination, catalogDirectory: candidate.directory, catalog: candidate.catalog, logs, reports, previous: candidate.previous, history: candidate.history }
}

function checkRelease(release, tag, reports, allowDraft = false) {
  if (release.tag_name !== tag || release.prerelease || (release.draft && (!allowDraft || !release.body?.startsWith(releaseDraftMarker)))) throw new Error(`${tag} 已存在但不是同名正式 Release 或本管线的待发布草稿，不会修改它`)
  const names = new Set()
  for (const asset of release.assets) {
    if (names.has(asset.name)) throw new Error(`${tag} 有重复资产名`)
    names.add(asset.name)
    if (asset.name.endsWith('.tgapp') && !reports.some(report => report.filename === asset.name)) throw new Error(`${tag} 有不属于当前目标集的应用包，不会删除或替换它`)
  }
}

function checkAsset(asset, report) {
  if (String(asset.size) !== report.size) throw new Error(`${report.filename} 的既有 Release 资产大小不一致，不可替换`)
  if (asset.digest && asset.digest !== `sha256:${report.sha256}`) throw new Error(`${report.filename} 的既有 Release 资产摘要不一致，不可替换`)
}

async function confirmArtifact(remote, release, asset, report, prepared, sequence) {
  checkAsset(asset, report)
  const directory = resolve(prepared.directory, `download-${String(sequence).padStart(3, '0')}`)
  await mkdir(directory)
  const downloaded = await remote.download(release, asset, report, directory)
  const verified = await tool(['verify', downloaded], prepared.logs)
  if (basename(downloaded) !== report.filename || verified.sha256 !== report.sha256 || verified.size !== report.size || !isDeepStrictEqual(verified.manifest, report.manifest) || !isDeepStrictEqual(verified.package, report.package)) throw new Error(`${report.filename} 的公开下载与已核验产物不一致，不会更新目录`)
}

/**
 * 两阶段发布：先只读检查所有既有资产，再补全未进入目录的版本，最后提交目录与历史。
 * 已在目录或历史中的版本绝不重建 Release；同名资产永不覆盖。适用于真实与离线远端。
 */
export async function executeRelease(prepared, remote, source) {
  const { reports, previous, history, catalog } = prepared
  const plans = [], confirmed = new Map()
  let sequence = 0, created = 0, uploaded = 0, published = 0
  await remote.assertSource(source)
  for (const entry of catalog.entries) {
    const key = identity(entry.manifest), tag = `${entry.manifest.id}-v${entry.manifest.version}`
    const packages = reports.filter(report => identity(report.manifest) === key)
    const listed = previous.entries.some(value => identity(value.manifest) === key)
    const remembered = history.entries.some(value => identity(value.manifest) === key)
    const release = await remote.getRelease(tag)
    if (!release && (listed || remembered)) throw new Error(`${tag} 已在目录或历史中，但 Release 不存在；不会清空历史重建`)
    if (release) {
      checkRelease(release, tag, packages, !listed && !remembered)
      for (const report of packages) {
        const asset = release.assets.find(value => value.name === report.filename)
        if (!asset && (listed || remembered)) throw new Error(`${report.filename} 已在目录或历史中但资产缺失；不会重新上传既有绑定`)
        if (asset) {
          await confirmArtifact(remote, release, asset, report, prepared, ++sequence)
          confirmed.set(report.filename, !release.draft)
        }
      }
    }
    plans.push({ tag, packages, listed, remembered, release })
  }
  // 先验证完所有版本再写入，避免后面的冲突导致前面的新版本已经上传。
  await remote.assertSource(source)
  for (const plan of plans) {
    if (!plan.release) {
      plan.release = await remote.createRelease(plan.tag, source)
      checkRelease(plan.release, plan.tag, plan.packages, true)
      created++
    }
    for (const report of plan.packages) {
      if (confirmed.has(report.filename)) continue
      // 远端适配器必须使用“不覆盖”的上传；并发插入同名资产也应失败而非覆盖。
      await remote.upload(plan.release, report)
      uploaded++
    }
  }
  for (const plan of plans) {
    const release = await remote.getRelease(plan.tag)
    if (!release) throw new Error(`${plan.tag} 上传后不可读取`)
    checkRelease(release, plan.tag, plan.packages, !plan.listed && !plan.remembered)
    for (const report of plan.packages) {
      const asset = release.assets.find(value => value.name === report.filename)
      if (!asset) throw new Error(`${report.filename} 上传后不存在，不能更新目录`)
      checkAsset(asset, report)
      if (!confirmed.has(report.filename)) {
        await confirmArtifact(remote, release, asset, report, prepared, ++sequence)
        confirmed.set(report.filename, !release.draft)
      }
    }
    plan.release = release
  }
  // 全部草稿字节先核验完，再正式发布；任何失败都不提前提交目录。
  for (const plan of plans) {
    let release = plan.release
    if (release.draft) {
      // 草稿可安全补齐；正式发布后可由 GitHub 的不可变 Release 机制锁定资产。
      await remote.assertSource(source)
      release = await remote.publish(release)
      published++
      checkRelease(release, plan.tag, plan.packages)
    }
    for (const report of plan.packages) {
      if (!confirmed.get(report.filename)) {
        const asset = release.assets.find(value => value.name === report.filename)
        if (!asset) throw new Error(`${report.filename} 正式发布后缺失`)
        await confirmArtifact(remote, release, asset, report, prepared, ++sequence)
        confirmed.set(report.filename, true)
      }
    }
  }
  await remote.assertSource(source)
  const changed = !isDeepStrictEqual(catalog, previous) || !isDeepStrictEqual(JSON.parse(await readFile(resolve(prepared.catalogDirectory, 'catalog-history.json'), 'utf8')), history)
  const commit = changed ? await remote.commitCatalog(prepared.catalogDirectory, source) : null
  const result = { created, uploaded, published, added: plans.filter(plan => !plan.listed).length, skipped: plans.filter(plan => plan.listed).length, committed: Boolean(commit), commit }
  await writeJson(resolve(prepared.directory, 'release-result.json'), result)
  process.stdout.write(`发布流程完成：新增目录版本 ${result.added}，跳过 ${result.skipped}，创建 Release ${created}，上传 ${uploaded}\n`)
  return result
}
