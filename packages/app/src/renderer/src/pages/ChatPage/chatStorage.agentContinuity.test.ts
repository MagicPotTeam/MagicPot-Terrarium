import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const managedMediaApiMock = vi.hoisted(() => ({
  migrateLegacyDataUrl: vi.fn(),
  reclaimLegacyMigration: vi.fn()
}))

vi.mock('../../utils/windowUtils', () => ({
  api: () => ({ svcManagedMedia: managedMediaApiMock })
}))

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
    private state: {
      failGetAllOnce: boolean
      failPutOnce: boolean
      getAllCount: number
      getCount: number
      putCount: number
      clearCount: number
    }
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

  private pendingError: DOMException | null = null

  consumeError(): DOMException | null {
    const error = this.pendingError
    this.pendingError = null
    return error
  }

  put(value: unknown): void {
    if (this.state.failPutOnce) {
      this.state.failPutOnce = false
      this.pendingError = new DOMException('Injected IndexedDB put failure', 'UnknownError')
      return
    }
    const record = value as { storageKey?: string; id?: string }
    const key = record.storageKey || record.id
    if (!key) {
      throw new Error('Missing fake IndexedDB keyPath value')
    }
    this.state.putCount += 1
    this.stores.get(this.storeName)?.set(key, cloneValue(value))
  }

  clear(): void {
    this.state.clearCount += 1
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
    private state: {
      failGetAllOnce: boolean
      failPutOnce: boolean
      getAllCount: number
      getCount: number
      putCount: number
      clearCount: number
    }
  ) {
    setTimeout(() => {
      if (!this.error) this.oncomplete?.()
    }, 5)
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
  onversionchange: (() => void) | null = null
  objectStoreNames: { contains: (name: string) => boolean }

  constructor(
    private stores: StoreMap,
    private state: {
      failGetAllOnce: boolean
      failPutOnce: boolean
      getAllCount: number
      getCount: number
      putCount: number
      clearCount: number
    }
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
    const tx = new FakeIDBTransaction(this.stores, this.state)
    const originalObjectStore = tx.objectStore.bind(tx)
    tx.objectStore = (name: string) => {
      const store = originalObjectStore(name)
      const originalPut = store.put.bind(store)
      store.put = (value: unknown) => {
        originalPut(value)
        const error = store.consumeError()
        if (error) {
          tx.error = error
          setTimeout(() => tx.onerror?.(), 0)
        }
      }
      return store
    }
    return tx
  }

  close(): void {
    this.onclose?.()
  }
}

function createFakeIndexedDb() {
  const state = {
    failGetAllOnce: true,
    failPutOnce: false,
    getAllCount: 0,
    getCount: 0,
    putCount: 0,
    clearCount: 0
  }
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
          onblocked?: () => void
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

describe('chatStorage agent continuity persistence', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
    managedMediaApiMock.migrateLegacyDataUrl.mockReset()
    managedMediaApiMock.reclaimLegacyMigration.mockReset()
    localStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('persists and reloads a thread media snapshot without cross-scope leakage', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    fakeIndexedDb.state.failGetAllOnce = false
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)
    const storage = await import('./chatStorage')
    const scope = 'fixture-project.agent-1'
    const otherScope = 'fixture-project.agent-2'
    const route = {
      channel: 'canvas',
      scopeType: 'thread',
      scopeId: 'fixture-project',
      threadId: 'agent-1'
    }
    const media = {
      version: 1 as const,
      kind: 'managed' as const,
      relativePath: 'originals/aa/fixture.png',
      sha256: 'a'.repeat(64),
      sizeBytes: 13,
      mimeType: 'image/png',
      originalFileName: 'fixture.png'
    }
    const firstRoundImage = {
      type: 'image' as const,
      url: 'local-media:///managed/originals/aa/fixture.png',
      fileName: 'fixture.png',
      mimeType: 'image/png',
      media
    }
    const snapshot = {
      id: 'fixture-session',
      title: 'Fixture Agent thread',
      storageScope: scope,
      profileId: 'fixture-agent-profile',
      skillId: 'fixture-agent',
      sessionUrl: 'https://fixture.invalid/session/1',
      sessionProfileId: 'fixture-agent-profile',
      sessionRouteFingerprint: 'canvas:thread:fixture-project:agent-1',
      messages: [
        { role: 'user' as const, content: 'Read this image.', attachments: [firstRoundImage] },
        { role: 'assistant' as const, content: 'round one' },
        { role: 'user' as const, content: 'Follow up without attaching it again.' }
      ]
    }

    await storage.saveSessionToDB(snapshot, scope)
    const releasedSnapshot = structuredClone(snapshot)
    expect(releasedSnapshot.messages[0]?.attachments?.[0]).toMatchObject({
      url: firstRoundImage.url,
      media
    })

    const restored = await storage.loadAllSessions(scope)
    expect(restored).toHaveLength(1)
    expect(restored[0]).toMatchObject({
      id: snapshot.id,
      storageScope: scope,
      sessionUrl: snapshot.sessionUrl,
      sessionProfileId: snapshot.sessionProfileId,
      sessionRouteFingerprint: snapshot.sessionRouteFingerprint
    })
    expect(restored[0]?.messages[0]?.attachments?.[0]).toMatchObject({
      type: 'image',
      url: firstRoundImage.url,
      media
    })
    expect(restored[0]?.messages[2]).toMatchObject({
      role: 'user',
      content: 'Follow up without attaching it again.'
    })

    await expect(storage.loadAllSessions(otherScope)).resolves.toEqual([])

    await storage.saveSessionToDB(
      { ...snapshot, id: 'other-session', storageScope: otherScope, messages: [] },
      otherScope
    )
    await expect(storage.loadAllSessions(scope)).resolves.toHaveLength(1)
    await expect(storage.loadAllSessions(otherScope)).resolves.toMatchObject([
      { id: 'other-session', storageScope: otherScope, messages: [] }
    ])
  })
})
