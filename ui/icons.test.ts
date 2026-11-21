import { expect, it } from 'vitest'
import { icon } from '@tgdrive/ui'

it('共享图标按包引用并保留线性图标与无障碍标记', () => {
  expect(icon('back')).toContain('class="tg-icon"')
  expect(icon('back')).toContain('viewBox="0 0 24 24"')
  expect(icon('back')).toContain('aria-hidden="true"')
  expect(icon('bookmarkFilled')).toContain('fill="currentColor"')
})
