/** 正文搜索只保留至多 100 项结果；所有摘录以文本输出。 */
import type { ReaderView, SearchMatch } from './view'
export function matches(text: string, query: string, limit = 100) {
  const needle = query.trim()
  if (!needle || needle.length > 100) return []
  const pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
  const result: { offset: number; length: number; excerpt: string }[] = []
  for (const match of text.matchAll(pattern)) {
    result.push({ offset: match.index!, length: match[0].length, excerpt: text.slice(Math.max(0, match.index! - 35), match.index! + match[0].length + 65).replace(/\s+/g, ' ') })
    if (result.length >= limit) break
  }
  return result
}
export function highlight(root: HTMLElement, offset: number, length: number) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), range = document.createRange()
  let at = 0, started = false
  while (walker.nextNode()) {
    const node = walker.currentNode as Text, end = at + node.length
    if (!started && end > offset) { range.setStart(node, Math.max(0, offset - at)); started = true }
    if (started && end >= offset + length) {
      range.setEnd(node, Math.max(0, offset + length - at))
      const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range)
      return
    }
    at = end
  }
}
export class BodySearch {
  private controller = new AbortController()
  private generation = 0
  private root: HTMLElement
  constructor(root: HTMLElement, private view: () => ReaderView | undefined, private navigate: (work: () => Promise<void>) => Promise<void>, private close: () => void) {
    this.root = root
    root.querySelector('[data-search-run]')!.addEventListener('click', () => { void this.run() })
    root.querySelector('input')!.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void this.run() } })
    root.querySelector('[data-search-stop]')!.addEventListener('click', () => this.stop())
  }
  stop() { this.controller.abort(); this.generation++; this.root.querySelector<HTMLElement>('[data-search-stop]')!.hidden = true }
  update() { this.stop(); this.root.hidden = !this.view()?.search; this.root.querySelector('[data-search-results]')!.replaceChildren(); this.status('') }
  private status(message: string) { this.root.querySelector('[role="status"]')!.textContent = message }
  private async run() {
    this.stop(); this.controller = new AbortController()
    const signal = this.controller.signal, generation = this.generation, view = this.view(), query = this.root.querySelector('input')!.value.trim()
    const results = this.root.querySelector<HTMLElement>('[data-search-results]')!
    results.replaceChildren()
    if (!view?.search || !query) { this.status('请输入搜索内容'); return }
    this.status('正在搜索正文…'); this.root.querySelector<HTMLElement>('[data-search-stop]')!.hidden = false
    let count = 0
    try {
      for await (const match of view.search(query, signal)) {
        signal.throwIfAborted()
        if (view !== this.view()) return
        const button = document.createElement('button'), label = document.createElement('strong'), excerpt = document.createElement('span')
        button.type = 'button'; label.textContent = match.label; excerpt.textContent = match.excerpt
        button.append(label, excerpt)
        button.onclick = () => {
          if (view !== this.view()) return
          this.close()
          void this.navigate(async () => { await view.restore(match.location); if (view === this.view()) view.highlight?.(match) }).catch(error => this.status(String(error)))
        }
        results.append(button); count++
        this.status('已找到 ' + count + ' 项，继续搜索…')
        if (count >= 100) break
      }
      if (!signal.aborted) this.status(count === 100 ? '已显示前 100 项，请缩小搜索范围' : count ? '共找到 ' + count + ' 项' : '未找到匹配文字；扫描版 PDF 可能没有文字层')
    } catch (error) { if (!signal.aborted) this.status('搜索失败，可重试：' + (error instanceof Error ? error.message : String(error))) }
    finally { if (generation === this.generation) this.root.querySelector<HTMLElement>('[data-search-stop]')!.hidden = true }
  }
}
