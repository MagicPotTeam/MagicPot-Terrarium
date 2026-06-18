import type { ChatMessage } from '../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/api/LLM'
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
  compactRound?: number
  lastCompactAttemptAt?: number
  lastCompactSuccessAt?: number
  lastCompactFailureAt?: number
  lastCompactSkipReason?: string
  lastPromptTokens?: number
  lastTotalTokens?: number
  metadata?: Record<string, unknown>
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

export type ChatContextCompactWindow = {
  compactCount: number
  keepRecentCount: number
  compactMessages: ChatMessage[]
  liveMessages: ChatMessage[]
  reason?: 'ready' | 'too_short'
}

const KEEP_RECENT_USER_TURNS = 8
const MIN_COMPACTABLE_MESSAGES = 8
const SUMMARY_MAX_CHARS = 6_000
const MESSAGE_EXCERPT_MAX_CHARS = 320
const MAX_SUMMARY_LINES = 18
const MAX_KEY_SENTENCES = 8
const MAX_FILE_REFERENCES = 12
const SUMMARY_OUTPUT_TOKEN_MIN = 512
const SUMMARY_OUTPUT_TOKEN_MAX = 4_096

export const CHAT_CONTEXT_COMPACT_SYSTEM_PROMPT = `You are summarizing a conversation between an AI agent and a user (or between agents in a team).

Create a structured summary with these exact sections:

### Current Goal
What is the agent currently trying to achieve?

### Key Decisions
What important choices were made, and why? Include approximate position (early/mid/late in conversation).

### Progress
List completed, in-progress, and pending tasks. Use [DONE], [IN PROGRESS], [PENDING] markers.

### Files Modified
List files that were read, written, or edited with brief context.

### Key Facts
Important details that the agent needs to remember to continue working.

### Keywords
Comma-separated list of important terms for keyword search.

### Key Sentences
Exact quotes from the conversation that should be preserved verbatim.

Rules:
- Preserve decision rationale ("X because Y", not just "decided X")
- Keep exact file paths, line numbers, error codes verbatim
- Use relative temporal markers ("early in session", "after fixing X")
- Do NOT include raw tool output (it's searchable in session history)
- Focus on what the agent needs to CONTINUE working, not a narrative
- If there is a previous summary included, merge its information with new content`

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim()

const clipText = (value: string, limit: number): string => {
  const normalized = normalizeWhitespace(value)
  if (!normalized) {
    return ''
  }

  return normalized.length > limit ? `${normalized.slice(0, Math.max(0, limit - 1))}…` : normalized
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
  return labels.length > 0 ? `attachments: ${labels.join(', ')}${suffix}` : ''
}

const buildMessageDigestLine = (message: ChatMessage): string => {
  const roleLabel =
    message.role === 'assistant' ? 'Assistant' : message.role === 'user' ? 'User' : 'System'
  const visibleText = clipText(message.content, MESSAGE_EXCERPT_MAX_CHARS)
  const hiddenText = clipText(message.hiddenContext || '', 120)
  const attachmentText = buildAttachmentSummary(message)
  const parts = [
    visibleText,
    hiddenText ? `hidden context: ${hiddenText}` : '',
    attachmentText
  ].filter(Boolean)

  return `- ${roleLabel}: ${parts.join(' | ') || '(empty message)'}`
}

const getMessageSearchText = (message: ChatMessage): string =>
  [
    message.content,
    message.hiddenContext || '',
    ...(message.attachments || []).map((attachment) =>
      [attachment.fileName, attachment.relativePath, attachment.mimeType].filter(Boolean).join(' ')
    )
  ]
    .filter(Boolean)
    .join('\n')

const extractPotentialFileReferences = (messages: readonly ChatMessage[]): string[] => {
  const references = new Set<string>()
  const pathPattern =
    /(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\w@.-]+[\\/])(?:[\w@.()\-\s]+[\\/])*[\w@.()\-\s]+\.[A-Za-z0-9]{1,12}(?::\d+)?/g

  for (const message of messages) {
    for (const attachment of message.attachments || []) {
      const label = attachment.relativePath || attachment.fileName
      if (label) {
        references.add(label)
      }
    }

    for (const match of getMessageSearchText(message).matchAll(pathPattern)) {
      const value = clipText(match[0], 180)
      if (value) {
        references.add(value)
      }
    }
  }

  return [...references].slice(0, MAX_FILE_REFERENCES)
}

const extractKeywords = (messages: readonly ChatMessage[]): string[] => {
  const counts = new Map<string, number>()
  const ignored = new Set([
    'this',
    'that',
    'with',
    'from',
    'have',
    'will',
    'your',
    'about',
    'there',
    'their',
    'message',
    'assistant',
    'user'
  ])

  for (const message of messages) {
    const text = getMessageSearchText(message).toLowerCase()
    const words = text.match(/[a-z0-9_./:-]{4,}|[\p{Script=Han}]{2,}/gu) || []
    for (const word of words) {
      const normalized = word.replace(/^[-_.:/]+|[-_.:/]+$/g, '')
      if (!normalized || ignored.has(normalized)) continue
      counts.set(normalized, (counts.get(normalized) || 0) + 1)
    }
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 16)
    .map(([word]) => word)
}

const getLatestUserMessageExcerpt = (messages: readonly ChatMessage[]): string => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === 'user') {
      const excerpt = clipText(message.content || message.hiddenContext || '', 220)
      if (excerpt) return excerpt
    }
  }
  return ''
}

export const formatChatMessagesForContextSummary = (messages: readonly ChatMessage[]): string =>
  messages
    .map((message) => {
      const content = [
        message.content,
        message.hiddenContext ? `hidden context: ${message.hiddenContext}` : '',
        buildAttachmentSummary(message)
      ]
        .filter(Boolean)
        .join(' | ')
      const clippedContent =
        message.role === 'assistant' ? clipText(content, 1_200) : clipText(content, 2_000)
      return clippedContent ? `[${message.role}]: ${clippedContent}` : ''
    })
    .filter(Boolean)
    .join('\n\n')

const buildVisibleDigestLines = (messages: readonly ChatMessage[]): string[] => {
  const digestLines = messages.map(buildMessageDigestLine)
  if (digestLines.length <= MAX_SUMMARY_LINES) {
    return digestLines
  }

  return [
    ...digestLines.slice(0, 6),
    `- Middle omitted: ${digestLines.length - 16} compacted message(s).`,
    ...digestLines.slice(-10)
  ]
}

const appendLineWithinLimit = (lines: string[], line: string, maxChars: number): boolean => {
  const next = [...lines, line].join('\n')
  if (next.length > maxChars) {
    return false
  }
  lines.push(line)
  return true
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

export const resolveChatContextCompactWindow = (
  historyMessages: readonly ChatMessage[],
  options?: { keepRecentUserTurns?: number; minCompactableMessages?: number }
): ChatContextCompactWindow => {
  const messages = [...historyMessages]
  const totalCount = messages.length
  if (totalCount === 0) {
    return {
      compactCount: 0,
      keepRecentCount: 0,
      compactMessages: [],
      liveMessages: [],
      reason: 'too_short'
    }
  }

  const keepRecentUserTurns = Math.max(1, options?.keepRecentUserTurns || KEEP_RECENT_USER_TURNS)
  const minCompactableMessages = Math.max(
    1,
    options?.minCompactableMessages || MIN_COMPACTABLE_MESSAGES
  )
  let userTurnCount = 0
  let keepRecentCountByTurns = 0
  let foundTargetUserTurns = false

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    keepRecentCountByTurns += 1
    if (messages[index].role === 'user') {
      userTurnCount += 1
      if (userTurnCount >= keepRecentUserTurns) {
        foundTargetUserTurns = true
        break
      }
    }
  }

  const keepRecentCount = foundTargetUserTurns
    ? Math.min(keepRecentCountByTurns, totalCount)
    : totalCount < minCompactableMessages
      ? totalCount
      : Math.min(Math.max(1, Math.floor(totalCount / 2)), totalCount)
  const compactCount = Math.max(0, totalCount - keepRecentCount)

  return {
    compactCount,
    keepRecentCount,
    compactMessages: compactCount > 0 ? messages.slice(0, compactCount) : [],
    liveMessages: messages.slice(compactCount),
    reason: compactCount > 0 ? 'ready' : 'too_short'
  }
}

export const wrapChatContextCompactSummary = (summary: string, compactRound: number): string => {
  const normalized = summary.trim()
  if (!normalized) {
    return ''
  }

  if (normalized.startsWith('[Previous context summary')) {
    return normalized
  }

  return `[Previous context summary (compact round ${compactRound})]\n\n${normalized}`
}

export const resolveChatContextCompactSummaryMaxTokens = (
  profile?: ChatCapabilityProfile | null
): number => {
  const capabilities = resolveChatProfileCapabilities(profile)
  const contextWindowTokens =
    capabilities.contextWindowTokens || capabilities.contextBudgetTokens || 256_000
  return Math.max(
    SUMMARY_OUTPUT_TOKEN_MIN,
    Math.min(SUMMARY_OUTPUT_TOKEN_MAX, Math.floor(contextWindowTokens / 64))
  )
}

export const buildChatContextCompactPromptMessages = (input: {
  messages: readonly ChatMessage[]
  previousSummary?: string
}): ChatMessage[] => {
  const previousSummary = input.previousSummary?.trim()
  const summaryInputParts = [
    previousSummary ? `Previous summary to merge:\n\n${previousSummary}` : '',
    `Summarize this conversation:\n\n${formatChatMessagesForContextSummary(input.messages)}`
  ].filter(Boolean)

  return [
    {
      role: 'system',
      content: CHAT_CONTEXT_COMPACT_SYSTEM_PROMPT
    },
    {
      role: 'user',
      content: summaryInputParts.join('\n\n---\n\n')
    }
  ]
}

export const buildExtractiveContextSummary = (
  messages: readonly ChatMessage[],
  options?: { maxChars?: number; previousSummary?: string; compactRound?: number }
): string => {
  if (messages.length === 0) {
    return ''
  }

  const maxChars = options?.maxChars || SUMMARY_MAX_CHARS
  const lines: string[] = []
  if (options?.compactRound) {
    appendLineWithinLimit(
      lines,
      `[Previous context summary (compact round ${options.compactRound})]`,
      maxChars
    )
    appendLineWithinLimit(lines, '', maxChars)
  }

  const latestUserMessage = getLatestUserMessageExcerpt(messages)
  appendLineWithinLimit(lines, '### Current Goal', maxChars)
  appendLineWithinLimit(
    lines,
    latestUserMessage
      ? `Continue from the compacted conversation. Latest compacted user request: "${latestUserMessage}"`
      : 'Continue from the compacted conversation using the preserved facts below.',
    maxChars
  )
  appendLineWithinLimit(lines, '', maxChars)

  appendLineWithinLimit(lines, '### Key Decisions', maxChars)
  const assistantDigest = messages
    .filter((message) => message.role === 'assistant' && message.content.trim())
    .slice(-4)
    .map((message) => `- Assistant outcome: ${clipText(message.content, 240)}`)
  const decisionLines = assistantDigest.length
    ? assistantDigest
    : ['- No explicit assistant decisions were detected in the compacted slice.']
  for (const line of decisionLines) {
    if (!appendLineWithinLimit(lines, line, maxChars)) break
  }
  appendLineWithinLimit(lines, '', maxChars)

  appendLineWithinLimit(lines, '### Progress', maxChars)
  appendLineWithinLimit(
    lines,
    '- [DONE] Older conversation slice was compacted into this summary.',
    maxChars
  )
  appendLineWithinLimit(
    lines,
    '- [IN PROGRESS] Continue with the live recent messages that remain raw.',
    maxChars
  )
  appendLineWithinLimit(
    lines,
    '- [PENDING] Preserve user requests, assistant conclusions, files, and errors listed below.',
    maxChars
  )
  appendLineWithinLimit(lines, '', maxChars)

  appendLineWithinLimit(lines, '### Files Modified', maxChars)
  const fileReferences = extractPotentialFileReferences(messages)
  if (fileReferences.length > 0) {
    for (const reference of fileReferences) {
      if (!appendLineWithinLimit(lines, `- ${reference}`, maxChars)) break
    }
  } else {
    appendLineWithinLimit(
      lines,
      '- No explicit file paths or attachments detected in the compacted slice.',
      maxChars
    )
  }
  appendLineWithinLimit(lines, '', maxChars)

  appendLineWithinLimit(lines, '### Key Facts', maxChars)
  const previousSummary = clipText(options?.previousSummary || '', Math.floor(maxChars * 0.35))
  if (previousSummary) {
    appendLineWithinLimit(
      lines,
      `- Prior compacted summary to preserve: ${previousSummary}`,
      maxChars
    )
  }
  for (const line of buildVisibleDigestLines(messages)) {
    if (!appendLineWithinLimit(lines, line, maxChars)) break
  }
  appendLineWithinLimit(lines, '', maxChars)

  appendLineWithinLimit(lines, '### Keywords', maxChars)
  const keywords = extractKeywords(messages)
  appendLineWithinLimit(
    lines,
    keywords.length > 0 ? keywords.join(', ') : 'context, compacted-history',
    maxChars
  )
  appendLineWithinLimit(lines, '', maxChars)

  appendLineWithinLimit(lines, '### Key Sentences', maxChars)
  const keySentences = messages
    .map((message) => clipText(message.content || message.hiddenContext || '', 260))
    .filter(Boolean)
    .slice(-MAX_KEY_SENTENCES)
  if (keySentences.length > 0) {
    for (const sentence of keySentences) {
      if (!appendLineWithinLimit(lines, `- "${sentence}"`, maxChars)) break
    }
  } else {
    appendLineWithinLimit(
      lines,
      '- No text sentences were available in the compacted slice.',
      maxChars
    )
  }

  return lines.join('\n')
}

const resolveCompressionCount = (
  historyMessages: readonly ChatMessage[],
  requestTokens: number,
  contextBudgetTokens: number,
  force = false
): number => {
  if (
    !force &&
    requestTokens + estimateChatMessagesTokenCount(historyMessages) < contextBudgetTokens
  ) {
    return 0
  }

  return resolveChatContextCompactWindow(historyMessages).compactCount
}

export const buildChatContextCompressionPlan = (input: {
  historyMessages: readonly ChatMessage[]
  requestMessage: ChatMessage
  profile?: ChatCapabilityProfile | null
  enabled: boolean
  cachedSummary?: ChatContextCompressionSummary
  force?: boolean
}): ChatContextCompressionPlan => {
  const capabilities = resolveChatProfileCapabilities(input.profile)
  const contextBudgetTokens = capabilities.contextBudgetTokens ?? null
  const contextWindowTokens = capabilities.contextWindowTokens ?? null
  const requestTokens = estimateChatMessageTokenCount(input.requestMessage)
  const cachedSummary = input.cachedSummary?.summary.trim() ? input.cachedSummary : undefined
  const cachedSummaryTokens = cachedSummary ? estimateTextTokenCount(cachedSummary.summary) : 0
  const estimatedInputTokens =
    cachedSummaryTokens + estimateChatMessagesTokenCount(input.historyMessages) + requestTokens
  const usageRatio = contextBudgetTokens
    ? Math.min(1, estimatedInputTokens / contextBudgetTokens)
    : null

  if (!input.force && (!input.enabled || !contextBudgetTokens)) {
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

  const effectiveBudgetTokens = contextBudgetTokens || Number.MAX_SAFE_INTEGER
  const compressionCount = resolveCompressionCount(
    input.historyMessages,
    requestTokens + cachedSummaryTokens,
    effectiveBudgetTokens,
    input.force
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
  const compactRound = (cachedSummary?.compactRound || 0) + 1
  const canReuseCachedSummary =
    !cachedSummary?.manual &&
    cachedSummary?.coveredMessageCount === compressionCount &&
    cachedSummary?.sourceHash === sourceHash &&
    cachedSummary.summary.trim()
  const compressionSummary = canReuseCachedSummary
    ? cachedSummary
    : {
        summary: buildExtractiveContextSummary(messagesToCompress, {
          compactRound,
          previousSummary: cachedSummary?.summary
        }),
        coveredMessageCount: (cachedSummary?.coveredMessageCount || 0) + compressionCount,
        sourceHash: cachedSummary?.sourceHash
          ? `${cachedSummary.sourceHash}:${sourceHash}`
          : sourceHash,
        estimatedSourceTokens:
          (cachedSummary?.estimatedSourceTokens || 0) +
          estimateChatMessagesTokenCount(messagesToCompress),
        estimatedSummaryTokens: 0,
        updatedAt: Date.now(),
        ...(cachedSummary?.manual ? { manual: true } : {}),
        ...(cachedSummary?.metadata ? { metadata: cachedSummary.metadata } : {}),
        compactRound
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
