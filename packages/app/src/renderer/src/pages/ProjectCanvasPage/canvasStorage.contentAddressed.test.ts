import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveCanvasItems } from './canvasStorage'
import type { CanvasItem } from './types'

// A small transactional model of IndexedDB: writes are staged per transaction and
// applied on completion, an abort drops them. It is a test double, not evidence
// of native IndexedDB isolation.
type FakeOp = { store: string; kind: 'put' | 'delete'; key: string; value?: unknown }
type FakeRequest<T> = { result?: T; onsuccess?: (() => void) | null; onerror?: (() => void) | null }

function byteLengthOf(value: unknown): number {
  const data = (value as { data?: unknown } | undefined)?.data
  return data instanceof ArrayBuffer ? data.byteLength : 0
}

function createFakeIndexedDb() {
  const committed = new Map<string, Map<string, unknown>>([
    ['canvas-items', new Map()],
    ['canvas-blobs', new Map()]
  ])
  const log = {
    puts: [] as Array<{ store: string; key: string; bytes: number }>,
    deletes: [] as Array<{ store: string; key: string }>,
    transactions: [] as Array<{ stores: string[]; mode: string; committed: boolean; aborted: boolean }>
  }
  let failure: { store: string; mode: 'sync-throw' | 'async-abort' } | null = null

  const database = {
    objectStoreNames: { contains: (name: string) => committed.has(name) },
    createObjectStore: (name: string) => committed.set(name, new Map()),
    close: vi.fn(),
    transaction(names: string | string[], mode: string = 'readonly') {
      const scope = typeof names === 'string' ? [names] : [...names]
      const record = { stores: scope, mode, committed: false, aborted: false }
      log.transactions.push(record)
      const ops: FakeOp[] = []
      let pending = 0
      let settled = false
      const tx = {
        oncomplete: null as (() => void) | null,
        onabort: null as (() => void) | null,
        onerror: null as (() => void) | null,
        error: null as Error | null,
        abort() {
          if (settled) return
          settled = true
          record.aborted = true
          setTimeout(() => tx.onabort?.(), 0)
        },
        objectStore(name: string) {
          if (!scope.includes(name)) throw new Error(`store ${name} is not in this transaction`)
          const read = (key: string): unknown => {
            for (let index = ops.length - 1; index >= 0; index -= 1) {
              const op = ops[index]
              if (op.store === name && op.key === key) return op.kind === 'put' ? op.value : undefined
            }
            return committed.get(name)!.get(key)
          }
          const keys = (): string[] => {
            const all = new Set(committed.get(name)!.keys())
            for (const op of ops) {
              if (op.store !== name) continue
              if (op.kind === 'put') all.add(op.key)
              else all.delete(op.key)
            }
            return [...all].sort()
          }
          const request = <T>(produce: () => T): FakeRequest<T> => {
            const req: FakeRequest<T> = {}
            pending += 1
            setTimeout(() => {
              if (!settled) {
                req.result = produce()
                req.onsuccess?.()
              }
              pending -= 1
              scheduleCompletion()
            }, 0)
            return req
          }
          return {
            put(value: unknown, key: string) {
              if (mode !== 'readwrite') throw new Error('readonly transaction')
              if (failure?.store === name && failure.mode === 'sync-throw') {
                throw new Error('synthetic put failure')
              }
              log.puts.push({ store: name, key, bytes: byteLengthOf(value) })
              ops.push({ store: name, kind: 'put', key, value: structuredClone(value) })
              return request(() => key)
            },
            delete(key: string) {
              if (mode !== 'readwrite') throw new Error('readonly transaction')
              log.deletes.push({ store: name, key })
              ops.push({ store: name, kind: 'delete', key })
              return request(() => undefined)
            },
            get(key: string) {
              return request(() => {
                const value = read(key)
                return value === undefined ? undefined : structuredClone(value)
              })
            },
            getAllKeys() {
              return request(() => keys())
            }
          }
        }
      }
      const scheduleCompletion = (): void => {
        setTimeout(() => {
          if (settled || pending > 0) return
          settled = true
          const failingStore = failure?.mode === 'async-abort' ? failure.store : null
          if (failingStore && ops.some((op) => op.store === failingStore)) {
            record.aborted = true
            tx.error = new Error('synthetic asynchronous abort')
            tx.onabort?.()
            return
          }
          for (const op of ops) {
            if (op.kind === 'put') committed.get(op.store)!.set(op.key, op.value)
            else committed.get(op.store)!.delete(op.key)
          }
          record.committed = true
          tx.oncomplete?.()
        }, 0)
      }
      scheduleCompletion()
      return tx
    }
  }

  return {
    committed,
    log,
    failNext(next: typeof failure) {
      failure = next
    },
    blobKeys: () => [...committed.get('canvas-blobs')!.keys()].sort(),
    blobBytes: (key: string) =>
      Array.from(
        new Uint8Array((committed.get('canvas-blobs')!.get(key) as { data: ArrayBuffer }).data)
      ),
    record: (storeKey: string) =>
      committed.get('canvas-items')!.get(storeKey) as
        | { items: Array<Record<string, unknown>> }
        | undefined,
    resetLog() {
      log.puts.length = 0
      log.deletes.length = 0
      log.transactions.length = 0
    },
    api: {
      open: () => {
        const request: { result?: typeof database; onsuccess?: () => void } = {}
        setTimeout(() => {
          request.result = database
          request.onsuccess?.()
        }, 0)
        return request
      }
    }
  }
}

type FakeIndexedDb = ReturnType<typeof createFakeIndexedDb>

const sourceBytes = new Map<string, Uint8Array>()
let fetchCalls: string[] = []

function registerSource(url: string, bytes: number[]): string {
  sourceBytes.set(url, new Uint8Array(bytes))
  return url
}

function contentKey(bytes: number[]): string {
  return `b-${createHash('sha256').update(new Uint8Array(bytes)).digest('hex').slice(0, 40)}`
}

function fileIdentityKey(canonicalPath: string, sizeBytes: number, lastModifiedMs: number): string {
  const identity = `canvas-asset-file-v1\n${canonicalPath}\n${sizeBytes}\n${lastModifiedMs}`
  return `f-${createHash('sha256').update(identity).digest('hex').slice(0, 40)}`
}

function imageItem(id: string, src: string, overrides: Record<string, unknown> = {}): CanvasItem {
  return {
    id,
    type: 'image',
    src,
    fileName: `${id}.png`,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false,
    ...overrides
  } as unknown as CanvasItem
}

let fake: FakeIndexedDb

beforeEach(() => {
  fake = createFakeIndexedDb()
  sourceBytes.clear()
  fetchCalls = []
  vi.stubGlobal('indexedDB', fake.api)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      fetchCalls.push(url)
      const bytes = sourceBytes.get(url)
      if (!bytes) return { ok: false }
      return { ok: true, arrayBuffer: async () => bytes.slice().buffer }
    })
  )
  vi.stubGlobal('api', undefined)
  Object.defineProperty(window, 'path', { configurable: true, writable: true, value: undefined })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('canvas content keys', () => {
  it('keys a path-less source by the SHA-256 of its bytes and records it on the item', async () => {
    const src = registerSource('blob:key-pathless-1', [1, 2, 3, 4])
    await saveCanvasItems([imageItem('image-1', src)], 'keys-pathless')

    const [saved] = fake.record('keys-pathless')!.items
    expect(saved.assetKey).toBe(contentKey([1, 2, 3, 4]))
    expect(saved.src).toBe('')
    expect(saved).not.toHaveProperty('assetKeySource')
  })

  it('gives equal bytes the same key and different bytes a different key', async () => {
    const first = registerSource('blob:key-equal-1', [9, 9, 9])
    const second = registerSource('blob:key-equal-2', [9, 9, 9])
    const third = registerSource('blob:key-equal-3', [9, 9, 8])
    await saveCanvasItems(
      [imageItem('a', first), imageItem('b', second), imageItem('c', third)],
      'keys-equal'
    )

    const keys = fake.record('keys-equal')!.items.map((item) => item.assetKey)
    expect(keys[0]).toBe(contentKey([9, 9, 9]))
    expect(keys[1]).toBe(keys[0])
    expect(keys[2]).toBe(contentKey([9, 9, 8]))
  })

  it('keys a path-backed image by its file identity, not by its bytes', async () => {
    const src = registerSource('local-media:///C:/refs/hero.png', [5, 5, 5, 5])
    const sourceIdentity = {
      version: 1,
      kind: 'local-file',
      canonicalPath: 'C:\\refs\\hero.png',
      sizeBytes: 4,
      lastModifiedMs: 1_700_000_000_000,
      cacheKey: 'thumb-cache-key'
    }
    await saveCanvasItems([imageItem('hero', src, { sourceIdentity })], 'keys-file')

    const [saved] = fake.record('keys-file')!.items
    expect(saved.assetKey).toBe(fileIdentityKey('C:\\refs\\hero.png', 4, 1_700_000_000_000))
  })

  it('never reuses a key after the source of an item was replaced', async () => {
    const original = registerSource('blob:key-replace-1', [1, 1, 1])
    const item = imageItem('edited', original)
    await saveCanvasItems([item], 'keys-replace')
    const firstKey = fake.record('keys-replace')!.items[0].assetKey

    // An edit keeps every other field (a spread copy), including stale key tags.
    const replacement = registerSource('blob:key-replace-2', [2, 2, 2])
    const edited = {
      ...item,
      src: replacement,
      assetKey: firstKey,
      assetKeySource: original
    } as unknown as CanvasItem
    await saveCanvasItems([edited], 'keys-replace')

    const saved = fake.record('keys-replace')!.items[0]
    expect(saved.assetKey).toBe(contentKey([2, 2, 2]))
    expect(saved.assetKey).not.toBe(firstKey)
  })

  it('computes the same key without SubtleCrypto', async () => {
    const bytes = Array.from({ length: 300 }, (_, index) => (index * 7) % 251)
    vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000000' })
    const src = registerSource('blob:key-fallback-1', bytes)
    await saveCanvasItems([imageItem('image-1', src)], 'keys-fallback')

    expect(fake.record('keys-fallback')!.items[0].assetKey).toBe(contentKey(bytes))
  })

  it('records one key per stored model texture', async () => {
    const model = registerSource('blob:key-model-1', [7, 7])
    const texture = registerSource('blob:key-texture-1', [8, 8, 8])
    const item = {
      id: 'model-1',
      type: 'model3d',
      src: model,
      fileName: 'ship.glb',
      textures: { 'hull.png': texture },
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      zIndex: 1,
      locked: false
    } as unknown as CanvasItem
    await saveCanvasItems([item], 'keys-model')

    const [saved] = fake.record('keys-model')!.items
    expect(saved.assetKey).toBe(contentKey([7, 7]))
    expect(saved.textureAssetKeys).toEqual({ 'hull.png': contentKey([8, 8, 8]) })
    expect(saved).not.toHaveProperty('textureAssetKeySources')
  })
})
