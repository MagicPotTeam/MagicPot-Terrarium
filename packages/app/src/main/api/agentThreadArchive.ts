import { validateAgentArchiveSearch } from '@shared/api/agentThreadMemorySearch'
import Ajv from 'ajv'
import { randomUUID } from 'node:crypto'
import { getAgentSessionKey, normalizeAgentRoute } from '@shared/agent'
import type { AgentThreadInteractionScope } from '@shared/api/agentThreadInteraction'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import {
  AGENT_THREAD_MEMORY_LIMITS as LIMITS,
  type AgentArchiveQuery, type AgentArchiveSearch, type AgentArchiveSearchResult,
  type ResolveAgentArchiveQueryReq
} from '@shared/api/agentThreadMemory'
import type { AgentThreadInteractionChannel } from './agentThreadInteractions'
import { authorizeAgentThreadScope } from './agentThreadScope'

const key = (scope: AgentThreadInteractionScope) => JSON.stringify([getAgentSessionKey(normalizeAgentRoute(scope.route)), scope.conversationId])
const validate = new Ajv({ strict: true, ownProperties: true }).compile({
  type: 'object', additionalProperties: false,
  required: ['source', 'mode', 'matches', 'scannedMessages', 'scannedCharacters', 'totalMessages', 'truncated', 'untrustedData'],
  properties: {
    source: { const: 'session_archive' }, mode: { enum: ['literal', 'lexical', 'bm25'] }, untrustedData: { const: true }, truncated: { type: 'boolean' },
    priorCompactionUnavailable: { type: 'boolean' },
    searchSource: { enum: ['messages', 'tools', 'all'] },
    engine: { enum: ['unicode-token-scan', 'unicode-bm25-scan'] }, ranking: { enum: ['page-local-token-coverage', 'scan-window-bm25'] },
    corpus: { type: 'object', additionalProperties: false, required: ['documents', 'tokens', 'matchingDocuments', 'omittedMatches', 'scanComplete', 'documentUnit', 'k1', 'b'], properties: {
      documents: { type: 'integer', minimum: 0, maximum: LIMITS.bm25Documents }, tokens: { type: 'integer', minimum: 0, maximum: LIMITS.bm25Tokens }, matchingDocuments: { type: 'integer', minimum: 0, maximum: LIMITS.bm25Documents }, omittedMatches: { type: 'integer', minimum: 0, maximum: LIMITS.bm25Documents }, scanComplete: { type: 'boolean' }, documentUnit: { const: '8192-character-chunks' }, k1: { const: 1.2 }, b: { const: 0.75 }
    } },
    scannedEvents: { type: 'integer', minimum: 0, maximum: LIMITS.scannedEvents },
    nextBeforeEvent: { type: 'integer', minimum: 0, maximum: 20000001 },
    scannedMessages: { type: 'integer', minimum: 0, maximum: LIMITS.scannedMessages },
    scannedCharacters: { type: 'integer', minimum: 0, maximum: LIMITS.scannedCharacters },
    totalMessages: { type: 'integer', minimum: 0, maximum: 10000000 },
    nextBeforeMessage: { type: 'integer', minimum: 0, maximum: 10000000 },
    nextBeforeCharacter: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    matches: { type: 'array', maxItems: LIMITS.matches, items: {
      type: 'object', additionalProperties: false, required: ['messageIndex', 'role', 'excerpt'], properties: {
        messageIndex: { type: 'integer', minimum: 0, maximum: 10000000 }, role: { enum: ['user', 'assistant'] }, excerpt: { type: 'string', maxLength: LIMITS.excerptCharacters },
        kind: { enum: ['message', 'tool_result', 'tool_error'] }, eventIndex: { type: 'integer', minimum: 0, maximum: 20000000 },
        toolIndex: { type: 'integer', minimum: 0, maximum: 9999999 }, toolName: { type: 'string', pattern: '^[A-Za-z0-9_.:-]{1,128}$' },
        toolStatus: { enum: ['completed', 'failed', 'cancelled', 'unknown'] }, score: { type: 'number', minimum: 0, maximum: 300 }, chunkStart: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, excerptOmitted: { const: true }
      }
    } }
  }
})
type Pending = { senderId: number; scope: AgentThreadInteractionScope; lease: AgentThreadInteractionChannel; view: AgentArchiveQuery; resolve(value?: AgentArchiveSearchResult): void; reject(error: unknown): void }

/** Query rendezvous, never a history mirror. Only excerpts cross back to main/model. */
export class AgentThreadArchive {
  private readonly pending = new Map<string, Pending>()
  async search(scope: AgentThreadInteractionScope, senderId: number, lease: AgentThreadInteractionChannel, search: AgentArchiveSearch, signal?: AbortSignal): Promise<AgentArchiveSearchResult | undefined> {
    lease.assertLive(); signal?.throwIfAborted(); validateAgentArchiveSearch(search)
    if (this.pending.size >= 32 || [...this.pending.values()].some((entry) => entry.senderId === senderId && key(entry.scope) === key(scope))) throw new Error('An archive query is already pending or the query limit was reached.')
    const id = randomUUID()
    const combined = AbortSignal.any([lease.signal, ...(signal ? [signal] : [])])
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (result?: AgentArchiveSearchResult, error?: unknown) => {
        if (settled) return
        settled = true; clearTimeout(timer); combined.removeEventListener('abort', abort); this.pending.delete(id)
        if (error) reject(error); else resolve(result)
      }
      const abort = () => finish(undefined, combined.reason || new Error('Archive query cancelled.'))
      // A missing/old renderer is an explicit unavailable fallback, not an empty archive.
      const timer = setTimeout(() => finish(), LIMITS.queryTimeoutMs)
      this.pending.set(id, { senderId, scope: structuredClone(scope), lease, view: { id, expiresAt: Date.now() + LIMITS.queryTimeoutMs, search: structuredClone(search) },
        resolve: (value) => finish(value), reject: (error) => finish(undefined, error) })
      combined.addEventListener('abort', abort, { once: true })
      if (combined.aborted) abort()
    })
  }
  list(scope: AgentThreadInteractionScope, invocation?: ServiceInvocationContext): AgentArchiveQuery[] {
    const senderId = authorizeAgentThreadScope(scope, invocation, 'listAgentArchiveQueries')
    const queries: AgentArchiveQuery[] = []
    for (const entry of this.pending.values()) {
      if (entry.senderId !== senderId || key(entry.scope) !== key(scope)) continue
      try {
        entry.lease.assertLive()
        if (Date.now() >= entry.view.expiresAt) entry.resolve()
        else queries.push(structuredClone(entry.view))
      } catch (error) { entry.reject(error) }
    }
    return queries
  }
  resolve(req: ResolveAgentArchiveQueryReq, invocation?: ServiceInvocationContext): void {
    const senderId = authorizeAgentThreadScope(req, invocation, 'resolveAgentArchiveQuery')
    const entry = this.pending.get(req.queryId)
    if (!entry || entry.senderId !== senderId || key(entry.scope) !== key(req)) throw new Error('Archive query is not active in this conversation.')
    entry.lease.assertLive()
    if (Date.now() >= entry.view.expiresAt) { entry.resolve(); throw new Error('Archive query expired.') }
    if (req.unavailable === true && req.result === undefined) { entry.resolve(); return }
    const result = structuredClone(req.result)
    if (!validate(result) || !result || JSON.stringify(result).length > 64000 || result.matches.length > (entry.view.search.limit ?? 5)) throw new Error('Invalid archive query result.')
    const requested = entry.view.search, source = requested.source ?? 'messages', mode = requested.mode ?? 'literal'
    if (result.mode !== mode || (result.searchSource ?? 'messages') !== source || (mode === 'lexical' && (result.ranking !== 'page-local-token-coverage' || result.engine !== 'unicode-token-scan')) || (mode === 'literal' && (result.ranking !== undefined || result.engine !== undefined)) || (source === 'messages' && result.nextBeforeEvent !== undefined)) throw new Error('Invalid archive result mode/source.')
    if (mode === 'bm25') {
      const corpus = result.corpus
      if (result.ranking !== 'scan-window-bm25' || result.engine !== 'unicode-bm25-scan' || !corpus || corpus.scanComplete === result.truncated || corpus.documents > corpus.tokens || corpus.tokens > result.scannedCharacters || corpus.documents > result.scannedCharacters || corpus.matchingDocuments > corpus.documents || corpus.matchingDocuments !== result.matches.length + corpus.omittedMatches || result.matches.length !== Math.min(corpus.matchingDocuments, requested.limit ?? 5) || result.scannedEvents === undefined) throw new Error('Invalid archive BM25 corpus/ranking.')
      if (new Set(result.matches.map(match => JSON.stringify([match.messageIndex, match.eventIndex, match.chunkStart]))).size !== result.matches.length) throw new Error('Invalid archive BM25 duplicate chunk.')
      if (result.matches.some((match, index) => match.score === undefined || match.score <= 0 || match.chunkStart === undefined || index > 0 && result.matches[index - 1].score! < match.score!)) throw new Error('Invalid archive BM25 score/order.')
    } else if (result.corpus !== undefined || result.matches.some(match => match.chunkStart !== undefined || mode === 'lexical' && match.score !== undefined && match.score > 1)) throw new Error('Invalid archive ranking fields.')
    for (const match of result.matches) {
      const tool = match.kind === 'tool_result' || match.kind === 'tool_error'
      if ((source === 'messages' && tool) || (source === 'tools' && !tool) || ((mode === 'lexical' || mode === 'bm25') && match.score === undefined) || (mode === 'literal' && match.score !== undefined)) throw new Error('Invalid archive match source/score.')
      if (tool) {
        if (match.role !== 'assistant' || match.toolIndex === undefined || !match.toolName || !match.toolStatus || match.eventIndex !== 1 + 2 * match.toolIndex + (match.kind === 'tool_error' ? 1 : 0) || (requested.toolName && match.toolName !== requested.toolName)) throw new Error('Invalid archive tool provenance.')
      } else if (match.excerptOmitted || requested.toolName || match.toolIndex !== undefined || match.toolName !== undefined || match.toolStatus !== undefined || (match.eventIndex !== undefined && match.eventIndex !== 0)) throw new Error('Invalid archive message provenance.')
    }
    if (source !== 'messages' && result.nextBeforeCharacter !== undefined && result.nextBeforeEvent === undefined) throw new Error('Invalid archive event cursor.')
    const before = Math.min(requested.beforeMessage ?? result.totalMessages, result.totalMessages)
    const sameMessageCursor = mode !== 'bm25' || requested.beforeMessage === undefined || requested.beforeMessage <= result.totalMessages
    if (result.matches.some((match) => match.messageIndex >= before || (sameMessageCursor && match.messageIndex === before - 1 && requested.beforeEvent !== undefined && (match.eventIndex === undefined || match.eventIndex >= requested.beforeEvent)))) throw new Error('Invalid archive result cursor.')
    if (mode === 'bm25' && sameMessageCursor && requested.beforeCharacter !== undefined && result.matches.some(match => match.messageIndex === before - 1 && (source === 'messages' || match.eventIndex === requested.beforeEvent! - 1) && match.chunkStart! >= requested.beforeCharacter!)) throw new Error('Invalid archive BM25 chunk cursor.')
    const cursorEvent = sameMessageCursor ? requested.beforeEvent : undefined
    const cursorCharacter = sameMessageCursor ? requested.beforeCharacter : undefined
    if (result.nextBeforeMessage !== undefined) {
      const next = result.nextBeforeMessage
      if (!result.truncated || next > before || (next === before && !(
        source !== 'messages' && result.nextBeforeEvent !== undefined && (cursorEvent === undefined || result.nextBeforeEvent < cursorEvent) ||
        result.nextBeforeCharacter !== undefined && (source === 'messages' || result.nextBeforeEvent !== undefined && result.nextBeforeEvent === cursorEvent) && (cursorCharacter === undefined || result.nextBeforeCharacter < cursorCharacter)
      ))) throw new Error('Invalid archive result cursor.')
    } else if (result.nextBeforeEvent !== undefined || result.nextBeforeCharacter !== undefined || result.truncated) throw new Error('Invalid archive result cursor.')
    // Shape and origin are checked, not truth of renderer text. It remains untrusted.
    entry.resolve(result)
  }
}
export const agentThreadArchive = new AgentThreadArchive()
