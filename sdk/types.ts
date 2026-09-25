/** 页面插件的公开类型；实现由打包时加入的 tgdrive-sdk.js 提供。 */
export interface Ref { id: number; content_version: string }
export interface FileEntry extends Ref { path: string; name: string; is_dir: boolean; size: number; created_at: number; modified_at: number; favorite: boolean }
export interface Page { next_cursor: string | null; has_more: boolean }
export interface CallOptions { signal?: AbortSignal }
export interface RecordValue<T = unknown> { key: string; value: T; revision: string; updated_at: number }
export interface Search { under?: string; q?: string; kind?: 'file' | 'dir' | 'all'; extensions?: string[]; limit?: number; cursor?: string | null }
export interface ReadyContext { id: string; name: string; version: string; api_version: number; dark: boolean; capabilities?: string[] }
export interface ByteGrant { url: string; expires_at: number }
/** 批量信封中的一项调用；可批量的能力见 docs/sdk.md，界面交互、字节读取与批量本身不可用。 */
export interface BatchCall { method: string; params?: object }
export type BatchResult<T = unknown> = { result: T; error?: undefined } | { error: Error & { code?: string; status?: number }; result?: undefined }
/** 封面缓存记录：data 为 WebP/JPEG/PNG 的 base64 data URL，meta 由插件自定义用于核验是否过期。 */
export interface CoverRecord<M = unknown> { key: string; data: string; meta: M | null; updated_at: number }
export interface CoverStats { entries: number; bytes: number; limit_bytes: number; limit_entries: number }
export interface Drive {
  ready: Promise<ReadyContext>
  /** 能力探测：宿主未声明的功能需降级到消息通道。 */
  can(capability: string): boolean
  files: {
    list(params: { path: string; cursor?: string | null; limit?: number }, options?: CallOptions): Promise<Page & { entries: FileEntry[]; path: string; total?: number }>
    searchPage(params?: Search, options?: CallOptions): Promise<Page & { results: FileEntry[] }>
    stat(ref: { id: number; content_version?: string } | { path: string }, options?: CallOptions): Promise<FileEntry>
    readRange(ref: Ref, offset: number, length: number, options?: CallOptions): Promise<Uint8Array<ArrayBuffer>>
    readRanges(ref: Ref, ranges: Array<{ offset: number; length: number }>, options?: CallOptions): Promise<Uint8Array<ArrayBuffer>[]>
  }
  assets: { read(path: string, options?: CallOptions): Promise<Uint8Array<ArrayBuffer>> }
  media: {
    url(pathOrRef: string | Ref, kind?: 'preview' | 'thumbnail' | 'download' | 'bytes'): Promise<string>
    /** 字节数据面票据：插件可凭它直接 fetch + Range，需 media.bytes 能力。 */
    bytes(ref: Ref, options?: CallOptions): Promise<ByteGrant>
  }
  storage: {
    get<T = unknown>(key: string, options?: CallOptions): Promise<RecordValue<T> | null>
    set<T>(key: string, value: T, expectedRevision?: string | null, options?: CallOptions): Promise<RecordValue<T>>
    delete(key: string, expectedRevision: string, options?: CallOptions): Promise<{ ok: true }>
    list<T = unknown>(params?: { prefix?: string; cursor?: string | null; limit?: number }, options?: CallOptions): Promise<Page & { records: RecordValue<T>[] }>
    /** 近期内本页是否写入过该键；用于抑制自身写入经服务端事件回流。 */
    wroteRecently(key: string, windowMs?: number): boolean
  }
  /** 封面缓存：每次 1～16 个键，只返回命中项；单张解码后最多 256 KiB。需 covers 能力。 */
  covers: {
    get<M = unknown>(keys: string[], options?: CallOptions): Promise<CoverRecord<M>[]>
    put(key: string, data: string, meta?: object | null, options?: CallOptions): Promise<{ ok: true; bytes: number; evicted: number }>
    delete(keys: string[], options?: CallOptions): Promise<{ ok: true; deleted: number }>
    stats(options?: CallOptions): Promise<CoverStats>
  }
  /** 批量调用：一次往返执行最多 16 项服务端能力，逐项独立返回；需 rpc.batch 能力。 */
  batch(calls: BatchCall[], options?: CallOptions): Promise<BatchResult[]>
  settings: { get(): Promise<Record<string, string | boolean | number>>; patch(values: object): Promise<object>; open(): Promise<void> }
  ui: { pickDirectory(initial?: string): Promise<string | null>; download(path: string): Promise<void>; close(): Promise<void>; setImmersive(active: boolean, options?: { background: string }): Promise<void> }
  on(name: string, callback: (value?: any) => unknown): () => void
}
declare global { interface Window { tgdrive: Drive } }
