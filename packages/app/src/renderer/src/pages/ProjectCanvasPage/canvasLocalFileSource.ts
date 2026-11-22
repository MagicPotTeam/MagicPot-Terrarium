import { normalizeLocalMediaUrl } from '../ChatPage/chatPageShared'
import { createCanvasImageObjectUrlHandle } from './canvasImageObjectUrlRegistry'
import { localMediaUrlToFilePath, toLocalMediaUrl } from '@shared/localMediaUrl'

// Kept for existing callers; the conversion lives in shared/ so MAIN builds identical URLs.
export { toLocalMediaUrl }

let nextImageFileSourceId = 0

type ElectronCanvasFile = File & {
  path?: string
}

type ElectronFileBridge = {
  getPathForFile?: (file: File) => string
  authorizeLocalMediaFile?: (file: File) => string | Promise<string>
  resolveAuthorizedLocalMediaPath?: (filePath: string) => Promise<string>
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
    const filePath = localMediaUrlToFilePath(normalized)
    if (filePath === null) return null
    const authorized = await window.electronFile?.resolveAuthorizedLocalMediaPath?.(filePath)
    return authorized ? toLocalMediaUrl(authorized) : null
  } catch {
    return null
  }
}

export async function resolveCanvasImageFileSource(
  file: File,
  readFileAsDataURL: (file: File) => Promise<string>,
  signal?: AbortSignal
): Promise<string> {
  signal?.throwIfAborted()
  const localMediaUrl = await authorizeCanvasLocalMediaSourceUrl(file)
  signal?.throwIfAborted()
  if (localMediaUrl) {
    return localMediaUrl
  }

  if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    const handle = createCanvasImageObjectUrlHandle(
      `canvas-file-source:${++nextImageFileSourceId}`,
      file
    )
    if (!handle) throw new Error('Canvas image Object URL budget exhausted.')
    return handle.url
  }

  return await readFileAsDataURL(file)
}
