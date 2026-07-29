import { normalizeLocalMediaUrl } from '../ChatPage/chatPageShared'

type ElectronCanvasFile = File & {
  path?: string
}

type ElectronFileBridge = {
  getPathForFile?: (file: File) => string
  authorizeLocalMediaFile?: (file: File) => Promise<string>
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
      electronAPI?: ElectronFileBridge
    }
    const bridge = bridgeWindow.electronFile || bridgeWindow.electronAPI
    const bridgedPath = file instanceof File ? bridge?.getPathForFile?.(file) : ''
    return typeof bridgedPath === 'string' ? bridgedPath : ''
  } catch {
    return ''
  }
}

export function getCanvasLocalMediaSourceUrl(file: Blob): string | null {
  const filePath = getElectronCanvasFilePath(file).replace(/\\/g, '/')
  if (!filePath) {
    return null
  }

  return normalizeLocalMediaUrl(`file://${filePath}`)
}

export async function authorizeCanvasLocalMediaSourceUrl(file: File): Promise<string | null> {
  if (typeof window === 'undefined') return null

  try {
    const filePath = await window.electronFile?.authorizeLocalMediaFile?.(file)
    if (!filePath) return null
    return normalizeLocalMediaUrl(`file://${filePath.replace(/\\/g, '/')}`)
  } catch {
    return null
  }
}

export async function resolveCanvasImageFileSource(
  file: File,
  readFileAsDataURL: (file: File) => Promise<string>
): Promise<string> {
  const localMediaUrl = getCanvasLocalMediaSourceUrl(file)
  if (localMediaUrl) {
    return localMediaUrl
  }

  if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    return URL.createObjectURL(file)
  }

  return await readFileAsDataURL(file)
}
