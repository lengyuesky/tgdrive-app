/** 弹窗辅助组件：确认框、漫画人工归组（合并、拆分、重排、元数据修正）表单。
 * 遵循无障碍规范：焦点圈定 (Tab/Shift+Tab)、Escape 返回、aria-modal 与原焦点恢复。
 */
import type { BibliographicMetadata, Work, WorkMember, ReadingUnit } from '../library'

function createModal(options: {
  title: string
  wide?: boolean
  signal?: AbortSignal
  onCancel: () => void
}) {
  const container = document.getElementById('modal-container')!
  const previousActiveElement = document.activeElement as HTMLElement | null

  const overlay = document.createElement('div')
  overlay.className = 'modal-backdrop'

  const dialog = document.createElement('div')
  dialog.className = options.wide ? 'modal-dialog modal-dialog-wide' : 'modal-dialog'
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  const titleId = `modal-title-${Math.random().toString(36).slice(2, 8)}`
  dialog.setAttribute('aria-labelledby', titleId)

  const titleEl = document.createElement('h3')
  titleEl.className = 'modal-title'
  titleEl.id = titleId
  titleEl.textContent = options.title
  dialog.append(titleEl)

  let closed = false
  const cleanup = () => {
    if (closed) return
    closed = true
    document.removeEventListener('keydown', onKey)
    if (options.signal) {
      options.signal.removeEventListener('abort', onAbort)
    }
    overlay.remove()
    previousActiveElement?.focus()
  }

  const onAbort = () => {
    cleanup()
    options.onCancel()
  }

  if (options.signal) {
    if (options.signal.aborted) {
      options.onCancel()
      return { overlay: document.createElement('div'), dialog: document.createElement('div'), cleanup: () => {} }
    }
    options.signal.addEventListener('abort', onAbort, { once: true })
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      cleanup()
      options.onCancel()
      return
    }
    if (e.key === 'Tab') {
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el.offsetParent !== null || el.tabIndex >= 0)

      if (focusable.length === 0) {
        e.preventDefault()
        return
      }

      const first = focusable[0]
      const last = focusable[focusable.length - 1]

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  document.addEventListener('keydown', onKey)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      cleanup()
      options.onCancel()
    }
  })

  overlay.append(dialog)
  container.append(overlay)

  return { overlay, dialog, cleanup }
}

export function showConfirmModal(options: {
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
  signal?: AbortSignal
}): Promise<boolean> {
  return new Promise((resolve) => {
    const { dialog, cleanup } = createModal({
      title: options.title,
      signal: options.signal,
      onCancel: () => resolve(false),
    })

    const messageEl = document.createElement('p')
    messageEl.className = 'modal-message'
    messageEl.textContent = options.message

    const actions = document.createElement('div')
    actions.className = 'modal-actions'

    const cancelBtn = document.createElement('button')
    cancelBtn.type = 'button'
    cancelBtn.className = 'btn-secondary'
    cancelBtn.textContent = options.cancelText ?? '取消'

    const confirmBtn = document.createElement('button')
    confirmBtn.type = 'button'
    confirmBtn.className = options.danger ? 'btn-danger' : 'btn-primary'
    confirmBtn.textContent = options.confirmText ?? '确认'

    cancelBtn.addEventListener('click', () => {
      cleanup()
      resolve(false)
    })
    confirmBtn.addEventListener('click', () => {
      cleanup()
      resolve(true)
    })

    actions.append(cancelBtn, confirmBtn)
    dialog.append(messageEl, actions)
    confirmBtn.focus()
  })
}

export function showEditMetadataModal(
  current: BibliographicMetadata,
  signal?: AbortSignal
): Promise<BibliographicMetadata | null> {
  return new Promise((resolve) => {
    const { dialog, cleanup } = createModal({
      title: '修改作品信息',
      wide: true,
      signal,
      onCancel: () => resolve(null),
    })

    const form = document.createElement('form')
    form.className = 'modal-form'

    const titleLabel = document.createElement('label')
    titleLabel.textContent = '作品标题'
    const titleInput = document.createElement('input')
    titleInput.type = 'text'
    titleInput.value = current.title ?? ''
    titleInput.maxLength = 100
    titleLabel.append(titleInput)

    const seriesLabel = document.createElement('label')
    seriesLabel.textContent = '系列名称'
    const seriesInput = document.createElement('input')
    seriesInput.type = 'text'
    seriesInput.value = current.series ?? ''
    seriesInput.maxLength = 100
    seriesLabel.append(seriesInput)

    const authorLabel = document.createElement('label')
    authorLabel.textContent = '作者 / 画师'
    const authorInput = document.createElement('input')
    authorInput.type = 'text'
    authorInput.value = (current.authors ?? []).join(', ')
    authorInput.maxLength = 100
    authorLabel.append(authorInput)

    const descLabel = document.createElement('label')
    descLabel.textContent = '简介'
    const descInput = document.createElement('textarea')
    descInput.rows = 4
    descInput.value = current.description ?? ''
    descInput.maxLength = 1000
    descLabel.append(descInput)

    const actions = document.createElement('div')
    actions.className = 'modal-actions'

    const cancelBtn = document.createElement('button')
    cancelBtn.type = 'button'
    cancelBtn.className = 'btn-secondary'
    cancelBtn.textContent = '取消'

    const saveBtn = document.createElement('button')
    saveBtn.type = 'submit'
    saveBtn.className = 'btn-primary'
    saveBtn.textContent = '保存修改'

    cancelBtn.addEventListener('click', () => {
      cleanup()
      resolve(null)
    })
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      const title = titleInput.value.trim() || undefined
      const series = seriesInput.value.trim() || undefined
      const authors = authorInput.value
        .split(/[,，、]/)
        .map((s) => s.trim())
        .filter(Boolean)
      const description = descInput.value.trim() || undefined
      cleanup()
      resolve({
        title,
        series,
        authors: authors.length ? authors : undefined,
        description,
      })
    })

    actions.append(cancelBtn, saveBtn)
    form.append(titleLabel, seriesLabel, authorLabel, descLabel, actions)
    dialog.append(form)
    titleInput.focus()
  })
}

export function showReorderMembersModal(
  members: readonly WorkMember[],
  unitNames: ReadonlyMap<number, string>,
  signal?: AbortSignal
): Promise<WorkMember[] | null> {
  return new Promise((resolve) => {
    const { dialog, cleanup } = createModal({
      title: '调整卷话顺序与正番外归属',
      wide: true,
      signal,
      onCancel: () => resolve(null),
    })

    const list = document.createElement('div')
    list.className = 'reorder-list'

    let currentMembers = members.map((m) => ({ ...m }))

    const renderRows = () => {
      list.replaceChildren()
      currentMembers.forEach((member, index) => {
        const row = document.createElement('div')
        row.className = 'reorder-row'

        const nameSpan = document.createElement('span')
        nameSpan.className = 'reorder-name'
        nameSpan.textContent =
          unitNames.get(member.unitId) ?? `单元 ${member.unitId}`

        const roleSelect = document.createElement('select')
        roleSelect.className = 'reorder-role'
        roleSelect.innerHTML = `
          <option value="main" ${member.role === 'main' ? 'selected' : ''}>正篇</option>
          <option value="extra" ${member.role === 'extra' ? 'selected' : ''}>番外</option>
        `
        roleSelect.onchange = () => {
          currentMembers[index].role = roleSelect.value as 'main' | 'extra'
        }

        const upBtn = document.createElement('button')
        upBtn.type = 'button'
        upBtn.className = 'btn-sm'
        upBtn.textContent = '↑ 上移'
        upBtn.disabled = index === 0
        upBtn.onclick = () => {
          const temp = currentMembers[index]
          currentMembers[index] = currentMembers[index - 1]
          currentMembers[index - 1] = temp
          renderRows()
        }

        const downBtn = document.createElement('button')
        downBtn.type = 'button'
        downBtn.className = 'btn-sm'
        downBtn.textContent = '↓ 下移'
        downBtn.disabled = index === currentMembers.length - 1
        downBtn.onclick = () => {
          const temp = currentMembers[index]
          currentMembers[index] = currentMembers[index + 1]
          currentMembers[index + 1] = temp
          renderRows()
        }

        row.append(nameSpan, roleSelect, upBtn, downBtn)
        list.append(row)
      })
    }

    renderRows()

    const actions = document.createElement('div')
    actions.className = 'modal-actions'

    const cancelBtn = document.createElement('button')
    cancelBtn.type = 'button'
    cancelBtn.className = 'btn-secondary'
    cancelBtn.textContent = '取消'

    const confirmBtn = document.createElement('button')
    confirmBtn.type = 'button'
    confirmBtn.className = 'btn-primary'
    confirmBtn.textContent = '保存顺序'

    cancelBtn.addEventListener('click', () => {
      cleanup()
      resolve(null)
    })
    confirmBtn.addEventListener('click', () => {
      cleanup()
      resolve(currentMembers)
    })

    actions.append(cancelBtn, confirmBtn)
    dialog.append(list, actions)
    confirmBtn.focus()
  })
}

export function showMergeWorksModal(
  currentWork: Work,
  allWorks: readonly Work[],
  workTitles: ReadonlyMap<string, string>,
  signal?: AbortSignal
): Promise<string[] | null> {
  return new Promise((resolve) => {
    const otherWorks = allWorks.filter(
      (w) => w.id !== currentWork.id && !w.redirectTo && w.kind === 'comics'
    )
    if (!otherWorks.length) {
      alert('当前没有其他漫画作品可供合并')
      resolve(null)
      return
    }

    const { dialog, cleanup } = createModal({
      title: '选择要合并的其他漫画作品',
      wide: true,
      signal,
      onCancel: () => resolve(null),
    })

    const hintEl = document.createElement('p')
    hintEl.className = 'modal-hint'
    hintEl.textContent = `合并后当前作品将保留为主作品（${workTitles.get(currentWork.id) ?? '当前作品'}），其他选中的作品成员将合并入本作。`

    const list = document.createElement('div')
    list.className = 'modal-checkbox-list'

    const selectedIds = new Set<string>()

    const actions = document.createElement('div')
    actions.className = 'modal-actions'

    const cancelBtn = document.createElement('button')
    cancelBtn.type = 'button'
    cancelBtn.className = 'btn-secondary'
    cancelBtn.textContent = '取消'

    const confirmBtn = document.createElement('button')
    confirmBtn.type = 'button'
    confirmBtn.className = 'btn-primary'
    confirmBtn.textContent = '确认合并'
    confirmBtn.disabled = true

    otherWorks.forEach((work) => {
      const label = document.createElement('label')
      label.className = 'modal-checkbox-label'

      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.value = work.id
      checkbox.onchange = () => {
        if (checkbox.checked) selectedIds.add(work.id)
        else selectedIds.delete(work.id)
        confirmBtn.disabled = selectedIds.size === 0
      }

      const textEl = document.createElement('span')
      textEl.textContent = `${workTitles.get(work.id) ?? '未命名作品'} (${work.members.length} 卷/话)`

      label.append(checkbox, textEl)
      list.append(label)
    })

    cancelBtn.addEventListener('click', () => {
      cleanup()
      resolve(null)
    })
    confirmBtn.addEventListener('click', () => {
      if (selectedIds.size > 0) {
        cleanup()
        resolve([currentWork.id, ...selectedIds])
      }
    })

    actions.append(cancelBtn, confirmBtn)
    dialog.append(hintEl, list, actions)
    cancelBtn.focus()
  })
}

/** 拆分作品弹窗：必须满足已批准的契约细化，明确提示第一组保留原作品标记，其余为新作品 */
export function showSplitWorkModal(
  work: Work,
  unitNames: ReadonlyMap<number, string>,
  signal?: AbortSignal
): Promise<WorkMember[][] | null> {
  return new Promise((resolve) => {
    if (work.members.length < 2) {
      alert('作品成员少于 2 卷/话，无法拆分')
      resolve(null)
      return
    }

    const { dialog, cleanup } = createModal({
      title: '拆分作品卷话',
      wide: true,
      signal,
      onCancel: () => resolve(null),
    })

    // 法定明确提示语契约
    const legalNotice = document.createElement('div')
    legalNotice.className = 'modal-warning-box contract-notice'
    legalNotice.setAttribute('role', 'note')
    legalNotice.textContent =
      '第一组保留原作品标记，其余为新作品；各卷阅读进度和书签均保留。'

    const descEl = document.createElement('p')
    descEl.className = 'modal-hint'
    descEl.textContent = '请为各卷选择目标分组。至少需要两个非空分组方可完成拆分。'

    const list = document.createElement('div')
    list.className = 'split-list'

    // 默认分为两组
    let groupCount = 2
    const assignments = new Map<number, number>()
    work.members.forEach((m, idx) => {
      // 默认平分两组
      assignments.set(m.unitId, idx < Math.ceil(work.members.length / 2) ? 1 : 2)
    })

    const renderSplitRows = () => {
      list.replaceChildren()
      work.members.forEach((m) => {
        const row = document.createElement('div')
        row.className = 'split-row'

        const nameSpan = document.createElement('span')
        nameSpan.className = 'split-name'
        nameSpan.textContent =
          unitNames.get(m.unitId) ?? `单元 ${m.unitId} (${m.role === 'main' ? '正篇' : '番外'})`

        const groupSelect = document.createElement('select')
        groupSelect.className = 'split-group-select'
        for (let g = 1; g <= groupCount; g++) {
          const opt = document.createElement('option')
          opt.value = String(g)
          opt.textContent = g === 1 ? '第 1 组 (保留原作品标记)' : `第 ${g} 组 (新作品)`
          if (assignments.get(m.unitId) === g) opt.selected = true
          groupSelect.append(opt)
        }
        groupSelect.onchange = () => {
          assignments.set(m.unitId, Number(groupSelect.value))
          validateGroups()
        }

        row.append(nameSpan, groupSelect)
        list.append(row)
      })
    }

    const toolRow = document.createElement('div')
    toolRow.className = 'split-tool-row'
    const addGroupBtn = document.createElement('button')
    addGroupBtn.type = 'button'
    addGroupBtn.className = 'btn-sm'
    addGroupBtn.textContent = '+ 增加分组'
    addGroupBtn.onclick = () => {
      if (groupCount < work.members.length) {
        groupCount++
        renderSplitRows()
        validateGroups()
      }
    }
    toolRow.append(addGroupBtn)

    const actions = document.createElement('div')
    actions.className = 'modal-actions'

    const cancelBtn = document.createElement('button')
    cancelBtn.type = 'button'
    cancelBtn.className = 'btn-secondary'
    cancelBtn.textContent = '取消'

    const confirmBtn = document.createElement('button')
    confirmBtn.type = 'button'
    confirmBtn.className = 'btn-primary'
    confirmBtn.textContent = '确认拆分'

    const validateGroups = () => {
      const groups = new Map<number, WorkMember[]>()
      for (let g = 1; g <= groupCount; g++) groups.set(g, [])
      work.members.forEach((m) => {
        const g = assignments.get(m.unitId) ?? 1
        groups.get(g)?.push(m)
      })
      const firstGroup = groups.get(1) ?? []
      const otherNonEmpty = [...groups.entries()].filter(([g, list]) => g > 1 && list.length > 0)
      // 必须满足：第 1 组（保留原标记）非空，且至少存在一个非空新作品分组
      confirmBtn.disabled = firstGroup.length === 0 || otherNonEmpty.length === 0
    }

    validateGroups()
    renderSplitRows()

    cancelBtn.addEventListener('click', () => {
      cleanup()
      resolve(null)
    })
    confirmBtn.addEventListener('click', () => {
      const groups = new Map<number, WorkMember[]>()
      for (let g = 1; g <= groupCount; g++) groups.set(g, [])
      work.members.forEach((m) => {
        const g = assignments.get(m.unitId) ?? 1
        groups.get(g)?.push(m)
      })
      const firstGroup = groups.get(1) ?? []
      const otherNonEmpty = [...groups.entries()].filter(([g, list]) => g > 1 && list.length > 0)
      if (firstGroup.length > 0 && otherNonEmpty.length > 0) {
        cleanup()
        resolve([firstGroup, ...otherNonEmpty.map(([, list]) => list)])
      }
    })

    actions.append(cancelBtn, confirmBtn)
    dialog.append(legalNotice, descEl, toolRow, list, actions)
    confirmBtn.focus()
  })
}
