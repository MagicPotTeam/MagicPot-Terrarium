import type { ChatMessage } from '@shared/api/svcLLMProxy'

const FALLBACK_CHAT_FAILURE_RUN_ID = 'unknown-run'
const MAX_CHAT_FAILURE_RUN_ID_LENGTH = 96

const replaceControlCharacters = (value: string): string =>
  Array.from(value)
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 0x1f || codePoint === 0x7f ? '-' : character
    })
    .join('')

export const sanitizeChatFailureArchiveRunId = (runId?: string | null): string => {
  const normalized = replaceControlCharacters(
    String(runId || '')
      .trim()
      .normalize('NFKD')
  )
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/[^\w.-]+/g, '-')
    .replace(/\.+/g, '.')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, MAX_CHAT_FAILURE_RUN_ID_LENGTH)

  return normalized || FALLBACK_CHAT_FAILURE_RUN_ID
}

const sanitizeChatFailureAttachmentUrl = (url?: string | null): string | undefined => {
  const trimmed = String(url || '').trim()
  if (!trimmed) return undefined

  if (/^data:/i.test(trimmed)) return '[redacted:data-url]'
  if (/^blob:/i.test(trimmed)) return '[redacted:blob-url]'
  if (/^file:/i.test(trimmed)) return '[redacted:local-file-url]'
  if (/^local-media:/i.test(trimmed)) return '[redacted:local-media-url]'

  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      parsed.username = ''
      parsed.password = ''
      parsed.search = ''
      parsed.hash = ''
      return parsed.toString()
    }
  } catch {
    // Fall through to a generic marker for malformed or non-URL attachment references.
  }

  return '[redacted:attachment-url]'
}

export const formatChatFailureMessage = (message: string, runId?: string | null): string => {
  const normalized = message.trim()
  if (!runId || !normalized) return message
  return `${normalized} (Run: ${sanitizeChatFailureArchiveRunId(runId)})`
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
  const safeRunId = sanitizeChatFailureArchiveRunId(options.runId)
  if (options.pathJoin) {
    return options.pathJoin(options.baseDir, 'chat-failures', safeRunId)
  }
  return `${options.baseDir.replace(/[\\/]+$/g, '')}/chat-failures/${safeRunId}`
}

export const buildChatFailureArchivePayload = (options: {
  sessionId?: string | null
  profileId?: string | null
  skillId?: string | null
  error: string
  userMessage?: ChatMessage
  timestamp?: number
}) => ({
  runId: options.sessionId ? sanitizeChatFailureArchiveRunId(options.sessionId) : null,
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
          url: sanitizeChatFailureAttachmentUrl(attachment.url),
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          sourceWidth: attachment.sourceWidth,
          sourceHeight: attachment.sourceHeight
        }))
      }
    : null
})
