import { lstat, realpath } from 'node:fs/promises'
import { dirname, resolve, join, basename, sep } from 'node:path'

/** 所有构建入口只接受仓库外的新目录，目录链接也不能绕回源码或覆盖已有产物。 */
export async function assertNewOutput(root, output) {
  root = await realpath(root)
  const requested = resolve(output)
  let ancestor = requested
  const tail = []
  for (;;) {
    try { ancestor = await realpath(ancestor); break }
    catch (error) {
      if (error?.code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error
      tail.unshift(basename(ancestor)); ancestor = dirname(ancestor)
    }
  }
  const canonical = join(ancestor, ...tail)
  if (canonical === root || canonical.startsWith(root + sep)) throw new Error('构建输出必须位于源码仓库之外')
  try {
    await lstat(requested)
    const error = new Error('输出目录已经存在，必须使用新的隔离目录')
    error.code = 'EEXIST'
    throw error
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  return requested
}
