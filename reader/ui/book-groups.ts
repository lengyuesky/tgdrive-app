/** 图书分组管理与归属选择，所有用户文本均作为纯文本渲染。 */
import type { BookGroupsStore } from '../library'
import { errorMessage } from '../library'
import { createModal } from './modals'

export function fillGroupSelect(select: HTMLSelectElement, store: BookGroupsStore, filter = false, value = '') {
  select.replaceChildren()
  if (filter) select.add(new Option('全部分组', '*'))
  select.add(new Option('未分组', ''))
  for (const group of store.groups) select.add(new Option(group.name, group.id))
  select.value = value
}

export function showBookGroups(store: BookGroupsStore, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const { dialog, cleanup } = createModal({ title: '管理分组', signal, onCancel: resolve })
    const list = document.createElement('div')
    list.className = 'book-group-list'
    const form = document.createElement('div')
    form.className = 'book-group-row'
    const input = document.createElement('input')
    input.placeholder = '新分组名称'; input.setAttribute('aria-label', '新分组名称')
    const add = document.createElement('button')
    add.textContent = '新建'; add.type = 'button'; add.className = 'btn-primary'
    form.append(input, add)
    const status = document.createElement('p')
    status.setAttribute('role', 'status')
    const actions = document.createElement('div')
    actions.className = 'modal-actions'
    const reload = document.createElement('button'), close = document.createElement('button')
    reload.textContent = '重新加载'; close.textContent = '完成'
    reload.type = close.type = 'button'
    actions.append(reload, close)
    dialog.append(list, form, status, actions)
    let busy = false
    const run = async (action: () => Promise<unknown>, done?: () => void) => {
      if (busy) return
      busy = true; status.textContent = '正在保存…'
      dialog.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input').forEach(el => { el.disabled = true })
      try { await action(); if (signal.aborted) return; done?.(); status.textContent = '已保存'; render() }
      catch (error) { if (!signal.aborted) status.textContent = `${errorMessage(error)}；可重新加载后重试` }
      finally {
        busy = false
        dialog.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input').forEach(el => { el.disabled = false })
        add.disabled = !store.ready
      }
    }
    const render = () => {
      list.replaceChildren()
      for (const group of store.groups) {
        const row = document.createElement('div')
        row.className = 'book-group-row'
        const name = document.createElement('input')
        name.value = group.name; name.setAttribute('aria-label', `分组名称：${group.name}`)
        const rename = document.createElement('button'), remove = document.createElement('button')
        rename.textContent = '改名'; remove.textContent = '删除'
        rename.type = remove.type = 'button'
        rename.onclick = () => { void run(() => store.rename(group.id, name.value, signal)) }
        let confirming = false
        remove.onclick = () => {
          if (!confirming) {
            confirming = true; remove.textContent = '确认删除'
            status.textContent = `删除“${group.name}”后，组内书籍会回到未分组，不会删除文件。再次点击确认删除。`
          } else void run(() => store.remove(group.id, signal))
        }
        row.append(name, rename, remove); list.append(row)
      }
      add.disabled = !store.ready
      if (!store.ready) status.textContent = '分组读取失败，请重新加载'
    }
    add.onclick = () => { void run(() => store.create(input.value, signal), () => { input.value = '' }) }
    input.onkeydown = event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); add.click() } }
    reload.onclick = () => { void run(() => store.load(signal)) }
    close.onclick = () => { cleanup(); resolve() }
    render(); input.focus()
  })
}
