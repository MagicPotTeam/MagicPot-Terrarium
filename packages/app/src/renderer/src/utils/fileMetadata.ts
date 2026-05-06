import { formatFileSize } from './fileUtils'

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
  '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
  '.zip': 'application/zip'
}

const KIND_LABELS: Record<DisplayFileKind, string> = {
  archive: 'Archive',
  excel: 'Excel',
  generic: 'File',
  markdown: 'Markdown',
  pdf: 'PDF',
  powerpoint: 'PowerPoint',
  text: 'Text',
  word: 'Word'
}

const KIND_TONES: Record<
  DisplayFileKind,
  { accent: string; badgeFill: string; badgeStroke: string; surface: string }
> = {
  archive: {
    accent: '#d8b4fe',
    badgeFill: 'rgba(168,85,247,0.18)',
    badgeStroke: 'rgba(192,132,252,0.40)',
    surface: 'rgba(59,7,100,0.42)'
  },
  excel: {
    accent: '#86efac',
    badgeFill: 'rgba(34,197,94,0.18)',
    badgeStroke: 'rgba(74,222,128,0.38)',
    surface: 'rgba(20,43,31,0.56)'
  },
  generic: {
    accent: '#cbd5e1',
    badgeFill: 'rgba(148,163,184,0.18)',
    badgeStroke: 'rgba(148,163,184,0.34)',
    surface: 'rgba(15,23,42,0.56)'
  },
  markdown: {
    accent: '#86efac',
    badgeFill: 'rgba(34,197,94,0.18)',
    badgeStroke: 'rgba(74,222,128,0.38)',
    surface: 'rgba(20,43,31,0.56)'
  },
  pdf: {
    accent: '#fca5a5',
    badgeFill: 'rgba(239,68,68,0.18)',
    badgeStroke: 'rgba(248,113,113,0.42)',
    surface: 'rgba(69,10,10,0.44)'
  },
  powerpoint: {
    accent: '#fdba74',
    badgeFill: 'rgba(249,115,22,0.18)',
    badgeStroke: 'rgba(251,146,60,0.42)',
    surface: 'rgba(60,29,12,0.50)'
  },
  text: {
    accent: '#7dd3fc',
    badgeFill: 'rgba(14,165,233,0.18)',
    badgeStroke: 'rgba(56,189,248,0.42)',
    surface: 'rgba(8,47,73,0.50)'
  },
  word: {
    accent: '#93c5fd',
    badgeFill: 'rgba(59,130,246,0.18)',
    badgeStroke: 'rgba(96,165,250,0.42)',
    surface: 'rgba(17,24,39,0.58)'
  }
}

const BASIC_EDITABLE_MIME_TYPES = new Set(['text/plain', 'text/markdown', 'text/csv'])

export function getFileExtension(fileName?: string | null): string {
  if (!fileName) return ''
  const dotIndex = fileName.lastIndexOf('.')
  return dotIndex >= 0 ? fileName.slice(dotIndex).toLowerCase() : ''
}

export function normalizeFileMimeType(fileName?: string | null, mimeType?: string | null): string {
  const trimmedMimeType = mimeType?.trim()
  if (trimmedMimeType && trimmedMimeType !== 'application/octet-stream') {
    return trimmedMimeType
  }

  const extension = getFileExtension(fileName)
  return FILE_MIME_BY_EXTENSION[extension] || trimmedMimeType || 'application/octet-stream'
}

export function detectDisplayFileKind(
  fileName?: string | null,
  mimeType?: string | null
): DisplayFileKind {
  const extension = getFileExtension(fileName)
  if (extension === '.zip') return 'archive'
  if (extension === '.xls' || extension === '.xlsx' || extension === '.csv') return 'excel'
  if (extension === '.md') return 'markdown'
  if (extension === '.pdf') return 'pdf'
  if (extension === '.txt') return 'text'
  if (extension === '.doc' || extension === '.docx') return 'word'
  if (extension === '.ppt' || extension === '.pptx') return 'powerpoint'

  const normalizedMimeType = normalizeFileMimeType(fileName, mimeType).toLowerCase()
  if (normalizedMimeType.includes('zip')) return 'archive'
  if (
    normalizedMimeType === 'application/vnd.ms-excel' ||
    normalizedMimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    normalizedMimeType === 'text/csv'
  ) {
    return 'excel'
  }
  if (normalizedMimeType === 'text/markdown') return 'markdown'
  if (normalizedMimeType === 'application/pdf') return 'pdf'
  if (normalizedMimeType === 'text/plain') return 'text'
  if (
    normalizedMimeType === 'application/msword' ||
    normalizedMimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    return 'word'
  }
  if (
    normalizedMimeType === 'application/vnd.ms-powerpoint' ||
    normalizedMimeType ===
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ) {
    return 'powerpoint'
  }

  return 'generic'
}

export function getFileBadgeText(fileName?: string | null, mimeType?: string | null): string {
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

export function isBasicEditableFile(fileName?: string | null, mimeType?: string | null): boolean {
  const extension = getFileExtension(fileName)
  if (extension === '.txt' || extension === '.md' || extension === '.csv') {
    return true
  }

  const normalizedMimeType = normalizeFileMimeType(fileName, mimeType).toLowerCase()
  return BASIC_EDITABLE_MIME_TYPES.has(normalizedMimeType)
}

export function getFileKindLabel(fileName?: string | null, mimeType?: string | null): string {
  return KIND_LABELS[detectDisplayFileKind(fileName, mimeType)]
}

export function getFileTone(fileName?: string | null, mimeType?: string | null) {
  return KIND_TONES[detectDisplayFileKind(fileName, mimeType)]
}

export function buildFileMetaLine(options: {
  fileName?: string | null
  mimeType?: string | null
  sizeBytes?: number | null
  editable?: boolean
}): string {
  const parts = [
    getFileKindLabel(options.fileName, options.mimeType),
    getFileBadgeText(options.fileName, options.mimeType)
  ]
  if (
    typeof options.sizeBytes === 'number' &&
    Number.isFinite(options.sizeBytes) &&
    options.sizeBytes >= 0
  ) {
    parts.push(formatFileSize(options.sizeBytes))
  }
  if (typeof options.editable === 'boolean') {
    parts.push(options.editable ? 'Editable' : 'Read only')
  }
  return parts.join(' | ')
}
