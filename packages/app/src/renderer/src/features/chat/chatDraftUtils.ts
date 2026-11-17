import type { ChatAttachment } from '@shared/api/svcLLMProxy'

/**
 * An unaccepted user-authored queued send, as it is kept with the draft so it survives a reload.
 * Only the user's own text, durable attachments and the composer's own hidden context: never
 * callbacks, edit base messages, queue keys, a target session or generated team context.
 */
export type ChatDraftQueuedSend = {
  /** Stable across reloads; not the in-memory queue id. */
  id: string
  content: string
  attachments?: ChatAttachment[]
  originalComposerHiddenContext?: string
  queuedAt: number
}

export type ChatSessionDraftModel = {
  inputValue: string
  pendingAttachments: ChatAttachment[]
  pendingHiddenContext: string
  updatedAt: number
  /** Queued sends of this session; written only by the queue, independent of the composer fields. */
  queuedSends?: ChatDraftQueuedSend[]
  /** When queuedSends was written; updatedAt stays the composer's own timestamp. */
  queuedSendsUpdatedAt?: number
}

export const cloneChatAttachment = (attachment: ChatAttachment): ChatAttachment => ({
  ...attachment
})

export const cloneChatDraftQueuedSend = (item: ChatDraftQueuedSend): ChatDraftQueuedSend => ({
  ...item,
  ...(item.attachments ? { attachments: item.attachments.map(cloneChatAttachment) } : {})
})

export const cloneChatSessionDraft = <T extends ChatSessionDraftModel>(
  draft?: T | null
): T | undefined =>
  draft
    ? ({
        ...draft,
        pendingAttachments: draft.pendingAttachments.map(cloneChatAttachment),
        ...(draft.queuedSends ? { queuedSends: draft.queuedSends.map(cloneChatDraftQueuedSend) } : {})
      } as T)
    : undefined

const isFiniteTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/**
 * The queue part of a draft, or undefined when it holds neither a queued send nor a removal marker.
 * An empty list with a timestamp is a removal marker: the queue was emptied at that time, and it
 * outranks an older copy elsewhere (the draft backup or the session record).
 */
export const readDraftQueuedSends = (
  draft?: Partial<ChatSessionDraftModel> | null
): { queuedSends: ChatDraftQueuedSend[]; queuedSendsUpdatedAt: number } | undefined => {
  const queuedSends = Array.isArray(draft?.queuedSends)
    ? draft.queuedSends.filter(
        (item): item is ChatDraftQueuedSend =>
          Boolean(item) && typeof item.id === 'string' && Boolean(item.id) && typeof item.content === 'string'
      )
    : []
  const queuedSendsUpdatedAt = isFiniteTimestamp(draft?.queuedSendsUpdatedAt) ? draft.queuedSendsUpdatedAt : 0
  if (!queuedSends.length && queuedSendsUpdatedAt <= 0) return undefined
  return {
    queuedSends: queuedSends.map(cloneChatDraftQueuedSend),
    queuedSendsUpdatedAt
  }
}

export const normalizeChatSessionDraft = <T extends ChatSessionDraftModel = ChatSessionDraftModel>(
  draft?: Partial<T> | null
): T | undefined => {
  if (!draft) {
    return undefined
  }

  const inputValue = typeof draft.inputValue === 'string' ? draft.inputValue : ''
  const pendingHiddenContext =
    typeof draft.pendingHiddenContext === 'string' ? draft.pendingHiddenContext : ''
  const pendingAttachments = Array.isArray(draft.pendingAttachments)
    ? draft.pendingAttachments.map(cloneChatAttachment)
    : []
  const updatedAt =
    typeof draft.updatedAt === 'number' && Number.isFinite(draft.updatedAt)
      ? draft.updatedAt
      : Date.now()
  // A draft that holds only queued sends, or only a queue removal marker, is kept: its queue (or
  // the fact that the queue was emptied) must survive a reload.
  const queue = readDraftQueuedSends(draft)

  if (!inputValue && !pendingHiddenContext && pendingAttachments.length === 0 && !queue) {
    return undefined
  }

  return {
    inputValue,
    pendingHiddenContext,
    pendingAttachments,
    updatedAt,
    ...(queue ?? {})
  } as T
}

const buildChatDraftComparableValue = (
  draft?: ChatSessionDraftModel
): {
  inputValue: string
  pendingHiddenContext: string
  pendingAttachments: ChatAttachment[]
  queuedSends: ChatDraftQueuedSend[]
} | null =>
  draft
    ? {
        inputValue: draft.inputValue,
        pendingHiddenContext: draft.pendingHiddenContext,
        pendingAttachments: draft.pendingAttachments,
        queuedSends: draft.queuedSends ?? []
      }
    : null

export const areChatSessionDraftsEqual = (
  left?: ChatSessionDraftModel | null,
  right?: ChatSessionDraftModel | null
): boolean =>
  JSON.stringify(buildChatDraftComparableValue(left || undefined)) ===
  JSON.stringify(buildChatDraftComparableValue(right || undefined))

const buildChatComposerComparableValue = (
  draft?: ChatSessionDraftModel | null
): { inputValue: string; pendingHiddenContext: string; pendingAttachments: ChatAttachment[] } | null =>
  draft && (draft.inputValue || draft.pendingHiddenContext || draft.pendingAttachments.length)
    ? {
        inputValue: draft.inputValue,
        pendingHiddenContext: draft.pendingHiddenContext,
        pendingAttachments: draft.pendingAttachments
      }
    : null

/** Equality of the composer fields only: the queue part has its own owner. */
export const areChatComposerDraftsEqual = (
  left?: ChatSessionDraftModel | null,
  right?: ChatSessionDraftModel | null
): boolean =>
  JSON.stringify(buildChatComposerComparableValue(left)) ===
  JSON.stringify(buildChatComposerComparableValue(right))

/**
 * The draft with its queue part taken from queueSource: the composer fields and the queue are
 * written by different owners, and neither may drop the other's part.
 */
export const withDraftQueuedSends = <T extends ChatSessionDraftModel>(
  composerDraft: T | undefined,
  queueSource?: Partial<ChatSessionDraftModel> | null
): T | undefined => {
  const queue = readDraftQueuedSends(queueSource)
  if (!composerDraft && !queue) return undefined
  const base = (composerDraft ?? {
    inputValue: '',
    pendingAttachments: [],
    pendingHiddenContext: '',
    updatedAt: 0
  }) as T
  const { queuedSends: _queued, queuedSendsUpdatedAt: _queuedAt, ...composer } = base
  return (queue ? { ...composer, ...queue } : composer) as T
}

// Removes the composer part of a session's draft; its queued sends stay (they have their own owner).
// A session without its own draft is returned as is: a new identity would make the page save the whole
// unchanged conversation again.
export const stripSessionDraft = <T extends { draft?: unknown }>(session: T): Omit<T, 'draft'> => {
  if (!Object.hasOwn(session, 'draft')) return session
  const { draft, ...rest } = session
  const queue = readDraftQueuedSends(draft as Partial<ChatSessionDraftModel> | undefined)
  if (!queue) return rest
  const current = draft as ChatSessionDraftModel
  if (!current.inputValue && !current.pendingHiddenContext && !current.pendingAttachments?.length) {
    return session
  }
  return {
    ...rest,
    draft: { inputValue: '', pendingAttachments: [], pendingHiddenContext: '', updatedAt: 0, ...queue }
  } as Omit<T, 'draft'>
}

/**
 * The freshest copy of a session's queued sends: the backup wins a tie (it is written first). Both
 * copies may hold a removal marker (an empty list with a timestamp); a newer marker beats an older
 * list, so an accepted or removed item never comes back from a stale copy.
 */
export const resolvePreferredQueuedSends = (
  sessionDraft: Partial<ChatSessionDraftModel> | undefined | null,
  backupRecord?: { queuedSends?: ChatDraftQueuedSend[]; queuedSendsUpdatedAt?: number } | null
): { queuedSends: ChatDraftQueuedSend[]; queuedSendsUpdatedAt: number } => {
  const fromSession = readDraftQueuedSends(sessionDraft)
  const sessionUpdatedAt = fromSession?.queuedSendsUpdatedAt ?? 0
  const backupUpdatedAt = isFiniteTimestamp(backupRecord?.queuedSendsUpdatedAt)
    ? backupRecord.queuedSendsUpdatedAt
    : undefined
  if (backupUpdatedAt !== undefined && backupUpdatedAt >= sessionUpdatedAt) {
    const fromBackup = readDraftQueuedSends(backupRecord)
    return fromBackup
      ? { queuedSends: fromBackup.queuedSends, queuedSendsUpdatedAt: backupUpdatedAt }
      : { queuedSends: [], queuedSendsUpdatedAt: backupUpdatedAt }
  }
  return fromSession ?? { queuedSends: [], queuedSendsUpdatedAt: 0 }
}

export const resolvePreferredSessionDraft = <T extends ChatSessionDraftModel>(options: {
  sessionId: string | null
  sessionDraft: T | undefined
  storageScope: string
  readSessionDraftBackup: (
    sessionId: string,
    storageScope: string
  ) => { updatedAt: number; draft?: T } | undefined
}): T | undefined => {
  const normalizedSessionDraft = cloneChatSessionDraft(
    normalizeChatSessionDraft<T>(options.sessionDraft)
  )
  if (!options.sessionId) {
    return normalizedSessionDraft
  }

  const backupRecord = options.readSessionDraftBackup(options.sessionId, options.storageScope)
  if (!backupRecord) {
    return normalizedSessionDraft
  }

  const normalizedBackupDraft = cloneChatSessionDraft(
    normalizeChatSessionDraft<T>(backupRecord.draft)
  )
  const sessionUpdatedAt = normalizedSessionDraft?.updatedAt ?? 0
  if (backupRecord.updatedAt >= sessionUpdatedAt) {
    return normalizedBackupDraft
  }

  return normalizedSessionDraft
}
