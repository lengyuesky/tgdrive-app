// 独立浏览器夹具：合成视频、临时数据库、内存存储，不读取宿主项目的 .env。
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { seedReaders } from './readers-fixtures.mjs'
import { seedCinema } from './cinema-fixtures.mjs'
import { verifyFixtureBuilds } from './fixture-preflight.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const hostDir = process.env.TGDRIVE_HOST_DIR
const catalogDir = resolve(process.env.TGDRIVE_APP_CATALOG_DIR ?? `${repoRoot}/apps`)
await verifyFixtureBuilds(hostDir, catalogDir)

const temporary = await mkdtemp(`${tmpdir()}/tgdrive-apps-browser-`)
const video = `${temporary}/video.webm`

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options })
    child.on('error', reject)
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} 退出码：${code}`)))
  })
}

try {
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=duration=5:size=320x568:rate=15', '-c:v', 'libvpx-vp9', '-b:v', '220k', '-an', video])
} catch (error) {
  await rm(temporary, { recursive: true, force: true })
  throw new Error(`生成测试视频失败，请确认已安装 ffmpeg：${error.message}`)
}

const readers = await seedReaders(`${temporary}/readers`)
await seedCinema(readers)

const child = spawn('cargo', ['test', '--locked', 'apps::tests::browser_fixture', '--', '--ignored', '--exact', '--nocapture'], {
  cwd: hostDir,
  stdio: 'inherit',
  env: {
    ...process.env,
    TGDRIVE_TEST_VIDEO: video,
    TGDRIVE_TEST_FILES_DIR: readers,
    TGDRIVE_TEST_READERS: readers,
    TGDRIVE_APP_CATALOG_DIR: catalogDir,
    CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR ?? `${tmpdir()}/tgdrive-codex-target`,
  },
})

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('error', async (error) => { console.error(error); await rm(temporary, { recursive: true, force: true }); process.exit(1) })
child.on('exit', async (code) => { await rm(temporary, { recursive: true, force: true }); process.exit(code ?? 0) })
