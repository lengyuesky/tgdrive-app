// 创建独立的最小应用；拒绝覆盖已有目录。
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const [id, output = id] = process.argv.slice(2)
if (!id || !/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error('用法：npm run create -- 应用ID [输出目录]')
const directory = resolve(output)
await mkdir(directory)
const manifest = { id, name: '目录查看器', version: '1.0.0', api_version: 2, min_host_version: '0.3.0', description: '通过宿主授权目录并查看文件。', author: '请填写维护者', entry: 'index.html', permissions: ['files.read', 'media.read'], settings: [], integration: { file_types: ['txt'], directories: false, changelog: '首次发布。', formats: ['TXT'], limitations: ['只读取用户授权的目录。'], homepage: '', support: '', screenshots: [], data_schema: 1 } }
await writeFile(`${directory}/app.json`, JSON.stringify(manifest, null, 2) + '\n')
await writeFile(`${directory}/index.html`, '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="./style.css"><script defer src="./tgdrive-sdk.js"></script><script defer src="./app.js"></script></head><body><h1>目录查看器</h1><button id="choose">选择目录</button><p id="status" role="status"></p><ul id="files"></ul></body></html>\n')
await writeFile(`${directory}/style.css`, 'body{font:16px system-ui;padding:24px;line-height:1.6;color:#243047;background:#f4f6fa}button{padding:8px 16px;border:1px solid #ccd3df;border-radius:8px;background:white}li{margin:10px 0}\n')
await writeFile(`${directory}/app.js`, `const drive = window.tgdrive
const status = document.getElementById('status')
async function browse(path) {
  const result = await drive.files.list({ path, limit: 100 })
  const list = document.getElementById('files'); list.replaceChildren()
  for (const file of result.entries) {
    const item = document.createElement('li'), button = document.createElement('button')
    button.textContent = file.name; button.onclick = () => drive.ui.fileDetails(file).catch(report)
    item.append(button); list.append(item)
  }
  status.textContent = result.has_more ? '当前展示前 100 项，请按游标实现后续分页。' : path
}
function report(error) { status.textContent = error.message }
document.getElementById('choose').onclick = async () => {
  try { const path = await drive.ui.authorizeDirectory('/'); if (path) await browse(path) } catch (error) { report(error) }
}
async function boot() {
  const context = await drive.ready
  await drive.lifecycle.migrate(1, async () => {})
  if (context.launch?.file) await drive.ui.fileDetails(context.launch.file)
  await drive.lifecycle.report('ready')
}
boot().catch(report)
`)
console.log(`已创建 ${directory}。使用 npm run dev:host -- ${directory} 预览，使用 npm run package -- ${directory} 打包。`)
