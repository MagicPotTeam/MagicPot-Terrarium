import {
  DEFERRED_COMFY_INLINE_MAX_BYTES,
  DEFERRED_COMFY_MASK_VALUE_PREFIX,
  DEFERRED_COMFY_PERSIST_MAX_BYTES,
  encodeDeferredComfyFileInputValue,
  encodeDeferredComfyImageInputValue,
  encodeDeferredComfyMaskInputValue,
  parseDeferredComfyFileInputValue,
  parseDeferredComfyMaskInputValue
} from '@shared/comfy/deferredImages'
import { api } from './windowUtils'

/**
 * Renderer-selected files are materialized in memory before crossing IPC. Keep that operation
 * substantially below the main-process IPC ceiling so a hostile or accidental huge File cannot
 * cause an unbounded allocation/copy spike.
 */
export { DEFERRED_COMFY_PERSIST_MAX_BYTES }
const DEFERRED_COMFY_FILE_NAME_MAX_CHARS = 255
const MIME_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu

const IMAGE_EXTENSIONS_TO_MIME: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp'
}

const normalizeMimeType = (value: unknown, fallbackMimeType: string): string => {
  const candidate = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return candidate && candidate.length <= 256 && MIME_TYPE_PATTERN.test(candidate)
    ? candidate
    : fallbackMimeType
}

const isFileNameSeparatorOrControl = (character: string): boolean => {
  const code = character.charCodeAt(0)
  return character === '/' || character === '\\' || code <= 0x1f || code === 0x7f
}

const normalizeDeferredFileName = (value: unknown, fallbackFileName: string): string => {
  const candidate = Array.from(String(value || '').trim(), (character) =>
    isFileNameSeparatorOrControl(character) ? '_' : character
  )
    .join('')
    .slice(0, DEFERRED_COMFY_FILE_NAME_MAX_CHARS)
    .replace(/[. ]+$/u, '')
  return candidate || fallbackFileName
}

const inferImageMimeType = (file: File, fallbackMimeType: string): string => {
  const fileType = normalizeMimeType(file.type, '')
  if (fileType.startsWith('image/')) return fileType
  const lowerName = String(file.name || '')
    .trim()
    .toLowerCase()
  const extension = Object.keys(IMAGE_EXTENSIONS_TO_MIME).find((candidate) =>
    lowerName.endsWith(candidate)
  )
  return (extension && IMAGE_EXTENSIONS_TO_MIME[extension]) || fallbackMimeType
}

const assertReadableBlobSize = (blob: Blob): number => {
  const size = blob.size
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error('Local Comfy input has an invalid file size.')
  }
  if (size > DEFERRED_COMFY_PERSIST_MAX_BYTES) {
    throw new Error(
      `Local Comfy input exceeds the ${DEFERRED_COMFY_PERSIST_MAX_BYTES}-byte renderer limit.`
    )
  }
  return size
}

const readBlobArrayBuffer = async (blob: Blob): Promise<ArrayBuffer> => {
  const expectedSize = assertReadableBlobSize(blob)
  const maybeArrayBuffer = (blob as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> }).arrayBuffer
  const result =
    typeof maybeArrayBuffer === 'function'
      ? await maybeArrayBuffer.call(blob)
      : await new Promise<ArrayBuffer>((resolve, reject) => {
          const reader = new FileReader()
          reader.onerror = () =>
            reject(reader.error || new Error('Failed to read local Comfy input.'))
          reader.onload = () =>
            reader.result instanceof ArrayBuffer
              ? resolve(reader.result)
              : reject(new Error('Failed to read local Comfy input.'))
          reader.readAsArrayBuffer(blob)
        })
  if (result.byteLength !== expectedSize) {
    throw new Error('Local Comfy input size changed while it was being read.')
  }
  return result
}

const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

const persistOrInline = async (input: {
  fileName: string
  mimeType: string
  buffer: ArrayBuffer
  encode: (value: {
    fileName: string
    mimeType: string
    sizeBytes: number
    filePath?: string
    dataUrl?: string
  }) => string
}): Promise<string> => {
  const bytes = new Uint8Array(input.buffer)
  try {
    const saved = await api().svcFs.saveQAppInputImage({
      filename: input.fileName,
      image: bytes
    })
    if (saved.fullPath) {
      return input.encode({
        fileName: input.fileName,
        mimeType: input.mimeType,
        sizeBytes: bytes.byteLength,
        filePath: saved.fullPath
      })
    }
  } catch (error) {
    console.warn('[DeferredComfyInput] Failed to persist local input:', error)
  }
  if (bytes.byteLength > DEFERRED_COMFY_INLINE_MAX_BYTES) {
    throw new Error('Local Comfy input cache is unavailable and the file is too large to inline.')
  }
  return input.encode({
    fileName: input.fileName,
    mimeType: input.mimeType,
    sizeBytes: bytes.byteLength,
    dataUrl: `data:${input.mimeType};base64,${arrayBufferToBase64(input.buffer)}`
  })
}

export const buildDeferredComfyFileValue = async (
  file: File,
  fallbackMimeType = 'application/octet-stream'
): Promise<string> => {
  const fileName = normalizeDeferredFileName(file.name, `file-${Date.now()}`)
  const mimeType = normalizeMimeType(file.type, fallbackMimeType)
  return await persistOrInline({
    fileName,
    mimeType,
    buffer: await readBlobArrayBuffer(file),
    encode: encodeDeferredComfyFileInputValue
  })
}

export const buildDeferredComfyImageValue = async (
  file: File,
  fallbackMimeType = 'image/png'
): Promise<string> => {
  const fileName = normalizeDeferredFileName(file.name, `image-${Date.now()}.png`)
  const mimeType = inferImageMimeType(file, fallbackMimeType)
  return await persistOrInline({
    fileName,
    mimeType,
    buffer: await readBlobArrayBuffer(file),
    encode: encodeDeferredComfyImageInputValue
  })
}

export const buildDeferredComfyMaskValue = async (input: {
  blob: Blob
  fileName: string
  originalValue: string
}): Promise<string> => {
  const fileName = normalizeDeferredFileName(input.fileName, `mask-${Date.now()}.png`)
  const blobType = normalizeMimeType(input.blob.type, '')
  const mimeType = blobType.startsWith('image/') ? blobType : 'image/png'
  const buffer = await readBlobArrayBuffer(input.blob)
  return await persistOrInline({
    fileName,
    mimeType,
    buffer,
    encode: (value) =>
      encodeDeferredComfyMaskInputValue({ ...value, originalValue: input.originalValue })
  })
}

export const getDeferredComfyLocalPreview = async (
  value: string
): Promise<{ dataUrl?: string; bytes?: Uint8Array; mimeType: string } | null> => {
  let deferred
  try {
    deferred = value.startsWith(DEFERRED_COMFY_MASK_VALUE_PREFIX)
      ? parseDeferredComfyMaskInputValue(value)
      : parseDeferredComfyFileInputValue(value)
  } catch {
    return null
  }
  if (!deferred) return null
  if (deferred.sizeBytes > DEFERRED_COMFY_PERSIST_MAX_BYTES) {
    throw new Error('Persisted local Comfy input exceeds the renderer preview limit.')
  }
  if (deferred.dataUrl) return { dataUrl: deferred.dataUrl, mimeType: deferred.mimeType }
  if (!deferred.filePath) return null
  const result = await api().svcFs.readImageFromPath({ fullPath: deferred.filePath })
  if (!(result.image instanceof Uint8Array) || result.image.byteLength !== deferred.sizeBytes) {
    throw new Error('Persisted local Comfy input size no longer matches its metadata.')
  }
  return { bytes: result.image, mimeType: deferred.mimeType }
}
