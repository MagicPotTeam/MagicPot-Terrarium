import {
  MAX_CHAT_IMAGE_PREPARATION_BATCH_SOURCE_BYTES,
  MAX_CHAT_IMAGE_PREPARATION_SOURCE_BYTES,
  MAX_REMOTE_CHAT_STREAM_REQUEST_BYTES
} from '@shared/llm/chatAttachmentTransportLimits'
import { DEFAULT_PROVIDER_JSON_MAX_BYTES } from '@shared/llm/providerJsonBudget'
import { normalizeMediaReference } from '@shared/mediaReference'
import i18next from 'i18next'
import type { ChatAttachment } from '../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/api/LLM'

/**
 * Which size limit MAIN applies to the images of a request on its route:
 * - 'prepared-source': built-in OpenAI Responses route; MAIN refuses when the ORIGINAL
 *   bytes of one inline image or of all inline images together exceed its preparation
 *   limits, before it re-encodes them (so the provider JSON budget does not apply to
 *   the originals there).
 * - 'provider-json': a client that inlines the original bytes as base64 and refuses when
 *   their base64 characters together exceed the provider JSON budget (Gemini, Claude).
 * - 'remote-stream': MAIN forwards the request JSON, which carries every inline image as
 *   a data URL, to the remote server and refuses a body above its byte limit.
 */
export type ChatRequestImageByteBudgetRoute = 'prepared-source' | 'provider-json' | 'remote-stream'

export const CHAT_REQUEST_IMAGE_BUDGET_EXCEEDED = 'CHAT_REQUEST_IMAGE_BUDGET_EXCEEDED'

/**
 * A request that MAIN would certainly refuse for the size of its images; nothing was read or
 * sent. Its message is the one short line the send path shows through its existing notice.
 */
export class ChatRequestImageBudgetError extends Error {
  readonly code = CHAT_REQUEST_IMAGE_BUDGET_EXCEEDED
  readonly retryBlocked = true
  constructor(message: string = i18next.t('chat.request_images_too_large')) {
    super(message)
    this.name = 'ChatRequestImageBudgetError'
  }
}

export const isChatRequestImageBudgetError = (value: unknown): value is ChatRequestImageBudgetError =>
  value instanceof ChatRequestImageBudgetError

type DescriptorImageSize = { sourceBytes: number; base64Chars: number }

const MAX_DATA_URL_HEADER_CHARS = 4096
const NON_BASE64_CHAR = /[^A-Za-z0-9+/=]/g

const base64CharsForBytes = (bytes: number): number => Math.ceil(bytes / 3) * 4

/**
 * Size of one image occurrence as it will be sent, from its descriptor only; nothing is
 * read. Known only where it is certain: a managed reference (MAIN verifies the recorded
 * size when it materializes the bytes, a mismatch fails the request) and a base64 data
 * URL (its own length). Anything else (local paths, blob:, http(s), malformed data) is
 * unknown and is not counted, so the request keeps today's behaviour for it.
 */
export const describeRequestImageSize = (
  attachment: ChatAttachment
): DescriptorImageSize | undefined => {
  if (attachment.type !== 'image') return undefined
  const media = normalizeMediaReference(attachment.media)
  if (media?.kind === 'managed' && typeof media.sizeBytes === 'number') {
    return { sourceBytes: media.sizeBytes, base64Chars: base64CharsForBytes(media.sizeBytes) }
  }
  const url = typeof attachment.url === 'string' ? attachment.url : ''
  if (url.slice(0, 5).toLowerCase() !== 'data:') return undefined
  const comma = url.indexOf(',')
  if (comma < 0 || comma > MAX_DATA_URL_HEADER_CHARS) return undefined
  if (!/;base64$/i.test(url.slice(0, comma))) return undefined
  const payloadChars = url.length - comma - 1
  if (payloadChars <= 0 || payloadChars % 4 !== 0) return undefined
  NON_BASE64_CHAR.lastIndex = comma + 1
  if (NON_BASE64_CHAR.exec(url)) return undefined
  const padding = url.endsWith('==') ? 2 : url.endsWith('=') ? 1 : 0
  return { sourceBytes: (payloadChars / 4) * 3 - padding, base64Chars: payloadChars }
}

/**
 * Size of an image the request path added from a report-bundle manifest that MAIN verified
 * for this send (verifyReportBundles: MAIN's own snapshot manifest, whose sizeBytes are the
 * sizes MAIN measured of files it found unchanged just before). The renderer then reads
 * exactly those files and sends their bytes, so the recorded size is what MAIN measures.
 * Only for attachments the expansion created from such a manifest; a descriptor's own
 * sizeBytes is never trusted.
 */
export const describeVerifiedManifestImageSize = (
  attachment: ChatAttachment
): DescriptorImageSize | undefined => {
  if (attachment.type !== 'image') return undefined
  const size = attachment.sizeBytes
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return undefined
  return { sourceBytes: size, base64Chars: base64CharsForBytes(size) }
}

/**
 * Refuses, before any image is read, a request whose known image sizes already exceed the
 * limit MAIN applies on its route. Only the known sizes are summed, so the total is a lower
 * bound of what MAIN measures and a refusal here is one MAIN would certainly make. Every
 * occurrence counts, as MAIN counts every occurrence. The caller passes only image
 * attachments that will certainly be part of the request, and in `verifiedManifestImages`
 * those it added from a manifest MAIN verified (see describeVerifiedManifestImageSize).
 */
export const assertRequestImageBytesWithinBudget = (
  attachments: readonly ChatAttachment[],
  route: ChatRequestImageByteBudgetRoute,
  options: {
    verifiedManifestImages?: ReadonlySet<ChatAttachment>
    createError?: () => Error
  } = {}
): void => {
  const createError = options.createError ?? (() => new ChatRequestImageBudgetError())
  let sourceBytes = 0
  let base64Chars = 0
  for (const attachment of attachments) {
    const size =
      describeRequestImageSize(attachment) ??
      (options.verifiedManifestImages?.has(attachment)
        ? describeVerifiedManifestImageSize(attachment)
        : undefined)
    if (!size) continue
    sourceBytes += size.sourceBytes
    base64Chars += size.base64Chars
    if (route === 'prepared-source') {
      if (
        size.sourceBytes > MAX_CHAT_IMAGE_PREPARATION_SOURCE_BYTES ||
        sourceBytes > MAX_CHAT_IMAGE_PREPARATION_BATCH_SOURCE_BYTES
      ) {
        throw createError()
      }
    } else if (route === 'provider-json') {
      if (base64Chars > DEFAULT_PROVIDER_JSON_MAX_BYTES) throw createError()
    } else if (base64Chars > MAX_REMOTE_CHAT_STREAM_REQUEST_BYTES) {
      throw createError()
    }
  }
}
