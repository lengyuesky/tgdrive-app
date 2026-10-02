import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'
import { validateManifest } from '../../catalog.mjs'
it('脚手架生成可校验的独立应用并拒绝覆盖用户文件', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'tgdrive-template-'))
  try {
    const destination = resolve(root, 'viewer')
    execFileSync(process.execPath, ['tools/create-app.mjs', 'sample-viewer', destination])
    const manifest = JSON.parse(await readFile(resolve(destination, 'app.json'), 'utf8'))
    expect(() => validateManifest(manifest)).not.toThrow()
    expect(manifest.integration.file_types).toEqual(['txt'])
    expect(() => execFileSync(process.execPath, ['tools/create-app.mjs', 'sample-viewer', destination], { stdio: 'pipe' })).toThrow()
    expect(await readFile(resolve(destination, 'app.js'), 'utf8')).toContain('drive.ui.authorizeDirectory')
  } finally { await rm(root, { recursive: true, force: true }) }
})
