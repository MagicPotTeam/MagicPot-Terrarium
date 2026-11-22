import fs from 'node:fs'
import { basename, extname, join } from 'node:path'

/** The private temp media folder is not verified: nothing is written. */
export const CANVAS_DRAG_TEMP_ROOT_REFUSED = 'LOCAL_MEDIA_TEMP_ROOT_REFUSED'

export function sanitizeDragFileName(fileName: string): string {
  const trimmed = (fileName || '').trim()
  const baseName = [...basename(trimmed || 'canvas-selection.png')]
    .map((char) => {
      const code = char.charCodeAt(0)
      return code <= 0x1f || '<>:"/\\|?*'.includes(char) ? '_' : char
    })
    .join('')

  if (!baseName) {
    return 'canvas-selection.png'
  }
  if (extname(baseName)) {
    return baseName
  }
  return `${baseName}.png`
}

export type CanvasSystemDragFile = { fileName: string; data: Uint8Array | ArrayBuffer }

/**
 * Writes the images dragged out of the canvas into `dragDirectory` and returns their paths.
 * The caller passes a folder of main's private temp media folder only once that folder has
 * been verified again right before this write (null otherwise, and then nothing is
 * written). The folder is created private (0700) and each file is created here (0600,
 * exclusively): an entry that already has the name is never followed or overwritten.
 */
export function writeCanvasSystemDragFiles(
  files: readonly CanvasSystemDragFile[],
  dragDirectory: string | null,
  {
    fileSystem = fs,
    uniquePrefix = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }: {
    fileSystem?: Pick<typeof fs, 'mkdirSync' | 'writeFileSync'>
    uniquePrefix?: () => string
  } = {}
): string[] {
  if (!dragDirectory) throw new Error(CANVAS_DRAG_TEMP_ROOT_REFUSED)
  fileSystem.mkdirSync(dragDirectory, { recursive: true, mode: 0o700 })
  return files.map((file) => {
    const fullPath = join(dragDirectory, `${uniquePrefix()}-${sanitizeDragFileName(file.fileName)}`)
    fileSystem.writeFileSync(fullPath, Buffer.from(file.data as Uint8Array), {
      mode: 0o600,
      flag: 'wx'
    })
    return fullPath
  })
}
