import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildProjectStorageDirName } from '../pages/MainPage/projectStore'

/**
 * The scan over the real canvas storage (on a minimal in-memory IndexedDB and mirror folder):
 * it reads item records only, one board at a time, and fails when a board cannot be read.
 */

const mocks = vi.hoisted(() => ({
  forEachStoredChatRecord: vi.fn(),
  updateReferenceSnapshot: vi.fn()
}))

vi.mock('../pages/ChatPage/chatStorage', () => ({
  forEachStoredChatRecord: mocks.forEachStoredChatRecord
}))

vi.mock('../utils/windowUtils', () => ({
  api: () => ({ svcManagedMedia: { updateReferenceSnapshot: mocks.updateReferenceSnapshot } })
}))

const AUTOSAVE_ROOT = '/home/u/AutoSave'
const id = (n: number): string => n.toString(16).padStart(2, '0').repeat(32)
const media = (sha256: string) => ({
  version: 1 as const,
  kind: 'managed' as const,
  sha256,
  relativePath: `originals/${sha256.slice(0, 2)}/${sha256}.png`,
  sizeBytes: 3,
  mimeType: 'image/png',
  originalFileName: 'image.png'
})
const image = (itemId: string, sha256: string, extra: Record<string, unknown> = {}) => ({
  id: itemId,
  type: 'image',
  src: '',
  fileName: `${itemId}.png`,
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  media: media(sha256),
  ...extra
})

type Snapshot = { complete: boolean; ids: string[] }

/** The canvas database: item records by board, plus a blob store nothing should read. */
function createCanvasDb(records: Map<string, unknown>) {
  const stats = { open: 0, maxOpen: 0, reads: [] as string[], failOpen: false }
  const db = {
    objectStoreNames: { contains: () => true },
    close: () => {
      stats.open -= 1
    },
    transaction() {
      let pending = 0
      const tx: {
        oncomplete: (() => void) | null
        onabort: (() => void) | null
        onerror: (() => void) | null
        error: null
        objectStore: (name: string) => unknown
      } = {
        oncomplete: null,
        onabort: null,
        onerror: null,
        error: null,
        objectStore: (name: string) => {
          const request = <T>(produce: () => T) => {
            const req: { result?: T; onsuccess?: () => void } = {}
            pending += 1
            setTimeout(() => {
              req.result = produce()
              req.onsuccess?.()
              pending -= 1
              complete()
            }, 0)
            return req
          }
          return {
            get: (key: string) => {
              stats.reads.push(`${name}:${key}`)
              return request(() =>
                name === 'canvas-items' ? structuredClone(records.get(key)) : undefined
              )
            },
            getAllKeys: () => {
              stats.reads.push(`${name}:*`)
              return request(() => (name === 'canvas-items' ? [...records.keys()] : []))
            }
          }
        }
      }
      const complete = () =>
        setTimeout(() => {
          if (pending === 0) tx.oncomplete?.()
        }, 0)
      complete()
      return tx
    }
  }
  const api = {
    open: () => {
      const request: {
        result?: typeof db
        error?: DOMException
        onsuccess?: () => void
        onerror?: () => void
      } = {}
      setTimeout(() => {
        if (stats.failOpen) {
          request.error = new DOMException('Denied', 'UnknownError')
          request.onerror?.()
          return
        }
        stats.open += 1
        stats.maxOpen = Math.max(stats.maxOpen, stats.open)
        request.result = db
        request.onsuccess?.()
      }, 0)
      return request
    }
  }
  return { api, stats }
}

describe('managed media reference scan over the canvas boards', () => {
  const files = new Map<string, string>()
  let createObjectUrl: ReturnType<typeof vi.fn>
  let originalCreateObjectUrl: typeof URL.createObjectURL | undefined

  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    files.clear()
    mocks.forEachStoredChatRecord.mockReset()
    mocks.forEachStoredChatRecord.mockResolvedValue(undefined)
    mocks.updateReferenceSnapshot.mockReset()
    mocks.updateReferenceSnapshot.mockResolvedValue(undefined)
    originalCreateObjectUrl = URL.createObjectURL
    createObjectUrl = vi.fn(() => 'blob:scan-made-this')
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: createObjectUrl
    })
    vi.stubGlobal('api', {
      svcFs: {
        readTextFile: async ({ fullPath }: { fullPath: string }) => {
          const content = files.get(fullPath)
          if (content === undefined) throw new Error(`File not found: ${fullPath}`)
          return { content, filename: fullPath.split('/').pop() }
        },
        readFileFromPath: async () => {
          throw new Error('the scan must not read file bytes')
        }
      },
      svcState: {
        getConfig: async () => ({ config: {} }),
        getUserDataDirectoryState: async () => ({
          state: { autoSaveRoot: AUTOSAVE_ROOT, projectRoot: '/home/u/Projects' }
        })
      }
    })
    Object.defineProperty(window, 'path', {
      configurable: true,
      writable: true,
      value: {
        join: (...parts: string[]) => parts.join('/').replace(/\/+/g, '/'),
        dirname: (value: string) => value.slice(0, value.lastIndexOf('/')),
        basename: (value: string) => value.slice(value.lastIndexOf('/') + 1)
      }
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: originalCreateObjectUrl
    })
    Object.defineProperty(window, 'path', { configurable: true, writable: true, value: undefined })
    localStorage.clear()
  })

  async function scanOnce(): Promise<Snapshot> {
    vi.resetModules()
    const { startManagedMediaReferenceScanner } = await import('./managedMediaReferenceBootstrap')
    const stop = startManagedMediaReferenceScanner()
    try {
      await vi.advanceTimersByTimeAsync(2_000)
      for (
        let step = 0;
        step < 100 && mocks.updateReferenceSnapshot.mock.calls.length === 0;
        step += 1
      ) {
        await vi.advanceTimersByTimeAsync(10)
      }
    } finally {
      stop()
    }
    expect(mocks.updateReferenceSnapshot).toHaveBeenCalledTimes(1)
    return mocks.updateReferenceSnapshot.mock.calls[0][0] as Snapshot
  }

  function seedBoards() {
    localStorage.setItem(
      'ai_engine_projects',
      JSON.stringify([{ id: 'board-a' }, { id: 'board-b' }, { id: 'board-c' }])
    )
    const records = new Map<string, unknown>([
      ['board-a', { items: [image('a', id(1), { assetKey: `b-${'1'.repeat(40)}` })], groups: [] }],
      ['board-c', { items: [image('c', id(3))], groups: [] }]
    ])
    // board-b is not in IndexedDB: a load restores it from its mirror file, embedded bytes and all.
    files.set(
      `${AUTOSAVE_ROOT}/${buildProjectStorageDirName('board-b', 'board-b')}/project.mpcanvas`,
      JSON.stringify({
        magic: 'MAGICPOT_CANVAS',
        version: 8,
        createdAt: '2026-01-01T00:00:00.000Z',
        items: [image('b', id(2))],
        groups: [],
        groupBranches: [],
        blobs: { b: { base64: 'AQID', mimeType: 'image/png' } }
      })
    )
    return createCanvasDb(records)
  }

  it('names the media of every board without reading an image or making an object URL', async () => {
    const canvas = seedBoards()
    vi.stubGlobal('indexedDB', canvas.api)

    const snapshot = await scanOnce()

    expect(snapshot.complete).toBe(true)
    expect(snapshot.ids).toEqual([id(1), id(2), id(3)])
    expect(createObjectUrl).not.toHaveBeenCalled()
    expect(canvas.stats.reads.filter((read) => !read.startsWith('canvas-items:'))).toEqual([])
    expect(canvas.stats.reads).toEqual([
      'canvas-items:board-a',
      'canvas-items:board-b',
      'canvas-items:board-c'
    ])
  })

  it('reads one board at a time', async () => {
    const canvas = seedBoards()
    vi.stubGlobal('indexedDB', canvas.api)

    await scanOnce()

    expect(canvas.stats.maxOpen).toBe(1)
  })

  it('sends an incomplete snapshot when the canvas database cannot be read', async () => {
    const canvas = seedBoards()
    canvas.stats.failOpen = true
    vi.stubGlobal('indexedDB', canvas.api)

    const snapshot = await scanOnce()

    expect(snapshot).toMatchObject({ complete: false, ids: [] })
  })
})
