// packages/app/src/shared/utils/chatSendStageBreadcrumb.ts
// A breadcrumb the renderer reports at each stage of a chat send, so that a renderer death can be
// placed in the send ("it died after the request with 8 images of 9 M characters was built").
// COUNTS, SIZES AND ENUMERATED NAMES ONLY: never message text, error messages, file names, paths
// or URLs. Each request of a page has its own sequence number, so that main can tell overlapping
// sends apart (a background request must not hide the image send that is still running).

export const CHAT_SEND_STAGE_CHANNEL = 'app:chat-send-stage'

export const CHAT_SEND_STAGES = [
  /** The request code received the messages (before any attachment is read). */
  'request-start',
  /** Image history was selected and expanded for the image limits. */
  'images-checked',
  /** Attachments were read / encoded and the request is about to be dispatched. */
  'request-built',
  /** The dispatched request returned. */
  'reply-finished',
  /** The request ended with an error or was aborted, at whatever stage it had reached. */
  'reply-failed'
] as const

export type ChatSendStage = (typeof CHAT_SEND_STAGES)[number]

/** The stages after which a send is no longer running. */
export const TERMINAL_CHAT_SEND_STAGES: readonly ChatSendStage[] = ['reply-finished', 'reply-failed']
/** The stages a failed send can have reached. */
export const RUNNING_CHAT_SEND_STAGES = ['request-start', 'images-checked', 'request-built'] as const
export type RunningChatSendStage = (typeof RUNNING_CHAT_SEND_STAGES)[number]

/**
 * The error names a failed send may report. Any other name (an app's own error class, a value that
 * is not an error) is reported as 'other': a name is never copied from the error itself.
 */
export const CHAT_SEND_ERROR_NAMES = [
  'Error',
  'AbortError',
  'TimeoutError',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'QuotaExceededError',
  'NotReadableError',
  'NotFoundError',
  'NetworkError',
  'DataError',
  'EncodingError',
  'InvalidStateError',
  'SecurityError',
  'other'
] as const
export type ChatSendErrorName = (typeof CHAT_SEND_ERROR_NAMES)[number]

/** The enumerated name of a thrown value; reads only its `name`, never its message. */
export function chatSendErrorName(error: unknown): ChatSendErrorName {
  try {
    const name = error && typeof error === 'object' ? (error as { name?: unknown }).name : undefined
    return typeof name === 'string' && (CHAT_SEND_ERROR_NAMES as readonly string[]).includes(name)
      ? (name as ChatSendErrorName)
      : 'other'
  } catch {
    return 'other'
  }
}

export type ChatSendStageBreadcrumb = {
  stage: ChatSendStage
  /** The request's number within this page (1, 2, ...): every stage of one request carries the same. */
  sendSeq: number
  messageCount: number
  imageCount: number
  /** Known image sizes plus the decoded size of inline data: images. */
  imageBytes: number
  /** data: URLs among all attachments and their total length in characters. */
  dataUrlCount: number
  dataUrlChars: number
  /** 'reply-failed' only: the stage the request had reached, and the error's enumerated name. */
  failedAfter?: RunningChatSendStage
  errorName?: ChatSendErrorName
}

/**
 * What the main process keeps: the page's counts plus the size of this renderer's JS heap in bytes.
 *
 * The two heap numbers are attached by the PRELOAD from V8's own heap statistics
 * (process.getHeapStatistics()), never by the page: the page's performance.memory is quantised and
 * cached by Chromium (during a real out-of-memory death it said 26 MB while the heap was at
 * 1.9 GB), and a number the page could choose is not evidence. A page that supplies them is not
 * a breadcrumb (see parseChatSendStageBreadcrumb).
 */
export type ChatSendStageReport = ChatSendStageBreadcrumb & {
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
  sendSeq: number
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
  return { stage, sendSeq, messageCount: messages.length, imageCount, imageBytes, dataUrlCount, dataUrlChars }
}

/**
 * The breadcrumb of a request that failed or was aborted: the counts of the last stage it reported
 * (so the sizes of a built request survive), that stage, and the error's enumerated name.
 */
export function failedChatSendStage(
  last: ChatSendStageBreadcrumb,
  error: unknown
): ChatSendStageBreadcrumb | null {
  if (!(RUNNING_CHAT_SEND_STAGES as readonly string[]).includes(last.stage)) return null
  return {
    stage: 'reply-failed',
    sendSeq: last.sendSeq,
    messageCount: last.messageCount,
    imageCount: last.imageCount,
    imageBytes: last.imageBytes,
    dataUrlCount: last.dataUrlCount,
    dataUrlChars: last.dataUrlChars,
    failedAfter: last.stage as RunningChatSendStage,
    errorName: chatSendErrorName(error)
  }
}

const BREADCRUMB_KEYS = new Set<string>([
  'stage',
  'sendSeq',
  'messageCount',
  'imageCount',
  'imageBytes',
  'dataUrlCount',
  'dataUrlChars',
  'failedAfter',
  'errorName'
])

/**
 * True only for a plain object: its prototype is Object.prototype or null, so a typed array, an
 * array, a map, a date, an error or a class instance is rejected by its prototype alone, before
 * any key is looked at. Symbol keys are never part of a breadcrumb: Object.getOwnPropertySymbols
 * scans the property table without building a list of the string keys (30 ms for an object with a
 * million keys, against 716 ms for deserializing that object, measured on Node 24). Over IPC a
 * symbol key cannot arrive at all (structured clone drops it); this keeps direct callers strict.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Object.getOwnPropertySymbols(value).length === 0
}

/**
 * True only for a plain object whose own enumerable keys are all in `allowed`. The key walk is
 * NOT cheap for a large object: V8's for-in lists every key before the first step, so it costs
 * about as much as copying the object, whatever key it stops at. Only the preload uses it, where
 * contextBridge has already copied the page's whole object; main never walks a report's keys (see
 * parseChatSendStageReport). Only key NAMES are looked at here.
 */
function isPlainRecordWithKeys(value: unknown, allowed: ReadonlySet<string>): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false
  let count = 0
  // With Object.prototype or null as prototype, for-in visits own enumerable string keys only.
  for (const key in value) {
    count += 1
    if (count > allowed.size || !allowed.has(key)) return false
  }
  return true
}

/**
 * Accepts exactly the shape the page may report (known keys, a known stage, non-negative
 * integers). There is no heap number in it: those come from the preload.
 */
export function parseChatSendStageBreadcrumb(value: unknown): ChatSendStageBreadcrumb | null {
  if (!isPlainRecordWithKeys(value, BREADCRUMB_KEYS)) return null
  return readBreadcrumb(value)
}

/**
 * The value of an OWN key, read once; undefined when the key is absent (an inherited value, e.g. a
 * key added to Object.prototype, is never taken).
 */
const ownValue = (record: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(record, key) ? record[key] : undefined

/**
 * Reads the known keys by name, each once, into a new object. Nothing else of `record` is read or
 * copied, so keys it does not know are left behind unread.
 */
function readBreadcrumb(record: Record<string, unknown>): ChatSendStageBreadcrumb | null {
  const stage = ownValue(record, 'stage')
  if (!CHAT_SEND_STAGES.includes(stage as ChatSendStage)) return null
  const sendSeq = ownValue(record, 'sendSeq')
  const messageCount = ownValue(record, 'messageCount')
  const imageCount = ownValue(record, 'imageCount')
  const imageBytes = ownValue(record, 'imageBytes')
  const dataUrlCount = ownValue(record, 'dataUrlCount')
  const dataUrlChars = ownValue(record, 'dataUrlChars')
  if (
    !isCount(sendSeq) ||
    !isCount(messageCount) ||
    !isCount(imageCount) ||
    !isCount(imageBytes) ||
    !isCount(dataUrlCount) ||
    !isCount(dataUrlChars)
  ) {
    return null
  }
  const breadcrumb: ChatSendStageBreadcrumb = {
    stage: stage as ChatSendStage,
    sendSeq,
    messageCount,
    imageCount,
    imageBytes,
    dataUrlCount,
    dataUrlChars
  }
  const failedAfter = ownValue(record, 'failedAfter')
  const errorName = ownValue(record, 'errorName')
  // A failure names the stage it came after and the error's enumerated name; nothing else does.
  if (breadcrumb.stage === 'reply-failed') {
    if (!(RUNNING_CHAT_SEND_STAGES as readonly unknown[]).includes(failedAfter)) return null
    if (!(CHAT_SEND_ERROR_NAMES as readonly unknown[]).includes(errorName)) return null
    breadcrumb.failedAfter = failedAfter as RunningChatSendStage
    breadcrumb.errorName = errorName as ChatSendErrorName
  } else if (failedAfter !== undefined || errorName !== undefined) {
    return null
  }
  return breadcrumb
}

const HEAP_KEYS = ['usedJSHeapSize', 'jsHeapSizeLimit'] as const

/** Adds the heap numbers the preload read; anything that is not a non-negative integer is left out. */
export function withJsHeapNumbers(
  breadcrumb: ChatSendStageBreadcrumb,
  heap: { usedJSHeapSize?: unknown; jsHeapSizeLimit?: unknown } | null | undefined
): ChatSendStageReport {
  const report: ChatSendStageReport = { ...breadcrumb }
  for (const key of HEAP_KEYS) {
    const value = heap?.[key]
    if (isCount(value)) report[key] = value
  }
  return report
}

/**
 * What main accepts on the channel: a breadcrumb plus, optionally, the two heap numbers. Main gets
 * this from a renderer, so its prototype is checked before anything is read (see isPlainRecord)
 * and then only the known keys are read, by name and once each, into a new object (see
 * readBreadcrumb). The keys are NOT walked: listing them costs as much as Electron's own
 * deserialization of the message, a second block of the main thread for a report with millions of
 * keys. A key main does not know is therefore not refused but left behind unread; the preload
 * already refuses one from the page (parseChatSendStageBreadcrumb), and nothing unknown is stored.
 * Beyond the deserialization, the work here does not grow with the size of the report except for
 * the symbol check's scan.
 */
export function parseChatSendStageReport(value: unknown): ChatSendStageReport | null {
  if (!isPlainRecord(value)) return null
  const usedJSHeapSize = ownValue(value, 'usedJSHeapSize')
  const jsHeapSizeLimit = ownValue(value, 'jsHeapSizeLimit')
  if (usedJSHeapSize !== undefined && !isCount(usedJSHeapSize)) return null
  if (jsHeapSizeLimit !== undefined && !isCount(jsHeapSizeLimit)) return null
  const breadcrumb = readBreadcrumb(value)
  if (!breadcrumb) return null
  return withJsHeapNumbers(breadcrumb, { usedJSHeapSize, jsHeapSizeLimit })
}
