import type { ChatAttachment } from '@shared/api/svcLLMProxy'
import type { CanvasTargetEvidenceMode } from '@shared/canvasTarget'
import type { TargetScheme } from '@shared/targetScheme'
import { normalizeChatAttachmentsForRequest } from '@renderer/utils/chatAttachmentRequestUtils'
import { normalizeFileMimeType } from '@renderer/utils/fileDisplay'

import { normalizeLocalMediaUrl } from '../ChatPage/chatPageShared'
import { buildCanvasAgentAttachments } from './canvasAgentAttachmentUtils'
import { normalizeCanvasTargetEvidenceMode } from './canvasTargetEvidence'
import type { CanvasItem } from './types'

export type CanvasTargetSchemeImageAttachment = {
  fileId: string
  attachment: ChatAttachment
}

export type CanvasTargetSourceAttachment = ChatAttachment

export function buildCanvasTargetSchemeImageAttachments(
  scheme: TargetScheme
): CanvasTargetSchemeImageAttachment[] {
  return scheme.files
    .filter(
      (file) =>
        Boolean(file.attachmentUrl) &&
        ((file.mimeType || '').startsWith('image/') || /\.(png|jpg|jpeg|webp)$/i.test(file.name))
    )
    .map((file) => ({
      fileId: file.id,
      attachment: {
        type: 'image',
        url: file.attachmentUrl as string,
        mimeType: file.mimeType || 'image/png',
        fileName: file.name,
        sizeBytes: file.sizeBytes
      }
    }))
}

export function buildCanvasTargetSourceAttachments(
  targetItems: CanvasItem[]
): CanvasTargetSourceAttachment[] {
  return buildCanvasAgentAttachments(targetItems)
}

export function shouldAttachCanvasTargetSelectionSnapshot(options: {
  targetItems: CanvasItem[]
  sourceAttachments?: ChatAttachment[]
}): boolean {
  if (options.targetItems.length !== 1) {
    return true
  }

  const [targetItem] = options.targetItems
  const sourceAttachments = options.sourceAttachments || []
  if (targetItem?.type !== 'image' || sourceAttachments.length !== 1) {
    return true
  }

  return sourceAttachments[0]?.type !== 'image'
}

export function resolveCanvasTargetEvidenceAttachments(options: {
  evidenceMode?: CanvasTargetEvidenceMode
  sourceAttachments?: ChatAttachment[]
  snapshotAttachment?: ChatAttachment | null
  includeSelectionSnapshot?: boolean
}): {
  sourceAttachments: ChatAttachment[]
  snapshotAttachment: ChatAttachment | null
} {
  const evidenceMode = normalizeCanvasTargetEvidenceMode(options.evidenceMode)
  const sourceAttachments =
    evidenceMode === 'selected_sources' ? options.sourceAttachments || [] : []
  const snapshotAttachment =
    evidenceMode !== 'structured_only' && options.includeSelectionSnapshot !== false
      ? options.snapshotAttachment || null
      : null

  return {
    sourceAttachments,
    snapshotAttachment
  }
}

export function buildCanvasTargetAttachments(options: {
  sourceAttachments?: ChatAttachment[]
  snapshotAttachment?: ChatAttachment | null
  schemeImageAttachments?: CanvasTargetSchemeImageAttachment[]
  allowedSchemeFileIds?: string[] | null
}): ChatAttachment[] {
  const allowedFileIds = new Set(
    (options.allowedSchemeFileIds || [])
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean)
  )

  const filteredSchemeAttachments =
    allowedFileIds.size > 0
      ? (options.schemeImageAttachments || [])
          .filter((entry) => allowedFileIds.has(entry.fileId))
          .map((entry) => ({
            ...entry.attachment,
            hiddenFromChatView: true
          }))
      : (options.schemeImageAttachments || []).map((entry) => ({
          ...entry.attachment,
          hiddenFromChatView: true
        }))

  return [
    ...(options.sourceAttachments || []),
    ...(options.snapshotAttachment
      ? [
          {
            ...options.snapshotAttachment,
            hiddenFromChatView: true
          }
        ]
      : []),
    ...filteredSchemeAttachments
  ]
}

const CANVAS_TARGET_OCR_SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg'])
const CANVAS_TARGET_OCR_SUPPORTED_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg'])
const CANVAS_TARGET_OCR_SUPPORTED_FILE_MIME_TYPES = new Set(['application/pdf'])
const CANVAS_TARGET_OCR_SUPPORTED_FILE_EXTENSIONS = new Set(['pdf'])
const CANVAS_TARGET_OCR_MAX_IMAGE_BYTES = 10 * 1024 * 1024
const CANVAS_TARGET_OCR_MAX_FILE_BYTES = 50 * 1024 * 1024

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let index = 0; index < bytes.byteLength; index += 1) {
    binary += String.fromCharCode(bytes[index])
  }
  return btoa(binary)
}

function resolveCanvasTargetAttachmentExtension(
  attachment: Pick<ChatAttachment, 'fileName' | 'url'>
) {
  const fromFileName = attachment.fileName?.trim()
  if (fromFileName) {
    const lastDot = fromFileName.lastIndexOf('.')
    if (lastDot >= 0 && lastDot < fromFileName.length - 1) {
      return fromFileName.slice(lastDot + 1).toLowerCase()
    }
  }

  const normalizedUrl = attachment.url?.trim()
  if (!normalizedUrl || normalizedUrl.startsWith('data:') || normalizedUrl.startsWith('blob:')) {
    return undefined
  }

  try {
    const normalizedLocalUrl = normalizeLocalMediaUrl(normalizedUrl)
    const parsed = new URL(normalizedLocalUrl)
    const fileName = decodeURIComponent(parsed.pathname.split('/').pop() || '')
    const lastDot = fileName.lastIndexOf('.')
    if (lastDot >= 0 && lastDot < fileName.length - 1) {
      return fileName.slice(lastDot + 1).toLowerCase()
    }
  } catch {
    const fileName = normalizedUrl.split(/[\\/]/).pop() || ''
    const lastDot = fileName.lastIndexOf('.')
    if (lastDot >= 0 && lastDot < fileName.length - 1) {
      return fileName.slice(lastDot + 1).toLowerCase()
    }
  }

  return undefined
}

function inferCanvasTargetAttachmentMimeType(attachment: ChatAttachment): string | undefined {
  const normalizedMimeType = normalizeFileMimeType(attachment.fileName, attachment.mimeType)
  if (normalizedMimeType && normalizedMimeType !== 'application/octet-stream') {
    return normalizedMimeType
  }

  const normalizedUrl = attachment.url?.trim()
  if (normalizedUrl?.startsWith('data:')) {
    const mimeMatch = normalizedUrl.match(/^data:([^;,]+)/i)
    if (mimeMatch?.[1]) {
      return normalizeFileMimeType(mimeMatch[1])
    }
  }

  const extension = resolveCanvasTargetAttachmentExtension(attachment)
  if (extension === 'png') return 'image/png'
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg'
  if (extension === 'pdf') return 'application/pdf'
  return undefined
}

function isCanvasTargetOcrSafeAttachment(attachment: ChatAttachment): boolean {
  const mimeType = inferCanvasTargetAttachmentMimeType(attachment)
  const extension = resolveCanvasTargetAttachmentExtension(attachment)

  if (attachment.type === 'image') {
    if (
      typeof attachment.sizeBytes === 'number' &&
      Number.isFinite(attachment.sizeBytes) &&
      attachment.sizeBytes > CANVAS_TARGET_OCR_MAX_IMAGE_BYTES
    ) {
      return false
    }

    return Boolean(
      (mimeType && CANVAS_TARGET_OCR_SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) ||
      (extension && CANVAS_TARGET_OCR_SUPPORTED_IMAGE_EXTENSIONS.has(extension))
    )
  }

  if (attachment.type === 'file') {
    if (
      typeof attachment.sizeBytes === 'number' &&
      Number.isFinite(attachment.sizeBytes) &&
      attachment.sizeBytes > CANVAS_TARGET_OCR_MAX_FILE_BYTES
    ) {
      return false
    }

    return Boolean(
      (mimeType && CANVAS_TARGET_OCR_SUPPORTED_FILE_MIME_TYPES.has(mimeType)) ||
      (extension && CANVAS_TARGET_OCR_SUPPORTED_FILE_EXTENSIONS.has(extension))
    )
  }

  return false
}

async function materializeCanvasTargetOcrAttachment(
  attachment: ChatAttachment
): Promise<ChatAttachment | null> {
  if (attachment.type !== 'image') {
    return attachment
  }

  const mimeType = inferCanvasTargetAttachmentMimeType(attachment) || 'image/png'
  const normalizedUrl = normalizeLocalMediaUrl(attachment.url || '').trim()
  if (!normalizedUrl) {
    return null
  }

  if (normalizedUrl.startsWith('data:') || /^https?:\/\//i.test(normalizedUrl)) {
    return {
      ...attachment,
      mimeType
    }
  }

  try {
    const response = await fetch(normalizedUrl)
    if (!response.ok) {
      throw new Error(`Failed to fetch attachment: ${response.status}`)
    }
    const buffer = await response.arrayBuffer()
    return {
      ...attachment,
      url: `data:${mimeType};base64,${arrayBufferToBase64(buffer)}`,
      mimeType,
      sizeBytes: attachment.sizeBytes ?? buffer.byteLength
    }
  } catch {
    return null
  }
}

export async function prepareCanvasTargetAttachmentsForProfile(
  attachments: ChatAttachment[] | undefined,
  profile?: {
    is_ocr_model?: boolean
  } | null
): Promise<ChatAttachment[] | undefined> {
  if (!attachments?.length) {
    return undefined
  }

  if (!profile?.is_ocr_model) {
    const normalizedAttachments = await normalizeChatAttachmentsForRequest(attachments)
    if (!normalizedAttachments?.length) {
      return undefined
    }

    return normalizedAttachments
  }

  const safeAttachments = attachments.filter(isCanvasTargetOcrSafeAttachment)
  if (safeAttachments.length === 0) {
    return undefined
  }

  const normalizedAttachments = await normalizeChatAttachmentsForRequest(safeAttachments)
  if (!normalizedAttachments?.length) {
    return undefined
  }

  const prepared: ChatAttachment[] = []
  for (const attachment of normalizedAttachments) {
    const nextAttachment = await materializeCanvasTargetOcrAttachment(attachment)
    if (nextAttachment) {
      prepared.push(nextAttachment)
    }
  }

  return prepared.length > 0 ? prepared : undefined
}
