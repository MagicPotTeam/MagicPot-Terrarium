import { formatToolSearchExcerpt } from './toolSearchExcerpt'
import type { ChatMessage } from '@shared/api/svcLLMProxy'
import { AGENT_THREAD_MEMORY_LIMITS as LIMITS, type AgentArchiveMatch, type AgentArchiveSearch, type AgentArchiveSearchResult } from '@shared/api/agentThreadMemory'
import { escapedMemoryLiteral, memoryLexicalTerms, validateAgentArchiveSearch } from '@shared/api/agentThreadMemorySearch'

export type AgentSearchEvent = { text: string; match: Omit<AgentArchiveMatch, 'excerpt' | 'score'> }
export const agentEventCount = (message: ChatMessage): number => message.role === 'assistant' && Array.isArray(message.toolHistory) ? 1 + Math.min(message.toolHistory.length, 10000000) * 2 : 1
export function agentEventAt(message: ChatMessage, messageIndex: number, eventIndex: number, search: AgentArchiveSearch): AgentSearchEvent | undefined {
  if (!message || (message.role !== 'user' && message.role !== 'assistant')) return
  if (eventIndex === 0) {
    if (search.source === 'tools' || search.toolName || typeof message.content !== 'string') return
    return { text: message.content, match: { messageIndex, role: message.role, kind: 'message', eventIndex } }
  }
  if (search.source === 'messages' || message.role !== 'assistant') return
  const toolIndex = Math.floor((eventIndex - 1) / 2), tool = message.toolHistory?.[toolIndex]
  if (!tool || typeof tool.toolName !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(tool.toolName) || (search.toolName && tool.toolName !== search.toolName)) return
  const field = eventIndex % 2 === 1 ? 'content' : 'error', text = tool[field]
  if (typeof text !== 'string' || !text) return
  return { text, match: { messageIndex, role: 'assistant', eventIndex, toolIndex, toolName: tool.toolName,
    toolStatus: ['completed', 'failed', 'cancelled'].includes(tool.status) ? tool.status as 'completed' | 'failed' | 'cancelled' : 'unknown', kind: field === 'content' ? 'tool_result' : 'tool_error' } }
}
/** Traverses the existing session only; never constructs a duplicate full event index.
 * Each page collects the most recent matching chunks then optionally ranks that page.
 * Cursors retain event+character positions, including oversized tool output tails.
 */
export async function searchAgentSessionEvents(messages: readonly ChatMessage[], search: AgentArchiveSearch, signal?: AbortSignal, expiresAt?: number): Promise<AgentArchiveSearchResult> {
  validateAgentArchiveSearch(search)
  if (search.mode === 'bm25') throw new Error('BM25 requires the bounded scan-window ranker.')
  const mode = search.mode ?? 'literal', source = search.source ?? 'messages', query = search.query.trim(), limit = search.limit ?? 5
  const terms = mode === 'lexical' ? memoryLexicalTerms(query) : [query]
  const patterns = terms.map((term) => mode === 'literal' ? escapedMemoryLiteral(term) : new RegExp(`(?<![\\p{L}\\p{N}\\p{M}_])(?:${escapedMemoryLiteral(term).source})(?![\\p{L}\\p{N}\\p{M}_])`, 'iu'))
  const matches: AgentArchiveMatch[] = [], deadline = Math.min(Date.now() + 8000, expiresAt === undefined ? Infinity : expiresAt - 250)
  if (Date.now() >= deadline) throw new Error('Archive query has insufficient remaining lifetime.')
  let lastYield = Date.now()
  let index = Math.min(search.beforeMessage ?? messages.length, messages.length) - 1
  let eventIndex: number | undefined = search.beforeEvent === undefined ? undefined : search.beforeEvent - 1
  let end = search.beforeCharacter
  let scannedMessages = 0, scannedEvents = 0, scannedCharacters = 0, work = 0
  let nextBeforeMessage: number | undefined, nextBeforeEvent: number | undefined, nextBeforeCharacter: number | undefined
  const advanceEvent = () => { eventIndex = eventIndex! - 1; end = undefined; scannedEvents++ }
  while (index >= 0) {
    signal?.throwIfAborted()
    if (eventIndex !== undefined && eventIndex < 0) { scannedMessages++; index--; eventIndex = undefined; end = undefined; continue }
    const message = messages[index]
    if ((work > 0 && Date.now() >= deadline) || scannedMessages >= LIMITS.scannedMessages || scannedEvents >= LIMITS.scannedEvents || scannedCharacters >= LIMITS.scannedCharacters || matches.length >= limit) {
      nextBeforeMessage = index + 1; nextBeforeEvent = eventIndex === undefined ? undefined : eventIndex + 1; nextBeforeCharacter = end; break
    }
    // Chromium clamps nested timers: do not spend thousands of 4ms waits on
    // tiny/empty events. Yield after 128 events or ~8ms of synchronous work.
    if (++work % 128 === 0 || Date.now() - lastYield >= 8) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0)); lastYield = Date.now()
    }
    signal?.throwIfAborted()
    if (!message || !['user', 'assistant'].includes(message.role)) { scannedMessages++; index--; eventIndex = undefined; end = undefined; continue }
    eventIndex = Math.min(eventIndex ?? (source === 'messages' ? 0 : agentEventCount(message) - 1), source === 'messages' ? 0 : agentEventCount(message) - 1)
    if (eventIndex < 0) { scannedMessages++; index--; eventIndex = undefined; end = undefined; continue }
    const event = agentEventAt(message, index, eventIndex, { ...search, source })
    if (!event) { advanceEvent(); continue }
    end = Math.min(end ?? event.text.length, event.text.length)
    const length = Math.min(end, LIMITS.messageCharacters, LIMITS.scannedCharacters - scannedCharacters)
    let start = end - length
    if (start > 0 && /[\uDC00-\uDFFF]/.test(event.text[start]) && /[\uD800-\uDBFF]/.test(event.text[start - 1])) start++
    if (length > 0 && start === end) { nextBeforeMessage = index + 1; nextBeforeEvent = eventIndex + 1; nextBeforeCharacter = end; break }
    // Context on both sides establishes token boundaries without altering original offsets.
    const from = Math.max(0, start - 2), to = Math.min(event.text.length, end + query.length + 2)
    const content = event.text.slice(from, to)
    let first = -1, coverage = 0
    for (const pattern of patterns) {
      const scan = new RegExp(pattern.source, pattern.flags + 'g')
      scan.lastIndex = start - from
      const found = scan.exec(content)
      if (found && found.index + from < end) { coverage++; if (first < 0) first = found.index }
    }
    scannedCharacters += end - start
    if (coverage) {
      const rawExcerpt = content.slice(Math.max(0, first - 100), Math.max(0, first - 100) + LIMITS.excerptCharacters)
      const formatted = event.match.kind === 'message' ? { text: rawExcerpt, omitted: false } : formatToolSearchExcerpt(event.text, from + Math.max(0, first - 100), LIMITS.excerptCharacters)
      matches.push({ ...event.match, excerpt: formatted.text, ...(formatted.omitted ? { excerptOmitted: true } : {}), ...(mode === 'lexical' ? { score: coverage / terms.length } : {}) })
    }
    if (start > 0) end = start
    else advanceEvent()
  }
  signal?.throwIfAborted()
  if (mode === 'lexical') matches.sort((a, b) => b.score! - a.score! || b.messageIndex - a.messageIndex || b.eventIndex! - a.eventIndex!)
  return { source: 'session_archive', mode, searchSource: source, matches, scannedMessages, scannedEvents, scannedCharacters, totalMessages: messages.length,
    truncated: nextBeforeMessage !== undefined, untrustedData: true,
    ...(mode === 'lexical' ? { ranking: 'page-local-token-coverage' as const, engine: 'unicode-token-scan' as const } : {}),
    ...(nextBeforeMessage !== undefined ? { nextBeforeMessage } : {}),
    ...(source !== 'messages' && nextBeforeEvent !== undefined ? { nextBeforeEvent } : {}),
    ...(nextBeforeCharacter !== undefined ? { nextBeforeCharacter } : {}) }
}
