import { mkdir, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' })
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`影视测试媒体生成失败：${code}`)))
  })
}
/** 仅合成色块、测试音和中文字幕，绝不读取真实影视。 */
export async function seedCinema(root) {
  const directory = `${root}/测试影视`
  await mkdir(directory, { recursive: true })
  const subtitle = '1\n00:00:00,000 --> 00:00:08,000\n你好，私人影院\n\n2\n00:00:08,000 --> 00:00:20,000\n拖动后字幕仍然同步\n'
  await writeFile(`${directory}/星际旅程 S01E01.srt`, subtitle)
  await writeFile(`${directory}/星际旅程 S01E02.zh.srt`, subtitle)
  await writeFile(`${directory}/星际旅程 S01E02.ass`, '[Script Info]\nScriptType: v4.00+\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:20.00,Default,,0,0,0,,{\\b1}中文 ASS\\N仅显示文本\n')
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=duration=20:size=640x360:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '48', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', `${directory}/星际旅程 S01E01.mp4`])
  await ffmpeg(['-i', `${directory}/星际旅程 S01E01.mp4`, '-i', `${directory}/星际旅程 S01E01.srt`, '-map', '0:v', '-map', '0:a', '-map', '0:a', '-map', '1', '-c', 'copy', '-c:s', 'srt', '-metadata:s:a:0', 'title=主音轨', '-metadata:s:a:1', 'title=第二音轨', '-metadata:s:s:0', 'language=zho', `${directory}/星际旅程 S01E02.mkv`])
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x49355f:size=360x504', '-frames:v', '1', `${directory}/poster.png`])
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x4a436d:size=960x420', '-frames:v', '1', `${directory}/backdrop.jpg`])
  await writeFile(`${directory}/错误示例.avi`, '这不是有效的视频文件')
  const native = `${directory}/原生示例`
  await mkdir(native, { recursive: true })
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=duration=6:size=320x180:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=6', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '200k', '-c:a', 'libopus', '-b:a', '48k', `${native}/流光.webm`])
}
