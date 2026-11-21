import { createHash } from 'node:crypto'
import { getAgentSessionKey, normalizeAgentRoute, type AgentRouteLike } from '@shared/agent'
import type { LLMChatReq } from '@shared/api/svcLLMProxy'
import type { ChatAttachment } from '@shared/llm'
import type { MediaReference } from '@shared/mediaReference'
import {
  inspectThreadImageInput,
  THREAD_IMAGE_INPUT_MAX_BYTES,
  THREAD_IMAGE_INPUT_MAX_PIXELS
} from './agentThreadImageInputs'

export function threadImageOutputScope(route: AgentRouteLike, conversationId: string): string {
  const key = getAgentSessionKey(normalizeAgentRoute(route))
  return createHash('sha256')
    .update(JSON.stringify([key, conversationId]))
    .digest('hex')
}

// Snapshot only a bounded tuple, never a renderer path or bytes. Preserve bad slots;
// a malformed list means no historical candidates, not permission to replay messages.
export function captureHistoryReferences(
  history: unknown,
  limit: 1 | 5 = 5
): (MediaReference | null)[] | undefined {
  if (history === undefined) return undefined // Legacy inline history.
  if (!Array.isArray(history) || history.length > 5) return []
  return Array.from({ length: Math.min(history.length, limit) }, (_, index) => {
    const entry: unknown = Object.getOwnPropertyDescriptor(history, index)?.value
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
    for (const key in entry) {
      if (key !== 'sha256' && key !== 'mimeType' && key !== 'sizeBytes') return null
    }
    const sha256: unknown = Object.getOwnPropertyDescriptor(entry, 'sha256')?.value
    const mimeType: unknown = Object.getOwnPropertyDescriptor(entry, 'mimeType')?.value
    const sizeBytes: unknown = Object.getOwnPropertyDescriptor(entry, 'sizeBytes')?.value
    if (
      typeof sha256 !== 'string' ||
      sha256.length !== 64 ||
      !/^[a-f0-9]{64}$/u.test(sha256) ||
      (mimeType !== 'image/png' && mimeType !== 'image/jpeg' && mimeType !== 'image/webp') ||
      typeof sizeBytes !== 'number' ||
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes <= 0 ||
      sizeBytes > THREAD_IMAGE_INPUT_MAX_BYTES
    )
      return null
    const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as const)[
      mimeType
    ]
    return {
      version: 1,
      kind: 'managed',
      sha256,
      mimeType,
      sizeBytes,
      originalFileName: `image.${ext}`,
      relativePath: `originals/${sha256.slice(0, 2)}/${sha256}.${ext}`
    }
  })
}

/** Internal only: caller must supply an admitted publication or a captured tuple.
 * Never let a qualified reference override the selected output namespace. v1
 * has no provenance record: exact membership in this store is the ownership proof.
 */
export async function readThreadImageOutput(
  scope: string,
  reference: MediaReference,
  live: () => void
): Promise<Buffer> {
  live()
  if (!reference.sizeBytes || reference.sizeBytes > THREAD_IMAGE_INPUT_MAX_BYTES)
    throw new Error('Recent image exceeds the input byte limit.')
  if (
    !reference.relativePath.startsWith('originals/') &&
    !reference.relativePath.startsWith(`user-output/${scope}/originals/`)
  )
    throw new Error('Image is outside this conversation.')
  const [
    { getChatMediaDir, resolveChatMediaNamespaceDir },
    { resolveManagedMediaReference, readManagedMediaBytes }
  ] = await Promise.all([
    import('../llmProxy/chatMediaDir'),
    import('../llmProxy/managedMediaStore')
  ])
  live()
  const authorizedRoot = getChatMediaDir()
  const resolved = await resolveManagedMediaReference(
    resolveChatMediaNamespaceDir('user-output', scope),
    reference,
    { authorizedRoot }
  )
  live()
  const bytes = await readManagedMediaBytes(resolved.storeRoot!, resolved.metadata, {
    authorizedRoot,
    maxBytes: THREAD_IMAGE_INPUT_MAX_BYTES
  })
  live()
  return bytes
}

const previewEdge = 1024
const previewBytes = 1536 * 1024
export class ThreadImageReviewUnavailable extends Error {
  constructor() {
    super('Latest image cannot be reviewed in this conversation; please reattach it.')
  }
}

/** Captures one selection with no I/O. The admitted caller controls whether a
 * preview is needed. No path, receipt, source metadata or original bytes leave MAIN.
 */
export function createThreadImageReviewLoader(options: {
  route: AgentRouteLike
  conversationId: string
  threadImageHistory: LLMChatReq['threadImageHistory']
  assertLive(): void
}): (signal?: AbortSignal) => Promise<ChatAttachment> {
  const scope = threadImageOutputScope(options.route, options.conversationId)
  const newest = captureHistoryReferences(options.threadImageHistory, 1)?.[0]
  const { assertLive } = options
  return async (signal) => {
    const live = () => {
      signal?.throwIfAborted()
      assertLive()
    }
    live()
    if (!newest) throw new ThreadImageReviewUnavailable()
    try {
      const bytes = await readThreadImageOutput(scope, newest, live)
      live()
      const source = inspectThreadImageInput(bytes, newest.mimeType)
      const { default: sharp } = await import('sharp')
      live()
      // Decode once into bounded pixels; constructing a fresh encoder from raw
      // pixels prevents even small originals from carrying ancillary text or EXIF.
      const { data, info } = await sharp(bytes, {
        limitInputPixels: THREAD_IMAGE_INPUT_MAX_PIXELS,
        pages: 1,
        failOn: 'warning'
      })
        .resize(previewEdge, previewEdge, { fit: 'inside', withoutEnlargement: true })
        .toColourspace('srgb')
        .ensureAlpha()
        .raw({ depth: 'uchar' })
        .toBuffer({ resolveWithObject: true })
      live()
      const { width, height, channels } = info
      if (
        channels !== 4 ||
        width < 1 ||
        height < 1 ||
        width > Math.min(previewEdge, source.width) ||
        height > Math.min(previewEdge, source.height) ||
        data.length !== width * height * channels
      )
        throw new ThreadImageReviewUnavailable()
      for (const edge of [previewEdge, 512]) {
        const image = sharp(data, { raw: { width, height, channels } })
        if (edge < previewEdge)
          image.resize(edge, edge, { fit: 'inside', withoutEnlargement: true })
        const png = await image.png().toBuffer()
        live()
        if (png.length && png.length <= previewBytes) {
          return {
            type: 'image',
            url: `data:image/png;base64,${png.toString('base64')}`,
            mimeType: 'image/png',
            sizeBytes: png.length
          }
        }
      }
    } catch {
      live() // Do not mask cancellation/revocation or expose storage/codec details.
    }
    throw new ThreadImageReviewUnavailable()
  }
}
