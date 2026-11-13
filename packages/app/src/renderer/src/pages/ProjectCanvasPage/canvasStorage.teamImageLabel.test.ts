import { afterEach, expect, it, vi } from 'vitest'
import { loadCanvasItems, saveCanvasItems } from './canvasStorage'
import type { CanvasImageItem } from './types'

vi.mock('../QuickAppPage/components/QAppContext', () => ({ restoreGlobalQAppCache: vi.fn() }))
vi.mock('../ChatPage/chatPageShared', () => ({
  getDownloadFileNameFromUrl: vi.fn(),
  normalizeLocalMediaUrl: (value: string) => value
}))

// Same in-memory, async request/transaction approach as canvasStorage.test.ts; not native IDB.
function createFakeIndexedDB() {
  const stores = new Map<string, Map<string, unknown>>()
  const database = {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore(name: string) {
      stores.set(name, new Map())
    },
    transaction(names: string | string[]) {
      const allowed = Array.isArray(names) ? names : [names]
      let pending = 0
      let completionScheduled = false
      const scheduleCompletion = () => {
        if (completionScheduled) return
        completionScheduled = true
        setTimeout(() => {
          completionScheduled = false
          if (pending === 0) transaction.oncomplete?.()
        }, 0)
      }
      const transaction: {
        oncomplete: (() => void) | null
        onerror: (() => void) | null
        objectStore: (name: string) => {
          put: (value: unknown, key: string) => void
          get: (key: string) => { result?: unknown; onsuccess?: () => void }
        }
      } = {
        oncomplete: null,
        onerror: null,
        objectStore: (name) => {
          if (!allowed.includes(name)) throw new Error('Store not included in synthetic transaction')
          return {
            put: (value, key) => { stores.get(name)!.set(key, structuredClone(value)) },
            get: key => {
              const request: { result?: unknown; onsuccess?: () => void } = {}
              pending++
              setTimeout(() => {
                request.result = structuredClone(stores.get(name)!.get(key))
                request.onsuccess?.()
                pending--
                scheduleCompletion()
              }, 0)
              return request
            }
          }
        }
      }
      scheduleCompletion()
      return transaction
    },
    close() {
      // The in-memory database remains available to the next open.
    }
  }
  let opened = false
  return {
    open() {
      const request: { result?: typeof database; onupgradeneeded?: () => void; onsuccess?: () => void } = {}
      setTimeout(() => {
        request.result = database
        if (!opened) {
          opened = true
          request.onupgradeneeded?.()
        }
        request.onsuccess?.()
      }, 0)
      return request
    }
  }
}

afterEach(() => vi.unstubAllGlobals())

it('round-trips team image labels and ordinary images through the synthetic IndexedDB canvas store', async () => {
  vi.stubGlobal('indexedDB', createFakeIndexedDB())
  const fetchBoundary = vi.fn(() => { throw new Error('Unexpected network request') })
  vi.stubGlobal('fetch', fetchBoundary)
  vi.stubGlobal('api', undefined)
  vi.stubGlobal('path', undefined)
  const ordinary: CanvasImageItem = {
    id: 'ordinary', type: 'image', src: 'synthetic-image:ordinary', x: 0, y: 0,
    width: 20, height: 10, rotation: 0, scaleX: 1, scaleY: 1, zIndex: 1, locked: false
  }
  const labelled: CanvasImageItem = { ...ordinary, id: 'team', teamImageLabel: '设计师·图1' }
  await saveCanvasItems([labelled, ordinary], 'synthetic-team-label')
  const { items } = await loadCanvasItems('synthetic-team-label')
  expect(items).toHaveLength(2)
  expect(items.find(item => item.id === 'team')).toMatchObject({ teamImageLabel: '设计师·图1' })
  expect(items.find(item => item.id === 'ordinary')).not.toHaveProperty('teamImageLabel')
  expect(fetchBoundary).not.toHaveBeenCalled()
})
