import type { ChatMessage } from '@shared/api/svcLLMProxy'
import { AGENT_THREAD_MEMORY_LIMITS as LIMITS, type AgentArchiveSearch, type AgentArchiveSearchResult } from '@shared/api/agentThreadMemory'
import { escapedMemoryLiteral, memoryLexicalTerms, validateAgentArchiveSearch } from '@shared/api/agentThreadMemorySearch'
import { agentEventAt, agentEventCount, type AgentSearchEvent } from './agentEventSearch'
import { rankBm25, type Bm25DocumentStats } from './agentBm25'
import { formatToolSearchExcerpt } from './toolSearchExcerpt'
type Document = Bm25DocumentStats & { event: AgentSearchEvent; start: number; offset: number }
/** Query-local statistics, no durable index/body mirror. Rank after scanning the
 * entire bounded window, never stop at the first k matches. Chunks are documents,
 * not whole events. Tokens spanning chunks belong to the chunk with their start. */
export async function searchAgentBm25(messages: readonly ChatMessage[], search: AgentArchiveSearch, signal?: AbortSignal, expiresAt?: number): Promise<AgentArchiveSearchResult> {
  validateAgentArchiveSearch(search)
  if (search.mode !== 'bm25') throw new Error('BM25 mode required.')
  const source = search.source ?? 'messages', limit = search.limit ?? 5, query = search.query.trim()
  const terms = memoryLexicalTerms(query).filter((term, index, all) => !all.slice(0, index).some(prior => new RegExp(`^(?:${escapedMemoryLiteral(prior).source})$`, 'iu').test(term)))
  const patterns = terms.map(term => new RegExp(`(?<![\\p{L}\\p{N}\\p{M}_])(?:${escapedMemoryLiteral(term).source})(?![\\p{L}\\p{N}\\p{M}_])`, 'giu'))
  const documents: Document[] = [], deadline = Math.min(Date.now() + 8000, expiresAt === undefined ? Infinity : expiresAt - 250)
  if (Date.now() >= deadline) throw new Error('Archive query has insufficient remaining lifetime.')
  let index = Math.min(search.beforeMessage ?? messages.length, messages.length) - 1
  let eventIndex: number | undefined = search.beforeEvent === undefined ? undefined : search.beforeEvent - 1, end = search.beforeCharacter
  if (search.beforeMessage !== undefined && search.beforeMessage > messages.length) { eventIndex = undefined; end = undefined }
  let scannedMessages = 0, scannedEvents = 0, scannedCharacters = 0, tokens = 0, work = 0, lastYield = Date.now()
  let nextBeforeMessage: number | undefined, nextBeforeEvent: number | undefined, nextBeforeCharacter: number | undefined
  const advance = () => { eventIndex = eventIndex! - 1; end = undefined; scannedEvents++ }
  const remaining = () => { nextBeforeMessage = index + 1; nextBeforeEvent = eventIndex === undefined ? undefined : eventIndex + 1; nextBeforeCharacter = end }
  while (index >= 0) {
    signal?.throwIfAborted()
    if (eventIndex !== undefined && eventIndex < 0) { scannedMessages++; index--; eventIndex = undefined; end = undefined; continue }
    if (Date.now() >= deadline || scannedMessages >= LIMITS.scannedMessages || scannedEvents >= LIMITS.scannedEvents || scannedCharacters >= LIMITS.scannedCharacters || documents.length >= LIMITS.bm25Documents || tokens >= LIMITS.bm25Tokens) { remaining(); break }
    if (++work % 64 === 0 || Date.now() - lastYield >= 8) { await new Promise<void>(resolve => setTimeout(resolve, 0)); lastYield = Date.now(); continue }
    const message = messages[index]
    if (!message || !['user', 'assistant'].includes(message.role)) { scannedMessages++; index--; eventIndex = undefined; end = undefined; continue }
    const lastEvent = source === 'messages' ? 0 : agentEventCount(message) - 1
    if (eventIndex !== undefined && eventIndex > lastEvent) end = undefined // Character position belongs only to the original event.
    eventIndex = Math.min(eventIndex ?? lastEvent, lastEvent)
    const event = agentEventAt(message, index, eventIndex, { ...search, source })
    if (!event) { advance(); continue }
    end = Math.min(end ?? event.text.length, event.text.length)
    const length = Math.min(end, LIMITS.bm25ChunkCharacters, LIMITS.scannedCharacters - scannedCharacters, LIMITS.bm25Tokens - tokens)
    let start = end - length
    if (start > 0 && /[\uDC00-\uDFFF]/.test(event.text[start]) && /[\uD800-\uDBFF]/.test(event.text[start - 1])) start++
    if (length > 0 && start === end) { remaining(); break }
    const chunkEnd = end
    const from = Math.max(0, start - 2), content = event.text.slice(from, Math.min(event.text.length, chunkEnd + query.length + 2))
    // Full Unicode token starts, not fragment runs: bounded two-code-unit left
    // context distinguishes a continuation even for arbitrarily long tokens.
    const starts = new RegExp('(?<![\\p{L}\\p{N}\\p{M}_])[\\p{L}\\p{N}\\p{M}_]+', 'gu')
    starts.lastIndex = start - from
    let count = 0
    for (const token of content.matchAll(starts)) { if (token.index + from >= chunkEnd) break; count++ }
    let offset = -1
    const frequencies = patterns.map(pattern => {
      pattern.lastIndex = start - from; let frequency = 0
      for (const match of content.matchAll(pattern)) { if (match.index + from >= chunkEnd) break; frequency++; if (offset < 0 || match.index + from < offset) offset = match.index + from }
      return frequency
    })
    scannedCharacters += end - start; tokens += count
    if (count > 0) documents.push({ length: count, frequencies, event, start, offset })
    if (start > 0) end = start
    else advance()
  }
  signal?.throwIfAborted()
  if (expiresAt !== undefined && Date.now() >= expiresAt - 100) throw new Error('Archive query expired before ranking.')
  // Let a queued Stop/scope change run before ranking/excerpt projection.
  if (work > 0) await new Promise<void>(resolve => setTimeout(resolve, 0))
  signal?.throwIfAborted()
  if (expiresAt !== undefined && Date.now() >= expiresAt - 100) throw new Error('Archive query expired before ranking.')
  const scores = rankBm25(documents, terms.length)
  const ranked = documents.map((doc, position) => ({ doc, score: scores[position] })).filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || b.doc.event.match.messageIndex - a.doc.event.match.messageIndex || (b.doc.event.match.eventIndex ?? 0) - (a.doc.event.match.eventIndex ?? 0) || b.doc.start - a.doc.start)
  const matches = ranked.slice(0, limit).map(({ doc, score }) => {
    const from = Math.max(0, doc.offset - 100), formatted = doc.event.match.kind === 'message' ? { text: doc.event.text.slice(from, from + LIMITS.excerptCharacters), omitted: false } : formatToolSearchExcerpt(doc.event.text, from, LIMITS.excerptCharacters)
    return { ...doc.event.match, excerpt: formatted.text, score, chunkStart: doc.start, ...(formatted.omitted ? { excerptOmitted: true as const } : {}) }
  })
  signal?.throwIfAborted()
  if (expiresAt !== undefined && Date.now() >= expiresAt - 50) throw new Error('Archive query expired before returning ranked excerpts.')
  return { source: 'session_archive', mode: 'bm25', searchSource: source, ranking: 'scan-window-bm25', engine: 'unicode-bm25-scan', matches, scannedMessages, scannedEvents, scannedCharacters, totalMessages: messages.length, truncated: nextBeforeMessage !== undefined, untrustedData: true,
    corpus: { documents: documents.length, tokens, matchingDocuments: ranked.length, omittedMatches: Math.max(0, ranked.length - matches.length), scanComplete: nextBeforeMessage === undefined, documentUnit: '8192-character-chunks', k1: 1.2, b: 0.75 },
    ...(nextBeforeMessage !== undefined ? { nextBeforeMessage } : {}), ...(source !== 'messages' && nextBeforeEvent !== undefined ? { nextBeforeEvent } : {}), ...(nextBeforeCharacter !== undefined ? { nextBeforeCharacter } : {}) }
}
