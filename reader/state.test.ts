import { describe, expect, it, vi } from 'vitest'
import { ProgressStore, preferences, validLocation, type Progress } from './state'
import type { Drive, FileEntry, RecordValue } from '../sdk/types'
const file: FileEntry = { id:2, name:'书.pdf',path:'/书.pdf',content_version:'a',size:10,is_dir:false,created_at:1,modified_at:1,favorite:false }
const progress = (index: number): Progress => ({file,title:'书',location:{format:'pdf',index}})
function storage() {
  let record: RecordValue<Progress> | null = null, revision = 0
  const set = vi.fn(async (key: string, value: Progress, expected: string | null) => {
    if ((record?.revision ?? null) !== expected) throw Object.assign(new Error('冲突'), {code:'storage_conflict'})
    record = { key, value:structuredClone(value), revision:String(++revision), updated_at:revision }
    return structuredClone(record)
  })
  const get = vi.fn(async () => structuredClone(record))
  const drive = {storage:{set,get}} as unknown as Drive
  return {drive,set,get, latest:()=>record}
}
describe('跨设备阅读记录', () => {
  it('未移动不重复保存，过期页面不能把新进度改回旧页', async () => {
    const mock = storage(), status = vi.fn()
    const first = new ProgressStore(mock.drive,file,status)
    await first.load(); first.mark(progress(1)); await first.flush()
    first.mark(progress(1)); await first.flush(); expect(mock.set).toHaveBeenCalledTimes(1)
    const second = new ProgressStore(mock.drive,file,vi.fn())
    expect((await second.load())!.location.index).toBe(1)
    second.mark(progress(2)); await second.flush()
    first.mark(progress(0)); await first.flush()
    expect(mock.latest()!.value.location.index).toBe(2)
    expect(status).toHaveBeenLastCalledWith('另一设备更新了阅读进度',true)
    await first.resolve(false)
    expect(mock.latest()!.value.location.index).toBe(0)
    first.stop(); second.stop()
  })
  it('使用云端丢弃待覆盖值，下一次保存基于最新修订标识', async () => {
    const mock = storage(), first = new ProgressStore(mock.drive,file,vi.fn()), second = new ProgressStore(mock.drive,file,vi.fn())
    await first.load(); await second.load()
    first.mark(progress(3)); await first.flush()
    second.mark(progress(1)); await second.flush()
    expect((await second.resolve(true))!.location.index).toBe(3)
    await second.flush(); expect(mock.latest()!.value.location.index).toBe(3)
    second.mark(progress(4)); await second.flush(); expect(mock.latest()!.value.location.index).toBe(4)
    first.stop(); second.stop()
  })
  it('网络失败保留待保存位置，重试后才显示已同步', async () => {
    const mock = storage(), status = vi.fn(), store = new ProgressStore(mock.drive,file,status)
    await store.load(); mock.set.mockRejectedValueOnce(new Error('断网'))
    store.mark(progress(5)); await store.flush()
    expect(status).toHaveBeenLastCalledWith('未同步：保存失败，请重试',false)
    await store.flush(); expect(mock.latest()!.value.location.index).toBe(5)
    store.stop()
  })
  it('不使用非法定位或无限字号等损坏配置', () => {
    expect(validLocation({format:'txt',index:-1})).toBe(false)
    expect(validLocation({format:'comic',index:1,ratio:Infinity})).toBe(false)
    expect(preferences({fontSize:Infinity,width:-2,theme:'bad' as never})).toMatchObject({fontSize:18,width:360,theme:'system'})
  })
})
