import type { AgentRouteLike } from '@shared/agent'

export type SemanticMemoryScopeKind = 'session' | 'agent' | 'workspace' | 'drive' | 'session-set'

export type SemanticMemoryScope = {
  kind: SemanticMemoryScopeKind
  id: string
  sessionIds?: string[]
}

export type SemanticMemoryVisibility = 'private' | 'workspace' | 'shared'
export type SemanticMemoryLifetime = 'session' | 'durable' | 'custom'

export type SemanticMemoryProvenance = {
  source: string
  sourceId: string
  sessionId?: string
  runId?: string
  eventId?: string
  artifactId?: string
  messageIndex?: number
  createdAt: number
  contentHash: string
}

export type SemanticMemorySensitiveMetadata = {
  sensitive: boolean
  redacted: boolean
  redactionKinds?: string[]
  allowRemoteEmbedding?: boolean
}

export type SemanticMemoryChunk = {
  id: string
  scope: SemanticMemoryScope
  content: string
  summary?: string
  importance: number
  lifetime: SemanticMemoryLifetime
  expiresAt?: number
  visibility: SemanticMemoryVisibility
  disabled?: boolean
  provenance: SemanticMemoryProvenance
  sensitive: SemanticMemorySensitiveMetadata
  createdAt: number
  updatedAt: number
}

export type EmbeddingRequest = { texts: string[]; model: string }
export type EmbeddingResponse = { vectors: number[][]; model: string; dimension: number }
export interface SemanticEmbeddingProvider {
  id: string
  remote: boolean
  model: string
  dimension: number
  embed(request: EmbeddingRequest): Promise<EmbeddingResponse>
}

export type SemanticMemorySearchMode = 'lexical' | 'semantic' | 'hybrid'
export type SemanticMemorySearchRequest = {
  query: string
  scopes: SemanticMemoryScope[]
  visibility?: SemanticMemoryVisibility[]
  mode?: SemanticMemorySearchMode
  limit?: number
  lexicalWeight?: number
  semanticWeight?: number
  providerId?: string
  now?: number
}
export type SemanticMemorySearchHit = {
  memory: SemanticMemoryChunk
  score: number
  lexicalScore: number
  semanticScore?: number
}
export type SemanticMemorySearchResult = {
  hits: SemanticMemorySearchHit[]
  requestedMode: SemanticMemorySearchMode
  effectiveMode: SemanticMemorySearchMode
  degraded: boolean
  degradationReason?: string
}
export type SemanticMemoryInspectResult = {
  memory?: SemanticMemoryChunk
  vector?: { providerId: string; model: string; dimension: number }
}
export type SemanticMemoryAdminResult = { affected: number }
export type SemanticMemoryRebuildJob = {
  id: string
  providerId: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  cursor?: string
  processed: number
  error?: string
  createdAt: number
  updatedAt: number
}

export type SemanticMemoryPublicProvenance = {
  sourceKind: string
  sourceId: string
  sourceSessionKey?: string
  sourceEventId?: string
  sourceRunId?: string
  sourceArtifactId?: string
  contentHash: string
  recordedAt?: number
}

/** Public memory records expose only a bounded redacted preview and allowlisted provenance. */
export type SemanticMemoryPublicRecord = {
  id: string
  scope: SemanticMemoryScope
  importance: number
  lifetime: SemanticMemoryLifetime
  expiresAt?: number
  visibility: SemanticMemoryVisibility
  disabled: boolean
  sensitive: boolean
  redacted: boolean
  preview: string
  provenance: SemanticMemoryPublicProvenance
  createdAt: number
  updatedAt: number
}
export type SemanticMemoryPublicSearchHit = {
  memory: SemanticMemoryPublicRecord
  score: number
  lexicalScore: number
  semanticScore?: number
}
export type SemanticMemoryPublicSearchResult = Omit<SemanticMemorySearchResult, 'hits'> & {
  hits: SemanticMemoryPublicSearchHit[]
}
export type SemanticMemoryPublicInspectResult = { memory?: SemanticMemoryPublicRecord }
export type SemanticMemoryIngestResult = { discovered: number; upserted: number }

export type SemanticMemoryPublicScope =
  | { kind: 'session'; route: AgentRouteLike }
  | { kind: 'session-set'; routes: AgentRouteLike[] }
  | { kind: 'agent'; id: string; sourceRoute: AgentRouteLike }
  | { kind: 'workspace'; id: string; sourceRoute: AgentRouteLike }
  | { kind: 'drive'; id: string; sourceRoute: AgentRouteLike }

export type SemanticMemorySearchPublicReq = Omit<SemanticMemorySearchRequest, 'scopes'> & {
  scopes: SemanticMemoryPublicScope[]
}
export type SemanticMemoryInspectPublicReq = { id: string; sourceRoute: AgentRouteLike }
export type SemanticMemoryDeletePublicReq = SemanticMemoryInspectPublicReq
export type SemanticMemorySetDisabledPublicReq = SemanticMemoryInspectPublicReq & {
  disabled: boolean
}
export type SemanticMemorySetVisibilityPublicReq = SemanticMemoryInspectPublicReq & {
  visibility: SemanticMemoryVisibility
}
export type SemanticMemoryClearScopePublicReq = { scope: SemanticMemoryPublicScope }
export type SemanticMemoryRebuildPublicReq = {
  sourceRoute: AgentRouteLike
  providerId: string
  jobId?: string
  batchSize?: number
}
export type SemanticMemoryIngestSessionPublicReq = {
  sourceRoute: AgentRouteLike
  providerId?: string
}
export type SemanticMemoryIngestScopePublicReq = {
  scope: SemanticMemoryPublicScope
  providerId?: string
}
export type SemanticMemoryAgentSessionLinkPublicReq = {
  agentId: string
  sourceRoute: AgentRouteLike
}
export type SemanticMemoryAgentSessionLink = {
  agentId: string
  sessionId: string
  createdAt: number
}
