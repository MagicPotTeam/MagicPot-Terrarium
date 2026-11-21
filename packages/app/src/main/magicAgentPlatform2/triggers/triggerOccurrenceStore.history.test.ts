import { afterEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MagicAgentEventStore,
  ResourceRevisionConflictError,
  type ResourceMutationInput
} from '../persistence/eventStore'
import { TriggerOccurrenceScheduler } from './triggerOccurrenceScheduler'
import {
  MAGIC_AGENT_TRIGGER_OCCURRENCE_RESOURCE_KIND as KIND,
  TRIGGER_OCCURRENCE_ARCHIVE_ABOVE,
  TRIGGER_OCCURRENCE_ARCHIVE_BATCH,
  TRIGGER_OCCURRENCE_ARCHIVE_DOWN_TO,
  TriggerOccurrenceConflictError,
  TriggerOccurrenceStore,
  type TriggerOccurrenceState,
  type TriggerOccurrenceStatus
} from './triggerOccurrenceStore'

const roots: string[] = []
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.length = 0
})
const open = (path = ':memory:') => {
  const eventStore = new MagicAgentEventStore(path)
  return { eventStore, store: new TriggerOccurrenceStore(eventStore) }
}
const fileBacked = () => {
  const root = mkdtempSync(join(tmpdir(), 'trigger-occurrence-archive-'))
  roots.push(root)
  return join(root, 'events.db')
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
// Terminal records an older build left behind: same shape as complete()/fail() write, never
// archived, all older than anything the test enqueues afterwards (updatedAt `from + index`).
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
const unarchived = (eventStore: MagicAgentEventStore) => eventStore.countResources({ kind: KIND })
const drain = (store: TriggerOccurrenceStore, now: number) => {
  let total = 0
  for (;;) {
    const archived = store.archiveTerminal(now)
    total += archived
    if (archived < TRIGGER_OCCURRENCE_ARCHIVE_BATCH) return total
  }
}
// Rows the store decoded through listResources, the only bulk read it makes.
const countRowsRead = (eventStore: MagicAgentEventStore) => {
  const counter = { rows: 0 }
  const listResources = eventStore.listResources.bind(eventStore)
  vi.spyOn(eventStore, 'listResources').mockImplementation((options) => {
    const page = listResources(options)
    counter.rows += page.length
    return page
  })
  return counter
}
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

describe('TriggerOccurrenceStore archiving', () => {
  it('archives only the oldest terminal records, down to the retained tail', () => {
    const { eventStore, store } = open()
    try {
      enqueue(store, 'old-pending', 0, { scheduledAt: 99_999 })
      seedTerminal(eventStore, 150, { status: 'completed' })
      seedTerminal(eventStore, 50, { from: 200, status: 'dead-letter', prefix: 'dead' })
      seedTerminal(eventStore, 50, { from: 300, status: 'unknown', prefix: 'unknown' })
      seedTerminal(eventStore, 20, { from: 400, status: 'failed', prefix: 'failed' })
      enqueue(store, 'live', 1_000)
      expect(unarchived(eventStore)).toBe(272)
      const archived = drain(store, 2_000)
      const left = unarchived(eventStore)
      expect(archived).toBe(272 - left)
      expect(left).toBeGreaterThanOrEqual(TRIGGER_OCCURRENCE_ARCHIVE_DOWN_TO)
      expect(left).toBeLessThanOrEqual(TRIGGER_OCCURRENCE_ARCHIVE_ABOVE)
      // Non-terminal records are never archived, however old.
      for (const id of ['old-pending', 'live', 'failed-0', 'failed-19'])
        expect(store.get(id)?.deleted).toBe(false)
      // Terminal records go oldest first: the archived ones are a prefix by update time.
      const terminal = [
        ...Array.from({ length: 150 }, (_, index) => `old-${index}`),
        ...Array.from({ length: 50 }, (_, index) => `dead-${index}`),
        ...Array.from({ length: 50 }, (_, index) => `unknown-${index}`)
      ].map((id) => store.get(id)!)
      expect(terminal.filter((item) => item.deleted)).toHaveLength(archived)
      expect(terminal.slice(0, archived).every((item) => item.deleted)).toBe(true)
      expect(terminal.slice(archived).some((item) => item.deleted)).toBe(false)
      // Archiving keeps the final state.
      expect(new Set(terminal.map((item) => item.state.status))).toEqual(
        new Set(['completed', 'dead-letter', 'unknown'])
      )
      expect(store.list().every((item) => !item.deleted)).toBe(true)
      expect(store.list()).toHaveLength(left)
      // Below the high-water mark nothing more is archived.
      expect(store.archiveTerminal(3_000)).toBe(0)
    } finally {
      eventStore.close()
    }
  })

  it('keeps dedup, idempotency keys and history of archived records, across a restart', () => {
    const path = fileBacked()
    let { eventStore, store } = open(path)
    enqueue(store, 'done', 10)
    store.claimNext(10, 'worker', 100)
    const completed = store.complete('done', 'worker', 11)
    seedTerminal(eventStore, 300, { from: 20 })
    drain(store, 12)
    const archived = store.get('done')
    expect(archived).toMatchObject({ deleted: true, revision: completed.revision + 1 })
    expect(archived?.state).toEqual(completed.state)
    const history = eventStore.listResourceMutations(KIND, 'done', 100)
    expect(history.map((item) => item.operation)).toEqual(['create', 'update', 'update', 'delete'])
    eventStore.close()
    ;({ eventStore, store } = open(path))
    try {
      expect(store.get('done')).toEqual(archived)
      // Same occurrence again: the archived record is the answer, nothing new is written.
      expect(enqueue(store, 'done', 10)).toEqual(archived)
      expect(() => enqueue(store, 'done', 10, { scheduledAt: 11 })).toThrow(
        TriggerOccurrenceConflictError
      )
      expect(() => enqueue(store, 'other', 10, { idempotencyKey: 'done' })).toThrow(
        TriggerOccurrenceConflictError
      )
      expect(store.claimNext(1_000_000, 'worker', 100)).toBeUndefined()
      expect(eventStore.listResourceMutations(KIND, 'done', 100)).toEqual(history)
      expect(store.get('other')).toBeUndefined()
    } finally {
      eventStore.close()
    }
  })

  it('leaves an older build no way to duplicate an archived occurrence', () => {
    const { eventStore, store } = open()
    try {
      enqueue(store, 'done', 10)
      store.claimNext(10, 'worker', 100)
      store.complete('done', 'worker', 11)
      seedTerminal(eventStore, 300, { from: 20 })
      drain(store, 12)
      // An older build reads without archived records and so re-sends the original create.
      expect(eventStore.getResource(KIND, 'done')).toBeUndefined()
      const [created] = eventStore.listResourceMutations(KIND, 'done', 1)
      const state = created!.resource.state as TriggerOccurrenceState
      const create = (idempotencyKey: string): ResourceMutationInput => ({
        operation: 'create',
        kind: KIND,
        id: 'done',
        idempotencyKey,
        state,
        createdAt: state.requestedAt,
        event: enqueuedEvent('done', state)
      })
      expect(eventStore.mutateResource(create('done')).inserted).toBe(false)
      expect(() => eventStore.mutateResource(create('done-again'))).toThrow(
        ResourceRevisionConflictError
      )
      expect(store.get('done')?.state.status).toBe('completed')
    } finally {
      eventStore.close()
    }
  })

  it('archives despite a clock behind the records and retries after a lost race', () => {
    const { eventStore, store } = open()
    try {
      seedTerminal(eventStore, 200, { from: 10_000 })
      const batch = vi.spyOn(eventStore, 'mutateResourcesBatch').mockImplementationOnce(() => {
        throw new ResourceRevisionConflictError(KIND, 'old-0')
      })
      expect(store.archiveTerminal(5)).toBe(0)
      expect(unarchived(eventStore)).toBe(200)
      batch.mockRestore()
      expect(drain(store, 5)).toBe(TRIGGER_OCCURRENCE_ARCHIVE_BATCH)
      expect(store.get('old-0')).toMatchObject({ deleted: true, updatedAt: 10_000 })
      expect(store.get('old-0')?.state.status).toBe('completed')
    } finally {
      eventStore.close()
    }
  })
})

describe('TriggerOccurrenceScheduler with a long history', () => {
  const schedulerFor = (store: TriggerOccurrenceStore, clock: { now: number }) => {
    const executed: string[] = []
    const scheduler = new TriggerOccurrenceScheduler({
      occurrences: store,
      triggers: {
        get: () => ({ id: 'trigger-1', revision: 0, state: { enabled: true } })
      } as never,
      execute: async (_trigger, occurrence) => {
        executed.push(occurrence.occurrenceId)
      },
      now: () => clock.now
    })
    return { scheduler, executed }
  }

  it('drains a backlog once, then reads a bounded number of records per poll', async () => {
    const { eventStore, store } = open()
    try {
      seedTerminal(eventStore, 3_000)
      enqueue(store, 'fresh', 5_000)
      const clock = { now: 5_000 }
      const { scheduler, executed } = schedulerFor(store, clock)
      const reads = countRowsRead(eventStore)
      await expect(scheduler.runOnce()).resolves.toBe(true)
      expect(executed).toEqual(['fresh'])
      expect(store.get('fresh')?.state.status).toBe('completed')
      // The drain reads each archived record about once, not the history once per chunk.
      expect(reads.rows).toBeLessThanOrEqual(3_000 + 2 * TRIGGER_OCCURRENCE_ARCHIVE_ABOVE)
      expect(unarchived(eventStore)).toBeLessThanOrEqual(TRIGGER_OCCURRENCE_ARCHIVE_ABOVE)
      for (let poll = 0; poll < 3; poll += 1) {
        clock.now += 1_000
        enqueue(store, `next-${poll}`, clock.now)
        reads.rows = 0
        await expect(scheduler.runOnce()).resolves.toBe(true)
        expect(reads.rows).toBeLessThanOrEqual(TRIGGER_OCCURRENCE_ARCHIVE_ABOVE + 1)
      }
      expect(executed).toEqual(['fresh', 'next-0', 'next-1', 'next-2'])
    } finally {
      eventStore.close()
    }
  })

  it('keeps the live index bounded under a steady stream and runs each occurrence once', async () => {
    const { eventStore, store } = open()
    try {
      const clock = { now: 1_000 }
      const { scheduler, executed } = schedulerFor(store, clock)
      // Well past the retained tail, so the bound below only holds if archiving keeps up.
      const count = 400
      for (let index = 0; index < count; index += 1) {
        clock.now += 1_000
        enqueue(store, `tick-${index}`, clock.now)
        await expect(scheduler.runOnce()).resolves.toBe(true)
        expect(unarchived(eventStore)).toBeLessThanOrEqual(Math.min(200, index + 1))
      }
      expect(unarchived(eventStore)).toBeLessThanOrEqual(TRIGGER_OCCURRENCE_ARCHIVE_ABOVE)
      expect(executed).toEqual(Array.from({ length: count }, (_, index) => `tick-${index}`))
      for (let index = 0; index < count; index += 1)
        expect(store.get(`tick-${index}`)?.state.status).toBe('completed')
    } finally {
      eventStore.close()
    }
  })

  it('stops a backlog drain at stop() without claiming', async () => {
    const { eventStore, store } = open()
    try {
      seedTerminal(eventStore, 1_000)
      enqueue(store, 'fresh', 5_000)
      const { scheduler, executed } = schedulerFor(store, { now: 5_000 })
      const run = scheduler.runOnce()
      const stopped = scheduler.stop()
      await expect(run).resolves.toBe(false)
      await stopped
      expect(executed).toEqual([])
      expect(unarchived(eventStore)).toBe(1_001 - TRIGGER_OCCURRENCE_ARCHIVE_BATCH)
      expect(store.get('fresh')?.state.status).toBe('pending')
    } finally {
      eventStore.close()
    }
  })

  it('still claims when archiving fails, and logs only the error name', async () => {
    const { eventStore, store } = open()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      enqueue(store, 'fresh', 5_000)
      const failure = new Error('/home/user/private/events.db: record text')
      failure.name = 'SqliteError'
      vi.spyOn(store, 'archiveTerminal').mockImplementation(() => {
        throw failure
      })
      const clock = { now: 5_000 }
      const { scheduler, executed } = schedulerFor(store, clock)
      await expect(scheduler.runOnce()).resolves.toBe(true)
      clock.now += 1_000
      await expect(scheduler.runOnce()).resolves.toBe(false)
      expect(executed).toEqual(['fresh'])
      expect(warn.mock.calls).toEqual([['[triggers] Occurrence archive failed: SqliteError']])
    } finally {
      warn.mockRestore()
      eventStore.close()
    }
  })
})
