import { searchAgentBm25 } from './agentBm25Search'
import { searchAgentSessionEvents } from './agentEventSearch'
import { escapedMemoryLiteral, validateAgentArchiveSearch } from '@shared/api/agentThreadMemorySearch'
import type { ChatMessage } from '@shared/api/svcLLMProxy'
import { AGENT_THREAD_MEMORY_LIMITS as LIMITS, type AgentArchiveSearch, type AgentArchiveSearchResult } from '@shared/api/agentThreadMemory'

function findLiteralOffset(content: string, pattern: RegExp, before: number): number {
  pattern.lastIndex = 0
  const match = pattern.exec(content)
  return match && match.index < before ? match.index : -1
}

/** Local text-only scan with message+character cursors; no permanently skipped long tails. */
export async function searchAgentSessionArchive(messages: readonly ChatMessage[], search: AgentArchiveSearch, signal?: AbortSignal, expiresAt?: number): Promise<AgentArchiveSearchResult> {
  validateAgentArchiveSearch(search)
  if (search.mode === 'bm25') return searchAgentBm25(messages, search, signal, expiresAt)
  if ((search.source && search.source !== 'messages') || search.mode === 'lexical') return searchAgentSessionEvents(messages, search, signal, expiresAt)
  const query = search.query.trim()
  const limit = search.limit ?? 5
  if (!query || query.length > LIMITS.queryCharacters || !Number.isInteger(limit) || limit < 1 || limit > LIMITS.matches ||
    (search.beforeMessage !== undefined && (!Number.isSafeInteger(search.beforeMessage) || search.beforeMessage < 0)) ||
    (search.beforeCharacter !== undefined && (!Number.isSafeInteger(search.beforeCharacter) || search.beforeCharacter < 0 || search.beforeMessage === undefined))) throw new Error('Invalid archive search.')
  // Escape each UTF-16 unit: this is a literal, linear search, not caller regex.
  // Unicode simple case-folding keeps original indices and is context-independent.
  const literal = escapedMemoryLiteral(query)
  const deadline = expiresAt === undefined ? Infinity : expiresAt - 250
  if (Date.now() >= deadline) throw new Error('Archive query has insufficient remaining lifetime.')
  const matches: AgentArchiveSearchResult['matches'] = []
  let scannedMessages = 0, scannedCharacters = 0, chunks = 0
  let index = Math.min(search.beforeMessage ?? messages.length, messages.length) - 1
  let end: number | undefined = search.beforeCharacter
  let nextBeforeMessage: number | undefined, nextBeforeCharacter: number | undefined
  while (index >= 0) {
    signal?.throwIfAborted()
    if ((chunks > 0 && Date.now() >= deadline) || scannedMessages >= LIMITS.scannedMessages || scannedCharacters >= LIMITS.scannedCharacters || matches.length >= limit) {
      nextBeforeMessage = index + 1; nextBeforeCharacter = end; break
    }
    const message = messages[index]
    if (!message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') { scannedMessages++; index--; end = undefined; continue }
    end = Math.min(end ?? message.content.length, message.content.length)
    const length = Math.min(end, LIMITS.messageCharacters, LIMITS.scannedCharacters - scannedCharacters)
    let start = end - length
    // Never split a surrogate pair at a page/chunk boundary.
    if (start > 0 && /[\uDC00-\uDFFF]/.test(message.content[start]) && /[\uD800-\uDBFF]/.test(message.content[start - 1])) start++
    const scannedLength = end - start
    if (length > 0 && scannedLength === 0) { nextBeforeMessage = index + 1; nextBeforeCharacter = end; break }
    // Small overlap allows literal matches that cross a chunk boundary. Only
    // matches whose start belongs to this chunk are emitted.
    const content = message.content.slice(start, Math.min(message.content.length, end + query.length - 1))
    const offset = findLiteralOffset(content, literal, scannedLength)
    scannedCharacters += scannedLength
    chunks++
    if (offset >= 0 && offset < scannedLength) {
      const from = Math.max(0, offset - 100)
      matches.push({ messageIndex: index, role: message.role as 'user' | 'assistant', excerpt: content.slice(from, from + LIMITS.excerptCharacters) })
    }
    if (start > 0) end = start
    else { scannedMessages++; index--; end = undefined }
    if (chunks % 8 === 0 || scannedMessages % 200 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  signal?.throwIfAborted()
  return { source: 'session_archive', mode: 'literal', matches, scannedMessages, scannedCharacters, totalMessages: messages.length, truncated: nextBeforeMessage !== undefined,
    ...(nextBeforeMessage !== undefined ? { nextBeforeMessage } : {}), ...(nextBeforeCharacter !== undefined ? { nextBeforeCharacter } : {}), untrustedData: true }
}
