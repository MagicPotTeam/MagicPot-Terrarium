import { describe, expect, it, vi } from 'vitest'
import { MagicAgentEventStore, type ResourceMutationInput } from '../persistence/eventStore'
import { TriggerOccurrenceScheduler } from './triggerOccurrenceScheduler'
import {
  MAGIC_AGENT_TRIGGER_OCCURRENCE_QUEUE_RESOURCE_KIND as QUEUE_KIND,
  MAGIC_AGENT_TRIGGER_OCCURRENCE_RESOURCE_KIND as KIND,
  TRIGGER_OCCURRENCE_ARCHIVE_ABOVE,
  TRIGGER_OCCURRENCE_QUEUE_MARKER_ID,
  TRIGGER_OCCURRENCE_STALE_AFTER_MS,
  TriggerOccurrenceStore,
  type TriggerOccurrenceSource,
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
    scheduledAt,
    source = 'cron'
  }: {
    from: number
    status: TriggerOccurrenceStatus
    prefix: string
    triggerId?: string
    step?: number
    scheduledAt?: number
    source?: TriggerOccurrenceSource
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
        source,
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
// The production executor denies an occurrence without a trigger permit; by default it throws the
// same way. `runFor` instead lets each run succeed after that long on the clock.
const harness = (
  eventStore: MagicAgentEventStore,
  triggers: Record<string, TriggerConfig>,
  { runFor, clock = { now: 0 } }: { runFor?: number; clock?: { now: number } } = {}
) => {
  const store = new TriggerOccurrenceStore(eventStore)
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
      if (runFor === undefined) throw new Error('denied')
      clock.now += runFor
    },
    now: () => clock.now,
    leaseMs: Math.max(30_000, 2 * (runFor ?? 0))
  })
  return { store, clock, executed, scheduler }
}
// The counts the scheduler logged for dead-lettered occurrences; the lines name no occurrence.
const deadLetterCounts = (warn: { mock: { calls: unknown[][] } }) =>
  warn.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.startsWith('[triggers] Dead-lettered'))
    .map((line) => {
      expect(line).not.toMatch(/stranded-|cron:|msg-/)
      return Number(/Dead-lettered (\d+) /.exec(line)?.[1])
    })
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
  // good while its sources kept enqueueing (cron one per minute). An upgraded store holds those
  // 1000 terminal records plus a week of stranded, due, never-claimed occurrences, of any source.
  it.each(['cron', 'channel-message'] as const)(
    'claims a fresh occurrence at once, keeps every poll bounded and runs one stranded %s occurrence',
    async (source) => {
      const eventStore = new MagicAgentEventStore(':memory:')
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        const stranded = 10_000
        seed(eventStore, 1_000, { from: 1_000_000, status: 'dead-letter', prefix: 'done' })
        seed(eventStore, stranded, {
          from: 1_000_000_000,
          status: 'pending',
          prefix: 'stranded',
          source
        })
        const { store, clock, executed, scheduler } = harness(eventStore, { 'trigger-1': {} })
        clock.now = 1_000_000_000 + stranded * MINUTE + DAY
        const first = fresh(store, clock.now)
        const reads = countRowsRead(eventStore)
        const polls: { rows: number; ms: number }[] = []
        let freshPoll: number | undefined
        while (live(eventStore) > TRIGGER_OCCURRENCE_ARCHIVE_ABOVE && polls.length < 300) {
          reads.rows = 0
          // Main-thread time as CPU time of this file's own process, so a busy machine adds nothing.
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
        // maxCatchUpRuns defaults to 1: of a week of stranded records only the newest runs.
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
        // Logged as counts only, once a drain ends.
        expect(deadLetterCounts(warn).reduce((sum, count) => sum + count, 0)).toBe(stranded - 1)
      } finally {
        warn.mockRestore()
        eventStore.close()
      }
    },
    120_000
  )

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

describe('TriggerOccurrenceScheduler with events that waited', () => {
  const message = (store: TriggerOccurrenceStore, id: string, at: number) =>
    store.enqueue({
      occurrenceId: id,
      triggerId: 'chat',
      source: 'channel-message',
      scheduledAt: at,
      requestedAt: at,
      idempotencyKey: id
    })
  const statuses = (store: TriggerOccurrenceStore, ids: readonly string[]) =>
    ids.map((id) => store.get(id)?.state.status)
  const messages = ['msg-1', 'msg-2', 'msg-3']

  it('runs every event queued before a sleep and coalesces only the missed cron instants', async () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const { store, clock, executed, scheduler } = harness(
        eventStore,
        { chat: {}, tick: {} },
        { runFor: 1_000 }
      )
      const asleepAt = 5_000_000
      clock.now = asleepAt - 5 * MINUTE
      await expect(scheduler.runOnce()).resolves.toBe(false)
      // Three cron instants and three channel messages are queued, then the machine sleeps.
      const instants = [2, 1, 0].map((ago) => fresh(store, asleepAt - ago * MINUTE, 'tick').id)
      messages.forEach((id, index) => message(store, id, asleepAt + index + 1))
      clock.now = asleepAt + 15 * MINUTE
      for (let poll = 0; poll < 6; poll += 1) {
        await scheduler.runOnce()
        clock.now += 1_000
      }
      // Each message is its own event; of the instants only the newest runs (maxCatchUpRuns 1).
      expect(executed).toEqual([instants[2], ...messages])
      expect(statuses(store, messages)).toEqual(['completed', 'completed', 'completed'])
      for (const id of instants.slice(0, 2))
        expect(store.get(id)?.state).toMatchObject({
          status: 'dead-letter',
          lastError: { name: 'TriggerOccurrenceStale' }
        })
      expect(deadLetterCounts(warn)).toEqual([2])
    } finally {
      warn.mockRestore()
      eventStore.close()
    }
  })

  it('runs every event queued behind slow runs', async () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    try {
      const { store, clock, executed, scheduler } = harness(
        eventStore,
        { chat: {} },
        { runFor: 4 * MINUTE }
      )
      clock.now = 9_000_000
      const events = [1, 2, 3, 4, 5].map(
        (index) => message(store, `ev-${index}`, clock.now + index).id
      )
      // Each run takes 4 minutes, so the last events wait well past the stale horizon.
      for (let poll = 0; poll < 8; poll += 1) {
        await scheduler.runOnce()
        clock.now += 1_000
      }
      expect(executed).toEqual(events)
      expect(new Set(statuses(store, events))).toEqual(new Set(['completed']))
    } finally {
      eventStore.close()
    }
  })

  it('runs the events an older build queued in a store it never stalled', async () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    try {
      // Closed on an older build with three messages queued, upgraded a day later.
      seed(eventStore, 3, {
        from: 1_000_000,
        status: 'pending',
        prefix: 'msg',
        triggerId: 'chat',
        source: 'channel-message'
      })
      const { store, clock, executed, scheduler } = harness(eventStore, { chat: {} }, { runFor: 1 })
      clock.now = 1_000_000 + DAY
      for (let poll = 0; poll < 4; poll += 1) {
        await scheduler.runOnce()
        clock.now += 1_000
      }
      expect(executed).toEqual(['msg-000000', 'msg-000001', 'msg-000002'])
      expect(eventStore.getResource(QUEUE_KIND, TRIGGER_OCCURRENCE_QUEUE_MARKER_ID)?.state).toEqual(
        { schemaVersion: 1, firstPollAt: 1_000_000 + DAY }
      )
      expect(store.get('msg-000000')?.state.status).toBe('completed')
    } finally {
      eventStore.close()
    }
  })

  it('treats only records from before the first poll as stranded, across restarts', async () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    try {
      // A store an older build stalled: 1000 terminal records, then three stranded messages.
      seed(eventStore, 1_000, { from: 1_000_000, status: 'completed', prefix: 'done' })
      seed(eventStore, 3, {
        from: 1_000_000_000,
        status: 'pending',
        prefix: 'stranded',
        triggerId: 'chat',
        source: 'channel-message'
      })
      const clock = { now: 1_000_000_000 + DAY }
      const firstPollAt = clock.now
      const before = harness(eventStore, { chat: {} }, { runFor: 1, clock })
      for (let poll = 0; poll < 15; poll += 1) {
        await before.scheduler.runOnce()
        clock.now += 1_000
      }
      expect(before.executed).toEqual(['stranded-000002'])
      expect(before.store.get('stranded-000001')?.state.lastError?.name).toBe(
        'TriggerOccurrenceStale'
      )
      // The 1000th record, the last one the older build still claimed within.
      const marker = {
        schemaVersion: 1,
        firstPollAt,
        strandedBefore: firstPollAt - TRIGGER_OCCURRENCE_STALE_AFTER_MS,
        strandedAfter: {
          updatedAt: 1_000_000 + 999 * MINUTE,
          resourceKind: KIND,
          resourceId: 'done-000999'
        }
      }
      expect(eventStore.getResource(QUEUE_KIND, TRIGGER_OCCURRENCE_QUEUE_MARKER_ID)?.state).toEqual(
        marker
      )
      // Messages arrive, the app is closed for an hour, and a new process polls the store.
      messages.forEach((id, index) => message(before.store, id, clock.now + index))
      clock.now += 60 * MINUTE
      const after = harness(eventStore, { chat: {} }, { runFor: 1, clock })
      for (let poll = 0; poll < 4; poll += 1) {
        await after.scheduler.runOnce()
        clock.now += 1_000
      }
      expect(after.executed).toEqual(messages)
      expect(eventStore.getResource(QUEUE_KIND, TRIGGER_OCCURRENCE_QUEUE_MARKER_ID)).toMatchObject({
        revision: 0,
        state: marker
      })
    } finally {
      eventStore.close()
    }
  })
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

describe('TriggerOccurrenceScheduler at the edges of the stranded rule', () => {
  it('runs every record inside the window an older build claimed within', async () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    try {
      // 1003 live: the older build claimed within the oldest 1000, so w-000000 and w-000001 were
      // still claimable; only w-000002..4 were past its window.
      seed(eventStore, 998, { from: 1_000_000, status: 'dead-letter', prefix: 'done' })
      seed(eventStore, 5, {
        from: 1_000_000_000,
        status: 'pending',
        prefix: 'w',
        triggerId: 'chat',
        step: 1,
        source: 'channel-message'
      })
      const clock = { now: 2_000_000_000 }
      const { store, executed, scheduler } = harness(eventStore, { chat: {} }, { runFor: 1, clock })
      for (let poll = 0; poll < 40; poll += 1) {
        await scheduler.runOnce()
        clock.now += 1_000
      }
      expect([...new Set(executed)].sort()).toEqual(['w-000000', 'w-000001', 'w-000004'])
      for (const id of ['w-000002', 'w-000003'])
        expect(store.get(id)?.state).toMatchObject({
          status: 'dead-letter',
          lastError: { name: 'TriggerOccurrenceStale' }
        })
    } finally {
      eventStore.close()
    }
  }, 60_000)

  it('never treats a record enqueued after the first poll as stranded, whatever its time', async () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    try {
      seed(eventStore, 1_000, { from: 1_000_000, status: 'dead-letter', prefix: 'done' })
      seed(eventStore, 1_500, {
        from: 1_000_000_000,
        status: 'pending',
        prefix: 'stranded',
        source: 'channel-message'
      })
      const clock = { now: 2_000_000_000 }
      const { store, executed, scheduler } = harness(
        eventStore,
        { 'trigger-1': {}, 'trigger-9': {} },
        { runFor: 1, clock }
      )
      await scheduler.runOnce()
      expect(
        eventStore.getResource(QUEUE_KIND, TRIGGER_OCCURRENCE_QUEUE_MARKER_ID)?.state
      ).toMatchObject({ strandedBefore: 2_000_000_000 - TRIGGER_OCCURRENCE_STALE_AFTER_MS })
      // Manual fires whose client time is older than the marker's bound, and older than the
      // stranded records around them.
      for (const [id, at] of [
        ['old-a', 1_050_000_000],
        ['old-b', 1_050_000_001]
      ] as const)
        store.enqueueManual({
          occurrenceId: id,
          triggerId: 'trigger-9',
          scheduledAt: at,
          requestedAt: at,
          idempotencyKey: id
        })
      for (let poll = 0; poll < 80; poll += 1) {
        await scheduler.runOnce()
        clock.now += 1_000
      }
      expect(executed).toEqual(expect.arrayContaining(['old-a', 'old-b']))
      expect([...new Set(executed.filter((id) => id.startsWith('stranded-')))]).toEqual([
        'stranded-001499'
      ])
    } finally {
      eventStore.close()
    }
  }, 60_000)

  it('bounds a marker written without the window edge by time only, and ignores one it cannot read', async () => {
    for (const [strandedAfter, expected] of [
      [undefined, ['w-000004']],
      [{ updatedAt: 'late' }, ['w-000000', 'w-000001', 'w-000002', 'w-000003', 'w-000004']]
    ] as const) {
      const eventStore = new MagicAgentEventStore(':memory:')
      try {
        seed(eventStore, 998, { from: 1_000_000, status: 'dead-letter', prefix: 'done' })
        seed(eventStore, 5, {
          from: 1_000_000_000,
          status: 'pending',
          prefix: 'w',
          triggerId: 'chat',
          step: 1,
          source: 'channel-message'
        })
        const clock = { now: 2_000_000_000 }
        eventStore.mutateResource({
          operation: 'create',
          kind: QUEUE_KIND,
          id: TRIGGER_OCCURRENCE_QUEUE_MARKER_ID,
          idempotencyKey: 'earlier-marker',
          state: {
            schemaVersion: 1,
            firstPollAt: clock.now,
            strandedBefore: clock.now - TRIGGER_OCCURRENCE_STALE_AFTER_MS,
            ...(strandedAfter === undefined ? {} : { strandedAfter })
          },
          createdAt: clock.now,
          event: {
            protocolVersion: '2.0.0',
            id: 'marker:occurrence-queue.marked:0',
            type: 'occurrence-queue.marked',
            createdAt: clock.now,
            payload: {},
            envelopeKind: 'event',
            streamId: `${QUEUE_KIND}:${TRIGGER_OCCURRENCE_QUEUE_MARKER_ID}`,
            sequence: 0,
            resource: { kind: QUEUE_KIND, id: TRIGGER_OCCURRENCE_QUEUE_MARKER_ID },
            revision: 0
          } as never
        })
        const { executed, scheduler } = harness(eventStore, { chat: {} }, { runFor: 1, clock })
        for (let poll = 0; poll < 40; poll += 1) {
          await scheduler.runOnce()
          clock.now += 1_000
        }
        expect([...new Set(executed)].sort()).toEqual(expected)
      } finally {
        eventStore.close()
      }
    }
  }, 60_000)

  it.each([
    ['one page', 5],
    ['many pages', 1_200]
  ] as const)(
    'keeps maxCatchUpRuns while the dead-letter batch keeps failing (%s)',
    async (_name, count) => {
      const eventStore = new MagicAgentEventStore(':memory:')
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        seed(eventStore, count, { from: 1_000_000_000, status: 'pending', prefix: 'st' })
        const clock = { now: 2_000_000_000 }
        const { store, executed, scheduler } = harness(
          eventStore,
          { 'trigger-1': {}, 'trigger-2': {} },
          { runFor: 1, clock }
        )
        // A due event that is not stale, written after the whole backlog.
        store.enqueue({
          occurrenceId: 'legit',
          triggerId: 'trigger-2',
          source: 'manual',
          scheduledAt: 1_000_000_000 + count * MINUTE,
          requestedAt: 1_000_000_000 + count * MINUTE,
          idempotencyKey: 'legit'
        })
        const batch = eventStore.mutateResourcesBatch.bind(eventStore)
        let failing = true
        let failures = 0
        vi.spyOn(eventStore, 'mutateResourcesBatch').mockImplementation((inputs, fence) => {
          if (failing && inputs.length > 1) {
            failures += 1
            throw new Error('disk full')
          }
          return batch(inputs, fence)
        })
        for (let poll = 0; poll < 30; poll += 1) {
          await scheduler.runOnce().catch(() => undefined)
          clock.now += 1_000
        }
        expect(failures).toBeGreaterThan(3)
        expect(executed).toContain('legit')
        failing = false
        for (let poll = 0; poll < 60; poll += 1) {
          await scheduler.runOnce()
          clock.now += 1_000
        }
        const last = `st-${String(count - 1).padStart(6, '0')}`
        expect(executed.filter((id) => id.startsWith('st-'))).toEqual([last])
        expect(store.get('st-000000')?.state).toMatchObject({
          status: 'dead-letter',
          lastError: { name: 'TriggerOccurrenceStale' }
        })
      } finally {
        warn.mockRestore()
        eventStore.close()
      }
    },
    60_000
  )
})
