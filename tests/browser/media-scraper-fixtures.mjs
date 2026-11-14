import { copyFile, mkdir, writeFile } from 'node:fs/promises'

/** 从本轮已生成的色块影片复制独立样本，所有测试目录均属于临时网盘。 */
export async function seedMediaScraper(root) {
  const mp4 = `${root}/测试影视/星际旅程 S01E01.mp4`
  const mkv = `${root}/测试影视/星际旅程 S01E02.mkv`
  for (const name of ['整组', '关闭页面', '取消操作', '故障重试', '恢复记录', '公共后端']) {
    const directory = `${root}/刮削验证/${name}`
    await mkdir(directory, { recursive: true })
    const number = name === '公共后端' ? 'IPX-001' : 'ABC-123'
    await copyFile(mp4, `${directory}/${number}.mp4`)
    await writeFile(`${directory}/${number}.zh.srt`, '1\n00:00:00,000 --> 00:00:05,000\n合成验证字幕\n')
    if (name === '整组') {
      await copyFile(mkv, `${directory}/ABC-123.mkv`)
      await copyFile(mp4, `${directory}/ABC-123-4K.mp4`)
    }
  }
}
