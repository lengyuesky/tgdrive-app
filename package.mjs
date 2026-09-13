// 将编译好的页面资源打包成标准 ZIP，运行时不需要 Node.js 或构建工具。
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { resolve, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateRawSync } from 'node:zlib'
import { MAX_MANIFEST_BYTES, parsePublishJson, readLimitedFile } from './catalog.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const source = resolve(process.argv[2] ?? `${root}/shorts`)
const output = resolve(process.argv[3] ?? `${root}/catalog`)
const manifest = parsePublishJson(new TextDecoder('utf-8', { fatal: true }).decode(await readLimitedFile(`${source}/app.json`, MAX_MANIFEST_BYTES, '应用清单')))
if (!/^[a-z][a-z0-9-]{0,63}$/.test(manifest.id) || !/^[0-9A-Za-z.+-]{1,80}$/.test(manifest.version)) {
  throw new Error('应用 ID 或版本无效')
}
// 包内清单与目录共用 JSON 数值表示，避免 1.0/1e0 经目录序列化后与原包不一致。
const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n')
if (manifestBytes.length > MAX_MANIFEST_BYTES) throw new Error('规范化应用清单超过 64 KiB')
const files = []
async function collect(directory) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue
    const path = `${directory}/${entry.name}`
    if (entry.isSymbolicLink()) throw new Error('插件包不能包含符号链接')
    if (entry.isDirectory()) await collect(path)
    else if (entry.isFile()) {
      const name = relative(source, path).split('\\').join('/')
      files.push({ name, data: name === 'app.json' ? manifestBytes : await readFile(path) })
    }
  }
}
await collect(source)
if (!files.some((file) => file.name === manifest.entry)) throw new Error('应用入口文件不存在')
if (files.some((file) => file.name === 'tgdrive-sdk.js')) throw new Error('tgdrive-sdk.js 由打包工具自动加入，请移除同名源文件')
files.push({ name: 'tgdrive-sdk.js', data: await readFile(`${root}/sdk/tgdrive-sdk.js`) })
if (files.length > 256 || files.some((file) => file.data.length > 8 * 1024 * 1024)
  || files.reduce((sum, file) => sum + file.data.length, 0) > 32 * 1024 * 1024) throw new Error('插件包超过文件数量或大小限制')
const local = []
const central = []
let offset = 0
for (const { name, data } of files) {
  if (!name.split('/').every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))) throw new Error(`资源路径无效：${name}`)
  const filename = Buffer.from(name)
  const compressed = deflateRawSync(data)
  const checksum = crc32(data)
  const head = Buffer.alloc(30)
  head.writeUInt32LE(0x04034b50)
  head.writeUInt16LE(20, 4)
  head.writeUInt16LE(0x800, 6)
  head.writeUInt16LE(8, 8)
  head.writeUInt16LE(33, 12)
  head.writeUInt32LE(checksum, 14)
  head.writeUInt32LE(compressed.length, 18)
  head.writeUInt32LE(data.length, 22)
  head.writeUInt16LE(filename.length, 26)
  local.push(head, filename, compressed)
  const entry = Buffer.alloc(46)
  entry.writeUInt32LE(0x02014b50)
  entry.writeUInt16LE(0x0314, 4)
  head.copy(entry, 6, 4, 30)
  entry.writeUInt32LE(0o100644 * 65536, 38)
  entry.writeUInt32LE(offset, 42)
  central.push(entry, filename)
  offset += head.length + filename.length + compressed.length
}
const directory = Buffer.concat(central)
const end = Buffer.alloc(22)
end.writeUInt32LE(0x06054b50)
end.writeUInt16LE(files.length, 8)
end.writeUInt16LE(files.length, 10)
end.writeUInt32LE(directory.length, 12)
end.writeUInt32LE(offset, 16)
const archive = Buffer.concat([...local, directory, end])
if (archive.length > 16 * 1024 * 1024) throw new Error('插件包压缩后超过 16 MiB')
await mkdir(output, { recursive: true })
const destination = `${output}/${manifest.id}-${manifest.version}.tgapp`
await writeFile(destination, archive)
console.log(`已打包 ${manifest.name} v${manifest.version}：${destination}（${archive.length} 字节）`)
