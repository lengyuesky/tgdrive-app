/** EPUB 只保留受控重排内容，所有资源由归档按需提供。 */
import DOMPurify from 'dompurify'
import { Archive, archivePath, relativeResource } from '../reader/archive'
import { FlowReader } from '../reader/flow'
import { LIMITS, RangeFile } from '../reader/io'
import { PictureWindow } from '../reader/pictures'
import type { ViewContext, Section, NavigationItem } from '../reader/view'
import type { Location } from '../reader/state'
const elements = (root: Document | Element, name: string) => [...root.getElementsByTagNameNS('*', name)]
export function xml(text: string): Document {
  if (/<!ENTITY|<!DOCTYPE[^>]*\[/i.test(text)) throw new Error('不支持包含实体定义的图书 XML')
  const document = new DOMParser().parseFromString(text, 'application/xml')
  if (elements(document, 'parsererror').length || document.getElementsByTagName('*').length > 20000) throw new Error('图书 XML 损坏或结构过大')
  return document
}
const allowedTags = ['body','div','section','article','p','h1','h2','h3','h4','h5','h6','span','br','hr','em','strong','b','i','u','s','sub','sup','blockquote','pre','code','ul','ol','li','dl','dt','dd','table','thead','tbody','tr','td','th','caption','figure','figcaption','img','a']
export function cleanChapter(text: string, path: string): DocumentFragment {
  const document = xml(text)
  const body = elements(document, 'body')[0] ?? document.documentElement
  // 在 XML 惰性文档中移除所有可发起请求的属性，之后才交给 HTML 清洗器。
  for (const element of [body, ...body.getElementsByTagName('*')]) {
    const src = element.localName === 'img' ? element.getAttribute('src') : null
    const href = element.localName === 'a' ? element.getAttribute('href') : null
    const id = element.getAttribute('id'), alt = element.getAttribute('alt')
    const colspan = element.getAttribute('colspan'), rowspan = element.getAttribute('rowspan')
    for (const attr of [...element.attributes]) element.removeAttributeNode(attr)
    if (id && id.length <= 1024) element.setAttribute('id', `book-${id}`)
    if (alt) element.setAttribute('alt', alt.slice(0, 500))
    if (colspan && /^[1-9]\d?$/.test(colspan)) element.setAttribute('colspan', colspan)
    if (rowspan && /^[1-9]\d?$/.test(rowspan)) element.setAttribute('rowspan', rowspan)
    try {
      if (src) element.setAttribute('data-resource', relativeResource(path, src).path)
      if (href) { const target = relativeResource(path, href); element.setAttribute('data-link', `${target.path}#${target.hash}`); element.setAttribute('role', 'link'); element.setAttribute('tabindex', '0') }
    } catch { if (src) element.setAttribute('alt', '外部图片已禁用') }
  }
  return DOMPurify.sanitize(body, { RETURN_DOM_FRAGMENT: true, ALLOWED_TAGS: allowedTags, ALLOWED_ATTR: ['id','alt','colspan','rowspan','data-resource','data-link','role','tabindex'], ALLOW_DATA_ATTR: false })
}
interface EpubSection extends Section { path: string; hash: string }
interface EpubNavigation extends EpubSection { depth: number }
const ancestorCount = (element: Element, scope: Element, name: string) => {
  let count = 0
  for (let parent = element.parentElement; parent && parent !== scope; parent = parent.parentElement) if (parent.localName === name) count++
  return count
}
export class EpubReader extends FlowReader {
  readonly format = 'epub'
  author = ''
  navigation: NavigationItem[] = []
  private archive: Archive
  private chapters: EpubSection[] = []
  private pictures?: PictureWindow
  constructor(context: ViewContext) {
    super(context)
    this.archive = new Archive(new RangeFile(context.drive, context.file, context.signal, LIMITS.epub))
    this.article.addEventListener('click', this.link)
    this.article.addEventListener('keydown', this.linkKey)
  }
  protected async prepare() {
    await this.archive.open()
    const container = xml(await this.archive.text('META-INF/container.xml'))
    const root = elements(container, 'rootfile')[0]?.getAttribute('full-path')
    if (!root) throw new Error('EPUB 缺少内容清单')
    const packagePath = archivePath(decodeURIComponent(root)), packageDoc = xml(await this.archive.text(packagePath))
    this.title = elements(packageDoc, 'title')[0]?.textContent?.trim().slice(0, 160) || this.context.file.name
    this.author = [...new Set(elements(packageDoc, 'creator').map((item) => item.textContent?.trim()).filter(Boolean))].slice(0, 8).join('、').slice(0, 160)
    if (elements(packageDoc, 'meta').some((meta) => meta.getAttribute('property') === 'rendition:layout' && meta.textContent?.trim() === 'pre-paginated')) throw new Error('首版不支持固定版式 EPUB，请使用 PDF 版本')
    if (this.archive.entries.has('META-INF/encryption.xml')) {
      const encryption = xml(await this.archive.text('META-INF/encryption.xml'))
      const inside = (uri: string) => { try { return this.archive.entries.has(archivePath(decodeURIComponent(uri))) } catch { return false } }
      for (const data of elements(encryption, 'EncryptedData')) {
        const algorithm = elements(data, 'EncryptionMethod')[0]?.getAttribute('Algorithm')
        const references = elements(data, 'CipherReference').map((item) => item.getAttribute('URI') ?? '')
        if (['http://www.idpf.org/2008/embedding','http://ns.adobe.com/pdf/enc#RC'].includes(algorithm ?? '') && /\.(ttf|otf|woff2?)$/i.test(references[0] ?? '')) continue
        // 声明加密但包内并不存在所指条目时，是剥离重打包后残留的无效标记（多见于自多看等 DRM 平台流出的书源），正文并未加密，忽略即可。
        if (!references.some((uri) => inside(uri))) continue
        throw new Error('不支持 DRM 或加密 EPUB 内容')
      }
    }
    const items = new Map(elements(packageDoc, 'item').map((item) => [item.getAttribute('id'), item]))
    const paths: string[] = []
    for (const item of elements(packageDoc, 'itemref')) {
      const target = items.get(item.getAttribute('idref'))
      if (!target) throw new Error('EPUB 章节清单不完整')
      if ((item.getAttribute('properties') ?? '').includes('layout-pre-paginated')) throw new Error('不支持固定版式 EPUB 章节')
      paths.push(relativeResource(packagePath, target.getAttribute('href') ?? '').path)
    }
    if (!paths.length || paths.length > 10000) throw new Error('EPUB 章节为空或过多')
    const navigation: EpubNavigation[] = []
    const nav = [...items.values()].find((item) => (item.getAttribute('properties') ?? '').split(/\s+/).includes('nav'))
    const ncx = items.get(elements(packageDoc, 'spine')[0]?.getAttribute('toc') ?? '')
    if (nav || ncx) {
      const navPath = relativeResource(packagePath, (nav ?? ncx)!.getAttribute('href') ?? '').path
      const navDoc = xml(await this.archive.text(navPath))
      if (nav) {
        const scope = elements(navDoc, 'nav').find((node) => node.getAttributeNS('http://www.idpf.org/2007/ops', 'type')?.split(/\s+/).includes('toc')) ?? navDoc.documentElement
        const spine = new Set(paths), targets = new Map<Element, ReturnType<typeof relativeResource>>()
        for (const link of elements(scope, 'a')) {
          try {
            const target = relativeResource(navPath, link.getAttribute('href') ?? '')
            if (spine.has(target.path)) targets.set(link, target)
          } catch { /* 外部目录链接不可打开。 */ }
        }
        for (const node of scope.getElementsByTagName('*')) {
          let target = targets.get(node), label = node.textContent?.trim().slice(0, 120), depth = Math.max(0, ancestorCount(node, scope, 'li') - 1)
          if (node.localName === 'li') {
            const heading = [...node.children].find(child => child.localName === 'span')
            const links = elements(node, 'a')
            if (!heading || links.some(link => link.closest('li') === node && targets.has(link))) continue
            // 无链接组标题借首个有效子目标；空组不伪造书首，展开动作由界面独立处理。
            target = links.map(link => targets.get(link)).find(Boolean)
            label = heading.textContent?.trim().slice(0, 120); depth = ancestorCount(node, scope, 'li')
            if (!label) continue
          } else if (node.localName !== 'a') continue
          if (target) navigation.push({ ...target, label: label || '章节', entry: `${target.path}#${target.hash}`, depth })
        }
      } else for (const point of elements(navDoc, 'navPoint')) {
        const content = [...point.children].find(child => child.localName === 'content')
        const label = [...point.children].find(child => child.localName === 'navLabel')
        if (!content) continue
        try {
          const target = relativeResource(navPath, content.getAttribute('src') ?? '')
          navigation.push({ ...target, label: label?.textContent?.trim().slice(0, 120) || '章节', entry: `${target.path}#${target.hash}`, depth: ancestorCount(point, navDoc.documentElement, 'navPoint') })
        } catch { /* 非法目录项不进入导航。 */ }
      }
    }
    // spine 是阅读顺序，目录 hash 只是跳转目标；同一 XHTML 不能重复计为整章。
    this.chapters = [...new Set(paths)].map((path) => ({ path, hash: '', entry: `${path}#`, label: navigation.find((item) => item.path === path)?.label ?? path.split('/').pop() ?? '章节' }))
    if (navigation.length > 10000) throw new Error('EPUB 导航条目超过 10000')
    this.navigation = navigation.flatMap((item) => {
      const index = this.chapters.findIndex((chapter) => chapter.path === item.path)
      return index < 0 ? [] : [{ label: item.label, depth: item.depth, location: { format: 'epub' as const, index, entry: item.entry } }]
    })
    this.sections = this.chapters
  }
  protected async content(index: number, signal: AbortSignal) {
    this.pictures?.destroy()
    const section = this.chapters[index]!
    return cleanChapter(await this.archive.text(section.path, signal), section.path)
  }
  protected afterContent(signal: AbortSignal) {
    this.pictures?.destroy()
    this.pictures = new PictureWindow(this.scroller, this.article, signal,
      (image, current) => this.archive.read(image.dataset.resource!, LIMITS.entry, current), (error) => this.report(error), (mutate) => this.layout(mutate))
  }
  protected afterLayout() { this.pictures?.update(this.article) }
  protected indexFor(location: Location) {
    const path = location.entry?.split('#', 2)[0]
    const index = path ? this.chapters.findIndex((item) => item.path === path) : -1
    return index >= 0 ? index : super.indexFor(location)
  }
  protected async reposition(location: Location) {
    const hash = location.entry?.split('#', 2)[1]
    if (location.offset === undefined && hash) {
      const target = [...this.article.querySelectorAll('[id]')].find((item) => item.id === `book-${hash}`)
      if (target) { this.reveal(target); return }
    }
    await super.reposition(location)
  }
  private link = (event: Event) => {
    const link = (event.target as Element).closest<HTMLElement>('[data-link]')
    if (!link) return
    event.preventDefault()
    const [path, hash = ''] = link.dataset.link!.split('#', 2)
    const selected = this.chapters.findIndex((item) => item.path === path)
    if (selected < 0) { this.report(new Error('此链接不指向可阅读章节')); return }
    const work = () => this.restore({ format: 'epub', index: selected, entry: `${path}#${hash}` })
    void (this.context.navigate ? this.context.navigate(work) : work()).catch((error) => this.report(error))
  }
  private linkKey = (event: KeyboardEvent) => { if (event.key === 'Enter') this.link(event) }
  destroy() { super.destroy(); this.pictures?.destroy(); this.archive.destroy(); this.article.removeEventListener('click', this.link); this.article.removeEventListener('keydown', this.linkKey) }
}
