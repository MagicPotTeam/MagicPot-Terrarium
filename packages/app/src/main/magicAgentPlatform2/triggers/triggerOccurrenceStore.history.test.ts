import { describe, expect, it } from 'vitest'
import { MagicAgentEventStore, type ResourceMutationInput } from '../persistence/eventStore'
import {
  MAGIC_AGENT_TRIGGER_OCCURRENCE_RESOURCE_KIND as KIND,
  TriggerOccurrenceConflictError,
  TriggerOccurrenceStore,
  type TriggerOccurrenceState,
  type TriggerOccurrenceStatus
} from './triggerOccurrenceStore'

const open = (path = ':memory:') => {
  const eventStore = new MagicAgentEventStore(path)
  return { eventStore, store: new TriggerOccurrenceStore(eventStore) }
}
// The store's own enqueue event shape (it carries resource and revision beside the envelope).
const enqueuedEvent = (id: string, state: TriggerOccurrenceState) => {
  const event = {
    protocolVersion: '2.0.0',
    id: `${id}:occurrence.enqueued:0`,
    type: 'occurrence.enqueued',
    createdAt: state.requestedAt,
    payload: state,
    envelopeKind: 'event' as const,
    streamId: `${KIND}:${id}`,
    sequence: 0,
    resource: { kind: KIND, id },
    revision: 0
  }
  return event
}
// Terminal records an older build left behind: same shape as complete()/fail() write, all
// older than anything the test enqueues afterwards (updatedAt `from + index`).
const seedTerminal = (
  eventStore: MagicAgentEventStore,
  count: number,
  { from = 1, status = 'completed' as TriggerOccurrenceStatus, prefix = 'old' } = {}
) => {
  for (let start = 0; start < count; start += 1000) {
    const batch: ResourceMutationInput[] = []
    for (let index = start; index < Math.min(count, start + 1000); index += 1) {
      const id = `${prefix}-${index}`
      const at = from + index
      const state: TriggerOccurrenceState = {
        schemaVersion: 1,
        occurrenceId: id,
        triggerId: 'trigger-1',
        source: 'cron',
        scheduledAt: at,
        requestedAt: at,
        status,
        attempt: 1,
        idempotencyKey: id,
        semanticDigest: `sha256:${'0'.repeat(64)}`,
        createdAt: at,
        updatedAt: at
      }
      batch.push({
        operation: 'create',
        kind: KIND,
        id,
        idempotencyKey: id,
        state,
        createdAt: at,
        event: enqueuedEvent(id, state)
      })
    }
    eventStore.mutateResourcesBatch(batch)
  }
}
const enqueue = (
  store: TriggerOccurrenceStore,
  occurrenceId: string,
  at: number,
  patch: Partial<Parameters<TriggerOccurrenceStore['enqueueManual']>[0]> = {}
) =>
  store.enqueueManual({
    occurrenceId,
    triggerId: 'trigger-1',
    scheduledAt: at,
    requestedAt: at,
    idempotencyKey: occurrenceId,
    ...patch
  })
const permit = { authorizationId: 'trigger-authorization:sha256:a', requestDigest: 'sha256:a' }

describe('TriggerOccurrenceStore beyond 1000 records', () => {
  it('claims a due occurrence enqueued after thousands of terminal records, in schedule order', () => {
    const { eventStore, store } = open()
    try {
      // Oldest of all, due later: it is on the first page but must not win.
      enqueue(store, 'old-pending', 0, { scheduledAt: 9_000 })
      seedTerminal(eventStore, 2_500)
      enqueue(store, 'fresh', 5_000)
      expect(store.claimNext(5_000, 'worker', 10)?.id).toBe('fresh')
      expect(store.claimNext(5_000, 'worker', 10)).toBeUndefined()
      store.complete('fresh', 'worker', 5_001)
      expect(store.claimNext(9_000, 'worker', 10)?.id).toBe('old-pending')
    } finally {
      eventStore.close()
    }
  })

  it('sweeps expired marked and out-of-attempts claims that sit beyond the first 1000 records', () => {
    const { eventStore, store } = open()
    try {
      enqueue(store, 'marked', 5_000)
      store.claimNext(5_000, 'first', 10)
      store.markPermit('marked', 'first', 5_001, permit)
      enqueue(store, 'spent', 5_002)
      store.claimNext(5_002, 'second', 10, 1)
      // Older records written afterwards push both out of an oldest-first 1000 window.
      seedTerminal(eventStore, 2_500)
      expect(store.claimNext(6_000, 'sweeper', 10, 1)).toBeUndefined()
      expect(store.get('marked')?.state).toMatchObject({
        status: 'unknown',
        permit: { attempt: 1 }
      })
      expect(store.get('spent')?.state.status).toBe('dead-letter')
    } finally {
      eventStore.close()
    }
  })

  it('refuses a reused idempotency key whose record is beyond the first 1000 records', () => {
    const { eventStore, store } = open()
    try {
      seedTerminal(eventStore, 1_200)
      enqueue(store, 'x', 5_000, { idempotencyKey: 'shared-key' })
      expect(() => enqueue(store, 'y', 5_001, { idempotencyKey: 'shared-key' })).toThrow(
        TriggerOccurrenceConflictError
      )
      expect(store.get('y')).toBeUndefined()
    } finally {
      eventStore.close()
    }
  })
})
