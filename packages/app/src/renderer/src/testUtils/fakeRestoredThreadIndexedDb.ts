import type { FakeIDBKeyRange } from './fakeIdbKeyRange'

/**
 * Test-only in-memory IndexedDB for the restored agent thread page tests. It isolates the real
 * chatStorage API in jsdom; it is not an Electron restart or a claim about a real desktop
 * IndexedDB process surviving termination.
 *
 * Unlike the per-file fakes it replaces, a transaction cannot complete while one of its requests
 * is pending, as in a browser: every get / getAll / getAllKeys takes a hold on its transaction
 * synchronously when it is issued and releases it only after its onsuccess / onerror has returned,
 * so a request issued inside a callback keeps the transaction open. oncomplete fires once no hold
 * remains and at least `minimumLifetimeMs` (8 ms, the old fixed timer) have passed.
 *
 * Everything else behaves as the per-file fakes did: put and delete apply synchronously, the
 * database is created on the first open, and waitForTransactions() waits until every transaction
 * has settled. Callers needing key order, cursors, versioned upgrades or read statistics use
 * fakeChatIndexedDb.ts instead.
 */

type StoreMap = Map<string, Map<string, unknown>>

export type FakeRestoredThreadIndexedDbState = {
  stores: StoreMap
  database: FakeRestoredThreadIDBDatabase | null
}

type FakeRequest<T> = {
  result?: T
  error?: DOMException
  onsuccess?: () => void
  onerror?: () => void
}

/** Returns the release function of a hold taken on the request's transaction. */
type TakeHold = () => () => void

const DEFAULT_MINIMUM_LIFETIME_MS = 8

const cloneValue = <T>(value: T): T => {
  if (value === undefined) return value
  if (typeof structuredClone === 'function') return structuredClone(value)
  return JSON.parse(JSON.stringify(value)) as T
}

export class FakeRestoredThreadIDBObjectStore {
  constructor(
    private readonly stores: StoreMap,
    private readonly storeName: string,
    private readonly takeHold: TakeHold = () => () => undefined
  ) {}

  /** Run a read on the next timer turn, holding the transaction until its callback returned. */
  private read<T>(produce: () => T): FakeRequest<T> {
    const request: FakeRequest<T> = {}
    const release = this.takeHold()
    setTimeout(() => {
      try {
        request.result = produce()
        request.onsuccess?.()
      } finally {
        release()
      }
    }, 0)
    return request
  }

  get(key: string): FakeRequest<unknown> {
    return this.read(() => {
      const value = this.stores.get(this.storeName)?.get(key)
      return value === undefined ? undefined : cloneValue(value)
    })
  }

  getAll(range?: FakeIDBKeyRange): FakeRequest<unknown[]> {
    return this.read(() =>
      [...(this.stores.get(this.storeName)?.entries() || [])]
        .filter(([key]) => !range || range.includes(key))
        .map(([, value]) => cloneValue(value))
    )
  }

  /** Keys only; the scoped readers use it once per connection to look for stray keys. */
  getAllKeys(): FakeRequest<string[]> {
    return this.read(() => [...(this.stores.get(this.storeName)?.keys() || [])])
  }

  put(value: unknown): void {
    const record = value as { storageKey?: string; id?: string }
    const key = record.storageKey || record.id
    if (!key) throw new Error('Missing fake IndexedDB keyPath value')
    this.stores.get(this.storeName)?.set(key, cloneValue(value))
  }

  delete(key: string): void {
    this.stores.get(this.storeName)?.delete(key)
  }
}

export class FakeRestoredThreadIDBTransaction {
  error: DOMException | null = null
  oncomplete: (() => void) | null = null
  onerror: (() => void) | null = null

  readonly completed: Promise<void>

  private holds = 0
  private minimumLifetimeElapsed = false
  private finish: (() => void) | null = null

  constructor(
    private readonly stores: StoreMap,
    minimumLifetimeMs = DEFAULT_MINIMUM_LIFETIME_MS
  ) {
    this.completed = new Promise((resolve) => {
      this.finish = () => {
        this.finish = null
        if (!this.error) this.oncomplete?.()
        resolve()
      }
    })
    setTimeout(() => {
      this.minimumLifetimeElapsed = true
      this.settle()
    }, minimumLifetimeMs)
  }

  /** Requests still holding this transaction open (issued, callback not yet returned). */
  get pendingRequests(): number {
    return this.holds
  }

  objectStore(name: string): FakeRestoredThreadIDBObjectStore {
    if (!this.stores.has(name)) throw new Error(`Missing fake object store: ${name}`)
    return new FakeRestoredThreadIDBObjectStore(this.stores, name, () => this.takeHold())
  }

  private takeHold(): () => void {
    this.holds += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.holds -= 1
      this.settle()
    }
  }

  private settle(): void {
    if (this.minimumLifetimeElapsed && this.holds === 0) this.finish?.()
  }
}

export class FakeRestoredThreadIDBDatabase {
  onclose: (() => void) | null = null
  onversionchange: (() => void) | null = null
  readonly objectStoreNames = {
    contains: (name: string): boolean => this.state.stores.has(name)
  }

  private readonly pendingTransactions = new Set<Promise<void>>()

  constructor(private readonly state: FakeRestoredThreadIndexedDbState) {}

  async waitForTransactions(): Promise<void> {
    while (this.pendingTransactions.size) await Promise.all([...this.pendingTransactions])
  }

  createObjectStore(name: string): FakeRestoredThreadIDBObjectStore {
    if (!this.state.stores.has(name)) this.state.stores.set(name, new Map())
    return new FakeRestoredThreadIDBObjectStore(this.state.stores, name)
  }

  transaction(name: string, _mode: string): FakeRestoredThreadIDBTransaction {
    if (!this.state.stores.has(name)) throw new Error(`Missing fake transaction store: ${name}`)
    const transaction = new FakeRestoredThreadIDBTransaction(this.state.stores)
    this.pendingTransactions.add(transaction.completed)
    void transaction.completed.then(() => this.pendingTransactions.delete(transaction.completed))
    return transaction
  }

  close(): void {
    this.onclose?.()
  }
}

export const createFakeRestoredThreadIndexedDb = () => {
  const state: FakeRestoredThreadIndexedDbState = {
    stores: new Map(),
    database: null
  }

  return {
    api: {
      open: (_name: string, _version: number) => {
        const request: {
          result?: FakeRestoredThreadIDBDatabase
          error?: DOMException
          transaction?: unknown
          onupgradeneeded?: (event: { target: { result: FakeRestoredThreadIDBDatabase } }) => void
          onsuccess?: () => void
          onerror?: () => void
          onblocked?: () => void
        } = {}

        setTimeout(() => {
          if (!state.database) {
            state.database = new FakeRestoredThreadIDBDatabase(state)
            request.result = state.database
            request.onupgradeneeded?.({ target: { result: state.database } })
          }
          request.result = state.database
          request.onsuccess?.()
        }, 0)

        return request
      },
      deleteDatabase: (_name: string) => {
        const request: {
          onsuccess?: () => void
          onerror?: () => void
          onblocked?: () => void
        } = {}
        setTimeout(() => request.onsuccess?.(), 0)
        return request
      }
    },
    state
  }
}

export type FakeRestoredThreadIndexedDb = ReturnType<typeof createFakeRestoredThreadIndexedDb>
