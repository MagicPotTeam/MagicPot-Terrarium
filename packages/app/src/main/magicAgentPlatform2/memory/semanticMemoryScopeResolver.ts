import { getAgentSessionKey, normalizeAgentRoute, type AgentRouteLike } from '@shared/agent'
import type {
  SemanticMemoryPublicScope,
  SemanticMemoryScope
} from '@shared/magicAgentPlatform2/memory'
import type { AssistantRuntime } from '../../assistantRuntime/runtime'
import type { AssistantRoute, AssistantSessionRecord } from '../../assistantRuntime/types'
import type { PersistentAgentInstanceStore } from '../agents/persistentAgentInstanceStore'
import type { PersistentDriveStore } from '../drives/persistentDriveStore'
import type { SqliteSemanticMemoryStore } from './sqliteSemanticMemoryStore'

export type SemanticMemoryScopeActor = { kind: 'user'; id: string }
export type ResolvedSemanticMemoryScope = {
  scope: SemanticMemoryScope
  policyRoute: AssistantRoute
  sessions: AssistantSessionRecord[]
}

export class SemanticMemoryScopeResolver {
  constructor(
    private readonly runtime: AssistantRuntime,
    private readonly links: SqliteSemanticMemoryStore,
    private readonly agentStore?: PersistentAgentInstanceStore,
    private readonly driveStore?: PersistentDriveStore
  ) {}

  async resolve(
    value: SemanticMemoryPublicScope,
    actor: SemanticMemoryScopeActor
  ): Promise<ResolvedSemanticMemoryScope> {
    this.assertActor(actor)
    if (value.kind === 'session') {
      const session = await this.ownedSession(value.route, actor)
      return {
        scope: { kind: 'session', id: session.sessionKey },
        policyRoute: session.route,
        sessions: [session]
      }
    }
    if (value.kind === 'session-set') {
      if (!value.routes.length)
        throw new Error('Semantic memory session-set requires at least one route.')
      const sessions = await Promise.all(
        value.routes.map((route) => this.ownedSession(route, actor))
      )
      return {
        scope: {
          kind: 'session-set',
          id: sessions.map((item) => item.sessionKey).join('|'),
          sessionIds: sessions.map((item) => item.sessionKey)
        },
        policyRoute: sessions[0].route,
        sessions
      }
    }
    const source = await this.ownedSession(value.sourceRoute, actor)
    if (value.kind === 'workspace') {
      if (source.workspace.workspaceId !== value.id)
        throw new Error('Semantic memory source session workspace identity mismatch.')
      return {
        scope: { kind: 'workspace', id: value.id },
        policyRoute: source.route,
        sessions: [source]
      }
    }
    if (value.kind === 'agent') {
      const agent = this.agentStore?.get(value.id)
      if (!agent || agent.state.ownerId !== actor.id)
        throw new Error('Semantic memory Agent is not owned by the authenticated user.')
      if (!this.links.hasAgentSessionLink(value.id, source.sessionKey))
        throw new Error('Semantic memory Agent source session is not explicitly linked.')
      return {
        scope: { kind: 'agent', id: value.id },
        policyRoute: source.route,
        sessions: [source]
      }
    }
    const drive = this.driveStore?.get(value.id)
    if (!drive || drive.state.ownerId !== actor.id)
      throw new Error('Semantic memory Drive is not owned by the authenticated user.')
    const sessionIds = drive.state.links
      .filter((link) => link.kind === 'session')
      .map((link) => link.targetId)
    if (!sessionIds.includes(source.sessionKey))
      throw new Error('Semantic memory Drive source session is not explicitly linked.')
    const sessions: AssistantSessionRecord[] = [source]
    for (const sessionId of sessionIds) {
      if (sessionId === source.sessionKey) continue
      const summary = (await this.runtime.listSessions(1_000)).find(
        (item) => item.sessionKey === sessionId
      )
      if (!summary) continue
      try {
        sessions.push(await this.ownedSession(summary.route, actor))
      } catch {
        /* Ignore unowned links. */
      }
    }
    return { scope: { kind: 'drive', id: value.id }, policyRoute: source.route, sessions }
  }

  async authorizeStored(
    scope: SemanticMemoryScope,
    actor: SemanticMemoryScopeActor
  ): Promise<AssistantRoute> {
    if (scope.kind === 'session') return (await this.ownedSessionKey(scope.id, actor)).route
    if (scope.kind === 'workspace') {
      const session = (await this.ownedSessions(actor)).find(
        (item) => item.workspace.workspaceId === scope.id
      )
      if (!session)
        throw new Error('Semantic memory Workspace is not owned by the authenticated user.')
      return session.route
    }
    if (scope.kind === 'agent') {
      const agent = this.agentStore?.get(scope.id)
      if (!agent || agent.state.ownerId !== actor.id)
        throw new Error('Semantic memory Agent is not owned by the authenticated user.')
      for (const link of this.links.listAgentSessionLinks(scope.id)) {
        try {
          return (await this.ownedSessionKey(link.sessionId, actor)).route
        } catch {
          // Persisted links are not authority; keep looking for an independently owned session.
        }
      }
      throw new Error('Semantic memory Agent has no owned linked session.')
    }
    if (scope.kind === 'drive') {
      const drive = this.driveStore?.get(scope.id)
      if (!drive || drive.state.ownerId !== actor.id)
        throw new Error('Semantic memory Drive is not owned by the authenticated user.')
      for (const link of drive.state.links) {
        if (link.kind !== 'session') continue
        try {
          return (await this.ownedSessionKey(link.targetId, actor)).route
        } catch {
          // Drive membership/assignment never substitutes for independent session ownership.
        }
      }
      throw new Error('Semantic memory Drive has no owned linked session.')
    }
    throw new Error('Stored aggregate session-set scopes are not supported.')
  }

  async linkAgentSession(
    agentId: string,
    route: AgentRouteLike,
    actor: SemanticMemoryScopeActor
  ): Promise<void> {
    const agent = this.agentStore?.get(agentId)
    if (!agent || agent.state.ownerId !== actor.id)
      throw new Error('Semantic memory Agent is not owned by the authenticated user.')
    const session = await this.ownedSession(route, actor)
    this.links.linkAgentSession(agentId, session.sessionKey)
  }

  async unlinkAgentSession(
    agentId: string,
    route: AgentRouteLike,
    actor: SemanticMemoryScopeActor
  ): Promise<number> {
    this.assertOwnedAgent(agentId, actor)
    const session = await this.ownedSession(route, actor)
    return this.links.unlinkAgentSession(agentId, session.sessionKey)
  }

  async listAgentSessionLinks(agentId: string, actor: SemanticMemoryScopeActor) {
    this.assertOwnedAgent(agentId, actor)
    const owned: Array<{ agentId: string; sessionId: string; createdAt: number }> = []
    for (const link of this.links.listAgentSessionLinks(agentId)) {
      try {
        await this.ownedSessionKey(link.sessionId, actor)
        owned.push(link)
      } catch {
        // A persisted link never grants access to a session the actor does not own.
      }
    }
    return owned
  }

  private async ownedSession(
    routeValue: AgentRouteLike,
    actor: SemanticMemoryScopeActor
  ): Promise<AssistantSessionRecord> {
    const requested = normalizeAgentRoute(routeValue) as AssistantRoute
    const session = await this.runtime.getSession(requested)
    if (!session || getAgentSessionKey(session.route) !== getAgentSessionKey(requested))
      throw new Error('Assistant session does not exist.')
    this.assertRouteOwner(session.route, actor)
    return session
  }
  private async ownedSessionKey(
    sessionId: string,
    actor: SemanticMemoryScopeActor
  ): Promise<AssistantSessionRecord> {
    const summary = (await this.runtime.listSessions(1_000)).find(
      (item) => item.sessionKey === sessionId
    )
    if (!summary) throw new Error('Assistant session does not exist.')
    return this.ownedSession(summary.route, actor)
  }
  private async ownedSessions(actor: SemanticMemoryScopeActor): Promise<AssistantSessionRecord[]> {
    const result: AssistantSessionRecord[] = []
    for (const summary of await this.runtime.listSessions(1_000)) {
      try {
        result.push(await this.ownedSession(summary.route, actor))
      } catch {
        /* Different owner. */
      }
    }
    return result
  }
  private assertActor(actor: SemanticMemoryScopeActor): void {
    if (!actor.id.trim()) throw new Error('Semantic memory requires an authenticated user.')
  }
  private assertOwnedAgent(agentId: string, actor: SemanticMemoryScopeActor): void {
    this.assertActor(actor)
    const agent = this.agentStore?.get(agentId)
    if (!agent || agent.state.ownerId !== actor.id)
      throw new Error('Semantic memory Agent is not owned by the authenticated user.')
  }
  private assertRouteOwner(route: AssistantRoute, actor: SemanticMemoryScopeActor): void {
    if (route.senderId !== actor.id && !(route.scopeType === 'dm' && route.scopeId === actor.id))
      throw new Error('Semantic memory session is not owned by the authenticated user.')
  }
}
