/** 图片头部已由 imageBlob 检查后才可调用；临时 URL 在解码成功、失败、取消时均释放。 */
import { abortError, natural } from '../io'

export function sortCoverCandidates(paths: string[]): string[] {
  const score = (path: string) => {
    const name = path.split('/').pop()?.replace(/\.[^.]+$/, '') ?? ''
    return /cover|poster|folder|封面/i.test(name) ? 0 : /(^|[^\d])0*1$/i.test(name) ? 1 : 2
  }
  return [...paths].sort((a, b) => score(a) - score(b) || natural(a, b))
}
export const isThumbnailUrl = (raw: unknown): raw is string => typeof raw === 'string' && /^data:image\/(?:webp|jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/.test(raw)
export async function downscaleCover(blob: Blob, maxDim = 320, signal = new AbortController().signal): Promise<string> {
  signal.throwIfAborted()
  const url = URL.createObjectURL(blob)
  if (typeof document === 'undefined') return url
  const image = new Image()
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { image.onload = null; image.onerror = null; signal.removeEventListener('abort', stop) }
      const stop = () => { cleanup(); image.removeAttribute('src'); reject(abortError()) }
      image.onload = () => { cleanup(); resolve() }
      image.onerror = () => { cleanup(); reject(new Error('封面图片解码失败')) }
      signal.addEventListener('abort', stop, { once: true }); image.src = url
    })
    signal.throwIfAborted()
    const width = image.naturalWidth || image.width, height = image.naturalHeight || image.height
    if (!width || !height || width * height > 32_000_000) throw new Error('封面图片尺寸无效或超过像素上限')
    const size = Math.max(1, Math.min(320, maxDim)), scale = Math.min(1, size / Math.max(width, height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale))
    try {
      const context = canvas.getContext('2d')
      if (!context) throw new Error('浏览器无法创建封面画布')
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      const webp = canvas.toDataURL('image/webp', 0.8)
      signal.throwIfAborted()
      const output = webp.startsWith('data:image/webp;') ? webp : canvas.toDataURL('image/jpeg', 0.8)
      if (!isThumbnailUrl(output)) throw new Error('浏览器无法生成封面缩略图')
      return output
    } finally { canvas.width = 0; canvas.height = 0 }
  } finally { image.removeAttribute('src'); URL.revokeObjectURL(url) }
}
