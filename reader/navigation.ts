/** 统一阅读目录与导航组件：层级折叠、文本筛选、快捷跳转与可见缩略图有界调度。 */
import type { Location } from './state'
import type { NavigationItem, ReaderThumbnail, ReaderView } from './view'

export interface NavigationOptions {
  root: HTMLElement
  view: () => ReaderView | undefined
  navigate: (work: () => Promise<void>) => Promise<void>
  closePanel: () => void
  report: (error: unknown) => void
  onJump?: () => void
}

interface TreeItemRecord {
  index: number
  item: NavigationItem
  depth: number
  parentIndex: number
  hasChildren: boolean
  collapsed: boolean
  el: HTMLElement
  btn: HTMLButtonElement
  chevron?: HTMLButtonElement
  thumbBox?: HTMLElement
  thumbImg?: HTMLImageElement
  thumbState: 'none' | 'pending' | 'loading' | 'loaded'
  thumbRelease?: () => void
  thumbAbort?: AbortController
}

export class ReaderNavigation {
  private treeEl: HTMLElement | null
  private filterInput: HTMLInputElement | null
  private selectEl: HTMLSelectElement | null
  private jumpInput: HTMLInputElement | null
  private jumpButton: HTMLButtonElement | null

  private records: TreeItemRecord[] = []
  private queue: number[] = []
  private activeRequests = new Set<AbortController>()
  private readonly MAX_CONCURRENT = 2
  private panelOpen = false
  private observer?: IntersectionObserver
  private observerGeneration = 0
  private disposed = false
  private removers: (() => void)[] = []

  get activeCount(): number {
    return this.activeRequests.size
  }

  constructor(private options: NavigationOptions) {
    this.treeEl = options.root.querySelector<HTMLElement>('#toc-tree')
    this.filterInput = options.root.querySelector<HTMLInputElement>('#toc-filter')
    this.selectEl = options.root.querySelector<HTMLSelectElement>('#toc')
    this.jumpInput = options.root.querySelector<HTMLInputElement>('#jump')
    this.jumpButton = options.root.querySelector<HTMLButtonElement>('#jump-button')

    if (this.filterInput) {
      const filterHandler = () => this.updateVisibility()
      this.filterInput.addEventListener('input', filterHandler)
      this.removers.push(() => this.filterInput?.removeEventListener('input', filterHandler))
    }

    if (this.selectEl) {
      const selectHandler = () => {
        const val = this.selectEl?.value
        if (val === undefined || val === '') return
        const idx = parseInt(val, 10)
        const record = this.records[idx]
        if (record) {
          void this.options
            .navigate(() => this.options.view()!.restore(record.item.location))
            .then(() => this.options.closePanel())
            .catch(this.options.report)
        }
      }
      this.selectEl.addEventListener('change', selectHandler)
      this.removers.push(() => this.selectEl?.removeEventListener('change', selectHandler))
    }

    if (this.jumpButton) {
      const jumpHandler = () => {
        if (!this.jumpInput) return
        const target = parseInt(this.jumpInput.value, 10) - 1
        if (Number.isFinite(target) && target >= 0) {
          // 有效手动跳转提交时通知调用者复位脏标记
          this.options.onJump?.()
          void this.options
            .navigate(() => this.options.view()!.go(target))
            .then(() => this.options.closePanel())
            .catch(this.options.report)
        }
      }
      this.jumpButton.addEventListener('click', jumpHandler)
      this.removers.push(() => this.jumpButton?.removeEventListener('click', jumpHandler))
    }
  }

  update(currentView?: ReaderView) {
    this.cleanupThumbnails()
    const view = currentView ?? this.options.view()
    this.records = []
    this.queue = []
    // 切换图书时不重置 activeRequests：旧请求仍在途占用槽位，直到其 promise 结算幂等释放

    if (this.selectEl) this.selectEl.replaceChildren()
    if (this.treeEl) this.treeEl.replaceChildren()
    if (this.filterInput) this.filterInput.value = ''

    if (!view) return

    const format = view.current().format
    const entries: NavigationItem[] = view.navigation?.length
      ? view.navigation
      : view.sections.map((section, index) => ({
          label: section.label,
          location: { format, index, entry: section.entry },
          depth: 0,
        }))

    if (this.selectEl) {
      entries.forEach((item, index) => {
        const option = document.createElement('option')
        option.value = String(index)
        option.textContent = item.label
        this.selectEl!.append(option)
      })
    }

    if (this.treeEl) {
      const hasThumbs = !!(view.capabilities?.thumbnails && typeof view.thumbnail === 'function')

      entries.forEach((item, index) => {
        const depth = item.depth ?? 0
        const nextDepth = entries[index + 1]?.depth ?? 0
        const hasChildren = nextDepth > depth

        let parentIndex = -1
        for (let p = index - 1; p >= 0; p--) {
          if ((entries[p].depth ?? 0) < depth) {
            parentIndex = p
            break
          }
        }

        const row = document.createElement('div')
        row.className = 'toc-item-row'
        row.setAttribute('role', 'treeitem')
        row.dataset.index = String(index)
        row.style.paddingLeft = `${depth * 16 + 8}px`

        let chevron: HTMLButtonElement | undefined
        if (hasChildren) {
          chevron = document.createElement('button')
          chevron.type = 'button'
          chevron.className = 'toc-fold-toggle'
          chevron.setAttribute('aria-label', '折叠子章节')
          chevron.setAttribute('aria-expanded', 'true')
          chevron.textContent = '▾'
          chevron.addEventListener('click', (e) => {
            e.stopPropagation()
            this.toggleFold(index)
          })
          row.append(chevron)
        } else {
          const spacer = document.createElement('span')
          spacer.className = 'toc-spacer'
          row.append(spacer)
        }

        let thumbBox: HTMLElement | undefined
        let thumbImg: HTMLImageElement | undefined
        if (hasThumbs) {
          thumbBox = document.createElement('span')
          thumbBox.className = 'toc-thumbnail-box'
          thumbImg = document.createElement('img')
          thumbImg.className = 'toc-thumbnail-img'
          thumbImg.alt = ''
          thumbBox.append(thumbImg)
          row.append(thumbBox)
        }

        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'toc-item-btn'
        btn.setAttribute('title', item.label)
        const labelSpan = document.createElement('span')
        labelSpan.className = 'toc-item-label'
        labelSpan.textContent = item.label
        btn.append(labelSpan)

        btn.addEventListener('click', () => {
          void this.options
            .navigate(() => this.options.view()!.restore(item.location))
            .then(() => this.options.closePanel())
            .catch(this.options.report)
        })
        row.append(btn)

        this.treeEl!.append(row)

        this.records.push({
          index,
          item,
          depth,
          parentIndex,
          hasChildren,
          collapsed: false,
          el: row,
          btn,
          chevron,
          thumbBox,
          thumbImg,
          thumbState: 'none',
        })
      })
    }

    if (this.panelOpen) {
      this.attachObserver()
    }
  }

  private toggleFold(index: number) {
    const record = this.records[index]
    if (!record || !record.hasChildren) return
    record.collapsed = !record.collapsed
    if (record.chevron) {
      record.chevron.textContent = record.collapsed ? '▸' : '▾'
      record.chevron.setAttribute('aria-expanded', String(!record.collapsed))
      record.chevron.setAttribute('aria-label', record.collapsed ? '展开子章节' : '折叠子章节')
    }
    this.updateVisibility()
  }

  private isAncestorCollapsed(index: number): boolean {
    let curr = this.records[index].parentIndex
    while (curr !== -1) {
      if (this.records[curr].collapsed) return true
      curr = this.records[curr].parentIndex
    }
    return false
  }

  private updateVisibility() {
    const query = this.filterInput?.value.trim().toLowerCase() ?? ''
    for (let i = 0; i < this.records.length; i++) {
      const record = this.records[i]
      let shouldHide: boolean
      if (query) {
        shouldHide = !record.item.label.toLowerCase().includes(query)
      } else {
        shouldHide = this.isAncestorCollapsed(i)
      }
      this.setRowHidden(record, shouldHide)
    }
  }

  private setRowHidden(record: TreeItemRecord, hidden: boolean) {
    if (record.el.hidden === hidden) return
    record.el.hidden = hidden
    if (hidden) {
      this.cancelAndReleaseThumbnail(record)
      this.observer?.unobserve(record.el)
    } else {
      if (this.panelOpen && this.observer) {
        this.observer.observe(record.el)
      }
    }
  }

  syncLocation(location: Location) {
    if (this.selectEl) {
      const matching = this.records.find((r) => r.item.location.index === location.index)
      if (matching) {
        this.selectEl.value = String(matching.index)
      }
    }
    this.records.forEach((r) => {
      const isCurrent = r.item.location.index === location.index
      r.el.classList.toggle('is-current', isCurrent)
      if (isCurrent) {
        r.btn.setAttribute('aria-current', 'location')
      } else {
        r.btn.removeAttribute('aria-current')
      }
    })
  }

  onPanelChange(open: boolean) {
    if (this.disposed) return
    this.panelOpen = open
    if (open) {
      this.attachObserver()
    } else {
      this.cleanupThumbnails()
    }
  }

  private attachObserver() {
    this.observer?.disconnect()
    this.observer = undefined
    if (typeof IntersectionObserver === 'undefined' || !this.treeEl) return

    const view = this.options.view()
    if (!view?.capabilities?.thumbnails || typeof view.thumbnail !== 'function') return

    const currentGeneration = ++this.observerGeneration
    const observer = new IntersectionObserver(
      (entries, obs) => {
        // 过时或已断开的 Observer 回调直接丢弃，不调度当前视图
        if (
          this.disposed ||
          !this.panelOpen ||
          obs !== this.observer ||
          currentGeneration !== this.observerGeneration
        ) {
          return
        }
        for (const entry of entries) {
          const indexStr = (entry.target as HTMLElement).dataset.index
          if (indexStr === undefined) continue
          const index = parseInt(indexStr, 10)
          const record = this.records[index]
          // 严格核对 record 及其对应的真实 DOM 节点，避免旧 DOM index 误调度新书条目
          if (!record || record.el !== entry.target) continue

          if (entry.isIntersecting && !record.el.hidden) {
            if (record.thumbState === 'none') {
              record.thumbState = 'pending'
              this.queue.push(index)
              this.schedule()
            }
          } else {
            if (record.thumbState === 'pending') {
              const qIdx = this.queue.indexOf(index)
              if (qIdx !== -1) this.queue.splice(qIdx, 1)
              record.thumbState = 'none'
            } else if (record.thumbState === 'loading') {
              if (record.thumbAbort) {
                record.thumbAbort.abort()
                record.thumbAbort = undefined
              }
              record.thumbState = 'none'
            } else if (record.thumbState === 'loaded') {
              this.cancelAndReleaseThumbnail(record)
            }
          }
        }
      },
      { root: this.treeEl, threshold: 0.01 }
    )
    this.observer = observer

    for (const record of this.records) {
      if (!record.el.hidden) {
        this.observer.observe(record.el)
      }
    }
  }

  private schedule() {
    if (!this.panelOpen || this.disposed) return
    const view = this.options.view()
    if (!view || !view.capabilities?.thumbnails || typeof view.thumbnail !== 'function') return

    while (this.activeRequests.size < this.MAX_CONCURRENT && this.queue.length > 0) {
      const index = this.queue.shift()!
      const record = this.records[index]
      if (!record || record.el.hidden || record.thumbState !== 'pending') {
        continue
      }

      const controller = new AbortController()
      record.thumbAbort = controller
      record.thumbState = 'loading'
      this.activeRequests.add(controller)

      const physicalIndex = record.item.location.index
      view
        .thumbnail(physicalIndex, controller.signal)
        .then((thumb) => {
          if (
            controller.signal.aborted ||
            record.thumbAbort !== controller ||
            record.thumbState !== 'loading' ||
            !this.panelOpen ||
            record.el.hidden ||
            this.disposed
          ) {
            try {
              thumb.release()
            } catch {}
            return
          }

          let released = false
          record.thumbRelease = () => {
            if (!released) {
              released = true
              try {
                thumb.release()
              } catch {}
            }
          }
          record.thumbState = 'loaded'
          if (record.thumbImg) {
            record.thumbImg.src = thumb.url
          }
        })
        .catch(() => {
          // 优雅忽略失败
        })
        .finally(() => {
          // 无论成功失败或中止，由各请求自身的 finally 幂等归还槽位
          this.activeRequests.delete(controller)
          // 仅当此请求仍然持有该记录时才修改记录状态，避免旧请求 finally 将同记录新请求的 loading 误重置为 none
          if (record.thumbAbort === controller) {
            record.thumbAbort = undefined
            if (record.thumbState === 'loading') {
              record.thumbState = 'none'
            }
          }
          this.schedule()
        })
    }
  }

  private cancelAndReleaseThumbnail(record: TreeItemRecord) {
    const queueIdx = this.queue.indexOf(record.index)
    if (queueIdx !== -1) {
      this.queue.splice(queueIdx, 1)
    }
    if (record.thumbAbort) {
      record.thumbAbort.abort()
      record.thumbAbort = undefined
    }
    if (record.thumbRelease) {
      try {
        record.thumbRelease()
      } catch {}
      record.thumbRelease = undefined
    }
    if (record.thumbImg) {
      record.thumbImg.removeAttribute('src')
    }
    record.thumbState = 'none'
  }

  private cleanupThumbnails() {
    this.observerGeneration++
    this.observer?.disconnect()
    this.observer = undefined
    this.queue = []
    for (const record of this.records) {
      this.cancelAndReleaseThumbnail(record)
    }
    // 注意：不得将 activeRequests 清空；在途请求中止后仍占槽，直至底层 promise 结算并自然归还
  }

  destroy() {
    this.disposed = true
    this.cleanupThumbnails()
    this.removers.forEach((remove) => remove())
    this.removers = []
    this.records = []
  }
}
