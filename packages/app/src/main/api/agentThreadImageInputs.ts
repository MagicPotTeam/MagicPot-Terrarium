import { createHash } from 'node:crypto'
import type { ChatAttachment, ChatMessage } from '@shared/llm'
import { assembleBinaryChunks, validateBinaryChunkReference } from '@shared/binaryChunkProtocol'
import { inspectStillRaster } from '../utils/stillRaster'

export const THREAD_IMAGE_INPUT_MAX_BYTES = 20 * 1024 * 1024
const MAX_ENCODED = Math.ceil(THREAD_IMAGE_INPUT_MAX_BYTES / 3) * 4
export const THREAD_IMAGE_INPUT_MAX_PIXELS = 64 * 1024 * 1024
const limits = Object.freeze({
  maxBytes: THREAD_IMAGE_INPUT_MAX_BYTES,
  maxEdge: 16384,
  maxPixels: THREAD_IMAGE_INPUT_MAX_PIXELS
})
const invalid = (): never => {
  throw new Error(
    'Recent image is missing, unsupported or invalid; attach it again. No image was generated.'
  )
}
export type PreparedThreadImage = {
  dataUrl: string
  receipt: {
    sourceSha256: string
    sourceSizeBytes: number
    sourceMimeType: string
    sourceWidth: number
    sourceHeight: number
    sha256: string
    sizeBytes: number
    mimeType: string
    width: number
    height: number
    resized: boolean
  }
}

/** Snapshot only the last five supplied image attachments. Never parse message/tool
 * text, infer filesystem access from a URL/media field, or widen history selection.
 * Keep invalid entries as sentinels; a newer bad image must not silently select older.
 */
export function captureThreadRecentImages(
  messages: readonly ChatMessage[]
): Array<ChatAttachment | undefined> {
  const images: Array<ChatAttachment | undefined> = []
  for (let m = messages.length - 1; m >= 0 && images.length < 5; m--) {
    if (!['user', 'assistant'].includes(messages[m].role)) continue
    const attachments = messages[m].attachments ?? []
    for (let a = attachments.length - 1; a >= 0 && images.length < 5; a--) {
      const image = attachments[a]
      if (image.type !== 'image') continue
      try {
        if (typeof image.url !== 'string' || image.url.length > MAX_ENCODED + 64) invalid()
        if (image.binary) {
          const reference = validateBinaryChunkReference(image.binary.reference)
          if (
            image.binary.transport !== 'chunked-binary-v1' ||
            reference.sizeBytes > THREAD_IMAGE_INPUT_MAX_BYTES ||
            !Array.isArray(image.binary.chunks) ||
            image.binary.chunks.length !== reference.chunkCount ||
            image.binary.chunks.reduce(
              (sum, frame) =>
                sum +
                (typeof frame?.bytesBase64 === 'string'
                  ? frame.bytesBase64.length
                  : MAX_ENCODED + 1),
              0
            ) >
              MAX_ENCODED + 4 * reference.chunkCount
          )
            invalid()
        }
        images.push(
          structuredClone({
            type: 'image',
            url: image.url,
            mimeType: image.mimeType,
            ...(image.binary ? { binary: image.binary } : {})
          })
        )
      } catch {
        images.push(undefined)
      }
    }
  }
  return images
}

export function inspectThreadImageInput(bytes: Buffer, declaredMime: string | undefined) {
  const info = inspectStillRaster(bytes, limits)
  if ((declaredMime && declaredMime !== info.mimeType) || info.orientation !== 1) return invalid()
  return info
}

/** MAIN-owned bytes only. NativeImage is an existing decoder, not a new host or
 * interruptible sandbox. Structural/pixel budgets precede decode; check() discards
 * output after Stop/config/scope revocation but cannot preempt synchronous codecs.
 * Non-default EXIF orientation is refused: Electron does not promise to apply it.
 */
export async function prepareThreadImageBytes(
  bytes: Buffer,
  declaredMime: string | undefined,
  check: () => void
): Promise<PreparedThreadImage> {
  check()
  const info = inspectThreadImageInput(bytes, declaredMime)
  const sourceSha256 = createHash('sha256').update(bytes).digest('hex')
  const sourceSizeBytes = bytes.length
  const resized = Math.max(info.width, info.height) > 2048
  const scale = resized ? 2048 / Math.max(info.width, info.height) : 1
  const width = Math.max(1, Math.round(info.width * scale))
  const height = Math.max(1, Math.round(info.height * scale))
  let mimeType: string = info.mimeType
  if (info.mimeType === 'image/webp') {
    // Electron nativeImage cannot reliably verify WebP. Decode bounded local bytes
    // before upload, preserving original WebP on the wire when no resize is needed.
    const { default: sharp } = await import('sharp')
    check()
    let image = sharp(bytes, { limitInputPixels: limits.maxPixels, failOn: 'warning', pages: 1 })
    if (resized) image = image.resize(width, height, { fit: 'fill' })
    const output = await (resized ? image.png() : image.raw()).toBuffer({ resolveWithObject: true })
    check()
    if (output.info.width !== width || output.info.height !== height) return invalid()
    if (resized) {
      bytes = output.data
      mimeType = 'image/png'
    }
  } else {
    const { nativeImage } = await import('electron')
    check()
    const decoded = nativeImage.createFromBuffer(bytes)
    check()
    const size = decoded.getSize()
    if (decoded.isEmpty() || size.width !== info.width || size.height !== info.height)
      return invalid()
    if (resized) {
      const output = decoded.resize({ width, height, quality: 'best' })
      check()
      const actual = output.getSize()
      if (output.isEmpty() || actual.width !== width || actual.height !== height) return invalid()
      bytes = output.toPNG()
      mimeType = 'image/png'
    }
  }
  if (resized) {
    check()
    const prepared = inspectStillRaster(bytes, { ...limits, maxEdge: 2048, maxPixels: 2048 * 2048 })
    if (
      prepared.mimeType !== 'image/png' ||
      prepared.orientation !== 1 ||
      prepared.width !== width ||
      prepared.height !== height
    )
      return invalid()
  }
  check()
  return {
    dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`,
    receipt: {
      sourceSha256,
      sourceSizeBytes,
      sourceMimeType: info.mimeType,
      sourceWidth: info.width,
      sourceHeight: info.height,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.length,
      mimeType,
      width,
      height,
      resized
    }
  }
}

export async function prepareThreadInlineImage(
  image: ChatAttachment | undefined,
  check: () => void
): Promise<PreparedThreadImage> {
  check()
  if (!image) return invalid()
  let bytes: Buffer
  let mime = image.mimeType
  if (image.binary) {
    const reference = validateBinaryChunkReference(image.binary.reference)
    if (reference.sizeBytes > THREAD_IMAGE_INPUT_MAX_BYTES) return invalid()
    bytes = Buffer.from(await assembleBinaryChunks(reference, image.binary.chunks))
    check()
    if (mime && mime !== reference.mimeType) return invalid()
    mime = reference.mimeType
  } else {
    const prefix = /^data:(image\/(?:png|jpeg|webp));base64,/u.exec(image.url)
    if (!prefix) return invalid() // No HTTP, file/local-media URL, SVG, GIF or guessed path.
    const encoded = image.url.slice(prefix[0].length)
    if (!encoded.length || encoded.length > MAX_ENCODED || encoded.length % 4 !== 0)
      return invalid()
    bytes = Buffer.from(encoded, 'base64')
    if (
      !bytes.length ||
      bytes.length > THREAD_IMAGE_INPUT_MAX_BYTES ||
      bytes.toString('base64') !== encoded ||
      (mime && mime !== prefix[1])
    )
      return invalid()
    mime = prefix[1]
  }
  return prepareThreadImageBytes(bytes, mime, check)
}
