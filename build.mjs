// 独立插件构建工具：打包静态与编译插件，生成 .build、apps 与根目录分发清单。
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { copyFile, mkdir, readdir, writeFile, rm, readFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isDeepStrictEqual } from 'node:util'
import { spawn } from 'node:child_process'
import { build } from 'vite'
import {
  mergeCatalogs, collectPackages, formatSha256Sums, sha256Hex,
  serializeCatalog, DEFAULT_REPOSITORY, readCatalog, verifyCatalogPackages,
} from './catalog.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const modules = resolve(root, 'node_modules')
const officialApps = ['shorts', 'books', 'comics', 'cinema']

async function pack(source, destination) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [`${root}/package.mjs`, source, destination], { stdio: 'inherit' })
    child.on('error', rejectPromise)
    child.on('exit', (code) => code === 0 ? resolvePromise() : rejectPromise(new Error(`插件打包失败：${code}`)))
  })
}

async function buildReader(name, destination) {
  const output = `${root}/.build/${name}`
  await build({
    configFile: false,
    root: `${root}/${name}`,
    base: './',
    publicDir: false,
    resolve: {
      alias: {
        'mediabunny': `${modules}/mediabunny/dist/modules/src/index.js`,
        'pdfjs-dist': `${modules}/pdfjs-dist`,
        'dompurify': `${modules}/dompurify/dist/purify.es.mjs`,
        '@zip.js/zip.js': `${modules}/@zip.js/zip.js`,
      },
    },
    build: {
      outDir: output,
      emptyOutDir: true,
      target: 'es2022',
      sourcemap: false,
      rollupOptions: {
        output: {
          entryFileNames: 'assets/main-[hash].js',
          chunkFileNames: 'assets/chunk-[hash].js',
          assetFileNames: 'assets/resource-[hash][extname]',
        },
      },
      chunkSizeWarningLimit: 1800,
    },
  })

  await copyFile(`${root}/${name}/app.json`, `${output}/app.json`)
  await copyFile(`${root}/${name}/icon.svg`, `${output}/icon.svg`)
  await mkdir(`${output}/licenses`, { recursive: true })

  if (name === 'cinema') {
    await copyFile(`${modules}/mediabunny/LICENSE`, `${output}/licenses/mediabunny.txt`)
    await copyFile(`${root}/cinema/NOTICE.txt`, `${output}/licenses/NOTICE.txt`)
  } else {
    await copyFile(`${modules}/@zip.js/zip.js/LICENSE`, `${output}/licenses/zip-js.txt`)
  }

  if (name === 'books') {
    await copyFile(`${modules}/dompurify/LICENSE`, `${output}/licenses/dompurify.txt`)
    await copyFile(`${modules}/pdfjs-dist/LICENSE`, `${output}/licenses/pdfjs.txt`)
    await copyFile(`${root}/books/licenses/core-js.txt`, `${output}/licenses/core-js.txt`)
    await copyFile(`${root}/books/NOTICE.txt`, `${output}/licenses/NOTICE.txt`)
    for (const directory of ['cmaps', 'standard_fonts']) {
      await mkdir(`${output}/${directory}`, { recursive: true })
      for (const item of await readdir(`${modules}/pdfjs-dist/${directory}`, { withFileTypes: true })) {
        if (item.isFile()) {
          await copyFile(`${modules}/pdfjs-dist/${directory}/${item.name}`, `${output}/${directory}/${item.name}`)
        }
      }
    }
  }

  await pack(output, destination)
}

async function buildAll() {
  const distRoot = resolve(process.env.TGDRIVE_APP_BUILD_OUTPUT ?? root)
  const targetAppsDir = resolve(distRoot, 'apps')
  const targetCatalogPath = resolve(distRoot, 'catalog.json')
  const targetSumsPath = resolve(distRoot, 'SHA256SUMS')
  const repository = process.env.TGDRIVE_APP_GITHUB_REPO ?? DEFAULT_REPOSITORY

  // 1. 在隔离临时 staging 目录构建全部插件包，避免构建中途失败导致目标目录损坏
  const stagingDir = await mkdtemp(join(tmpdir(), 'tgdrive-build-staging-'))
  const stagingAppsDir = resolve(stagingDir, 'apps')
  await mkdir(stagingAppsDir, { recursive: true })

  try {
    await pack(`${root}/shorts`, stagingAppsDir)
    for (const name of ['books', 'comics', 'cinema']) {
      await buildReader(name, stagingAppsDir)
    }

    // 2. 收集并校验 staging 产物完整性与源 app.json 一致性
    const packages = await collectPackages(stagingAppsDir)
    if (packages.length !== officialApps.length || new Set(packages.map(p => p.manifest.id)).size !== officialApps.length) {
      throw new Error(`构建产物必须恰好包含四个官方插件包（预期 ${officialApps.join(', ')}）`)
    }
    for (const pkg of packages) {
      const sourceManifest = JSON.parse(await readFile(`${root}/${pkg.manifest.id}/app.json`, 'utf8'))
      if (!isDeepStrictEqual(sourceManifest, pkg.manifest)) {
        throw new Error(`插件 ${pkg.manifest.id} 包清单与源 app.json 不一致，需重新构建`)
      }
    }

    // 3. 若目标目录已有 catalog.json，读取并交由 mergeCatalogs 执行同版本不可篡改校验。
    // 仅当文件不存在（ENOENT）时允许首次构建，其他损坏/协议错误原样失败阻断，绝不静默覆盖。
    let previousCatalog = null
    try {
      previousCatalog = await readCatalog(targetCatalogPath, { repository })
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.cause?.code === 'ENOENT') {
        previousCatalog = null
      } else {
        throw error
      }
    }

    // 4. 生成 catalog.json 与 SHA256SUMS（单一真源 mergeCatalogs 严格执行同版本防篡改与版本单调校验）
    const catalogObj = mergeCatalogs({
      currentEntries: packages,
      previousCatalog,
      repository,
    })
    const catalogJsonStr = serializeCatalog(catalogObj)
    const stagingCatalogPath = resolve(stagingDir, 'catalog.json')
    await writeFile(stagingCatalogPath, catalogJsonStr)

    const sumsEntries = [
      ...packages.map(p => ({ name: `apps/${p.filename}`, sha256: p.sha256 })),
      { name: 'catalog.json', sha256: sha256Hex(Buffer.from(catalogJsonStr, 'utf8')) },
    ]
    const sumsStr = formatSha256Sums(sumsEntries)
    const stagingSumsPath = resolve(stagingDir, 'SHA256SUMS')
    await writeFile(stagingSumsPath, sumsStr)

    // 5. staging 内部做校验
    await verifyCatalogPackages(catalogObj, stagingAppsDir)

    // 6. 验证完全通过后，转入已授权的目标输出目录
    await mkdir(targetAppsDir, { recursive: true })

    // apps/ 仅保留最新四个包：清理目标目录中的旧版或其他 .tgapp
    const currentFilenames = new Set(packages.map(p => p.filename))
    const existingTargetFiles = await readdir(targetAppsDir, { withFileTypes: true })
    for (const item of existingTargetFiles) {
      if (item.name.endsWith('.tgapp') && !currentFilenames.has(item.name)) {
        await rm(resolve(targetAppsDir, item.name), { force: true })
      }
    }

    // 转入最新包
    for (const pkg of packages) {
      await copyFile(resolve(stagingAppsDir, pkg.filename), resolve(targetAppsDir, pkg.filename))
    }

    // 转入 catalog.json 与 SHA256SUMS
    await copyFile(stagingCatalogPath, targetCatalogPath)
    await copyFile(stagingSumsPath, targetSumsPath)

    console.log(`生成 catalog.json、SHA256SUMS 与 apps/ 插件包：${distRoot}`)
  } finally {
    await rm(stagingDir, { recursive: true, force: true })
  }
}

if (process.argv[2]) {
  // 保留原传入已编译源码目录和输出目录的用法
  const defaultPackDestination = process.env.TGDRIVE_APP_BUILD_OUTPUT
    ? resolve(process.env.TGDRIVE_APP_BUILD_OUTPUT)
    : resolve(root, 'apps')
  await pack(resolve(process.argv[2]), resolve(process.argv[3] ?? defaultPackDestination))
} else {
  await buildAll()
}
