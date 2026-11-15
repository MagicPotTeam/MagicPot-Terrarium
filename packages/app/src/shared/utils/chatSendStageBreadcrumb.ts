// packages/app/src/shared/utils/chatSendStageBreadcrumb.ts
// A breadcrumb the renderer reports at each stage of a chat send, so that a renderer death can be
// placed in the send ("it died after the request with 8 images of 9 M characters was built").
// COUNTS AND SIZES ONLY: never message text, file names, paths or URLs.

export const CHAT_SEND_STAGE_CHANNEL = 'app:chat-send-stage'

export const CHAT_SEND_STAGES = [
  /** The request code received the messages (before any attachment is read). */
  'request-start',
  /** Image history was selected and expanded for the image limits. */
  'images-checked',
  /** Attachments were read / encoded and the request is about to be dispatched. */
  'request-built',
  /** The dispatched request returned. */
  'reply-finished'
] as const

export type ChatSendStage = (typeof CHAT_SEND_STAGES)[number]

export type ChatSendStageBreadcrumb = {
  stage: ChatSendStage
  messageCount: number
  imageCount: number
  /** Known image sizes plus the decoded size of inline data: images. */
  imageBytes: number
  /** data: URLs among all attachments and their total length in characters. */
  dataUrlCount: number
  dataUrlChars: number
  /** performance.memory, when the renderer exposes it */
  usedJSHeapSize?: number
  jsHeapSizeLimit?: number
}

type AttachmentLike = { type?: unknown; url?: unknown; sizeBytes?: unknown }
type MessageLike = { attachments?: readonly AttachmentLike[] | unknown }

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** Walks attachments only; O(attachments), reads string lengths and prefixes, never content. */
export function summarizeChatSendStage(
  stage: ChatSendStage,
  messages: readonly MessageLike[],
  memory?: { usedJSHeapSize?: unknown; jsHeapSizeLimit?: unknown } | null
): ChatSendStageBreadcrumb {
  let imageCount = 0
  let imageBytes = 0
  let dataUrlCount = 0
  let dataUrlChars = 0
  for (const message of messages) {
    const attachments = Array.isArray(message?.attachments) ? (message.attachments as AttachmentLike[]) : []
    for (const attachment of attachments) {
      const url = typeof attachment?.url === 'string' ? attachment.url : ''
      const isDataUrl = url.startsWith('data:')
      if (isDataUrl) {
        dataUrlCount += 1
        dataUrlChars += url.length
      }
      if (attachment?.type !== 'image') continue
      imageCount += 1
      if (isCount(attachment.sizeBytes)) imageBytes += attachment.sizeBytes
      else if (isDataUrl) imageBytes += Math.floor((url.length - url.indexOf(',') - 1) * 0.75)
    }
  }
  const usedJSHeapSize = memory?.usedJSHeapSize
  const jsHeapSizeLimit = memory?.jsHeapSizeLimit
  return {
    stage,
    messageCount: messages.length,
    imageCount,
    imageBytes,
    dataUrlCount,
    dataUrlChars,
    ...(isCount(usedJSHeapSize) ? { usedJSHeapSize } : {}),
    ...(isCount(jsHeapSizeLimit) ? { jsHeapSizeLimit } : {})
  }
}

const BREADCRUMB_KEYS = new Set([
  'stage',
  'messageCount',
  'imageCount',
  'imageBytes',
  'dataUrlCount',
  'dataUrlChars',
  'usedJSHeapSize',
  'jsHeapSizeLimit'
])

/** Accepts exactly the breadcrumb shape (known keys, a known stage, non-negative integers). */
export function parseChatSendStageBreadcrumb(value: unknown): ChatSendStageBreadcrumb | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length > BREADCRUMB_KEYS.size || keys.some((key) => !BREADCRUMB_KEYS.has(key))) return null
  if (!CHAT_SEND_STAGES.includes(record.stage as ChatSendStage)) return null
  const required = ['messageCount', 'imageCount', 'imageBytes', 'dataUrlCount', 'dataUrlChars'] as const
  if (required.some((key) => !isCount(record[key]))) return null
  for (const key of ['usedJSHeapSize', 'jsHeapSizeLimit'] as const) {
    if (record[key] !== undefined && !isCount(record[key])) return null
  }
  return {
    stage: record.stage as ChatSendStage,
    messageCount: record.messageCount as number,
    imageCount: record.imageCount as number,
    imageBytes: record.imageBytes as number,
    dataUrlCount: record.dataUrlCount as number,
    dataUrlChars: record.dataUrlChars as number,
    ...(record.usedJSHeapSize !== undefined ? { usedJSHeapSize: record.usedJSHeapSize as number } : {}),
    ...(record.jsHeapSizeLimit !== undefined ? { jsHeapSizeLimit: record.jsHeapSizeLimit as number } : {})
  }
}
