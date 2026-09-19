/** 按记录进行 CAS 保存；保留未同步状态，绝不以过期进度覆盖另一设备。 */
import type { Drive, FileEntry, RecordValue } from '../sdk/types'
export interface Location { format: 'txt' | 'epub' | 'pdf' | 'comic'; index: number; offset?: number; ratio?: number; entry?: string; encoding?: string }
export interface Progress { file: FileEntry; title: string; location: Location }
export type ReaderFont = 'serif' | 'sans' | 'system'
export type ReaderFit = 'width' | 'page'
export type ReadingMode = 'scroll' | 'page' | 'single' | 'double'
/** 阅读视图使用的平面配置；新字段可选，旧调用方的完整字面量仍然有效。 */
export interface Preferences {
  theme: 'system' | 'light' | 'sepia' | 'dark'; fontSize: number; lineHeight: number; width: number
  mode: ReadingMode; direction: 'ltr' | 'rtl'; zoom: number
  font?: ReaderFont; margin?: number; fit?: ReaderFit; coverAlone?: boolean; spreadOffset?: 0 | 1
}
export const defaults: Preferences = { theme: 'system', fontSize: 18, lineHeight: 1.8, width: 760, mode: 'scroll', direction: 'ltr', zoom: 1 }
export const zoomLevels = [.5, .75, 1, 1.25, 1.5, 2, 3] as const
export const localFonts: Record<ReaderFont, string> = {
  serif: '"Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", SimSun, serif',
  sans: '"Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", sans-serif',
  system: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
}
const clamp = (value: unknown, min: number, max: number, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
export function preferences(raw: Partial<Preferences> | null | undefined): Preferences {
  const p = raw ?? {}
  return { theme: ['system','light','sepia','dark'].includes(p.theme ?? '') ? p.theme! : 'system', fontSize: clamp(p.fontSize, 12, 36, 18), lineHeight: clamp(p.lineHeight, 1.2, 2.8, 1.8), width: clamp(p.width, 360, 1400, 760),
    mode: ['page', 'single', 'double'].includes(p.mode ?? '') ? p.mode! : 'scroll', direction: p.direction === 'rtl' ? 'rtl' : 'ltr', zoom: clamp(p.zoom, 0.5, 3, 1),
    font: p.font === 'sans' || p.font === 'system' ? p.font : 'serif', margin: clamp(p.margin, 0, 64, 12),
    fit: p.fit === 'page' ? 'page' : p.fit === 'width' ? 'width' : undefined, coverAlone: p.coverAlone !== false, spreadOffset: p.spreadOffset === 1 ? 1 : 0 }
}

export type PreferenceFormat = 'text' | 'comic' | 'pdf'
export interface TextPreferences {
  theme: Preferences['theme']; fontSize: number; lineHeight: number; width: number
  mode: 'scroll' | 'page'; font: ReaderFont; margin: number
}
export interface ComicPreferences {
  theme: Preferences['theme']; mode: 'scroll' | 'single' | 'double'; direction: Preferences['direction']
  fit: ReaderFit; zoom: number; coverAlone: boolean; spreadOffset: 0 | 1
}
export interface PdfPreferences { theme: Preferences['theme']; fit: ReaderFit; zoom: number }
export interface FormatPreferences { text: TextPreferences; comic: ComicPreferences; pdf: PdfPreferences }
/** 持久化配置和视图平面配置分离，不能将 V2 记录直接传给 configure。 */
export interface PreferencesV2 extends FormatPreferences { schemaVersion: 2 }
export interface WorkPreferencesV2 {
  schemaVersion: 2
  overrides: { [K in PreferenceFormat]?: Partial<FormatPreferences[K]> }
}
export interface PreferencesSnapshot { value: PreferencesV2; revision: string | null; migrated: boolean }
export interface WorkPreferencesSnapshot { workId: string; value: WorkPreferencesV2; revision: string | null }
const fields = {
  text: ['theme', 'fontSize', 'lineHeight', 'width', 'mode', 'font', 'margin'],
  comic: ['theme', 'mode', 'direction', 'fit', 'zoom', 'coverAlone', 'spreadOffset'],
  pdf: ['theme', 'fit', 'zoom'],
} as const
const formats = ['text', 'comic', 'pdf'] as const
const object = (raw: unknown): raw is Record<string, unknown> => !!raw && typeof raw === 'object' && !Array.isArray(raw)
const unknownPreferences = () => Object.assign(new Error('阅读偏好格式未知，未覆盖原记录；请重新读取或升级应用'), { code: 'unknown_preferences' })
export const preferenceFormat = (format: Location['format']): PreferenceFormat => format === 'txt' || format === 'epub' ? 'text' : format
export function defaultPreferences(): PreferencesV2 {
  return { schemaVersion: 2,
    text: { theme: 'system', fontSize: 18, lineHeight: 1.8, width: 760, mode: 'scroll', font: 'serif', margin: 12 },
    comic: { theme: 'system', mode: 'scroll', direction: 'ltr', fit: 'width', zoom: 1, coverAlone: true, spreadOffset: 0 },
    pdf: { theme: 'system', fit: 'width', zoom: 1 } }
}
function validPreference(format: PreferenceFormat, key: string, value: unknown) {
  const between = (min: number, max: number) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
  switch (key) {
    case 'theme': return ['system', 'light', 'sepia', 'dark'].includes(value as string)
    case 'mode': return (format === 'comic' ? ['scroll', 'single', 'double'] : ['scroll', 'page']).includes(value as string)
    case 'font': return ['serif', 'sans', 'system'].includes(value as string)
    case 'fit': return value === 'width' || value === 'page'
    case 'direction': return value === 'ltr' || value === 'rtl'
    case 'fontSize': return between(12, 36)
    case 'lineHeight': return between(1.2, 2.8)
    case 'width': return between(360, 1400)
    case 'margin': return between(0, 64)
    case 'zoom': return between(.5, 3)
    case 'coverAlone': return typeof value === 'boolean'
    case 'spreadOffset': return value === 0 || value === 1
    default: return false
  }
}
function parseFormat<K extends PreferenceFormat>(format: K, raw: unknown, partial: boolean): Partial<FormatPreferences[K]> {
  if (!object(raw)) throw unknownPreferences()
  const allowed: readonly string[] = fields[format]
  if (Object.keys(raw).some(key => !allowed.includes(key) || !validPreference(format, key, raw[key]))
    || !partial && allowed.some(key => !(key in raw))) throw unknownPreferences()
  return { ...raw } as Partial<FormatPreferences[K]>
}
export function parsePreferences(raw: unknown): PreferencesV2 {
  if (!object(raw)) throw unknownPreferences()
  if (raw.schemaVersion === 2) {
    if (Object.keys(raw).some(key => key !== 'schemaVersion' && !formats.includes(key as PreferenceFormat))) throw unknownPreferences()
    return { schemaVersion: 2, text: parseFormat('text', raw.text, false) as TextPreferences,
      comic: parseFormat('comic', raw.comic, false) as ComicPreferences, pdf: parseFormat('pdf', raw.pdf, false) as PdfPreferences }
  }
  const legacyFields = ['theme', 'fontSize', 'lineHeight', 'width', 'mode', 'direction', 'zoom', 'font', 'margin', 'fit', 'coverAlone', 'spreadOffset']
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1 || Object.keys(raw).some(key => key !== 'schemaVersion' && !legacyFields.includes(key))) throw unknownPreferences()
  const p = preferences(raw), value = defaultPreferences()
  value.text = { ...value.text, theme: p.theme, fontSize: p.fontSize, lineHeight: p.lineHeight, width: p.width, mode: p.mode === 'page' ? 'page' : 'scroll', font: p.font!, margin: p.margin! }
  value.comic = { ...value.comic, theme: p.theme, mode: p.mode === 'page' ? 'single' : p.mode, direction: p.direction, zoom: p.zoom, fit: p.fit ?? (p.mode === 'page' ? 'page' : 'width'), coverAlone: p.coverAlone!, spreadOffset: p.spreadOffset! }
  value.pdf = { theme: p.theme, zoom: p.zoom, fit: raw.fit === 'page' ? 'page' : 'width' }
  return value
}
export function parseWorkPreferences(raw: unknown): WorkPreferencesV2 {
  if (!object(raw) || raw.schemaVersion !== 2 || !object(raw.overrides) || Object.keys(raw).some(key => !['schemaVersion', 'overrides'].includes(key))) throw unknownPreferences()
  const overrides: WorkPreferencesV2['overrides'] = {}
  for (const key of Object.keys(raw.overrides)) {
    if (!formats.includes(key as PreferenceFormat)) throw unknownPreferences()
    const format = key as PreferenceFormat
    Object.assign(overrides, { [format]: parseFormat(format, raw.overrides[format], true) })
  }
  return { schemaVersion: 2, overrides }
}
export function resolvePreferences(value: PreferencesV2, format: PreferenceFormat, work?: WorkPreferencesV2): Preferences {
  const base = parsePreferences(value), overrides = work ? parseWorkPreferences(work).overrides[format] : undefined
  return preferences({ ...defaults, ...base[format], ...overrides })
}
export class PreferenceSaveError extends Error {
  readonly code: 'storage_conflict' | 'preferences_not_saved'
  readonly draft: PreferencesV2 | WorkPreferencesV2
  constructor(readonly key: string, draft: PreferencesV2 | WorkPreferencesV2, cause: unknown) {
    const conflict = (cause as { code?: string } | null)?.code === 'storage_conflict'
    super(conflict ? '另一设备更新了阅读偏好；草稿已保留，请重新读取并确认后重试' : '阅读偏好未确认保存；草稿已保留，请重新读取后重试', { cause })
    this.name = 'PreferenceSaveError'; this.code = conflict ? 'storage_conflict' : 'preferences_not_saved'; this.draft = structuredClone(draft)
  }
}
/** 不自动重试 CAS；调用方必须保留表单基线并显式处理冲突，读取失败不能构造空基线保存。 */
export class PreferenceStore {
  constructor(private drive: Drive) {}
  async load(signal?: AbortSignal): Promise<PreferencesSnapshot> {
    signal?.throwIfAborted()
    const record = await this.drive.storage.get('preferences', { signal }); signal?.throwIfAborted()
    return { value: record ? parsePreferences(record.value) : defaultPreferences(), revision: record?.revision ?? null,
      migrated: !!record && (record.value as { schemaVersion?: unknown } | null)?.schemaVersion !== 2 }
  }
  private workKey(workId: string) {
    if (!/^[a-f0-9]{32}$/.test(workId)) throw Object.assign(new Error('作品标识无效，请先解析当前主作品'), { code: 'invalid_work' })
    return `preferences:work:${workId}`
  }
  async loadWork(workId: string, signal?: AbortSignal): Promise<WorkPreferencesSnapshot> {
    const key = this.workKey(workId); signal?.throwIfAborted()
    const record = await this.drive.storage.get(key, { signal }); signal?.throwIfAborted()
    return { workId, value: record ? parseWorkPreferences(record.value) : { schemaVersion: 2, overrides: {} }, revision: record?.revision ?? null }
  }
  private async save<T extends PreferencesV2 | WorkPreferencesV2>(key: string, value: T, revision: string | null, signal?: AbortSignal) {
    signal?.throwIfAborted()
    try {
      const record = await this.drive.storage.set(key, value, revision, { signal }); signal?.throwIfAborted()
      return record
    } catch (cause) { throw new PreferenceSaveError(key, value, cause) }
  }
  async saveFormat<K extends PreferenceFormat>(base: PreferencesSnapshot, format: K, patch: Partial<FormatPreferences[K]>, signal?: AbortSignal): Promise<PreferencesSnapshot> {
    const value = parsePreferences(base.value)
    Object.assign(value[format], parseFormat(format, patch, true))
    const record = await this.save('preferences', value, base.revision, signal)
    return { value: parsePreferences(record.value), revision: record.revision, migrated: false }
  }
  async saveWork<K extends PreferenceFormat>(base: WorkPreferencesSnapshot, format: K, patch: Partial<FormatPreferences[K]>, signal?: AbortSignal): Promise<WorkPreferencesSnapshot> {
    const value = parseWorkPreferences(base.value)
    Object.assign(value.overrides, { [format]: { ...value.overrides[format], ...parseFormat(format, patch, true) } })
    const record = await this.save(this.workKey(base.workId), value, base.revision, signal)
    return { workId: base.workId, value: parseWorkPreferences(record.value), revision: record.revision }
  }
  async clearWork(base: WorkPreferencesSnapshot, format: PreferenceFormat, signal?: AbortSignal): Promise<WorkPreferencesSnapshot> {
    const value = parseWorkPreferences(base.value); delete value.overrides[format]
    const record = await this.save(this.workKey(base.workId), value, base.revision, signal)
    return { workId: base.workId, value: parseWorkPreferences(record.value), revision: record.revision }
  }
}
export function validLocation(value: unknown): value is Location {
  if (!value || typeof value !== 'object') return false
  const loc = value as Location
  return ['txt','epub','pdf','comic'].includes(loc.format) && Number.isSafeInteger(loc.index) && loc.index >= 0
    && (loc.offset === undefined || Number.isSafeInteger(loc.offset) && loc.offset >= 0)
    && (loc.ratio === undefined || Number.isFinite(loc.ratio) && loc.ratio >= 0 && loc.ratio <= 1)
    && (loc.entry === undefined || typeof loc.entry === 'string' && loc.entry.length <= 4096)
    && (loc.encoding === undefined || ['utf-8','utf-16le','utf-16be','gb18030'].includes(loc.encoding))
}
export class ProgressStore {
  private record: RecordValue<Progress> | null = null
  private pending: Progress | null = null
  private running?: Promise<void>
  private timer?: ReturnType<typeof setTimeout>
  private conflict = false
  private stopped = false
  readonly key: string
  constructor(private drive: Drive, file: FileEntry, private status: (message: string, conflict: boolean) => void) { this.key = `progress:${file.id}` }
  seed(record: RecordValue<Progress> | null) {
    this.record = record
  }
  async load() {
    this.record = await this.drive.storage.get<Progress>(this.key)
    const value = this.record?.value
    return value && validLocation(value.location) ? value : null
  }
  mark(progress: Progress, immediately = false) {
    if (this.stopped || !validLocation(progress.location)) return
    if (!this.pending && JSON.stringify(progress) === JSON.stringify(this.record?.value)) return
    this.pending = structuredClone(progress)
    if (this.conflict) return
    this.status('未同步', false)
    if (immediately) void this.flush()
    else if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.flush() }, 5000)
  }
  flush(): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined
    if (this.running) return this.running
    this.running = this.save().finally(() => { this.running = undefined })
    return this.running
  }
  private async save() {
    while (this.pending && !this.conflict) {
      const value = this.pending; this.pending = null
      try {
        this.record = await this.drive.storage.set(this.key, value, this.record?.revision ?? null)
        this.status('已同步', false)
      } catch (error) {
        this.pending ??= value
        this.conflict = (error as { code?: string }).code === 'storage_conflict'
        this.status(this.conflict ? '另一设备更新了阅读进度' : '未同步：保存失败，请重试', this.conflict)
        return
      }
    }
  }
  async resolve(useRemote: boolean) {
    await this.running
    const latest = await this.drive.storage.get<Progress>(this.key)
    this.record = latest
    if (useRemote) this.pending = null
    this.conflict = false
    this.status('已同步', false)
    if (!useRemote) await this.flush()
    return latest?.value
  }
  stop() { this.stopped = true; clearTimeout(this.timer) }
}
