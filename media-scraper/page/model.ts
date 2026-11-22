import type { FileNode } from '@tgdrive/page-sdk'

/** 仅为本应用后端协议建模；文件节点直接使用契约类型。 */
export interface Settings {
  revision: string
  backend_url: string
  token_configured: boolean
  overwrite_nfo: boolean
  overwrite_poster: boolean
  directory: FileNode | null
}
export interface SettingsDraft { backend_url: string; overwrite_nfo: boolean; overwrite_poster: boolean }
export interface Counts { total: number; processed: number; done: number; skipped: number; failed: number }
export interface Run {
  id: string
  root: FileNode
  scope_revision: string
  state: string
  message: string
  created_at: number
  updated_at: number
  scan_complete: boolean
  counts: Counts
  retry_of: string | null
}
export interface Item {
  id: string
  run_id: string
  position: number
  files: FileNode[]
  number: string
  state: string
  reason: string
  target_id: string | null
  actors_summary: string
  steps: { role: string; state: string }[]
}
export interface Actor {
  data: { name: string; role: string; order: number | null; thumb: string; biography: string; provider: string; id: string }
  state: string
  message: string
  image_step: string | null
}
export interface Detail {
  item: Item
  steps: { id: string; role: string; state: string; name: string; message: string; file: FileNode | null }[]
  next_step: number | null
  actors: Actor[]
  next_actor: number | null
  attempts: { sequence: number; stage: string; provider: string; reason: string }[]
  next_attempt: number | null
}
export interface Status { settings: Settings; active: Run | null; latest: Run | null }
export interface HistoryCursor { created_at: number; id: string }
export interface HistoryPage { records: Run[]; next_cursor: HistoryCursor | null }
export interface ItemsPage { run: Run; items: Item[]; next_after: number | null }
export interface DetailCursors { step: number | null; actor: number | null; attempt: number | null }
export type DetailPart = keyof DetailCursors
export const active = (run: Run | null): boolean => !!run && ['scanning', 'running', 'stopping'].includes(run.state)
export const retryable = (run: Run | null): boolean => !!run && !active(run) && (!run.scan_complete || run.counts.done < run.counts.total)
export const stateName = (state: string): string => ({
  scanning: '扫描中', running: '刮削中', stopping: '正在停止', completed: '任务已结束', cancelled: '已停止', interrupted: '已中断', failed: '失败',
  pending: '等待处理', processing: '处理中', stopped: '未完成', done: '已完成', kept: '保留已有', skipped: '已跳过', needs_verification: '待核实',
  creating: '准备上传', uploading: '上传中', ready: '待提交', committing: '提交中', unknown: '待核实',
  matched: '已补充', unmatched: '未匹配', timeout: '查询超时', no_image: '来源无头像',
} as Record<string, string>)[state] ?? `未知状态（${state}）`
export const roleName = (role: string): string => ({ organize: '整理', nfo: 'NFO', poster: '海报', actor_cleanup: '旧头像清理', search: '搜索', detail: '详情' } as Record<string, string>)[role] ?? (role.startsWith('actor_') ? `演员头像 ${Number(role.slice(6)) + 1}` : role)
export const verificationNote = '失败计数包含待核实项；待核实不代表写入失败。重试会先核对回执和当前文件，再补齐缺失资料；本轮仍无终态证据时保持待核实，请在应用中心重启后端后再试。'
