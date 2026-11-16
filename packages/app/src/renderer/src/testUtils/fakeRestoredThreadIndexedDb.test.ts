import { describe, expect, it } from 'vitest'
import {
  createFakeRestoredThreadIndexedDb,
  type FakeRestoredThreadIDBDatabase
} from './fakeRestoredThreadIndexedDb'

const STORE = 'sessions'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Block the event loop, as a long React render does. */
const stall = (ms: number): void => {
  const end = performance.now() + ms
  while (performance.now() < end) {
    /* busy wait */
  }
}

const openDatabase = async (): Promise<FakeRestoredThreadIDBDatabase> => {
  const fake = createFakeRestoredThreadIndexedDb()
  return new Promise((resolve) => {
    const request = fake.api.open('chat', 1)
    request.onupgradeneeded = (event) => {
      event.target.result.createObjectStore(STORE)
    }
    request.onsuccess = () => resolve(request.result as FakeRestoredThreadIDBDatabase)
  })
}

describe('fakeRestoredThreadIndexedDb transactions', () => {
  it('never completes a transaction before the callback of its own get, even when an older transaction is pending and the loop stalls for 15 ms', async () => {
    const db = await openDatabase()
    const seed = db.transaction(STORE, 'readwrite')
    seed.objectStore(STORE).put({ storageKey: 'session', value: 1 })
    await db.waitForTransactions()

    // The per-file fake this replaces completed on a fixed 8 ms timer; with an older 8 ms timer
    // pending and a stall, Node ran that timer list first and the save's transaction reported
    // complete before its compare callback (about 8 inversions in 10 trials).
    for (let trial = 0; trial < 10; trial += 1) {
      const order: string[] = []
      const older = db.transaction(STORE, 'readonly')
      older.oncomplete = () => order.push('older complete')
      await sleep(7)
      const tx = db.transaction(STORE, 'readwrite')
      const request = tx.objectStore(STORE).get('session')
      request.onsuccess = () => order.push(`get ${(request.result as { value: number }).value}`)
      tx.oncomplete = () => order.push('complete')
      stall(15)
      await db.waitForTransactions()
      expect(order.indexOf('get 1')).toBeGreaterThanOrEqual(0)
      expect(order.indexOf('complete')).toBeGreaterThan(order.indexOf('get 1'))
    }
  })

  it('keeps a transaction open for a get issued inside a request callback', async () => {
    const db = await openDatabase()
    const seed = db.transaction(STORE, 'readwrite')
    seed.objectStore(STORE).put({ storageKey: 'first', value: 1 })
    seed.objectStore(STORE).put({ storageKey: 'second', value: 2 })
    await db.waitForTransactions()

    const order: string[] = []
    const tx = db.transaction(STORE, 'readonly')
    const store = tx.objectStore(STORE)
    const first = store.get('first')
    first.onsuccess = () => {
      order.push('first')
      // Past the 8 ms minimum by the time the chained request is issued.
      stall(15)
      const second = store.get('second')
      expect(tx.pendingRequests).toBe(2)
      second.onsuccess = () => {
        order.push('second')
        const keys = store.getAllKeys()
        keys.onsuccess = () => order.push(`keys ${(keys.result || []).join(',')}`)
      }
    }
    tx.oncomplete = () => order.push('complete')

    await db.waitForTransactions()
    expect(order).toEqual(['first', 'second', 'keys first,second', 'complete'])
    expect(tx.pendingRequests).toBe(0)
  })

  it('still completes a transaction without requests after its 8 ms minimum', async () => {
    const db = await openDatabase()
    const order: string[] = []
    const startedAt = performance.now()
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put({ storageKey: 'session', value: 1 })
    tx.oncomplete = () => order.push('complete')
    await sleep(0)
    expect(order).toEqual([])
    await db.waitForTransactions()
    expect(order).toEqual(['complete'])
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(7)
  })
})
