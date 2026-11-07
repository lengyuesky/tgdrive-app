// 封面验收仅使用已合成的视频和故意损坏的文本文件，不读取生产媒体。
import { copyFile, mkdir, writeFile } from 'node:fs/promises'

export async function seedFntvCovers(root) {
  const directory = `${root}/封面验证`
  await mkdir(directory, { recursive: true })
  await copyFile(`${root}/测试影视/星际旅程 S01E01.mp4`, `${directory}/纯视频截帧.mp4`)
  await writeFile(`${directory}/无法解码.mp4`, '封面验证：这不是有效视频，但原文件读取入口应当保留。')
}
