export type PageAction = 'refresh' | 'reset' | 'next' | 'previous'

/** 只保留当前页数据，之前的页仅保留游标；字节短页仍以返回游标为准。 */
export class RecordCursor<C> {
  after: C | null = null
  next: C | null = null
  private previous: (C | null)[] = []
  get page(): number { return this.previous.length + 1 }
  get hasPrevious(): boolean { return this.previous.length > 0 }
  request(action: PageAction): C | null {
    if (action === 'next') return this.next
    if (action === 'previous') return this.previous.at(-1) ?? null
    return action === 'reset' ? null : this.after
  }
  accept(action: PageAction, after: C | null, next: C | null): void {
    if (next !== null && JSON.stringify(next) === JSON.stringify(after)) throw new Error('记录游标没有推进，请刷新记录')
    if (action === 'reset') this.previous = []
    else if (action === 'next') this.previous.push(this.after)
    else if (action === 'previous') this.previous.pop()
    this.after = after; this.next = next
  }
  clear(): void { this.after = null; this.next = null; this.previous = [] }
}
