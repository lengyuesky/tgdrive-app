import type { FileEntry, ScraperCandidate, ScraperReference } from '../sdk/types'

export const VIDEO_EXTENSIONS = ['mp4','mkv','m4v','mov','webm','ogv','avi','wmv','flv','ts','mts','m2ts','3gp']
export const stem = (name: string) => name.replace(/\.[^.]+$/, '')
export const foldName = (name: string) => name.replace(/[A-Z]/g, char => char.toLowerCase())
export const parent = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/'
export const normalizedNumber = (value: string) => value.replace(/[^a-z0-9]/gi, '').toUpperCase()
/** 只识别有明确边界的编号；普通电影名和画质参数不会被当作可靠番号。 */
export function numbers(name: string): string[] {
  const result = new Set<string>()
  const value = stem(name).toUpperCase()
  for (const match of value.matchAll(/(?:^|[^A-Z0-9])FC2[ _-]*(?:PPV[ _-]*)?(\d{5,9})(?=$|[^A-Z0-9])/g)) result.add(`FC2-PPV-${match[1]}`)
  for (const match of value.matchAll(/(?:^|[^A-Z0-9])([A-Z]{2,12})[ _-]+(\d{2,8})(?=$|[^A-Z0-9])/g)) {
    if (!['FC','PPV','HEVC','H264','H265','X264','X265','WEB','BLURAY'].includes(match[1])) result.add(`${match[1]}-${match[2]}`)
  }
  for (const match of value.matchAll(/(?:^|[^A-Z0-9])([A-Z]{2,10})(\d{3,8})(?=$|[^A-Z0-9])/g)) {
    if (!['FC','HEVC','H','X','WEB'].includes(match[1])) result.add(`${match[1]}-${match[2]}`)
  }
  for (const match of value.matchAll(/(?:^|[^A-Z0-9])(\d{2,4}[A-Z]{2,10})[ _-]?(\d{2,8})(?=$|[^A-Z0-9])/g)) result.add(`${match[1]}-${match[2]}`)
  for (const match of value.matchAll(/(?:^|[^A-Z0-9])(\d{6})[_-](\d{2,4})(?=$|[^A-Z0-9])/g)) result.add(`${match[1]}_${match[2]}`)
  return [...result]
}
export function inferNumber(file: FileEntry): string {
  const own = numbers(file.name)
  if (own.length === 1) return own[0]
  if (own.length > 1) return ''
  const directory = numbers(parent(file.path).split('/').pop() ?? '')
  return directory.length === 1 ? directory[0] : ''
}
/** 同一番号可以有多个资料源；保持后端顺序，依次尝试，不把来源数量当作作品歧义。 */
export function exactCandidates(candidates: ScraperCandidate[], number: string): ScraperCandidate[] {
  const expected = normalizedNumber(number), seen = new Set<string>()
  return candidates.filter(candidate => {
    if (!expected || !candidate.provider.trim() || !candidate.id.trim() || normalizedNumber(candidate.number) !== expected) return false
    const key = `${candidate.provider}\0${candidate.id}`
    if (seen.has(key)) return false
    seen.add(key); return true
  })
}
export const reference = ({ id, path, content_version }: FileEntry): ScraperReference => ({ id, path, content_version })
export interface Group { key: string; files: FileEntry[]; number: string }
export function groups(files: FileEntry[]): Group[] {
  const result = new Map<string, Group>()
  for (const file of files) {
    const key = `${parent(file.path)}\0${foldName(stem(file.name))}`
    let group = result.get(key)
    if (!group) { group = { key, files: [], number: inferNumber(file) }; result.set(key, group) }
    group.files.push(file)
  }
  return [...result.values()]
}
/** 不能唯一归属的视频配套文件由自动刮削跳过。 */
export function sharedCompanion(name: string, videos: Set<string>): boolean {
  const value=foldName(name), base=stem(value), ext=value.split('.').pop() ?? ''
  if(!['nfo','jpg','jpeg','png','webp','srt','vtt','ass','ssa'].includes(ext))return false
  if(value==='movie.nfo'||/^(poster|folder|cover)\.(jpg|jpeg|png|webp)$/.test(value))return true
  let owners=Number(videos.has(base))
  if(['jpg','jpeg','png','webp'].includes(ext)&&base.endsWith('-poster'))owners+=Number(videos.has(base.slice(0,-7)))
  if(['srt','vtt','ass','ssa'].includes(ext))for(let at=base.indexOf('.');at>=0;at=base.indexOf('.',at+1))owners+=Number(videos.has(base.slice(0,at)))
  return owners!==1
}
export const stateName = (state: string) => ({ draft:'检查中',running:'执行中',stopping:'正在停止',completed:'已结束',cancelled:'已停止',paused:'已暂停',interrupted:'已中断',pending:'等待处理',processing:'处理中',done:'已完成',kept:'保留已有',skipped:'未更新',needs_user:'已跳过',needs_verification:'待核实',uploading:'写入中' } as Record<string,string>)[state] ?? state
export const resultReason = (reason: string) => reason.replaceAll('请选择影视资料候选', '未取得匹配的资料').replaceAll('请重新预览', '请重新刮削').replaceAll('重新扫描并预览', '重新刮削').replaceAll('预览会话', '刮削任务')
