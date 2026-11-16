// How unaccepted user-authored queued sends are kept with the draft so that they survive a
// window reload or a restart, and how they come back: paused, never sent by themselves.
// Pure functions; ChatPage owns the queue state, chatStorage owns the records.

import type { ChatAttachment } from '@shared/api/svcLLMProxy'
import { normalizeMediaReference } from '@shared/mediaReference'
import type { ChatDraftQueuedSend } from '@renderer/features/chat/chatDraftUtils'
import { isUserQueuedSend, type QueuedSendState } from './chatQueuedSends'

/** An inline data: URL longer than this is never stored with a queued send (FIX-PLAN item 4). */
export const QUEUED_SEND_INLINE_ATTACHMENT_MAX_CHARS = 64 * 1024
/** All inline data: URLs of one session's stored queue together stay below this. */
export const QUEUED_SENDS_INLINE_BUDGET_CHARS = 256 * 1024

/**
 * Stands in for an attachment that could not be kept in a durable form. An empty data: URL never
 * loads, so the composer shows its existing "image unavailable" tile; it is never sent.
 */
export const UNAVAILABLE_QUEUED_ATTACHMENT_URL = 'data:,'
const UNAVAILABLE_FLAG = 'queuedAttachmentUnavailable'

export const isUnavailableQueuedAttachment = (attachment: ChatAttachment): boolean =>
  attachment.metadata?.[UNAVAILABLE_FLAG] === true

/** The descriptive fields of an attachment, marked unavailable: the item keeps its place and count. */
export const markQueuedAttachmentUnavailable = (attachment: ChatAttachment): ChatAttachment => ({
  type: attachment.type,
  url: UNAVAILABLE_QUEUED_ATTACHMENT_URL,
  ...(typeof attachment.fileName === 'string' ? { fileName: attachment.fileName } : {}),
  ...(typeof attachment.mimeType === 'string' ? { mimeType: attachment.mimeType } : {}),
  metadata: { [UNAVAILABLE_FLAG]: true }
})

const hasDurableMediaReference = (attachment: ChatAttachment): boolean => {
  const reference = normalizeMediaReference(attachment.media)
  return Boolean(reference && (reference.kind !== 'managed' || reference.sha256))
}

/**
 * Durable forms only: a managed reference, a file or https reference, or a small inline data: URL
 * within the session budget. A blob: URL (it dies with the renderer), a broken media reference or
 * an over-cap inline data: URL is kept as an unavailable attachment, never silently dropped.
 */
export const toDurableQueuedAttachments = (
  attachments: readonly ChatAttachment[] | undefined,
  budget: { inlineChars: number }
): ChatAttachment[] | undefined => {
  if (!attachments?.length) return undefined
  return attachments.map((attachment) => {
    if (isUnavailableQueuedAttachment(attachment)) return markQueuedAttachmentUnavailable(attachment)
    if (typeof attachment.url !== 'string' || attachment.url.startsWith('blob:')) {
      return markQueuedAttachmentUnavailable(attachment)
    }
    if (attachment.media !== undefined && attachment.media !== null && !hasDurableMediaReference(attachment)) {
      return markQueuedAttachmentUnavailable(attachment)
    }
    if (attachment.url.startsWith('data:')) {
      if (
        attachment.url.length > QUEUED_SEND_INLINE_ATTACHMENT_MAX_CHARS ||
        attachment.url.length > budget.inlineChars
      ) {
        return markQueuedAttachmentUnavailable(attachment)
      }
      budget.inlineChars -= attachment.url.length
    }
    // A chunked binary payload belongs to one request, never to a stored record.
    const { binary: _binary, ...durable } = attachment
    return { ...durable }
  })
}

/** The in-memory fields of a queued send that its stored form is built from. */
export type PersistableQueuedSend = QueuedSendState & {
  persistId?: string
  queuedAt?: number
  originalComposerHiddenContext?: string
  overrides?: QueuedSendState['overrides'] & {
    content: string
    attachments?: ChatAttachment[]
    hiddenContext?: string
  }
}

/**
 * The stored form of a session's queue: unaccepted user-authored items only, in order. The
 * composer's own hidden context is kept; generated team context, callbacks, edit base messages,
 * queue keys and target sessions are not.
 */
export const serializeQueuedSends = (
  queue: readonly PersistableQueuedSend[] | undefined
): ChatDraftQueuedSend[] => {
  const budget = { inlineChars: QUEUED_SENDS_INLINE_BUDGET_CHARS }
  const stored: ChatDraftQueuedSend[] = []
  for (const item of queue ?? []) {
    if (!item.persistId || !item.overrides || !isUserQueuedSend(item)) continue
    const content = typeof item.overrides.content === 'string' ? item.overrides.content : ''
    const attachments = toDurableQueuedAttachments(item.overrides.attachments, budget)
    if (!content && !attachments?.length) continue
    // The composer's own hidden text: set for a composer submission, or the plain composer
    // queue (no submission flag), whose hidden context is the composer's.
    const ownHiddenContext =
      item.originalComposerHiddenContext ??
      (item.fromComposer && !item.overrides.composerSubmission ? item.overrides.hiddenContext : undefined)
    stored.push({
      id: item.persistId,
      content,
      ...(attachments?.length ? { attachments } : {}),
      ...(ownHiddenContext ? { originalComposerHiddenContext: ownHiddenContext } : {}),
      queuedAt: typeof item.queuedAt === 'number' && Number.isFinite(item.queuedAt) ? item.queuedAt : 0
    })
  }
  return stored
}

/** Normalizes stored queued sends read back from storage (untrusted shape). */
export const normalizeStoredQueuedSends = (
  value: unknown,
  normalizeAttachments: (value: unknown) => ChatAttachment[]
): ChatDraftQueuedSend[] => {
  if (!Array.isArray(value)) return []
  const budget = { inlineChars: QUEUED_SENDS_INLINE_BUDGET_CHARS }
  const seen = new Set<string>()
  return value.flatMap((candidate): ChatDraftQueuedSend[] => {
    if (!candidate || typeof candidate !== 'object') return []
    const item = candidate as Partial<ChatDraftQueuedSend>
    if (typeof item.id !== 'string' || !item.id || seen.has(item.id)) return []
    const content = typeof item.content === 'string' ? item.content : ''
    const attachments = toDurableQueuedAttachments(normalizeAttachments(item.attachments), budget)
    if (!content && !attachments?.length) return []
    seen.add(item.id)
    return [
      {
        id: item.id,
        content,
        ...(attachments?.length ? { attachments } : {}),
        ...(typeof item.originalComposerHiddenContext === 'string' && item.originalComposerHiddenContext
          ? { originalComposerHiddenContext: item.originalComposerHiddenContext }
          : {}),
        queuedAt:
          typeof item.queuedAt === 'number' && Number.isFinite(item.queuedAt) ? item.queuedAt : 0
      }
    ]
  })
}

/**
 * Restores stored items in front of the in-memory queue, skipping those it already holds. Every
 * restored item is paused and held: it is never sent by itself, and only Edit (back into the
 * composer, where every send-time check runs again) or Remove acts on it. An edit's base
 * messages are gone after a reload, so a restored edit is a plain item.
 */
export const restoreQueuedSends = <T extends PersistableQueuedSend>(
  stored: readonly ChatDraftQueuedSend[],
  inMemory: readonly T[] | undefined,
  createItem: (fields: {
    persistId: string
    queuedAt: number
    content: string
    attachments?: ChatAttachment[]
    originalComposerHiddenContext?: string
  }) => T
): T[] | undefined => {
  const present = new Set((inMemory ?? []).map((item) => item.persistId).filter(Boolean))
  // Read-side check as well: whatever the record holds, only durable forms come back.
  const budget = { inlineChars: QUEUED_SENDS_INLINE_BUDGET_CHARS }
  const restored = stored
    .filter((item) => !present.has(item.id))
    .map((item) => ({ item, attachments: toDurableQueuedAttachments(item.attachments, budget) }))
    .map(({ item, attachments }) =>
      createItem({
        persistId: item.id,
        queuedAt: item.queuedAt,
        content: item.content,
        ...(attachments?.length ? { attachments } : {}),
        ...(item.originalComposerHiddenContext
          ? { originalComposerHiddenContext: item.originalComposerHiddenContext }
          : {})
      })
    )
  return restored.length ? [...restored, ...(inMemory ?? [])] : undefined
}
