const INVALID_FILE_PART_CHARACTERS = '<>:"/\\|?*'

export function getImageExportExtension(mimeType: string): string {
  if (mimeType === 'image/jpeg') return '.jpg'
  if (mimeType === 'image/webp') return '.webp'
  if (mimeType === 'image/gif') return '.gif'
  if (mimeType === 'image/bmp') return '.bmp'
  if (mimeType === 'image/svg+xml') return '.svg'
  if (mimeType === 'image/x-icon') return '.ico'
  return '.png'
}

export function sanitizeFilePart(value: string): string {
  let cleaned = ''
  let lastWasReplacement = false

  for (const char of value.trim()) {
    const isInvalid = char.charCodeAt(0) <= 0x1f || INVALID_FILE_PART_CHARACTERS.includes(char)

    if (isInvalid) {
      if (!lastWasReplacement) {
        cleaned += '_'
        lastWasReplacement = true
      }
      continue
    }

    cleaned += char
    lastWasReplacement = false
  }

  return cleaned || 'item'
}

export function sanitizeRelativePathSegments(relativePath: string): string[] {
  return relativePath
    .split(/[/\\]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
    .map((segment) => sanitizeFilePart(segment))
}

export function getExportMimeType(format: 'png' | 'jpeg'): 'image/png' | 'image/jpeg' {
  return format === 'png' ? 'image/png' : 'image/jpeg'
}

export function getExportFileExtension(format: 'png' | 'jpeg' | 'svg'): '.png' | '.jpg' | '.svg' {
  if (format === 'png') return '.png'
  if (format === 'svg') return '.svg'
  return '.jpg'
}
