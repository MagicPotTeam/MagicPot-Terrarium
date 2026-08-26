import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async () => vi.importActual<typeof import('node:fs')>('node:fs'))
vi.mock('electron', () => ({ app: { isPackaged: false } }))
import { MagicAgentEventStore } from '../persistence'
import { CalendarCronTriggerSource } from './calendarCronTriggerSource'
import { PersistentTriggerStore } from './persistentTriggerStore'
import { TriggerOccurrenceStore } from './triggerOccurrenceStore'

const roots: string[] = []
const createStore = (databasePath?: string) => {
  const root = databasePath
    ? undefined
    : join(tmpdir(), `magic-agent-trigger-${Date.now()}-${Math.random()}`)
  if (root) {
    mkdirSync(root, { recursive: true })
    roots.push(root)
  }
  const resolvedDatabasePath = databasePath ?? join(root as string, 'events.db')
  mkdirSync(join(resolvedDatabasePath, '..'), { recursive: true })
  const eventStore = new MagicAgentEventStore(resolvedDatabasePath)
  return {
    eventStore,
    triggers: new PersistentTriggerStore(eventStore),
    databasePath: resolvedDatabasePath
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('PersistentTriggerStore', () => {
  it('continues bounded cron catch-up from persisted cursor after reopen', () => {
    const { eventStore, triggers, databasePath } = createStore()
    const occurrences = new TriggerOccurrenceStore(eventStore)
    triggers.create(
      {
        id: 'cron-restart',
        type: 'event',
        title: 'Cron restart',
        enabled: true,
        config: {
          sourceKind: 'cron',
          cron: '*/15 * * * *',
          timeZone: 'UTC',
          startAt: '2026-01-01T00:01:00Z',
          maxCatchUpRuns: 1
        }
      },
      Date.parse('2026-01-01T00:00:00Z'),
      'cron-restart-create'
    )
    const now = Date.parse('2026-01-01T01:00:00Z')
    expect(new CalendarCronTriggerSource(triggers, occurrences).tick(now)).toBe(1)
    eventStore.close()

    const reopened = createStore(databasePath)
    const reopenedOccurrences = new TriggerOccurrenceStore(reopened.eventStore)
    expect(new CalendarCronTriggerSource(reopened.triggers, reopenedOccurrences).tick(now)).toBe(1)
    expect(
      reopenedOccurrences
        .list()
        .map((item) => item.state.scheduledAt)
        .toSorted()
    ).toEqual([Date.parse('2026-01-01T00:15:00Z'), Date.parse('2026-01-01T00:30:00Z')])
    reopened.eventStore.close()
  })

  it('durably replays source cursor mutations and rejects conflicts after reopen', () => {
    const { eventStore, triggers, databasePath } = createStore()
    triggers.create(
      {
        id: 'cursor-source',
        type: 'event',
        title: 'Cursor source',
        enabled: true,
        config: { sourceKind: 'cron', cron: '*/15 * * * *' }
      },
      1,
      'cursor-source-create'
    )
    const input = {
      triggerId: 'cursor-source',
      expectedRevision: 0,
      cursorAt: 100,
      advancedAt: 10,
      idempotencyKey: 'cursor-advance'
    }
    const first = triggers.advanceSourceCursor(input)
    eventStore.close()

    const reopened = createStore(databasePath)
    expect(reopened.triggers.advanceSourceCursor(input)).toEqual(first)
    expect(() => reopened.triggers.advanceSourceCursor({ ...input, cursorAt: 101 })).toThrow(
      /payload conflict/i
    )
    expect(() =>
      reopened.triggers.advanceSourceCursor({ ...input, idempotencyKey: 'other-cursor' })
    ).toThrow(/revision conflict/i)
    reopened.eventStore.close()
  })

  it('persists interval triggers and deterministically claims due work', () => {
    const { eventStore, triggers } = createStore()
    triggers.create(
      {
        id: 'heartbeat',
        type: 'schedule',
        title: 'Heartbeat',
        enabled: true,
        schedule: { type: 'interval', intervalMs: 1_000 },
        nextFireAt: 100
      },
      1
    )

    expect(triggers.claimDue(99, 'worker-1', 50)).toBeUndefined()
    const claimed = triggers.claimDue(100, 'worker-1', 50)
    expect(claimed?.state.claim).toMatchObject({
      claimId: 'worker-1',
      claimedAt: 100,
      expiresAt: 150,
      occurrenceAt: 100,
      missedCount: 0
    })
    expect(triggers.claimDue(100, 'worker-2', 50)).toBeUndefined()

    const completed = triggers.completeClaim('heartbeat', 'worker-1', 120)
    expect(completed.state.lastFireAt).toBe(100)
    expect(completed.state.nextFireAt).toBe(1_100)
    expect(completed.state.claim).toBeUndefined()
    eventStore.close()
  })

  it('recovers expired claims after reopening the durable store', () => {
    const first = createStore()
    const { databasePath } = first
    first.triggers.create(
      {
        id: 'recoverable',
        type: 'schedule',
        title: 'Recoverable',
        enabled: true,
        schedule: { type: 'interval', intervalMs: 500 },
        nextFireAt: 10
      },
      1
    )
    first.triggers.claimDue(10, 'crashed-worker', 20)
    first.eventStore.close()

    const reopened = new MagicAgentEventStore(databasePath)
    const recovered = new PersistentTriggerStore(reopened)
    expect(recovered.claimDue(29, 'worker-2', 20)).toBeUndefined()
    expect(recovered.claimDue(30, 'worker-2', 20)?.state.claim?.claimId).toBe('worker-2')
    reopened.close()
  })

  it('backs off failed claims and clears failure state after a successful retry', () => {
    const { eventStore, triggers } = createStore()
    triggers.create(
      {
        id: 'retry',
        type: 'schedule',
        title: 'Retry',
        enabled: true,
        schedule: { type: 'interval', intervalMs: 100 },
        nextFireAt: 0
      },
      0
    )
    triggers.claimDue(0, 'worker-1', 10)
    const failed = triggers.failClaim('retry', 'worker-1', 1, 'temporary failure', 50)
    expect(failed.state.failure).toMatchObject({
      attempts: 1,
      lastError: 'temporary failure',
      nextRetryAt: 51,
      occurrence: { occurrenceAt: 0, nextFireAtAfter: 100 }
    })
    expect(triggers.claimDue(50, 'worker-2', 10)).toBeUndefined()
    expect(triggers.claimDue(51, 'worker-2', 10)?.id).toBe('retry')
    expect(triggers.completeClaim('retry', 'worker-2', 52).state.failure).toBeUndefined()
    eventStore.close()
  })
  it('claims due triggers by earliest deadline and stable id order', () => {
    const { eventStore, triggers } = createStore()
    for (const [id, nextFireAt] of [
      ['later', 20],
      ['beta', 10],
      ['alpha', 10]
    ] as const) {
      triggers.create(
        {
          id,
          type: 'schedule',
          title: id,
          enabled: true,
          schedule: { type: 'interval', intervalMs: 100 },
          nextFireAt
        },
        0
      )
    }
    expect(triggers.claimDue(20, 'worker', 10)?.id).toBe('alpha')
    eventStore.close()
  })
  it('replays committed complete and fail claims and rejects changed payloads', () => {
    const { eventStore, triggers } = createStore()
    triggers.create(
      {
        id: 'complete-replay',
        type: 'schedule',
        title: 'Complete replay',
        enabled: true,
        schedule: { type: 'interval', intervalMs: 100 },
        nextFireAt: 10
      },
      0
    )
    triggers.claimDue(10, 'complete-owner', 100)
    const completed = triggers.completeClaim('complete-replay', 'complete-owner', 20)
    expect(triggers.completeClaim('complete-replay', 'complete-owner', 20)).toEqual(completed)
    expect(() => triggers.completeClaim('complete-replay', 'complete-owner', 21)).toThrow(
      'Trigger claim replay payload conflicts with committed fire.'
    )

    triggers.create(
      {
        id: 'fail-replay',
        type: 'schedule',
        title: 'Fail replay',
        enabled: true,
        schedule: { type: 'interval', intervalMs: 100 },
        nextFireAt: 10
      },
      0
    )
    triggers.claimDue(10, 'fail-owner', 100)
    const failed = triggers.failClaim('fail-replay', 'fail-owner', 20, 'temporary', 30)
    expect(triggers.failClaim('fail-replay', 'fail-owner', 20, 'temporary', 30)).toEqual(failed)
    expect(() => triggers.failClaim('fail-replay', 'fail-owner', 20, 'different', 30)).toThrow(
      'Trigger claim replay payload conflicts with committed fail.'
    )
    eventStore.close()
  })

  it('rejects completion and failure at or after claim expiry', () => {
    const { eventStore, triggers } = createStore()
    for (const id of ['expired-complete', 'expired-fail']) {
      triggers.create(
        {
          id,
          type: 'schedule',
          title: id,
          enabled: true,
          schedule: { type: 'interval', intervalMs: 100 },
          nextFireAt: 10
        },
        0
      )
      triggers.claimDue(10, `${id}-owner`, 10)
    }
    expect(() => triggers.completeClaim('expired-complete', 'expired-complete-owner', 20)).toThrow(
      'Trigger claim has expired.'
    )
    expect(() => triggers.failClaim('expired-fail', 'expired-fail-owner', 20, 'late', 10)).toThrow(
      'Trigger claim has expired.'
    )
    eventStore.close()
  })

  it('keeps same-timestamp event identities distinct and uses mutation timestamps', () => {
    const { eventStore, triggers } = createStore()
    triggers.create(
      {
        id: 'same-time',
        type: 'schedule',
        title: 'Same time',
        enabled: true,
        schedule: { type: 'interval', intervalMs: 1 },
        nextFireAt: 10,
        futureState: { preserved: true }
      } as Parameters<PersistentTriggerStore['create']>[0],
      0
    )
    const firstClaim = triggers.claimDue(10, 'owner-1', 10)
    expect(firstClaim?.updatedAt).toBe(10)
    const failed = triggers.failClaim('same-time', 'owner-1', 10, 'failed', 0)
    expect(failed.updatedAt).toBe(10)
    const secondClaim = triggers.claimDue(10, 'owner-2', 10)
    expect(secondClaim?.updatedAt).toBe(10)
    const completed = triggers.completeClaim('same-time', 'owner-2', 10)
    expect(completed.updatedAt).toBe(10)
    expect(
      (completed.state as typeof completed.state & { futureState: unknown }).futureState
    ).toEqual({
      preserved: true
    })

    const ids = eventStore
      .readStream('trigger:same-time:stream', { afterSequence: -1, limit: 10 })
      .map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
    eventStore.close()
  })

  it('applies skip without dropping an occurrence due exactly now and does not block other work', () => {
    const { eventStore, triggers } = createStore()
    triggers.create(
      {
        id: 'skip-first',
        type: 'schedule',
        title: 'Skip first',
        enabled: true,
        schedule: { type: 'interval', intervalMs: 100, missedRunPolicy: 'skip' },
        nextFireAt: 0
      },
      0
    )
    triggers.create(
      {
        id: 'other-due',
        type: 'schedule',
        title: 'Other due',
        enabled: true,
        schedule: { type: 'interval', intervalMs: 100 },
        nextFireAt: 50
      },
      0
    )

    const exact = triggers.claimDue(100, 'skip-worker', 20)
    expect(exact?.id).toBe('skip-first')
    expect(exact?.state.claim).toMatchObject({ occurrenceAt: 100, missedCount: 0 })
    triggers.completeClaim('skip-first', 'skip-worker', 101)

    expect(triggers.claimDue(101, 'other-worker', 20)?.id).toBe('other-due')

    const skippedEvents = eventStore
      .readStream('trigger:skip-first:stream', { afterSequence: -1, limit: 20 })
      .filter((item) => item.type === 'trigger.skipped')
    expect(skippedEvents).toHaveLength(1)
    expect(skippedEvents[0]?.payload).toMatchObject({
      missedCount: 1,
      windowStart: 0,
      windowEnd: 0,
      nextFireAt: 100
    })
    eventStore.close()
  })

  it('coalesces run-once backlog without schedule drift across reopen', () => {
    const first = createStore()
    const { databasePath } = first
    first.triggers.create(
      {
        id: 'run-once',
        type: 'schedule',
        title: 'Run once',
        enabled: true,
        schedule: { type: 'interval', intervalMs: 100, missedRunPolicy: 'run-once' },
        nextFireAt: 0
      },
      0
    )
    first.eventStore.close()

    const reopened = createStore(databasePath)
    const claimed = reopened.triggers.claimDue(350, 'worker', 100)
    expect(claimed?.state.claim).toMatchObject({
      occurrenceAt: 300,
      windowStart: 0,
      windowEnd: 300,
      missedCount: 3,
      nextFireAtAfter: 400
    })
    const completed = reopened.triggers.completeClaim('run-once', 'worker', 375)
    expect(completed.state.lastFireAt).toBe(300)
    expect(completed.state.nextFireAt).toBe(400)
    reopened.eventStore.close()
  })

  it('limits catch-up, preserves occurrence order, and converges after restart', () => {
    const first = createStore()
    const { databasePath } = first
    first.triggers.create(
      {
        id: 'catch-up',
        type: 'schedule',
        title: 'Catch up',
        enabled: true,
        schedule: {
          type: 'interval',
          intervalMs: 100,
          missedRunPolicy: 'catch-up',
          maxCatchUpRuns: 2
        },
        nextFireAt: 0
      },
      0
    )

    const firstClaim = first.triggers.claimDue(450, 'worker-1', 100)
    expect(firstClaim?.state.claim).toMatchObject({ occurrenceAt: 300, batchEndAt: 400 })
    first.triggers.completeClaim('catch-up', 'worker-1', 451)
    first.eventStore.close()

    const reopened = createStore(databasePath)
    const secondClaim = reopened.triggers.claimDue(452, 'worker-2', 100)
    expect(secondClaim?.state.claim).toMatchObject({ occurrenceAt: 400, batchEndAt: 400 })
    const completed = reopened.triggers.completeClaim('catch-up', 'worker-2', 453)
    expect(completed.state.nextFireAt).toBe(500)
    expect(completed.state.catchUpUntilAt).toBeUndefined()
    expect(reopened.triggers.claimDue(499, 'worker-3', 100)).toBeUndefined()

    const skipped = reopened.eventStore
      .readStream('trigger:catch-up:stream', { afterSequence: -1, limit: 20 })
      .find((item) => item.type === 'trigger.skipped')
    expect(skipped?.payload).toMatchObject({ missedCount: 3, windowStart: 0, windowEnd: 200 })
    reopened.eventStore.close()
  })

  it('retries the same catch-up occurrence after failure', () => {
    const { eventStore, triggers } = createStore()
    triggers.create(
      {
        id: 'catch-up-retry',
        type: 'schedule',
        title: 'Catch-up retry',
        enabled: true,
        schedule: {
          type: 'interval',
          intervalMs: 100,
          missedRunPolicy: 'catch-up',
          maxCatchUpRuns: 2
        },
        nextFireAt: 0
      },
      0
    )
    const claimed = triggers.claimDue(450, 'worker-1', 100)
    const occurrence = claimed?.state.claim
    triggers.failClaim('catch-up-retry', 'worker-1', 451, 'temporary', 10)
    expect(triggers.claimDue(460, 'worker-2', 100)).toBeUndefined()
    const retry = triggers.claimDue(461, 'worker-2', 100)
    expect(retry?.state.claim).toMatchObject({
      occurrenceAt: occurrence?.occurrenceAt,
      windowStart: occurrence?.windowStart,
      windowEnd: occurrence?.windowEnd,
      nextFireAtAfter: occurrence?.nextFireAtAfter,
      batchEndAt: occurrence?.batchEndAt
    })
    eventStore.close()
  })

  it('rejects stale claim completion and invalid intervals', () => {
    const { eventStore, triggers } = createStore()
    expect(() =>
      triggers.create({
        id: 'invalid',
        type: 'schedule',
        title: 'Invalid',
        enabled: true,
        schedule: { type: 'interval', intervalMs: 0 },
        nextFireAt: 0
      })
    ).toThrow('Trigger interval must be positive.')
    triggers.create(
      {
        id: 'valid',
        type: 'schedule',
        title: 'Valid',
        enabled: true,
        schedule: { type: 'interval', intervalMs: 100 },
        nextFireAt: 0
      },
      0
    )
    triggers.claimDue(0, 'owner', 10)
    expect(() => triggers.completeClaim('valid', 'other', 1)).toThrow(
      'Trigger claim does not match.'
    )
    eventStore.close()
  })
})

describe('PersistentTriggerStore control mutations', () => {
  const controlTrigger = () => ({
    id: 'control',
    type: 'schedule' as const,
    title: 'Control',
    enabled: true,
    schedule: { type: 'interval' as const, intervalMs: 100 },
    nextFireAt: 100
  })
  it('disable/enable controls claim eligibility and emits events', () => {
    const { eventStore, triggers } = createStore()
    triggers.create(controlTrigger(), 0)
    const disabled = triggers.setEnabled({
      triggerId: 'control',
      enabled: false,
      expectedRevision: 0,
      idempotencyKey: 'disable-1',
      changedAt: 10
    })
    expect(disabled.state.enabled).toBe(false)
    expect(triggers.claimDue(100, 'w', 10)).toBeUndefined()
    const enabled = triggers.setEnabled({
      triggerId: 'control',
      enabled: true,
      expectedRevision: disabled.revision,
      idempotencyKey: 'enable-1',
      changedAt: 20
    })
    expect(enabled.state.enabled).toBe(true)
    expect(triggers.claimDue(100, 'w', 10)?.id).toBe('control')
    eventStore.close()
  })
  it('pause/resume controls claim eligibility', () => {
    const { eventStore, triggers } = createStore()
    const created = triggers.create(controlTrigger(), 0)
    const paused = triggers.setPaused({
      triggerId: 'control',
      paused: true,
      expectedRevision: created.revision,
      idempotencyKey: 'pause-1',
      changedAt: 10
    })
    expect(paused.state.paused).toBe(true)
    expect(triggers.claimDue(100, 'w', 10)).toBeUndefined()
    const resumed = triggers.setPaused({
      triggerId: 'control',
      paused: false,
      expectedRevision: paused.revision,
      idempotencyKey: 'resume-1',
      changedAt: 20
    })
    expect(resumed.state.paused).toBe(false)
    expect(triggers.claimDue(100, 'w', 10)?.id).toBe('control')
    eventStore.close()
  })
  it('control changes do not cancel an active claim', () => {
    const { eventStore, triggers } = createStore()
    const created = triggers.create(controlTrigger(), 0)
    triggers.claimDue(100, 'w', 20)
    const changed = triggers.setPaused({
      triggerId: 'control',
      paused: true,
      expectedRevision: created.revision + 1,
      idempotencyKey: 'pause-active',
      changedAt: 101
    })
    expect(changed.state.claim).toBeDefined()
    expect(changed.state.paused).toBe(true)
    eventStore.close()
  })
  it('retry preserves schedule cursor and failure fields, then makes failure due', () => {
    const { eventStore, triggers } = createStore()
    triggers.create(controlTrigger(), 0)
    triggers.claimDue(100, 'w', 20)
    const failed = triggers.failClaim('control', 'w', 101, 'failed', 100)
    const retried = triggers.retry({
      triggerId: 'control',
      expectedRevision: failed.revision,
      idempotencyKey: 'retry-1',
      requestedAt: 102
    })
    expect(retried.state.nextFireAt).toBe(failed.state.nextFireAt)
    expect(retried.state.failure?.attempts).toBe(failed.state.failure?.attempts)
    expect(triggers.claimDue(102, 'next', 20)?.id).toBe('control')
    eventStore.close()
  })
  it('validates controls and replays idempotently with semantic conflicts', () => {
    const { eventStore, triggers } = createStore()
    const created = triggers.create(controlTrigger(), 0)
    const first = triggers.setPaused({
      triggerId: 'control',
      paused: true,
      expectedRevision: created.revision,
      idempotencyKey: 'same',
      changedAt: 10
    })
    expect(
      triggers.setPaused({
        triggerId: 'control',
        paused: true,
        expectedRevision: created.revision,
        idempotencyKey: 'same',
        changedAt: 10
      })
    ).toEqual(first)
    const second = triggers.setPaused({
      triggerId: 'control',
      paused: false,
      expectedRevision: first.revision,
      idempotencyKey: 'second',
      changedAt: 20
    })
    const historical = triggers.setPaused({
      triggerId: 'control',
      paused: true,
      expectedRevision: created.revision,
      idempotencyKey: 'same',
      changedAt: 10
    })
    expect(historical).toEqual(first)
    expect(triggers.get('control')?.revision).toBe(second.revision)
    expect(() =>
      triggers.setEnabled({
        triggerId: 'control',
        enabled: false,
        expectedRevision: created.revision,
        idempotencyKey: 'same',
        changedAt: 10
      })
    ).toThrow(/conflict/i)
    expect(() =>
      triggers.setPaused({
        triggerId: 'control',
        paused: false,
        expectedRevision: created.revision,
        idempotencyKey: 'same',
        changedAt: 11
      })
    ).toThrow()
    expect(() =>
      triggers.setEnabled({
        triggerId: 'control',
        enabled: true,
        expectedRevision: NaN,
        idempotencyKey: 'x',
        changedAt: 1
      })
    ).toThrow()
    expect(() =>
      triggers.retry({
        triggerId: 'control',
        expectedRevision: first.revision,
        idempotencyKey: 'r',
        requestedAt: 1
      })
    ).toThrow()
    eventStore.close()
  })
  it('replays historical retry after later mutation and rejects cross-operation reuse', () => {
    const { eventStore, triggers } = createStore()
    triggers.create(controlTrigger(), 0)
    triggers.claimDue(100, 'retry-owner', 20)
    const failed = triggers.failClaim('control', 'retry-owner', 101, 'temporary', 50)
    const first = triggers.retry({
      triggerId: 'control',
      expectedRevision: failed.revision,
      idempotencyKey: 'retry-replay',
      requestedAt: 102
    })
    const later = triggers.setPaused({
      triggerId: 'control',
      paused: true,
      expectedRevision: first.revision,
      idempotencyKey: 'later-control',
      changedAt: 103
    })
    const replay = triggers.retry({
      triggerId: 'control',
      expectedRevision: failed.revision,
      idempotencyKey: 'retry-replay',
      requestedAt: 102
    })
    expect(replay).toEqual(first)
    expect(triggers.get('control')?.revision).toBe(later.revision)
    expect(() =>
      triggers.retry({
        triggerId: 'control',
        expectedRevision: failed.revision,
        idempotencyKey: 'retry-replay',
        requestedAt: 104
      })
    ).toThrow()
    expect(() =>
      triggers.setEnabled({
        triggerId: 'control',
        enabled: false,
        expectedRevision: failed.revision,
        idempotencyKey: 'retry-replay',
        changedAt: 102
      })
    ).toThrow()
    eventStore.close()
  })
})

describe('PersistentTriggerStore update', () => {
  const updateTrigger = () => ({
    id: 'update',
    type: 'schedule' as const,
    title: 'Old',
    enabled: true,
    config: { safe: true },
    schedule: { type: 'interval' as const, intervalMs: 100 },
    nextFireAt: 100
  })
  it('updates allowlisted fields and replays historical revision after control mutation', () => {
    const { eventStore, triggers } = createStore()
    const created = triggers.create(updateTrigger(), 0)
    const first = triggers.update({
      triggerId: 'update',
      expectedRevision: created.revision,
      idempotencyKey: 'update-1',
      updatedAt: 10,
      patch: { title: 'New', config: { safe: false } }
    })
    triggers.setPaused({
      triggerId: 'update',
      paused: true,
      expectedRevision: first.revision,
      idempotencyKey: 'pause-after',
      changedAt: 20
    })
    expect(
      triggers.update({
        triggerId: 'update',
        expectedRevision: created.revision,
        idempotencyKey: 'update-1',
        updatedAt: 10,
        patch: { title: 'New', config: { safe: false } }
      })
    ).toEqual(first)
    expect(triggers.get('update')?.revision).toBe(2)
    eventStore.close()
  })
  it('preserves active claim and rejects authority/schedule fields', () => {
    const { eventStore, triggers } = createStore()
    const created = triggers.create(updateTrigger(), 0)
    const claimed = triggers.claimDue(100, 'owner', 10)
    const changed = triggers.update({
      triggerId: 'update',
      expectedRevision: claimed!.revision,
      idempotencyKey: 'update-claim',
      updatedAt: 101,
      patch: { title: 'Claimed' }
    })
    expect(changed.state.claim).toBeDefined()
    expect(() =>
      triggers.update({
        triggerId: 'update',
        expectedRevision: changed.revision,
        idempotencyKey: 'bad',
        updatedAt: 102,
        patch: { schedule: {} }
      } as never)
    ).toThrow()
    expect(() =>
      triggers.update({
        triggerId: 'update',
        expectedRevision: changed.revision,
        idempotencyKey: 'bad2',
        updatedAt: 102,
        patch: { id: 'other' }
      } as never)
    ).toThrow()
    eventStore.close()
  })
  it.each([{ title: '' }, { enabled: 'yes' }, { config: [1, 2] }])(
    'rejects invalid update patch %o',
    (patch) => {
      const { eventStore, triggers } = createStore()
      triggers.create(updateTrigger(), 0)
      expect(() =>
        triggers.update({
          triggerId: 'update',
          expectedRevision: 0,
          idempotencyKey: 'invalid',
          updatedAt: 10,
          patch
        } as never)
      ).toThrow()
      eventStore.close()
    }
  )
})

describe('PersistentTriggerStore create caller idempotency', () => {
  const trigger = () => ({
    id: 'caller-create',
    type: 'schedule' as const,
    title: 'Create',
    enabled: true,
    config: { prompt: 'secret' },
    schedule: { type: 'interval' as const, intervalMs: 100 },
    nextFireAt: 100
  })
  it('replays the same caller create and rejects semantic conflicts', () => {
    const { eventStore, triggers } = createStore()
    const first = triggers.create(trigger(), 10, 'caller-1')
    expect(triggers.create(trigger(), 10, 'caller-1')).toEqual(first)
    expect(() => triggers.create({ ...trigger(), title: 'Changed' }, 10, 'caller-1')).toThrow(
      /idempotency|conflict/i
    )
    expect(() => triggers.create(trigger(), 10, 'caller-2')).toThrow(/already exists/i)
    const mutation = eventStore
      .listResourceMutations('trigger', 'caller-create', 10)
      .find((item) => item.idempotencyKey.includes('caller:caller-1'))
    expect(eventStore.getEvent(mutation!.eventId)?.payload).not.toHaveProperty('config')
    eventStore.close()
  })
  it('replays caller create after SQLite reopen', () => {
    const firstStore = createStore()
    const { databasePath } = firstStore
    const first = firstStore.triggers.create(trigger(), 10, 'caller-reopen')
    firstStore.eventStore.close()
    const reopened = createStore(databasePath)
    expect(reopened.triggers.create(trigger(), 10, 'caller-reopen')).toEqual(first)
    reopened.eventStore.close()
  })
})
