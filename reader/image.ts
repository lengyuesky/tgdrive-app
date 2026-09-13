/** 解码前验证位图头部尺寸；不调用会扫描未知格式的第三方解析器。 */
import { LIMITS } from './io'
export interface ImageInfo { width: number; height: number; mime: string }
export function imageInfo(bytes: Uint8Array): ImageInfo {
  if (bytes.length > LIMITS.entry || bytes.length < 10) throw new Error('图片为空、损坏或超过 32 MiB')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const word = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length))
  let width = 0, height = 0, mime = ''
  if (bytes.length >= 24 && word(1, 3) === 'PNG' && bytes[0] === 137 && word(12, 4) === 'IHDR') {
    width = view.getUint32(16); height = view.getUint32(20); mime = 'image/png'
  } else if (word(0, 3) === 'GIF' && ['87a', '89a'].includes(word(3, 3))) {
    width = view.getUint16(6, true); height = view.getUint16(8, true); mime = 'image/gif'
  } else if (bytes.length >= 26 && word(0, 2) === 'BM') {
    const header = view.getUint32(14, true)
    width = header === 12 ? view.getUint16(18, true) : view.getInt32(18, true)
    height = header === 12 ? view.getUint16(20, true) : Math.abs(view.getInt32(22, true)); mime = 'image/bmp'
  } else if (bytes.length >= 30 && word(0, 4) === 'RIFF' && word(8, 4) === 'WEBP') {
    const u24 = (i: number) => bytes[i]! | bytes[i + 1]! << 8 | bytes[i + 2]! << 16
    const kind = word(12, 4)
    if (kind === 'VP8X') { width = u24(24) + 1; height = u24(27) + 1 }
    else if (kind === 'VP8L' && bytes[20] === 0x2f) { const bits = view.getUint32(21, true); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1 }
    else if (kind === 'VP8 ' && word(23, 3) === '\x9d\x01\x2a') { width = view.getUint16(26, true) & 0x3fff; height = view.getUint16(28, true) & 0x3fff }
    mime = 'image/webp'
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2, steps = 0
    while (at + 4 <= bytes.length && steps++ < 10000) {
      if (bytes[at++] !== 0xff) throw new Error('JPEG 标记损坏')
      while (at < bytes.length && bytes[at] === 0xff) at++
      const marker = bytes[at++]!
      if (marker === 0xda || marker === 0xd9) break
      if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue
      if (at + 2 > bytes.length) break
      const length = view.getUint16(at)
      if (length < 2 || at + length > bytes.length) break
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
        height = view.getUint16(at + 3); width = view.getUint16(at + 5); break
      }
      at += length
    }
    mime = 'image/jpeg'
  } else if (bytes.length >= 16 && word(4, 4) === 'ftyp' && /avif|avis/.test(word(8, Math.min(64, bytes.length - 8)))) {
    let count = 0
    const scan = (start: number, end: number, depth: number) => {
      if (depth > 10) throw new Error('AVIF 图片结构过深')
      for (let at = start; at + 8 <= end;) {
        if (++count > 10000) throw new Error('AVIF 图片结构过多')
        let size = view.getUint32(at), head = 8
        const kind = word(at + 4, 4)
        if (size === 1) { if (at + 16 > end) throw new Error('AVIF 图片损坏'); const big = view.getBigUint64(at + 8); if (big > BigInt(end - at)) throw new Error('AVIF 图片范围越界'); size = Number(big); head = 16 }
        if (size === 0) size = end - at
        if (size < head || at + size > end) throw new Error('AVIF 图片结构损坏')
        if (kind === 'ispe' && size >= head + 12) { width = Math.max(width, view.getUint32(at + head + 4)); height = Math.max(height, view.getUint32(at + head + 8)) }
        if (['meta', 'iprp', 'ipco'].includes(kind)) scan(at + head + (kind === 'meta' ? 4 : 0), at + size, depth + 1)
        at += size
      }
    }
    scan(0, bytes.length, 0); mime = 'image/avif'
  }
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width > 65535 || height > 65535 || width * height > LIMITS.pixels) throw new Error('图片格式损坏、不受支持或超过 3200 万像素')
  return { width, height, mime }
}
export function imageBlob(bytes: Uint8Array<ArrayBuffer>) {
  const info = imageInfo(bytes)
  return { ...info, blob: new Blob([bytes], { type: info.mime }) }
}
