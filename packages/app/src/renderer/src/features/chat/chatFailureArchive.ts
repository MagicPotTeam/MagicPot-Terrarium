import type { ChatMessage } from '@shared/api/svcLLMProxy'

export const formatChatFailureMessage = (message: string, runId?: string | null): string => {
  const normalized = message.trim()
  if (!runId || !normalized) return message
  return `${normalized} (Run: ${runId})`
}

export const resolveChatFailureArchiveRootDir = (options: {
  configDownloadDir?: string | null
  buildDataDir?: string | null
  localStorageOverride?: string | null
}): string | null => {
  const baseDir = (
    options.localStorageOverride ||
    options.configDownloadDir ||
    options.buildDataDir ||
    ''
  ).trim()
  return baseDir || null
}

export const readChatFailureArchiveRootDir = (options: {
  configDownloadDir?: string | null
  buildDataDir?: string | null
  storage?: Pick<Storage, 'getItem'>
}): string | null => {
  const downloadDirKey = 'qapp.downloadDir'
  const localOverride = (() => {
    try {
      return (options.storage || localStorage).getItem(downloadDirKey)
    } catch {
      return null
    }
  })()

  return resolveChatFailureArchiveRootDir({
    configDownloadDir: options.configDownloadDir,
    buildDataDir: options.buildDataDir,
    localStorageOverride: localOverride
  })
}

export const resolveChatFailureArchiveDir = (options: {
  baseDir: string
  runId: string
  pathJoin?: (...paths: string[]) => string
}): string => {
  if (options.pathJoin) {
    return options.pathJoin(options.baseDir, 'chat-failures', options.runId)
  }
  return `${options.baseDir.replace(/[\\/]+$/g, '')}/chat-failures/${options.runId}`
}

export const buildChatFailureArchivePayload = (options: {
  sessionId?: string | null
  profileId?: string | null
  skillId?: string | null
  error: string
  userMessage?: ChatMessage
  timestamp?: number
}) => ({
  runId: options.sessionId || null,
  profileId: options.profileId || null,
  skillId: options.skillId || null,
  error: options.error,
  createdAt: new Date(options.timestamp ?? Date.now()).toISOString(),
  userMessage: options.userMessage
    ? {
        role: options.userMessage.role,
        content: options.userMessage.content,
        attachments: options.userMessage.attachments?.map((attachment) => ({
          type: attachment.type,
          url: attachment.url,
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          sourceWidth: attachment.sourceWidth,
          sourceHeight: attachment.sourceHeight
        }))
      }
    : null
})
