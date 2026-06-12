import type { ChatMessage } from '@shared/api/svcLLMProxy'
import type { ChatCapabilityProfile, ChatProfileCapabilities } from '@shared/llm'
import { resolveChatProfileCapabilities } from '@shared/llm'

export type ChatContextCompressionSummary = {
  summary: string
  coveredMessageCount: number
  sourceHash: string
  estimatedSourceTokens: number
  estimatedSummaryTokens: number
  updatedAt: number
  manual?: boolean
}

export type ChatContextCompressionPlan = {
  capabilities: ChatProfileCapabilities
  estimatedInputTokens: number
  contextBudgetTokens: number | null
  contextWindowTokens: number | null
  estimatedCompressedInputTokens: number
  usageRatio: number | null
  shouldCompress: boolean
  compressionSummary?: ChatContextCompressionSummary
  requestHistoryMessages: ChatMessage[]
}

const RETAIN_RECENT_MESSAGES = 8
const MIN_MESSAGES_TO_COMPRESS = 3
const SUMMARY_MAX_CHARS = 6_000
const MESSAGE_EXCERPT_MAX_CHARS = 320
const MAX_SUMMARY_LINES = 18

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim()

const clipText = (value: string, limit: number): string => {
  const normalized = normalizeWhitespace(value)
  if (!normalized) {
    return ''
  }

  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized
}

export const estimateTextTokenCount = (text: string | undefined | null): number => {
  const normalized = String(text || '')
  if (!normalized.trim()) {
    return 0
  }

  const glyphs = [...normalized]
  let wideGlyphCount = 0
  for (const glyph of glyphs) {
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(glyph)) {
      wideGlyphCount += 1
    }
  }

  const narrowGlyphCount = Math.max(0, glyphs.length - wideGlyphCount)
  return Math.max(1, Math.ceil(wideGlyphCount * 1.05 + narrowGlyphCount / 4))
}

const estimateAttachmentTokenCount = (message: ChatMessage): number =>
  (message.attachments || []).reduce((total, attachment) => {
    const descriptor = [
      attachment.type,
      attachment.fileName,
      attachment.mimeType,
      attachment.relativePath
    ]
      .filter(Boolean)
      .join(' ')
    return total + 28 + estimateTextTokenCount(descriptor)
  }, 0)

export const estimateChatMessageTokenCount = (message: ChatMessage): number =>
  10 +
  estimateTextTokenCount(message.content) +
  estimateTextTokenCount(message.hiddenContext) +
  estimateAttachmentTokenCount(message)

export const estimateChatMessagesTokenCount = (messages: readonly ChatMessage[]): number =>
  messages.reduce((total, message) => total + estimateChatMessageTokenCount(message), 0)

const buildAttachmentSummary = (message: ChatMessage): string => {
  const attachments = message.attachments || []
  if (attachments.length === 0) {
    return ''
  }

  const labels = attachments
    .slice(0, 4)
    .map((attachment) => attachment.fileName || attachment.type)
    .filter(Boolean)
  const suffix = attachments.length > labels.length ? ` +${attachments.length - labels.length}` : ''
  return labels.length > 0 ? `附件: ${labels.join(', ')}${suffix}` : ''
}

const buildMessageDigestLine = (message: ChatMessage): string => {
  const roleLabel =
    message.role === 'assistant' ? '助手' : message.role === 'user' ? '用户' : '系统'
  const visibleText = clipText(message.content, MESSAGE_EXCERPT_MAX_CHARS)
  const hiddenText = clipText(message.hiddenContext || '', 120)
  const attachmentText = buildAttachmentSummary(message)
  const parts = [visibleText, hiddenText ? `隐藏上下文: ${hiddenText}` : '', attachmentText].filter(
    Boolean
  )

  return `- ${roleLabel}: ${parts.join(' | ') || '(空消息)'}`
}

export const createContextCompressionSourceHash = (
  messages: readonly ChatMessage[],
  coveredMessageCount = messages.length
): string => {
  let hash = 2166136261
  for (const message of messages.slice(0, coveredMessageCount)) {
    const digest = [
      message.role,
      message.content,
      message.hiddenContext || '',
      ...(message.attachments || []).map(
        (attachment) =>
          `${attachment.type}:${attachment.fileName || ''}:${attachment.mimeType || ''}:${attachment.url || ''}`
      )
    ].join('\n')

    for (let index = 0; index < digest.length; index += 1) {
      hash ^= digest.charCodeAt(index)
      hash = Math.imul(hash, 16777619)
    }
  }

  return Math.abs(hash >>> 0).toString(16)
}

export const buildExtractiveContextSummary = (
  messages: readonly ChatMessage[],
  options?: { maxChars?: number }
): string => {
  if (messages.length === 0) {
    return ''
  }

  const maxChars = options?.maxChars || SUMMARY_MAX_CHARS
  const digestLines = messages.map(buildMessageDigestLine)
  const visibleLines =
    digestLines.length <= MAX_SUMMARY_LINES
      ? digestLines
      : [
          ...digestLines.slice(0, 6),
          `- 中间省略 ${digestLines.length - 16} 条更早消息`,
          ...digestLines.slice(-10)
        ]

  const summaryLines = ['较早对话的压缩背景信息：']
  for (const line of visibleLines) {
    const tentative = [...summaryLines, line].join('\n')
    if (tentative.length > maxChars) {
      break
    }
    summaryLines.push(line)
  }

  if (summaryLines.length === 1) {
    summaryLines.push('- 之前有较长历史，已压缩为背景信息。')
  }

  return summaryLines.join('\n')
}

const resolveCompressionCount = (
  historyMessages: readonly ChatMessage[],
  requestTokens: number,
  contextBudgetTokens: number
): number => {
  if (historyMessages.length <= RETAIN_RECENT_MESSAGES + MIN_MESSAGES_TO_COMPRESS) {
    return 0
  }

  const messageTokenCounts = historyMessages.map(estimateChatMessageTokenCount)
  let remainingHistoryTokens = messageTokenCounts.reduce((sum, count) => sum + count, 0)
  let compressionCount = 0
  const maxCompressionCount = Math.max(
    0,
    historyMessages.length - Math.min(RETAIN_RECENT_MESSAGES, historyMessages.length - 1)
  )

  while (
    compressionCount < maxCompressionCount &&
    requestTokens + remainingHistoryTokens > contextBudgetTokens
  ) {
    remainingHistoryTokens -= messageTokenCounts[compressionCount]
    compressionCount += 1
  }

  return compressionCount >= MIN_MESSAGES_TO_COMPRESS ? compressionCount : 0
}

export const buildChatContextCompressionPlan = (input: {
  historyMessages: readonly ChatMessage[]
  requestMessage: ChatMessage
  profile?: ChatCapabilityProfile | null
  enabled: boolean
  cachedSummary?: ChatContextCompressionSummary
}): ChatContextCompressionPlan => {
  const capabilities = resolveChatProfileCapabilities(input.profile)
  const contextBudgetTokens = capabilities.contextBudgetTokens ?? null
  const contextWindowTokens = capabilities.contextWindowTokens ?? null
  const requestTokens = estimateChatMessageTokenCount(input.requestMessage)
  const estimatedInputTokens = estimateChatMessagesTokenCount(input.historyMessages) + requestTokens
  const usageRatio = contextBudgetTokens
    ? Math.min(1, estimatedInputTokens / contextBudgetTokens)
    : null

  if (!input.enabled || !contextBudgetTokens) {
    return {
      capabilities,
      estimatedInputTokens,
      contextBudgetTokens,
      contextWindowTokens,
      estimatedCompressedInputTokens: estimatedInputTokens,
      usageRatio,
      shouldCompress: false,
      requestHistoryMessages: [...input.historyMessages]
    }
  }

  const compressionCount = resolveCompressionCount(
    input.historyMessages,
    requestTokens,
    contextBudgetTokens
  )
  if (compressionCount === 0) {
    return {
      capabilities,
      estimatedInputTokens,
      contextBudgetTokens,
      contextWindowTokens,
      estimatedCompressedInputTokens: estimatedInputTokens,
      usageRatio,
      shouldCompress: false,
      requestHistoryMessages: [...input.historyMessages]
    }
  }

  const messagesToCompress = input.historyMessages.slice(0, compressionCount)
  const requestHistoryMessages = input.historyMessages.slice(compressionCount)
  const sourceHash = createContextCompressionSourceHash(messagesToCompress)
  const compressionSummary =
    input.cachedSummary &&
    input.cachedSummary.coveredMessageCount === compressionCount &&
    input.cachedSummary.sourceHash === sourceHash &&
    input.cachedSummary.summary.trim()
      ? input.cachedSummary
      : {
          summary: buildExtractiveContextSummary(messagesToCompress),
          coveredMessageCount: compressionCount,
          sourceHash,
          estimatedSourceTokens: estimateChatMessagesTokenCount(messagesToCompress),
          estimatedSummaryTokens: 0,
          updatedAt: Date.now()
        }

  compressionSummary.estimatedSummaryTokens = estimateTextTokenCount(compressionSummary.summary)

  return {
    capabilities,
    estimatedInputTokens,
    contextBudgetTokens,
    contextWindowTokens,
    estimatedCompressedInputTokens:
      compressionSummary.estimatedSummaryTokens +
      estimateChatMessagesTokenCount(requestHistoryMessages) +
      requestTokens,
    usageRatio,
    shouldCompress: true,
    compressionSummary,
    requestHistoryMessages
  }
}
