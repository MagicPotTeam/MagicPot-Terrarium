import { describe, expect, it } from 'vitest'
import { MagicAgentEventStore } from '../persistence/eventStore'
import { PersistentAgentTeamStore } from './persistentAgentTeamStore'

const team = {
  id: 'team',
  name: 'Team',
  ownerId: 'owner',
  status: 'active' as const,
  members: [],
  createdAt: 1,
  createdBy: { kind: 'user' as const, id: 'owner' }
}

describe('PersistentAgentTeamStore', () => {
  it('creates a first-class Team and exact-replays', () => {
    const events = new MagicAgentEventStore(':memory:')
    const store = new PersistentAgentTeamStore(events)
    const created = store.create({ team, idempotencyKey: 'create' })
    expect(store.create({ team, idempotencyKey: 'create' })).toEqual(created)
    expect(store.list()).toHaveLength(1)
    events.close()
  })

  it('requires an empty Team and exact-replays removal', () => {
    const events = new MagicAgentEventStore(':memory:')
    const store = new PersistentAgentTeamStore(events)
    const created = store.create({ team, idempotencyKey: 'create' })
    const removed = store.remove({
      teamId: team.id,
      expectedRevision: created.revision,
      removedAt: 2,
      idempotencyKey: 'remove'
    })
    expect(removed.state.status).toBe('removed')
    expect(
      store.remove({
        teamId: team.id,
        expectedRevision: created.revision,
        removedAt: 2,
        idempotencyKey: 'remove'
      })
    ).toEqual(removed)
    expect(() =>
      store.remove({
        teamId: team.id,
        expectedRevision: created.revision,
        removedAt: 3,
        idempotencyKey: 'remove'
      })
    ).toThrow(/conflict/)
    events.close()
  })

  it('adds/removes members with revision and leader fencing', () => {
    const events = new MagicAgentEventStore(':memory:')
    const store = new PersistentAgentTeamStore(events)
    const created = store.create({ team, idempotencyKey: 'create' })
    const member = {
      memberId: 'leader',
      agentInstanceId: 'agent-1',
      role: 'leader' as const,
      joinedAt: 2,
      addedBy: { kind: 'user' as const, id: 'owner' }
    }
    const added = store.addMember({
      teamId: team.id,
      expectedRevision: created.revision,
      member,
      idempotencyKey: 'add'
    })
    expect(added.state.members).toEqual([member])
    expect(() =>
      store.addMember({
        teamId: team.id,
        expectedRevision: added.revision,
        member: { ...member, memberId: 'leader-2', agentInstanceId: 'agent-2' },
        idempotencyKey: 'second-leader'
      })
    ).toThrow(/leader/)
    const removed = store.removeMember({
      teamId: team.id,
      expectedRevision: added.revision,
      memberId: member.memberId,
      removedAt: 3,
      idempotencyKey: 'remove'
    })
    expect(removed.state.members).toEqual([])
    events.close()
  })

  it('rejects revision conflicts and duplicate Agent membership', () => {
    const events = new MagicAgentEventStore(':memory:')
    const store = new PersistentAgentTeamStore(events)
    const created = store.create({ team, idempotencyKey: 'create' })
    const member = {
      memberId: 'member',
      agentInstanceId: 'agent',
      role: 'member' as const,
      joinedAt: 2,
      addedBy: { kind: 'user' as const, id: 'owner' }
    }
    const added = store.addMember({
      teamId: team.id,
      expectedRevision: created.revision,
      member,
      idempotencyKey: 'add'
    })
    expect(() =>
      store.removeMember({
        teamId: team.id,
        expectedRevision: created.revision,
        memberId: member.memberId,
        removedAt: 3,
        idempotencyKey: 'stale'
      })
    ).toThrow(/revision/)
    expect(() =>
      store.addMember({
        teamId: team.id,
        expectedRevision: added.revision,
        member: { ...member, memberId: 'other' },
        idempotencyKey: 'duplicate'
      })
    ).toThrow(/already exists/)
    events.close()
  })
})
