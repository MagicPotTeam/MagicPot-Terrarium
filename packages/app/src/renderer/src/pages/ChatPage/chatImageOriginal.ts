import { assembleBinaryChunks, BinaryChunkProtocolError } from '@shared/binaryChunkProtocol'
import type { ManagedMediaSvc } from '@shared/api/svcManagedMedia'
import type { ChatAttachment } from '@shared/api/svcLLMProxy'
import { MAX_LLM_REQUEST_IMAGE_SOURCE_BYTES } from '@shared/llm/chatAttachmentTransportLimits'
import { normalizeMediaReference } from '@shared/mediaReference'
import {
  InvalidChatImageSourceError,
  readBoundedLocalChatImageBlob
} from './boundedLocalChatImageReader'
import { normalizeLocalMediaUrl } from './chatPageShared'

const extensions = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
} as const
type ImageMime = keyof typeof extensions
const terminalMediaCodes = new Set([
  'MANAGED_MEDIA_MISSING',
  'MANAGED_MEDIA_CORRUPT',
  'MANAGED_MEDIA_REQUEST_SIZE_LIMIT',
  'VALIDATION_ERROR'
])

export function isTerminalChatImageSaveError(error: unknown): boolean {
  if (error instanceof InvalidChatImageSourceError || error instanceof BinaryChunkProtocolError)
    return true
  if (!error || typeof error !== 'object') return false
  if ('code' in error && typeof error.code === 'string' && terminalMediaCodes.has(error.code))
    return true
  // Ordinary unary IPC can lose the custom .code. Match only MAIN's public media errors
  // (including Electron's possible error-name prefix), not arbitrary network/IO messages.
  return (
    'message' in error &&
    typeof error.message === 'string' &&
    /^(?:ServiceError: )?(?:Managed media is (?:missing|corrupt)|Managed media exceeds the request byte limit)$/.test(
      error.message
    )
  )
}

function sniffImageMime(bytes: Uint8Array): ImageMime {
  const starts = (offset: number, ...prefix: number[]) =>
    prefix.every((byte, i) => bytes[offset + i] === byte)
  if (bytes.length > 8 && starts(0, 0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10)) return 'image/png'
  if (bytes.length > 3 && starts(0, 0xff, 0xd8, 0xff)) return 'image/jpeg'
  const ascii = (offset: number, text: string) =>
    text.split('').every((char, index) => bytes[offset + index] === char.charCodeAt(0))
  if (bytes.length > 6 && (ascii(0, 'GIF87a') || ascii(0, 'GIF89a'))) return 'image/gif'
  if (bytes.length > 12 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp'
  throw new InvalidChatImageSourceError('Empty or unsupported image bytes')
}

async function sha256Of(bytes: Uint8Array): Promise<string | undefined> {
  if (!globalThis.crypto?.subtle) return undefined
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

const readBlobBytes = (blob: Blob): Promise<Uint8Array> => {
  if (typeof blob.arrayBuffer === 'function')
    return blob.arrayBuffer().then((buffer) => new Uint8Array(buffer))
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () =>
      reader.result instanceof ArrayBuffer
        ? resolve(new Uint8Array(reader.result))
        : reject(new InvalidChatImageSourceError('Invalid image bytes'))
    reader.onerror = () => reject(reader.error || new Error('Unable to read image bytes'))
    reader.readAsArrayBuffer(blob)
  })
}

/** Read only bytes eligible for export. MAIN owns managed paths; when it cannot resolve
 * an original, propagate the failure without downloading a possibly unrelated attachment URL. */
export async function readChatImageForSave(
  attachment: ChatAttachment,
  service?: Pick<ManagedMediaSvc, 'materializeForRequest'>
) {
  const media = normalizeMediaReference(attachment.media)
  const managed = media?.kind === 'managed' ? media : undefined
  if (attachment.media?.kind === 'managed' && !managed)
    throw new InvalidChatImageSourceError('Invalid managed image reference')
  const maxBytes = MAX_LLM_REQUEST_IMAGE_SOURCE_BYTES
  const expectedSize = managed?.sizeBytes ?? attachment.sizeBytes
  if (
    expectedSize !== undefined &&
    (!Number.isSafeInteger(expectedSize) || expectedSize <= 0 || expectedSize > maxBytes)
  )
    throw new InvalidChatImageSourceError('Invalid image size')
  let data: Uint8Array
  let sha256: string | undefined
  if (managed && typeof service?.materializeForRequest === 'function') {
    const result = await service.materializeForRequest({
      reference: managed,
      transport: 'chunked-binary-v1',
      maxBytes: expectedSize ?? maxBytes
    })
    if (
      result?.transport !== 'chunked-binary-v1' ||
      result.reference?.sizeBytes !== managed.sizeBytes ||
      result.reference?.sha256 !== managed.sha256 ||
      result.reference.mimeType !== managed.mimeType
    )
      throw new InvalidChatImageSourceError('Managed image reference mismatch')
    data = await assembleBinaryChunks(result.reference, result.chunks)
    sha256 = result.reference.sha256
  } else {
    const response = await fetch(normalizeLocalMediaUrl(attachment.url))
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined)
      throw new Error(`Image read failed (${response.status})`)
    }
    const blob = await readBoundedLocalChatImageBlob(response, {
      maxBytes: expectedSize ?? maxBytes
    })
    if (expectedSize !== undefined && blob.size !== expectedSize)
      throw new InvalidChatImageSourceError('Image size mismatch')
    data = await readBlobBytes(blob)
    sha256 = await sha256Of(data)
    if (managed && sha256 !== managed.sha256)
      throw new InvalidChatImageSourceError('Managed image hash mismatch')
  }
  const mime = sniffImageMime(data)
  if (managed && mime !== managed.mimeType)
    throw new InvalidChatImageSourceError('Managed image format mismatch')
  return { data, extension: extensions[mime], sha256 }
}
