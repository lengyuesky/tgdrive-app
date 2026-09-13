import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyFixtureBuilds } from '../browser/fixture-preflight.mjs'

const root = resolve(import.meta.dirname, '../..')
const run = promisify(execFile)
const temporary: string[] = []
const ids = ['shorts', 'books', 'comics', 'cinema']

async function fixture() {
  const directory = await mkdtemp(`${tmpdir()}/tgdrive-preflight-test-`)
  temporary.push(directory)
  const hostDir = `${directory}/host`, catalogDir = `${directory}/custom-catalog`
  await mkdir(`${hostDir}/frontend/dist`, { recursive: true })
  await writeFile(`${hostDir}/frontend/dist/index.html`, '<!doctype html><html><body>合成宿主构建产物</body></html>')
  const packages: Record<string, string> = {}
  for (const id of ids) {
    const source = `${directory}/${id}`
    await mkdir(source)
    const manifest = await readFile(`${root}/${id}/app.json`, 'utf8')
    await writeFile(`${source}/app.json`, manifest)
    await writeFile(`${source}/index.html`, '<!doctype html><html><body>合成插件构建产物</body></html>')
    await run(process.execPath, [`${root}/package.mjs`, source, catalogDir])
    packages[id] = `${catalogDir}/${id}-${JSON.parse(manifest).version}.tgapp`
  }
  return { hostDir, catalogDir, packages }
}

afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('浏览器夹具构建前置检查（不启动宿主）', () => {
  it('显式合成宿主与四个当前真实包通过，支持自定义目录', async () => {
    const { hostDir, catalogDir } = await fixture()
    await expect(verifyFixtureBuilds(hostDir, catalogDir)).resolves.toBeUndefined()
  })

  it('未指定宿主或缺少其前端产物时提供直接提示', async () => {
    const { hostDir, catalogDir } = await fixture()
    await expect(verifyFixtureBuilds(undefined, catalogDir)).rejects.toThrow('TGDRIVE_HOST_DIR 环境变量未设置')
    await rm(`${hostDir}/frontend/dist/index.html`)
    await expect(verifyFixtureBuilds(hostDir, catalogDir)).rejects.toThrow('请先在宿主 frontend 目录执行 npm run build')
  })

  it('未构建的插件目录直接提示 npm run build', async () => {
    const { hostDir, catalogDir } = await fixture()
    await rm(catalogDir, { recursive: true })
    await expect(verifyFixtureBuilds(hostDir, catalogDir)).rejects.toThrow('请先在插件仓库执行 npm run build')
  })

  it.each(ids)('缺少当前 %s 包时不能让其他包掩盖未构建状态', async id => {
    const { hostDir, catalogDir, packages } = await fixture()
    await rm(packages[id])
    await writeFile(`${catalogDir}/${id}-0.0.1.tgapp`, '旧版包不能代替当前包')
    await expect(verifyFixtureBuilds(hostDir, catalogDir)).rejects.toThrow(`未找到当前插件包 ${packages[id].split('/').at(-1)}`)
  })

  it.each(['empty', 'directory'])('拒绝 %s 占位文件', async kind => {
    const { hostDir, catalogDir, packages } = await fixture()
    await rm(packages.cinema)
    if (kind === 'empty') await writeFile(packages.cinema, '')
    else await mkdir(packages.cinema)
    await expect(verifyFixtureBuilds(hostDir, catalogDir)).rejects.toThrow('非空普通包文件')
  })

  it('真实夹具入口先拒绝缺包，不尝试 ffmpeg 或 cargo', async () => {
    const { hostDir, catalogDir, packages } = await fixture()
    await rm(packages.shorts)
    await expect(run(process.execPath, [`${root}/tests/browser/fixture.mjs`], {
      cwd: root,
      env: { ...process.env, PATH: '', TGDRIVE_HOST_DIR: hostDir, TGDRIVE_APP_CATALOG_DIR: catalogDir },
      timeout: 10_000,
    })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('请先在插件仓库执行 npm run build') })
  })
})
