import { createPageApp } from '@tgdrive/page-sdk'
import { choose, files } from './business.js'
import './style.css'

const app = createPageApp()
const list = document.querySelector<HTMLUListElement>('#files')!
const output = document.querySelector<HTMLElement>('#output')!
const next = document.querySelector<HTMLButtonElement>('#next')!
let cursor: string | null = null
async function load() {
  const page = await files(app.host, cursor ?? undefined)
  cursor = page.next_cursor
  for (const file of page.items) {
    const item = document.createElement('li'), button = document.createElement('button')
    button.textContent = file.name
    button.onclick = () => { void choose(app.host, file).then(bytes => { output.textContent = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join(' ') || '零字节文件' }).catch(showError) }
    item.append(button); list.append(item)
  }
  next.hidden = !cursor
}
function showError(error: unknown) { output.textContent = error instanceof Error ? error.message : '请求未能完成' }
document.querySelector<HTMLButtonElement>('#authorize')!.onclick = () => {
  void app.ui.requestScope({ reason: '列出所选目录内的文件', preferred_access: 'read_only' }).then(scope => { if (scope) { list.replaceChildren(); cursor = null; return load() } }).catch(showError)
}
next.onclick = () => { void load().catch(showError) }
app.ui.onNotice(notice => { if (notice.event === 'ui.theme_changed') document.documentElement.dataset.theme = notice.data.theme })
document.documentElement.dataset.theme = app.context.theme
void app.ui.setTitle({ title: app.context.app.name }).catch(showError)
void load().catch(showError)
