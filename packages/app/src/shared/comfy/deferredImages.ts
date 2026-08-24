export const DEFERRED_COMFY_IMAGE_VALUE_PREFIX = 'MAGICPOT_DEFERRED_COMFY_IMAGE:'
export const DEFERRED_COMFY_FILE_VALUE_PREFIX = 'MAGICPOT_DEFERRED_COMFY_FILE:'
export const DEFERRED_COMFY_MASK_VALUE_PREFIX = 'MAGICPOT_DEFERRED_COMFY_MASK:'
export const DEFERRED_COMFY_INLINE_MAX_BYTES = 16 * 1024 * 1024
export const DEFERRED_COMFY_PERSIST_MAX_BYTES = 128 * 1024 * 1024
const DEFERRED_COMFY_ENCODED_MAX_CHARS = DEFERRED_COMFY_INLINE_MAX_BYTES * 4 + 64 * 1024
const DEFERRED_COMFY_FILE_NAME_MAX_CHARS = 255
const DEFERRED_COMFY_MIME_TYPE_MAX_CHARS = 256
const DEFERRED_COMFY_FILE_PATH_MAX_CHARS = 32 * 1024
const MIME_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u
const DEFERRED_COMFY_VALUE_PREFIXES = [
  DEFERRED_COMFY_IMAGE_VALUE_PREFIX,
  DEFERRED_COMFY_FILE_VALUE_PREFIX,
  DEFERRED_COMFY_MASK_VALUE_PREFIX
] as const

export class InvalidDeferredComfyInputValueError extends Error {
  constructor() {
    super('Invalid deferred Comfy input value.')
    this.name = 'InvalidDeferredComfyInputValueError'
  }
}

export const isDeferredComfyInputValue = (value: unknown): boolean =>
  typeof value === 'string' &&
  DEFERRED_COMFY_VALUE_PREFIXES.some((prefix) => value.startsWith(prefix))

export type DeferredComfyFileInputValue = {
  fileName: string
  mimeType: string
  /** Inline payload. Kept as a bounded fallback when the durable local cache is unavailable. */
  dataUrl?: string
  /** Durable app-local file path used for newly dragged/loaded files. */
  filePath?: string
  sizeBytes: number
}

export type DeferredComfyImageInputValue = DeferredComfyFileInputValue

export type DeferredComfyMaskInputValue = DeferredComfyFileInputValue & {
  /** Original image workflow value. It is materialized on the leased destination before the mask. */
  originalValue: string
}

const encode = (prefix: string, value: object): string =>
  `${prefix}${encodeURIComponent(JSON.stringify(value))}`

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const parseCanonicalBase64DataUrl = (
  dataUrl: string
): { mimeType: string; sizeBytes: number } | null => {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/u.exec(dataUrl)
  if (!match) return null
  const mimeType = match[1]
  const payload = match[2]
  if (
    !MIME_TYPE_PATTERN.test(mimeType) ||
    mimeType !== mimeType.toLowerCase() ||
    payload.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(payload)
  ) {
    return null
  }
  if (payload.endsWith('==')) {
    const sextet = BASE64_ALPHABET.indexOf(payload[payload.length - 3])
    if (sextet < 0 || (sextet & 0x0f) !== 0) return null
  } else if (payload.endsWith('=')) {
    const sextet = BASE64_ALPHABET.indexOf(payload[payload.length - 2])
    if (sextet < 0 || (sextet & 0x03) !== 0) return null
  }
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  return { mimeType, sizeBytes: (payload.length / 4) * 3 - padding }
}

export function encodeDeferredComfyFileInputValue(value: DeferredComfyFileInputValue): string {
  return encode(DEFERRED_COMFY_FILE_VALUE_PREFIX, value)
}

/** Backward-compatible image encoder used by existing saved form state and call sites. */
export function encodeDeferredComfyImageInputValue(value: DeferredComfyImageInputValue): string {
  return encode(DEFERRED_COMFY_IMAGE_VALUE_PREFIX, value)
}

export function encodeDeferredComfyMaskInputValue(value: DeferredComfyMaskInputValue): string {
  return encode(DEFERRED_COMFY_MASK_VALUE_PREFIX, value)
}

const isAbsoluteFilePath = (value: string): boolean =>
  /^(?:[a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)|\/)/u.test(value)

const hasControlCharacter = (value: string): boolean =>
  Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })

const hasFileNameSeparatorOrControl = (value: string): boolean =>
  Array.from(value).some(
    (character) => character === '/' || character === '\\' || hasControlCharacter(character)
  )

const parseFilePayload = (
  value: unknown,
  prefixes: readonly string[],
  options: { requireImageDataUrl?: boolean } = {}
): DeferredComfyFileInputValue | null => {
  if (typeof value !== 'string') return null
  const prefix = prefixes.find((candidate) => value.startsWith(candidate))
  if (!prefix) return null
  if (value.length > prefix.length + DEFERRED_COMFY_ENCODED_MAX_CHARS) {
    throw new InvalidDeferredComfyInputValueError()
  }

  try {
    const parsed = JSON.parse(
      decodeURIComponent(value.slice(prefix.length))
    ) as Partial<DeferredComfyFileInputValue>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new InvalidDeferredComfyInputValueError()
    }
    const dataUrl = typeof parsed.dataUrl === 'string' ? parsed.dataUrl : ''
    const filePath = typeof parsed.filePath === 'string' ? parsed.filePath : ''
    const fileName = typeof parsed.fileName === 'string' ? parsed.fileName : ''
    const mimeType = typeof parsed.mimeType === 'string' ? parsed.mimeType : ''
    const hasDataUrl = dataUrl.length > 0
    const hasFilePath = filePath.length > 0
    const sizeBytes =
      typeof parsed.sizeBytes === 'number' &&
      Number.isSafeInteger(parsed.sizeBytes) &&
      parsed.sizeBytes >= 0
        ? parsed.sizeBytes
        : null
    if (
      !fileName ||
      fileName !== fileName.trim() ||
      fileName.length > DEFERRED_COMFY_FILE_NAME_MAX_CHARS ||
      hasFileNameSeparatorOrControl(fileName) ||
      !mimeType ||
      mimeType !== mimeType.trim() ||
      mimeType !== mimeType.toLowerCase() ||
      mimeType.length > DEFERRED_COMFY_MIME_TYPE_MAX_CHARS ||
      !MIME_TYPE_PATTERN.test(mimeType) ||
      filePath !== filePath.trim() ||
      filePath.length > DEFERRED_COMFY_FILE_PATH_MAX_CHARS ||
      (hasFilePath && (!isAbsoluteFilePath(filePath) || hasControlCharacter(filePath))) ||
      sizeBytes === null ||
      hasDataUrl === hasFilePath
    ) {
      throw new InvalidDeferredComfyInputValueError()
    }
    if (hasDataUrl) {
      const parsedDataUrl = parseCanonicalBase64DataUrl(dataUrl)
      if (
        !parsedDataUrl ||
        parsedDataUrl.mimeType !== mimeType ||
        (options.requireImageDataUrl && !mimeType.startsWith('image/')) ||
        parsedDataUrl.sizeBytes !== sizeBytes ||
        parsedDataUrl.sizeBytes > DEFERRED_COMFY_INLINE_MAX_BYTES
      ) {
        throw new InvalidDeferredComfyInputValueError()
      }
    } else if (
      sizeBytes > DEFERRED_COMFY_PERSIST_MAX_BYTES ||
      (options.requireImageDataUrl && !mimeType.startsWith('image/'))
    ) {
      throw new InvalidDeferredComfyInputValueError()
    }

    return {
      fileName,
      mimeType,
      ...(hasDataUrl ? { dataUrl } : {}),
      ...(hasFilePath ? { filePath } : {}),
      sizeBytes
    }
  } catch (error) {
    if (error instanceof InvalidDeferredComfyInputValueError) throw error
    throw new InvalidDeferredComfyInputValueError()
  }
}

export function parseDeferredComfyFileInputValue(
  value: unknown
): DeferredComfyFileInputValue | null {
  return parseFilePayload(value, [
    DEFERRED_COMFY_FILE_VALUE_PREFIX,
    DEFERRED_COMFY_IMAGE_VALUE_PREFIX
  ])
}

export function parseDeferredComfyImageInputValue(
  value: unknown
): DeferredComfyImageInputValue | null {
  return parseFilePayload(
    value,
    [DEFERRED_COMFY_IMAGE_VALUE_PREFIX, DEFERRED_COMFY_FILE_VALUE_PREFIX],
    { requireImageDataUrl: true }
  )
}

export function parseDeferredComfyMaskInputValue(
  value: unknown
): DeferredComfyMaskInputValue | null {
  if (typeof value !== 'string') return null
  if (!value.startsWith(DEFERRED_COMFY_MASK_VALUE_PREFIX)) return null
  const file = parseFilePayload(value, [DEFERRED_COMFY_MASK_VALUE_PREFIX], {
    requireImageDataUrl: true
  })
  if (!file) return null
  try {
    const parsed = JSON.parse(
      decodeURIComponent(value.slice(DEFERRED_COMFY_MASK_VALUE_PREFIX.length))
    ) as Partial<DeferredComfyMaskInputValue>
    if (
      typeof parsed.originalValue !== 'string' ||
      !parsed.originalValue ||
      parsed.originalValue !== parsed.originalValue.trim() ||
      parsed.originalValue.length > DEFERRED_COMFY_ENCODED_MAX_CHARS
    ) {
      throw new InvalidDeferredComfyInputValueError()
    }
    return { ...file, originalValue: parsed.originalValue }
  } catch (error) {
    if (error instanceof InvalidDeferredComfyInputValueError) throw error
    throw new InvalidDeferredComfyInputValueError()
  }
}

export function getDeferredComfyFileDisplayName(value: string): string {
  try {
    return (
      parseDeferredComfyMaskInputValue(value)?.fileName ||
      parseDeferredComfyFileInputValue(value)?.fileName ||
      value
    )
  } catch (error) {
    if (error instanceof InvalidDeferredComfyInputValueError) return ''
    throw error
  }
}

export const getDeferredComfyImageDisplayName = getDeferredComfyFileDisplayName
