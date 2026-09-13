import { Input, CustomSource, MP4, QTFF, MATROSKA, WEBM, EncodedPacketSink, EncodedVideoPacketSource, EncodedAudioPacketSource, Output, Mp4OutputFormat, StreamTarget, type EncodedPacket } from 'mediabunny'
import type { Drive, FileEntry } from '../sdk/types'
import { RangeFile, ReadScheduler, delay, isAbort, MiB } from './io'
import { MatroskaSubtitles } from './matroska'
import type { SubtitleTrack } from './subtitles'
import { extension } from './model'

export interface PlaybackInfo { mode: string; duration: number; audio: { id: number; label: string }[]; subtitles: SubtitleTrack[]; seekable: boolean }
interface Callbacks { info(info: PlaybackInfo): void; ready(): void; error(message: string): void; note(message: string): void }
function event(target: EventTarget, name: string, signal: AbortSignal, action?: () => void) {
  signal.throwIfAborted()
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => { target.removeEventListener(name, done); target.removeEventListener('error', failed); signal.removeEventListener('abort', aborted) }
    const done = () => { cleanup(); resolve() }
    const failed = () => { cleanup(); reject(new Error('浏览器无法处理此媒体流，请下载原文件播放')) }
    const aborted = () => { cleanup(); reject(new DOMException('读取已取消', 'AbortError')) }
    target.addEventListener(name, done, { once: true }); target.addEventListener('error', failed, { once: true }); signal.addEventListener('abort', aborted, { once: true })
    try { action?.() } catch (error) { cleanup(); reject(error) }
  })
}

/** 每次重建只保留一个输入、一个 MSE 和一个写入流；无编码器、无整片 Blob。 */
export class PlaybackSession {
  private controller = new AbortController()
  private runController?: AbortController
  private input?: Input
  private output?: Output
  private range?: RangeFile
  private objectUrl?: string
  private subtitles?: MatroskaSubtitles
  private info: PlaybackInfo = { mode: '原生播放', duration: 0, audio: [], subtitles: [], seekable: true }
  private native = true
  private restored = false
  private resumeAfterRestore = true
  private generation = 0
  private audioId?: number
  private nativeCleanup?: () => void
  constructor(private drive: Drive, readonly file: FileEntry, private video: HTMLVideoElement, private scheduler: ReadScheduler, private callbacks: Callbacks) {}
  get currentInfo() { return this.info }
  get canSave() { return this.restored }
  get selectedAudio() { return this.audioId }
  async start(seconds = 0, audio?: number) {
    this.audioId = audio
    if (extension(this.file.name) === 'mkv') return this.remux(seconds)
    const active = ++this.generation, signal = this.controller.signal
    this.native = true
    // 原生播放前也检查可识别文件的音视频编码，避免有画面却静默丢失音轨。
    if (['mp4', 'm4v', 'mov', 'webm'].includes(extension(this.file.name))) {
      const range = new RangeFile(this.drive, this.file, signal, this.scheduler)
      const probe = new Input({ source: new CustomSource({ getSize: () => this.file.size, read: (start, end) => range.stream(start, end), maxCacheSize: 8 * MiB }), formats: [MP4, QTFF, MATROSKA, WEBM] })
      this.input = probe; this.range = range
      let compatible = false
      try {
        const mime = await probe.getMimeType(), audio = await probe.getAudioTracks()
        compatible = !!this.video.canPlayType(mime)
        for (const track of audio.slice(0, 1)) {
          const codec = await track.getCodecParameterString()
          if (!codec || !this.video.canPlayType(`${extension(this.file.name) === 'webm' ? 'audio/webm' : 'audio/mp4'}; codecs="${codec}"`)) compatible = false
        }
      } finally { probe.dispose(); range.clear(); this.input = undefined; this.range = undefined }
      signal.throwIfAborted()
      if (active !== this.generation) return
      if (!compatible) return this.remux(seconds)
    }
    const url = await this.drive.media.url(this.file)
    if (active !== this.generation) return
    signal.throwIfAborted()
    const meta = () => {
      if (active !== this.generation || signal.aborted) return
      this.info = { ...this.info, mode: '原生播放', duration: Number.isFinite(this.video.duration) ? this.video.duration : 0, seekable: Number.isFinite(this.video.duration) }
      this.callbacks.info(this.info)
      if (seconds > 0 && this.info.duration > 0) this.video.currentTime = Math.min(seconds, Math.max(0, this.info.duration - .2))
      this.restored = true; this.callbacks.ready()
      void this.play()
    }
    const error = () => {
      if (active !== this.generation || signal.aborted) return
      this.nativeCleanup?.()
      if (['mp4', 'm4v', 'mov', 'webm'].includes(extension(this.file.name))) {
        this.callbacks.note('原生播放失败，正在尝试客户端转封装…')
        void this.remux(seconds).catch(e => this.report(e))
      } else this.callbacks.error('浏览器不支持此文件的容器或编码。可下载后使用本机播放器观看。')
    }
    this.video.addEventListener('loadedmetadata', meta, { once: true }); this.video.addEventListener('error', error)
    this.nativeCleanup = () => { this.video.removeEventListener('loadedmetadata', meta); this.video.removeEventListener('error', error) }
    this.video.src = url; this.video.load()
    await this.play()
  }
  async play() {
    this.resumeAfterRestore = true
    if (!this.video.hasAttribute('src')) { this.callbacks.note('正在准备媒体，请稍候'); return }
    const active = this.generation
    try { await this.video.play() }
    catch (error) {
      if (active !== this.generation || this.controller.signal.aborted) return
      if ((error as Error).name === 'NotAllowedError') this.callbacks.note('请点击播放按钮继续')
      else if ((error as Error).name !== 'AbortError' && !this.native) this.report(error)
    }
  }
  private report(error: unknown) {
    if (!this.controller.signal.aborted && !isAbort(error)) {
      this.callbacks.error(error instanceof Error ? error.message : String(error))
      this.restored = false
      this.stopRun()
    }
  }
  async seek(seconds: number) {
    const target = Math.max(0, Math.min(seconds, this.info.duration > 0 ? this.info.duration - .05 : seconds))
    if (!this.info.seekable && target > 0) throw new Error('文件没有可用的定位索引，无法可靠拖动，请下载原文件')
    if (this.native) { this.video.currentTime = target; return }
    return this.remux(target, this.restored ? !this.video.paused : this.resumeAfterRestore)
  }
  async selectAudio(id: number) {
    const previous = this.audioId, resume = this.restored ? !this.video.paused : this.resumeAfterRestore
    this.audioId = id
    try { await this.remux(this.video.currentTime, resume) }
    catch (error) { this.audioId = previous; throw error }
  }
  async embedded(track: SubtitleTrack, seconds: number) {
    if (!this.subtitles) throw new Error('此文件没有可读取的内嵌文本字幕')
    return this.subtitles.window(track, seconds)
  }
  private stopRun() {
    this.runController?.abort(); this.nativeCleanup?.(); this.nativeCleanup = undefined
    this.input?.dispose(); this.input = undefined
    void this.output?.cancel().catch(() => {}); this.output = undefined
    this.range?.clear(); this.range = undefined; this.subtitles = undefined
    this.video.pause(); this.video.removeAttribute('src'); this.video.load()
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl)
    this.objectUrl = undefined
  }
  private async remux(seconds: number, resume = true) {
    const active = ++this.generation
    // 重建媒体源必然触发暂停；保留用户原先的播放意图，连续拖动时也不误判为新暂停。
    this.resumeAfterRestore = resume
    this.restored = false; this.stopRun(); this.native = false
    this.runController = new AbortController()
    const signal = AbortSignal.any([this.controller.signal, this.runController.signal])
    if (typeof MediaSource === 'undefined') throw new Error('此浏览器缺少 MediaSource，无法进行客户端转封装，请下载原文件播放')
    const range = new RangeFile(this.drive, this.file, signal, this.scheduler)
    this.range = range
    const input = new Input({ source: new CustomSource({ getSize: () => this.file.size, read: (start, end) => range.stream(start, end), maxCacheSize: 8 * MiB }), formats: [MP4, QTFF, MATROSKA, WEBM] })
    this.input = input
    try {
      const videoTrack = await input.getPrimaryVideoTrack(), audioTracks = await input.getAudioTracks()
      if (!videoTrack) throw new Error('文件中没有可播放的视频轨')
      const audioTrack = audioTracks.find(t => t.id === this.audioId) ?? audioTracks[0]
      this.audioId = audioTrack?.id
      const videoCodec = await videoTrack.getCodec(), audioCodec = await audioTrack?.getCodec()
      const vc = await videoTrack.getDecoderConfig(), ac = await audioTrack?.getDecoderConfig()
      if (!videoCodec || !vc || (audioTrack && (!audioCodec || !ac))) throw new Error('文件使用了无法转封装的视频或音频编码，请下载原文件')
      const mime = `video/mp4; codecs="${[await videoTrack.getCodecParameterString(), audioTrack && await audioTrack.getCodecParameterString()].filter(Boolean).join(',')}"`
      if (!MediaSource.isTypeSupported(mime)) throw new Error(`此设备不支持 ${videoCodec}${audioTrack ? ` / ${audioCodec}` : ''} 解码，转封装不能改变编码，请下载原文件播放`)
      let embedded: SubtitleTrack[] = [], indexed = true
      if (extension(this.file.name) === 'mkv') {
        const subtitles = new MatroskaSubtitles(range)
        try { await subtitles.open(); this.subtitles = subtitles; embedded = subtitles.tracks; indexed = subtitles.points.length > 0 }
        catch (error) { if (isAbort(error)) throw error; indexed = false; this.callbacks.note(`内嵌字幕／定位索引不可用：${(error as Error).message}`) }
      }
      const duration = await input.getDurationFromMetadata() ?? 0
      const info = { mode: '客户端转封装 · 不重新编码', duration, audio: await Promise.all(audioTracks.map(async t => ({ id: t.id, label: `${await t.getName() || await t.getLanguageCode() || '音轨'} · ${await t.getCodec() || '未知编码'}` }))), subtitles: embedded, seekable: indexed && duration > 0 }
      signal.throwIfAborted()
      this.info = info; this.callbacks.info(info)
      if (seconds > 0 && !this.info.seekable) { seconds = 0; this.callbacks.note('缺少可靠定位索引，已从头播放；可使用原文件下载') }
      range.setBudget(16 * MiB)
      const videoSink = new EncodedPacketSink(videoTrack), audioSink = audioTrack ? new EncodedPacketSink(audioTrack) : undefined
      let vp = await videoSink.getKeyPacket(seconds) ?? await videoSink.getFirstKeyPacket()
      if (!vp) throw new Error('未找到视频关键帧')
      const startTime = Math.max(0, vp.timestamp)
      let ap = audioSink ? await audioSink.getPacket(startTime) ?? await audioSink.getFirstPacket() : null
      signal.throwIfAborted(); range.setBudget()
      const mse = new MediaSource()
      this.objectUrl = URL.createObjectURL(mse)
      await event(mse, 'sourceopen', signal, () => { this.video.src = this.objectUrl!; this.video.load() })
      const buffer = mse.addSourceBuffer(mime)
      const mediaError = () => { if (active === this.generation) this.report(new Error('浏览器无法解码此媒体流，请重试或下载原文件播放')) }
      this.video.addEventListener('error', mediaError)
      this.nativeCleanup = () => this.video.removeEventListener('error', mediaError)
      if (duration > 0) mse.duration = duration
      const removeOld = async () => {
        const before = this.video.currentTime - 10
        if (before > 0 && buffer.buffered.length && buffer.buffered.start(0) < before) await event(buffer, 'updateend', signal, () => buffer.remove(0, before))
      }
      let written = 0
      const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 1 }), target: new StreamTarget(new WritableStream({ write: async ({ data, position }) => {
        signal.throwIfAborted()
        if (position !== written || data.length > 16 * MiB) throw new Error('媒体分片顺序错误或超过 16 MiB，已停止播放')
        await removeOld()
        try { await event(buffer, 'updateend', signal, () => buffer.appendBuffer(data)) }
        catch (error) {
          if ((error as Error).name !== 'QuotaExceededError') throw error
          await removeOld()
          await event(buffer, 'updateend', signal, () => buffer.appendBuffer(data))
        }
        written += data.length
        if (!this.restored && buffer.buffered.length && buffer.buffered.end(buffer.buffered.length - 1) > Math.max(startTime, seconds)) {
          this.video.currentTime = Math.max(startTime, seconds)
          this.restored = true; this.callbacks.ready()
          if (this.resumeAfterRestore) void this.play()
        }
      } }), { chunked: false }) })
      this.output = output
      const vs = new EncodedVideoPacketSource(videoCodec), as = audioCodec ? new EncodedAudioPacketSource(audioCodec) : undefined
      output.addVideoTrack(vs)
      if (as) output.addAudioTrack(as)
      await output.start()
      const pump = async () => {
        let videoMeta = true, audioMeta = true, packets = 0, fragmentBudget = 0, lastKey = startTime
        while (vp || ap) {
          signal.throwIfAborted()
          const nextTime = Math.min(vp?.timestamp ?? Infinity, ap?.timestamp ?? Infinity)
          while (this.restored && nextTime > this.video.currentTime + 30) await delay(100, signal)
          let packet: EncodedPacket
          if (vp && (!ap || vp.timestamp <= ap.timestamp)) {
            packet = vp
            if (vp.type === 'key' && vp.timestamp - lastKey >= 1) { fragmentBudget = 0; lastKey = vp.timestamp }
            fragmentBudget += vp.data.length
            if (fragmentBudget > 16 * MiB) throw new Error('视频关键帧间隔数据超过 16 MiB，请下载原文件播放')
            await vs.add(vp, videoMeta ? { decoderConfig: vc } : undefined); videoMeta = false
            vp = await videoSink.getNextPacket(vp)
          } else {
            packet = ap!
            fragmentBudget += packet.data.length
            if (fragmentBudget > 16 * MiB) throw new Error('音视频分片超过 16 MiB')
            await as!.add(packet, audioMeta ? { decoderConfig: ac! } : undefined); audioMeta = false
            ap = await audioSink!.getNextPacket(packet)
          }
          if (++packets % 64 === 0) await delay(0, signal)
        }
        await output.finalize(); signal.throwIfAborted()
        if (mse.readyState === 'open') mse.endOfStream()
        if (!this.restored) throw new Error('媒体没有产生可播放的数据')
      }
      void pump().catch(error => { if (active === this.generation) this.report(error) })
      // 数据泵自行遵守播放器背压，启动不等待整片处理完毕。
    } catch (error) {
      if (active === this.generation && !isAbort(error)) { this.stopRun(); throw error }
    }
  }
  stop() { this.generation++; this.controller.abort(); this.stopRun() }
}
