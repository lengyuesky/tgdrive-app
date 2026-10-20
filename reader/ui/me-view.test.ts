import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReadingLibrary } from '../library'
import { deferred, file, memoryDrive, sources } from '../library/test-fixtures'
import { MeView } from './me-view'
import type { UiContext } from './types'

const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).reverse().forEach(cleanup => cleanup())
  document.body.replaceChildren()
})

async function setup() {
  document.body.innerHTML = '<div id="modal-container"></div><div id="test"></div>'
  const root = file(1, '/书', true), other = file(2, '/漫画', true)
  const mock = memoryDrive([root, other, file(10, '/书/文字.txt'), file(20, '/漫画/漫画.cbz')])
  mock.seed('library:sources', sources(root).config)
  const library = new ReadingLibrary(mock.drive, 'all')
  await library.initialize(); await library.refresh()
  const context = {
    drive: mock.drive, library, kind: 'all', signal: new AbortController().signal,
    openReader: vi.fn(), openDetail: vi.fn(), switchView: vi.fn(), reportError: vi.fn(), createReader: vi.fn(), closeApp: vi.fn(),
  } satisfies UiContext
  const container = document.getElementById('test')!, view = new MeView(container, context)
  cleanups.push(() => library.destroy(), () => view.destroy())
  await view.render('sources')
  return { ...mock, library, context, container, view,
    input: container.querySelector<HTMLInputElement>('#input-source-path')!,
    submit: container.querySelector<HTMLButtonElement>('#btn-submit-source')!,
  }
}

describe('沙箱内显式添加来源', () => {
  it('普通按钮不依赖原生表单提交，真实添加来源且在途不重复保存', async () => {
    const x = await setup(), original = x.library.addSource.bind(x.library), pending = deferred(), started = deferred()
    const add = vi.spyOn(x.library, 'addSource').mockImplementation(async (...args) => {
      started.resolve(); await pending.promise; return original(...args)
    })
    expect(x.submit.type).toBe('button')
    const requestSubmit = vi.spyOn(HTMLFormElement.prototype, 'requestSubmit')
    x.input.value = '/漫画'; x.submit.click(); await started.promise
    expect(x.submit.disabled).toBe(true)
    x.submit.click()
    x.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(add).toHaveBeenCalledOnce()
    pending.resolve()
    await vi.waitFor(() => expect(x.container.querySelectorAll('.source-item-path')).toHaveLength(2))
    expect(x.library.snapshot.sources.config.sources.map(source => source.path)).toEqual(['/书', '/漫画'])
    expect(requestSubmit).not.toHaveBeenCalled()
  })

  it('路径输入回车阻止原生提交，仍通过同一 JS 流程添加', async () => {
    const x = await setup()
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    x.input.value = '/漫画'; x.input.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(x.container.querySelectorAll('.source-item-path')).toHaveLength(2))
  })

  it('授权目录选择完成后直接添加，不调用沙箱禁用的 requestSubmit', async () => {
    const x = await setup()
    const requestSubmit = vi.spyOn(HTMLFormElement.prototype, 'requestSubmit')
    x.drive.can = capability => capability === 'ui.authorizeDirectory'
    x.drive.ui = { ...x.drive.ui, authorizeDirectory: vi.fn(async () => '/漫画') }
    await x.view.render('sources')
    x.container.querySelector<HTMLButtonElement>('#btn-choose-source')!.click()
    await vi.waitFor(() => expect(x.container.querySelectorAll('.source-item-path')).toHaveLength(2))
    expect(x.drive.ui.authorizeDirectory).toHaveBeenCalled()
    expect(requestSubmit).not.toHaveBeenCalled()
  })
})
