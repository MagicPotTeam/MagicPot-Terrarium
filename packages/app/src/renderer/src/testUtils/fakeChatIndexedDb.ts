import { FakeIDBKeyRange, installFakeIDBKeyRange } from './fakeIdbKeyRange'

/**
 * A small in-memory IndexedDB for the chat storage tests. Unlike the per-file fakes it keeps
 * records in primary-key order, honours key ranges in getAll / getAllKeys / openCursor, runs
 * versioned upgrades with an upgrade transaction, and records every record it hands to the page
 * (`handedOut`), so a test can prove which records a reader made the store deserialise.
 *
 * Supported keys: numbers and strings (numbers sort first, strings by UTF-16 code unit).
 */
export type FakeChatKey = string | number

type Row = { key: FakeChatKey; value: unknown }
type StoreData = { keyPath: string; rows: Row[] }
type Callback = (() => void) | null

/** A record the store refuses to hand out: reading it fails the request and is counted. */
export const POISONED_RECORD = Symbol('poisoned chat record')

export const compareFakeChatKeys = (a: unknown, b: unknown): number => {
  const rank = (key: unknown): number => {
    if (typeof key === 'number') return 0
    if (typeof key === 'string') return 1
    throw new DOMException('The parameter is not a valid key.', 'DataError')
  }
  const rankA = rank(a)
  const rankB = rank(b)
  if (rankA !== rankB) return rankA < rankB ? -1 : 1
  return (a as FakeChatKey) < (b as FakeChatKey)
    ? -1
    : (a as FakeChatKey) > (b as FakeChatKey)
      ? 1
      : 0
}

export interface FakeChatIndexedDbStats {
  /** Primary keys of the records whose values reached the page, in order, with repeats. */
  handedOut: FakeChatKey[]
  /** How often each store method was called. */
  calls: Record<'get' | 'getAll' | 'getAllKeys' | 'openCursor' | 'put' | 'delete', number>
  /** getAll / openCursor calls that were not limited by a key range. */
  unrangedValueScans: number
  poisonedReads: number
}

class FakeRequest<T> {
  result: T | undefined = undefined
  error: DOMException | null = null
  onsuccess: Callback = null
  onerror: Callback = null
  transaction: FakeTransaction | null = null
}

class FakeCursor {
  constructor(
    readonly key: FakeChatKey,
    readonly primaryKey: FakeChatKey,
    readonly value: unknown,
    private readonly advance: () => void
  ) {}
  continue(): void {
    this.advance()
  }
}

class FakeObjectStore {
  constructor(
    private readonly data: StoreData,
    private readonly tx: FakeTransaction,
    private readonly stats: FakeChatIndexedDbStats
  ) {}

  get keyPath(): string {
    return this.data.keyPath
  }

  private rowsIn(range?: FakeIDBKeyRange): Row[] {
    return range ? this.data.rows.filter((row) => range.includes(row.key)) : [...this.data.rows]
  }

  /** Returns false when the record is poisoned (the request must fail). */
  private handOut(row: Row, into: unknown[]): boolean {
    if (row.value === POISONED_RECORD) {
      this.stats.poisonedReads += 1
      return false
    }
    this.stats.handedOut.push(row.key)
    into.push(structuredClone(row.value))
    return true
  }

  private readFailure(): DOMException {
    return new DOMException('Poisoned record was read.', 'DataError')
  }

  get(key: FakeChatKey): FakeRequest<unknown> {
    this.stats.calls.get += 1
    return this.tx.request<unknown>((request) => {
      const row = this.data.rows.find((candidate) => compareFakeChatKeys(candidate.key, key) === 0)
      if (!row) return
      const out: unknown[] = []
      if (!this.handOut(row, out)) throw this.readFailure()
      request.result = out[0]
    })
  }

  getAll(range?: FakeIDBKeyRange): FakeRequest<unknown[]> {
    this.stats.calls.getAll += 1
    if (!range) this.stats.unrangedValueScans += 1
    return this.tx.request<unknown[]>((request) => {
      const out: unknown[] = []
      for (const row of this.rowsIn(range)) {
        if (!this.handOut(row, out)) throw this.readFailure()
      }
      request.result = out
    })
  }

  getAllKeys(range?: FakeIDBKeyRange): FakeRequest<FakeChatKey[]> {
    this.stats.calls.getAllKeys += 1
    return this.tx.request<FakeChatKey[]>((request) => {
      request.result = this.rowsIn(range).map((row) => row.key)
    })
  }

  openCursor(range?: FakeIDBKeyRange): FakeRequest<FakeCursor | null> {
    this.stats.calls.openCursor += 1
    if (!range) this.stats.unrangedValueScans += 1
    let lastKey: FakeChatKey | undefined
    const request = this.tx.request<FakeCursor | null>(() => step())
    // Like a real cursor, each step looks at the store as it is now, after the last key.
    const step = (): void => {
      const row = this.rowsIn(range).find(
        (candidate) => lastKey === undefined || compareFakeChatKeys(candidate.key, lastKey) > 0
      )
      if (!row) {
        request.result = null
        return
      }
      lastKey = row.key
      const out: unknown[] = []
      if (!this.handOut(row, out)) throw this.readFailure()
      request.result = new FakeCursor(row.key, row.key, out[0], () => this.tx.rerun(request, step))
    }
    return request
  }

  put(value: unknown): FakeRequest<FakeChatKey> {
    this.stats.calls.put += 1
    this.tx.assertWritable()
    const key = (value as Record<string, unknown>)[this.data.keyPath] as FakeChatKey
    compareFakeChatKeys(key, key)
    const stored = structuredClone(value)
    return this.tx.request<FakeChatKey>((request) => {
      const index = this.data.rows.findIndex((row) => compareFakeChatKeys(row.key, key) === 0)
      if (index >= 0) this.data.rows[index] = { key, value: stored }
      else {
        this.data.rows.push({ key, value: stored })
        this.data.rows.sort((a, b) => compareFakeChatKeys(a.key, b.key))
      }
      request.result = key
    })
  }

  delete(key: FakeChatKey): FakeRequest<undefined> {
    this.stats.calls.delete += 1
    this.tx.assertWritable()
    return this.tx.request<undefined>(() => {
      const index = this.data.rows.findIndex((row) => compareFakeChatKeys(row.key, key) === 0)
      if (index >= 0) this.data.rows.splice(index, 1)
    })
  }
}

class FakeTransaction {
  error: DOMException | null = null
  oncomplete: Callback = null
  onerror: Callback = null
  onabort: Callback = null
  private pending = 0
  private finished = false
  private readonly snapshot: Map<string, Row[]>

  constructor(
    private readonly stores: Map<string, StoreData>,
    readonly mode: 'readonly' | 'readwrite' | 'versionchange',
    private readonly stats: FakeChatIndexedDbStats,
    private readonly onFinished: (committed: boolean) => void = () => undefined
  ) {
    this.snapshot = new Map([...stores].map(([name, data]) => [name, [...data.rows]]))
    this.scheduleCommitCheck()
  }

  objectStore(name: string): FakeObjectStore {
    const data = this.stores.get(name)
    if (!data) throw new DOMException(`No objectStore named ${name}`, 'NotFoundError')
    return new FakeObjectStore(data, this, this.stats)
  }

  assertWritable(): void {
    if (this.finished)
      throw new DOMException('The transaction has finished.', 'TransactionInactiveError')
    if (this.mode === 'readonly')
      throw new DOMException('The transaction is read-only.', 'ReadOnlyError')
  }

  request<T>(run: (request: FakeRequest<T>) => void): FakeRequest<T> {
    if (this.finished)
      throw new DOMException('The transaction has finished.', 'TransactionInactiveError')
    const request = new FakeRequest<T>()
    request.transaction = this
    this.rerun(request, () => run(request))
    return request
  }

  /** Queue one more result for a request (a cursor step). */
  rerun<T>(request: FakeRequest<T>, run: () => void): void {
    if (this.finished)
      throw new DOMException('The transaction has finished.', 'TransactionInactiveError')
    this.pending += 1
    setTimeout(() => {
      if (this.finished) return
      let failure: DOMException | null = null
      try {
        run()
      } catch (error) {
        failure = error as DOMException
      }
      try {
        if (failure) {
          request.error = failure
          request.onerror?.()
          this.fail(failure)
        } else {
          request.onsuccess?.()
        }
      } catch (error) {
        // An exception in a handler aborts the transaction, as in a browser.
        this.fail(error as DOMException)
      }
      this.pending -= 1
      this.scheduleCommitCheck()
    }, 0)
  }

  abort(): void {
    if (this.finished) throw new DOMException('The transaction has finished.', 'InvalidStateError')
    this.rollback()
    setTimeout(() => this.onabort?.(), 0)
  }

  private fail(error: DOMException): void {
    if (this.finished) return
    this.error = error
    this.rollback()
    setTimeout(() => {
      this.onerror?.()
      this.onabort?.()
    }, 0)
  }

  private rollback(): void {
    this.finished = true
    for (const [name, rows] of this.snapshot) {
      const data = this.stores.get(name)
      if (data) data.rows = [...rows]
    }
    this.onFinished(false)
  }

  private scheduleCommitCheck(): void {
    setTimeout(() => {
      if (this.finished || this.pending > 0) return
      this.finished = true
      this.onFinished(true)
      this.oncomplete?.()
    }, 0)
  }
}

class FakeDatabase {
  onclose: Callback = null
  onversionchange: Callback = null
  closed = false

  constructor(
    readonly name: string,
    public version: number,
    private readonly stores: Map<string, StoreData>,
    private readonly stats: FakeChatIndexedDbStats
  ) {}

  get objectStoreNames(): { contains: (name: string) => boolean } {
    return { contains: (name: string) => this.stores.has(name) }
  }

  createObjectStore(name: string, options: { keyPath: string }): FakeObjectStore {
    if (!this.upgradeTransaction) {
      throw new DOMException('Not in a version change transaction.', 'InvalidStateError')
    }
    const data: StoreData = { keyPath: options.keyPath, rows: [] }
    this.stores.set(name, data)
    return this.upgradeTransaction.objectStore(name)
  }

  upgradeTransaction: FakeTransaction | null = null

  transaction(name: string, mode: 'readonly' | 'readwrite' = 'readonly'): FakeTransaction {
    if (this.closed)
      throw new DOMException('The database connection is closing.', 'InvalidStateError')
    if (!this.stores.has(name))
      throw new DOMException(`No objectStore named ${name}`, 'NotFoundError')
    return new FakeTransaction(this.stores, mode, this.stats)
  }

  close(): void {
    this.closed = true
  }
}

export interface FakeChatIndexedDb {
  stats: FakeChatIndexedDbStats
  /** Create or replace a store without going through an upgrade (seeding a fixture). */
  seedStore(name: string, keyPath: string, records: unknown[]): void
  /** Put raw rows under explicit keys, including keys that do not match the record. */
  seedRows(name: string, rows: Array<{ key: FakeChatKey; value: unknown }>): void
  /** Declare the version the stored database already has (0 = does not exist yet). */
  setVersion(version: number): void
  keys(name: string): FakeChatKey[]
  values(name: string): unknown[]
  resetStats(): void
  /** Stub indexedDB and IDBKeyRange for the current test. */
  install(stubGlobal: (name: string, value: unknown) => unknown): void
}

export function createFakeChatIndexedDb(): FakeChatIndexedDb {
  const stores = new Map<string, StoreData>()
  let version = 0
  const freshCalls = (): FakeChatIndexedDbStats['calls'] => ({
    get: 0,
    getAll: 0,
    getAllKeys: 0,
    openCursor: 0,
    put: 0,
    delete: 0
  })
  const stats: FakeChatIndexedDbStats = {
    handedOut: [],
    calls: freshCalls(),
    unrangedValueScans: 0,
    poisonedReads: 0
  }

  const api = {
    cmp: compareFakeChatKeys,
    open(name: string, requestedVersion?: number) {
      const request: {
        result?: FakeDatabase
        error?: DOMException | null
        transaction?: FakeTransaction | null
        onupgradeneeded?: ((event: { target: unknown }) => void) | null
        onsuccess?: Callback
        onerror?: Callback
        onblocked?: Callback
      } = {}
      setTimeout(() => {
        const target = requestedVersion ?? (version || 1)
        const db = new FakeDatabase(name, target, stores, stats)
        request.result = db
        const succeed = (): void => {
          request.transaction = null
          db.upgradeTransaction = null
          request.onsuccess?.()
        }
        if (target <= version) {
          succeed()
          return
        }
        const upgrade = new FakeTransaction(stores, 'versionchange', stats, (committed) => {
          if (!committed) {
            request.error = upgrade.error
            request.onerror?.()
            return
          }
          version = target
          succeed()
        })
        db.upgradeTransaction = upgrade
        request.transaction = upgrade
        request.onupgradeneeded?.({ target: request })
      }, 0)
      return request
    }
  }

  return {
    stats,
    seedStore(name, keyPath, records) {
      const rows = records.map((value) => ({
        key: (value as Record<string, unknown>)[keyPath] as FakeChatKey,
        value: structuredClone(value)
      }))
      rows.sort((a, b) => compareFakeChatKeys(a.key, b.key))
      stores.set(name, { keyPath, rows })
    },
    seedRows(name, rows) {
      const data = stores.get(name)
      if (!data) throw new Error(`Seed the store ${name} first`)
      for (const row of rows) {
        const value = row.value === POISONED_RECORD ? row.value : structuredClone(row.value)
        const index = data.rows.findIndex(
          (existing) => compareFakeChatKeys(existing.key, row.key) === 0
        )
        if (index >= 0) data.rows[index] = { key: row.key, value }
        else data.rows.push({ key: row.key, value })
      }
      data.rows.sort((a, b) => compareFakeChatKeys(a.key, b.key))
    },
    setVersion(next) {
      version = next
    },
    keys: (name) => (stores.get(name)?.rows ?? []).map((row) => row.key),
    values: (name) => (stores.get(name)?.rows ?? []).map((row) => row.value),
    resetStats() {
      stats.handedOut = []
      stats.calls = freshCalls()
      stats.unrangedValueScans = 0
      stats.poisonedReads = 0
    },
    install(stubGlobal) {
      installFakeIDBKeyRange()
      stubGlobal('indexedDB', api)
    }
  }
}
