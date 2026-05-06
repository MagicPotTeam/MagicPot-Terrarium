export type DisplayFileKind =
  | 'archive'
  | 'excel'
  | 'generic'
  | 'markdown'
  | 'pdf'
  | 'powerpoint'
  | 'text'
  | 'word'

const FILE_MIME_BY_EXTENSION: Record<string, string> = {
  '.avi': 'video/x-msvideo',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.csv': 'text/csv',
  '.fbx': 'application/octet-stream',
  '.gif': 'image/gif',
  '.gltf': 'model/gltf+json',
  '.glb': 'model/gltf-binary',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.md': 'text/markdown',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
  '.obj': 'text/plain',
  '.ogg': 'video/ogg',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.svg': 'image/svg+xml',
  '.stl': 'application/octet-stream',
  '.txt': 'text/plain',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip'
}

const WORD_MIME_TYPES = new Set([
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
])

const EXCEL_MIME_TYPES = new Set([
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv'
])

const POWERPOINT_MIME_TYPES = new Set([
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'
])

const BASIC_EDITABLE_MIME_TYPES = new Set(['text/plain', 'text/markdown', 'text/csv'])

const getFileExtension = (fileName?: string): string => {
  const trimmed = fileName?.trim().toLowerCase() || ''
  const lastDot = trimmed.lastIndexOf('.')
  if (lastDot <= 0 || lastDot === trimmed.length - 1) return ''
  return trimmed.slice(lastDot)
}

export const guessMimeTypeFromFileName = (
  fileName?: string,
  fallback = 'application/octet-stream'
): string => {
  const extension = getFileExtension(fileName)
  return FILE_MIME_BY_EXTENSION[extension] || fallback
}

export const normalizeFileMimeType = (
  fileName?: string,
  mimeType?: string,
  fallback = 'application/octet-stream'
): string => {
  const trimmedMimeType = mimeType?.trim()
  if (trimmedMimeType && trimmedMimeType !== 'application/octet-stream') {
    return trimmedMimeType
  }
  return guessMimeTypeFromFileName(fileName, trimmedMimeType || fallback)
}

export const detectDisplayFileKind = (fileName?: string, mimeType?: string): DisplayFileKind => {
  const extension = getFileExtension(fileName)
  const normalizedMimeType = normalizeFileMimeType(fileName, mimeType).toLowerCase()

  if (extension === '.txt' || normalizedMimeType === 'text/plain') return 'text'
  if (extension === '.md' || normalizedMimeType === 'text/markdown') return 'markdown'
  if (extension === '.csv' || normalizedMimeType === 'text/csv') return 'excel'
  if (extension === '.pdf' || normalizedMimeType === 'application/pdf') return 'pdf'
  if (extension === '.zip' || normalizedMimeType === 'application/zip') return 'archive'
  if (extension === '.doc' || extension === '.docx' || WORD_MIME_TYPES.has(normalizedMimeType)) {
    return 'word'
  }
  if (
    extension === '.xls' ||
    extension === '.xlsx' ||
    extension === '.csv' ||
    EXCEL_MIME_TYPES.has(normalizedMimeType)
  ) {
    return 'excel'
  }
  if (
    extension === '.ppt' ||
    extension === '.pptx' ||
    POWERPOINT_MIME_TYPES.has(normalizedMimeType)
  ) {
    return 'powerpoint'
  }
  return 'generic'
}

export const getFileKindLabel = (kind: DisplayFileKind): string => {
  switch (kind) {
    case 'markdown':
      return 'Markdown'
    case 'text':
      return 'Text'
    case 'word':
      return 'Word'
    case 'excel':
      return 'Excel'
    case 'powerpoint':
      return 'PowerPoint'
    case 'pdf':
      return 'PDF'
    case 'archive':
      return 'Archive'
    default:
      return 'File'
  }
}

export const getFileBadgeText = (fileName?: string, mimeType?: string): string => {
  const extension = getFileExtension(fileName)
  if (extension) return extension.slice(1).toUpperCase()

  const normalizedMimeType = normalizeFileMimeType(fileName, mimeType).toLowerCase()
  if (!normalizedMimeType) return 'FILE'

  if (normalizedMimeType === 'text/plain') return 'TXT'
  if (normalizedMimeType === 'text/markdown') return 'MD'
  if (normalizedMimeType === 'text/csv') return 'CSV'
  if (normalizedMimeType === 'application/msword') return 'DOC'
  if (
    normalizedMimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    return 'DOCX'
  }
  if (normalizedMimeType === 'application/vnd.ms-excel') return 'XLS'
  if (normalizedMimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
    return 'XLSX'
  }
  if (normalizedMimeType === 'application/vnd.ms-powerpoint') return 'PPT'
  if (
    normalizedMimeType ===
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ) {
    return 'PPTX'
  }
  if (normalizedMimeType === 'application/pdf') return 'PDF'
  if (normalizedMimeType === 'application/zip') return 'ZIP'

  const subtype = normalizedMimeType
    .split('/')[1]
    ?.split('.')
    .pop()
    ?.split('+')[0]
    ?.trim()
    .toUpperCase()
  return subtype || 'FILE'
}

export const isBasicEditableFile = (fileName?: string, mimeType?: string): boolean => {
  const extension = getFileExtension(fileName)
  if (extension === '.txt' || extension === '.md' || extension === '.csv') return true

  const normalizedMimeType = normalizeFileMimeType(fileName, mimeType).toLowerCase()
  return BASIC_EDITABLE_MIME_TYPES.has(normalizedMimeType)
}

export const formatFileSize = (sizeBytes?: number): string | undefined => {
  if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes < 0)
    return undefined
  if (sizeBytes < 1024) return `${sizeBytes} B`
  if (sizeBytes < 1024 * 1024)
    return `${(sizeBytes / 1024).toFixed(sizeBytes < 10 * 1024 ? 1 : 0)} KB`
  if (sizeBytes < 1024 * 1024 * 1024) {
    return `${(sizeBytes / (1024 * 1024)).toFixed(sizeBytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
  }
  return `${(sizeBytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

type FileMetaLabelOptions = {
  editable?: boolean
  fileName?: string
  includeBadge?: boolean
  mimeType?: string
  sizeBytes?: number
}

export const buildFileMetaLabel = ({
  editable = false,
  fileName,
  includeBadge = false,
  mimeType,
  sizeBytes
}: FileMetaLabelOptions): string => {
  const kind = detectDisplayFileKind(fileName, mimeType)
  const parts = [getFileKindLabel(kind)]

  if (includeBadge) {
    parts.push(getFileBadgeText(fileName, mimeType))
  }

  const sizeLabel = formatFileSize(sizeBytes)
  if (sizeLabel) {
    parts.push(sizeLabel)
  }

  if (editable) {
    parts.push('Editable')
  }

  return parts.join(' | ')
}
