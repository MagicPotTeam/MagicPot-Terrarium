import { afterEach, describe, expect, it } from 'vitest'
import type { MagicAgentEvent } from '../../../shared/magicAgentPlatform2'
import {
  EventStoreClosedError,
  EventStoreConflictError,
  MagicAgentEventStore,
  RecoveryReducerError,
  RecoverySnapshotDecodeError,
  deepFreeze,
  restoreWithReducer,
  type RecoveryBundle,
  type SnapshotInput
} from './eventStore'

const stores: MagicAgentEventStore[] = []
const open = (): MagicAgentEventStore => {
  const store = new MagicAgentEventStore(':memory:')
  stores.push(store)
  return store
}
const event = (sequence: number, streamId = 's'): MagicAgentEvent<unknown> => ({
  protocolVersion: '2.0.0',
  envelopeKind: 'event',
  id: `${streamId}-${sequence}`,
  streamId,
  sequence,
  type: 'test.event',
  createdAt: sequence,
  payload: { sequence }
})
const snapshot = (coveredSequence: number, snapshotVersion = 0): SnapshotInput => ({
  snapshotId: `snap-${snapshotVersion}`,
  streamId: 's',
  snapshotVersion,
  coveredSequence,
  stateType: 'counter',
  state: { value: coveredSequence + 1 },
  metadata: { source: 'test' },
  createdAt: snapshotVersion
})

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

describe('snapshot schema v2', () => {
  it('appends, gets, lists, counts, and deeply freezes snapshots', () => {
    const store = open()
    store.appendBatch([event(0)])
    expect(store.appendSnapshot(snapshot(0))).toMatchObject({ inserted: true })
    const value = store.getSnapshot('snap-0')!
    expect(store.getLatestSnapshot('s')).toEqual(value)
    expect(store.listSnapshots('s')).toEqual([value])
    expect(store.countSnapshots()).toBe(1)
    expect(Object.isFrozen(value)).toBe(true)
    expect(Object.isFrozen(value.state)).toBe(true)
  })

  it('allows exact snapshot replay', () => {
    const store = open()
    store.appendBatch([event(0)])
    expect(store.appendSnapshot(snapshot(0)).inserted).toBe(true)
    expect(store.appendSnapshot(snapshot(0)).inserted).toBe(false)
  })

  it('rejects snapshot identity conflict', () => {
    const store = open()
    store.appendBatch([event(0), event(1)])
    store.appendSnapshot(snapshot(0))
    expect(() => store.appendSnapshot({ ...snapshot(1, 1), snapshotId: 'snap-0' })).toThrow(
      EventStoreConflictError
    )
  })

  it('rejects snapshot version conflict', () => {
    const store = open()
    store.appendBatch([event(0), event(1)])
    store.appendSnapshot(snapshot(0))
    expect(() => store.appendSnapshot({ ...snapshot(1), snapshotId: 'other' })).toThrow(
      EventStoreConflictError
    )
  })

  it('requires strict snapshot monotonicity', () => {
    const store = open()
    store.appendBatch([event(0), event(1)])
    store.appendSnapshot(snapshot(1, 1))
    expect(() => store.appendSnapshot(snapshot(0, 2))).toThrow(EventStoreConflictError)
  })

  it('requires covered sequence to exist', () => {
    const store = open()
    store.appendBatch([event(0), event(2)])
    expect(() => store.appendSnapshot(snapshot(1))).toThrow(/existing stream event/)
  })

  it('allows -1 only for an empty stream', () => {
    const store = open()
    expect(store.appendSnapshot(snapshot(-1)).inserted).toBe(true)
    store.appendBatch([event(0, 'other')])
    expect(() =>
      store.appendSnapshot({ ...snapshot(-1), snapshotId: 'other-snap', streamId: 'other' })
    ).toThrow(EventStoreConflictError)
  })

  it('rejects JSON-unsafe snapshot state', () => {
    const store = open()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => store.appendSnapshot({ ...snapshot(-1), state: cyclic })).toThrow(TypeError)
  })

  it('rejects new events covered by a snapshot and rolls back the batch', () => {
    const store = open()
    store.appendBatch([event(0), event(10)])
    store.appendSnapshot(snapshot(10))
    expect(() => store.appendBatch([event(11), { ...event(5), id: 's-late-5' }])).toThrow(
      'event sequence is covered by snapshot'
    )
    expect(store.getEvent('s-11')).toBeUndefined()
    expect(store.countEvents()).toBe(2)
  })

  it('allows events after snapshot coverage', () => {
    const store = open()
    store.appendBatch(Array.from({ length: 11 }, (_, sequence) => event(sequence)))
    store.appendSnapshot(snapshot(10))
    expect(store.appendBatch([event(11)])[0].inserted).toBe(true)
  })

  it('allows exact replay of an old covered event', () => {
    const store = open()
    store.appendBatch(Array.from({ length: 11 }, (_, sequence) => event(sequence)))
    store.appendSnapshot(snapshot(10))
    expect(store.appendBatch([event(5)])[0].inserted).toBe(false)
  })

  it('recovers without a snapshot', () => {
    const store = open()
    store.appendBatch([event(0), event(1)])
    expect(store.recoverStream('s').events.map((item) => item.sequence)).toEqual([0, 1])
  })

  it('recovers latest snapshot and tail only', () => {
    const store = open()
    store.appendBatch([event(0), event(1), event(2)])
    store.appendSnapshot(snapshot(1))
    const bundle = store.recoverStream('s')
    expect(bundle.snapshot?.coveredSequence).toBe(1)
    expect(bundle.events.map((item) => item.sequence)).toEqual([2])
  })

  it('enforces recovery event limit', () => {
    const store = open()
    store.appendBatch([event(0)])
    expect(() => store.recoverStream('s', { eventLimit: 0 })).toThrow(/more than 0/)
  })

  it('validates list options', () => {
    const store = open()
    expect(() => store.listSnapshots('s', null as never)).toThrow(/plain object/)
    expect(() => store.listSnapshots('s', { limit: 0 })).toThrow(/between 1 and 1000/)
  })

  it('validates recovery options', () => {
    const store = open()
    expect(() => store.recoverStream('s', [] as never)).toThrow(/plain object/)
    expect(() => store.recoverStream('s', { eventLimit: 1001 })).toThrow(/between 0 and 1000/)
  })

  it('deep-freezes children below a pre-frozen root', () => {
    const nested = { child: { value: 1 } }
    Object.freeze(nested)
    deepFreeze(nested)
    expect(Object.isFrozen(nested.child)).toBe(true)
  })

  it('deep-freezes cyclic objects', () => {
    const value: { self?: unknown } = {}
    value.self = value
    expect(() => deepFreeze(value)).not.toThrow()
    expect(Object.isFrozen(value)).toBe(true)
  })

  it('restores deterministically and freezes final state', () => {
    const bundle: RecoveryBundle = { snapshot: null, events: [event(0), event(2)] }
    const result = restoreWithReducer(bundle, { total: 0 }, (state) => ({ total: state.total + 1 }))
    expect(result).toMatchObject({ state: { total: 2 }, lastSequence: 2 })
    expect(Object.isFrozen(result.state)).toBe(true)
  })

  it('rejects forged cross-stream bundles', () => {
    const bundle = { snapshot: null, events: [event(0), event(1, 'other')] } as RecoveryBundle
    expect(() => restoreWithReducer(bundle, 0, (state) => state + 1)).toThrow(/stream or sequence/)
  })

  it('rejects non-increasing forged bundles', () => {
    const bundle = { snapshot: null, events: [event(2), event(1)] } as RecoveryBundle
    expect(() => restoreWithReducer(bundle, 0, (state) => state + 1)).toThrow(/stream or sequence/)
  })

  it('wraps decoder errors with cause', () => {
    const error = new Error('decode')
    const bundle = { snapshot: { ...snapshot(-1), insertedAt: 0 }, events: [] }
    expect(() =>
      restoreWithReducer<number>(
        bundle,
        0,
        (state) => state,
        () => {
          throw error
        }
      )
    ).toThrow(RecoverySnapshotDecodeError)
    try {
      restoreWithReducer<number>(
        bundle,
        0,
        (state) => state,
        () => {
          throw error
        }
      )
    } catch (caught) {
      expect((caught as Error).cause).toBe(error)
    }
  })

  it('wraps reducer errors with cause', () => {
    const error = new Error('reduce')
    try {
      restoreWithReducer({ snapshot: null, events: [event(0)] }, 0, () => {
        throw error
      })
      throw new Error('expected failure')
    } catch (caught) {
      expect(caught).toBeInstanceOf(RecoveryReducerError)
      expect((caught as Error).cause).toBe(error)
    }
  })

  it('freezes events read from storage', () => {
    const store = open()
    store.appendBatch([event(0)])
    const stored = store.getEvent('s-0')!
    expect(Object.isFrozen(stored)).toBe(true)
    expect(Object.isFrozen(stored.payload)).toBe(true)
  })

  it('guards snapshot APIs after close', () => {
    const store = open()
    store.close()
    expect(() => store.countSnapshots()).toThrow(EventStoreClosedError)
    expect(() => store.getSnapshot('snap')).toThrow(EventStoreClosedError)
    expect(() => store.listSnapshots('s')).toThrow(EventStoreClosedError)
    expect(() => store.recoverStream('s')).toThrow(EventStoreClosedError)
  })
})
