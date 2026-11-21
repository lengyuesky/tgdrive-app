import { SdkError } from './error.js'

/** 通用严格 JSON 读取器；不另建线上 schema。重复键必须在 JSON.parse 覆盖之前发现。 */
export function parseJson(text: string): unknown {
  let position = 0
  const fail = (): never => { throw new SdkError('JSON 不是无损的规范数据') }
  const whitespace = () => { while (/[\t\n\r ]/.test(text[position] ?? 'x')) position++ }
  const string = (): string => {
    const start = position++
    while (position < text.length) {
      const character = text[position++]
      if (character === '\\') { position++; continue }
      if (character === '"') {
        let value: string
        try { value = JSON.parse(text.slice(start, position)) as string } catch { return fail() }
        if (!wellFormed(value)) return fail()
        return value
      }
    }
    return fail()
  }
  const value = (depth: number): unknown => {
    // 这是本地递归解析器的栈保护，与 serde_json 默认深度一致，不另定义宿主线上配额。
    if (depth > 128) return fail()
    whitespace()
    if (text[position] === '"') return string()
    if (text[position] === '{') {
      position++; whitespace()
      const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>
      if (text[position] === '}') { position++; return output }
      for (;;) {
        if (text[position] !== '"') return fail()
        const key = string(); whitespace()
        if (Object.hasOwn(output, key) || text[position++] !== ':') return fail()
        output[key] = value(depth + 1); whitespace()
        const character = text[position++]
        if (character === '}') return output
        if (character !== ',') return fail()
        whitespace()
      }
    }
    if (text[position] === '[') {
      position++; whitespace()
      const output: unknown[] = []
      if (text[position] === ']') { position++; return output }
      for (;;) {
        output.push(value(depth + 1)); whitespace()
        const character = text[position++]
        if (character === ']') return output
        if (character !== ',') return fail()
      }
    }
    for (const [token, result] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(token, position)) { position += token.length; return result }
    }
    const token = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(position))?.[0]
    if (!token) return fail()
    position += token.length
    const number = Number(token)
    if (!Number.isFinite(number) || Number.isInteger(number) && !Number.isSafeInteger(number)) return fail()
    return number
  }
  const output = value(0); whitespace()
  if (position !== text.length) return fail()
  return output
}
export function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}
export function stringifyJson(value: unknown): string {
  const text = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'number' && (!Number.isFinite(item) || Number.isInteger(item) && !Number.isSafeInteger(item))) throw new SdkError('JSON 数字不能无损传输')
    if (typeof item === 'string' && !wellFormed(item)) throw new SdkError('JSON 字符串不是合法 UTF-8')
    if (typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint') throw new SdkError('JSON 值无效')
    return item
  })
  if (text === undefined) throw new SdkError('JSON 正文不能为空')
  return text
}
export function jsonObject<T>(text: string): T {
  const value = parseJson(text)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new SdkError('线上 JSON 必须为对象')
  return value as T
}
export function encodeJson(value: unknown): string {
  const bytes = new TextEncoder().encode(stringifyJson(value))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export function decodeJson(encoded: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length % 4 === 1) throw new SdkError('启动上下文编码无效')
  let raw: string
  try { raw = atob(encoded.replace(/-/g, '+').replace(/_/g, '/')) } catch { throw new SdkError('启动上下文编码无效') }
  if (btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== encoded) throw new SdkError('启动上下文编码不是规范形式')
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(raw, character => character.charCodeAt(0)))
}
