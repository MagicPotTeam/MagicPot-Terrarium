import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { getAgentSessionKey, normalizeAgentRoute, type AgentRouteLike } from '@shared/agent'
import type {
  SemanticMemoryAdminResult,
  SemanticMemoryAgentSessionLink,
  SemanticMemoryAgentSessionLinkPublicReq,
  SemanticMemoryClearScopePublicReq,
  SemanticMemoryDeletePublicReq,
  SemanticMemoryIngestResult,
  SemanticMemoryIngestScopePublicReq,
  SemanticMemoryIngestSessionPublicReq,
  SemanticMemoryInspectPublicReq,
  SemanticMemoryPublicInspectResult,
  SemanticMemoryPublicRecord,
  SemanticMemoryPublicScope,
  SemanticMemoryPublicSearchResult,
  SemanticMemoryRebuildJob,
  SemanticMemoryRebuildPublicReq,
  SemanticMemoryScope,
  SemanticMemorySearchPublicReq,
  SemanticMemorySetDisabledPublicReq,
  SemanticMemorySetVisibilityPublicReq
} from '@shared/magicAgentPlatform2/memory'
import type { AssistantRuntime } from '../../assistantRuntime/runtime'
import type { PersistentAgentInstanceStore } from '../agents/persistentAgentInstanceStore'
import type { PersistentDriveStore } from '../drives/persistentDriveStore'
import type { AssistantRoute } from '../../assistantRuntime/types'
import type { PolicyJsonRecord } from '@shared/magicAgentPlatform2/policy'
import { redactSecretCredentialText } from '../policy/redaction'
import { AssistantSessionMemorySource } from './assistantSessionMemorySource'
import type { SemanticMemoryService } from './semanticMemoryService'
import { SemanticMemoryScopeResolver } from './semanticMemoryScopeResolver'

export type SemanticMemoryAuthenticatedUser = { kind: 'user'; id: string }
type PolicyAuthorizer = (input: {
  route: AssistantRoute
  sessionId: string
  toolName: string
  toolInput: PolicyJsonRecord
}) => void

export type PublicSemanticMemoryServiceDeps = {
  memory?: SemanticMemoryService
  assistantRuntime?: AssistantRuntime
  source?: AssistantSessionMemorySource
  authorize?: PolicyAuthorizer
  resolver?: SemanticMemoryScopeResolver
  agentStore?: PersistentAgentInstanceStore
  driveStore?: PersistentDriveStore
  resolveRuntime?: () => AssistantRuntime
}

export class PublicSemanticMemoryService {
  constructor(private readonly deps: PublicSemanticMemoryServiceDeps = {}) {}

  async search(
    req: SemanticMemorySearchPublicReq,
    actor: SemanticMemoryAuthenticatedUser
  ): Promise<SemanticMemoryPublicSearchResult> {
    const resolved = await Promise.all(
      req.scopes.map((scope) => this.resolver().resolve(scope, actor))
    )
    const scopes = resolved.map((item) => item.scope)
    const route = resolved[0]?.policyRoute
    if (!route) throw new Error('Semantic memory requires at least one scope.')
    this.authorize(route, 'memory.search', {
      queryLength: req.query.length,
      scopeCount: scopes.length
    })
    const result = await this.memory().search({ ...req, scopes })
    return { ...result, hits: result.hits.map((hit) => ({ ...hit, memory: project(hit.memory) })) }
  }

  async inspect(
    req: SemanticMemoryInspectPublicReq,
    actor: SemanticMemoryAuthenticatedUser
  ): Promise<SemanticMemoryPublicInspectResult> {
    if (!this.deps.resolver && !this.deps.assistantRuntime && !this.deps.resolveRuntime) {
      const route = normalizeAgentRoute(req.sourceRoute)
      if (route.scopeId !== actor.id)
        throw new Error('Semantic memory route is not owned by the authenticated user.')
      this.authorize(route, 'memory.inspect', { id: req.id })
      const memory = this.memory().store.get(req.id)
      if (!memory) return {}
      if (memory.scope.kind !== 'session' || memory.scope.id !== getAgentSessionKey(route))
        throw new Error('Semantic memory record is not owned by the authenticated user.')
      return { memory: project(memory) }
    }
    await this.resolver().resolve({ kind: 'session', route: req.sourceRoute }, actor)
    const memory = this.memory().store.get(req.id)
    if (!memory) return {}
    const route = await this.resolver().authorizeStored(memory.scope, actor)
    this.authorize(route, 'memory.inspect', { id: req.id })
    return { memory: project(memory) }
  }

  async delete(
    req: SemanticMemoryDeletePublicReq,
    actor: SemanticMemoryAuthenticatedUser
  ): Promise<SemanticMemoryAdminResult> {
    return this.mutateId(req, actor, 'memory.delete', () => this.memory().delete(req.id))
  }
  async setDisabled(
    req: SemanticMemorySetDisabledPublicReq,
    actor: SemanticMemoryAuthenticatedUser
  ): Promise<SemanticMemoryAdminResult> {
    return this.mutateId(req, actor, 'memory.setDisabled', () =>
      this.memory().setDisabled(req.id, req.disabled)
    )
  }
  async setVisibility(
    req: SemanticMemorySetVisibilityPublicReq,
    actor: SemanticMemoryAuthenticatedUser
  ): Promise<SemanticMemoryAdminResult> {
    return this.mutateId(req, actor, 'memory.setVisibility', () =>
      this.memory().setVisibility(req.id, req.visibility)
    )
  }
  async clearScope(
    req: SemanticMemoryClearScopePublicReq,
    actor: SemanticMemoryAuthenticatedUser
  ): Promise<SemanticMemoryAdminResult> {
    const resolved = await this.resolver().resolve(req.scope, actor)
    const route = resolved.policyRoute
    const scope = resolved.scope
    this.authorize(route, 'memory.clearScope', { scopeKind: scope.kind, scopeId: scope.id })
    if (scope.kind === 'session-set') {
      let affected = 0
      for (const sessionId of scope.sessionIds ?? [])
        affected += this.memory().clearScope({ kind: 'session', id: sessionId }).affected
      return { affected }
    }
    return this.memory().clearScope(scope)
  }
  async rebuild(
    req: SemanticMemoryRebuildPublicReq,
    actor: SemanticMemoryAuthenticatedUser
  ): Promise<SemanticMemoryRebuildJob> {
    const resolved = await this.resolver().resolve(
      { kind: 'session', route: req.sourceRoute },
      actor
    )
    const route = resolved.policyRoute
    this.authorize(route, 'memory.rebuild', {
      providerId: req.providerId,
      ...(req.jobId === undefined ? {} : { jobId: req.jobId })
    })
    return this.memory().rebuild(req.providerId, req.jobId, req.batchSize)
  }
  async ingestScope(
    req: SemanticMemoryIngestScopePublicReq,
    actor: SemanticMemoryAuthenticatedUser
  ): Promise<SemanticMemoryIngestResult> {
    const resolved = await this.resolver().resolve(req.scope, actor)
    this.authorize(resolved.policyRoute, 'memory.ingestScope', {
      scopeKind: resolved.scope.kind,
      scopeId: resolved.scope.id
    })
    const sessions =
      resolved.scope.kind === 'drive' ? resolved.sessions : resolved.sessions.slice(0, 1)
    let discovered = 0
    let upserted = 0
    if (resolved.scope.kind === 'drive') {
      const drive = this.deps.driveStore?.get(resolved.scope.id)
      if (!drive) throw new Error('Semantic memory Drive does not exist.')
      const content = `title: ${drive.state.title}\nobjective: ${drive.state.objective}\nstatus: ${drive.state.status}`
      const now = Date.now()
      const chunk = {
        id: `drive:${drive.id}:summary`,
        scope: resolved.scope,
        content,
        summary: content,
        importance: 0.8,
        lifetime: 'durable' as const,
        visibility: 'private' as const,
        provenance: {
          source: 'drive',
          sourceId: drive.id,
          createdAt: now,
          contentHash: createHash('sha256').update(content).digest('hex')
        },
        sensitive: { sensitive: false, redacted: false, allowRemoteEmbedding: false },
        createdAt: now,
        updatedAt: now
      }
      const existing = this.memory().store.get(chunk.id)
      await this.memory().upsert(chunk, req.providerId)
      discovered++
      if (!existing || existing.provenance.contentHash !== chunk.provenance.contentHash) upserted++
    }
    for (const session of sessions) {
      const chunks = (this.deps.source ?? new AssistantSessionMemorySource()).createChunks(
        session,
        {
          scopes: [resolved.scope.kind as 'session' | 'workspace' | 'agent' | 'drive'],
          ...(resolved.scope.kind === 'agent' ? { agentId: resolved.scope.id } : {}),
          ...(resolved.scope.kind === 'drive' ? { driveId: resolved.scope.id } : {})
        }
      )
      discovered += chunks.length
      for (const chunk of chunks) {
        const existing = this.memory().store.get(chunk.id)
        await this.memory().upsert(chunk, req.providerId)
        if (!existing || existing.provenance.contentHash !== chunk.provenance.contentHash)
          upserted++
      }
    }
    return { discovered, upserted }
  }

  async ingestSession(
    req: SemanticMemoryIngestSessionPublicReq,
    actor: SemanticMemoryAuthenticatedUser
  ): Promise<SemanticMemoryIngestResult> {
    return this.ingestScope(
      {
        scope: { kind: 'session', route: req.sourceRoute },
        ...(req.providerId === undefined ? {} : { providerId: req.providerId })
      },
      actor
    )
  }

  async linkAgentSession(
    req: SemanticMemoryAgentSessionLinkPublicReq,
    actor: SemanticMemoryAuthenticatedUser
  ): Promise<SemanticMemoryAgentSessionLink[]> {
    await this.resolver().linkAgentSession(
      req.agentId,
      normalizeAgentRoute(req.sourceRoute) as AssistantRoute,
      actor
    )
    return this.resolver().listAgentSessionLinks(req.agentId, actor)
  }

  async unlinkAgentSession(
    req: SemanticMemoryAgentSessionLinkPublicReq,
    actor: SemanticMemoryAuthenticatedUser
  ): Promise<SemanticMemoryAgentSessionLink[]> {
    await this.resolver().unlinkAgentSession(req.agentId, req.sourceRoute, actor)
    return this.resolver().listAgentSessionLinks(req.agentId, actor)
  }

  listAgentSessionLinks(
    req: { agentId: string },
    actor: SemanticMemoryAuthenticatedUser
  ): Promise<SemanticMemoryAgentSessionLink[]> {
    return this.resolver().listAgentSessionLinks(req.agentId, actor)
  }

  private resolver(): SemanticMemoryScopeResolver {
    if (this.deps.resolver) return this.deps.resolver
    const runtime =
      this.deps.assistantRuntime ??
      this.deps.resolveRuntime?.() ??
      ({
        getSession: async (route: AgentRouteLike) => ({
          sessionKey: getAgentSessionKey(route),
          route: normalizeAgentRoute(route),
          workspace: { workspaceId: '' }
        })
      } as unknown as AssistantRuntime)
    return new SemanticMemoryScopeResolver(
      runtime,
      this.memory().store,
      this.deps.agentStore,
      this.deps.driveStore
    )
  }
  private memory(): SemanticMemoryService {
    if (this.deps.memory) return this.deps.memory
    const require = createRequire(import.meta.url)
    return (
      require('./productionSemanticMemory') as typeof import('./productionSemanticMemory')
    ).getProductionSemanticMemory().service
  }
  private authorize(route: AgentRouteLike, toolName: string, toolInput: PolicyJsonRecord): void {
    const normalizedRoute = normalizeAgentRoute(route) as AssistantRoute
    const authorize =
      this.deps.authorize ??
      ((input: Parameters<PolicyAuthorizer>[0]) => {
        const require = createRequire(import.meta.url)
        const { getAssistantTerminalPolicyRuntime } =
          require('../productionRuntime') as typeof import('../productionRuntime')
        return getAssistantTerminalPolicyRuntime().authorizeAssistantMutation(input)
      })
    authorize({
      route: normalizedRoute,
      sessionId: getAgentSessionKey(normalizedRoute),
      toolName,
      toolInput
    })
  }
  private async mutateId(
    req: SemanticMemoryInspectPublicReq,
    actor: SemanticMemoryAuthenticatedUser,
    toolName: string,
    operation: () => SemanticMemoryAdminResult
  ): Promise<SemanticMemoryAdminResult> {
    if (!this.deps.resolver && !this.deps.assistantRuntime && !this.deps.resolveRuntime) {
      const route = normalizeAgentRoute(req.sourceRoute)
      if (route.scopeId !== actor.id)
        throw new Error('Semantic memory route is not owned by the authenticated user.')
      this.authorize(route, toolName, { id: req.id })
      const memory = this.memory().store.get(req.id)
      if (!memory) return operation()
      if (memory.scope.kind !== 'session' || memory.scope.id !== getAgentSessionKey(route))
        throw new Error('Semantic memory record is not owned by the authenticated user.')
      return operation()
    }
    await this.resolver().resolve({ kind: 'session', route: req.sourceRoute }, actor)
    const memory = this.memory().store.get(req.id)
    if (!memory) return { affected: 0 }
    const route = await this.resolver().authorizeStored(memory.scope, actor)
    this.authorize(route, toolName, { id: req.id })
    return operation()
  }
}

const project = (
  memory: Parameters<SemanticMemoryService['upsert']>[0]
): SemanticMemoryPublicRecord => ({
  id: memory.id,
  scope: memory.scope,
  importance: memory.importance,
  lifetime: memory.lifetime,
  ...(memory.expiresAt === undefined ? {} : { expiresAt: memory.expiresAt }),
  visibility: memory.visibility,
  disabled: memory.disabled === true,
  sensitive: memory.sensitive.sensitive,
  redacted: true,
  preview: redactSecretCredentialText(memory.summary ?? memory.content).slice(0, 500),
  provenance: {
    sourceKind: memory.provenance.source,
    sourceId: memory.provenance.sourceId,
    ...(memory.provenance.sessionId === undefined
      ? {}
      : { sourceSessionKey: memory.provenance.sessionId }),
    ...(memory.provenance.eventId === undefined
      ? {}
      : { sourceEventId: memory.provenance.eventId }),
    ...(memory.provenance.runId === undefined ? {} : { sourceRunId: memory.provenance.runId }),
    ...(memory.provenance.artifactId === undefined
      ? {}
      : { sourceArtifactId: memory.provenance.artifactId }),
    contentHash: memory.provenance.contentHash,
    recordedAt: memory.provenance.createdAt
  },
  createdAt: memory.createdAt,
  updatedAt: memory.updatedAt
})
