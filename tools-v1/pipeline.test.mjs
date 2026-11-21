import assert from 'node:assert/strict'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { createOutput, expectedPairs, parseOptions, root } from './pipeline.mjs'
import { assertNewOutput } from './output.mjs'

async function temporary(run) {
  const directory = await mkdtemp(resolve(tmpdir(), 'tgapp-pipeline-test-'))
  try { await run(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}

test('四款正式应用恰好分发两个 web 与四个原生目标', () => {
  assert.deepEqual(expectedPairs(), ['cinema/linux-amd64', 'cinema/linux-arm64', 'media-scraper/linux-amd64', 'media-scraper/linux-arm64', 'reader/web', 'shorts/web'])
  for (const target of ['web', 'linux-amd64', 'linux-arm64']) assert.equal(expectedPairs(target).length, 2)
  assert.throws(() => expectedPairs('darwin-arm64'))
})

test('输出必须新建且不能位于源码中，包括目录链接', async () => temporary(async directory => {
  const output = resolve(directory, 'build')
  assert.equal(await createOutput(output), output)
  await assert.rejects(createOutput(output), { code: 'EEXIST' })
  await assert.rejects(createOutput(root))
  await assert.rejects(createOutput(resolve(root, 'pipeline-output')))
  const link = resolve(directory, 'source-link')
  await symlink(root, link, 'dir')
  await assert.rejects(createOutput(resolve(link, 'pipeline-output')))
}))

test('单应用入口也拒绝源码内、已有目录与目录链接，不再保留旧分发路径例外', async () => temporary(async directory => {
  const output = resolve(directory, 'new')
  assert.equal(await assertNewOutput(root, output), output)
  await assert.rejects(assertNewOutput(root, directory), { code: 'EEXIST' })
  await assert.rejects(assertNewOutput(root, resolve(root, 'compiled-output')))
  const link = resolve(directory, 'linked-source')
  await symlink(root, link, 'dir')
  await assert.rejects(assertNewOutput(root, resolve(link, 'compiled-output')))
}))

test('命令行拒绝未知、重复及缺少值的参数', () => {
  const options = { '--output': { name: 'output' }, '--probe': { name: 'probe', boolean: true } }
  assert.deepEqual(parseOptions(['--output', '/tmp/new-output', '--probe'], options), { output: '/tmp/new-output', probe: true })
  for (const args of [['--unknown'], ['--output'], ['--output', '--probe'], ['--probe', '--probe'], ['--output', 'a', '--output', 'b']]) assert.throws(() => parseOptions(args, options))
})
