import path from 'node:path'
import { Readable } from 'node:stream'
import type { ChatAttachment, LLMChatResult } from '@shared/llm'
import { getChatMediaDir, sanitizeChatMediaScope } from './chatMediaDir'
import { importManagedMediaStream, ManagedMediaImportError } from './managedMediaStore'

export type PersistCodexImageArtifactsOptions = {
  enabled: boolean
  conversationId?: string
  responseId?: string
}

const DATA_IMAGE_URL_PATTERN = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i
const MAX_CODEX_IMAGE_ARTIFACT_BYTES = 64 * 1024 * 1024

const IMAGE_MIME_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
}

const readMetadataString = (
  metadata: Record<string, unknown> | undefined,
  key: string
): string | undefined => {
  const value = metadata?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

const sanitizeArtifactSegment = (value: string | undefined, fallback: string): string => {
  const normalized = sanitizeChatMediaScope(value)
  if (!normalized) return fallback
  const bounded = normalized.slice(0, 128).replace(/[-.]+$/u, '')
  return bounded || fallback
}

const extensionFromImageMimeType = (mimeType: string): string =>
  IMAGE_MIME_EXTENSION[mimeType.toLowerCase()] || 'png'

const normalizeArtifactFileName = (
  fileName: string | undefined,
  fallbackStem: string,
  mimeType: string
): string => {
  const candidate = String(fileName || '')
    .normalize('NFC')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    ?.trim()
  const stem = String(candidate || '')
    .replace(/\.[^.]*$/, '')
    .replace(/[<>:"|?*\p{Cc}]/gu, '-')
    .replace(/[. ]+$/u, '')
    .trim()
  const safeStem =
    stem && !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/iu.test(stem) ? stem : fallbackStem
  return `${safeStem}.${extensionFromImageMimeType(mimeType)}`
}

const parseDataImageUrl = (value: string): { mimeType: string; data: Buffer } | null => {
  const match = value.match(DATA_IMAGE_URL_PATTERN)
  if (!match) {
    return null
  }

  const mimeType = match[1].toLowerCase()
  if (!Object.prototype.hasOwnProperty.call(IMAGE_MIME_EXTENSION, mimeType)) {
    return null
  }

  const data = Buffer.from(match[2].replace(/\s+/g, ''), 'base64')
  if (data.length === 0 || data.length > MAX_CODEX_IMAGE_ARTIFACT_BYTES) {
    return null
  }

  return { mimeType, data }
}

export const persistCodexImageArtifacts = async (
  result: LLMChatResult,
  options: PersistCodexImageArtifactsOptions
): Promise<LLMChatResult> => {
  if (!options.enabled || !result.attachments?.length) {
    return result
  }

  const metadataConversationId = readMetadataString(result.metadata, 'conversationId')
  const metadataResponseId = readMetadataString(result.metadata, 'responseId')
  const scope = sanitizeArtifactSegment(
    options.conversationId || metadataConversationId || options.responseId || metadataResponseId,
    'codex-image'
  )
  const authorizedRoot = getChatMediaDir()
  const chatMediaRoot = path.join(authorizedRoot, `codex-images-${scope}`)
  const persistedAttachments: ChatAttachment[] = []
  let changed = false

  for (let index = 0; index < result.attachments.length; index++) {
    const attachment = result.attachments[index]
    if (attachment.type !== 'image') {
      persistedAttachments.push(attachment)
      continue
    }

    const parsed = parseDataImageUrl(attachment.url)
    if (!parsed) {
      persistedAttachments.push(attachment)
      continue
    }

    const responseSegment = sanitizeArtifactSegment(
      options.responseId || metadataResponseId,
      `image-${Date.now()}`
    )
    const fileName = normalizeArtifactFileName(
      attachment.fileName,
      `${responseSegment}-${index + 1}`,
      parsed.mimeType
    )
    try {
      const imported = await importManagedMediaStream(
        {
          chatMediaRoot,
          stream: Readable.from([parsed.data]),
          mimeType: parsed.mimeType,
          originalFileName: fileName,
          provenance: {
            source: 'codex-generated',
            conversationId: options.conversationId || metadataConversationId,
            responseId: options.responseId || metadataResponseId,
            attachmentIndex: index
          },
          maxBytes: MAX_CODEX_IMAGE_ARTIFACT_BYTES
        },
        { authorizedRoot }
      )
      const relativePath = path
        .relative(authorizedRoot, imported.absolutePath)
        .split(path.sep)
        .join('/')

      persistedAttachments.push({
        ...attachment,
        url: imported.localMediaUrl,
        media: { ...imported.reference, relativePath },
        mimeType: imported.reference.mimeType,
        fileName,
        sizeBytes: imported.reference.sizeBytes,
        metadata: {
          ...(attachment.metadata || {}),
          codexArtifact: true,
          savedPath: imported.absolutePath,
          fileUrl: imported.localMediaUrl,
          localMediaUrl: imported.localMediaUrl
        }
      })
      changed = true
    } catch (error) {
      if (!(error instanceof ManagedMediaImportError)) {
        throw error
      }
      persistedAttachments.push(attachment)
    }
  }

  return changed
    ? {
        ...result,
        attachments: persistedAttachments
      }
    : result
}
