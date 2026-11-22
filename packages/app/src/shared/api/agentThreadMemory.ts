import type { AgentThreadInteractionScope } from './agentThreadInteraction'

export const AGENT_THREAD_MEMORY_LIMITS = {
  queryCharacters: 256, matches: 20, excerptCharacters: 500,
  scannedMessages: 50000, scannedCharacters: 8 * 1024 * 1024,
  messageCharacters: 256 * 1024, queryTimeoutMs: 10000,
  scannedEvents: 50000, lexicalTerms: 16,
  bm25Documents: 4096, bm25Tokens: 500000, bm25ChunkCharacters: 8192,
  noteKeys: 32, noteKeyCharacters: 64, noteCharacters: 4000, noteBytes: 64 * 1024
} as const
export type AgentArchiveSource = 'messages' | 'tools' | 'all'
export type AgentArchiveSearch = {
  query: string; limit?: number; beforeMessage?: number; beforeCharacter?: number
  source?: AgentArchiveSource; mode?: 'literal' | 'lexical' | 'bm25'; beforeEvent?: number; toolName?: string
}
export type AgentArchiveMatch = {
  messageIndex: number; role: 'user' | 'assistant'; excerpt: string
  kind?: 'message' | 'tool_result' | 'tool_error'; eventIndex?: number; toolIndex?: number
  toolName?: string; toolStatus?: 'completed' | 'failed' | 'cancelled' | 'unknown'; score?: number; excerptOmitted?: true; chunkStart?: number
}
export type AgentArchiveSearchResult = {
  source: 'session_archive'
  mode: 'literal' | 'lexical' | 'bm25'
  searchSource?: AgentArchiveSource
  ranking?: 'page-local-token-coverage' | 'scan-window-bm25'
  engine?: 'unicode-token-scan' | 'unicode-bm25-scan'
  corpus?: { documents: number; tokens: number; matchingDocuments: number; omittedMatches: number; scanComplete: boolean; documentUnit: '8192-character-chunks'; k1: 1.2; b: 0.75 }
  scannedEvents?: number
  matches: AgentArchiveMatch[]
  scannedMessages: number
  scannedCharacters: number
  totalMessages: number
  truncated: boolean
  nextBeforeMessage?: number
  nextBeforeCharacter?: number
  nextBeforeEvent?: number
  untrustedData: true
  /** Old compaction discarded some originals before retention existed. A miss
   * cannot establish absence from that unavailable historical prefix. */
  priorCompactionUnavailable?: boolean
}
export type AgentArchiveQuery = { id: string; expiresAt: number; search: AgentArchiveSearch }
export type ResolveAgentArchiveQueryReq = AgentThreadInteractionScope & {
  queryId: string
  result?: AgentArchiveSearchResult
  unavailable?: boolean
}
export type AgentThreadNote = { key: string; value: string; updatedAt: number }
export type AgentThreadNotes = { revision: number; notes: AgentThreadNote[] }
export type AgentThreadNoteMutation = {
  expectedRevision: number
  operationId: string
} & ({ action: 'set' | 'delete'; key: string; value?: string } | { action: 'clear'; key?: never; value?: never })
export type MutateAgentThreadNoteReq = AgentThreadInteractionScope & AgentThreadNoteMutation
