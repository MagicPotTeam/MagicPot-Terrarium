import { describe, expect, it, vi } from 'vitest'
import { MagicAgentEventStore, type ResourceMutationInput } from '../persistence/eventStore'
import { TriggerOccurrenceScheduler } from './triggerOccurrenceScheduler'
import {
  MAGIC_AGENT_TRIGGER_OCCURRENCE_RESOURCE_KIND as KIND,
  TRIGGER_OCCURRENCE_ARCHIVE_ABOVE,
  TRIGGER_OCCURRENCE_STALE_AFTER_MS,
  TriggerOccurrenceStore,
  type TriggerOccurrenceState,
  type TriggerOccurrenceStatus
} from './triggerOccurrenceStore'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

// Records as an older build wrote them, one per `step` ms from `from` (a cron firing per minute).
const seed = (
  eventStore: MagicAgentEventStore,
  count: number,
  {
    from,
    status,
    prefix,
    triggerId = 'trigger-1',
    step = MINUTE,
    scheduledAt
  }: {
    from: number
    status: TriggerOccurrenceStatus
    prefix: string
    triggerId?: string
    step?: number
    scheduledAt?: number
  }
) => {
  for (let start = 0; start < count; start += 1000) {
    const batch: ResourceMutationInput[] = []
    for (let index = start; index < Math.min(count, start + 1000); index += 1) {
      const id = `${prefix}-${String(index).padStart(6, '0')}`
      const at = from + index * step
      const state: TriggerOccurrenceState = {
        schemaVersion: 1,
        occurrenceId: id,
        triggerId,
        source: 'cron',
        scheduledAt: scheduledAt ?? at,
        requestedAt: at,
        status,
        attempt: status === 'pending' ? 0 : 3,
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
        event: {
          protocolVersion: '2.0.0',
          id: `${id}:occurrence.enqueued:0`,
          type: 'occurrence.enqueued',
          createdAt: at,
          payload: state,
          envelopeKind: 'event',
          streamId: `${KIND}:${id}`,
          sequence: 0,
          resource: { kind: KIND, id },
          revision: 0
        } as never
      })
    }
    eventStore.mutateResourcesBatch(batch)
  }
}
const live = (eventStore: MagicAgentEventStore) => eventStore.countResources({ kind: KIND })
// Rows decoded through listResources, the only bulk read the store makes.
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
type TriggerConfig = Readonly<{ enabled?: boolean; maxCatchUpRuns?: number }>
// The production executor denies an occurrence without a trigger permit; it throws the same way.
const harness = (eventStore: MagicAgentEventStore, triggers: Record<string, TriggerConfig>) => {
  const store = new TriggerOccurrenceStore(eventStore)
  const clock = { now: 0 }
  const executed: string[] = []
  const scheduler = new TriggerOccurrenceScheduler({
    occurrences: store,
    triggers: {
      get: (id: string) => {
        const trigger = triggers[id]
        if (!trigger) return undefined
        const config =
          trigger.maxCatchUpRuns === undefined ? {} : { maxCatchUpRuns: trigger.maxCatchUpRuns }
        return { id, revision: 0, state: { id, enabled: trigger.enabled ?? true, config } }
      }
    } as never,
    execute: async (_trigger, occurrence) => {
      executed.push(occurrence.occurrenceId)
      throw new Error('denied')
    },
    now: () => clock.now
  })
  return { store, clock, executed, scheduler }
}
const fresh = (store: TriggerOccurrenceStore, at: number, triggerId = 'trigger-1') =>
  store.enqueue({
    occurrenceId: `cron:${at}:${triggerId}`,
    triggerId,
    source: 'cron',
    scheduledAt: at,
    requestedAt: at,
    idempotencyKey: `cron:${at}:${triggerId}`
  })

describe('TriggerOccurrenceScheduler after an upgrade with a stranded backlog', () => {
  // On an older build, once about 1000 records existed every later occurrence stayed pending for
  // good while cron kept enqueueing one per minute. An upgraded store holds those 1000 terminal
  // records plus a week of stranded, due, never-claimed occurrences.
  it('claims a fresh occurrence at once, keeps every poll bounded and replays one stale instant', async () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    try {
      const stranded = 10_000
      seed(eventStore, 1_000, { from: 1_000_000, status: 'dead-letter', prefix: 'done' })
      seed(eventStore, stranded, { from: 1_000_000_000, status: 'pending', prefix: 'stranded' })
      const { store, clock, executed, scheduler } = harness(eventStore, { 'trigger-1': {} })
      clock.now = 1_000_000_000 + stranded * MINUTE + DAY
      const first = fresh(store, clock.now)
      const reads = countRowsRead(eventStore)
      const polls: { rows: number; ms: number }[] = []
      let freshPoll: number | undefined
      while (live(eventStore) > TRIGGER_OCCURRENCE_ARCHIVE_ABOVE && polls.length < 300) {
        reads.rows = 0
        const started = process.cpuUsage()
        await scheduler.runOnce()
        const used = process.cpuUsage(started)
        polls.push({ rows: reads.rows, ms: (used.user + used.system) / 1000 })
        // Fail fast: one poll over the whole backlog is the defect.
        expect(polls.at(-1)!.rows).toBeLessThanOrEqual(600)
        if (freshPoll === undefined && executed.includes(first.id)) freshPoll = polls.length
        clock.now += 1_000
      }
      expect(freshPoll).toBeDefined()
      expect(freshPoll!).toBeLessThanOrEqual(2)
      // Bounded chunks: 1000 archives and 10k dead-letters at 100 writes a poll, in about 210
      // polls, none long. Before, every poll read the backlog twice: ~500 ms, 21k rows.
      expect(polls.length).toBeLessThanOrEqual(250)
      expect(Math.max(...polls.map((poll) => poll.ms))).toBeLessThan(250)
      // Draining done, later polls see only the small live set.
      for (let poll = 0; poll < 20; poll += 1) {
        reads.rows = 0
        await scheduler.runOnce()
        expect(reads.rows).toBeLessThanOrEqual(TRIGGER_OCCURRENCE_ARCHIVE_ABOVE + 2)
        clock.now += 1_000
      }
      // maxCatchUpRuns defaults to 1: of a week of missed instants only the newest runs.
      const replayed = new Set(executed.filter((id) => id.startsWith('stranded-')))
      expect([...replayed]).toEqual([`stranded-${String(stranded - 1).padStart(6, '0')}`])
      const oldest = store.get('stranded-000000')
      expect(oldest).toMatchObject({ deleted: true })
      expect(oldest?.state).toMatchObject({
        status: 'dead-letter',
        attempt: 0,
        lastError: { name: 'TriggerOccurrenceStale' }
      })
      expect(live(eventStore)).toBeLessThanOrEqual(TRIGGER_OCCURRENCE_ARCHIVE_ABOVE)
    } finally {
      eventStore.close()
    }
  }, 120_000)

  it('keeps the newest maxCatchUpRuns stale occurrences per trigger and never runs a disabled one', async () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    try {
      seed(eventStore, 900, { from: 1_000_000, status: 'pending', prefix: 'a', triggerId: 'a' })
      seed(eventStore, 900, { from: 1_000_030, status: 'pending', prefix: 'b', triggerId: 'b' })
      seed(eventStore, 900, { from: 1_000_045, status: 'pending', prefix: 'off', triggerId: 'off' })
      const { store, clock, executed, scheduler } = harness(eventStore, {
        a: { maxCatchUpRuns: 3 },
        b: {},
        off: { enabled: false, maxCatchUpRuns: 2 }
      })
      clock.now = 1_000_000 + 900 * MINUTE + DAY
      for (let poll = 0; poll < 120; poll += 1) {
        await scheduler.runOnce()
        clock.now += 10_000
      }
      const ran = (prefix: string) =>
        [...new Set(executed.filter((id) => id.startsWith(`${prefix}-`)))].sort()
      expect(ran('a')).toEqual(['a-000897', 'a-000898', 'a-000899'])
      expect(ran('b')).toEqual(['b-000899'])
      expect(ran('off')).toEqual([])
      expect(store.get('off-000898')?.state.status).toBe('pending')
      expect(store.get('off-000899')?.state.status).toBe('pending')
      expect(store.get('off-000897')?.state).toMatchObject({
        status: 'dead-letter',
        lastError: { name: 'TriggerOccurrenceStale' }
      })
      expect(live(eventStore)).toBeLessThanOrEqual(TRIGGER_OCCURRENCE_ARCHIVE_ABOVE)
    } finally {
      eventStore.close()
    }
  }, 60_000)
})

describe('TriggerOccurrenceStore stale occurrences', () => {
  const poll = (store: TriggerOccurrenceStore, now: number, eligible = () => false) =>
    store.poll({ now, owner: `poll-${now}`, leaseMs: 30_000, eligible })
  const later = 1_000_000 + DAY

  it('touches only never-claimed pending records due longer than the horizon', () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    const store = new TriggerOccurrenceStore(eventStore)
    try {
      seed(eventStore, 3, { from: 1_000_000, status: 'pending', prefix: 'stale' })
      // The same trigger: one record not yet due, one due only just now, one that ran.
      const future = store.enqueueManual({
        occurrenceId: 'future',
        triggerId: 'trigger-1',
        scheduledAt: later + DAY,
        requestedAt: 1_000_000,
        idempotencyKey: 'future'
      })
      const young = store.enqueueManual({
        occurrenceId: 'young',
        triggerId: 'trigger-1',
        scheduledAt: 1_000_000,
        requestedAt: later - TRIGGER_OCCURRENCE_STALE_AFTER_MS + 1,
        idempotencyKey: 'young'
      })
      seed(eventStore, 2, { from: 1_000_100, status: 'failed', prefix: 'failed' })
      for (let index = 0; index < 3; index += 1) poll(store, later)
      expect(store.get('stale-000002')?.state.status).toBe('pending')
      for (const id of ['stale-000000', 'stale-000001'])
        expect(store.get(id)).toMatchObject({
          deleted: true,
          state: { status: 'dead-letter', lastError: { name: 'TriggerOccurrenceStale' } }
        })
      expect(store.get('future')).toEqual(future)
      expect(store.get('young')).toEqual(young)
      for (const id of ['failed-000000', 'failed-000001'])
        expect(store.get(id)).toMatchObject({ deleted: false, state: { status: 'failed' } })
    } finally {
      eventStore.close()
    }
  })

  it('never dead-letters a marked record, claimed or failed, however old (older builds keep them)', () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    const store = new TriggerOccurrenceStore(eventStore)
    const permit = { authorizationId: 'trigger-authorization:sha256:a', requestDigest: 'sha256:a' }
    try {
      for (const id of ['marked', 'other'])
        store.enqueueManual({
          occurrenceId: id,
          triggerId: 'trigger-1',
          scheduledAt: 1_000,
          requestedAt: 1_000,
          idempotencyKey: id
        })
      store.claimNext(1_000, 'worker', DAY * 30)
      store.markPermit('marked', 'worker', 1_001, permit)
      const marked = store.get('marked')
      for (let index = 0; index < 3; index += 1) poll(store, later)
      // The marked claim is unexpired and stays as it is; the other pending one is the newest stale
      // record of its trigger, so it is kept for the catch-up run.
      expect(store.get('marked')).toEqual(marked)
      expect(store.get('other')?.state.status).toBe('pending')
    } finally {
      eventStore.close()
    }
  })

  it('keeps an archived stale record readable, deduplicated and out of an older build', () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    const store = new TriggerOccurrenceStore(eventStore)
    try {
      for (const at of [1_000, 2_000])
        store.enqueue({
          occurrenceId: `cron:${at}:trigger-1`,
          triggerId: 'trigger-1',
          source: 'cron',
          scheduledAt: at,
          requestedAt: at,
          idempotencyKey: `cron:${at}:trigger-1`
        })
      poll(store, later)
      const dead = store.get('cron:1000:trigger-1')
      expect(dead).toMatchObject({ deleted: true, state: { status: 'dead-letter', attempt: 0 } })
      expect(
        eventStore
          .listResourceMutations(KIND, 'cron:1000:trigger-1', 10)
          .map((item) => item.operation)
      ).toEqual(['create', 'update', 'delete'])
      // The source enqueues the same instant again: the archived final state is the answer.
      expect(
        store.enqueue({
          occurrenceId: 'cron:1000:trigger-1',
          triggerId: 'trigger-1',
          source: 'cron',
          scheduledAt: 1_000,
          requestedAt: 1_000,
          idempotencyKey: 'cron:1000:trigger-1'
        })
      ).toEqual(dead)
      expect(eventStore.getResource(KIND, 'cron:1000:trigger-1')).toBeUndefined()
      expect(store.get('cron:2000:trigger-1')?.state.status).toBe('pending')
    } finally {
      eventStore.close()
    }
  })

  it('runs the newest stale occurrence in the first poll when one page holds the old records', async () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    try {
      // 400 terminal records: more than one archive batch, so the first poll stops archiving early.
      seed(eventStore, 400, { from: 1, step: 1, status: 'completed', prefix: 'done' })
      const { store, clock, executed, scheduler } = harness(eventStore, { 'trigger-1': {} })
      fresh(store, 1_000_000)
      clock.now = 2_000_000
      await scheduler.stop()
      await expect(scheduler.runOnce()).resolves.toBe(true)
      expect(executed).toEqual(['cron:1000000:trigger-1'])
      expect(live(eventStore)).toBe(401 - 100)
    } finally {
      eventStore.close()
    }
  })

  it('still runs the newest stale occurrence when a pass needs many polls', () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    const store = new TriggerOccurrenceStore(eventStore)
    try {
      // More old records than one page, none of which a poll may touch: pending, not due yet.
      seed(eventStore, 1_200, {
        from: 500,
        step: 1,
        status: 'pending',
        prefix: 'scheduled',
        scheduledAt: later + DAY
      })
      seed(eventStore, 3, { from: 1_000_000, status: 'pending', prefix: 'stale' })
      const claimed: string[] = []
      for (let index = 0; index < 10; index += 1) {
        const result = poll(store, later + index, () => true)
        if (result.claimed) claimed.push(result.claimed.id)
      }
      expect(claimed).toEqual(['stale-000002'])
      expect(store.get('stale-000000')?.state.status).toBe('dead-letter')
      expect(store.get('scheduled-000000')?.state.status).toBe('pending')
    } finally {
      eventStore.close()
    }
  })
})
