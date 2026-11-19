import { afterEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MagicAgentEventStore } from '../persistence/eventStore'
import {
  TriggerOccurrenceConflictError,
  TriggerOccurrenceFencingError,
  TriggerOccurrenceStore
} from './triggerOccurrenceStore'

const make = (
  store: TriggerOccurrenceStore,
  patch: Partial<Parameters<TriggerOccurrenceStore['enqueueManual']>[0]> = {}
) =>
  store.enqueueManual({
    occurrenceId: 'occ-1',
    triggerId: 'trigger-1',
    scheduledAt: 100,
    requestedAt: 90,
    idempotencyKey: 'idem-1',
    ...patch
  })
const roots: string[] = []
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.length = 0
})
const setup = (fileBacked = false) => {
  const root = fileBacked ? mkdtempSync(join(tmpdir(), 'trigger-occurrence-')) : undefined
  if (root) roots.push(root)
  const eventStore = new MagicAgentEventStore(root ? join(root, 'events.db') : ':memory:')
  return { eventStore, store: new TriggerOccurrenceStore(eventStore) }
}

describe('TriggerOccurrenceStore', () => {
  it('enqueues and replays the same semantic idempotency key', () => {
    const { eventStore, store } = setup()
    const first = make(store)
    expect(make(store)).toEqual(first)
    eventStore.close()
  })
  it.each([
    { triggerId: 'other' },
    { occurrenceId: 'other' },
    { scheduledAt: 101 },
    { requestedAt: 91 },
    { idempotencyKey: 'other' }
  ])('rejects changed semantic replay', (patch) => {
    const { eventStore, store } = setup()
    make(store)
    expect(() => make(store, patch)).toThrow()
    eventStore.close()
  })
  it('claims globally by schedule then request order and fences late callbacks', () => {
    const { eventStore, store } = setup()
    make(store, { occurrenceId: 'late', scheduledAt: 200 })
    make(store, { occurrenceId: 'early', scheduledAt: 100, idempotencyKey: 'early' })
    const first = store.claimNext(100, 'worker', 10)
    expect(first?.id).toBe('early')
    expect(() => store.complete('early', 'other', 105)).toThrow(TriggerOccurrenceFencingError)
    const completed = store.complete('early', 'worker', 105)
    expect(completed.state.status).toBe('completed')
    expect(completed.state.claim).toBeUndefined()
    eventStore.close()
  })
  it('reclaims expired claims and dead-letters after max attempts', () => {
    const { eventStore, store } = setup()
    make(store)
    store.claimNext(100, 'one', 5)
    expect(() => store.complete('occ-1', 'one', 106)).toThrow()
    const retry = store.claimNext(106, 'two', 5)
    expect(retry?.state.attempt).toBe(2)
    expect(retry?.state.nextRetryAt).toBeUndefined()
    expect(retry?.state.lastError).toBeUndefined()
    store.fail('occ-1', 'two', 107, new Error('failed'))
    store.claimNext(107, 'three', 5)
    expect(store.fail('occ-1', 'three', 108, new Error('failed'), 0, 2).state.status).toBe(
      'dead-letter'
    )
    eventStore.close()
  })
  it('skips immutable expired max entries while dead-lettering a later ordinary entry and claiming an eligible pending one', () => {
    const { eventStore, store } = setup()
    try {
      make(store, { occurrenceId: 'isolated', triggerId: 'isolated', idempotencyKey: 'isolated' })
      store.claimNext(100, 'first', 5, 1)
      make(store, { occurrenceId: 'ordinary', triggerId: 'disabled-ordinary', idempotencyKey: 'ordinary' })
      store.claimNext(100, 'second', 5, 1)
      make(store, { occurrenceId: 'pending', triggerId: 'eligible', idempotencyKey: 'pending' })
      const before = store.get('isolated')
      const history = eventStore.listResourceMutations('trigger-occurrence', 'isolated', 100)
      const result = store.claimNext(106, 'third', 5, 1, (state) => state.triggerId === 'eligible', (state) => state.triggerId !== 'isolated')
      expect(result?.id).toBe('pending')
      expect(store.get('ordinary')?.state.status).toBe('dead-letter')
      expect(store.get('isolated')).toEqual(before)
      expect(eventStore.listResourceMutations('trigger-occurrence', 'isolated', 100)).toEqual(history)
    } finally { eventStore.close() }
  })
  it('defaults to dead-lettering expired claims even when eligible rejects them', () => {
    const { eventStore, store } = setup()
    try {
      make(store)
      store.claimNext(100, 'first', 5, 1)
      expect(store.claimNext(106, 'next', 5, 1, () => false)).toBeUndefined()
      expect(store.get('occ-1')?.state.status).toBe('dead-letter')
    } finally { eventStore.close() }
  })
  it('mutable is independent of eligible and does not filter ordinary pending claims', () => {
    const { eventStore, store } = setup()
    try {
      make(store, { occurrenceId: 'skipped', triggerId: 'not-eligible', idempotencyKey: 'skipped' })
      make(store, { occurrenceId: 'selected', triggerId: 'eligible', idempotencyKey: 'selected' })
      expect(store.claimNext(100, 'worker', 5, 3, (state) => state.triggerId === 'eligible', () => false)?.id).toBe('selected')
      expect(store.get('skipped')?.state.status).toBe('pending')
    } finally { eventStore.close() }
  })
  it('reopens durable occurrence state', () => {
    const { eventStore, store } = setup(true)
    make(store)
    const path = eventStore.getStorageInfo().path
    eventStore.close()
    const reopened = new MagicAgentEventStore(path)
    expect(new TriggerOccurrenceStore(reopened).list()).toHaveLength(1)
    reopened.close()
  })
})

const permit = { authorizationId: 'trigger-authorization:sha256:a', requestDigest: 'sha256:a' }
const unknownError = {
  name: 'TriggerOccurrenceOutcomeUnknown',
  message: 'Trigger occurrence outcome is unknown.'
}
const eventIds = (eventStore: MagicAgentEventStore, id: string) =>
  eventStore.listResourceMutations('trigger-occurrence', id, 100).map((item) => item.eventId)

describe('TriggerOccurrenceStore execution permit marker', () => {
  it.each([false, true])(
    'marks the claimed attempt once and keeps status and claim (file-backed %s)',
    (fileBacked) => {
      const { eventStore, store } = setup(fileBacked)
      try {
        make(store)
        const claimed = store.claimNext(100, 'worker', 10)
        const marked = store.markPermit('occ-1', 'worker', 101, permit)
        expect(marked.state).toMatchObject({
          status: 'claimed',
          attempt: 1,
          claim: claimed?.state.claim
        })
        expect(marked.state.permit).toEqual({
          attempt: 1,
          owner: 'worker',
          markedAt: 101,
          ...permit
        })
        expect(marked.revision).toBe((claimed?.revision ?? -1) + 1)
        const history = eventStore.listResourceMutations('trigger-occurrence', 'occ-1', 100)
        expect(store.markPermit('occ-1', 'worker', 102, permit)).toEqual(marked)
        for (const other of [
          { ...permit, authorizationId: 'trigger-authorization:sha256:b' },
          { ...permit, requestDigest: 'sha256:b' }
        ])
          expect(() => store.markPermit('occ-1', 'worker', 102, other)).toThrow(
            TriggerOccurrenceFencingError
          )
        expect(eventStore.listResourceMutations('trigger-occurrence', 'occ-1', 100)).toEqual(
          history
        )
        expect(eventIds(eventStore, 'occ-1').at(-1)).toBe('occ-1:occurrence.permit-marked:2')
      } finally {
        eventStore.close()
      }
    }
  )
  it.each([
    [1, false],
    [3, false],
    [1, true],
    [3, true]
  ])(
    'turns a failure after the mark into a terminal unknown (maxAttempts %i, file-backed %s)',
    (maxAttempts, fileBacked) => {
      const { eventStore, store } = setup(fileBacked)
      try {
        make(store)
        store.claimNext(100, 'worker', 10, maxAttempts)
        store.markPermit('occ-1', 'worker', 101, permit)
        const failed = store.fail(
          'occ-1',
          'worker',
          102,
          new Error('dispatch failed'),
          5,
          maxAttempts
        )
        expect(failed.state.status).toBe('unknown')
        expect(failed.state.nextRetryAt).toBeUndefined()
        expect(failed.state.claim).toBeUndefined()
        expect(failed.state.lastError).toEqual(unknownError)
        expect(failed.state.permit).toMatchObject({ attempt: 1, owner: 'worker' })
        expect(eventIds(eventStore, 'occ-1').at(-1)).toBe('occ-1:occurrence.outcome-unknown:3')
        for (const now of [102, 107, 111, 10_000, Number.MAX_SAFE_INTEGER])
          for (const max of [maxAttempts, 3, 100])
            expect(store.claimNext(now, `later-${now}`, 10, max)).toBeUndefined()
        expect(store.get('occ-1')).toEqual(failed)
      } finally {
        eventStore.close()
      }
    }
  )
  it('completes a marked occurrence after its lease expired and keeps the marker', () => {
    const { eventStore, store } = setup()
    try {
      make(store)
      store.claimNext(100, 'worker', 10)
      store.markPermit('occ-1', 'worker', 105, permit)
      expect(() => store.complete('occ-1', 'other', 200)).toThrow(TriggerOccurrenceFencingError)
      const completed = store.complete('occ-1', 'worker', 200)
      expect(completed.state.status).toBe('completed')
      expect(completed.state.claim).toBeUndefined()
      expect(completed.state.permit).toMatchObject({ attempt: 1, owner: 'worker', markedAt: 105 })
      expect(store.claimNext(10_000, 'later', 10)).toBeUndefined()
    } finally {
      eventStore.close()
    }
  })
  it('fails a marked occurrence to unknown after lease expiry but still fences an unmarked one', () => {
    const { eventStore, store } = setup()
    try {
      make(store, { occurrenceId: 'marked', idempotencyKey: 'marked' })
      make(store, { occurrenceId: 'plain', idempotencyKey: 'plain', scheduledAt: 101 })
      store.claimNext(101, 'marked-worker', 10)
      store.claimNext(101, 'plain-worker', 10)
      store.markPermit('marked', 'marked-worker', 102, permit)
      expect(store.fail('marked', 'marked-worker', 500, new Error('late')).state.status).toBe(
        'unknown'
      )
      const plain = store.get('plain')
      expect(() => store.fail('plain', 'plain-worker', 500, new Error('late'))).toThrow(
        TriggerOccurrenceFencingError
      )
      expect(() => store.complete('plain', 'plain-worker', 500)).toThrow(
        TriggerOccurrenceFencingError
      )
      expect(store.get('plain')).toEqual(plain)
    } finally {
      eventStore.close()
    }
  })
  it('refuses a mark by another owner or after lease expiry without writing', () => {
    const { eventStore, store } = setup()
    try {
      make(store)
      store.claimNext(100, 'worker', 10)
      const before = store.get('occ-1')
      const history = eventStore.listResourceMutations('trigger-occurrence', 'occ-1', 100)
      expect(() => store.markPermit('occ-1', 'other', 101, permit)).toThrow(
        TriggerOccurrenceFencingError
      )
      expect(() => store.markPermit('occ-1', 'worker', 110, permit)).toThrow(
        TriggerOccurrenceFencingError
      )
      expect(() => store.markPermit('missing', 'worker', 101, permit)).toThrow(
        TriggerOccurrenceFencingError
      )
      expect(store.get('occ-1')).toEqual(before)
      expect(eventStore.listResourceMutations('trigger-occurrence', 'occ-1', 100)).toEqual(history)
      make(store, { occurrenceId: 'pending', idempotencyKey: 'pending', scheduledAt: 500 })
      expect(() => store.markPermit('pending', 'worker', 101, permit)).toThrow(
        TriggerOccurrenceFencingError
      )
    } finally {
      eventStore.close()
    }
  })
  it('turns an expired marked claim at the attempt maximum into unknown, never dead-letter', () => {
    const { eventStore, store } = setup()
    try {
      make(store)
      store.claimNext(100, 'worker', 10, 1)
      store.markPermit('occ-1', 'worker', 101, permit)
      expect(store.claimNext(109, 'early', 10, 1)).toBeUndefined()
      expect(store.get('occ-1')?.state.status).toBe('claimed')
      expect(store.claimNext(110, 'next', 10, 1)).toBeUndefined()
      const swept = store.get('occ-1')?.state
      expect(swept).toMatchObject({
        status: 'unknown',
        lastError: unknownError,
        permit: { attempt: 1 }
      })
      expect(swept?.claim).toBeUndefined()
      expect(swept?.nextRetryAt).toBeUndefined()
      expect(eventIds(eventStore, 'occ-1')).toEqual([
        'occ-1:occurrence.enqueued:0',
        'occ-1:occurrence.claimed:1',
        'occ-1:occurrence.permit-marked:2',
        'occ-1:occurrence.outcome-unknown:3'
      ])
    } finally {
      eventStore.close()
    }
  })
  it('settles every expired marked claim as unknown while still claiming unmarked pending work in order', () => {
    const { eventStore, store } = setup()
    try {
      for (const id of ['marked-a', 'marked-b']) {
        make(store, {
          occurrenceId: id,
          triggerId: id,
          idempotencyKey: id,
          scheduledAt: 10,
          requestedAt: 5
        })
        store.claimNext(10, `${id}-worker`, 10, 1)
        store.markPermit(id, `${id}-worker`, 11, permit)
      }
      make(store, {
        occurrenceId: 'pending-late',
        idempotencyKey: 'pending-late',
        scheduledAt: 300
      })
      make(store, {
        occurrenceId: 'pending-early',
        idempotencyKey: 'pending-early',
        scheduledAt: 200
      })
      expect(store.claimNext(400, 'first', 10, 1)?.id).toBe('pending-early')
      expect(store.claimNext(400, 'second', 10, 1)?.id).toBe('pending-late')
      for (const id of ['marked-a', 'marked-b']) {
        expect(store.get(id)?.state.status).toBe('unknown')
        expect(eventIds(eventStore, id).at(-1)).toBe(`${id}:occurrence.outcome-unknown:3`)
      }
      // Unmarked expired claims are still re-claimed as before; the marked ones never are.
      expect(
        ['third', 'fourth', 'fifth'].map((owner) => store.claimNext(10_000, owner, 10, 3)?.id)
      ).toEqual(['pending-early', 'pending-late', undefined])
    } finally {
      eventStore.close()
    }
  })
  it('leaves an immutable expired marked claim untouched and still never claims it', () => {
    const { eventStore, store } = setup()
    try {
      make(store)
      store.claimNext(100, 'worker', 10)
      store.markPermit('occ-1', 'worker', 101, permit)
      const before = store.get('occ-1')
      const history = eventStore.listResourceMutations('trigger-occurrence', 'occ-1', 100)
      for (const now of [110, 10_000])
        expect(store.claimNext(now, `poll-${now}`, 10, 3, undefined, () => false)).toBeUndefined()
      expect(store.get('occ-1')).toEqual(before)
      expect(eventStore.listResourceMutations('trigger-occurrence', 'occ-1', 100)).toEqual(history)
    } finally {
      eventStore.close()
    }
  })
  it('keeps unknown terminal and returns it unchanged for a replayed enqueue', () => {
    const { eventStore, store } = setup()
    try {
      const enqueued = make(store)
      store.claimNext(100, 'worker', 10)
      store.markPermit('occ-1', 'worker', 101, permit)
      const unknown = store.fail('occ-1', 'worker', 102, new Error('failed'))
      expect(unknown.state.status).toBe('unknown')
      expect(() => store.complete('occ-1', 'worker', 103)).toThrow(TriggerOccurrenceFencingError)
      expect(() => store.fail('occ-1', 'worker', 103, new Error('again'))).toThrow(
        TriggerOccurrenceFencingError
      )
      expect(() => store.markPermit('occ-1', 'worker', 103, permit)).toThrow(
        TriggerOccurrenceFencingError
      )
      expect(make(store)).toEqual(unknown)
      expect(unknown.state.semanticDigest).toBe(enqueued.state.semanticDigest)
      expect(store.get('occ-1')).toEqual(unknown)
    } finally {
      eventStore.close()
    }
  })
  it('keeps a marked claim unclaimable across a real SQLite close and reopen', () => {
    const { eventStore, store } = setup(true)
    const path = eventStore.getStorageInfo().path
    make(store)
    store.claimNext(100, 'crashed-worker', 10)
    store.markPermit('occ-1', 'crashed-worker', 101, permit)
    const history = eventStore.listResourceMutations('trigger-occurrence', 'occ-1', 100)
    eventStore.close()
    const reopened = new MagicAgentEventStore(path)
    try {
      const restarted = new TriggerOccurrenceStore(reopened)
      expect(restarted.claimNext(105, 'restarted', 10)).toBeUndefined()
      expect(restarted.get('occ-1')?.state).toMatchObject({
        status: 'claimed',
        permit: { owner: 'crashed-worker' }
      })
      expect(restarted.claimNext(110, 'restarted', 10)).toBeUndefined()
      expect(restarted.get('occ-1')?.state.status).toBe('unknown')
      expect(restarted.claimNext(10_000, 'restarted-again', 10)).toBeUndefined()
      const after = reopened.listResourceMutations('trigger-occurrence', 'occ-1', 100)
      expect(after.slice(0, history.length)).toEqual(history)
      expect(after.map((item) => item.eventId)).toEqual([
        'occ-1:occurrence.enqueued:0',
        'occ-1:occurrence.claimed:1',
        'occ-1:occurrence.permit-marked:2',
        'occ-1:occurrence.outcome-unknown:3'
      ])
    } finally {
      reopened.close()
    }
  })
  it('never re-marks or claims a marked record that an older build claimed again', () => {
    const { eventStore, store } = setup()
    try {
      make(store)
      store.claimNext(100, 'worker', 10)
      const marked = store.markPermit('occ-1', 'worker', 101, permit)
      // An older build ignores `permit` but keeps it when it re-claims an expired claim.
      const state = {
        ...marked.state,
        attempt: 2,
        claim: { owner: 'older', claimedAt: 200, expiresAt: 210 },
        updatedAt: 200
      }
      const claimedEvent = {
        protocolVersion: '2.0.0',
        id: `occ-1:occurrence.claimed:${marked.revision + 1}`,
        type: 'occurrence.claimed',
        createdAt: 200,
        payload: state,
        envelopeKind: 'event' as const,
        streamId: 'trigger-occurrence:occ-1',
        sequence: marked.revision + 1,
        resource: { kind: 'trigger-occurrence', id: 'occ-1' },
        revision: marked.revision + 1
      }
      eventStore.mutateResource({
        operation: 'update',
        kind: 'trigger-occurrence',
        id: 'occ-1',
        expectedRevision: marked.revision,
        idempotencyKey: 'occ-1:older-build-claim',
        state,
        createdAt: 200,
        event: claimedEvent
      })
      expect(() => store.markPermit('occ-1', 'older', 201, permit)).toThrow(
        TriggerOccurrenceFencingError
      )
      expect(store.claimNext(205, 'new', 10)).toBeUndefined()
      expect(store.claimNext(210, 'new', 10)).toBeUndefined()
      expect(store.get('occ-1')?.state).toMatchObject({
        status: 'unknown',
        attempt: 2,
        permit: { attempt: 1 }
      })
    } finally {
      eventStore.close()
    }
  })
  it('lets no second store instance claim, complete or fail a record another instance marked', () => {
    const { eventStore, store: first } = setup()
    const second = new TriggerOccurrenceStore(eventStore)
    try {
      make(first)
      first.claimNext(100, 'first-owner', 10)
      first.markPermit('occ-1', 'first-owner', 101, permit)
      for (const now of [105, 500]) {
        expect(() => second.complete('occ-1', 'second-owner', now)).toThrow(
          TriggerOccurrenceFencingError
        )
        expect(() => second.fail('occ-1', 'second-owner', now, new Error('x'))).toThrow(
          TriggerOccurrenceFencingError
        )
        expect(() => second.markPermit('occ-1', 'second-owner', now, permit)).toThrow(
          TriggerOccurrenceFencingError
        )
      }
      expect(second.claimNext(105, 'second-owner', 10)).toBeUndefined()
      expect(first.get('occ-1')?.state.status).toBe('claimed')
      expect(second.claimNext(500, 'second-owner', 10)).toBeUndefined()
      expect(second.get('occ-1')?.state.status).toBe('unknown')
      expect(() => first.complete('occ-1', 'first-owner', 501)).toThrow(
        TriggerOccurrenceFencingError
      )
      expect(() => first.fail('occ-1', 'first-owner', 501, new Error('x'))).toThrow(
        TriggerOccurrenceFencingError
      )
      expect(second.get('occ-1')?.state.status).toBe('unknown')
    } finally {
      eventStore.close()
    }
  })
})
