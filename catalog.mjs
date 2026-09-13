// catalog.mjs：插件发布目录生成、历史合并、严格校验与 SHA256SUMS 工具。
import { open, writeFile, readdir, mkdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { crc32, inflateRawSync } from 'node:zlib'

export const DEFAULT_REPOSITORY = 'lengyuesky/tgdrive-app'
export const MAX_CATALOG_BYTES = 1024 * 1024
export const MAX_ENTRIES = 512
export const MAX_PACKAGE_BYTES = 16 * 1024 * 1024
export const MAX_MANIFEST_BYTES = 64 * 1024
export const TAG_PATTERN = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/
export const REPO_PATTERN = /^(?!\.{1,2}\/)[a-zA-Z0-9_.-]+\/(?!\.{1,2}$)[a-zA-Z0-9_.-]+$/
export const SHA256_PATTERN = /^[0-9a-f]{64}$/
export const APP_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/
export const VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/
const SEMVER_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/
const MAX_SEMVER_COMPONENT = (1n << 64n) - 1n
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u
const PERMISSIONS = ['files.read', 'media.read', 'favorites.write']
const MANIFEST_FIELDS = ['id', 'name', 'version', 'api_version', 'min_host_version', 'description', 'author', 'entry', 'permissions', 'settings']

function matches(pattern, value) {
  return typeof value === 'string' && pattern.exec(value)?.[0] === value
}

function validateObject(value, label, fields, required = fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须为对象`)
  if (Object.keys(value).some(key => !fields.includes(key))) throw new Error(`${label} 包含未知字段`)
  if (required.some(key => !Object.hasOwn(value, key))) throw new Error(`${label} 缺少必填字段`)
}

function validText(value, limit) {
  return typeof value === 'string' && value.isWellFormed() && Buffer.byteLength(value) <= limit
}

function validNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))
}

/** 拒绝溢出和超安全整数，避免发布或合并历史时静默舍入清单默认值。 */
export function parsePublishJson(text) {
  return JSON.parse(text, (_key, value) => {
    if (typeof value === 'number' && !validNumber(value)) throw new Error('JSON 数字超出有限值或安全整数范围，不能无损发布')
    return value
  })
}

function versionParts(value, pattern = VERSION_PATTERN) {
  if (!validText(value, 80) || !matches(pattern, value)) throw new Error('版本必须为合法 SemVer，稳定版本仅允许无前导零的 X.Y.Z')
  const parts = value.match(pattern).slice(1, 4).map(BigInt)
  if (parts.some(part => part > MAX_SEMVER_COMPONENT)) throw new Error('SemVer 数字段超出宿主支持范围')
  return parts
}

export function validateRepository(repository) {
  if (!validText(repository, 100) || !matches(REPO_PATTERN, repository)) throw new Error('仓库标识无效，必须为合法 owner/repo')
}

export function validateReleaseTag(tag) {
  if (!matches(TAG_PATTERN, tag)) throw new Error('release_tag 必须为无前导零的稳定 vX.Y.Z')
  versionParts(tag.slice(1))
}

/** 稳定 SemVer 按数值分段比较，避免字典序和浮点精度影响发布顺序。 */
export function compareStableVersions(left, right) {
  const a = versionParts(left)
  const b = versionParts(right)
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return 0
}

/** 只校验 schema，不按本机 API/宿主版本过滤未来兼容性条目。 */
export function validateManifest(manifest) {
  validateObject(manifest, 'manifest', MANIFEST_FIELDS)
  if (!matches(APP_ID_PATTERN, manifest.id)) throw new Error('应用 ID 无效')
  for (const [key, limit] of [['name', 120], ['description', 1600], ['author', 160]]) {
    const text = manifest[key]
    if (!validText(text, limit) || !text.trim() || CONTROL_PATTERN.test(text)) throw new Error(`manifest.${key} 为空、过长或包含控制字符`)
  }
  versionParts(manifest.version)
  versionParts(manifest.min_host_version, SEMVER_PATTERN)
  if (!Number.isInteger(manifest.api_version) || manifest.api_version < 1 || manifest.api_version > 0xffffffff) throw new Error('api_version 必须为正整数 u32')
  if (!validText(manifest.entry, 240) || !manifest.entry.endsWith('.html') || !manifest.entry.split('/').every(part => matches(/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/, part))) {
    throw new Error('entry 必须为包内合法 HTML 资源路径')
  }
  if (!Array.isArray(manifest.permissions) || manifest.permissions.length > PERMISSIONS.length || new Set(manifest.permissions).size !== manifest.permissions.length || manifest.permissions.some(permission => !PERMISSIONS.includes(permission))) {
    throw new Error('permissions 包含重复或不受支持的权限')
  }
  if (!Array.isArray(manifest.settings) || manifest.settings.length > 24) throw new Error('settings 必须为最多 24 项的数组')
  const keys = new Set()
  for (const field of manifest.settings) {
    validateObject(field, 'setting', ['key', 'label', 'description', 'type', 'default'], ['key', 'label', 'type', 'default'])
    if (!matches(/^[A-Za-z0-9_]{1,64}$/, field.key) || ['__proto__', 'constructor', 'prototype'].includes(field.key) || keys.has(field.key)) throw new Error('setting.key 无效或重复')
    keys.add(field.key)
    if (!validText(field.label, 160) || !field.label.trim() || (Object.hasOwn(field, 'description') && !validText(field.description, 1200))) throw new Error('setting 文本为空或过长')
    const value = field.default
    if (field.type === 'boolean' && typeof value === 'boolean') continue
    if (field.type === 'number' && validNumber(value)) continue
    if (['string', 'directory'].includes(field.type) && validText(value, 2048)) {
      if (field.type === 'directory' && value.split('/').some(part => part === '..' || CONTROL_PATTERN.test(part) || Buffer.byteLength(part) > 255)) throw new Error('setting.directory 默认值不是合法网盘路径')
      continue
    }
    throw new Error('setting.type 或 default 无效')
  }
}

/** 按实际读取字节数限量，文件增长或符号链接不能绕过大小门禁。 */
export async function readLimitedFile(path, maxBytes, label) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > maxBytes) throw new Error(`${label} 不是普通文件或大小超限（最大 ${maxBytes} 字节）`)
    const chunks = []
    let size = 0
    for await (const chunk of file.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
      size += chunk.length
      if (size > maxBytes) throw new Error(`${label} 大小超限（最大 ${maxBytes} 字节）`)
      chunks.push(chunk)
    }
    return Buffer.concat(chunks, size)
  } finally {
    await file.close()
  }
}

/** 从本仓库打包器生成的 ZIP 中限量提取文件；不接受加密或数据描述符。 */
export function extractFileFromZip(buffer, targetName) {
  let offset = 0
  while (offset + 30 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) break
    const flags = buffer.readUInt16LE(offset + 6)
    const method = buffer.readUInt16LE(offset + 8)
    const compSize = buffer.readUInt32LE(offset + 18)
    const size = buffer.readUInt32LE(offset + 22)
    const nameLen = buffer.readUInt16LE(offset + 26)
    const extraLen = buffer.readUInt16LE(offset + 28)
    const name = buffer.toString('utf8', offset + 30, offset + 30 + nameLen)
    const dataStart = offset + 30 + nameLen + extraLen
    const dataEnd = dataStart + compSize
    if ((flags & 9) !== 0 || dataEnd > buffer.length) throw new Error('ZIP 文件头无效或不受支持')
    if (name === targetName) {
      const limit = targetName === 'app.json' ? MAX_MANIFEST_BYTES : 8 * 1024 * 1024
      if (size > limit) throw new Error('ZIP 文件解压大小超限')
      const compressed = buffer.subarray(dataStart, dataEnd)
      const data = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed, { maxOutputLength: limit }) : null
      if (!data) throw new Error('ZIP 压缩方式不受支持')
      if (data.length !== size || crc32(data) !== buffer.readUInt32LE(offset + 14)) throw new Error('ZIP 文件长度或校验和不符')
      return data
    }
    offset = dataEnd
  }
  return null
}

export function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** 校验完整条目，包括清单、大小、稳定 tag 与精确的仓库资产 URL。 */
export function validateEntry(entry, options = {}) {
  const repository = options.repository ?? DEFAULT_REPOSITORY
  validateRepository(repository)
  validateObject(entry, '目录条目', ['manifest', 'sha256', 'size', 'url', 'release_tag'])
  validateManifest(entry.manifest)
  if (!matches(SHA256_PATTERN, entry.sha256)) throw new Error('sha256 必须为 64 位小写 hex')
  if (!Number.isInteger(entry.size) || entry.size <= 0 || entry.size > MAX_PACKAGE_BYTES) throw new Error('size 必须为正整数且不能超过 16 MiB')
  validateReleaseTag(entry.release_tag)
  const { id, version } = entry.manifest
  const expectedUrl = `https://github.com/${repository}/releases/download/${entry.release_tag}/${id}-${version}.tgapp`
  if (entry.url !== expectedUrl) throw new Error('条目 URL 不符合规范，必须精确指向指定仓库、稳定 tag 和包文件名')
}

/** 序列化与实际写入使用相同字节上限，包含末尾换行。 */
export function serializeCatalog(catalog) {
  const json = JSON.stringify(catalog, null, 2) + '\n'
  if (Buffer.byteLength(json) > MAX_CATALOG_BYTES) throw new Error('目录大小超限（最大 1 MiB）')
  return json
}

export function validateCatalog(catalog, options = {}) {
  validateObject(catalog, 'catalog', ['schema_version', 'repository', 'release_tag', 'entries'])
  if (catalog.schema_version !== 1) throw new Error('不支持的 schema_version，预期 1')
  validateRepository(catalog.repository)
  if (options.repository !== undefined && catalog.repository !== options.repository) throw new Error('目录所属仓库与当前仓库不匹配')
  validateReleaseTag(catalog.release_tag)
  if (!Array.isArray(catalog.entries)) throw new Error('entries 必须为数组')
  if (catalog.entries.length > MAX_ENTRIES) throw new Error('目录条目数超限（最大 512 条）')
  const seen = new Set()
  for (const entry of catalog.entries) {
    validateEntry(entry, { repository: catalog.repository })
    if (compareStableVersions(entry.release_tag.slice(1), catalog.release_tag.slice(1)) > 0) throw new Error('条目 release_tag 不能晚于目录 release_tag')
    const key = `${entry.manifest.id}@${entry.manifest.version}`
    if (seen.has(key)) throw new Error(`禁止重复记录：${key}`)
    seen.add(key)
  }
  serializeCatalog(catalog)
  return true
}

export function parseCatalog(content, options = {}) {
  if (Buffer.byteLength(content) > MAX_CATALOG_BYTES) throw new Error('目录大小超限（最大 1 MiB）')
  let catalog
  try {
    catalog = parsePublishJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(content)))
  } catch {
    throw new Error('目录不是有效的 UTF-8 JSON')
  }
  validateCatalog(catalog, options)
  return catalog
}

export async function readCatalog(path, options = {}) {
  return parseCatalog(await readLimitedFile(path, MAX_CATALOG_BYTES, '目录'), options)
}

/** 历史全量保留；同版本的摘要、完整清单和长度均不可改变。 */
export function mergeCatalogs({ currentEntries, previousCatalog = null, releaseTag, repository = DEFAULT_REPOSITORY }) {
  validateReleaseTag(releaseTag)
  validateRepository(repository)
  const merged = new Map()
  if (previousCatalog !== null) {
    validateCatalog(previousCatalog, { repository })
    if (compareStableVersions(releaseTag.slice(1), previousCatalog.release_tag.slice(1)) <= 0) throw new Error('新 release_tag 必须大于上一稳定目录版本')
    for (const prev of previousCatalog.entries) merged.set(`${prev.manifest.id}@${prev.manifest.version}`, prev)
  }
  if (!Array.isArray(currentEntries)) throw new Error('当前发布条目必须为数组')
  const currentKeys = new Set()
  for (const cur of currentEntries) {
    const entry = {
      manifest: cur?.manifest,
      sha256: cur?.sha256,
      size: cur?.size,
      url: `https://github.com/${repository}/releases/download/${releaseTag}/${cur?.manifest?.id}-${cur?.manifest?.version}.tgapp`,
      release_tag: releaseTag,
    }
    // 复用历史之前仍验证当前产物，不能让相同摘要掩盖错误元数据。
    validateEntry(entry, { repository })
    const key = `${entry.manifest.id}@${entry.manifest.version}`
    if (currentKeys.has(key)) throw new Error(`禁止重复记录：${key}`)
    currentKeys.add(key)
    const prev = merged.get(key)
    if (prev) {
      if (prev.sha256 !== entry.sha256) throw new Error(`同一应用相同版本不允许更换摘要（tamper detected）：${key}`)
      if (prev.size !== entry.size || !isDeepStrictEqual(prev.manifest, entry.manifest)) throw new Error(`同一应用相同版本不允许更换完整清单或大小：${key}`)
    } else {
      merged.set(key, entry)
    }
  }
  const entries = [...merged.values()].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id) || compareStableVersions(b.manifest.version, a.manifest.version))
  if (entries.length > MAX_ENTRIES) throw new Error('目录合并后条目超过上限，发布失败而非截断历史')
  const catalog = { schema_version: 1, repository, release_tag: releaseTag, entries }
  validateCatalog(catalog, { repository })
  return catalog
}

export async function collectPackages(packagesDir) {
  const items = await readdir(packagesDir, { withFileTypes: true })
  const packages = []
  for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!item.name.endsWith('.tgapp')) continue
    if (!item.isFile()) throw new Error('插件包必须为普通文件，不能是目录或符号链接')
    const buffer = await readLimitedFile(resolve(packagesDir, item.name), MAX_PACKAGE_BYTES, '插件包')
    const appJsonRaw = extractFileFromZip(buffer, 'app.json')
    if (!appJsonRaw) throw new Error(`包文件 ${item.name} 缺少内部 app.json`)
    const manifest = parsePublishJson(new TextDecoder('utf-8', { fatal: true }).decode(appJsonRaw))
    validateManifest(manifest)
    if (item.name !== `${manifest.id}-${manifest.version}.tgapp`) throw new Error('包文件名与 manifest 不符')
    packages.push({ filename: item.name, manifest, sha256: sha256Hex(buffer), size: buffer.length, buffer })
  }
  return packages
}

export function formatSha256Sums(fileEntries) {
  const sorted = [...fileEntries].sort((a, b) => a.name.localeCompare(b.name))
  return sorted.map(({ sha256, name }) => `${sha256}  ${name}\n`).join('')
}

async function main() {
  const args = process.argv.slice(2)
  const command = args[0] ?? 'generate'
  if (command === 'verify') {
    if (args.length > 2) throw new Error('verify 只接受一个目录文件路径')
    const catalogPath = resolve(args[1] ?? './catalog/catalog.json')
    const catalog = await readCatalog(catalogPath)
    console.log(`目录校验通过：${catalogPath}（共 ${catalog.entries.length} 条）`)
    return
  }
  if (command !== 'generate') throw new Error(`未知命令：${command}`)
  const packagesDir = resolve(args[1] ?? './catalog')
  const outputDir = resolve(args[2] ?? packagesDir)
  let releaseTag = process.env.TGDRIVE_APP_RELEASE_TAG ?? 'v1.0.0'
  let repository = process.env.TGDRIVE_APP_GITHUB_REPO ?? DEFAULT_REPOSITORY
  let previousPath = null
  for (const arg of args.slice(3)) {
    if (arg.startsWith('--tag=')) releaseTag = arg.slice('--tag='.length)
    else if (arg.startsWith('--repo=')) repository = arg.slice('--repo='.length)
    else if (arg.startsWith('--previous=') && arg.length > '--previous='.length) previousPath = resolve(arg.slice('--previous='.length))
    else throw new Error(`未知或空命令行参数：${arg}`)
  }
  const previousCatalog = previousPath ? await readCatalog(previousPath, { repository }) : null
  const packages = await collectPackages(packagesDir)
  if (packages.length === 0) throw new Error('未找到任何 .tgapp 插件包')
  const catalog = mergeCatalogs({ currentEntries: packages, previousCatalog, releaseTag, repository })
  const catalogJson = serializeCatalog(catalog)
  await mkdir(outputDir, { recursive: true })
  await writeFile(resolve(outputDir, 'catalog.json'), catalogJson)
  await writeFile(resolve(outputDir, 'SHA256SUMS'), formatSha256Sums([
    { name: 'catalog.json', sha256: sha256Hex(Buffer.from(catalogJson)) },
    ...packages.map(p => ({ name: p.filename, sha256: p.sha256 })),
  ]))
  console.log(`成功生成 catalog.json（${Buffer.byteLength(catalogJson)} 字节，${catalog.entries.length} 条）与 SHA256SUMS`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error('catalog 失败：', error.message)
    process.exitCode = 1
  })
}
