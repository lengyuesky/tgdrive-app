import { expect, it } from 'vitest'
import { validateManifest } from '../../catalog.mjs'
import source from '../../fntv/app.json?raw'

it('飞牛服务包要求受限宿主能力，旧接口或其他应用不能冒领此能力', () => {
  const manifest = JSON.parse(source)
  expect(() => validateManifest(manifest)).not.toThrow()
  for (const changed of [{ id: 'cinema' }, { api_version: 1 }, { min_host_version: '0.3.4' }, { permissions: ['files.read', 'fntv.service'] }]) {
    expect(() => validateManifest({ ...manifest, ...changed })).toThrow()
  }
  expect(manifest.permissions).not.toContain('favorites.write')
  expect(manifest.integration.file_types).toEqual([])
})
