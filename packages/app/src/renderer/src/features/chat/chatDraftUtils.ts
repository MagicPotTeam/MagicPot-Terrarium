import type { ChatAttachment } from '@shared/api/svcLLMProxy'

export type ChatSessionDraftModel = {
  inputValue: string
  pendingAttachments: ChatAttachment[]
  pendingHiddenContext: string
  updatedAt: number
}

export const cloneChatAttachment = (attachment: ChatAttachment): ChatAttachment => ({
  ...attachment
})

export const cloneChatSessionDraft = <T extends ChatSessionDraftModel>(
  draft?: T | null
): T | undefined =>
  draft
    ? ({
        ...draft,
        pendingAttachments: draft.pendingAttachments.map(cloneChatAttachment)
      } as T)
    : undefined

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

  if (!inputValue && !pendingHiddenContext && pendingAttachments.length === 0) {
    return undefined
  }

  return {
    inputValue,
    pendingHiddenContext,
    pendingAttachments,
    updatedAt
  } as T
}

const buildChatDraftComparableValue = (
  draft?: ChatSessionDraftModel
): {
  inputValue: string
  pendingHiddenContext: string
  pendingAttachments: ChatAttachment[]
} | null =>
  draft
    ? {
        inputValue: draft.inputValue,
        pendingHiddenContext: draft.pendingHiddenContext,
        pendingAttachments: draft.pendingAttachments
      }
    : null

export const areChatSessionDraftsEqual = (
  left?: ChatSessionDraftModel | null,
  right?: ChatSessionDraftModel | null
): boolean =>
  JSON.stringify(buildChatDraftComparableValue(left || undefined)) ===
  JSON.stringify(buildChatDraftComparableValue(right || undefined))

export const stripSessionDraft = <T extends { draft?: unknown }>(session: T): Omit<T, 'draft'> => {
  const { draft, ...rest } = session
  void draft
  return rest
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
