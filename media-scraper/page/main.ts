import './style.css'
import { createPageApp } from '@tgdrive/page-sdk'
import { ScraperPage } from './controller'
import { ScraperView } from './view'

try {
  const app = createPageApp(), mobile = window.matchMedia('(max-width:700px), (pointer:coarse)')
  let view: ScraperView
  const page = new ScraperPage(app.host, app.ui, app.context, () => view?.render())
  view = new ScraperView(page, () => app.ui.close())
  document.documentElement.dataset.theme = app.context.theme
  const immersive = (active = mobile.matches, signal?: AbortSignal) => app.ui.setImmersive({ active, background: document.documentElement.dataset.theme === 'dark' ? '#000000' : '#f2f2f7' }, { signal })
  const theme = app.ui.onNotice(notice => {
    if (notice.event === 'ui.theme_changed') { document.documentElement.dataset.theme = notice.data.theme; void immersive().catch(error => page.fail(error)) }
  })
  const resize = () => { if (!page.closed) void immersive().catch(error => page.fail(error)) }
  mobile.addEventListener('change', resize)
  const dispose = () => { page.dispose(); view.dispose(); theme(); mobile.removeEventListener('change', resize) }
  // 没有页面侧业务数据要保存。关闭只结束观察，后台任务不因此停止。
  app.ui.beforeClose(async signal => { dispose(); await immersive(false, signal).catch(() => {}) })
  window.addEventListener('pagehide', dispose, { once: true })
  const boot = async () => {
    const retry = document.getElementById('boot-retry') as HTMLButtonElement
    retry.disabled = true
    try {
      await page.initialize()
      await Promise.all([app.ui.setTitle({ title: '影视刮削' }), immersive()])
      view.render()
    } catch (error) {
      if (!page.closed) { document.getElementById('boot-status')!.textContent = error instanceof Error ? error.message : String(error); retry.hidden = false }
    } finally { retry.disabled = false }
  }
  document.getElementById('boot-retry')!.addEventListener('click', () => { void boot() })
  void boot()
} catch (error) {
  document.getElementById('boot-status')!.textContent = `无法打开影视刮削：${error instanceof Error ? error.message : String(error)}。请从应用中心重新打开。`
}
