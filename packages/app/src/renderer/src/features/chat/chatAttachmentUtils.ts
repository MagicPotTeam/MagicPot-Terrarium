import type { ChatAttachment } from '@shared/api/svcLLMProxy'
import { MAX_CHAT_IMAGE_PREPARATION_BATCH_SOURCE_BYTES } from '@shared/llm/chatAttachmentTransportLimits'
import { normalizeMediaReference, type MediaReference } from '@shared/mediaReference'

export type ResolveChatAttachmentSourceOptions = {
  mediaLookup?: (media: MediaReference) => string | null | undefined
}

export type ResolvedChatAttachmentSource =
  | { status: 'resolved'; url: string; source: 'url' | 'media' }
  | {
      status: 'unavailable'
      reason: 'missing-source' | 'media-lookup-unavailable' | 'media-not-found'
    }

export const resolveChatAttachmentSource = (
  attachment: ChatAttachment,
  options: ResolveChatAttachmentSourceOptions = {}
): ResolvedChatAttachmentSource => {
  if (typeof attachment.url === 'string' && attachment.url.trim()) {
    return { status: 'resolved', url: attachment.url, source: 'url' }
  }

  if (!attachment.media) {
    return { status: 'unavailable', reason: 'missing-source' }
  }
  if (!options.mediaLookup) {
    return { status: 'unavailable', reason: 'media-lookup-unavailable' }
  }

  const managedSource = options.mediaLookup(attachment.media)
  if (typeof managedSource === 'string' && managedSource.trim()) {
    return { status: 'resolved', url: managedSource, source: 'media' }
  }
  return { status: 'unavailable', reason: 'media-not-found' }
}

export const CHAT_MODEL3D_EXTENSIONS = [
  '.glb',
  '.gltf',
  '.obj',
  '.fbx',
  '.dae',
  '.3ds',
  '.ply',
  '.stl'
]

export const getChatAttachmentTypeForFile = (
  file: Pick<File, 'name' | 'type'>
): ChatAttachment['type'] => {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('video/')) return 'video'
  if (
    (!file.type || file.type === 'application/octet-stream') &&
    /\.(?:png|jpe?g|webp|gif)$/i.test(file.name)
  )
    return 'image'

  const extensionIndex = file.name.lastIndexOf('.')
  const extension = extensionIndex >= 0 ? file.name.toLowerCase().slice(extensionIndex) : ''
  if (CHAT_MODEL3D_EXTENSIONS.includes(extension)) return 'model3d'

  return 'file'
}

export const getChatAttachmentMaxSizeMB = (type: ChatAttachment['type']): number => {
  if (type === 'video') return 500
  if (type === 'model3d') return 200
  if (type === 'image') return 5
  return 10
}

/**
 * Largest total of image bytes the composer accepts for one message on the built-in OpenAI
 * Responses route: MAIN's image preparation batch limit (32 MiB of original bytes per
 * request). With the per-image limit alone, 8 images of 4.9 MB were accepted and the
 * request was then refused after the message had been posted. The composer applies it only
 * where that route is certain (resolveComposerImageByteBudgetRoute); other routes keep
 * their send-time checks.
 */
export const CHAT_MESSAGE_IMAGE_BATCH_MAX_BYTES = MAX_CHAT_IMAGE_PREPARATION_BATCH_SOURCE_BYTES

const isByteCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const MAX_DATA_URL_HEADER_CHARS = 4096
const NON_BASE64_CHAR = /[^A-Za-z0-9+/=]/g

/**
 * Bytes an image attachment of the composer will send, known from its descriptor only and
 * counted as the send-time check counts them (describeRequestImageSize): the managed media
 * size, or the length of a well-formed base64 data URL. The descriptor's own sizeBytes is
 * never trusted. 0 for anything else (not an image, or a size not known without reading).
 */
export const getKnownChatImageBytes = (attachment: ChatAttachment | null | undefined): number => {
  if (attachment?.type !== 'image') return 0
  const media = normalizeMediaReference(attachment.media)
  if (media?.kind === 'managed') return isByteCount(media.sizeBytes) ? media.sizeBytes : 0
  const url = typeof attachment.url === 'string' ? attachment.url : ''
  if (url.slice(0, 5).toLowerCase() !== 'data:') return 0
  const comma = url.indexOf(',')
  if (comma < 0 || comma > MAX_DATA_URL_HEADER_CHARS) return 0
  if (!/;base64$/i.test(url.slice(0, comma))) return 0
  const payloadChars = url.length - comma - 1
  if (payloadChars <= 0 || payloadChars % 4 !== 0) return 0
  NON_BASE64_CHAR.lastIndex = comma + 1
  if (NON_BASE64_CHAR.exec(url)) return 0
  const padding = url.endsWith('==') ? 2 : url.endsWith('=') ? 1 : 0
  return (payloadChars / 4) * 3 - padding
}

export type ChatImageBatchBudget = {
  /** Whether every incoming image fits next to the images already in the message. */
  fits: boolean
  /** Image bytes the message already holds. */
  usedBytes: number
  /** Image bytes of the incoming batch. */
  incomingBytes: number
  /** Image bytes the message can still take before this batch. */
  remainingBytes: number
}

/**
 * Whether a batch of incoming images (their byte sizes; 0 for a non-image) fits the
 * per-message image budget next to the images already in `existing`. A batch is taken
 * whole or not at all, as the composer's other attach checks do.
 */
export const resolveChatImageBatchBudget = (
  existing: readonly ChatAttachment[],
  incomingImageBytes: readonly number[],
  maxBytes: number = CHAT_MESSAGE_IMAGE_BATCH_MAX_BYTES
): ChatImageBatchBudget => {
  const usedBytes = existing.reduce(
    (total, attachment) => total + getKnownChatImageBytes(attachment),
    0
  )
  const incomingBytes = incomingImageBytes.reduce(
    (total, bytes) => total + (isByteCount(bytes) ? bytes : 0),
    0
  )
  const remainingBytes = Math.max(0, maxBytes - usedBytes)
  return {
    fits: incomingBytes === 0 || incomingBytes <= remainingBytes,
    usedBytes,
    incomingBytes,
    remainingBytes
  }
}

type FileWithOptionalPath = File & { path?: unknown }

export const getLocalFilePath = (file: File): string => {
  const candidate = (file as FileWithOptionalPath).path
  return typeof candidate === 'string' ? candidate.replace(/\\/g, '/') : ''
}

export const summarizeChatAttachmentsForLog = (attachments: ChatAttachment[] | undefined) =>
  attachments?.map((attachment) => ({
    type: attachment.type,
    fileName: attachment.fileName,
    relativePath: attachment.relativePath,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    sourceWidth: attachment.sourceWidth,
    sourceHeight: attachment.sourceHeight,
    url:
      typeof attachment.url === 'string'
        ? attachment.url.startsWith('data:')
          ? `[data-url length=${attachment.url.length}]`
          : attachment.url
        : attachment.url
  }))
