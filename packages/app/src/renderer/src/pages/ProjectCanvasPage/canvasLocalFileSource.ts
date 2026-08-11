import { normalizeLocalMediaUrl } from '../ChatPage/chatPageShared'

type ElectronCanvasFile = File & {
  path?: string
}

type ElectronFileBridge = {
  getPathForFile?: (file: File) => string
  authorizeLocalMediaFile?: (file: File) => string | Promise<string>
  resolveAuthorizedLocalMediaPath?: (filePath: string) => Promise<string>
}

function encodeLocalMediaPathSegments(filePath: string): string {
  return filePath
    .split('/')
    .map((segment, index) =>
      index === 1 && /^[a-zA-Z]:$/.test(segment) ? segment : encodeURIComponent(segment)
    )
    .join('/')
}

export function toLocalMediaUrl(filePath: string): string | null {
  const trimmed = filePath.trim()
  if (!trimmed) return null

  const normalizedPath = trimmed.replace(/\\/g, '/')
  if (normalizedPath.startsWith('//')) {
    const [hostname, ...segments] = normalizedPath.slice(2).split('/')
    if (!hostname) return null
    return `local-media://${encodeURIComponent(hostname)}/${segments
      .map(encodeURIComponent)
      .join('/')}`
  }

  const pathname = normalizedPath.startsWith('/') ? normalizedPath : `/${normalizedPath}`
  return `local-media://${encodeLocalMediaPathSegments(pathname)}`
}

export function getElectronCanvasFilePath(file: Blob): string {
  const legacyPath = (file as ElectronCanvasFile).path
  if (typeof legacyPath === 'string' && legacyPath.trim()) {
    return legacyPath
  }

  if (typeof window === 'undefined') {
    return ''
  }

  try {
    const bridgeWindow = window as Window & {
      electronFile?: ElectronFileBridge
    }
    const bridge = bridgeWindow.electronFile
    const bridgedPath = file instanceof File ? bridge?.getPathForFile?.(file) : ''
    return typeof bridgedPath === 'string' ? bridgedPath : ''
  } catch {
    return ''
  }
}

export function getCanvasLocalMediaSourceUrl(file: Blob): string | null {
  return toLocalMediaUrl(getElectronCanvasFilePath(file))
}

export async function authorizeCanvasLocalMediaSourceUrl(file: File): Promise<string | null> {
  if (typeof window === 'undefined') return null

  try {
    const filePath = await window.electronFile?.authorizeLocalMediaFile?.(file)
    return filePath ? toLocalMediaUrl(filePath) : null
  } catch {
    return null
  }
}

export async function resolveAuthorizedCanvasLocalMediaSourceUrl(
  sourceUrl: string
): Promise<string | null> {
  const normalized = normalizeLocalMediaUrl(sourceUrl).trim()
  if (!/^local-media:|^file:/i.test(normalized) || typeof window === 'undefined') return null

  try {
    const parsed = new URL(normalized)
    const decodedPathSegments = parsed.pathname
      .split('/')
      .map((segment) => decodeURIComponent(segment))
    let filePath = decodedPathSegments.join('/').replace(/^\/([a-zA-Z]:\/)/, '$1')
    if (/^[a-zA-Z]$/.test(parsed.hostname)) {
      filePath = `${parsed.hostname}:/${filePath.replace(/^\/+/, '')}`
    } else if (parsed.hostname) {
      filePath = `//${decodeURIComponent(parsed.hostname)}/${filePath.replace(/^\/+/, '')}`
    }
    const authorized = await window.electronFile?.resolveAuthorizedLocalMediaPath?.(filePath)
    return authorized ? toLocalMediaUrl(authorized) : null
  } catch {
    return null
  }
}

export async function resolveCanvasImageFileSource(
  file: File,
  readFileAsDataURL: (file: File) => Promise<string>
): Promise<string> {
  const localMediaUrl = await authorizeCanvasLocalMediaSourceUrl(file)
  if (localMediaUrl) {
    return localMediaUrl
  }

  if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    return URL.createObjectURL(file)
  }

  return await readFileAsDataURL(file)
}
