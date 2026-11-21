// The save boundary's guard against inline images (FIX-PLAN item 4, part 1). An image attachment
// whose url is a base64 data: URL longer than CHAT_STORED_INLINE_ATTACHMENT_MAX_CHARS is moved to
// managed media and the record keeps the reference. Such a string is copied into every state
// copy, baseline, save and whole-scope read of its conversation; the reference is a few hundred
// characters. A save never waits for the import: it writes the image as it is (the user's message
// and the reply reach storage at once), the import runs outside the save chain, and the stored
// record is rewritten with the reference afterwards (InlineAttachmentBackgroundImports). When the
// import fails the image stays inline: the guard never drops an image and never fails a save.

import type { ChatAttachment, ChatMessage } from '@shared/api/svcLLMProxy'
import { normalizeMediaReference } from '@shared/mediaReference'
import { beginUnwrittenManagedMediaImports } from '@renderer/services/managedMediaUnwrittenImports'
import type { ChatSession } from './chatStorage'

/** An inline data: URL longer than this is not written to a stored conversation as it is. */
export const CHAT_STORED_INLINE_ATTACHMENT_MAX_CHARS = 64 * 1024

/** How long an inline image whose import failed is written as it is before it is tried again. */
export const INLINE_ATTACHMENT_IMPORT_RETRY_MS = 10 * 60_000

/** How long a finished import is reused for the same data: URL (a retried or superseded save). */
const RECENT_IMPORT_TTL_MS = 2 * 60_000
const RECENT_IMPORT_MAX_ENTRIES = 32
/** Images whose import failed recently, remembered so they are not tried again at once. */
const FAILED_IMPORT_MAX_ENTRIES = 256

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

/**
 * The identity of a data: URL the guard's caches are keyed by, never the URL itself (they would
 * keep megabytes of base64 alive): its length and two independent 32-bit hashes of every
 * character. A sample of the characters is not enough: two images that differ only between the
 * samples would share an import, and one would be stored as the other.
 */
const identityOf = (url: string): string => {
  let fnv = 0x811c9dc5
  let murmur = 0x9747b28c
  for (let index = 0; index < url.length; index += 1) {
    const code = url.charCodeAt(index)
    fnv = Math.imul(fnv ^ code, 0x01000193)
    murmur = Math.imul(murmur ^ code, 0x5bd1e995)
    murmur ^= murmur >>> 15
  }
  return `${url.length}:${(fnv >>> 0).toString(36)}:${(murmur >>> 0).toString(36)}`
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
  // Every cache is keyed by identityOf(url). Only a managed reference is kept as a value: a
  // data: URL result is never cached (the importer's result must be a managed reference).
  private readonly inFlight = new Map<string, Promise<InlineAttachmentReplacement | null>>()
  private readonly recent = new Map<
    string,
    { replacement: InlineAttachmentReplacement; at: number }
  >()
  private readonly failures = new Map<string, number>()
  // The identity of a url already hashed, for the string it was hashed from (the same string the
  // attachment holds, so nothing more is kept alive): saves see the same strings again and again.
  private readonly identities = new WeakMap<object, { url: string; identity: string }>()

  constructor(
    private readonly importAttachment: InlineAttachmentImporter,
    private readonly now: () => number = () => Date.now()
  ) {}

  private identity(attachment: ChatAttachment): string {
    const known = this.identities.get(attachment)
    if (known && known.url === attachment.url) return known.identity
    const identity = identityOf(attachment.url)
    this.identities.set(attachment, { url: attachment.url, identity })
    return identity
  }

  private shouldTry(attachment: ChatAttachment): boolean {
    if (this.failures.size === 0) return true
    const retryAt = this.failures.get(this.identity(attachment))
    return retryAt === undefined || retryAt <= this.now()
  }

  private noteFailure(identity: string): void {
    const now = this.now()
    for (const [key, retryAt] of this.failures) {
      if (retryAt <= now) this.failures.delete(key)
    }
    this.failures.delete(identity)
    this.failures.set(identity, now + INLINE_ATTACHMENT_IMPORT_RETRY_MS)
    while (this.failures.size > FAILED_IMPORT_MAX_ENTRIES) {
      const oldest = this.failures.keys().next().value
      if (oldest === undefined) break
      this.failures.delete(oldest)
    }
  }

  /** Whether a save of this conversation has inline images to import first (no allocation for none). */
  needsImport(session: ChatSession): boolean {
    let found = false
    forEachAttachmentList(session, (attachments) => {
      if (found) return
      found = attachments.some(
        (attachment) => isOversizedInlineImageAttachment(attachment) && this.shouldTry(attachment)
      )
    })
    return found
  }

  /** A finished import of this image that may still be reused. */
  private cachedReplacement(attachment: ChatAttachment): InlineAttachmentReplacement | null {
    const cached = this.recent.get(this.identity(attachment))
    return cached && this.now() - cached.at <= RECENT_IMPORT_TTL_MS ? cached.replacement : null
  }

  private importOne(attachment: ChatAttachment): Promise<InlineAttachmentReplacement | null> {
    const cached = this.cachedReplacement(attachment)
    if (cached) return Promise.resolve(cached)
    const identity = this.identity(attachment)
    const existing = this.inFlight.get(identity)
    if (existing) return existing
    const flight = (async () => {
      try {
        const replacement = toReplacement(attachment, await this.importAttachment(attachment))
        if (!replacement) throw new Error('The import did not return a managed reference')
        this.failures.delete(identity)
        this.remember(identity, replacement)
        return replacement
      } catch (error) {
        console.warn('[ChatInlineAttachmentGuard] Kept an inline image; its import failed:', error)
        this.noteFailure(identity)
        return null
      } finally {
        this.inFlight.delete(identity)
      }
    })()
    this.inFlight.set(identity, flight)
    return flight
  }

  private remember(identity: string, replacement: InlineAttachmentReplacement): void {
    const now = this.now()
    for (const [key, entry] of this.recent) {
      if (now - entry.at > RECENT_IMPORT_TTL_MS) this.recent.delete(key)
    }
    this.recent.delete(identity)
    this.recent.set(identity, { replacement, at: now })
    while (this.recent.size > RECENT_IMPORT_MAX_ENTRIES) {
      const oldest = this.recent.keys().next().value
      if (oldest === undefined) break
      this.recent.delete(oldest)
    }
  }

  /**
   * One attachment in its managed form when it is an oversized inline image that could be
   * imported; otherwise (or when its import fails) `attachment` itself. Never rejects.
   */
  async importInlineImage(attachment: ChatAttachment): Promise<ChatAttachment> {
    if (!isOversizedInlineImageAttachment(attachment) || !this.shouldTry(attachment)) {
      return attachment
    }
    const replacement = await this.importOne(attachment)
    return replacement ? { ...attachment, ...replacement } : attachment
  }

  /**
   * The stored form of `session` without waiting: references in place of the oversized inline
   * images whose import has already finished. `pending` is true when others are still to be
   * imported (they stay inline in this form). The same object when nothing was replaced.
   */
  externalizeKnown(session: ChatSession): ExternalizedSession & { pending: boolean } {
    const replacements = new Map<string, InlineAttachmentReplacement>()
    let pending = false
    forEachAttachmentList(session, (attachments) => {
      for (const attachment of attachments) {
        if (
          !isOversizedInlineImageAttachment(attachment) ||
          replacements.has(attachment.url) ||
          !this.shouldTry(attachment)
        ) {
          continue
        }
        const cached = this.cachedReplacement(attachment)
        if (cached) replacements.set(attachment.url, cached)
        else pending = true
      }
    })
    return {
      session: applyInlineAttachmentReplacements(session, replacements),
      replacements,
      pending
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
          this.shouldTry(attachment)
        ) {
          sources.set(attachment.url, attachment)
        }
      }
    })
    const replacements = new Map<string, InlineAttachmentReplacement>()
    // One at a time: each import sends one image to main.
    for (const [url, attachment] of sources) {
      const replacement = await this.importOne(attachment)
      if (replacement) replacements.set(url, replacement)
    }
    return { session: applyInlineAttachmentReplacements(session, replacements), replacements }
  }
}

/** How often one background run looks again for images that arrived while it was importing. */
const BACKGROUND_IMPORT_MAX_PASSES = 3

/**
 * Writes finished imports back into the stored conversation (in the save order, against the
 * record the owner expects) and into the owner's live state.
 */
export type InlineAttachmentsImported = (
  scope: string,
  sessionId: string,
  replacements: ReadonlyMap<string, InlineAttachmentReplacement>
) => Promise<void>

/**
 * The guard's imports, outside the save chain: a save writes what is known at once and asks for
 * the rest here. One run per conversation at a time; a request during a run is taken up by that
 * run when it has finished. While a run is open the reference scanner waits (its references are
 * not stored yet).
 */
export class InlineAttachmentBackgroundImports {
  private readonly runs = new Map<string, { latest: ChatSession | null }>()

  constructor(
    private readonly guard: ChatInlineAttachmentGuard,
    private readonly onImported: InlineAttachmentsImported,
    private readonly openUnwrittenWindow: () => () => void = beginUnwrittenManagedMediaImports
  ) {}

  /** Imports the oversized inline images of `session` that are not imported yet. */
  request(scope: string, session: ChatSession): void {
    const key = `${scope}\u0000${session.id}`
    const run = this.runs.get(key)
    if (run) {
      run.latest = session
      return
    }
    const state = { latest: null as ChatSession | null }
    this.runs.set(key, state)
    void this.run(key, scope, session, state)
  }

  /** Whether a run for this conversation is open. */
  isRunning(scope: string, sessionId: string): boolean {
    return this.runs.has(`${scope}\u0000${sessionId}`)
  }

  private async run(
    key: string,
    scope: string,
    first: ChatSession,
    state: { latest: ChatSession | null }
  ): Promise<void> {
    const close = this.openUnwrittenWindow()
    try {
      let session: ChatSession | null = first
      for (let pass = 0; session && pass < BACKGROUND_IMPORT_MAX_PASSES; pass += 1) {
        state.latest = null
        const { replacements } = await this.guard.externalize(session)
        if (replacements.size > 0) {
          try {
            await this.onImported(scope, session.id, replacements)
          } catch (error) {
            console.warn(
              '[ChatInlineAttachmentGuard] Imported images were not written back:',
              error
            )
          }
        }
        const latest: ChatSession | null = state.latest
        session = latest && this.guard.externalizeKnown(latest).pending ? latest : null
      }
    } finally {
      this.runs.delete(key)
      close()
    }
  }
}
