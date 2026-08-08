import { afterEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')
import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
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
  const root = resolve(
    'C:/MagicPot-Terrarium-Tests',
    `.tmp-trigger-occurrence-${Date.now()}-${Math.random()}`
  )
  if (fileBacked) {
    mkdirSync(resolve('C:/MagicPot-Terrarium-Tests'), { recursive: true })

    mkdirSync(root, { recursive: true })
    roots.push(root)
  }
  const eventStore = new MagicAgentEventStore(fileBacked ? resolve(root, 'events.db') : ':memory:')
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
