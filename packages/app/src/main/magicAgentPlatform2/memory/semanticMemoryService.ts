import crypto from 'crypto'
import type {
  SemanticMemoryAdminResult,
  SemanticMemoryChunk,
  SemanticMemoryInspectResult,
  SemanticMemoryRebuildJob,
  SemanticMemoryScope,
  SemanticMemorySearchRequest,
  SemanticMemorySearchResult,
  SemanticMemoryVisibility
} from '@shared/magicAgentPlatform2/memory'
import { EmbeddingProviderRegistry } from './embeddingProviderRegistry'
import { SqliteSemanticMemoryStore } from './sqliteSemanticMemoryStore'

export class SemanticMemoryService {
  constructor(
    readonly store: SqliteSemanticMemoryStore,
    readonly providers = new EmbeddingProviderRegistry()
  ) {}

  async upsert(memory: SemanticMemoryChunk, providerId?: string): Promise<SemanticMemoryChunk> {
    validateMemory(memory)
    const existing = this.store.get(memory.id)
    if (existing?.provenance.contentHash === memory.provenance.contentHash) return existing
    this.store.upsert(memory)
    if (providerId) await this.embedMemory(memory, providerId)
    return memory
  }

  async search(request: SemanticMemorySearchRequest): Promise<SemanticMemorySearchResult> {
    const requestedMode = request.mode ?? 'hybrid'
    const limit = Math.min(100, Math.max(1, request.limit ?? 10))
    const candidates = this.store.listCandidates(
      request.scopes,
      request.visibility,
      request.now ?? Date.now()
    )
    const lexical = this.store.lexicalIds(request.query, candidates, limit)
    let queryVector: number[] | undefined
    const providerId = request.providerId
    let degradationReason: string | undefined
    if (requestedMode !== 'lexical') {
      try {
        if (!providerId) throw new Error('No embedding provider selected')
        const provider = this.providers.require(providerId)
        const response = await provider.embed({ texts: [request.query], model: provider.model })
        this.providers.validate(provider, response, 1)
        queryVector = response.vectors[0]
      } catch (error) {
        degradationReason = error instanceof Error ? error.message : String(error)
      }
    }
    const semantic = new Map<string, number>()
    if (queryVector && providerId)
      for (const memory of candidates) {
        const stored = this.store.getVector(memory.id, providerId)
        if (stored && stored.dimension === queryVector.length)
          semantic.set(memory.id, cosine(queryVector, stored.vector))
      }
    const effectiveMode =
      requestedMode === 'lexical'
        ? 'lexical'
        : queryVector && semantic.size
          ? requestedMode
          : 'lexical'
    if (effectiveMode === 'lexical' && requestedMode !== 'lexical' && !degradationReason)
      degradationReason = 'No compatible stored vectors'
    const lw = clamp(request.lexicalWeight ?? 0.45),
      sw = clamp(request.semanticWeight ?? 0.55)
    const hits = candidates
      .map((memory) => {
        const lexicalScore = lexical.get(memory.id) ?? 0,
          semanticScore = semantic.get(memory.id)
        const score =
          effectiveMode === 'lexical'
            ? lexicalScore
            : requestedMode === 'semantic'
              ? (semanticScore ?? 0)
              : lw * lexicalScore + sw * (semanticScore ?? 0)
        return {
          memory,
          score,
          lexicalScore,
          ...(semanticScore === undefined ? {} : { semanticScore })
        }
      })
      .filter((hit) => hit.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.memory.importance - a.memory.importance ||
          a.memory.id.localeCompare(b.memory.id)
      )
      .slice(0, limit)
    return {
      hits,
      requestedMode,
      effectiveMode,
      degraded: effectiveMode !== requestedMode,
      ...(degradationReason ? { degradationReason } : {})
    }
  }

  inspect(id: string, providerId?: string): SemanticMemoryInspectResult {
    const memory = this.store.get(id)
    const vector = memory && providerId ? this.store.getVector(id, providerId) : undefined
    return {
      memory,
      ...(vector
        ? {
            vector: {
              providerId: vector.providerId,
              model: vector.model,
              dimension: vector.dimension
            }
          }
        : {})
    }
  }
  delete(id: string): SemanticMemoryAdminResult {
    return { affected: this.store.delete(id) }
  }
  setDisabled(id: string, disabled: boolean): SemanticMemoryAdminResult {
    return { affected: this.store.setDisabled(id, disabled) }
  }
  setVisibility(id: string, visibility: SemanticMemoryVisibility): SemanticMemoryAdminResult {
    return { affected: this.store.setVisibility(id, visibility) }
  }
  clearScope(scope: SemanticMemoryScope): SemanticMemoryAdminResult {
    return { affected: this.store.clearScope(scope) }
  }

  async rebuild(
    providerId: string,
    jobId = `rebuild:${providerId}`,
    batchSize = 50
  ): Promise<SemanticMemoryRebuildJob> {
    const provider = this.providers.require(providerId),
      now = Date.now()
    let job = this.store.getJob(jobId) ?? {
      id: jobId,
      providerId,
      status: 'pending' as const,
      processed: 0,
      createdAt: now,
      updatedAt: now
    }
    if (job.status === 'completed') return job
    job = { ...job, status: 'running', error: undefined, updatedAt: now }
    this.store.putJob(job)
    try {
      const all = this.store
        .listAll()
        .filter((m) => !job.cursor || m.id > job.cursor)
        .slice(0, batchSize)
      for (const memory of all) {
        await this.embedMemory(memory, providerId)
        job = { ...job, cursor: memory.id, processed: job.processed + 1, updatedAt: Date.now() }
        this.store.putJob(job)
      }
      const remaining = this.store.listAll().some((m) => !job.cursor || m.id > job.cursor)
      job = { ...job, status: remaining ? 'pending' : 'completed', updatedAt: Date.now() }
      this.store.putJob(job)
      return job
    } catch (error) {
      job = {
        ...job,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        updatedAt: Date.now()
      }
      this.store.putJob(job)
      throw error
    }
  }

  private async embedMemory(memory: SemanticMemoryChunk, providerId: string): Promise<void> {
    const provider = this.providers.require(providerId)
    if (memory.sensitive.sensitive && provider.remote && !memory.sensitive.allowRemoteEmbedding)
      throw new Error('Sensitive memory cannot use a remote embedding provider')
    const response = await provider.embed({ texts: [memory.content], model: provider.model })
    this.providers.validate(provider, response, 1)
    this.store.putVector(
      memory.id,
      provider.id,
      response.model,
      response.dimension,
      response.vectors[0]
    )
  }
}

function validateMemory(memory: SemanticMemoryChunk): void {
  if (
    !memory.id ||
    !memory.scope.id ||
    !memory.content ||
    memory.importance < 0 ||
    memory.importance > 1
  )
    throw new Error('Invalid semantic memory chunk')
  if (
    memory.provenance.contentHash !==
    crypto.createHash('sha256').update(memory.content).digest('hex')
  )
    throw new Error('Semantic memory content hash mismatch')
}
const clamp = (value: number) => Math.max(0, Math.min(1, value))
const cosine = (a: number[], b: number[]): number => {
  let dot = 0,
    aa = 0,
    bb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    aa += a[i] * a[i]
    bb += b[i] * b[i]
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0
}
