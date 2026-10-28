/**
 * Content-addressed binary transport shared by renderer, main and remote bridges.
 *
 * The protocol deliberately carries bytes as canonical base64 frames instead of paths or
 * data URLs. A receiver can therefore verify the complete object before publishing it to a
 * managed store, and a partial/duplicated frame set can never be mistaken for a valid asset.
 */

export const BINARY_CHUNK_PROTOCOL_VERSION = 1 as const
export const DEFAULT_BINARY_CHUNK_BYTES = 256 * 1024
export const MAX_BINARY_CHUNK_BYTES = 4 * 1024 * 1024
export const MAX_BINARY_CHUNK_COUNT = 4096
export const MAX_BINARY_OBJECT_BYTES = 256 * 1024 * 1024
export const BINARY_MIME_TYPE_MAX_LENGTH = 255

const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const MIME_TYPE_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+\/[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u

export type BinaryChunkReference = Readonly<{
  version: typeof BINARY_CHUNK_PROTOCOL_VERSION
  kind: 'content-addressed-binary'
  sha256: string
  sizeBytes: number
  mimeType: string
  chunkSize: number
  chunkCount: number
}>

export type BinaryChunkFrame = Readonly<{
  version: typeof BINARY_CHUNK_PROTOCOL_VERSION
  kind: 'content-addressed-binary-chunk'
  sha256: string
  index: number
  chunkCount: number
  bytesBase64: string
}>

/** Native sandboxes may supply local codecs/hashers without installing browser globals. */
export type BinaryChunkRuntime = Readonly<{
  decodeBase64?: (value: string) => Uint8Array
  encodeBase64?: (value: Uint8Array) => string
  sha256?: (value: Uint8Array) => string | Promise<string>
}>

export class BinaryChunkProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BinaryChunkProtocolError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

function assertSafeInteger(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new BinaryChunkProtocolError(`Invalid ${name}`)
  }
  return value
}

function assertSha256(value: unknown): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new BinaryChunkProtocolError('Invalid binary object hash')
  }
  return value
}

function assertMimeType(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > BINARY_MIME_TYPE_MAX_LENGTH ||
    !MIME_TYPE_PATTERN.test(value)
  ) {
    throw new BinaryChunkProtocolError('Invalid binary object MIME type')
  }
  return value.toLowerCase()
}

function canonicalBase64(value: unknown, runtime?: BinaryChunkRuntime): string {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) {
    throw new BinaryChunkProtocolError('Invalid binary chunk encoding')
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    throw new BinaryChunkProtocolError('Invalid binary chunk encoding')
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  if (padding > 0 && value.slice(0, -padding).includes('=')) {
    throw new BinaryChunkProtocolError('Invalid binary chunk encoding')
  }
  if (runtime?.decodeBase64 && runtime.encodeBase64) {
    let decoded: Uint8Array
    let reencoded: string
    try {
      decoded = runtime.decodeBase64(value)
      if (!(decoded instanceof Uint8Array)) throw new Error('Invalid binary codec output')
      reencoded = runtime.encodeBase64(decoded)
    } catch {
      throw new BinaryChunkProtocolError('Invalid binary chunk encoding')
    }
    if (reencoded !== value)
      throw new BinaryChunkProtocolError('Non-canonical binary chunk encoding')
    return value
  }
  if (typeof globalThis.atob !== 'function' || typeof globalThis.btoa !== 'function') {
    throw new BinaryChunkProtocolError('Binary chunk base64 is unavailable in this runtime')
  }
  let decoded: string
  try {
    decoded = globalThis.atob(value)
  } catch (error) {
    throw new BinaryChunkProtocolError('Invalid binary chunk encoding')
  }
  // atob accepts non-zero pad bits in some runtimes. Re-encoding makes the protocol canonical.
  let reencoded: string
  try {
    reencoded = globalThis.btoa(decoded)
  } catch (error) {
    throw new BinaryChunkProtocolError('Invalid binary chunk encoding')
  }
  if (reencoded !== value) throw new BinaryChunkProtocolError('Non-canonical binary chunk encoding')
  return value
}

function decodeBase64(value: string, runtime?: BinaryChunkRuntime): Uint8Array {
  canonicalBase64(value, runtime)
  if (runtime?.decodeBase64 && runtime.encodeBase64) return runtime.decodeBase64(value)
  const binary = globalThis.atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function encodeBase64(bytes: Uint8Array): string {
  if (typeof globalThis.btoa !== 'function') {
    throw new BinaryChunkProtocolError('Binary chunk base64 is unavailable in this runtime')
  }
  let binary = ''
  // Build bounded strings in one pass; callers are already limited to MAX_BINARY_CHUNK_BYTES.
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return globalThis.btoa(binary)
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new BinaryChunkProtocolError('Binary object hashing is unavailable in this runtime')
  }
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new Uint8Array(bytes) as Uint8Array<ArrayBuffer>
  )
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function normalizeReference(value: unknown): BinaryChunkReference {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'version',
      'kind',
      'sha256',
      'sizeBytes',
      'mimeType',
      'chunkSize',
      'chunkCount'
    ]) ||
    value.version !== BINARY_CHUNK_PROTOCOL_VERSION ||
    value.kind !== 'content-addressed-binary'
  ) {
    throw new BinaryChunkProtocolError('Invalid binary object reference')
  }
  const sha256 = assertSha256(value.sha256)
  const sizeBytes = assertSafeInteger(
    value.sizeBytes,
    'binary object size',
    1,
    MAX_BINARY_OBJECT_BYTES
  )
  const chunkSize = assertSafeInteger(
    value.chunkSize,
    'binary chunk size',
    1,
    MAX_BINARY_CHUNK_BYTES
  )
  const expectedChunkCount = Math.ceil(sizeBytes / chunkSize)
  const chunkCount = assertSafeInteger(
    value.chunkCount,
    'binary chunk count',
    1,
    MAX_BINARY_CHUNK_COUNT
  )
  if (chunkCount !== expectedChunkCount) {
    throw new BinaryChunkProtocolError('Binary object chunk count does not match its size')
  }
  return Object.freeze({
    version: BINARY_CHUNK_PROTOCOL_VERSION,
    kind: 'content-addressed-binary',
    sha256,
    sizeBytes,
    mimeType: assertMimeType(value.mimeType),
    chunkSize,
    chunkCount
  })
}

export function validateBinaryChunkReference(value: unknown): BinaryChunkReference {
  return normalizeReference(value)
}

function normalizeFrame(value: unknown, runtime?: BinaryChunkRuntime): BinaryChunkFrame {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['version', 'kind', 'sha256', 'index', 'chunkCount', 'bytesBase64']) ||
    value.version !== BINARY_CHUNK_PROTOCOL_VERSION ||
    value.kind !== 'content-addressed-binary-chunk'
  ) {
    throw new BinaryChunkProtocolError('Invalid binary chunk frame')
  }
  const sha256 = assertSha256(value.sha256)
  const chunkCount = assertSafeInteger(
    value.chunkCount,
    'binary chunk count',
    1,
    MAX_BINARY_CHUNK_COUNT
  )
  const index = assertSafeInteger(value.index, 'binary chunk index', 0, chunkCount - 1)
  const bytesBase64 = canonicalBase64(value.bytesBase64, runtime)
  const bytes = decodeBase64(bytesBase64, runtime)
  if (bytes.length === 0 || bytes.length > MAX_BINARY_CHUNK_BYTES) {
    throw new BinaryChunkProtocolError('Invalid binary chunk size')
  }
  return Object.freeze({
    version: BINARY_CHUNK_PROTOCOL_VERSION,
    kind: 'content-addressed-binary-chunk',
    sha256,
    index,
    chunkCount,
    bytesBase64
  })
}

export function validateBinaryChunkFrame(
  value: unknown,
  runtime?: BinaryChunkRuntime
): BinaryChunkFrame {
  return normalizeFrame(value, runtime)
}

export async function createBinaryChunkTransport(
  bytesInput: Uint8Array,
  options: { mimeType: string; chunkSize?: number }
): Promise<{ reference: BinaryChunkReference; chunks: BinaryChunkFrame[] }> {
  if (!(bytesInput instanceof Uint8Array)) {
    throw new BinaryChunkProtocolError('Binary object bytes must be a Uint8Array')
  }
  const bytes = new Uint8Array(bytesInput)
  const chunkSize = assertSafeInteger(
    options.chunkSize ?? DEFAULT_BINARY_CHUNK_BYTES,
    'binary chunk size',
    1,
    MAX_BINARY_CHUNK_BYTES
  )
  if (bytes.length === 0 || bytes.length > MAX_BINARY_OBJECT_BYTES) {
    throw new BinaryChunkProtocolError('Binary object size is outside protocol limits')
  }
  const chunkCount = Math.ceil(bytes.length / chunkSize)
  const reference = normalizeReference({
    version: BINARY_CHUNK_PROTOCOL_VERSION,
    kind: 'content-addressed-binary',
    sha256: await sha256Hex(bytes),
    sizeBytes: bytes.length,
    mimeType: options.mimeType,
    chunkSize,
    chunkCount
  })
  const chunks: BinaryChunkFrame[] = []
  for (let index = 0; index < chunkCount; index += 1) {
    const start = index * chunkSize
    chunks.push(
      normalizeFrame({
        version: BINARY_CHUNK_PROTOCOL_VERSION,
        kind: 'content-addressed-binary-chunk',
        sha256: reference.sha256,
        index,
        chunkCount,
        bytesBase64: encodeBase64(bytes.subarray(start, Math.min(bytes.length, start + chunkSize)))
      })
    )
  }
  return { reference, chunks }
}

/** Validate a complete frame set without allocating or hashing the assembled object. */
export function validateBinaryChunkFrameSet(
  referenceInput: unknown,
  framesInput: readonly unknown[],
  runtime?: BinaryChunkRuntime
): BinaryChunkFrame[] {
  const reference = normalizeReference(referenceInput)
  if (!Array.isArray(framesInput) || framesInput.length !== reference.chunkCount) {
    throw new BinaryChunkProtocolError('Binary chunk frames are incomplete')
  }
  const seen = new Set<number>()
  return framesInput.map((raw) => {
    const frame = normalizeFrame(raw, runtime)
    if (
      frame.sha256 !== reference.sha256 ||
      frame.chunkCount !== reference.chunkCount ||
      seen.has(frame.index)
    ) {
      throw new BinaryChunkProtocolError('Binary chunk frame does not match its reference')
    }
    const bytes = decodeBase64(frame.bytesBase64, runtime)
    const expectedLength =
      frame.index === reference.chunkCount - 1
        ? reference.sizeBytes - reference.chunkSize * (reference.chunkCount - 1)
        : reference.chunkSize
    if (bytes.length !== expectedLength) {
      throw new BinaryChunkProtocolError('Binary chunk frame has an invalid length')
    }
    seen.add(frame.index)
    return frame
  })
}

export async function assembleBinaryChunks(
  referenceInput: unknown,
  frames: Iterable<unknown>,
  runtime?: BinaryChunkRuntime
): Promise<Uint8Array> {
  const reference = normalizeReference(referenceInput)
  if (frames == null || typeof frames[Symbol.iterator] !== 'function') {
    throw new BinaryChunkProtocolError('Binary chunk frames must be iterable')
  }
  const frameList: unknown[] = []
  for (const frame of frames) {
    if (frameList.length >= reference.chunkCount) {
      throw new BinaryChunkProtocolError('Binary chunk frame count exceeds the reference')
    }
    frameList.push(frame)
  }
  const validated = validateBinaryChunkFrameSet(reference, frameList, runtime)
  const assembled = new Uint8Array(reference.sizeBytes)
  try {
    let offsetByIndex = 0
    for (const frame of validated) {
      const bytes = decodeBase64(frame.bytesBase64, runtime)
      const start = frame.index * reference.chunkSize
      assembled.set(bytes, start)
      offsetByIndex += bytes.length
    }
    const hash = await (runtime?.sha256 ? runtime.sha256(assembled) : sha256Hex(assembled))
    if (offsetByIndex !== reference.sizeBytes || hash !== reference.sha256) {
      throw new BinaryChunkProtocolError('Binary chunk content failed integrity validation')
    }
    return assembled
  } catch (error) {
    assembled.fill(0)
    throw error
  }
}
