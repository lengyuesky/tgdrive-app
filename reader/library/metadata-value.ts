/** 所有简介和书名都转为纯文本；调用方只能用 textContent 展示这些字段。 */
import DOMPurify from 'dompurify'
import { LibraryError } from './model'
import type { BibliographicMetadata } from './model'

export function metadataText(raw: unknown, maximum = 160): string | undefined {
  if (typeof raw !== 'string') return undefined
  const bounded = raw.slice(0, 32768)
  const clean = DOMPurify.sanitize(bounded, { ALLOWED_TAGS: [], ALLOWED_ATTR: [], RETURN_DOM_FRAGMENT: true }).textContent ?? ''
  const text = clean.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replace(/\s+/g, ' ').trim().slice(0, maximum)
  return text || undefined
}
export function validNumber(raw: unknown, maximum = 1_000_000): number | undefined {
  if (typeof raw !== 'number' && (typeof raw !== 'string' || !/^\d+(?:\.\d+)?$/.test(raw.trim()))) return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 && value <= maximum ? value : undefined
}
export function cleanMetadata(raw: unknown): BibliographicMetadata {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const value = raw as BibliographicMetadata, result: BibliographicMetadata = {}
  for (const key of ['title', 'series', 'language', 'publisher', 'description'] as const) {
    const text = metadataText(value[key], key === 'description' ? 4000 : key === 'language' ? 40 : 160)
    if (text) result[key] = text
  }
  if (Array.isArray(value.authors)) {
    const authors = [...new Set(value.authors.slice(0, 16).map(author => metadataText(author)).filter((author): author is string => !!author))]
    if (authors.length) result.authors = authors
  }
  for (const key of ['volume', 'number', 'year'] as const) {
    const number = validNumber(value[key], key === 'year' ? 9999 : 1_000_000)
    if (number !== undefined) result[key] = number
  }
  return result
}
export function validateOverrides(raw: unknown): BibliographicMetadata {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new LibraryError('invalid_metadata', '人工元数据格式无效')
  const clean = cleanMetadata(raw)
  // 空字符串明确清空该字段；undefined 表示继续使用内嵌或文件名。
  for (const key of ['title', 'series', 'language', 'publisher', 'description'] as const) if ((raw as BibliographicMetadata)[key] === '') clean[key] = ''
  if (Array.isArray((raw as BibliographicMetadata).authors) && !(raw as BibliographicMetadata).authors!.length) clean.authors = []
  return clean
}
export function safeXml(text: string): Document {
  if (new TextEncoder().encode(text).length > 8 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(text)) throw new LibraryError('unsafe_xml', '不允许 XML 实体、外部文档声明或过大的元数据')
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (doc.getElementsByTagNameNS('*', 'parsererror').length || doc.getElementsByTagName('*').length > 20000) throw new LibraryError('invalid_xml', '元数据 XML 损坏或结构过大')
  for (const element of doc.getElementsByTagName('*')) {
    let depth = 0, parent = element.parentElement
    while (parent) { if (++depth > 32) throw new LibraryError('invalid_xml', '元数据 XML 结构过深'); parent = parent.parentElement }
  }
  return doc
}
export const elements = (root: Document | Element, name: string) => [...root.getElementsByTagNameNS('*', name)]
export function elementText(element?: Element): string | undefined {
  if (!element) return undefined
  const clone = element.cloneNode(true) as Element
  for (const child of [...clone.getElementsByTagName('*')]) if (['script', 'style', 'iframe', 'object', 'embed'].includes(child.localName.toLowerCase())) child.remove()
  return clone.textContent ?? undefined
}
