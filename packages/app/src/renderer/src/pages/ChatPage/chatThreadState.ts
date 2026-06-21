import type { ChatMessage } from '@shared/api/svcLLMProxy'
import {
  estimateChatMessagesTokenCount,
  estimateTextTokenCount,
  type ChatContextCompressionSummary
} from './chatContextCompression'

export type ChatThreadToolHistoryEntry = {
  id: string
  toolName: string
  args?: Record<string, unknown>
  status: 'running' | 'success' | 'error'
  startedAt: number
  finishedAt?: number
  durationMs?: number
  resultPreview?: string
  error?: string
}

export type ChatThreadMemoryKind = 'turn' | 'tool' | 'compression' | 'scratchpad'

export type ChatThreadMemoryEntry = {
  id: string
  kind: ChatThreadMemoryKind
  title: string
  text: string
  createdAt: number
  updatedAt?: number
  role?: ChatMessage['role']
  sourceMessageIndex?: number
  sourceHash?: string
  toolName?: string
  estimatedTokens?: number
}

export type ChatThreadCompressionRecord = {
  id: string
  createdAt: number
  manual?: boolean
  coveredMessageCount: number
  sourceHash: string
  estimatedSourceTokens: number
  estimatedSummaryTokens: number
  estimatedAfterTokens?: number
  summary: string
}

export type ChatThreadState = {
  scratchpad?: string
  memoryEntries?: ChatThreadMemoryEntry[]
  toolHistory?: ChatThreadToolHistoryEntry[]
  compressionRecords?: ChatThreadCompressionRecord[]
}

export type ChatThreadMemorySearchMode = 'auto' | 'fts' | 'semantic' | 'hybrid'

const MAX_MEMORY_ENTRIES = 240
const MAX_TOOL_HISTORY_ENTRIES = 160
const MAX_COMPRESSION_RECORDS = 80
const MEMORY_ENTRY_TEXT_MAX_CHARS = 4_000
const MEMORY_ENTRY_TITLE_MAX_CHARS = 96
const TOOL_RESULT_PREVIEW_MAX_CHARS = 2_000
const CONTEXT_MEMORY_ENTRY_MAX_CHARS = 900

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const normalizeString = (value: unknown): string => String(value || '').trim()

export const clipChatThreadText = (value: unknown, limit: number): string => {
  const normalized = normalizeString(value).replace(/\s+/g, ' ')
  if (!normalized) return ''
  return normalized.length > limit ? `${normalized.slice(0, Math.max(0, limit - 1))}…` : normalized
}

const createThreadStateId = (prefix: string): string => {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `${prefix}-${crypto.randomUUID()}`
    }
  } catch {
    /* ignore */
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

const normalizeTimestamp = (value: unknown, fallback = Date.now()): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback

const normalizeToolHistoryEntry = (value: unknown): ChatThreadToolHistoryEntry | null => {
  if (!isPlainObject(value)) return null
  const toolName = normalizeString(value.toolName)
  if (!toolName) return null
  const status =
    value.status === 'running' || value.status === 'success' || value.status === 'error'
      ? value.status
      : 'success'
  return {
    id: normalizeString(value.id) || createThreadStateId('tool'),
    toolName,
    ...(isPlainObject(value.args) ? { args: value.args } : {}),
    status,
    startedAt: normalizeTimestamp(value.startedAt),
    ...(typeof value.finishedAt === 'number' && Number.isFinite(value.finishedAt)
      ? { finishedAt: value.finishedAt }
      : {}),
    ...(typeof value.durationMs === 'number' && Number.isFinite(value.durationMs)
      ? { durationMs: Math.max(0, value.durationMs) }
      : {}),
    ...(normalizeString(value.resultPreview)
      ? { resultPreview: clipChatThreadText(value.resultPreview, TOOL_RESULT_PREVIEW_MAX_CHARS) }
      : {}),
    ...(normalizeString(value.error) ? { error: clipChatThreadText(value.error, 600) } : {})
  }
}

const normalizeMemoryEntry = (value: unknown): ChatThreadMemoryEntry | null => {
  if (!isPlainObject(value)) return null
  const text = normalizeString(value.text)
  if (!text) return null
  const kind =
    value.kind === 'tool' ||
    value.kind === 'compression' ||
    value.kind === 'scratchpad' ||
    value.kind === 'turn'
      ? value.kind
      : 'turn'
  const role =
    value.role === 'system' || value.role === 'user' || value.role === 'assistant'
      ? value.role
      : undefined
  return {
    id: normalizeString(value.id) || createThreadStateId('memory'),
    kind,
    title: clipChatThreadText(value.title || text, MEMORY_ENTRY_TITLE_MAX_CHARS),
    text: clipChatThreadText(text, MEMORY_ENTRY_TEXT_MAX_CHARS),
    createdAt: normalizeTimestamp(value.createdAt),
    ...(typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
      ? { updatedAt: value.updatedAt }
      : {}),
    ...(role ? { role } : {}),
    ...(typeof value.sourceMessageIndex === 'number' && Number.isFinite(value.sourceMessageIndex)
      ? { sourceMessageIndex: value.sourceMessageIndex }
      : {}),
    ...(normalizeString(value.sourceHash) ? { sourceHash: normalizeString(value.sourceHash) } : {}),
    ...(normalizeString(value.toolName) ? { toolName: normalizeString(value.toolName) } : {}),
    ...(typeof value.estimatedTokens === 'number' && Number.isFinite(value.estimatedTokens)
      ? { estimatedTokens: Math.max(0, Math.round(value.estimatedTokens)) }
      : {})
  }
}

const normalizeCompressionRecord = (value: unknown): ChatThreadCompressionRecord | null => {
  if (!isPlainObject(value)) return null
  const summary = normalizeString(value.summary)
  const sourceHash = normalizeString(value.sourceHash)
  if (!summary || !sourceHash) return null
  return {
    id: normalizeString(value.id) || `compression-${sourceHash}`,
    createdAt: normalizeTimestamp(value.createdAt),
    ...(value.manual === true ? { manual: true } : {}),
    coveredMessageCount:
      typeof value.coveredMessageCount === 'number' && Number.isFinite(value.coveredMessageCount)
        ? Math.max(0, Math.round(value.coveredMessageCount))
        : 0,
    sourceHash,
    estimatedSourceTokens:
      typeof value.estimatedSourceTokens === 'number' &&
      Number.isFinite(value.estimatedSourceTokens)
        ? Math.max(0, Math.round(value.estimatedSourceTokens))
        : estimateTextTokenCount(summary),
    estimatedSummaryTokens:
      typeof value.estimatedSummaryTokens === 'number' &&
      Number.isFinite(value.estimatedSummaryTokens)
        ? Math.max(0, Math.round(value.estimatedSummaryTokens))
        : estimateTextTokenCount(summary),
    ...(typeof value.estimatedAfterTokens === 'number' &&
    Number.isFinite(value.estimatedAfterTokens)
      ? { estimatedAfterTokens: Math.max(0, Math.round(value.estimatedAfterTokens)) }
      : {}),
    summary
  }
}

export const normalizeChatThreadState = (value: unknown): ChatThreadState => {
  if (!isPlainObject(value)) return {}

  const scratchpad = normalizeString(value.scratchpad)
  const memoryEntries = Array.isArray(value.memoryEntries)
    ? value.memoryEntries
        .map(normalizeMemoryEntry)
        .filter((entry): entry is ChatThreadMemoryEntry => Boolean(entry))
    : []
  const toolHistory = Array.isArray(value.toolHistory)
    ? value.toolHistory
        .map(normalizeToolHistoryEntry)
        .filter((entry): entry is ChatThreadToolHistoryEntry => Boolean(entry))
    : []
  const compressionRecords = Array.isArray(value.compressionRecords)
    ? value.compressionRecords
        .map(normalizeCompressionRecord)
        .filter((entry): entry is ChatThreadCompressionRecord => Boolean(entry))
    : []

  return {
    ...(scratchpad ? { scratchpad } : {}),
    ...(memoryEntries.length ? { memoryEntries: memoryEntries.slice(-MAX_MEMORY_ENTRIES) } : {}),
    ...(toolHistory.length ? { toolHistory: toolHistory.slice(-MAX_TOOL_HISTORY_ENTRIES) } : {}),
    ...(compressionRecords.length
      ? { compressionRecords: compressionRecords.slice(-MAX_COMPRESSION_RECORDS) }
      : {})
  }
}

const formatAttachmentMemoryText = (message: ChatMessage): string => {
  const attachments = message.attachments || []
  if (!attachments.length) return ''
  return attachments
    .slice(0, 8)
    .map((attachment) =>
      [attachment.type, attachment.fileName, attachment.mimeType, attachment.relativePath]
        .filter(Boolean)
        .join(' ')
    )
    .filter(Boolean)
    .join('; ')
}

export const buildMessageMemoryText = (message: ChatMessage): string => {
  const parts = [normalizeString(message.content), normalizeString(message.hiddenContext)]
  const attachmentText = formatAttachmentMemoryText(message)
  if (attachmentText) {
    parts.push(`Attachments: ${attachmentText}`)
  }
  return parts.filter(Boolean).join('\n')
}

const getRoleLabel = (role: ChatMessage['role']): string =>
  role === 'assistant' ? 'Assistant' : role === 'user' ? 'User' : 'System'

export const buildMemoryEntriesFromMessages = (
  messages: readonly ChatMessage[],
  options?: {
    createdAt?: number
    idPrefix?: string
  }
): ChatThreadMemoryEntry[] => {
  const createdAt = options?.createdAt || Date.now()
  const entries: ChatThreadMemoryEntry[] = []
  let index = 0

  while (index < messages.length) {
    const message = messages[index]
    if (!message || message.role === 'system') {
      index += 1
      continue
    }

    if (message.role === 'user') {
      const assistantMessages: ChatMessage[] = []
      let cursor = index + 1
      while (cursor < messages.length && messages[cursor].role !== 'user') {
        if (messages[cursor].role === 'assistant') {
          assistantMessages.push(messages[cursor])
        }
        cursor += 1
      }
      const userText = buildMessageMemoryText(message)
      const assistantText = assistantMessages
        .map(buildMessageMemoryText)
        .filter(Boolean)
        .join('\n\n')
      const text = [`User: ${userText}`, assistantText ? `Assistant: ${assistantText}` : '']
        .filter(Boolean)
        .join('\n\n')
      if (normalizeString(text)) {
        entries.push({
          id: createThreadStateId(options?.idPrefix || 'turn-memory'),
          kind: 'turn',
          title: clipChatThreadText(userText || text, MEMORY_ENTRY_TITLE_MAX_CHARS),
          text: clipChatThreadText(text, MEMORY_ENTRY_TEXT_MAX_CHARS),
          createdAt,
          sourceMessageIndex: index,
          estimatedTokens: estimateChatMessagesTokenCount([message, ...assistantMessages])
        })
      }
      index = Math.max(cursor, index + 1)
      continue
    }

    const text = buildMessageMemoryText(message)
    if (text) {
      entries.push({
        id: createThreadStateId(options?.idPrefix || 'message-memory'),
        kind: 'turn',
        role: message.role,
        title: clipChatThreadText(text, MEMORY_ENTRY_TITLE_MAX_CHARS),
        text: clipChatThreadText(
          `${getRoleLabel(message.role)}: ${text}`,
          MEMORY_ENTRY_TEXT_MAX_CHARS
        ),
        createdAt,
        sourceMessageIndex: index,
        estimatedTokens: estimateChatMessagesTokenCount([message])
      })
    }
    index += 1
  }

  return entries
}

export const buildTurnMemoryEntries = (
  userMessage: ChatMessage,
  assistantMessages: readonly ChatMessage[],
  createdAt = Date.now()
): ChatThreadMemoryEntry[] =>
  buildMemoryEntriesFromMessages([userMessage, ...assistantMessages], {
    createdAt,
    idPrefix: 'turn-memory'
  })

export const summarizeToolArgs = (args?: Record<string, unknown>): string => {
  if (!args || Object.keys(args).length === 0) return '{}'
  try {
    return clipChatThreadText(JSON.stringify(args, null, 2), 1_200)
  } catch {
    return clipChatThreadText(String(args), 1_200)
  }
}

export const buildToolMemoryEntry = (
  toolEntry: ChatThreadToolHistoryEntry
): ChatThreadMemoryEntry => {
  const resultText = toolEntry.error || toolEntry.resultPreview || ''
  const text = [
    `Tool: ${toolEntry.toolName}`,
    `Status: ${toolEntry.status}`,
    `Args: ${summarizeToolArgs(toolEntry.args)}`,
    resultText ? `Result: ${resultText}` : ''
  ]
    .filter(Boolean)
    .join('\n')
  return {
    id: `tool-memory-${toolEntry.id}`,
    kind: 'tool',
    title: `Tool ${toolEntry.toolName}`,
    text: clipChatThreadText(text, MEMORY_ENTRY_TEXT_MAX_CHARS),
    createdAt: toolEntry.finishedAt || toolEntry.startedAt,
    toolName: toolEntry.toolName,
    estimatedTokens: estimateTextTokenCount(text)
  }
}

export const buildCompressionRecordFromSummary = (
  summary: ChatContextCompressionSummary,
  options?: { estimatedAfterTokens?: number }
): ChatThreadCompressionRecord => ({
  id: `compression-${summary.sourceHash}`,
  createdAt: summary.updatedAt || Date.now(),
  ...(summary.manual ? { manual: true } : {}),
  coveredMessageCount: summary.coveredMessageCount,
  sourceHash: summary.sourceHash,
  estimatedSourceTokens: summary.estimatedSourceTokens,
  estimatedSummaryTokens: summary.estimatedSummaryTokens || estimateTextTokenCount(summary.summary),
  ...(typeof options?.estimatedAfterTokens === 'number'
    ? { estimatedAfterTokens: Math.max(0, Math.round(options.estimatedAfterTokens)) }
    : {}),
  summary: summary.summary
})

export const buildCompressionMemoryEntry = (
  summary: ChatContextCompressionSummary
): ChatThreadMemoryEntry => ({
  id: `compression-memory-${summary.sourceHash}`,
  kind: 'compression',
  title: summary.manual ? 'Manual compression summary' : 'Auto compression summary',
  text: clipChatThreadText(summary.summary, MEMORY_ENTRY_TEXT_MAX_CHARS),
  createdAt: summary.updatedAt || Date.now(),
  sourceHash: summary.sourceHash,
  estimatedTokens: summary.estimatedSummaryTokens || estimateTextTokenCount(summary.summary)
})

export const appendChatThreadMemoryEntries = (
  currentEntries: readonly ChatThreadMemoryEntry[] | undefined,
  entriesToAppend: readonly ChatThreadMemoryEntry[]
): ChatThreadMemoryEntry[] => {
  const merged = [...(currentEntries || [])]
  const seen = new Set(merged.map((entry) => entry.id))
  entriesToAppend.forEach((entry) => {
    if (!entry.text.trim() || seen.has(entry.id)) return
    seen.add(entry.id)
    merged.push(entry)
  })
  return merged.slice(-MAX_MEMORY_ENTRIES)
}

export const appendChatThreadToolHistory = (
  currentEntries: readonly ChatThreadToolHistoryEntry[] | undefined,
  entry: ChatThreadToolHistoryEntry
): ChatThreadToolHistoryEntry[] => {
  const merged = [...(currentEntries || []).filter((candidate) => candidate.id !== entry.id), entry]
  return merged.slice(-MAX_TOOL_HISTORY_ENTRIES)
}

export const appendChatThreadCompressionRecord = (
  currentEntries: readonly ChatThreadCompressionRecord[] | undefined,
  record: ChatThreadCompressionRecord
): ChatThreadCompressionRecord[] => {
  const merged = [...(currentEntries || [])]
  const existingIndex = merged.findIndex(
    (candidate) => candidate.id === record.id || candidate.sourceHash === record.sourceHash
  )
  if (existingIndex >= 0) {
    merged[existingIndex] = record
  } else {
    merged.push(record)
  }
  return merged.slice(-MAX_COMPRESSION_RECORDS)
}

export const buildScratchpadContext = (scratchpad?: string): string => {
  const normalized = normalizeString(scratchpad)
  if (!normalized) return ''
  return ['[Agent Scratchpad]', normalized].join('\n')
}

export const buildThreadMemoryContextPrompt = (
  state: ChatThreadState | undefined,
  options?: { maxEntries?: number }
): string => {
  const normalized = normalizeChatThreadState(state)
  const maxEntries = Math.max(1, Math.min(12, options?.maxEntries || 6))
  const entries = (normalized.memoryEntries || [])
    .filter((entry) => entry.kind === 'compression' || entry.kind === 'tool')
    .slice(-maxEntries)
  if (!entries.length) return ''

  return [
    '[Session Memory]',
    ...entries.map(
      (entry) =>
        `- ${entry.title}: ${clipChatThreadText(entry.text, CONTEXT_MEMORY_ENTRY_MAX_CHARS)}`
    )
  ].join('\n')
}

const tokenizeForSearch = (value: string): string[] =>
  value
    .toLowerCase()
    .split(/[\s,.;:!?，。；：！？、(){}<>"'`~|/\\]+/)
    .map((token) => token.trim())
    .filter(Boolean)

const scoreMemoryEntry = (
  entry: ChatThreadMemoryEntry,
  query: string,
  mode: ChatThreadMemorySearchMode
): number => {
  const haystack = `${entry.title}\n${entry.text}\n${entry.toolName || ''}`.toLowerCase()
  const normalizedQuery = query.toLowerCase().trim()
  if (!normalizedQuery) return 1
  if (mode === 'fts' && haystack.includes(normalizedQuery)) return 100
  const tokens = tokenizeForSearch(normalizedQuery)
  if (tokens.length === 0) return 0
  const tokenHits = tokens.filter((token) => haystack.includes(token)).length
  const exactBoost = haystack.includes(normalizedQuery) ? 40 : 0
  const semanticBoost =
    mode === 'semantic' || mode === 'hybrid' || mode === 'auto' ? tokenHits * 8 : 0
  return exactBoost + tokenHits * 12 + semanticBoost
}

export const searchChatThreadMemory = (
  state: ChatThreadState | undefined,
  query: string,
  mode: ChatThreadMemorySearchMode = 'auto',
  limit = 20
): ChatThreadMemoryEntry[] => {
  const entries = normalizeChatThreadState(state).memoryEntries || []
  const normalizedQuery = query.trim()
  if (!normalizedQuery) {
    return entries.slice(-limit).reverse()
  }

  return entries
    .map((entry) => ({ entry, score: scoreMemoryEntry(entry, normalizedQuery, mode) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || right.entry.createdAt - left.entry.createdAt)
    .slice(0, limit)
    .map((item) => item.entry)
}

export const createSuccessfulToolHistoryEntry = (input: {
  toolName: string
  args?: Record<string, unknown>
  startedAt: number
  result?: string
}): ChatThreadToolHistoryEntry => {
  const finishedAt = Date.now()
  return {
    id: createThreadStateId('tool'),
    toolName: input.toolName,
    ...(input.args ? { args: input.args } : {}),
    status: 'success',
    startedAt: input.startedAt,
    finishedAt,
    durationMs: Math.max(0, finishedAt - input.startedAt),
    ...(normalizeString(input.result)
      ? { resultPreview: clipChatThreadText(input.result, TOOL_RESULT_PREVIEW_MAX_CHARS) }
      : {})
  }
}

export const createFailedToolHistoryEntry = (input: {
  toolName: string
  args?: Record<string, unknown>
  startedAt: number
  error: unknown
}): ChatThreadToolHistoryEntry => {
  const finishedAt = Date.now()
  const errorMessage =
    input.error instanceof Error ? input.error.message : String(input.error || '')
  return {
    id: createThreadStateId('tool'),
    toolName: input.toolName,
    ...(input.args ? { args: input.args } : {}),
    status: 'error',
    startedAt: input.startedAt,
    finishedAt,
    durationMs: Math.max(0, finishedAt - input.startedAt),
    error: clipChatThreadText(errorMessage, 600)
  }
}
