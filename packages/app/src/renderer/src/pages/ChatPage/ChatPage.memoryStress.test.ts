import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ChatAttachment, ChatMessage } from '@shared/api/svcLLMProxy'
import type { ChatSession } from './chatStorage'

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
      clearCount: number
      getAllCount: number
      getCount: number
      putCount: number
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
      clearCount: number
      getAllCount: number
      getCount: number
      putCount: number
    }
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
    private state: {
      clearCount: number
      getAllCount: number
      getCount: number
      putCount: number
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
    return new FakeIDBTransaction(this.stores, this.state)
  }

  close(): void {
    this.onclose?.()
  }
}

function createFakeIndexedDb() {
  const state = { clearCount: 0, getAllCount: 0, getCount: 0, putCount: 0 }
  const stores: StoreMap = new Map()
  let database: FakeIDBDatabase | null = null

  return {
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
      deleteDatabase: (_name: string) => {
        const request: {
          error?: DOMException
          onsuccess?: () => void
          onerror?: () => void
          onblocked?: () => void
        } = {}

        setTimeout(() => {
          stores.clear()
          database = null
          request.onsuccess?.()
        }, 0)

        return request
      }
    }
  }
}

const createDataUrl = (index: number): string =>
  `data:image/png;base64,${`${index.toString(36)}-`.repeat(8 * 1024)}`

const createLongMessage = (index: number): string =>
  `session ${index}\n${'long chat message chunk '.repeat(1024)}`

const createImageAttachment = (sessionIndex: number, imageIndex: number): ChatAttachment => ({
  type: 'image',
  url: createDataUrl(sessionIndex * 10 + imageIndex),
  fileName: `generated-${sessionIndex}-${imageIndex}.png`
})

const createStressSession = (index: number): ChatSession => ({
  id: `stress-session-${index}`,
  title: `Stress session ${index}`,
  createdAt: 1_700_000_000_000 + index,
  messages: [
    {
      role: 'user',
      content: createLongMessage(index),
      attachments: [createImageAttachment(index, 0)]
    },
    {
      role: 'assistant',
      content: createLongMessage(index + 1),
      attachments: [createImageAttachment(index, 1), createImageAttachment(index, 2)]
    }
  ] as ChatMessage[]
})

const resolveStressLogDir = (): string => {
  const runId = (process.env.MAGICPOT_STRESS_RUN_ID || `vitest-${process.pid}`).replace(
    /[^a-zA-Z0-9_.-]+/g,
    '-'
  )
  return join(homedir(), 'Desktop', '.Codex-Junk', 'MagicPot-OOM', runId)
}

const writeStressLog = (name: string, payload: Record<string, unknown>): void => {
  const logDir = resolveStressLogDir()
  mkdirSync(logDir, { recursive: true })
  writeFileSync(
    join(logDir, `${name}.json`),
    JSON.stringify(
      {
        ...payload,
        logDir,
        writtenAt: new Date().toISOString()
      },
      null,
      2
    )
  )
}

describe('ChatPage memory stress contracts', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('keeps long-lived autosave image tracking free of full data URL payloads', async () => {
    const { autoSavedChatImageTracker } = await import('./chatPageShared')
    autoSavedChatImageTracker.clear()

    const imageUrls = Array.from({ length: 64 }, (_, index) => createDataUrl(index))
    for (const imageUrl of imageUrls) {
      autoSavedChatImageTracker.add(imageUrl)
    }

    const trackedValues = [...autoSavedChatImageTracker]
    expect(trackedValues.some((value) => /^data:image\/[^;]+;base64,/i.test(value))).toBe(false)
    expect(trackedValues.join('\n').length).toBeLessThan(8 * 1024)

    writeStressLog('autosave-tracker', {
      inputImageCount: imageUrls.length,
      trackedValueCount: trackedValues.length,
      trackedBytes: trackedValues.join('\n').length
    })
  })

  it('persists routine assistant responses with single-session IO under data URL pressure', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)

    const storage = await import('./chatStorage')
    const { replaceLastMessageInSession } = await import('./chatSessionUtils')
    const sessions = Array.from({ length: 96 }, (_, index) => createStressSession(index))

    for (const session of sessions) {
      await storage.saveSessionToDB(session, 'stress-scope')
    }

    const targetSessionId = sessions[48].id
    const loadedTarget = await storage.loadSessionFromDB(targetSessionId, 'stress-scope')
    expect(loadedTarget).not.toBeNull()

    const responseMessage: ChatMessage = {
      role: 'assistant',
      content: `${createLongMessage(9000)}\nfinal response`,
      attachments: [createImageAttachment(9000, 0), createImageAttachment(9000, 1)]
    }
    const [updatedTarget] = replaceLastMessageInSession([loadedTarget as ChatSession], {
      sessionId: targetSessionId,
      message: responseMessage,
      sessionUrl: 'https://session.example/stress-target'
    })

    await storage.saveSessionToDB(updatedTarget, 'stress-scope')

    const reloadedTarget = await storage.loadSessionFromDB(targetSessionId, 'stress-scope')
    const untouchedNeighbor = await storage.loadSessionFromDB(sessions[49].id, 'stress-scope')

    expect(reloadedTarget).toMatchObject({
      id: targetSessionId,
      sessionUrl: 'https://session.example/stress-target',
      messages: [expect.any(Object), responseMessage]
    })
    expect(untouchedNeighbor?.messages[1]?.content).toBe(createLongMessage(50))
    expect(fakeIndexedDb.state.getAllCount).toBe(0)
    expect(fakeIndexedDb.state.clearCount).toBe(0)

    writeStressLog('single-session-persistence', {
      sessionCount: sessions.length,
      targetSessionId,
      indexedDbGetCount: fakeIndexedDb.state.getCount,
      indexedDbGetAllCount: fakeIndexedDb.state.getAllCount,
      indexedDbPutCount: fakeIndexedDb.state.putCount,
      indexedDbClearCount: fakeIndexedDb.state.clearCount
    })
  })
})
