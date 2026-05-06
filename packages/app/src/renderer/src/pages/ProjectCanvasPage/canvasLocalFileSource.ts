import { normalizeLocalMediaUrl } from '../ChatPage/chatPageShared'

type ElectronCanvasFile = File & {
  path?: string
}

type ElectronFileBridge = {
  getPathForFile?: (file: File) => string
}

export function getElectronCanvasFilePath(file: File): string {
  const legacyPath = (file as ElectronCanvasFile).path
  if (typeof legacyPath === 'string' && legacyPath.trim()) {
    return legacyPath
  }

  if (typeof window === 'undefined') {
    return ''
  }

  try {
    const bridge = (window as Window & { electronFile?: ElectronFileBridge }).electronFile
    const bridgedPath = bridge?.getPathForFile?.(file)
    return typeof bridgedPath === 'string' ? bridgedPath : ''
  } catch {
    return ''
  }
}

export function getCanvasLocalMediaSourceUrl(file: File): string | null {
  const filePath = getElectronCanvasFilePath(file).replace(/\\/g, '/')
  if (!filePath) {
    return null
  }

  return normalizeLocalMediaUrl(`file://${filePath}`)
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
