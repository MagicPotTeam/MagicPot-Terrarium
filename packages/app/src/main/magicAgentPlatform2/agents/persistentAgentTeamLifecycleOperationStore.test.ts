import { describe, expect, it } from 'vitest'
import { MagicAgentEventStore } from '../persistence/eventStore'
import { PersistentAgentTeamLifecycleOperationStore } from './persistentAgentTeamLifecycleOperationStore'

const state = {
  id: 'op',
  teamId: 'team',
  teamRevision: 2,
  action: 'pause' as const,
  actor: { kind: 'user' as const, id: 'owner' },
  inputDigest: 'digest',
  status: 'running' as const,
  members: [
    { memberId: 'a', agentInstanceId: 'agent-a', expectedRevision: 1 },
    { memberId: 'b', agentInstanceId: 'agent-b', expectedRevision: 2 }
  ],
  outcomes: [],
  startedAt: 10
}

describe('PersistentAgentTeamLifecycleOperationStore', () => {
  it('fails closed and durably completes unfinished running operations after restart', () => {
    const events = new MagicAgentEventStore(':memory:')
    const store = new PersistentAgentTeamLifecycleOperationStore(events)
    let operation = store.begin({ state, idempotencyKey: 'begin' })
    operation = store.recordOutcome({
      id: operation.id,
      expectedRevision: operation.revision,
      outcome: { memberId: 'a', agentInstanceId: 'agent-a', status: 'completed' },
      recordedAt: 2,
      idempotencyKey: 'a'
    })
    const recovered = store.recoverInterrupted({ id: operation.id, recoveredAt: 3 })
    expect(recovered.state.status).toBe('partial')
    expect(recovered.state.outcomes[1]).toEqual({
      memberId: 'b',
      agentInstanceId: 'agent-b',
      status: 'failed',
      error: 'Team lifecycle operation interrupted by process restart.'
    })
    expect(store.recoverInterrupted({ id: operation.id, recoveredAt: 4 })).toEqual(recovered)
    events.close()
  })

  it('durably records ordered outcomes/final status and exact-replays input', () => {
    const events = new MagicAgentEventStore(':memory:')
    const store = new PersistentAgentTeamLifecycleOperationStore(events)
    let operation = store.begin({ state, idempotencyKey: 'begin' })
    operation = store.recordOutcome({
      id: operation.id,
      expectedRevision: operation.revision,
      outcome: { memberId: 'a', agentInstanceId: 'agent-a', status: 'completed' },
      recordedAt: 11,
      idempotencyKey: 'a'
    })
    operation = store.recordOutcome({
      id: operation.id,
      expectedRevision: operation.revision,
      outcome: { memberId: 'b', agentInstanceId: 'agent-b', status: 'failed', error: 'denied' },
      recordedAt: 12,
      idempotencyKey: 'b'
    })
    operation = store.complete({
      id: operation.id,
      expectedRevision: operation.revision,
      status: 'partial',
      completedAt: 13,
      idempotencyKey: 'complete'
    })
    expect(operation.state).toMatchObject({ status: 'partial', completedAt: 13 })
    expect(operation.state.outcomes.map((item) => item.memberId)).toEqual(['a', 'b'])
    expect(store.getReplay({ id: 'op', inputDigest: 'digest' })).toEqual(operation)
    expect(() => store.getReplay({ id: 'op', inputDigest: 'changed' })).toThrow(/conflict/)
    expect(
      events
        .listResourceMutations('magic-agent-team-lifecycle-operation', 'op', 100)
        .map((item) => item.eventId)
    ).toEqual([
      'agent-team-lifecycle:op:begin:event',
      'agent-team-lifecycle:op:a:event',
      'agent-team-lifecycle:op:b:event',
      'agent-team-lifecycle:op:complete:event'
    ])
    events.close()
  })
})
