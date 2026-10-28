import {
  assembleBinaryChunks,
  validateBinaryChunkFrame,
  validateBinaryChunkReference,
  type BinaryChunkFrame,
  type BinaryChunkRuntime
} from '../binaryChunkProtocol'
import {
  figPluginAssetChunkSchema,
  figPluginAssetListSchema,
  figPluginSessionAssetSchema,
  type FigPluginAssetList,
  type FigPluginAssetReadRequest,
  type FigPluginSessionAsset
} from './hostAssets'
import type { FigPluginHost } from './manifest'

export type SessionAssetIdentity = Readonly<{
  sessionId: string
  pluginId: string
  host: FigPluginHost
  projectId?: string
}>

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// These are codecs only. Canonical encoding, frame keys and framing limits remain
// owned by binaryChunkProtocol, including its decode/re-encode pad-bit check.
const portableCodec: BinaryChunkRuntime = Object.freeze({
  decodeBase64(value: string) {
    const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
    const output = new Uint8Array((value.length * 3) / 4 - padding)
    let offset = 0
    for (let index = 0; index < value.length; index += 4) {
      const a = alphabet.indexOf(value[index])
      const b = alphabet.indexOf(value[index + 1])
      const c = value[index + 2] === '=' ? 0 : alphabet.indexOf(value[index + 2])
      const d = value[index + 3] === '=' ? 0 : alphabet.indexOf(value[index + 3])
      output[offset++] = (a << 2) | (b >>> 4)
      if (offset < output.length) output[offset++] = (b << 4) | (c >>> 2)
      if (offset < output.length) output[offset++] = (c << 6) | d
    }
    return output
  },
  encodeBase64(value: Uint8Array) {
    let output = ''
    for (let index = 0; index < value.length; index += 3) {
      const a = value[index]
      const b = value[index + 1]
      const c = value[index + 2]
      output += alphabet[a >>> 2] + alphabet[((a & 3) << 4) | ((b ?? 0) >>> 4)]
      output += index + 1 < value.length ? alphabet[((b & 15) << 2) | ((c ?? 0) >>> 6)] : '='
      output += index + 2 < value.length ? alphabet[c & 63] : '='
    }
    return output
  }
})

// Shared byte codecs do not carry session or execution authorization.
export const portableAssetCodec = portableCodec

function assertIdentity(asset: FigPluginSessionAsset, identity: SessionAssetIdentity, now: number) {
  if (
    asset.sessionId !== identity.sessionId ||
    asset.pluginId !== identity.pluginId ||
    asset.host !== identity.host ||
    (identity.projectId !== undefined && asset.projectId !== identity.projectId) ||
    !Number.isSafeInteger(now) ||
    now < asset.createdAt ||
    now >= asset.expiresAt
  )
    throw new Error('SESSION_ASSET_STALE_OR_UNBOUND')
}

export function validateSessionAsset(
  input: unknown,
  identity: SessionAssetIdentity,
  now = Date.now()
): Readonly<FigPluginSessionAsset> {
  const asset = figPluginSessionAssetSchema.parse(input)
  assertIdentity(asset, identity, now)
  return Object.freeze(asset)
}

export function validateSessionAssetCatalog(
  input: unknown,
  identity: SessionAssetIdentity,
  now = Date.now()
): FigPluginAssetList {
  const catalog = figPluginAssetListSchema.parse(input)
  if (catalog.sessionId !== identity.sessionId) throw new Error('SESSION_ASSET_CATALOG_UNBOUND')
  const projectId = identity.projectId ?? catalog.assets[0]?.projectId
  for (const asset of catalog.assets) {
    assertIdentity(asset, { ...identity, projectId }, now)
    Object.freeze(asset)
  }
  Object.freeze(catalog.assets)
  return Object.freeze(catalog)
}

export type SessionAssetReadOptions = Readonly<{
  identity: SessionAssetIdentity
  readChunk: (request: FigPluginAssetReadRequest) => unknown | Promise<unknown>
  sha256: (bytes: Uint8Array) => string | Promise<string>
  signal?: Pick<AbortSignal, 'aborted' | 'addEventListener' | 'removeEventListener'>
  isCurrent?: () => boolean
  now?: () => number
  deadline?: number
}>

/** Explicit, bounded local read only. No caching, host writes or provider calls. */
export async function readSessionAsset(
  input: unknown,
  options: SessionAssetReadOptions
): Promise<Uint8Array> {
  const now = options.now ?? Date.now
  const asset = validateSessionAsset(input, options.identity, now())
  const deadline = Math.min(asset.expiresAt, options.deadline ?? now() + 30_000)
  if (!Number.isSafeInteger(deadline)) throw new Error('SESSION_ASSET_DEADLINE')
  let active = true
  let timer: ReturnType<typeof setTimeout> | undefined
  let rejectStopped: (reason: Error) => void = () => {}
  const stopped = new Promise<never>((_, reject) => {
    rejectStopped = reject
  })
  // The rejection may precede the first network/hash race when a signal is already aborted.
  void stopped.catch(() => {})
  const cancel = () => {
    active = false
    rejectStopped(new Error('SESSION_ASSET_CANCELLED_OR_EXPIRED'))
  }
  const check = () => {
    if (!active || options.signal?.aborted || now() >= deadline || options.isCurrent?.() === false)
      throw new Error('SESSION_ASSET_CANCELLED_OR_EXPIRED')
    assertIdentity(asset, options.identity, now())
  }
  const frames: BinaryChunkFrame[] = []
  let assembled: Uint8Array | undefined
  let published = false
  try {
    timer = setTimeout(cancel, Math.max(0, deadline - now()))
    options.signal?.addEventListener('abort', cancel, { once: true })
    check()
    for (let index = 0; index < asset.chunkCount; index += 1) {
      check()
      const raw = await Promise.race([
        Promise.resolve().then(() => {
          check()
          return options.readChunk({
            protocol: 1,
            purpose: 'local-preview',
            assetId: asset.assetId,
            sha256: asset.sha256,
            index
          })
        }),
        stopped
      ])
      check()
      const envelope = figPluginAssetChunkSchema.parse(raw)
      const frame = validateBinaryChunkFrame(envelope.chunk, portableCodec)
      const expectedBytes = Math.min(asset.chunkSize, asset.sizeBytes - index * asset.chunkSize)
      const padding = frame.bytesBase64.endsWith('==') ? 2 : frame.bytesBase64.endsWith('=') ? 1 : 0
      if (
        envelope.sessionId !== asset.sessionId ||
        envelope.assetId !== asset.assetId ||
        frame.sha256 !== asset.sha256 ||
        frame.index !== index ||
        frame.chunkCount !== asset.chunkCount ||
        (frame.bytesBase64.length * 3) / 4 - padding !== expectedBytes
      )
        throw new Error('SESSION_ASSET_FRAME_MISMATCH')
      frames.push(frame)
    }
    const reference = validateBinaryChunkReference({
      version: 1,
      kind: 'content-addressed-binary',
      sha256: asset.sha256,
      sizeBytes: asset.sizeBytes,
      mimeType: asset.mimeType,
      chunkSize: asset.chunkSize,
      chunkCount: asset.chunkCount
    })
    assembled = await assembleBinaryChunks(reference, frames, {
      ...portableCodec,
      async sha256(bytes) {
        check()
        const hash = await Promise.race([
          Promise.resolve().then(() => {
            check()
            return options.sha256(bytes)
          }),
          stopped
        ])
        check()
        return hash
      }
    })
    check()
    published = true
    return assembled
  } finally {
    active = false
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', cancel)
    frames.length = 0
    if (!published) assembled?.fill(0)
  }
}
