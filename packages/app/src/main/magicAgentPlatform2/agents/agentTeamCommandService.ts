import { createHash } from 'node:crypto'
import {
  canonicalPolicyJson,
  digestPolicyRequest,
  POLICY_REQUEST_DISCRIMINATOR,
  POLICY_REQUEST_VERSION,
  type PolicyActorRef,
  type PolicyRequest
} from '../../../shared/magicAgentPlatform2/policy'
import type {
  MagicAgentTeamMember,
  MagicAgentTeamState
} from '../../../shared/magicAgentPlatform2/team'
import type { MagicAgentPolicyAuthorizationService } from '../policy'
import type { AgentInstanceCommandService } from './agentInstanceCommandService'
import type { PersistentAgentInstanceStore } from './persistentAgentInstanceStore'
import {
  type AgentTeamLifecycleAction,
  type AgentTeamMemberReplacementSpec,
  PersistentAgentTeamLifecycleOperationStore
} from './persistentAgentTeamLifecycleOperationStore'
import type { PersistentAgentTeamStore } from './persistentAgentTeamStore'

const teamRequest = (input: {
  actor: PolicyActorRef
  action: string
  teamId: string
  revision?: number
  agentInstanceId?: string
}): PolicyRequest => {
  const base = {
    discriminator: POLICY_REQUEST_DISCRIMINATOR,
    version: POLICY_REQUEST_VERSION,
    actor: input.actor,
    origin: 'internal' as const,
    action: `agent-team.${input.action}`,
    target: { kind: 'agent-team', id: input.teamId, source: 'dynamic-agent-fabric' },
    input: {
      teamId: input.teamId,
      ...(input.revision === undefined ? {} : { revision: input.revision }),
      ...(input.agentInstanceId ? { agentInstanceId: input.agentInstanceId } : {})
    },
    effects: [
      {
        kind: 'agent.lifecycle',
        risk: 'high' as const,
        target: `agent-team.${input.action}`,
        metadata: { teamId: input.teamId, action: input.action }
      }
    ],
    constraints: {},
    context: {}
  }
  const seed = { ...base, requestId: 'agent-team-request:seed' } as PolicyRequest
  return { ...base, requestId: `agent-team-request:${digestPolicyRequest(seed)}` }
}

export class AgentTeamCommandService {
  constructor(
    private readonly teams: PersistentAgentTeamStore,
    private readonly agents: PersistentAgentInstanceStore,
    private readonly authorization: MagicAgentPolicyAuthorizationService,
    private readonly now: () => number = Date.now,
    private readonly instanceCommands?: AgentInstanceCommandService,
    readonly lifecycleOperations?: PersistentAgentTeamLifecycleOperationStore
  ) {}
  list() {
    return this.teams.list()
  }
  get(id: string) {
    return this.teams.get(id)
  }

  create(input: {
    actor: PolicyActorRef
    team: MagicAgentTeamState
    idempotencyKey: string
    grantId?: string
    expectedGrantUseCount?: number
  }) {
    if (input.actor.kind !== 'user' && input.actor.kind !== 'agent')
      throw new Error('Only an authenticated user or Agent may create a Team.')
    const replay = this.teams.create.bind(this.teams)
    const existing = this.teams.get(input.team.id)
    if (existing) return replay({ team: input.team, idempotencyKey: input.idempotencyKey })
    this.authorize({
      ...input,
      policy: teamRequest({ actor: input.actor, action: 'create', teamId: input.team.id })
    })
    return this.teams.create({
      team: {
        ...input.team,
        ownerId: input.actor.id,
        createdBy: input.actor,
        status: 'active',
        members: []
      },
      idempotencyKey: input.idempotencyKey
    })
  }

  addMember(input: {
    actor: PolicyActorRef
    teamId: string
    expectedRevision: number
    member: MagicAgentTeamMember
    idempotencyKey: string
    grantId?: string
    expectedGrantUseCount?: number
  }) {
    const trustedMember = { ...input.member, addedBy: input.actor }
    const replay = this.teams.getAddMemberReplay({ ...input, member: trustedMember })
    if (replay) return replay
    const team = this.requireManager(input.teamId, input.actor)
    const agent = this.agents.get(input.member.agentInstanceId)
    if (!agent || agent.state.status === 'removed')
      throw new Error('Team member Agent instance not found.')
    this.authorize({
      ...input,
      policy: teamRequest({
        actor: input.actor,
        action: 'member-add',
        teamId: team.id,
        revision: input.expectedRevision,
        agentInstanceId: input.member.agentInstanceId
      })
    })
    return this.teams.addMember({ ...input, member: trustedMember })
  }

  remove(input: {
    actor: PolicyActorRef
    teamId: string
    expectedRevision: number
    removedAt: number
    idempotencyKey: string
    grantId?: string
    expectedGrantUseCount?: number
  }) {
    const existing = this.teams.get(input.teamId)
    if (existing?.state.status === 'removed') return this.teams.remove(input)
    const team = this.requireManager(input.teamId, input.actor)
    this.authorize({
      ...input,
      policy: teamRequest({
        actor: input.actor,
        action: 'remove',
        teamId: team.id,
        revision: input.expectedRevision
      })
    })
    return this.teams.remove(input)
  }

  removeMember(input: {
    actor: PolicyActorRef
    teamId: string
    expectedRevision: number
    memberId: string
    removedAt: number
    idempotencyKey: string
    grantId?: string
    expectedGrantUseCount?: number
  }) {
    const replay = this.teams.getRemoveMemberReplay(input)
    if (replay) return replay
    const team = this.requireManager(input.teamId, input.actor)
    this.authorize({
      ...input,
      policy: teamRequest({
        actor: input.actor,
        action: 'member-remove',
        teamId: team.id,
        revision: input.expectedRevision
      })
    })
    return this.teams.removeMember(input)
  }

  async replace(input: {
    actor: PolicyActorRef
    teamId: string
    expectedRevision: number
    replacements: readonly AgentTeamMemberReplacementSpec[]
    idempotencyKey: string
  }) {
    if (!this.instanceCommands || !this.lifecycleOperations)
      throw new Error('Team lifecycle commands are unavailable.')
    const action = 'replace' as const
    const operationId = `${input.teamId}:${action}:${input.idempotencyKey}`
    const inputDigest = createHash('sha256')
      .update(canonicalPolicyJson({ action, ...input } as never))
      .digest('hex')
    const replay = this.lifecycleOperations.getReplay({ id: operationId, inputDigest })
    if (replay && replay.state.status !== 'running') return replay
    if (replay) throw new Error('Team lifecycle operation is already running.')

    const team = this.requireManager(input.teamId, input.actor)
    if (team.state.status !== 'active') throw new Error('Only an active Team can be replaced.')
    if (team.revision !== input.expectedRevision) throw new Error('Team revision conflict.')
    if (!team.state.members.length) throw new Error('Empty Team cannot be operated.')

    const currentMemberIds = team.state.members.map((member) => member.memberId)
    if (new Set(currentMemberIds).size !== currentMemberIds.length)
      throw new Error('Team memberIds must be unique for replacement.')
    const replacementIds = input.replacements.map((replacement) => replacement.memberId)
    if (
      new Set(replacementIds).size !== replacementIds.length ||
      replacementIds.length !== currentMemberIds.length ||
      replacementIds.some((memberId) => !currentMemberIds.includes(memberId))
    )
      throw new Error('Team replacements must exactly cover unique current memberIds.')

    const replacements = new Map(
      input.replacements.map((replacement) => [replacement.memberId, replacement])
    )
    const members = [...team.state.members]
      .sort(
        (a, b) =>
          a.memberId.localeCompare(b.memberId) || a.agentInstanceId.localeCompare(b.agentInstanceId)
      )
      .map((member) => {
        const agent = this.agents.get(member.agentInstanceId)
        if (!agent || agent.state.status === 'removed')
          throw new Error('Team member Agent instance not found.')
        const replacement = replacements.get(member.memberId)!
        if (
          !replacement.definitionId.trim() ||
          !replacement.name.trim() ||
          !replacement.configVersion.trim()
        )
          throw new Error('Team replacement specification is invalid.')
        const config = this.instanceCommands!.configStore?.get(replacement.configVersion)?.state
        if (!config) throw new Error('Replacement Agent config content is unavailable.')
        if (config.definitionId !== replacement.definitionId)
          throw new Error('Replacement Agent config definition does not match the replacement.')
        return {
          memberId: member.memberId,
          agentInstanceId: member.agentInstanceId,
          expectedRevision: agent.revision,
          replacement
        }
      })

    let operation = this.lifecycleOperations.begin({
      state: {
        id: operationId,
        teamId: team.id,
        teamRevision: team.revision,
        action,
        actor: input.actor,
        inputDigest,
        status: 'running',
        members,
        outcomes: [],
        startedAt: this.now()
      },
      idempotencyKey: 'begin'
    })
    for (const member of members) {
      let outcome
      try {
        await this.instanceCommands.replace({
          actor: input.actor,
          instanceId: member.agentInstanceId,
          expectedRevision: member.expectedRevision,
          definitionId: member.replacement.definitionId,
          name: member.replacement.name,
          configVersion: member.replacement.configVersion,
          replacedAt: member.replacement.replacedAt,
          idempotencyKey: `team:${operationId}:${member.memberId}`
        })
        outcome = {
          memberId: member.memberId,
          agentInstanceId: member.agentInstanceId,
          status: 'completed' as const
        }
      } catch (error) {
        outcome = {
          memberId: member.memberId,
          agentInstanceId: member.agentInstanceId,
          status: 'failed' as const,
          error: error instanceof Error ? error.message : String(error)
        }
      }
      operation = this.lifecycleOperations.recordOutcome({
        id: operation.id,
        expectedRevision: operation.revision,
        outcome,
        recordedAt: this.now(),
        idempotencyKey: `member:${member.memberId}`
      })
    }
    const succeeded = operation.state.outcomes.filter((item) => item.status === 'completed').length
    return this.lifecycleOperations.complete({
      id: operation.id,
      expectedRevision: operation.revision,
      status: succeeded === members.length ? 'completed' : succeeded === 0 ? 'failed' : 'partial',
      completedAt: this.now(),
      idempotencyKey: 'complete'
    })
  }

  private async runLifecycle(
    action: AgentTeamLifecycleAction,
    input: {
      actor: PolicyActorRef
      teamId: string
      expectedRevision: number
      request?: import('../../../shared/api/svcMagicAgentPlatform').MagicAgentPlatformRunReq
      idempotencyKey: string
    }
  ) {
    if (!this.instanceCommands || !this.lifecycleOperations)
      throw new Error('Team lifecycle commands are unavailable.')
    const operationId = `${input.teamId}:${action}:${input.idempotencyKey}`
    const inputDigest = createHash('sha256')
      .update(canonicalPolicyJson({ action, ...input } as never))
      .digest('hex')
    const replay = this.lifecycleOperations.getReplay({ id: operationId, inputDigest })
    if (replay && replay.state.status !== 'running') return replay
    if (replay) throw new Error('Team lifecycle operation is already running.')

    const team = this.requireManager(input.teamId, input.actor)
    if (team.state.status === 'removed') throw new Error('Removed Team cannot be operated.')
    if (team.revision !== input.expectedRevision) throw new Error('Team revision conflict.')
    if (!team.state.members.length) throw new Error('Empty Team cannot be operated.')
    if (action === 'start' && !input.request) throw new Error('Team start run request is required.')
    if (action !== 'start' && input.request)
      throw new Error(`Team ${action} does not accept a run request.`)

    const members = [...team.state.members]
      .sort(
        (a, b) =>
          a.memberId.localeCompare(b.memberId) || a.agentInstanceId.localeCompare(b.agentInstanceId)
      )
      .map((member) => ({
        memberId: member.memberId,
        agentInstanceId: member.agentInstanceId,
        expectedRevision: this.agents.get(member.agentInstanceId)?.revision ?? -1
      }))
    let operation = this.lifecycleOperations.begin({
      state: {
        id: operationId,
        teamId: team.id,
        teamRevision: team.revision,
        action,
        actor: input.actor,
        inputDigest,
        ...(input.request ? { request: input.request } : {}),
        status: 'running',
        members,
        outcomes: [],
        startedAt: this.now()
      },
      idempotencyKey: 'begin'
    })
    for (const member of members) {
      let outcome
      try {
        const command = {
          actor: input.actor,
          instanceId: member.agentInstanceId,
          expectedRevision: member.expectedRevision,
          idempotencyKey: `team:${operationId}:${member.memberId}`
        }
        if (action === 'start') {
          const agent = this.agents.get(member.agentInstanceId)
          if (!agent) throw new Error('Team member Agent instance not found.')
          await this.instanceCommands.start({
            ...command,
            request: { ...input.request!, agentId: agent.state.definitionId }
          })
        } else if (action === 'pause') await this.instanceCommands.pause(command)
        else if (action === 'resume') await this.instanceCommands.resume(command)
        else await this.instanceCommands.stop(command)
        outcome = {
          memberId: member.memberId,
          agentInstanceId: member.agentInstanceId,
          status: 'completed' as const
        }
      } catch (error) {
        outcome = {
          memberId: member.memberId,
          agentInstanceId: member.agentInstanceId,
          status: 'failed' as const,
          error: error instanceof Error ? error.message : String(error)
        }
      }
      operation = this.lifecycleOperations.recordOutcome({
        id: operation.id,
        expectedRevision: operation.revision,
        outcome,
        recordedAt: this.now(),
        idempotencyKey: `member:${member.memberId}`
      })
    }
    const succeeded = operation.state.outcomes.filter((item) => item.status === 'completed').length
    return this.lifecycleOperations.complete({
      id: operation.id,
      expectedRevision: operation.revision,
      status: succeeded === members.length ? 'completed' : succeeded === 0 ? 'failed' : 'partial',
      completedAt: this.now(),
      idempotencyKey: 'complete'
    })
  }

  start(input: {
    actor: PolicyActorRef
    teamId: string
    expectedRevision: number
    request: import('../../../shared/api/svcMagicAgentPlatform').MagicAgentPlatformRunReq
    idempotencyKey: string
  }) {
    return this.runLifecycle('start', input)
  }
  pause(input: {
    actor: PolicyActorRef
    teamId: string
    expectedRevision: number
    idempotencyKey: string
  }) {
    return this.runLifecycle('pause', input)
  }
  resume(input: {
    actor: PolicyActorRef
    teamId: string
    expectedRevision: number
    idempotencyKey: string
  }) {
    return this.runLifecycle('resume', input)
  }
  stop(input: {
    actor: PolicyActorRef
    teamId: string
    expectedRevision: number
    idempotencyKey: string
  }) {
    return this.runLifecycle('stop', input)
  }

  private requireManager(id: string, actor: PolicyActorRef) {
    const team = this.teams.get(id)
    if (!team) throw new Error('Team not found.')
    const agentAuthorized =
      actor.kind === 'agent' &&
      ((team.state.createdBy.kind === 'agent' && team.state.createdBy.id === actor.id) ||
        team.state.members.some(
          (member) => member.agentInstanceId === actor.id && member.role === 'leader'
        ))
    if (!(actor.kind === 'user' && actor.id === team.state.ownerId) && !agentAuthorized)
      throw new Error(
        'Only the Team owner, creating Agent, or leader Agent may administer the Team.'
      )
    return team
  }
  private authorize(input: {
    policy: PolicyRequest
    idempotencyKey: string
    grantId?: string
    expectedGrantUseCount?: number
  }) {
    const result = this.authorization.authorize({
      authorizationId: `agent-team-authorization:${digestPolicyRequest(input.policy)}`,
      request: input.policy,
      evaluatedAt: this.now(),
      ...(input.grantId ? { grantId: input.grantId } : {}),
      ...(input.expectedGrantUseCount === undefined
        ? {}
        : { expectedGrantUseCount: input.expectedGrantUseCount }),
      idempotencyKey: `agent-team:authorize:${input.idempotencyKey}`
    })
    if (result.status !== 'authorized') throw new Error(`Agent Team mutation ${result.status}.`)
    this.authorization.consumeExecutionPermit({
      permit: result.permit,
      request: input.policy,
      consumedAt: this.now(),
      idempotencyKey: `agent-team:consume:${input.idempotencyKey}`
    })
  }
}
