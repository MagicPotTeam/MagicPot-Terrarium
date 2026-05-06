import type { TargetSchemeFile } from '@shared/targetScheme'
import {
  detectDisplayFileKind,
  formatFileSize,
  getFileBadgeText,
  getFileKindLabel,
  normalizeFileMimeType
} from '@renderer/utils/fileDisplay'
import { extractOfficePreviewText } from '../ProjectCanvasPage/officePreviewUtils'

const TEXT_EXTENSIONS = new Set(['.txt', '.md'])
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const DOCUMENT_EXTENSIONS = new Set(['.pdf', '.docx'])
const SUPPORTED_EXTENSIONS = new Set([
  ...TEXT_EXTENSIONS,
  ...IMAGE_EXTENSIONS,
  ...DOCUMENT_EXTENSIONS
])

export const TARGET_SCHEME_SUPPORTED_FILE_TYPES = [
  'pdf',
  'docx',
  'txt',
  'md',
  'png',
  'jpg',
  'jpeg',
  'webp'
] as const

export const TARGET_SCHEME_SUPPORTED_FILE_TYPES_LABEL =
  TARGET_SCHEME_SUPPORTED_FILE_TYPES.join(' / ')

export const TARGET_SCHEME_FILE_ACCEPT = TARGET_SCHEME_SUPPORTED_FILE_TYPES.map(
  (extension) => `.${extension}`
).join(',')

const getFileExtension = (fileName: string): string => {
  const dotIndex = fileName.lastIndexOf('.')
  return dotIndex >= 0 ? fileName.slice(dotIndex).toLowerCase() : ''
}

const readFileAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
        return
      }
      reject(new Error('Failed to read file as data URL'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file as data URL'))
    reader.readAsDataURL(file)
  })

const normalizePlainText = (value: string): string => value.replace(/\r\n/g, '\n').trim()

const decodePdfLiteral = (value: string): string => {
  let decoded = ''

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (char !== '\\') {
      decoded += char
      continue
    }

    const next = value[index + 1]
    if (!next) break

    if (next === 'n') {
      decoded += '\n'
      index += 1
      continue
    }

    if (next === 'r') {
      decoded += '\r'
      index += 1
      continue
    }

    if (next === 't') {
      decoded += '\t'
      index += 1
      continue
    }

    if (next === 'b') {
      decoded += '\b'
      index += 1
      continue
    }

    if (next === 'f') {
      decoded += '\f'
      index += 1
      continue
    }

    if (/[0-7]/.test(next)) {
      const octal = value.slice(index + 1, index + 4).match(/^[0-7]{1,3}/)?.[0]
      if (octal) {
        decoded += String.fromCharCode(Number.parseInt(octal, 8))
        index += octal.length
        continue
      }
    }

    decoded += next
    index += 1
  }

  return decoded
}

const extractPdfPreviewText = async (file: File): Promise<string | null> => {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const raw = new TextDecoder('latin1').decode(bytes)
  const segments: string[] = []

  const literalPattern = /\((?:\\.|[^\\()])+\)\s*Tj/g
  for (const match of raw.matchAll(literalPattern)) {
    const literal = match[0].replace(/\)\s*Tj$/, '').slice(1)
    const decoded = decodePdfLiteral(literal).replace(/\s+/g, ' ').trim()
    if (decoded) {
      segments.push(decoded)
    }
  }

  const arrayPattern = /\[(.*?)\]\s*TJ/gs
  for (const match of raw.matchAll(arrayPattern)) {
    const literalMatches = match[1]?.match(/\((?:\\.|[^\\()])+\)/g) || []
    const decoded = literalMatches
      .map((literal) => decodePdfLiteral(literal.slice(1, -1)).replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' ')
      .trim()

    if (decoded) {
      segments.push(decoded)
    }
  }

  const uniqueSegments = Array.from(new Set(segments))
  if (uniqueSegments.length === 0) {
    return null
  }

  const preview = uniqueSegments.join('\n').trim()
  return preview.length > 2000 ? `${preview.slice(0, 2000)}...` : preview
}

const buildPdfFallbackText = (file: File): string =>
  [
    `PDF 规则文件：${file.name}`,
    '已导入这个 PDF 文件，但当前无法稳定提取正文内容。',
    '如需让目标更准确，请在这里补充这份 PDF 的关键规则摘要。'
  ].join('\n')

const buildImageReferenceText = (file: File, mimeType: string): string => {
  const kindLabel = getFileKindLabel(detectDisplayFileKind(file.name, mimeType))
  const badge = getFileBadgeText(file.name, mimeType)
  const sizeLabel = formatFileSize(file.size)

  return [
    `图片规则参考：${file.name}`,
    `类型：${kindLabel}${badge ? ` / ${badge}` : ''}${sizeLabel ? ` / ${sizeLabel}` : ''}`,
    '目标执行时会把这张图片作为视觉参考，一起发送给模型。',
    '你也可以在这里补充这张参考图需要重点关注的目标要求。'
  ].join('\n')
}

const buildDocumentReferenceText = (file: File, previewText: string | null): string => {
  if (previewText?.trim()) {
    return previewText.trim()
  }

  return [
    `文档规则文件：${file.name}`,
    '已导入这个文档，但当前没有提取到可用文本。',
    '你可以在这里补充需要模型遵循的规则摘要。'
  ].join('\n')
}

export const isSupportedTargetSchemeFile = (file: Pick<File, 'name'>): boolean =>
  SUPPORTED_EXTENSIONS.has(getFileExtension(file.name))

export const listUnsupportedTargetSchemeFiles = (files: File[]): File[] =>
  files.filter((file) => !isSupportedTargetSchemeFile(file))

export const isTargetSchemeImageFile = (
  file: Pick<TargetSchemeFile, 'name' | 'mimeType' | 'attachmentUrl'>
): boolean => {
  const mimeType = normalizeFileMimeType(file.name, file.mimeType)
  return Boolean(file.attachmentUrl) && mimeType.startsWith('image/')
}

export const getTargetSchemeFileSummary = (
  file: Pick<TargetSchemeFile, 'name' | 'mimeType' | 'sizeBytes' | 'attachmentUrl'>
): string => {
  const mimeType = normalizeFileMimeType(file.name, file.mimeType)
  const kind = detectDisplayFileKind(file.name, mimeType)
  const parts = [getFileKindLabel(kind), getFileBadgeText(file.name, mimeType)]
  const sizeLabel = formatFileSize(file.sizeBytes)
  if (sizeLabel) parts.push(sizeLabel)
  if (isTargetSchemeImageFile(file)) parts.push('图片参考')
  return parts.filter(Boolean).join(' / ')
}

export const importTargetSchemeFile = async (
  file: File,
  createId: (prefix: string) => string
): Promise<TargetSchemeFile> => {
  const extension = getFileExtension(file.name)
  const mimeType = normalizeFileMimeType(file.name, file.type)

  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw new Error(`Unsupported file type: ${file.name}`)
  }

  if (TEXT_EXTENSIONS.has(extension)) {
    const text = normalizePlainText(await file.text())
    return {
      id: createId('target_file'),
      name: file.name,
      language: extension === '.md' ? 'markdown' : 'text',
      mimeType,
      sizeBytes: file.size,
      content: text
    }
  }

  if (extension === '.docx') {
    const previewText = await extractOfficePreviewText(file)
    return {
      id: createId('target_file'),
      name: file.name,
      language: 'text',
      mimeType,
      sizeBytes: file.size,
      content: buildDocumentReferenceText(file, previewText)
    }
  }

  if (extension === '.pdf') {
    const previewText = await extractPdfPreviewText(file)
    return {
      id: createId('target_file'),
      name: file.name,
      language: 'text',
      mimeType,
      sizeBytes: file.size,
      content: previewText || buildPdfFallbackText(file)
    }
  }

  const attachmentUrl = await readFileAsDataUrl(file)
  return {
    id: createId('target_file'),
    name: file.name,
    language: 'image-reference',
    mimeType,
    sizeBytes: file.size,
    attachmentUrl,
    content: buildImageReferenceText(file, mimeType)
  }
}
