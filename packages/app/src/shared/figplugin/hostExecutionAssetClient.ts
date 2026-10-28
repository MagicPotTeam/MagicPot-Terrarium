import {
  figPluginExecutionAssetChunkSchema,
  figPluginExecutionAssetReadRequestSchema,
  figPluginExecutionAssetSchema,
  type FigPluginExecutionAsset,
  type FigPluginExecutionAssetReadRequest
} from './hostExecutionAssets'
import { portableAssetCodec, type SessionAssetIdentity } from './hostAssetClient'
import { validateBinaryChunkFrame } from '../binaryChunkProtocol'

export type ExecutionAssetReadIntent = Readonly<{
  callId: string
  executionId: string
  actionId: string
  planSha256: string
  expiresAt: number
}>
export type ExecutionAssetReadOptions = Readonly<{
  identity: SessionAssetIdentity
  intent: ExecutionAssetReadIntent
  readChunk: (request: FigPluginExecutionAssetReadRequest) => unknown | Promise<unknown>
  sha256: (bytes: Uint8Array) => string | Promise<string>
  signal?: Pick<AbortSignal, 'aborted' | 'addEventListener' | 'removeEventListener'>
  isCurrent?: () => boolean
  now?: () => number
  deadline?: number
}>

export function validateExecutionAsset(
  input: unknown,
  identity: SessionAssetIdentity,
  now = Date.now()
): Readonly<FigPluginExecutionAsset> {
  const asset = figPluginExecutionAssetSchema.parse(input)
  if (
    asset.sessionId !== identity.sessionId ||
    asset.pluginId !== identity.pluginId ||
    asset.host !== identity.host ||
    (identity.projectId !== undefined && asset.projectId !== identity.projectId) ||
    !Number.isSafeInteger(now) ||
    now < asset.createdAt ||
    now >= asset.expiresAt
  )
    throw new Error('EXECUTION_ASSET_STALE_OR_UNBOUND')
  return Object.freeze(asset)
}

/** Read only the claim-bound execution endpoint. Never accepts a local-preview lease. */
export async function readExecutionAsset(
  input: unknown,
  options: ExecutionAssetReadOptions
): Promise<Uint8Array> {
  const now = options.now ?? Date.now
  const identity = Object.freeze({ ...options.identity })
  const asset = validateExecutionAsset(input, identity, now())
  const { callId, executionId, actionId, planSha256, expiresAt } = options.intent
  const request = figPluginExecutionAssetReadRequestSchema.parse({
    protocol: 1,
    purpose: 'host-plan-execution',
    callId,
    executionId,
    actionId,
    planSha256,
    assetId: asset.assetId,
    sha256: asset.sha256,
    index: 0
  })
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now() || expiresAt > asset.expiresAt)
    throw new Error('EXECUTION_ASSET_STALE_OR_UNBOUND')
  if (options.deadline !== undefined && !Number.isSafeInteger(options.deadline))
    throw new Error('EXECUTION_ASSET_DEADLINE')
  const deadline = Math.min(expiresAt, asset.expiresAt, options.deadline ?? now() + 30_000)
  if (!Number.isSafeInteger(deadline)) throw new Error('EXECUTION_ASSET_DEADLINE')
  let active = true
  let published = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let rejectStopped: (reason: Error) => void = () => {}
  const stopped = new Promise<never>((_, reject) => {
    rejectStopped = reject
  })
  void stopped.catch(() => {})
  const cancel = () => {
    active = false
    rejectStopped(new Error('EXECUTION_ASSET_CANCELLED_OR_EXPIRED'))
  }
  const check = () => {
    const time = now()
    if (
      !active ||
      options.signal?.aborted ||
      !Number.isSafeInteger(time) ||
      time < asset.createdAt ||
      time >= deadline ||
      options.isCurrent?.() === false
    )
      throw new Error('EXECUTION_ASSET_CANCELLED_OR_EXPIRED')
  }
  let bytes: Uint8Array | undefined
  try {
    timer = setTimeout(cancel, Math.max(0, deadline - now()))
    options.signal?.addEventListener('abort', cancel, { once: true })
    check()
    bytes = new Uint8Array(asset.sizeBytes)
    for (let index = 0; index < asset.chunkCount; index += 1) {
      check()
      const raw = await Promise.race([
        Promise.resolve().then(() => {
          check()
          return options.readChunk({ ...request, index })
        }),
        stopped
      ])
      check()
      const envelope = figPluginExecutionAssetChunkSchema.parse(raw)
      const temporary: Uint8Array[] = []
      const codec = {
        encodeBase64: portableAssetCodec.encodeBase64,
        decodeBase64(text: string) {
          const part = portableAssetCodec.decodeBase64!(text)
          temporary.push(part)
          return part
        }
      }
      try {
        const frame = validateBinaryChunkFrame(envelope.chunk, codec)
        const expectedBytes = Math.min(asset.chunkSize, asset.sizeBytes - index * asset.chunkSize)
        const padding = frame.bytesBase64.endsWith('==')
          ? 2
          : frame.bytesBase64.endsWith('=')
            ? 1
            : 0
        if (
          envelope.sessionId !== asset.sessionId ||
          envelope.assetId !== asset.assetId ||
          envelope.callId !== callId ||
          envelope.executionId !== executionId ||
          envelope.actionId !== actionId ||
          envelope.planSha256 !== planSha256 ||
          frame.sha256 !== asset.sha256 ||
          frame.index !== index ||
          frame.chunkCount !== asset.chunkCount ||
          (frame.bytesBase64.length * 3) / 4 - padding !== expectedBytes
        )
          throw new Error('EXECUTION_ASSET_FRAME_MISMATCH')
        bytes.set(codec.decodeBase64(frame.bytesBase64), index * asset.chunkSize)
      } finally {
        for (const part of temporary) part.fill(0)
      }
    }
    check()
    const hash = await Promise.race([
      Promise.resolve().then(() => {
        check()
        return options.sha256(bytes!)
      }),
      stopped
    ])
    check()
    if (hash !== asset.sha256) throw new Error('EXECUTION_ASSET_INTEGRITY')
    published = true
    return bytes
  } finally {
    active = false
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', cancel)
    if (!published) bytes?.fill(0)
  }
}
