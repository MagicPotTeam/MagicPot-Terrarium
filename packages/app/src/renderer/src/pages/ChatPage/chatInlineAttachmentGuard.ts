// The save boundary's guard against inline images (FIX-PLAN item 4, part 1). An image attachment
// whose url is a base64 data: URL longer than CHAT_STORED_INLINE_ATTACHMENT_MAX_CHARS is never
// written as it is: it is imported into managed media first and the record keeps the reference.
// Such a string is copied into every state copy, baseline, save and whole-scope read of its
// conversation; the reference is a few hundred characters. When the import fails the attachment
// is written as it was: the guard never drops an image and never fails a save.

import type { ChatAttachment, ChatMessage } from '@shared/api/svcLLMProxy'
import { normalizeMediaReference } from '@shared/mediaReference'
import type { ChatSession } from './chatStorage'

/** An inline data: URL longer than this is not written to a stored conversation as it is. */
export const CHAT_STORED_INLINE_ATTACHMENT_MAX_CHARS = 64 * 1024

/** How long an inline image whose import failed is written as it is before it is tried again. */
export const INLINE_ATTACHMENT_IMPORT_RETRY_MS = 10 * 60_000

/** How long a finished import is reused for the same data: URL (a retried or superseded save). */
const RECENT_IMPORT_TTL_MS = 2 * 60_000
const RECENT_IMPORT_MAX_ENTRIES = 32

/** The formats the managed media store holds; any other inline image is left as it is. */
const IMPORTABLE_INLINE_IMAGE_PREFIX = /^data:image\/(?:png|jpeg|webp|gif);base64,/i

/** The fields an imported attachment takes from its managed copy; every other field is kept. */
export type InlineAttachmentReplacement = Pick<ChatAttachment, 'url' | 'media'> &
  Partial<Pick<ChatAttachment, 'mimeType' | 'sizeBytes'>>

/** Imports one inline image attachment; resolves to its managed form or rejects. */
export type InlineAttachmentImporter = (attachment: ChatAttachment) => Promise<ChatAttachment>

/** An image attachment the guard imports before a save: a long, base64 data: URL of a stored format. */
export const isOversizedInlineImageAttachment = (attachment: unknown): boolean => {
  if (!attachment || typeof attachment !== 'object') return false
  const { type, url } = attachment as Partial<ChatAttachment>
  return (
    type === 'image' &&
    typeof url === 'string' &&
    url.length > CHAT_STORED_INLINE_ATTACHMENT_MAX_CHARS &&
    IMPORTABLE_INLINE_IMAGE_PREFIX.test(url.slice(0, 32))
  )
}

const messageLists = (session: ChatSession): (readonly ChatMessage[] | undefined)[] => [
  session.messages,
  session.compactedMessages,
  session.contextCompression?.replayImageMessages
]

/** Every attachment list a stored conversation holds: messages, compacted history, replay, draft. */
const forEachAttachmentList = (
  session: ChatSession,
  visit: (attachments: readonly ChatAttachment[]) => void
): void => {
  for (const messages of messageLists(session)) {
    if (!Array.isArray(messages)) continue
    for (const message of messages) {
      if (Array.isArray(message?.attachments) && message.attachments.length > 0) {
        visit(message.attachments)
      }
    }
  }
  const draft = session.draft
  if (Array.isArray(draft?.pendingAttachments) && draft.pendingAttachments.length > 0) {
    visit(draft.pendingAttachments)
  }
  if (Array.isArray(draft?.queuedSends)) {
    for (const item of draft.queuedSends) {
      if (Array.isArray(item?.attachments) && item.attachments.length > 0) visit(item.attachments)
    }
  }
}

const replaceInAttachments = <T extends readonly ChatAttachment[] | undefined>(
  attachments: T,
  replacements: ReadonlyMap<string, InlineAttachmentReplacement>
): T => {
  if (!Array.isArray(attachments) || attachments.length === 0) return attachments
  let next: ChatAttachment[] | undefined
  attachments.forEach((attachment, index) => {
    if (attachment?.type !== 'image' || typeof attachment.url !== 'string') return
    const replacement = replacements.get(attachment.url)
    if (!replacement) return
    next ??= [...attachments]
    next[index] = { ...attachment, ...replacement }
  })
  return (next ?? attachments) as T
}

const replaceInMessages = <T extends readonly ChatMessage[] | undefined>(
  messages: T,
  replacements: ReadonlyMap<string, InlineAttachmentReplacement>
): T => {
  if (!Array.isArray(messages)) return messages
  let next: ChatMessage[] | undefined
  messages.forEach((message, index) => {
    const attachments = replaceInAttachments(message?.attachments, replacements)
    if (attachments === message?.attachments) return
    next ??= [...messages]
    next[index] = { ...message, attachments }
  })
  return (next ?? messages) as T
}

/**
 * `session` with every image attachment whose url has a replacement switched to its managed form,
 * wherever the session keeps attachments. The same object when nothing matches; unchanged
 * messages, lists and drafts keep their identity.
 */
export const applyInlineAttachmentReplacements = (
  session: ChatSession,
  replacements: ReadonlyMap<string, InlineAttachmentReplacement>
): ChatSession => {
  if (replacements.size === 0) return session
  const changes: Partial<ChatSession> = {}
  const messages = replaceInMessages(session.messages, replacements)
  if (messages !== session.messages) changes.messages = messages
  const compactedMessages = replaceInMessages(session.compactedMessages, replacements)
  if (compactedMessages !== session.compactedMessages) changes.compactedMessages = compactedMessages
  const compression = session.contextCompression
  const replayImageMessages = replaceInMessages(compression?.replayImageMessages, replacements)
  if (compression && replayImageMessages !== compression.replayImageMessages) {
    changes.contextCompression = { ...compression, replayImageMessages }
  }
  const draft = session.draft
  if (draft) {
    const pendingAttachments = replaceInAttachments(draft.pendingAttachments, replacements)
    const storedQueue = draft.queuedSends
    let queuedSends = storedQueue
    if (Array.isArray(storedQueue)) {
      let nextQueue: NonNullable<typeof storedQueue> | undefined
      storedQueue.forEach((item, index) => {
        const attachments = replaceInAttachments(item?.attachments, replacements)
        if (attachments === item?.attachments) return
        nextQueue ??= [...storedQueue]
        nextQueue[index] = { ...item, attachments }
      })
      queuedSends = nextQueue ?? storedQueue
    }
    if (pendingAttachments !== draft.pendingAttachments || queuedSends !== draft.queuedSends) {
      changes.draft = { ...draft, pendingAttachments, ...(queuedSends ? { queuedSends } : {}) }
    }
  }
  return Object.keys(changes).length > 0 ? { ...session, ...changes } : session
}

/** A cheap identity for a data: URL (length and a sample of its characters), never the URL. */
const fingerprintOf = (url: string): string => {
  let hash = 0x811c9dc5
  const sample = (start: number, end: number): void => {
    for (let index = Math.max(0, start); index < Math.min(url.length, end); index += 1) {
      hash ^= url.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193)
    }
  }
  const middle = Math.floor(url.length / 2)
  sample(0, 2048)
  sample(middle - 1024, middle + 1024)
  sample(url.length - 2048, url.length)
  return `${url.length}:${(hash >>> 0).toString(36)}`
}

const toReplacement = (
  source: ChatAttachment,
  imported: ChatAttachment
): InlineAttachmentReplacement | null => {
  const reference = normalizeMediaReference(imported?.media)
  const url = typeof imported?.url === 'string' ? imported.url : ''
  if (reference?.kind !== 'managed' || !url || url.startsWith('data:') || url.startsWith('blob:')) {
    return null
  }
  return {
    url,
    media: imported.media,
    ...(imported.mimeType || source.mimeType
      ? { mimeType: imported.mimeType || source.mimeType }
      : {}),
    ...(typeof imported.sizeBytes === 'number' ? { sizeBytes: imported.sizeBytes } : {})
  }
}

export type ExternalizedSession = {
  session: ChatSession
  replacements: ReadonlyMap<string, InlineAttachmentReplacement>
}

/**
 * Imports the oversized inline images of a conversation into managed media, one at a time, and
 * returns the conversation with references in their place. The same data: URL is imported once
 * (concurrent saves share the import; a retried save reuses it for a short while). An image whose
 * import fails is kept inline and is not tried again before INLINE_ATTACHMENT_IMPORT_RETRY_MS.
 */
export class ChatInlineAttachmentGuard {
  private readonly inFlight = new Map<string, Promise<InlineAttachmentReplacement | null>>()
  private readonly recent = new Map<
    string,
    { replacement: InlineAttachmentReplacement; at: number }
  >()
  private readonly failures = new Map<string, number>()

  constructor(
    private readonly importAttachment: InlineAttachmentImporter,
    private readonly now: () => number = () => Date.now()
  ) {}

  private shouldTry(url: string): boolean {
    if (this.failures.size === 0) return true
    const retryAt = this.failures.get(fingerprintOf(url))
    return retryAt === undefined || retryAt <= this.now()
  }

  /** Whether a save of this conversation has inline images to import first (no allocation for none). */
  needsImport(session: ChatSession): boolean {
    let found = false
    forEachAttachmentList(session, (attachments) => {
      if (found) return
      found = attachments.some(
        (attachment) =>
          isOversizedInlineImageAttachment(attachment) && this.shouldTry(attachment.url)
      )
    })
    return found
  }

  private importOne(
    url: string,
    attachment: ChatAttachment
  ): Promise<InlineAttachmentReplacement | null> {
    const cached = this.recent.get(url)
    if (cached && this.now() - cached.at <= RECENT_IMPORT_TTL_MS) {
      return Promise.resolve(cached.replacement)
    }
    const existing = this.inFlight.get(url)
    if (existing) return existing
    const flight = (async () => {
      try {
        const replacement = toReplacement(attachment, await this.importAttachment(attachment))
        if (!replacement) throw new Error('The import did not return a managed reference')
        this.failures.delete(fingerprintOf(url))
        this.remember(url, replacement)
        return replacement
      } catch (error) {
        console.warn('[ChatInlineAttachmentGuard] Kept an inline image; its import failed:', error)
        this.failures.set(fingerprintOf(url), this.now() + INLINE_ATTACHMENT_IMPORT_RETRY_MS)
        return null
      } finally {
        this.inFlight.delete(url)
      }
    })()
    this.inFlight.set(url, flight)
    return flight
  }

  private remember(url: string, replacement: InlineAttachmentReplacement): void {
    const now = this.now()
    for (const [key, entry] of this.recent) {
      if (now - entry.at > RECENT_IMPORT_TTL_MS) this.recent.delete(key)
    }
    this.recent.delete(url)
    this.recent.set(url, { replacement, at: now })
    while (this.recent.size > RECENT_IMPORT_MAX_ENTRIES) {
      const oldest = this.recent.keys().next().value
      if (oldest === undefined) break
      this.recent.delete(oldest)
    }
  }

  /**
   * The stored form of `session`: references in place of the oversized inline images that could
   * be imported, every other value as it is. Resolves to the same object when nothing was
   * replaced. Never rejects.
   */
  async externalize(session: ChatSession): Promise<ExternalizedSession> {
    const sources = new Map<string, ChatAttachment>()
    forEachAttachmentList(session, (attachments) => {
      for (const attachment of attachments) {
        if (
          isOversizedInlineImageAttachment(attachment) &&
          !sources.has(attachment.url) &&
          this.shouldTry(attachment.url)
        ) {
          sources.set(attachment.url, attachment)
        }
      }
    })
    const replacements = new Map<string, InlineAttachmentReplacement>()
    // One at a time: each import sends one image to main.
    for (const [url, attachment] of sources) {
      const replacement = await this.importOne(url, attachment)
      if (replacement) replacements.set(url, replacement)
    }
    return { session: applyInlineAttachmentReplacements(session, replacements), replacements }
  }
}
