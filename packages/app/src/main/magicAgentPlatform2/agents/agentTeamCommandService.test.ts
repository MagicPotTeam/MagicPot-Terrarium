import { describe, expect, it, vi } from 'vitest'
import { MagicAgentEventStore } from '../persistence/eventStore'
import { PersistentAgentInstanceStore } from './persistentAgentInstanceStore'
import { PersistentAgentTeamStore } from './persistentAgentTeamStore'
import { PersistentAgentTeamLifecycleOperationStore } from './persistentAgentTeamLifecycleOperationStore'
import { AgentTeamCommandService } from './agentTeamCommandService'

const team = {
  id: 'team',
  name: 'Team',
  ownerId: '',
  status: 'active' as const,
  members: [],
  createdAt: 1,
  createdBy: { kind: 'user' as const, id: 'spoof' }
}
const setup = () => {
  const events = new MagicAgentEventStore(':memory:')
  const teams = new PersistentAgentTeamStore(events)
  const agents = new PersistentAgentInstanceStore(events)
  const authorization = {
    authorize: vi.fn(() => ({ status: 'authorized', permit: {} })),
    consumeExecutionPermit: vi.fn()
  }
  return {
    events,
    teams,
    agents,
    authorization,
    service: new AgentTeamCommandService(teams, agents, authorization as never, () => 10)
  }
}

describe('AgentTeamCommandService', () => {
  it('allows the creating or leader Agent to administer its Team and rejects other Agents', async () => {
    const { service, events } = setup()
    const inputTeam = { ...team, members: [] }
    const creator = { kind: 'agent' as const, id: 'agent-a' }
    const created = service.create({
      actor: creator,
      team: inputTeam,
      idempotencyKey: 'create-agent'
    })
    expect(created.state.createdBy).toEqual(creator)
    await expect(
      service.pause({
        actor: creator,
        teamId: team.id,
        expectedRevision: created.revision,
        idempotencyKey: 'pause'
      })
    ).rejects.toThrow(/unavailable/)
    expect(() =>
      service.remove({
        actor: { kind: 'agent', id: 'other' },
        teamId: team.id,
        expectedRevision: created.revision,
        removedAt: 2,
        idempotencyKey: 'other'
      })
    ).toThrow(/leader Agent/)
    events.close()
  })

  it('binds owner/creator and Policy-gates Team creation', () => {
    const { events, authorization, service } = setup()
    const actor = { kind: 'user' as const, id: 'owner' }
    const created = service.create({ actor, team, idempotencyKey: 'create' })
    expect(created.state).toMatchObject({ ownerId: 'owner', createdBy: actor, members: [] })
    expect(authorization.authorize).toHaveBeenCalledOnce()
    expect(authorization.consumeExecutionPermit).toHaveBeenCalledOnce()
    events.close()
  })

  it('exact-replays membership mutations before Policy and conflicts changed input', () => {
    const { events, agents, authorization, service } = setup()
    const owner = { kind: 'user' as const, id: 'owner' }
    const created = service.create({ actor: owner, team, idempotencyKey: 'create' })
    agents.create({
      instance: {
        id: 'agent',
        name: 'Agent',
        definitionId: 'definition',
        depth: 0,
        configVersion: 'v1',
        status: 'created',
        limits: {
          maxChildren: 1,
          maxDepth: 1,
          maxConcurrency: 1,
          maxRuntimeMs: 1,
          allowedToolNames: [],
          workspaceRoots: []
        }
      },
      createdAt: 2,
      idempotencyKey: 'agent'
    })
    const add = {
      actor: owner,
      teamId: team.id,
      expectedRevision: created.revision,
      member: {
        memberId: 'm',
        agentInstanceId: 'agent',
        role: 'member' as const,
        joinedAt: 3,
        addedBy: owner
      },
      idempotencyKey: 'add'
    }
    const added = service.addMember(add)
    authorization.authorize.mockClear()
    authorization.consumeExecutionPermit.mockClear()
    expect(service.addMember(add)).toEqual(added)
    expect(authorization.authorize).not.toHaveBeenCalled()
    expect(authorization.consumeExecutionPermit).not.toHaveBeenCalled()
    expect(() => service.addMember({ ...add, member: { ...add.member, role: 'leader' } })).toThrow(
      /conflict/
    )
    const remove = {
      actor: owner,
      teamId: team.id,
      expectedRevision: added.revision,
      memberId: 'm',
      removedAt: 4,
      idempotencyKey: 'remove'
    }
    const removed = service.removeMember(remove)
    authorization.authorize.mockClear()
    expect(service.removeMember(remove)).toEqual(removed)
    expect(authorization.authorize).not.toHaveBeenCalled()
    expect(() => service.removeMember({ ...remove, removedAt: 5 })).toThrow(/conflict/)
    events.close()
  })

  it('validates Agent existence and Team ownership before membership side effects', () => {
    const { events, agents, authorization, service } = setup()
    const owner = { kind: 'user' as const, id: 'owner' }
    const created = service.create({ actor: owner, team, idempotencyKey: 'create' })
    expect(() =>
      service.addMember({
        actor: owner,
        teamId: team.id,
        expectedRevision: created.revision,
        member: {
          memberId: 'm',
          agentInstanceId: 'missing',
          role: 'member',
          joinedAt: 2,
          addedBy: owner
        },
        idempotencyKey: 'missing'
      })
    ).toThrow(/not found/)
    expect(() =>
      service.addMember({
        actor: { kind: 'user', id: 'other' },
        teamId: team.id,
        expectedRevision: created.revision,
        member: {
          memberId: 'm',
          agentInstanceId: 'agent',
          role: 'member',
          joinedAt: 2,
          addedBy: owner
        },
        idempotencyKey: 'owner'
      })
    ).toThrow(/owner/)
    expect(authorization.authorize).toHaveBeenCalledTimes(1)
    agents.create({
      instance: {
        id: 'agent',
        name: 'Agent',
        definitionId: 'definition',
        depth: 0,
        configVersion: 'v1',
        status: 'created',
        limits: {
          maxChildren: 1,
          maxDepth: 1,
          maxConcurrency: 1,
          maxRuntimeMs: 1,
          allowedToolNames: [],
          workspaceRoots: []
        }
      },
      createdAt: 2,
      idempotencyKey: 'agent'
    })
    const added = service.addMember({
      actor: owner,
      teamId: team.id,
      expectedRevision: created.revision,
      member: {
        memberId: 'm',
        agentInstanceId: 'agent',
        role: 'leader',
        joinedAt: 3,
        addedBy: { kind: 'user', id: 'spoof' }
      },
      idempotencyKey: 'add'
    })
    expect(added.state.members[0]?.addedBy).toEqual(owner)
    expect(authorization.authorize).toHaveBeenCalledTimes(2)
    events.close()
  })

  it('fans out deterministically, continues failures, persists partial outcome, and exact-replays first', async () => {
    const { events, teams, agents, authorization } = setup()
    const owner = { kind: 'user' as const, id: 'owner' }
    const created = teams.create({
      team: { ...team, ownerId: owner.id, createdBy: owner },
      idempotencyKey: 'create'
    })
    const agentState = (id: string) => ({
      id,
      name: id,
      definitionId: id,
      depth: 0,
      configVersion: 'v1',
      status: 'created' as const,
      limits: {
        maxChildren: 1,
        maxDepth: 1,
        maxConcurrency: 1,
        maxRuntimeMs: 1,
        allowedToolNames: [],
        workspaceRoots: []
      }
    })
    agents.create({ instance: agentState('agent-z'), createdAt: 2, idempotencyKey: 'z' })
    agents.create({ instance: agentState('agent-a'), createdAt: 2, idempotencyKey: 'a' })
    let current = teams.addMember({
      teamId: team.id,
      expectedRevision: created.revision,
      member: {
        memberId: 'z',
        agentInstanceId: 'agent-z',
        role: 'member',
        joinedAt: 3,
        addedBy: owner
      },
      idempotencyKey: 'z'
    })
    current = teams.addMember({
      teamId: team.id,
      expectedRevision: current.revision,
      member: {
        memberId: 'a',
        agentInstanceId: 'agent-a',
        role: 'leader',
        joinedAt: 4,
        addedBy: owner
      },
      idempotencyKey: 'a'
    })
    const calls: string[] = []
    const commands = {
      pause: vi.fn(async ({ instanceId }: { instanceId: string }) => {
        calls.push(instanceId)
        if (instanceId === 'agent-a') throw new Error('policy denied')
      })
    }
    const operations = new PersistentAgentTeamLifecycleOperationStore(events)
    const service = new AgentTeamCommandService(
      teams,
      agents,
      authorization as never,
      () => 20,
      commands as never,
      operations
    )
    const input = {
      actor: owner,
      teamId: team.id,
      expectedRevision: current.revision,
      idempotencyKey: 'pause'
    }
    const result = await service.pause(input)
    expect(calls).toEqual(['agent-a', 'agent-z'])
    expect(result.state.status).toBe('partial')
    expect(result.state.outcomes.map((item) => item.status)).toEqual(['failed', 'completed'])
    commands.pause.mockClear()
    expect(await service.pause(input)).toEqual(result)
    expect(commands.pause).not.toHaveBeenCalled()
    await expect(
      service.pause({ ...input, expectedRevision: current.revision - 1 })
    ).rejects.toThrow(/conflict/)
    events.close()
  })

  it('replaces all members deterministically with durable mixed outcomes and unchanged references', async () => {
    const { events, teams, agents, authorization } = setup()
    const owner = { kind: 'user' as const, id: 'owner' }
    const created = teams.create({
      team: { ...team, ownerId: owner.id, createdBy: owner },
      idempotencyKey: 'rc'
    })
    const state = (id: string) => ({
      id,
      name: id,
      definitionId: `old-${id}`,
      depth: 0,
      configVersion: 'v1',
      status: 'created' as const,
      limits: {
        maxChildren: 1,
        maxDepth: 1,
        maxConcurrency: 1,
        maxRuntimeMs: 1,
        allowedToolNames: [],
        workspaceRoots: []
      }
    })
    agents.create({ instance: state('agent-z'), createdAt: 2, idempotencyKey: 'raz' })
    agents.create({ instance: state('agent-a'), createdAt: 2, idempotencyKey: 'raa' })
    let current = teams.addMember({
      teamId: team.id,
      expectedRevision: created.revision,
      member: {
        memberId: 'z',
        agentInstanceId: 'agent-z',
        role: 'member',
        joinedAt: 3,
        addedBy: owner
      },
      idempotencyKey: 'rmz'
    })
    current = teams.addMember({
      teamId: team.id,
      expectedRevision: current.revision,
      member: {
        memberId: 'a',
        agentInstanceId: 'agent-a',
        role: 'leader',
        joinedAt: 4,
        addedBy: owner
      },
      idempotencyKey: 'rma'
    })
    const before = teams.get(team.id)!
    const calls: { instanceId: string; actor: unknown; idempotencyKey: string }[] = []
    const commands = {
      configStore: {
        get: vi.fn((version: string) => ({ state: { definitionId: `new-${version}` } }))
      },
      replace: vi.fn(
        async (command: { instanceId: string; actor: unknown; idempotencyKey: string }) => {
          calls.push(command)
          if (command.instanceId === 'agent-z') throw new Error('replacement denied')
        }
      )
    }
    const operations = new PersistentAgentTeamLifecycleOperationStore(events)
    const service = new AgentTeamCommandService(
      teams,
      agents,
      authorization as never,
      () => 20,
      commands as never,
      operations
    )
    const input = {
      actor: owner,
      teamId: team.id,
      expectedRevision: current.revision,
      replacements: [
        { memberId: 'z', definitionId: 'new-z2', name: 'Z2', configVersion: 'z2', replacedAt: 12 },
        { memberId: 'a', definitionId: 'new-a2', name: 'A2', configVersion: 'a2', replacedAt: 11 }
      ],
      idempotencyKey: 'replace-all'
    }
    const result = await service.replace(input)
    expect(calls.map((call) => call.instanceId)).toEqual(['agent-a', 'agent-z'])
    expect(calls.every((call) => call.actor === owner)).toBe(true)
    expect(calls.map((call) => call.idempotencyKey)).toEqual([
      'team:team:replace:replace-all:a',
      'team:team:replace:replace-all:z'
    ])
    expect(result.state.status).toBe('partial')
    expect(result.state.members.map((member) => member.replacement)).toEqual([
      input.replacements[1],
      input.replacements[0]
    ])
    expect(teams.get(team.id)).toEqual(before)
    commands.replace.mockClear()
    expect(await service.replace(input)).toEqual(result)
    expect(commands.replace).not.toHaveBeenCalled()
    await expect(
      service.replace({
        ...input,
        replacements: [{ ...input.replacements[0], name: 'changed' }, input.replacements[1]]
      })
    ).rejects.toThrow(/conflict/)
    events.close()
  })

  it('prevalidates exact coverage, Agents, and immutable configs before effects', async () => {
    const { events, teams, agents, authorization } = setup()
    const owner = { kind: 'user' as const, id: 'owner' }
    const created = teams.create({
      team: { ...team, ownerId: owner.id, createdBy: owner },
      idempotencyKey: 'vc'
    })
    const current = teams.addMember({
      teamId: team.id,
      expectedRevision: created.revision,
      member: {
        memberId: 'member',
        agentInstanceId: 'missing',
        role: 'member',
        joinedAt: 2,
        addedBy: owner
      },
      idempotencyKey: 'vm'
    })
    const commands = { configStore: { get: vi.fn(() => undefined) }, replace: vi.fn() }
    const operations = new PersistentAgentTeamLifecycleOperationStore(events)
    const service = new AgentTeamCommandService(
      teams,
      agents,
      authorization as never,
      () => 20,
      commands as never,
      operations
    )
    const base = {
      actor: owner,
      teamId: team.id,
      expectedRevision: current.revision,
      replacements: [
        {
          memberId: 'member',
          definitionId: 'definition',
          name: 'Agent',
          configVersion: 'v2',
          replacedAt: 10
        }
      ],
      idempotencyKey: 'validation'
    }
    await expect(service.replace({ ...base, replacements: [] })).rejects.toThrow(/exactly cover/)
    await expect(service.replace(base)).rejects.toThrow(/not found/)
    expect(commands.replace).not.toHaveBeenCalled()
    expect(operations.get('team:replace:validation')).toBeUndefined()
    events.close()
  })
})
