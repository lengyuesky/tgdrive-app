import { lstat, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** 输出目录单独解析，独立单测不依赖仓库里尚未重新生成的发布资产。 */
export function fixtureCatalogDir(env = process.env) {
  return resolve(env.TGDRIVE_APP_CATALOG_DIR ?? resolve(root, 'apps'))
}

/** 在合成媒体或启动宿主前检查构建产物，避免缺包后等待浏览器超时。 */
export async function verifyFixtureBuilds(hostDir, catalogDir) {
  if (!hostDir) {
    throw new Error('TGDRIVE_HOST_DIR 环境变量未设置。宿主为私有仓库，本机集成测试需要显式指定宿主目录，例如：TGDRIVE_HOST_DIR=/path/to/tgdrive npm run test:e2e')
  }
  const hostFrontendDist = resolve(hostDir, 'frontend/dist/index.html')
  const frontend = await lstat(hostFrontendDist).catch(() => null)
  if (!frontend?.isFile() || frontend.size === 0) {
    throw new Error(`未找到宿主前端构建产物：${hostFrontendDist}，请先在宿主 frontend 目录执行 npm run build`)
  }
  for (const id of ['shorts', 'reader', 'cinema']) {
    const manifest = JSON.parse(await readFile(resolve(root, id, 'app.json'), 'utf8'))
    const filename = `${manifest.id}-${manifest.version}.tgapp`
    const packageFile = await lstat(resolve(catalogDir, filename)).catch(() => null)
    if (!packageFile?.isFile() || packageFile.size === 0) {
      throw new Error(`未找到当前插件包 ${filename}：请先在插件仓库执行 npm run build；自定义 TGDRIVE_APP_CATALOG_DIR 需包含三个当前版本的非空普通包文件`)
    }
  }
}
