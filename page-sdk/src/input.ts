import { LIMITS } from '../../contract/types/contract.js'
import type { UiRequest } from '../../contract/types/contract.js'
import { SdkError } from './error.js'
import { stringifyJson } from './json.js'
import { wireObject } from './wire.js'

/** 线上边界来自生成常量；浏览器只作同一契约的无状态输入检查，授权仍由宿主判定。 */
export function validNodeId(value: string): boolean {
  return /^[1-9][0-9]*$/.test(value) && value.length <= LIMITS.MAX_NODE_ID_DIGITS && BigInt(value) <= BigInt(LIMITS.MAX_NODE_ID)
}
export function byteCount(value: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value) || value.length > LIMITS.MAX_BYTE_COUNT_DIGITS || BigInt(value) > BigInt(LIMITS.MAX_BYTE_COUNT)) throw new SdkError('字节数量不符合契约的十进制字符串边界')
  return BigInt(value)
}
function opaque(value: string, maximum: number): boolean { return /^[A-Za-z0-9_-]+$/.test(value) && value.length <= maximum }
function text(value: string, maximum: number): boolean { return Boolean(value.trim()) && !/\p{Cc}/u.test(value) && new TextEncoder().encode(value).length <= maximum }
function progress(value: number): boolean { return Number.isInteger(value) && value >= 0 && value <= LIMITS.MAX_TASK_PROGRESS }
export function validateUiRequest(request: UiRequest): UiRequest {
  // 界面消息与 HTTP 使用同一种 JSON 形状，可选 undefined 字段在发送前省略。
  try { request = wireObject('UiRequest', stringifyJson(request)) }
  catch { throw new SdkError('界面请求参数格式无效') }
  let valid = true
  switch (request.method) {
    case 'ui.set_immersive': {
      const color = request.params.background
      valid = color == null || color.length === LIMITS.IMMERSIVE_COLOR_BYTES && new RegExp(`^#[0-9A-Fa-f]{${LIMITS.IMMERSIVE_COLOR_HEX_DIGITS}}$`).test(color)
      break
    }
    case 'ui.set_title': valid = text(request.params.title, LIMITS.MAX_UI_TITLE_BYTES); break
    case 'ui.pick_directory': valid = request.params.initial_id == null || validNodeId(request.params.initial_id); break
    case 'ui.request_scope': valid = text(request.params.reason, LIMITS.MAX_AUTHORIZATION_REASON_BYTES); break
    case 'ui.task': {
      const task = request.params
      valid = opaque(task.id, LIMITS.MAX_TASK_ID_BYTES) && text(task.title, LIMITS.MAX_TASK_TITLE_BYTES) && progress(task.completed) && (task.total == null || progress(task.total) && task.total >= task.completed)
      break
    }
    case 'ui.closed': valid = opaque(request.params.close_id, LIMITS.MAX_OPAQUE_ID_BYTES); break
    case 'ui.close': break
  }
  if (!valid) throw new SdkError('界面请求超出契约输入边界')
  return request
}
