import type { MagicAgentPlatformRunReq } from '../../../shared/api/svcMagicAgentPlatform'
import type { PolicyActorRef } from '../../../shared/magicAgentPlatform2/policy'
import { MagicAgentEventStore, type StoredResource } from '../persistence/eventStore'

export const MAGIC_AGENT_TEAM_LIFECYCLE_OPERATION_RESOURCE_KIND =
  'magic-agent-team-lifecycle-operation'

export type AgentTeamLifecycleAction = 'start' | 'pause' | 'resume' | 'stop' | 'replace'
export type AgentTeamMemberReplacementSpec = Readonly<{
  memberId: string
  definitionId: string
  name: string
  configVersion: string
  replacedAt: number
}>
export type AgentTeamLifecycleMemberOutcome = Readonly<{
  memberId: string
  agentInstanceId: string
  status: 'completed' | 'failed'
  error?: string
}>
export type AgentTeamLifecycleOperationState = Readonly<{
  id: string
  teamId: string
  teamRevision: number
  action: AgentTeamLifecycleAction
  actor: PolicyActorRef
  inputDigest: string
  request?: MagicAgentPlatformRunReq
  status: 'running' | 'completed' | 'partial' | 'failed'
  members: readonly Readonly<{
    memberId: string
    agentInstanceId: string
    expectedRevision: number
    replacement?: AgentTeamMemberReplacementSpec
  }>[]
  outcomes: readonly AgentTeamLifecycleMemberOutcome[]
  startedAt: number
  completedAt?: number
}>

export class PersistentAgentTeamLifecycleOperationStore {
  constructor(private readonly events: MagicAgentEventStore) {}

  get(id: string) {
    return this.events.getResource(MAGIC_AGENT_TEAM_LIFECYCLE_OPERATION_RESOURCE_KIND, id) as
      | StoredResource<AgentTeamLifecycleOperationState>
      | undefined
  }

  listRunning() {
    return (
      this.events.listResources({
        kind: MAGIC_AGENT_TEAM_LIFECYCLE_OPERATION_RESOURCE_KIND
      }) as readonly StoredResource<AgentTeamLifecycleOperationState>[]
    ).filter((item) => item.state.status === 'running')
  }

  getReplay(input: { id: string; inputDigest: string }) {
    const operation = this.get(input.id)
    if (!operation) return undefined
    if (operation.state.inputDigest !== input.inputDigest)
      throw new Error('Team lifecycle operation idempotency conflict.')
    return operation
  }

  begin(input: { state: AgentTeamLifecycleOperationState; idempotencyKey: string }) {
    const replay = this.getReplay({ id: input.state.id, inputDigest: input.state.inputDigest })
    if (replay) return replay
    return this.mutate(
      'create',
      input.state,
      input.state.startedAt,
      input.idempotencyKey,
      'started',
      {}
    )
  }

  recoverInterrupted(input: { id: string; recoveredAt: number }) {
    let operation = this.get(input.id)
    if (!operation) throw new Error('Team lifecycle operation not found.')
    if (operation.state.status !== 'running') return operation
    for (const member of operation.state.members) {
      if (operation.state.outcomes.some((item) => item.memberId === member.memberId)) continue
      operation = this.recordOutcome({
        id: input.id,
        expectedRevision: operation.revision,
        outcome: {
          memberId: member.memberId,
          agentInstanceId: member.agentInstanceId,
          status: 'failed',
          error: 'Team lifecycle operation interrupted by process restart.'
        },
        recordedAt: input.recoveredAt,
        idempotencyKey: `recovery:${input.id}:${member.memberId}`
      })
    }
    const completed = operation.state.outcomes.filter((item) => item.status === 'completed').length
    return this.complete({
      id: input.id,
      expectedRevision: operation.revision,
      status: completed === 0 ? 'failed' : 'partial',
      completedAt: input.recoveredAt,
      idempotencyKey: `recovery:${input.id}:complete`
    })
  }

  recordOutcome(input: {
    id: string
    expectedRevision: number
    outcome: AgentTeamLifecycleMemberOutcome
    recordedAt: number
    idempotencyKey: string
  }) {
    const operation = this.require(input.id, input.expectedRevision)
    if (operation.state.outcomes.some((item) => item.memberId === input.outcome.memberId))
      throw new Error('Team lifecycle member outcome already exists.')
    return this.mutate(
      'update',
      { ...operation.state, outcomes: [...operation.state.outcomes, input.outcome] },
      input.recordedAt,
      input.idempotencyKey,
      'member-completed',
      input.outcome
    )
  }

  complete(input: {
    id: string
    expectedRevision: number
    status: 'completed' | 'partial' | 'failed'
    completedAt: number
    idempotencyKey: string
  }) {
    const operation = this.require(input.id, input.expectedRevision)
    if (operation.state.outcomes.length !== operation.state.members.length)
      throw new Error('Team lifecycle operation has incomplete member outcomes.')
    return this.mutate(
      'update',
      { ...operation.state, status: input.status, completedAt: input.completedAt },
      input.completedAt,
      input.idempotencyKey,
      'completed',
      { status: input.status }
    )
  }

  private require(id: string, revision: number) {
    const operation = this.get(id)
    if (!operation) throw new Error('Team lifecycle operation not found.')
    if (operation.revision !== revision)
      throw new Error('Team lifecycle operation revision conflict.')
    return operation
  }

  private mutate(
    operation: 'create' | 'update',
    state: AgentTeamLifecycleOperationState,
    at: number,
    idempotencyKey: string,
    eventSuffix: string,
    payload: Record<string, unknown>
  ) {
    const key = `agent-team-lifecycle:${state.id}:${idempotencyKey}`
    return this.events.mutateResource<AgentTeamLifecycleOperationState>({
      operation,
      kind: MAGIC_AGENT_TEAM_LIFECYCLE_OPERATION_RESOURCE_KIND,
      id: state.id,
      ...(operation === 'update' ? { expectedRevision: this.get(state.id)!.revision } : {}),
      state,
      createdAt: operation === 'update' ? this.get(state.id)!.createdAt : at,
      idempotencyKey: key,
      event: {
        protocolVersion: '2.0.0',
        id: `${key}:event`,
        type: `agent-team.lifecycle-${eventSuffix}`,
        createdAt: at,
        payload: { operationId: state.id, teamId: state.teamId, action: state.action, ...payload },
        envelopeKind: 'event',
        streamId: `agent-team-lifecycle:${state.id}:stream`,
        sequence: this.events.listResourceMutations(
          MAGIC_AGENT_TEAM_LIFECYCLE_OPERATION_RESOURCE_KIND,
          state.id,
          1_000
        ).length
      }
    }).resource
  }
}
