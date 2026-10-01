import { expect, it, vi } from 'vitest'
import { BodySearch, matches } from './search'
import type { ReaderView } from './view'
it('字面量搜索不执行输入正则，保留中文、表情和大小写匹配位置', () => {
  expect(matches('测试😀 a+b A+B', 'a+b').map(item => item.offset)).toEqual([5, 9])
  expect(matches('x'.repeat(1000), 'x')).toHaveLength(100)
  expect(matches('正常', '')).toEqual([])
})
it('取消搜索后迟到的结果不写入新页面，恶意摘录按纯文本展示', async () => {
  const root = document.createElement('div')
  root.innerHTML = '<form><input value="词"/><button type="button" data-search-run>搜索</button><button data-search-stop></button></form><p role="status"></p><div data-search-results></div>'
  let finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  const view = { async *search() { await pending; yield { label: '<img onerror=alert(1)>', excerpt: '<script>1</script>', location: { format: 'txt', index: 0 }, length: 1 } } } as unknown as ReaderView
  const ui = new BodySearch(root, () => view, async fn => fn(), vi.fn())
  root.querySelector<HTMLButtonElement>('[data-search-run]')!.click(); ui.stop(); finish()
  await new Promise(resolve => setTimeout(resolve, 0)); expect(root.querySelector('[data-search-results]')!.childElementCount).toBe(0)
  root.querySelector<HTMLButtonElement>('[data-search-run]')!.click()
  await vi.waitFor(() => expect(root.querySelector('[data-search-results]')!.childElementCount).toBe(1))
  expect(root.querySelector('img,script')).toBeNull(); ui.stop()
})
