import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type StoreMap = Map<string, Map<string, unknown>>

function cloneValue<T>(value: T): T {
  if (value !== undefined && typeof structuredClone === 'function') {
    return structuredClone(value)
  }
  return value === undefined ? value : JSON.parse(JSON.stringify(value))
}

class FakeIDBObjectStore {
  constructor(
    private stores: StoreMap,
    private storeName: string,
    private state: { failGetAllOnce: boolean; getAllCount: number; getCount: number }
  ) {}

  get(key: string): {
    result?: unknown
    error?: DOMException
    onsuccess?: () => void
    onerror?: () => void
  } {
    const request: {
      result?: unknown
      error?: DOMException
      onsuccess?: () => void
      onerror?: () => void
    } = {}

    setTimeout(() => {
      this.state.getCount += 1
      const value = this.stores.get(this.storeName)?.get(key)
      request.result = value === undefined ? undefined : cloneValue(value)
      request.onsuccess?.()
    }, 0)

    return request
  }

  getAll(): {
    result?: unknown[]
    error?: DOMException
    onsuccess?: () => void
    onerror?: () => void
  } {
    const request: {
      result?: unknown[]
      error?: DOMException
      onsuccess?: () => void
      onerror?: () => void
    } = {}

    setTimeout(() => {
      this.state.getAllCount += 1
      if (this.state.failGetAllOnce) {
        this.state.failGetAllOnce = false
        const error = new Error(
          'Data lost due to missing file. Affected record should be considered irrecoverable'
        )
        error.name = 'NotReadableError'
        request.error = error as DOMException
        request.onerror?.()
        return
      }

      request.result = [...(this.stores.get(this.storeName)?.values() || [])].map((value) =>
        cloneValue(value)
      )
      request.onsuccess?.()
    }, 0)

    return request
  }

  put(value: unknown): void {
    const key = (value as { id?: string }).id
    if (!key) {
      throw new Error('Missing fake IndexedDB keyPath value')
    }
    this.stores.get(this.storeName)?.set(key, cloneValue(value))
  }

  clear(): void {
    this.stores.get(this.storeName)?.clear()
  }

  delete(key: string): void {
    this.stores.get(this.storeName)?.delete(key)
  }
}

class FakeIDBTransaction {
  error: DOMException | null = null
  oncomplete: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(
    private stores: StoreMap,
    private state: { failGetAllOnce: boolean; getAllCount: number; getCount: number }
  ) {
    setTimeout(() => {
      this.oncomplete?.()
    }, 0)
  }

  objectStore(name: string): FakeIDBObjectStore {
    const store = this.stores.get(name)
    if (!store) {
      throw new Error(`Missing fake object store: ${name}`)
    }
    return new FakeIDBObjectStore(this.stores, name, this.state)
  }
}

class FakeIDBDatabase {
  onclose: (() => void) | null = null
  objectStoreNames: { contains: (name: string) => boolean }

  constructor(
    private stores: StoreMap,
    private state: { failGetAllOnce: boolean; getAllCount: number; getCount: number }
  ) {
    this.objectStoreNames = {
      contains: (name: string) => this.stores.has(name)
    }
  }

  createObjectStore(name: string): FakeIDBObjectStore {
    if (!this.stores.has(name)) {
      this.stores.set(name, new Map())
    }
    return new FakeIDBObjectStore(this.stores, name, this.state)
  }

  transaction(_name: string, _mode: string): FakeIDBTransaction {
    return new FakeIDBTransaction(this.stores, this.state)
  }

  close(): void {
    this.onclose?.()
  }
}

function createFakeIndexedDb() {
  const state = { failGetAllOnce: true, getAllCount: 0, getCount: 0 }
  const deletedNames: string[] = []
  let stores: StoreMap = new Map()
  let database: FakeIDBDatabase | null = null

  return {
    deletedNames,
    state,
    api: {
      open: (_name: string, _version: number) => {
        const request: {
          result?: FakeIDBDatabase
          error?: DOMException
          onupgradeneeded?: (event: { target: { result: FakeIDBDatabase } }) => void
          onsuccess?: () => void
          onerror?: () => void
        } = {}

        setTimeout(() => {
          if (!database) {
            database = new FakeIDBDatabase(stores, state)
            request.result = database
            request.onupgradeneeded?.({ target: { result: database } })
          }

          request.result = database
          request.onsuccess?.()
        }, 0)

        return request
      },
      deleteDatabase: (name: string) => {
        const request: {
          error?: DOMException
          onsuccess?: () => void
          onerror?: () => void
          onblocked?: () => void
        } = {}

        setTimeout(() => {
          deletedNames.push(name)
          stores = new Map()
          database = null
          request.onsuccess?.()
        }, 0)

        return request
      }
    }
  }
}

describe('chatStorage', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('loads a single normalized session by id without reading every session', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)

    const storage = await import('./chatStorage')

    await storage.saveSessionToDB(
      {
        id: 'session-1',
        title: 'Target session',
        messages: [],
        pendingSessionUrl: 'https://example.test/session-1'
      } as import('./chatStorage').ChatSession & { pendingSessionUrl: string },
      'default'
    )
    await storage.saveSessionToDB(
      {
        id: 'session-2',
        title: 'Other session',
        messages: []
      },
      'default'
    )

    await expect(storage.loadSessionFromDB('session-1', 'default')).resolves.toMatchObject({
      id: 'session-1',
      title: 'Target session',
      messages: [],
      sessionUrl: 'https://example.test/session-1',
      storageScope: 'default'
    })
    expect(fakeIndexedDb.state.getCount).toBe(1)
    expect(fakeIndexedDb.state.getAllCount).toBe(0)
    expect(fakeIndexedDb.deletedNames).toEqual([])
  })

  it('returns null for missing sessions and sessions in another storage scope', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)

    const storage = await import('./chatStorage')

    await storage.saveSessionToDB(
      {
        id: 'session-1',
        title: 'Scoped session',
        messages: []
      },
      'workspace-a'
    )

    await expect(storage.loadSessionFromDB('session-1', 'default')).resolves.toBeNull()
    await expect(storage.loadSessionFromDB('missing-session', 'workspace-a')).resolves.toBeNull()
    expect(fakeIndexedDb.state.getCount).toBe(2)
    expect(fakeIndexedDb.state.getAllCount).toBe(0)
  })

  it('resets corrupted IndexedDB storage after fatal read errors and accepts future saves', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    vi.stubGlobal('indexedDB', fakeIndexedDb.api)

    const storage = await import('./chatStorage')

    await expect(storage.loadAllSessions('default')).resolves.toEqual([])
    expect(fakeIndexedDb.deletedNames).toEqual(['magicpot-chat'])
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[ChatStorage] Reset corrupted IndexedDB database "magicpot-chat".'
    )

    await storage.saveSessionToDB(
      {
        id: 'session-1',
        title: 'Recovered session',
        messages: []
      },
      'default'
    )

    await expect(storage.loadAllSessions('default')).resolves.toMatchObject([
      {
        id: 'session-1',
        title: 'Recovered session',
        storageScope: 'default'
      }
    ])

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[ChatStorage] loadAllSessions failed: NotReadableError:')
    )
  })
})
