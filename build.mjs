// 独立插件构建工具：打包静态与编译插件，生成 .build、catalog 与发布清单。
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { build } from 'vite'
import { mergeCatalogs, collectPackages, formatSha256Sums, sha256Hex, serializeCatalog, DEFAULT_REPOSITORY } from './catalog.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const modules = resolve(root, 'node_modules')
const catalog = resolve(process.env.TGDRIVE_APP_BUILD_OUTPUT ?? `${root}/catalog`)

async function pack(source, destination = catalog) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [`${root}/package.mjs`, source, destination], { stdio: 'inherit' })
    child.on('error', rejectPromise)
    child.on('exit', (code) => code === 0 ? resolvePromise() : rejectPromise(new Error(`插件打包失败：${code}`)))
  })
}

async function buildReader(name) {
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
    for (const directory of ['cmaps', 'standard_fonts']) {
      await mkdir(`${output}/${directory}`, { recursive: true })
      for (const item of await readdir(`${modules}/pdfjs-dist/${directory}`, { withFileTypes: true })) {
        if (item.isFile()) {
          await copyFile(`${modules}/pdfjs-dist/${directory}/${item.name}`, `${output}/${directory}/${item.name}`)
        }
      }
    }
  }

  await pack(output)
}

async function buildAll() {
  await mkdir(catalog, { recursive: true })
  await pack(`${root}/shorts`)
  for (const name of ['books', 'comics', 'cinema']) {
    await buildReader(name)
  }

  // 自动生成 catalog.json 与 SHA256SUMS
  const releaseTag = process.env.TGDRIVE_APP_RELEASE_TAG ?? 'v1.0.0'
  const repository = process.env.TGDRIVE_APP_GITHUB_REPO ?? DEFAULT_REPOSITORY
  const packages = await collectPackages(catalog)

  const catalogObj = mergeCatalogs({
    currentEntries: packages,
    releaseTag,
    repository,
  })

  const catalogJsonStr = serializeCatalog(catalogObj)
  const catalogPath = `${catalog}/catalog.json`
  await writeFile(catalogPath, catalogJsonStr)

  const sumsEntries = [
    { name: 'catalog.json', sha256: sha256Hex(Buffer.from(catalogJsonStr, 'utf8')) },
    ...packages.map((p) => ({ name: p.filename, sha256: p.sha256 })),
  ]
  const sumsPath = `${catalog}/SHA256SUMS`
  await writeFile(sumsPath, formatSha256Sums(sumsEntries))
  console.log(`生成 catalog.json 与 SHA256SUMS：${catalog}`)
}

if (process.argv[2]) {
  // 保留原 build:apps 传入已编译源码目录和输出目录的用法。
  await pack(resolve(process.argv[2]), resolve(process.argv[3] ?? catalog))
} else {
  await buildAll()
}
