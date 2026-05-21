import type { CustomSkill } from '@shared/config/config'
import type { ChatMessage } from '../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/api/LLM'
import type { ChatSession } from './chatStorage'
import { generateUUID, normalizeChatProfileIdForStorage } from './chatPageShared'
import { NO_SKILL_VALUE, getSkillCategoryForSkillId, resolveCustomSkillId } from './chatSkillUtils'

const updateSessionById = (
  sessions: ChatSession[],
  sessionId: string,
  updater: (session: ChatSession) => ChatSession
): ChatSession[] =>
  sessions.map((session) => (session.id === sessionId ? updater(session) : session))

export const createChatSession = (
  title: string,
  profileId?: string | null,
  skillId?: string | null
): ChatSession => ({
  id: generateUUID(),
  title,
  messages: [],
  profileId: normalizeChatProfileIdForStorage(profileId),
  skillId: skillId || undefined,
  pinned: false,
  archived: false,
  createdAt: Date.now()
})

const getSessionCreatedAt = (session: ChatSession, fallbackIndex: number): number =>
  typeof session.createdAt === 'number' ? session.createdAt : -fallbackIndex

export const sortSessionsByRecencyDesc = (sessions: ChatSession[]): ChatSession[] =>
  [...sessions]
    .map((session, index) => ({ session, index }))
    .sort((left, right) => {
      const createdAtDiff =
        getSessionCreatedAt(right.session, right.index) -
        getSessionCreatedAt(left.session, left.index)

      if (createdAtDiff !== 0) {
        return createdAtDiff
      }

      return left.index - right.index
    })
    .map(({ session }) => session)

export const mergeLoadedSessionsWithLocal = (
  loadedSessions: ChatSession[],
  localSessions: ChatSession[],
  preserveSessionIds: Array<string | null | undefined> = []
): ChatSession[] => {
  const mergedSessions = new Map<string, ChatSession>()
  const preservedIds = new Set(
    preserveSessionIds.filter((sessionId): sessionId is string => Boolean(sessionId))
  )

  for (const session of loadedSessions) {
    mergedSessions.set(session.id, session)
  }

  for (const session of localSessions) {
    if (preservedIds.has(session.id) && !mergedSessions.has(session.id)) {
      mergedSessions.set(session.id, session)
    }
  }

  return sortSessionsByRecencyDesc([...mergedSessions.values()])
}

export const normalizeRestoredSkillSelection = (
  skills: CustomSkill[] | undefined,
  skillId: string | null | undefined
): { skillId: string | null; skillCategory: string } => {
  const normalizedSkillId = resolveCustomSkillId(skills, skillId)
  return {
    skillId: normalizedSkillId,
    skillCategory: normalizedSkillId
      ? getSkillCategoryForSkillId(skills, normalizedSkillId)
      : NO_SKILL_VALUE
  }
}

type ApplyUserMessageInput = {
  sessionId: string
  userMessage: ChatMessage
  baseMessages?: ChatMessage[]
  titleSource?: string
}

export const applyUserMessageToSession = (
  sessions: ChatSession[],
  input: ApplyUserMessageInput
): ChatSession[] =>
  updateSessionById(sessions, input.sessionId, (session) => {
    const baseMessages = input.baseMessages ?? session.messages

    return {
      ...session,
      draft: undefined,
      messages: [...baseMessages, input.userMessage],
      title:
        baseMessages.length === 0 && input.titleSource
          ? input.titleSource.slice(0, 30)
          : session.title
    }
  })

export const appendAssistantPlaceholderToSession = (
  sessions: ChatSession[],
  sessionId: string,
  modelName?: string
): ChatSession[] =>
  updateSessionById(sessions, sessionId, (session) => ({
    ...session,
    messages: [
      ...session.messages,
      {
        role: 'assistant',
        content: '',
        ...(modelName ? { modelName } : {})
      }
    ]
  }))

export const appendAssistantDeltaToSession = (
  sessions: ChatSession[],
  input: {
    sessionId: string
    delta: string
  }
): ChatSession[] =>
  updateSessionById(sessions, input.sessionId, (session) => {
    if (!input.delta) {
      return session
    }

    const lastMessage = session.messages[session.messages.length - 1]
    if (!lastMessage || lastMessage.role !== 'assistant') {
      return session
    }

    return {
      ...session,
      messages: [
        ...session.messages.slice(0, -1),
        {
          ...lastMessage,
          content: `${lastMessage.content || ''}${input.delta}`
        }
      ]
    }
  })

type ReplaceLastMessageInput = {
  sessionId: string
  message: ChatMessage
  sessionUrl?: string | null
}

type ReplaceLastMessagesInput = {
  sessionId: string
  messages: ChatMessage[]
  sessionUrl?: string | null
}

const resolveNextSessionUrl = (
  currentSessionUrl: string | undefined,
  nextSessionUrl?: string | null
): string | undefined => {
  if (nextSessionUrl === null) {
    return undefined
  }

  return nextSessionUrl || currentSessionUrl
}

export const replaceLastMessageInSession = (
  sessions: ChatSession[],
  input: ReplaceLastMessageInput
): ChatSession[] =>
  updateSessionById(sessions, input.sessionId, (session) => {
    let newTitle = session.title

    if (session.messages.length <= 2 && input.message.attachments?.length) {
      const firstAttachment = input.message.attachments[0]
      const potentialName =
        firstAttachment.fileName || firstAttachment.url?.split('/').pop()?.split('?')[0]
      if (potentialName) {
        newTitle = potentialName.slice(0, 30)
      }
    }

    return {
      ...session,
      title: newTitle,
      sessionUrl: resolveNextSessionUrl(session.sessionUrl, input.sessionUrl),
      messages:
        session.messages.length > 0
          ? [...session.messages.slice(0, -1), input.message]
          : [input.message]
    }
  })

export const replaceLastMessageWithMessagesInSession = (
  sessions: ChatSession[],
  input: ReplaceLastMessagesInput
): ChatSession[] =>
  updateSessionById(sessions, input.sessionId, (session) => {
    let newTitle = session.title
    const firstMessage = input.messages[0]

    if (session.messages.length <= 2 && firstMessage?.attachments?.length) {
      const firstAttachment = firstMessage.attachments[0]
      const potentialName =
        firstAttachment.fileName || firstAttachment.url?.split('/').pop()?.split('?')[0]
      if (potentialName) {
        newTitle = potentialName.slice(0, 30)
      }
    }

    return {
      ...session,
      title: newTitle,
      sessionUrl: resolveNextSessionUrl(session.sessionUrl, input.sessionUrl),
      messages:
        session.messages.length > 0
          ? [...session.messages.slice(0, -1), ...input.messages]
          : [...input.messages]
    }
  })

export const updateSessionUrl = (
  sessions: ChatSession[],
  sessionId: string,
  sessionUrl: string
): ChatSession[] =>
  updateSessionById(sessions, sessionId, (session) => ({
    ...session,
    sessionUrl
  }))

export const removeTrailingEmptyAssistantMessage = (
  sessions: ChatSession[],
  sessionId: string
): ChatSession[] =>
  updateSessionById(sessions, sessionId, (session) => {
    const lastMessage = session.messages[session.messages.length - 1]
    if (lastMessage?.role !== 'assistant' || lastMessage.content) {
      return session
    }

    return {
      ...session,
      messages: session.messages.slice(0, -1)
    }
  })

export const collectAssistantImageUrls = (session?: ChatSession): string[] => {
  if (!session) {
    return []
  }

  const imageUrls: string[] = []
  for (const message of session.messages) {
    if (message.role !== 'assistant' || !message.attachments) {
      continue
    }

    for (const attachment of message.attachments) {
      if (attachment.type === 'image' && attachment.url) {
        imageUrls.push(attachment.url)
      }
    }
  }
  return imageUrls
}

export const filterVisibleSessions = (
  sessions: ChatSession[],
  keyword: string,
  options?: { includeArchived?: boolean }
): ChatSession[] => {
  const normalizedKeyword = keyword.trim().toLowerCase()
  const includeArchived = options?.includeArchived ?? false
  const filtered = sessions.filter((session) => {
    if (!includeArchived && session.archived) {
      return false
    }
    if (!normalizedKeyword) {
      return true
    }

    const searchTarget = [
      session.title,
      ...session.messages.map((message) => message.content),
      ...(session.messages.flatMap(
        (message) => message.attachments?.map((attachment) => attachment.fileName || '') || []
      ) || [])
    ]
      .join('\n')
      .toLowerCase()

    return searchTarget.includes(normalizedKeyword)
  })

  const activeSessions = filtered.filter((session) => !session.archived)
  const archivedSessions = filtered.filter((session) => session.archived)
  return [...activeSessions, ...archivedSessions]
}
