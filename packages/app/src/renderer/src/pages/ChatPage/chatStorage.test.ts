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

describe('chatStorage', () => {
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

  it('persists scoped delete tombstones across remounts', async () => {
    const storage = await import('./chatStorage')

    storage.setSessionDeleteTombstone('session-a', 'workspace-a')
    storage.setSessionDeleteTombstone('session-b', 'workspace-b')
    localStorage.setItem('magicpot-chat-delete-tombstone:%E0%A4%A:broken', '1')

    expect(storage.readSessionDeleteTombstones()).toEqual(
      expect.arrayContaining([
        { scope: 'workspace-a', sessionId: 'session-a' },
        { scope: 'workspace-b', sessionId: 'session-b' }
      ])
    )

    storage.setSessionDeleteTombstone('session-a', 'workspace-a', false)
    expect(storage.readSessionDeleteTombstones()).toEqual([
      { scope: 'workspace-b', sessionId: 'session-b' }
    ])
    storage.setSessionDeleteTombstone('session-b', 'workspace-b', false)
    localStorage.removeItem('magicpot-chat-delete-tombstone:%E0%A4%A:broken')
    expect(storage.readSessionDeleteTombstones()).toEqual([])
  })

  it('debounces targeted session upserts without scanning or clearing the store', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    fakeIndexedDb.state.failGetAllOnce = false
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)
    const storage = await import('./chatStorage')

    await storage.saveSessionToDB({ id: 'session-a', title: 'A', messages: [] }, 'workspace-a')
    await storage.saveSessionToDB({ id: 'session-b', title: 'B', messages: [] }, 'workspace-a')
    await storage.saveSessionToDB(
      { id: 'session-other', title: 'Other', messages: [] },
      'workspace-b'
    )
    const baselinePutCount = fakeIndexedDb.state.putCount

    storage.debouncedSaveSessions(
      [{ id: 'session-a', title: 'A updated', messages: [] }],
      1,
      'workspace-a'
    )
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(fakeIndexedDb.state.getAllCount).toBe(0)
    expect(fakeIndexedDb.state.clearCount).toBe(0)
    expect(fakeIndexedDb.state.putCount - baselinePutCount).toBe(1)
    await expect(storage.loadSessionFromDB('session-a', 'workspace-a')).resolves.toMatchObject({
      title: 'A updated'
    })
    await expect(storage.loadSessionFromDB('session-b', 'workspace-a')).resolves.toMatchObject({
      title: 'B'
    })
    await expect(storage.loadSessionFromDB('session-other', 'workspace-b')).resolves.toMatchObject({
      title: 'Other'
    })
  })

  it('does not resurrect a session deleted before its debounced save fires', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    fakeIndexedDb.state.failGetAllOnce = false
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)
    const storage = await import('./chatStorage')

    storage.debouncedSaveSessions(
      [{ id: 'session-delete', title: 'pending', messages: [] }],
      10,
      'workspace-a'
    )
    await storage.deleteSessionFromDB('session-delete', 'workspace-a')
    await new Promise((resolve) => setTimeout(resolve, 20))

    await expect(storage.loadSessionFromDB('session-delete', 'workspace-a')).resolves.toBeNull()
    expect(fakeIndexedDb.state.putCount).toBe(0)
  })

  it('does not resurrect tombstoned sessions during localStorage migration', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    fakeIndexedDb.state.failGetAllOnce = false
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)
    const storage = await import('./chatStorage')

    storage.setSessionDeleteTombstone('legacy-deleted', 'default')
    localStorage.setItem(
      'chat.sessions',
      JSON.stringify([{ id: 'legacy-deleted', title: 'Legacy deleted', messages: [] }])
    )

    await storage.migrateFromLocalStorage()

    await expect(storage.loadSessionFromDB('legacy-deleted', 'default')).resolves.toBeNull()
    expect(fakeIndexedDb.state.putCount).toBe(0)
  })

  it('does not resurrect a deleted session through a later immediate save', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    fakeIndexedDb.state.failGetAllOnce = false
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)
    const storage = await import('./chatStorage')

    storage.setSessionDeleteTombstone('session-delete-immediate', 'workspace-a')
    await storage.deleteSessionFromDB('session-delete-immediate', 'workspace-a')
    await storage.saveSessionToDB(
      { id: 'session-delete-immediate', title: 'stale writer', messages: [] },
      'workspace-a'
    )

    await expect(
      storage.loadSessionFromDB('session-delete-immediate', 'workspace-a')
    ).resolves.toBeNull()
    expect(fakeIndexedDb.state.putCount).toBe(0)
  })

  it('lets an immediate save supersede an older debounced snapshot', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    fakeIndexedDb.state.failGetAllOnce = false
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)
    const storage = await import('./chatStorage')

    storage.debouncedSaveSessions(
      [{ id: 'session-order', title: 'stale', messages: [] }],
      10,
      'workspace-a'
    )
    await storage.saveSessionToDB(
      { id: 'session-order', title: 'current', messages: [] },
      'workspace-a'
    )
    await new Promise((resolve) => setTimeout(resolve, 20))

    await expect(storage.loadSessionFromDB('session-order', 'workspace-a')).resolves.toMatchObject({
      title: 'current'
    })
    expect(fakeIndexedDb.state.putCount).toBe(1)
  })

  it('single-flights concurrent legacy media migration reads', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    fakeIndexedDb.state.failGetAllOnce = false
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)
    const storage = await import('./chatStorage')
    const legacyDataUrl = 'data:image/png;base64,AAAA'
    const reference = {
      version: 1 as const,
      kind: 'managed' as const,
      id: 'a'.repeat(64),
      relativePath: `originals/${'a'.repeat(64)}.png`,
      mimeType: 'image/png',
      originalFileName: 'legacy.png'
    }
    let releaseMigration: (() => void) | undefined
    managedMediaApiMock.migrateLegacyDataUrl.mockReturnValue(
      new Promise((resolve) => {
        releaseMigration = () =>
          resolve({
            reference,
            localMediaUrl: 'local-media:///originals/legacy.png',
            createdNewOriginal: true,
            createdNewMetadata: true
          })
      })
    )

    await storage.saveSessionToDB(
      {
        id: 'legacy-single-flight',
        title: 'Legacy',
        messages: [
          {
            role: 'user',
            content: '',
            attachments: [{ type: 'image', url: legacyDataUrl, fileName: 'legacy.png' }]
          }
        ]
      },
      'workspace-a'
    )

    const firstRead = storage.loadSessionFromDB('legacy-single-flight', 'workspace-a')
    const secondRead = storage.loadSessionFromDB('legacy-single-flight', 'workspace-a')
    await vi.waitFor(() => expect(managedMediaApiMock.migrateLegacyDataUrl).toHaveBeenCalledOnce())
    releaseMigration?.()

    const [first, second] = await Promise.all([firstRead, secondRead])
    expect(managedMediaApiMock.migrateLegacyDataUrl).toHaveBeenCalledOnce()
    expect(first?.messages[0]?.attachments?.[0]).toMatchObject({
      url: 'local-media:///originals/legacy.png',
      media: reference
    })
    expect(second).toEqual(first)
  })

  it('reclaims newly migrated media when persistence replacement fails', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    fakeIndexedDb.state.failGetAllOnce = false
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)
    const storage = await import('./chatStorage')
    const legacyDataUrl = 'data:image/png;base64,AAAA'
    const reference = {
      version: 1 as const,
      kind: 'managed' as const,
      sha256: 'd'.repeat(64),
      relativePath: `originals/dd/${'d'.repeat(64)}.png`,
      sizeBytes: 1024,
      mimeType: 'image/png',
      originalFileName: 'legacy.png'
    }
    const checkpoint = {
      version: 1 as const,
      reclaim: { reference }
    }
    managedMediaApiMock.migrateLegacyDataUrl.mockResolvedValue({
      reference,
      localMediaUrl: 'local-media:///originals/dd/legacy.png',
      checkpoint
    })

    await storage.saveSessionToDB(
      {
        id: 'legacy-persist-failure',
        title: 'Legacy persistence failure',
        messages: [
          {
            role: 'user',
            content: '',
            attachments: [{ type: 'image', url: legacyDataUrl, fileName: 'legacy.png' }]
          }
        ]
      },
      'workspace-a'
    )
    fakeIndexedDb.state.failPutOnce = true

    const loaded = await storage.loadSessionFromDB('legacy-persist-failure', 'workspace-a')

    expect(loaded?.messages[0]?.attachments?.[0]).toMatchObject({ url: legacyDataUrl })
    expect(managedMediaApiMock.reclaimLegacyMigration).toHaveBeenCalledWith(checkpoint)
  })

  it('keeps legacy inline media unchanged when managed migration fails', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    fakeIndexedDb.state.failGetAllOnce = false
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)
    const storage = await import('./chatStorage')
    const legacyDataUrl = 'data:image/png;base64,AAAA'
    managedMediaApiMock.migrateLegacyDataUrl.mockRejectedValue(new Error('migration unavailable'))

    await storage.saveSessionToDB(
      {
        id: 'legacy-migration-failure',
        title: 'Legacy failure',
        messages: [
          {
            role: 'user',
            content: '',
            attachments: [{ type: 'image', url: legacyDataUrl, fileName: 'legacy.png' }]
          }
        ]
      },
      'workspace-a'
    )

    const loaded = await storage.loadSessionFromDB('legacy-migration-failure', 'workspace-a')

    expect(loaded?.messages[0]?.attachments?.[0]).toMatchObject({ url: legacyDataUrl })
    expect(managedMediaApiMock.reclaimLegacyMigration).not.toHaveBeenCalled()
  })

  it('keeps sessions with the same id isolated by storage scope', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    fakeIndexedDb.state.failGetAllOnce = false
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)
    const storage = await import('./chatStorage')

    await storage.saveSessionToDB(
      { id: 'shared-session', title: 'Workspace A', messages: [] },
      'workspace-a'
    )
    await storage.saveSessionToDB(
      { id: 'shared-session', title: 'Workspace B', messages: [] },
      'workspace-b'
    )

    await expect(storage.loadSessionFromDB('shared-session', 'workspace-a')).resolves.toMatchObject(
      {
        title: 'Workspace A'
      }
    )
    await expect(storage.loadSessionFromDB('shared-session', 'workspace-b')).resolves.toMatchObject(
      {
        title: 'Workspace B'
      }
    )

    await storage.deleteSessionFromDB('shared-session', 'workspace-b')
    await expect(storage.loadSessionFromDB('shared-session', 'workspace-a')).resolves.toMatchObject(
      {
        title: 'Workspace A'
      }
    )
    await expect(storage.loadSessionFromDB('shared-session', 'workspace-b')).resolves.toBeNull()
  })

  it('coalesces repeated debounced updates and keeps only the latest callback', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    fakeIndexedDb.state.failGetAllOnce = false
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)
    const storage = await import('./chatStorage')
    const firstCallback = vi.fn()
    const latestCallback = vi.fn()

    storage.debouncedSaveSessions(
      [{ id: 'session-a', title: 'first', messages: [] }],
      5,
      'workspace-a',
      { onSuccess: firstCallback }
    )
    storage.debouncedSaveSessions(
      [{ id: 'session-a', title: 'latest', messages: [] }],
      5,
      'workspace-a',
      { onSuccess: latestCallback }
    )
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(fakeIndexedDb.state.putCount).toBe(1)
    expect(firstCallback).not.toHaveBeenCalled()
    expect(latestCallback).toHaveBeenCalledTimes(1)
    await expect(storage.loadSessionFromDB('session-a', 'workspace-a')).resolves.toMatchObject({
      title: 'latest'
    })
  })

  it('preserves context compression metadata and drops legacy compact activity logs when saving and loading sessions', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    fakeIndexedDb.state.failGetAllOnce = false
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)

    const storage = await import('./chatStorage')
    const contextCompression = {
      summary: '[Previous context summary]\n\n### Current Goal\nKeep working.',
      coveredMessageCount: 8,
      sourceHash: 'source-hash',
      estimatedSourceTokens: 4096,
      estimatedSummaryTokens: 256,
      updatedAt: 1_700_000,
      manual: true,
      compactRound: 3,
      lastCompactAttemptAt: 1_699_900,
      lastCompactSuccessAt: 1_700_000,
      lastCompactFailureAt: 1_699_000,
      lastCompactSkipReason: 'cooldown',
      lastPromptTokens: 16_000,
      lastTotalTokens: 16_500,
      metadata: {
        generatedBy: 'llm',
        profileId: 'compact-model',
        maxOutputTokens: 2_000,
        realUsage: {
          promptTokens: 16_000,
          totalTokens: 16_500
        }
      }
    }
    await storage.saveSessionToDB(
      {
        id: 'compressed-session',
        title: 'Compressed session',
        messages: [{ role: 'user', content: 'recent live message' }],
        contextCompression,
        contextCompressionActivity: [
          {
            type: 'compact_complete',
            timestamp: 1_700_000,
            summaryPreview: '[Previous context summary]'
          }
        ]
      } as import('./chatStorage').ChatSession & {
        contextCompressionActivity: Array<Record<string, unknown>>
      },
      'workspace-a'
    )

    const loadedSession = await storage.loadSessionFromDB('compressed-session', 'workspace-a')
    expect(loadedSession).toMatchObject({
      id: 'compressed-session',
      storageScope: 'workspace-a',
      contextCompression
    })
    expect(loadedSession).not.toHaveProperty('contextCompressionActivity')

    const loadedSessions = await storage.loadAllSessions('workspace-a')
    expect(loadedSessions).toEqual([
      expect.objectContaining({
        id: 'compressed-session',
        contextCompression
      })
    ])
    expect(loadedSessions[0]).not.toHaveProperty('contextCompressionActivity')
  })

  it('keeps successfully loaded sessions unchanged when managed media migration is unavailable', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    fakeIndexedDb.state.failGetAllOnce = false
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)

    const storage = await import('./chatStorage')
    const legacyDataUrl = 'data:image/png;base64,YQ=='
    await storage.saveSessionToDB(
      {
        id: 'legacy-without-service',
        title: 'Legacy image session',
        messages: [
          {
            role: 'user',
            content: 'legacy image',
            attachments: [{ type: 'image', url: legacyDataUrl, fileName: 'legacy.png' }]
          }
        ]
      },
      'workspace-a'
    )

    await expect(storage.loadAllSessions('workspace-a')).resolves.toEqual([
      expect.objectContaining({
        id: 'legacy-without-service',
        storageScope: 'workspace-a',
        messages: [
          expect.objectContaining({
            attachments: [expect.objectContaining({ url: legacyDataUrl })]
          })
        ]
      })
    ])
    expect(fakeIndexedDb.deletedNames).toEqual([])
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
