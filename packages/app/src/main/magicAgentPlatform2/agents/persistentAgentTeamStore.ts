import type {
  MagicAgentTeamMember,
  MagicAgentTeamState
} from '../../../shared/magicAgentPlatform2/team'
import { MagicAgentEventStore, type StoredResource } from '../persistence/eventStore'

export const MAGIC_AGENT_TEAM_RESOURCE_KIND = 'magic-agent-team'
const text = (value: string, field: string) => {
  if (!value.trim() || value !== value.trim()) throw new Error(`${field} is required.`)
}

export class PersistentAgentTeamStore {
  constructor(private readonly events: MagicAgentEventStore) {}
  get(id: string) {
    return this.events.getResource(MAGIC_AGENT_TEAM_RESOURCE_KIND, id) as
      | StoredResource<MagicAgentTeamState>
      | undefined
  }
  list() {
    return this.events.listResources({
      kind: MAGIC_AGENT_TEAM_RESOURCE_KIND
    }) as readonly StoredResource<MagicAgentTeamState>[]
  }

  create(input: { team: MagicAgentTeamState; idempotencyKey: string }) {
    text(input.team.id, 'Team id')
    text(input.team.name, 'Team name')
    text(input.team.ownerId, 'Team owner')
    if (input.team.members.length) throw new Error('Team must be created without members.')
    const key = `agent-team:${input.team.id}:create:${input.idempotencyKey}`
    const replay = this.replay(input.team.id, key)
    if (replay) {
      if (
        replay.state.name !== input.team.name ||
        replay.state.ownerId !== input.team.ownerId ||
        replay.state.status !== input.team.status
      )
        throw new Error('Team create idempotency conflict.')
      return replay
    }
    if (this.get(input.team.id)) throw new Error('Team already exists.')
    return this.mutate('create', input.team, input.team.createdAt, key, 'agent-team.created', {
      name: input.team.name,
      ownerId: input.team.ownerId
    })
  }

  getAddMemberReplay(input: {
    teamId: string
    member: MagicAgentTeamMember
    idempotencyKey: string
  }) {
    const replay = this.replay(
      input.teamId,
      `agent-team:${input.teamId}:member-add:${input.idempotencyKey}`
    )
    if (replay) {
      const member = replay.state.members.find((item) => item.memberId === input.member.memberId)
      if (
        !member ||
        member.agentInstanceId !== input.member.agentInstanceId ||
        member.role !== input.member.role ||
        member.joinedAt !== input.member.joinedAt ||
        member.addedBy.kind !== input.member.addedBy.kind ||
        member.addedBy.id !== input.member.addedBy.id
      )
        throw new Error('Team member add idempotency conflict.')
    }
    return replay
  }

  getRemoveMemberReplay(input: {
    teamId: string
    memberId: string
    removedAt: number
    idempotencyKey: string
  }) {
    const key = `agent-team:${input.teamId}:member-remove:${input.idempotencyKey}`
    const mutation = this.events
      .listResourceMutations(MAGIC_AGENT_TEAM_RESOURCE_KIND, input.teamId, 1_000)
      .find((item) => item.idempotencyKey === key)
    if (!mutation) return undefined
    const event = this.events.getEvent(`${key}:event`)
    const payload = event?.payload as { memberId?: string } | undefined
    if (event?.createdAt !== input.removedAt || payload?.memberId !== input.memberId)
      throw new Error('Team member remove idempotency conflict.')
    return mutation.resource as StoredResource<MagicAgentTeamState>
  }

  addMember(input: {
    teamId: string
    expectedRevision: number
    member: MagicAgentTeamMember
    idempotencyKey: string
  }) {
    text(input.member.memberId, 'Team member id')
    text(input.member.agentInstanceId, 'Agent instance id')
    const key = `agent-team:${input.teamId}:member-add:${input.idempotencyKey}`
    const replay = this.getAddMemberReplay(input)
    if (replay) return replay
    const team = this.require(input.teamId, input.expectedRevision)
    if (
      team.state.members.some(
        (m) =>
          m.memberId === input.member.memberId || m.agentInstanceId === input.member.agentInstanceId
      )
    )
      throw new Error('Team member already exists.')
    if (input.member.role === 'leader' && team.state.members.some((m) => m.role === 'leader'))
      throw new Error('Team already has a leader.')
    return this.mutate(
      'update',
      { ...team.state, members: [...team.state.members, input.member] },
      input.member.joinedAt,
      key,
      'agent-team.member-added',
      {
        memberId: input.member.memberId,
        agentInstanceId: input.member.agentInstanceId,
        role: input.member.role
      }
    )
  }

  remove(input: {
    teamId: string
    expectedRevision: number
    removedAt: number
    idempotencyKey: string
  }) {
    const key = `agent-team:${input.teamId}:remove:${input.idempotencyKey}`
    const replay = this.replay(input.teamId, key)
    if (replay) {
      const event = this.events.getEvent(`${key}:event`)
      if (event?.createdAt !== input.removedAt) throw new Error('Team remove idempotency conflict.')
      return replay
    }
    const team = this.require(input.teamId, input.expectedRevision)
    if (team.state.members.length) throw new Error('Team must be empty before removal.')
    return this.mutate(
      'update',
      { ...team.state, status: 'removed' },
      input.removedAt,
      key,
      'agent-team.removed',
      {}
    )
  }

  removeMember(input: {
    teamId: string
    expectedRevision: number
    memberId: string
    removedAt: number
    idempotencyKey: string
  }) {
    const key = `agent-team:${input.teamId}:member-remove:${input.idempotencyKey}`
    const replay = this.getRemoveMemberReplay(input)
    if (replay) return replay
    const team = this.require(input.teamId, input.expectedRevision)
    if (!team.state.members.some((m) => m.memberId === input.memberId))
      throw new Error('Team member not found.')
    return this.mutate(
      'update',
      { ...team.state, members: team.state.members.filter((m) => m.memberId !== input.memberId) },
      input.removedAt,
      key,
      'agent-team.member-removed',
      { memberId: input.memberId }
    )
  }

  private require(id: string, revision: number) {
    const team = this.get(id)
    if (!team) throw new Error('Team not found.')
    if (team.revision !== revision) throw new Error('Team revision conflict.')
    return team
  }
  private replay(id: string, key: string) {
    return this.events
      .listResourceMutations(MAGIC_AGENT_TEAM_RESOURCE_KIND, id, 1_000)
      .find((m) => m.idempotencyKey === key)?.resource as
      | StoredResource<MagicAgentTeamState>
      | undefined
  }
  private mutate(
    operation: 'create' | 'update',
    state: MagicAgentTeamState,
    at: number,
    key: string,
    type: string,
    payload: Record<string, unknown>
  ) {
    return this.events.mutateResource<MagicAgentTeamState>({
      operation,
      kind: MAGIC_AGENT_TEAM_RESOURCE_KIND,
      id: state.id,
      ...(operation === 'update' ? { expectedRevision: this.get(state.id)!.revision } : {}),
      state,
      createdAt: at,
      idempotencyKey: key,
      event: {
        protocolVersion: '2.0.0',
        id: `${key}:event`,
        type,
        createdAt: at,
        payload: { teamId: state.id, ...payload },
        envelopeKind: 'event',
        streamId: `agent-team:${state.id}:stream`,
        sequence: this.events.listResourceMutations(MAGIC_AGENT_TEAM_RESOURCE_KIND, state.id, 1_000)
          .length
      }
    }).resource
  }
}
