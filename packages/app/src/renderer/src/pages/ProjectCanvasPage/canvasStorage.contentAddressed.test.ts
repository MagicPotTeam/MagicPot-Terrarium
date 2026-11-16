import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { countCanvasAssetKeyReferences, loadCanvasItems, saveCanvasItems } from './canvasStorage'
import type { CanvasItem } from './types'
import { buildProjectStorageDirName } from '@shared/projectStorage'

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
  let beforeTransaction: ((stores: string[], mode: string) => void) | null = null

  const database = {
    objectStoreNames: { contains: (name: string) => committed.has(name) },
    createObjectStore: (name: string) => committed.set(name, new Map()),
    close: vi.fn(),
    transaction(names: string | string[], mode: string = 'readonly') {
      const scope = typeof names === 'string' ? [names] : [...names]
      beforeTransaction?.(scope, mode)
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
    onTransaction(hook: typeof beforeTransaction) {
      beforeTransaction = hook
    },
    blobPuts: () => log.puts.filter((put) => put.store === 'canvas-blobs'),
    recordPuts: () => log.puts.filter((put) => put.store === 'canvas-items'),
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
const restoredBlobs = new Map<string, Blob>()
let fetchCalls: string[] = []
let nextRestoredUrl = 0

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
      const restored = restoredBlobs.get(url)
      if (restored) return { ok: true, blob: async () => restored }
      const bytes = sourceBytes.get(url)
      if (!bytes) return { ok: false }
      return { ok: true, arrayBuffer: async () => bytes.slice().buffer }
    })
  )
  restoredBlobs.clear()
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    nextRestoredUrl += 1
    const url = `blob:restored-${nextRestoredUrl}`
    restoredBlobs.set(url, blob as Blob)
    return url
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
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

const assetBlobKey = (storeKey: string, bytes: number[]): string =>
  `${storeKey}::canvas::asset::${contentKey(bytes)}`
// The per-item blob the previous release reads (dual write for one release).
const legacyBlobKey = (storeKey: string, logicalKey: string): string =>
  `${storeKey}::canvas::${logicalKey}`
const keyedBlobKeys = (): string[] => fake.blobKeys().filter((key) => key.includes('::canvas::asset::'))
const keyedBlobPuts = () => fake.blobPuts().filter((put) => put.key.includes('::canvas::asset::'))

describe('content-addressed canvas blob store', () => {
  it('stores the bytes once: saving the same board again writes metadata only', async () => {
    const items = [
      imageItem('a', registerSource('blob:twice-a', [1, 1, 1, 1])),
      imageItem('b', registerSource('blob:twice-b', [2, 2, 2, 2, 2]))
    ]
    await saveCanvasItems(items, 'twice')
    // Each binary once under its content key, and once per item for the previous release.
    expect(fake.blobPuts().map((put) => put.key).sort()).toEqual(
      [
        assetBlobKey('twice', [1, 1, 1, 1]),
        assetBlobKey('twice', [2, 2, 2, 2, 2]),
        legacyBlobKey('twice', 'a'),
        legacyBlobKey('twice', 'b')
      ].sort()
    )
    expect(keyedBlobPuts().reduce((sum, put) => sum + put.bytes, 0)).toBe(9)
    expect(fake.blobBytes(legacyBlobKey('twice', 'a'))).toEqual([1, 1, 1, 1])
    expect(fake.blobBytes(legacyBlobKey('twice', 'b'))).toEqual([2, 2, 2, 2, 2])

    fake.resetLog()
    fetchCalls = []
    await saveCanvasItems(items, 'twice')

    expect(fetchCalls).toEqual([])
    expect(fake.blobPuts()).toEqual([])
    expect(fake.recordPuts()).toHaveLength(1)
    expect(fake.log.deletes).toEqual([])
  })

  it('moves no image bytes when an item is edited', async () => {
    const original = imageItem('moved', registerSource('blob:edit-move', [4, 4, 4]))
    await saveCanvasItems([original], 'edit')

    fake.resetLog()
    fetchCalls = []
    const moved = { ...original, x: 250, y: -40, zIndex: 9 } as CanvasItem
    await saveCanvasItems([moved], 'edit')

    expect(fetchCalls).toEqual([])
    expect(fake.blobPuts()).toEqual([])
    expect(fake.record('edit')!.items[0]).toMatchObject({
      x: 250,
      y: -40,
      assetKey: contentKey([4, 4, 4])
    })
  })

  it('does not read a path-backed file again once its identity key is stored', async () => {
    const readFileFromPath = vi.fn(async () => ({
      data: new Uint8Array([6, 6, 6, 6, 6, 6]),
      filename: 'ref.png'
    }))
    vi.stubGlobal('api', { svcFs: { readFileFromPath } })
    const sourceIdentity = {
      version: 1,
      kind: 'local-file',
      canonicalPath: 'D:\\refs\\ref.png',
      sizeBytes: 6,
      lastModifiedMs: 1_700_000_000_123,
      cacheKey: 'k'
    }
    const item = imageItem('ref', 'local-media:///D:/refs/ref.png', { sourceIdentity })
    await saveCanvasItems([item], 'path-backed')
    expect(readFileFromPath).toHaveBeenCalledTimes(1)
    expect(fake.blobPuts().map((put) => put.key).sort()).toEqual(
      [
        `path-backed::canvas::asset::${fake.record('path-backed')!.items[0].assetKey}`,
        legacyBlobKey('path-backed', 'ref')
      ].sort()
    )

    fake.resetLog()
    readFileFromPath.mockClear()
    await saveCanvasItems([{ ...item, x: 33 } as CanvasItem], 'path-backed')

    expect(readFileFromPath).not.toHaveBeenCalled()
    expect(fetchCalls).toEqual([])
    expect(fake.blobPuts()).toEqual([])
  })

  it('shares one blob between items with the same content and counts both references', async () => {
    const src = registerSource('blob:shared-1', [3, 3, 3])
    const first = imageItem('first', src)
    const copy = imageItem('copy', src, { x: 80 })
    await saveCanvasItems([first, copy], 'shared')

    expect(keyedBlobKeys()).toEqual([assetBlobKey('shared', [3, 3, 3])])
    expect(countCanvasAssetKeyReferences(fake.record('shared')!.items)).toEqual(
      new Map([[contentKey([3, 3, 3]), 2]])
    )

    // Deleting one of the two must not take the blob the other still uses.
    await saveCanvasItems([copy], 'shared')
    expect(keyedBlobKeys()).toEqual([assetBlobKey('shared', [3, 3, 3])])
    expect(countCanvasAssetKeyReferences(fake.record('shared')!.items)).toEqual(
      new Map([[contentKey([3, 3, 3]), 1]])
    )

    // With the last reference gone the blob is deleted.
    await saveCanvasItems([], 'shared')
    expect(fake.blobKeys()).toEqual([])
  })

  it('keeps the blob of a deleted item while the undo history can still restore it', async () => {
    const item = imageItem('undo-me', registerSource('blob:undo-1', [5, 4, 3, 2, 1]))
    const keep = imageItem('keep', registerSource('blob:undo-keep', [8]))
    await saveCanvasItems([item, keep], 'undo')

    // Delete: the history snapshot still holds the item.
    const history = [[item, keep]]
    await saveCanvasItems([keep], 'undo', [], [], null, { getProtectedItems: () => history })
    expect(fake.blobKeys()).toContain(assetBlobKey('undo', [5, 4, 3, 2, 1]))

    // Undo: the item returns without a single byte being read or written.
    fake.resetLog()
    fetchCalls = []
    await saveCanvasItems([item, keep], 'undo', [], [], null, { getProtectedItems: () => [[keep]] })
    expect(fetchCalls).toEqual([])
    expect(fake.blobPuts()).toEqual([])
    expect(fake.record('undo')!.items.map((saved) => saved.id)).toEqual(['undo-me', 'keep'])

    // Redo of the delete while the redo stack holds it, then the entry leaves the window.
    await saveCanvasItems([keep], 'undo', [], [], null, { getProtectedItems: () => [[item, keep]] })
    expect(fake.blobKeys()).toContain(assetBlobKey('undo', [5, 4, 3, 2, 1]))
    await saveCanvasItems([keep], 'undo', [], [], null, { getProtectedItems: () => [[keep]] })
    expect(fake.blobKeys()).toEqual([assetBlobKey('undo', [8]), legacyBlobKey('undo', 'keep')].sort())
  })

  it('stores the bytes again when a pruned asset comes back', async () => {
    const item = imageItem('back', registerSource('blob:back-1', [9, 8, 7]))
    await saveCanvasItems([item], 'back')
    await saveCanvasItems([], 'back')
    expect(fake.blobKeys()).toEqual([])

    await saveCanvasItems([item], 'back')
    expect(fake.blobKeys()).toEqual([assetBlobKey('back', [9, 8, 7]), legacyBlobKey('back', 'back')].sort())
    expect(fake.blobBytes(assetBlobKey('back', [9, 8, 7]))).toEqual([9, 8, 7])
  })

  it('skips the cleanup altogether when the history cannot be read', async () => {
    const item = imageItem('gone', registerSource('blob:history-fail-1', [1, 2]))
    await saveCanvasItems([item], 'history-fail')
    await saveCanvasItems([], 'history-fail', [], [], null, {
      getProtectedItems: () => {
        throw new Error('history unavailable')
      }
    })

    expect(fake.record('history-fail')!.items).toEqual([])
    expect(fake.blobKeys()).toEqual(
      [assetBlobKey('history-fail', [1, 2]), legacyBlobKey('history-fail', 'gone')].sort()
    )
  })

  it('never deletes blobs of another canvas, unscoped blobs or foreign keys', async () => {
    const blobs = fake.committed.get('canvas-blobs')!
    const foreign = { data: new Uint8Array([1]).buffer, mimeType: 'image/png' }
    blobs.set('other-canvas::canvas::asset::' + contentKey([1]), foreign)
    blobs.set('prune-scope::canvas::legacy-item-id', foreign)
    blobs.set('prune-scope::canvas::asset::not-a-content-key', foreign)
    blobs.set('unscoped-legacy-item-id', foreign)
    blobs.set('prune-scope-2::canvas::asset::' + contentKey([1]), foreign)

    const item = imageItem('scoped', registerSource('blob:scope-1', [4, 2]))
    await saveCanvasItems([item], 'prune-scope')
    await saveCanvasItems([], 'prune-scope')

    // Only the per-item blob of this canvas that no stored item reads any more is gone.
    expect(fake.blobKeys()).toEqual(
      [
        'other-canvas::canvas::asset::' + contentKey([1]),
        'prune-scope::canvas::asset::not-a-content-key',
        'unscoped-legacy-item-id',
        'prune-scope-2::canvas::asset::' + contentKey([1])
      ].sort()
    )
  })

  it('writes the bytes again when the stored blob vanished between the check and the commit', async () => {
    const item = imageItem('raced', registerSource('blob:race-1', [6, 5, 4]))
    await saveCanvasItems([item], 'race')
    const blobKey = assetBlobKey('race', [6, 5, 4])

    // Another window prunes the blob right before this save commits its metadata.
    let interfered = false
    fake.onTransaction((stores, mode) => {
      if (!interfered && mode === 'readwrite' && stores.includes('canvas-items')) {
        interfered = true
        fake.committed.get('canvas-blobs')!.delete(blobKey)
      }
    })
    await saveCanvasItems([{ ...item, x: 12 } as CanvasItem], 'race')
    fake.onTransaction(null)

    expect(interfered).toBe(true)
    expect(fake.blobBytes(blobKey)).toEqual([6, 5, 4])
    expect(fake.record('race')!.items[0]).toMatchObject({ x: 12, assetKey: contentKey([6, 5, 4]) })
  })

  it('refuses to commit metadata that would point at bytes it cannot store', async () => {
    const stable = imageItem('stable', registerSource('blob:refuse-1', [1, 2, 3]))
    await saveCanvasItems([stable], 'refuse')
    const before = fake.record('refuse')

    const unreadable = imageItem('stable', 'blob:refuse-unreadable')
    await expect(saveCanvasItems([unreadable], 'refuse')).rejects.toThrow(
      'binary data could not be persisted: stable'
    )

    expect(fake.record('refuse')).toEqual(before)
    expect(fake.blobKeys()).toEqual(
      [assetBlobKey('refuse', [1, 2, 3]), legacyBlobKey('refuse', 'stable')].sort()
    )
  })

  it('restores every item from its keyed blob and recognises the restored sources on the next save', async () => {
    const shared = registerSource('blob:restore-shared', [7, 7, 7])
    const items = [
      imageItem('one', shared),
      imageItem('two', shared, { x: 40 }),
      imageItem('three', registerSource('blob:restore-three', [1, 0, 1]))
    ]
    await saveCanvasItems(items, 'restore')

    const loaded = await loadCanvasItems('restore')
    expect(loaded.items.map((item) => item.id)).toEqual(['one', 'two', 'three'])
    const [one, two, three] = loaded.items as Array<CanvasItem & { src: string }>
    // One object URL per stored blob, shared by the items that share the content.
    expect(one.src).toMatch(/^blob:restored-/)
    expect(two.src).toBe(one.src)
    expect(three.src).not.toBe(one.src)
    expect(restoredBlobs.size).toBe(2)

    fake.resetLog()
    fetchCalls = []
    const edited = loaded.items.map((item) => ({ ...item, y: 500 }) as CanvasItem)
    await saveCanvasItems(edited, 'restore')

    expect(fetchCalls).toEqual([])
    expect(fake.blobPuts()).toEqual([])
    expect(keyedBlobKeys()).toEqual(
      [assetBlobKey('restore', [7, 7, 7]), assetBlobKey('restore', [1, 0, 1])].sort()
    )
    expect(fake.record('restore')!.items.map((item) => item.assetKey)).toEqual([
      contentKey([7, 7, 7]),
      contentKey([7, 7, 7]),
      contentKey([1, 0, 1])
    ])
    // The in-memory binding of key and source never reaches storage.
    for (const saved of fake.record('restore')!.items) {
      expect(saved).not.toHaveProperty('assetKeySource')
    }
  })

  it('round-trips a model with textures through keyed blobs', async () => {
    const item = {
      id: 'model-rt',
      type: 'model3d',
      src: registerSource('blob:model-rt', [2, 4, 6]),
      fileName: 'ship.glb',
      textures: { 'hull.png': registerSource('blob:model-rt-hull', [9, 9]) },
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
    await saveCanvasItems([item], 'model-rt')

    const loaded = await loadCanvasItems('model-rt')
    const restored = loaded.items[0] as CanvasItem & { src: string; textures: Record<string, string> }
    expect(restored.src).toMatch(/^blob:restored-/)
    expect(restored.textures['hull.png']).toMatch(/^blob:restored-/)
    expect(restored.textures['hull.png']).not.toBe(restored.src)

    fake.resetLog()
    fetchCalls = []
    await saveCanvasItems([{ ...restored, x: 5 } as CanvasItem], 'model-rt')
    expect(fetchCalls).toEqual([])
    expect(fake.blobPuts()).toEqual([])
    expect(keyedBlobKeys()).toEqual(
      [assetBlobKey('model-rt', [2, 4, 6]), assetBlobKey('model-rt', [9, 9])].sort()
    )
  })

  it('still loads a board whose binaries are stored per item id by an earlier version', async () => {
    const legacyBytes = new Uint8Array([4, 4, 4, 4]).buffer
    fake.committed.get('canvas-items')!.set('legacy-load', {
      items: [{ ...(imageItem('old-image', '') as object), src: '' }],
      groups: [],
      groupBranches: [],
      figmaBinding: null
    })
    fake.committed
      .get('canvas-blobs')!
      .set('legacy-load::canvas::old-image', { data: legacyBytes, mimeType: 'image/png' })

    const loaded = await loadCanvasItems('legacy-load')
    expect(loaded.items).toHaveLength(1)
    expect((loaded.items[0] as { src: string }).src).toMatch(/^blob:restored-/)
    expect(loaded.items[0]).not.toHaveProperty('assetKey')
  })
})

// ─── Autosave mirror ─────────────────────────────────────────────────────────
// An in-memory stand-in for the main-side mirror calls on a POSIX layout.
function createFakeMirror() {
  const autoSaveRoot = '/home/u/AutoSave'
  /** Files of the mirror folders, by full path. */
  const files = new Map<string, Uint8Array>()
  const text = new Map<string, string>()
  /** Files elsewhere on disk that main may read. */
  const localFiles = new Map<string, Uint8Array>()
  const events: string[] = []
  const calls = {
    copy: [] as Array<{ assetFileName: string; sourcePath: string }>,
    write: [] as Array<{ assetFileName: string; bytes: number }>,
    prune: [] as Array<{ keepAssetKeys: string[]; keepEntryNames: string[] }>,
    readFileFromPath: [] as string[],
    saveImageToPath: [] as string[]
  }
  // applyPrune: delete like main does (no grace period): every entry directly under
  // assets/ that the project file on disk does not reference and the caller does not keep.
  const state = { failProjectFileWrite: false, refuseCopy: false, applyPrune: false }
  const assetPath = (projectDirName: string, assetFileName: string): string =>
    `${autoSaveRoot}/${projectDirName}/assets/${assetFileName}`
  const publish = (target: string, data: Uint8Array) => {
    const existing = files.get(target)
    if (existing) return { status: 'exists' as const, sizeBytes: existing.byteLength }
    files.set(target, data.slice())
    return { status: 'written' as const, sizeBytes: data.byteLength }
  }
  const readable = (fullPath: string): Uint8Array | undefined =>
    localFiles.get(fullPath) ?? files.get(fullPath)

  const svcFs = {
    copyCanvasMirrorAsset: async (req: {
      projectDirName: string
      assetFileName: string
      sourcePath: string
    }) => {
      calls.copy.push({ assetFileName: req.assetFileName, sourcePath: req.sourcePath })
      const data = readable(req.sourcePath)
      if (state.refuseCopy || !data) throw new Error('Canvas mirror asset source is not authorized')
      events.push(`asset:${req.assetFileName}`)
      return publish(assetPath(req.projectDirName, req.assetFileName), data)
    },
    writeCanvasMirrorAsset: async (req: {
      projectDirName: string
      assetFileName: string
      data: Uint8Array
    }) => {
      calls.write.push({ assetFileName: req.assetFileName, bytes: req.data.byteLength })
      events.push(`asset:${req.assetFileName}`)
      return publish(assetPath(req.projectDirName, req.assetFileName), req.data)
    },
    listCanvasMirrorAssets: async (req: { projectDirName: string }) => {
      const prefix = assetPath(req.projectDirName, '')
      return {
        assetFileNames: [...files.keys()]
          .filter((fullPath) => fullPath.startsWith(prefix) && !fullPath.slice(prefix.length).includes('/'))
          .map((fullPath) => fullPath.slice(prefix.length))
      }
    },
    pruneCanvasMirrorAssets: async (req: {
      projectDirName: string
      keepAssetKeys: string[]
      keepEntryNames: string[]
    }) => {
      events.push('prune')
      calls.prune.push({ keepAssetKeys: req.keepAssetKeys, keepEntryNames: req.keepEntryNames })
      const removed = { removedAssetFileNames: [] as string[], removedSnapshotDirNames: [] as string[] }
      if (!state.applyPrune) return removed
      const content = text.get(`${autoSaveRoot}/${req.projectDirName}/project.mpcanvas`)
      if (content === undefined) return removed
      const keep = new Set(req.keepEntryNames)
      for (const match of content.matchAll(/"assets[\\/]+([^"\\/]+)/g)) keep.add(match[1])
      const prefix = assetPath(req.projectDirName, '')
      for (const fullPath of [...files.keys()]) {
        if (!fullPath.startsWith(prefix)) continue
        const entry = fullPath.slice(prefix.length).split('/')[0]
        if (keep.has(entry) || req.keepAssetKeys.includes(entry.split('.')[0])) continue
        files.delete(fullPath)
        if (entry.startsWith('snapshot-')) removed.removedSnapshotDirNames.push(entry)
        else removed.removedAssetFileNames.push(entry)
      }
      return removed
    },
    pruneAutoSaveProjects: async () => ({ removedProjectDirs: [] }),
    writeTextFile: async (req: { outputPath: string; filename: string; content: string }) => {
      if (state.failProjectFileWrite) throw new Error('synthetic disk full')
      events.push('project-file')
      const fullPath = `${req.outputPath}/${req.filename}`
      text.set(fullPath, req.content)
      return { success: true, fullPath }
    },
    readTextFile: async ({ fullPath }: { fullPath: string }) => {
      const content = text.get(fullPath)
      if (content === undefined) throw new Error('File not found')
      return { content, filename: fullPath.split('/').pop()! }
    },
    readFileFromPath: async ({ fullPath }: { fullPath: string }) => {
      calls.readFileFromPath.push(fullPath)
      const data = readable(fullPath)
      if (!data) throw new Error(`File not found: ${fullPath}`)
      return { data, filename: fullPath.split('/').pop()! }
    },
    saveImageToPath: async ({ outputPath, filename }: { outputPath: string; filename: string }) => {
      calls.saveImageToPath.push(`${outputPath}/${filename}`)
      return { success: true, fullPath: `${outputPath}/${filename}` }
    },
    listFilesInFolder: async () => ({
      files: [...files.keys()].map((fullPath) => ({ fullPath, filename: fullPath.split('/').pop()! }))
    })
  }

  vi.stubGlobal('api', {
    svcFs,
    svcState: {
      getConfig: async () => ({ config: {} }),
      getUserDataDirectoryState: async () => ({
        state: { autoSaveRoot, projectRoot: '/home/u/Projects' }
      })
    },
    svcCanvasThumbnail: {
      getSourceFileMetadata: async ({ fullPath }: { fullPath: string }) => {
        const data = readable(fullPath)
        return data
          ? {
              exists: true,
              canonicalPath: fullPath,
              sizeBytes: data.byteLength,
              lastModifiedMs: 1_700_000_000_000
            }
          : { exists: false }
      }
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

  return {
    autoSaveRoot,
    files,
    text,
    localFiles,
    events,
    calls,
    state,
    resetCalls() {
      calls.copy.length = 0
      calls.write.length = 0
      calls.prune.length = 0
      calls.readFileFromPath.length = 0
      calls.saveImageToPath.length = 0
      events.length = 0
    },
    projectFilePath: (): string => [...text.keys()].find((name) => name.endsWith('.mpcanvas'))!,
    projectDir(): string {
      const projectFilePath = this.projectFilePath()
      return projectFilePath.slice(0, projectFilePath.lastIndexOf('/'))
    },
    project(): { items: Array<Record<string, unknown> & { id: string; src: string }> } {
      return JSON.parse(text.get(this.projectFilePath())!)
    },
    assetFiles(): string[] {
      return [...files.keys()].map((fullPath) => fullPath.slice(fullPath.lastIndexOf('/') + 1)).sort()
    },
    totalBytes: (): number => [...files.values()].reduce((sum, data) => sum + data.byteLength, 0)
  }
}

describe('content-addressed autosave mirror', () => {
  it('writes each asset once: saving the board again moves no bytes and adds no file', async () => {
    const mirror = createFakeMirror()
    const a = imageItem('a', registerSource('blob:mirror-a', [1, 2, 3]))
    const b = imageItem('b', registerSource('blob:mirror-b', [4, 5]))
    const twin = imageItem('twin', 'blob:mirror-a')
    await saveCanvasItems([a, b, twin], 'mirror-once')

    expect(mirror.assetFiles()).toEqual(
      [`${contentKey([1, 2, 3])}.png`, `${contentKey([4, 5])}.png`].sort()
    )
    expect(mirror.project().items.map((item) => item.src)).toEqual([
      `assets/${contentKey([1, 2, 3])}.png`,
      `assets/${contentKey([4, 5])}.png`,
      `assets/${contentKey([1, 2, 3])}.png`
    ])
    // The bytes read for IndexedDB are reused: nothing is fetched twice.
    expect(fetchCalls.sort()).toEqual(['blob:mirror-a', 'blob:mirror-b'])
    const sizeAfterFirstSave = mirror.totalBytes()

    for (let save = 0; save < 20; save += 1) {
      mirror.resetCalls()
      fetchCalls = []
      fake.resetLog()
      await saveCanvasItems(
        [{ ...a, x: save } as CanvasItem, { ...b, y: save } as CanvasItem, twin],
        'mirror-once'
      )
      expect(fetchCalls).toEqual([])
      expect(fake.blobPuts()).toEqual([])
      expect(mirror.calls.copy).toEqual([])
      expect(mirror.calls.write).toEqual([])
      expect(mirror.calls.readFileFromPath).toEqual([])
      expect(mirror.calls.saveImageToPath).toEqual([])
    }
    expect(mirror.totalBytes()).toBe(sizeAfterFirstSave)
    expect(mirror.assetFiles()).toHaveLength(2)
    expect([...mirror.files.keys()].some((fullPath) => fullPath.includes('snapshot-'))).toBe(false)
    expect(mirror.project().items[0]).toMatchObject({ id: 'a', x: 19 })
  })

  it('copies path-backed and managed images file-to-file and round-trips a POSIX path', async () => {
    const mirror = createFakeMirror()
    mirror.localFiles.set('/home/u/pics/ref one.png', new Uint8Array([7, 7, 7]))
    mirror.localFiles.set('/home/u/userData/managed/m1.png', new Uint8Array([8, 8]))
    const pathBacked = imageItem('path', 'local-media:///home/u/pics/ref%20one.png', {
      fileName: 'ref one.png'
    })
    const managed = imageItem('managed', 'local-media:///home/u/userData/managed/m1.png', {
      media: { kind: 'managed', id: 'media-1' }
    })
    await saveCanvasItems([pathBacked, managed], 'mirror-posix')

    // Main copied both files itself, from their absolute POSIX paths.
    expect(mirror.calls.copy.map((call) => call.sourcePath).sort()).toEqual([
      '/home/u/pics/ref one.png',
      '/home/u/userData/managed/m1.png'
    ])
    expect(mirror.calls.write).toEqual([])
    expect(mirror.calls.saveImageToPath).toEqual([])
    // Only the IndexedDB copy of the unmanaged image went through the renderer, once.
    expect(mirror.calls.readFileFromPath).toEqual(['/home/u/pics/ref one.png'])
    expect(mirror.assetFiles()).toHaveLength(2)

    mirror.resetCalls()
    await saveCanvasItems(
      [{ ...pathBacked, x: 5 } as CanvasItem, { ...managed, x: 6 } as CanvasItem],
      'mirror-posix'
    )
    expect(mirror.calls.copy).toEqual([])
    expect(mirror.calls.write).toEqual([])
    expect(mirror.calls.readFileFromPath).toEqual([])
    expect(mirror.assetFiles()).toHaveLength(2)

    // IndexedDB is gone: the board comes back from the mirror alone.
    fake = createFakeIndexedDb()
    vi.stubGlobal('indexedDB', fake.api)
    const restored = await loadCanvasItems('mirror-posix')
    expect(restored.items.map((item) => item.id)).toEqual(['path', 'managed'])
    const restoredSources = restored.items.map((item) => (item as { src: string }).src)
    for (const src of restoredSources) {
      expect(src.startsWith(`local-media://${mirror.projectDir()}/assets/f-`)).toBe(true)
    }
    // The managed-media reference scanner still finds the media id.
    expect((restored.items[1] as { media?: { id: string } }).media).toEqual({
      kind: 'managed',
      id: 'media-1'
    })

    // Saving the restored board reads the mirror file by its absolute path and
    // references the asset files where they are instead of copying them.
    mirror.resetCalls()
    await saveCanvasItems(restored.items, 'mirror-posix')
    expect(mirror.calls.readFileFromPath).toHaveLength(1)
    expect(mirror.calls.readFileFromPath[0].startsWith(`${mirror.projectDir()}/assets/f-`)).toBe(true)
    expect(mirror.calls.copy).toEqual([])
    expect(mirror.calls.write).toEqual([])
    expect(mirror.assetFiles()).toHaveLength(2)
    expect(mirror.project().items.map((item) => `${mirror.projectDir()}/${item.src}`).sort()).toEqual(
      restoredSources.map((src) => src.slice('local-media://'.length)).sort()
    )
    expect(fake.record('mirror-posix')!.items).toHaveLength(2)
    // The bytes go back into IndexedDB under the mirror's own keys, so the
    // board does not get a second set of keys (and a second mirror copy).
    const mirrorKeys = mirror.assetFiles().map((name) => name.split('.')[0])
    const pathRecord = fake.record('mirror-posix')!.items.find((item) => item.id === 'path')!
    expect(mirrorKeys).toContain(pathRecord.assetKey)
    expect(keyedBlobKeys()).toHaveLength(1)
    for (const key of keyedBlobKeys()) {
      expect(mirrorKeys.some((mirrorKey) => key.endsWith(`::canvas::asset::${mirrorKey}`))).toBe(true)
    }

    // Next session: restored from IndexedDB, saved again: still no copy, no new file.
    const reopened = await loadCanvasItems('mirror-posix')
    mirror.resetCalls()
    fake.resetLog()
    await saveCanvasItems(
      reopened.items.map((item) => ({ ...item, x: 9 }) as CanvasItem),
      'mirror-posix'
    )
    expect(fake.blobPuts()).toEqual([])
    expect(mirror.calls.copy).toEqual([])
    expect(mirror.calls.write).toEqual([])
    expect(mirror.calls.readFileFromPath).toEqual([])
    expect(mirror.assetFiles()).toHaveLength(2)
  })

  it('keys only content-keyed files directly in a mirror asset folder by their name', async () => {
    const mirror = createFakeMirror()
    // Same name shape, but outside <autoSaveRoot>/<project>/assets/: keyed by its file identity.
    const outsidePath = `/home/u/pics/assets/${contentKey([5, 5])}.png`
    mirror.localFiles.set(outsidePath, new Uint8Array([5, 5]))
    await saveCanvasItems([imageItem('outside', `local-media://${outsidePath}`)], 'mirror-name')
    const outsideKey = fake.record('mirror-name')!.items[0].assetKey
    expect(outsideKey).toMatch(/^f-[0-9a-f]{40}$/)
    expect(outsideKey).not.toBe(contentKey([5, 5]))
  })

  it('sends the bytes through the renderer when main refuses the direct copy', async () => {
    const mirror = createFakeMirror()
    mirror.state.refuseCopy = true
    mirror.localFiles.set('/mnt/share/big.png', new Uint8Array([3, 1, 4, 1, 5]))
    await saveCanvasItems([imageItem('big', 'local-media:///mnt/share/big.png')], 'mirror-refused')

    expect(mirror.calls.copy).toHaveLength(1)
    expect(mirror.calls.write).toHaveLength(1)
    expect(mirror.calls.write[0].bytes).toBe(5)
    expect(mirror.assetFiles()).toHaveLength(1)
    expect(mirror.project().items[0].src).toBe(`assets/${mirror.assetFiles()[0]}`)
  })

  it('keeps the previous project file and every asset it names when a save is interrupted', async () => {
    const mirror = createFakeMirror()
    const old = imageItem('pic', registerSource('blob:crash-old', [1, 1, 1]))
    await saveCanvasItems([old], 'mirror-crash')
    const previousProjectFile = mirror.text.get(mirror.projectFilePath())!
    const previousRefs = mirror.project().items.map((item) => item.src)
    const previousBytes = previousRefs.map((ref) => [...mirror.files.get(`${mirror.projectDir()}/${ref}`)!])

    // The asset of the new state is written, the project file is not.
    mirror.state.failProjectFileWrite = true
    mirror.resetCalls()
    const next = imageItem('pic', registerSource('blob:crash-new', [2, 2, 2, 2]))
    await expect(saveCanvasItems([next], 'mirror-crash')).resolves.toBeUndefined()

    expect(mirror.calls.write).toHaveLength(1)
    expect(mirror.calls.prune).toEqual([])
    expect(mirror.text.get(mirror.projectFilePath())).toBe(previousProjectFile)
    previousRefs.forEach((ref, index) => {
      expect([...mirror.files.get(`${mirror.projectDir()}/${ref}`)!]).toEqual(previousBytes[index])
    })

    // Recovery from the mirror alone yields the previous board, complete.
    fake = createFakeIndexedDb()
    vi.stubGlobal('indexedDB', fake.api)
    const recovered = await loadCanvasItems('mirror-crash')
    expect(recovered.items).toHaveLength(1)
    expect((recovered.items[0] as { src: string }).src).toBe(
      `local-media://${mirror.projectDir()}/${previousRefs[0]}`
    )

    // The next successful save completes the interrupted one without rewriting the asset.
    mirror.state.failProjectFileWrite = false
    vi.stubGlobal('indexedDB', fake.api)
    mirror.resetCalls()
    await saveCanvasItems([next], 'mirror-crash')
    expect(mirror.calls.write).toEqual([])
    expect(mirror.project().items[0].src).toBe(`assets/${contentKey([2, 2, 2, 2])}.png`)
  })

  it('prunes only after the project file is acknowledged and protects what can come back', async () => {
    const mirror = createFakeMirror()
    const keep = imageItem('keep', registerSource('blob:prune-keep', [1]))
    const undoable = imageItem('undoable', registerSource('blob:prune-undo', [2, 2]))
    await saveCanvasItems([keep, undoable], 'mirror-prune')
    expect(mirror.events.indexOf('prune')).toBeGreaterThan(mirror.events.indexOf('project-file'))
    expect(
      mirror.events.filter((event) => event.startsWith('asset:')).every(
        (event) => mirror.events.indexOf(event) < mirror.events.indexOf('project-file')
      )
    ).toBe(true)

    // A restored item of an earlier version still points into a snapshot folder of the mirror.
    const snapshotDir = 'snapshot-11111111-2222-3333-4444-555555555555'
    const legacyPath = `${mirror.projectDir()}/assets/${snapshotDir}/images/legacy.png`
    mirror.files.set(legacyPath, new Uint8Array([9, 9, 9]))
    const legacy = imageItem('legacy', `local-media://${legacyPath}`)

    mirror.resetCalls()
    await saveCanvasItems([keep, legacy], 'mirror-prune', [], [], null, {
      getProtectedItems: () => [[keep, undoable]]
    })
    expect(mirror.calls.prune).toHaveLength(1)
    const [{ keepAssetKeys, keepEntryNames }] = mirror.calls.prune
    expect(keepAssetKeys).toContain(contentKey([1]))
    expect(keepAssetKeys).toContain(contentKey([2, 2]))
    expect(keepEntryNames).toEqual([snapshotDir])
    // The legacy file was copied into the content-addressed layout, not referenced in place.
    expect(mirror.project().items[1].src).toMatch(/^assets\/f-[0-9a-f]{40}\.png$/)

    // When the history cannot be read nothing is pruned at all.
    mirror.resetCalls()
    await saveCanvasItems([keep], 'mirror-prune', [], [], null, {
      getProtectedItems: () => {
        throw new Error('history unavailable')
      }
    })
    expect(mirror.calls.prune).toEqual([])
  })

  it('mirrors remote and inline sources once, keyed by their source string', async () => {
    const mirror = createFakeMirror()
    const remote = imageItem('remote', registerSource('https://example.invalid/a.png', [5, 5, 5]))
    const inline = imageItem('inline', 'data:image/png;base64,AQID')
    await saveCanvasItems([remote, inline], 'mirror-remote')

    expect(mirror.assetFiles()).toHaveLength(2)
    expect(mirror.assetFiles().every((name) => /^u-[0-9a-f]{40}\.png$/.test(name))).toBe(true)
    expect(fetchCalls).toEqual(['https://example.invalid/a.png'])
    // IndexedDB keeps the source strings themselves; only the mirror holds copies.
    expect(fake.blobKeys()).toEqual([])
    expect(fake.record('mirror-remote')!.items.map((item) => item.src)).toEqual([
      'https://example.invalid/a.png',
      'data:image/png;base64,AQID'
    ])

    mirror.resetCalls()
    fetchCalls = []
    await saveCanvasItems(
      [{ ...remote, x: 1 } as CanvasItem, { ...inline, x: 2 } as CanvasItem],
      'mirror-remote'
    )
    expect(fetchCalls).toEqual([])
    expect(mirror.calls.write).toEqual([])
  })

  it('hashes a long inline source once while its item is unchanged', async () => {
    const mirror = createFakeMirror()
    const longInline = `data:image/png;base64,${'QUJD'.repeat(4096)}`
    const inline = imageItem('long-inline', longInline)
    const digest = vi.spyOn(globalThis.crypto.subtle, 'digest')
    const longDigests = () =>
      digest.mock.calls.filter(([, data]) => (data as ArrayBufferView).byteLength >= longInline.length)
        .length
    try {
      await saveCanvasItems([inline], 'mirror-long-inline')
      expect(mirror.assetFiles()).toHaveLength(1)
      expect(longDigests()).toBe(1)

      digest.mockClear()
      mirror.resetCalls()
      await saveCanvasItems([inline, imageItem('other', 'data:image/png;base64,AQID')], 'mirror-long-inline')
      expect(longDigests()).toBe(0)
      expect(mirror.calls.write).toHaveLength(1)
    } finally {
      digest.mockRestore()
    }
  })

  it('leaves the source of an item untouched when its bytes cannot be mirrored', async () => {
    const mirror = createFakeMirror()
    await saveCanvasItems([imageItem('lost', 'https://example.invalid/missing.png')], 'mirror-lost')
    expect(mirror.assetFiles()).toEqual([])
    expect(mirror.project().items[0].src).toBe('https://example.invalid/missing.png')
  })
})

describe('metadata-only saves', () => {
  it('writes nothing at all when an asset still has to be stored', async () => {
    const mirror = createFakeMirror()
    const item = imageItem('new', registerSource('blob:meta-new', [1, 2, 3]))

    await expect(
      saveCanvasItems([item], 'meta-only', [], [], null, { metadataOnly: true })
    ).resolves.toBe('needs-bytes')
    expect(fetchCalls).toEqual([])
    expect(fake.record('meta-only')).toBeUndefined()
    expect(fake.blobKeys()).toEqual([])
    expect(mirror.text.size).toBe(0)
    expect(mirror.files.size).toBe(0)
    expect(mirror.calls.write).toEqual([])
    expect(mirror.calls.copy).toEqual([])
  })

  it('saves the record and the project file when every asset is already stored', async () => {
    const mirror = createFakeMirror()
    const item = imageItem('known', registerSource('blob:meta-known', [4, 4]))
    await saveCanvasItems([item], 'meta-ok')

    mirror.resetCalls()
    fetchCalls = []
    fake.resetLog()
    await expect(
      saveCanvasItems([{ ...item, x: 77 } as CanvasItem], 'meta-ok', [], [], null, {
        metadataOnly: true
      })
    ).resolves.toBeUndefined()

    expect(fetchCalls).toEqual([])
    expect(fake.blobPuts()).toEqual([])
    expect(mirror.calls.write).toEqual([])
    expect(mirror.calls.copy).toEqual([])
    expect(mirror.calls.readFileFromPath).toEqual([])
    expect(fake.record('meta-ok')!.items[0]).toMatchObject({ id: 'known', x: 77 })
    expect(mirror.project().items[0]).toMatchObject({ id: 'known', x: 77 })
  })

  it('refuses when only the mirror lacks an asset, and leaves the stored record alone', async () => {
    const mirror = createFakeMirror()
    const item = imageItem('half', registerSource('blob:meta-half', [6]))
    await saveCanvasItems([item], 'meta-mirror')
    const recordBefore = JSON.stringify(fake.record('meta-mirror'))
    mirror.files.clear()

    await expect(
      saveCanvasItems([{ ...item, x: 5 } as CanvasItem], 'meta-mirror', [], [], null, {
        metadataOnly: true
      })
    ).resolves.toBe('needs-bytes')
    expect(JSON.stringify(fake.record('meta-mirror'))).toBe(recordBefore)
    expect(mirror.files.size).toBe(0)

    // The following ordinary save repairs the mirror.
    await saveCanvasItems([{ ...item, x: 5 } as CanvasItem], 'meta-mirror')
    expect(mirror.assetFiles()).toEqual([`${contentKey([6])}.png`])
    expect(fake.record('meta-mirror')!.items[0]).toMatchObject({ x: 5 })
  })
})

describe('boards saved by an earlier version', () => {
  const legacyBlob = (bytes: number[], mimeType = 'image/png') => ({
    data: new Uint8Array(bytes).buffer,
    mimeType
  })

  function seedLegacyBoard(storeKey: string) {
    const model = {
      ...(imageItem('old-model', '') as object),
      type: 'model3d',
      fileName: 'old.glb',
      textures: { diffuse: 'blob:stale-texture-url' }
    }
    fake.committed.get('canvas-items')!.set(storeKey, {
      items: [
        { ...(imageItem('old-a', '') as object), src: '' },
        { ...(imageItem('old-b', '') as object), src: '', caption: 'kept' },
        model,
        { id: 'note', type: 'text', text: 'hello', x: 0, y: 0, zIndex: 3 }
      ],
      groups: [],
      groupBranches: [],
      figmaBinding: null
    })
    const blobs = fake.committed.get('canvas-blobs')!
    blobs.set(`${storeKey}::canvas::old-a`, legacyBlob([1, 1, 1]))
    blobs.set(`${storeKey}::canvas::old-b`, legacyBlob([2, 2]))
    blobs.set(`${storeKey}::canvas::old-model`, legacyBlob([3], 'model/gltf-binary'))
    blobs.set(`${storeKey}::canvas::old-model::tex::diffuse`, legacyBlob([4, 4, 4, 4]))
    // An orphan of a long-deleted item, another canvas and a pre-scope blob.
    blobs.set(`${storeKey}::canvas::deleted-long-ago`, legacyBlob([9]))
    blobs.set('another-board::canvas::old-a', legacyBlob([7]))
    blobs.set('old-a', legacyBlob([8]))
  }

  const legacyKeysOf = (storeKey: string) =>
    fake.blobKeys().filter(
      (key) => key.startsWith(`${storeKey}::canvas::`) && !key.includes('::canvas::asset::')
    )

  it('opens with every binary and is re-keyed by its first save', async () => {
    seedLegacyBoard('migrate')
    const loaded = await loadCanvasItems('migrate')
    expect(loaded.items.map((item) => item.id)).toEqual(['old-a', 'old-b', 'old-model', 'note'])
    for (const item of loaded.items.slice(0, 3)) {
      expect((item as { src: string }).src).toMatch(/^blob:restored-/)
    }

    fake.resetLog()
    await saveCanvasItems(loaded.items, 'migrate')
    expect(fake.blobPuts().every((put) => put.key.includes('::canvas::asset::'))).toBe(true)

    // Every binary is now stored under its content key, byte for byte...
    const record = fake.record('migrate')!
    expect(record.items.map((item) => item.assetKey)).toEqual([
      contentKey([1, 1, 1]),
      contentKey([2, 2]),
      contentKey([3]),
      undefined
    ])
    expect(record.items[2].textureAssetKeys).toEqual({ diffuse: contentKey([4, 4, 4, 4]) })
    expect(record.items[1]).toMatchObject({ caption: 'kept' })
    for (const bytes of [[1, 1, 1], [2, 2], [3], [4, 4, 4, 4]]) {
      expect(fake.blobBytes(assetBlobKey('migrate', bytes))).toEqual(bytes)
    }
    // ...while the per-item blobs of its items stay for the previous release; only
    // the orphan of an item no record holds any more is swept. Nothing else is touched.
    expect(legacyKeysOf('migrate')).toEqual(
      [
        'migrate::canvas::old-a',
        'migrate::canvas::old-b',
        'migrate::canvas::old-model',
        'migrate::canvas::old-model::tex::diffuse'
      ].sort()
    )
    expect(fake.blobBytes('migrate::canvas::old-a')).toEqual([1, 1, 1])
    expect(fake.blobKeys()).toContain('another-board::canvas::old-a')
    expect(fake.blobKeys()).toContain('old-a')

    // The migrated board reopens completely and its next save moves no bytes.
    const reopened = await loadCanvasItems('migrate')
    expect(reopened.items.map((item) => item.id)).toEqual(['old-a', 'old-b', 'old-model', 'note'])
    fake.resetLog()
    fetchCalls = []
    await saveCanvasItems(reopened.items, 'migrate')
    expect(fake.blobPuts()).toEqual([])
    expect(fetchCalls).toEqual([])
  })

  it('keeps every old blob when the first save does not commit', async () => {
    seedLegacyBoard('migrate-abort')
    const loaded = await loadCanvasItems('migrate-abort')
    const recordBefore = JSON.stringify(fake.record('migrate-abort'))
    const legacyBefore = legacyKeysOf('migrate-abort')

    fake.failNext({ store: 'canvas-items', mode: 'async-abort' })
    await expect(saveCanvasItems(loaded.items, 'migrate-abort')).rejects.toThrow()

    expect(JSON.stringify(fake.record('migrate-abort'))).toBe(recordBefore)
    expect(legacyKeysOf('migrate-abort')).toEqual(legacyBefore)
    // The old form still opens with everything.
    const reopened = await loadCanvasItems('migrate-abort')
    expect(reopened.items.map((item) => item.id)).toEqual(['old-a', 'old-b', 'old-model', 'note'])
  })

  it('keeps the old blobs whether or not the mirror has acknowledged the board', async () => {
    seedLegacyBoard('migrate-mirror')
    const mirror = createFakeMirror()
    mirror.state.failProjectFileWrite = true
    const loaded = await loadCanvasItems('migrate-mirror')
    const legacyBefore = legacyKeysOf('migrate-mirror')

    await saveCanvasItems(loaded.items, 'migrate-mirror')
    expect(fake.record('migrate-mirror')!.items[0].assetKey).toBe(contentKey([1, 1, 1]))
    expect(legacyKeysOf('migrate-mirror')).toEqual(
      legacyBefore.filter((key) => !key.endsWith('::deleted-long-ago'))
    )

    mirror.state.failProjectFileWrite = false
    await saveCanvasItems(loaded.items, 'migrate-mirror')
    expect(legacyKeysOf('migrate-mirror')).toEqual(
      legacyBefore.filter((key) => !key.endsWith('::deleted-long-ago'))
    )
    expect(mirror.project().items).toHaveLength(4)
  })

  it('keeps the per-item blob of a stored item that has no content key', async () => {
    // A managed image saved by an earlier version that still stored its bytes per item.
    const managed = {
      ...(imageItem('managed-old', 'local-media:///C:/managed/m.png') as object),
      media: { kind: 'managed', id: 'media-9' }
    }
    fake.committed.get('canvas-items')!.set('migrate-managed', {
      items: [managed],
      groups: [],
      groupBranches: [],
      figmaBinding: null
    })
    fake.committed
      .get('canvas-blobs')!
      .set('migrate-managed::canvas::managed-old', legacyBlob([5, 5]))

    await saveCanvasItems([managed as unknown as CanvasItem], 'migrate-managed')
    expect(fake.record('migrate-managed')!.items[0].assetKey).toBeUndefined()
    expect(fake.blobKeys()).toEqual(['migrate-managed::canvas::managed-old'])
  })
})

// ─── Rollback to the previous release ───────────────────────────────────────
// The previous release (3339aece) restores a blob-backed item only when its
// record entry has no src and a blob is stored under <storeKey>::canvas::<id>
// (model textures: <id>::tex::<name>). This mirrors that loader's look-up.
function loadLikePreviousRelease(storeKey: string): Map<string, number[]> {
  const record = fake.record(storeKey) as
    | { items: Array<Record<string, unknown> & { id: string }> }
    | undefined
  const restored = new Map<string, number[]>()
  for (const item of record?.items ?? []) {
    if (!['image', 'model3d', 'video', 'file'].includes(item.type as string)) continue
    if (item.src) continue
    const blob = fake.committed.get('canvas-blobs')!.get(legacyBlobKey(storeKey, item.id)) as
      | { data: ArrayBuffer }
      | undefined
    if (blob) restored.set(item.id, Array.from(new Uint8Array(blob.data)))
    const textures = item.textures as Record<string, string> | undefined
    for (const name of Object.keys(textures ?? {})) {
      const texture = fake.committed
        .get('canvas-blobs')!
        .get(legacyBlobKey(storeKey, `${item.id}::tex::${name}`)) as { data: ArrayBuffer } | undefined
      if (texture) restored.set(`${item.id}::tex::${name}`, Array.from(new Uint8Array(texture.data)))
    }
  }
  return restored
}

function readBlobBytes(blob: Blob): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(Array.from(new Uint8Array(reader.result as ArrayBuffer)))
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(blob)
  })
}

describe('rollback to the previous release', () => {
  const modelItem = (id: string, src: string, textures: Record<string, string>): CanvasItem =>
    ({ ...(imageItem(id, src) as object), type: 'model3d', fileName: `${id}.glb`, textures }) as unknown as CanvasItem

  it('gives every blob item a per-item blob with the bytes of its keyed blob', async () => {
    const shared = registerSource('blob:rb-shared', [1, 2, 3])
    const items = [
      imageItem('a', shared),
      imageItem('a-copy', shared, { x: 30 }),
      imageItem('b', registerSource('blob:rb-b', [4, 5])),
      modelItem('m', registerSource('blob:rb-m', [6]), { 'skin.png': registerSource('blob:rb-tex', [7, 7]) }),
      { id: 'note', type: 'text', text: 'hi', x: 0, y: 0, zIndex: 2 } as unknown as CanvasItem
    ]
    await saveCanvasItems(items, 'rb-pairs')

    const record = fake.record('rb-pairs')! as unknown as {
      assetFormat: number
      legacyBlobAssetKeys: Record<string, string>
      items: Array<Record<string, unknown> & { id: string }>
    }
    expect(record.assetFormat).toBe(2)
    for (const item of record.items.filter((entry) => entry.type !== 'text')) {
      expect(item.src).toBe('')
      const keyed = fake.blobBytes(`rb-pairs::canvas::asset::${item.assetKey as string}`)
      expect(fake.blobBytes(legacyBlobKey('rb-pairs', item.id))).toEqual(keyed)
      expect(record.legacyBlobAssetKeys[item.id]).toBe(item.assetKey)
    }
    expect(fake.blobBytes(legacyBlobKey('rb-pairs', 'm::tex::skin.png'))).toEqual(
      fake.blobBytes(assetBlobKey('rb-pairs', [7, 7]))
    )
    // The previous release's loader finds every image, the copy and the texture included.
    expect(Object.fromEntries(loadLikePreviousRelease('rb-pairs'))).toEqual({
      a: [1, 2, 3],
      'a-copy': [1, 2, 3],
      b: [4, 5],
      m: [6],
      'm::tex::skin.png': [7, 7]
    })

    // Never more than once per item: later saves, also after a reopen, move nothing.
    for (let round = 0; round < 3; round += 1) {
      fake.resetLog()
      fetchCalls = []
      await saveCanvasItems(items.map((item) => ({ ...item, y: round }) as CanvasItem), 'rb-pairs')
      expect(fake.blobPuts()).toEqual([])
      expect(fetchCalls).toEqual([])
    }
    const reopened = await loadCanvasItems('rb-pairs')
    fake.resetLog()
    fetchCalls = []
    await saveCanvasItems(reopened.items, 'rb-pairs', [], [], null, { metadataOnly: true })
    expect(fake.blobPuts()).toEqual([])
    expect(fetchCalls).toEqual([])
  })

  it('writes the per-item blob of a new item once, from the stored bytes when they need no read', async () => {
    const original = imageItem('first', registerSource('blob:rb-dup', [8, 8, 8]))
    await saveCanvasItems([original], 'rb-dup')

    // A duplicate shares the stored content key: its per-item copy comes from the keyed blob.
    fake.resetLog()
    fetchCalls = []
    const duplicate = { ...original, id: 'second', x: 50 } as CanvasItem
    await saveCanvasItems([original, duplicate], 'rb-dup')
    expect(fetchCalls).toEqual([])
    expect(fake.blobPuts().map((put) => put.key)).toEqual([legacyBlobKey('rb-dup', 'second')])
    expect(fake.blobBytes(legacyBlobKey('rb-dup', 'second'))).toEqual([8, 8, 8])

    // A metadata-only flush cannot write it: it asks for a full save instead.
    const third = { ...original, id: 'third', x: 90 } as CanvasItem
    fake.resetLog()
    await expect(
      saveCanvasItems([original, duplicate, third], 'rb-dup', [], [], null, { metadataOnly: true })
    ).resolves.toBe('needs-bytes')
    expect(fake.log.puts).toEqual([])
  })

  it('rewrites the per-item blob when the image of an item is replaced', async () => {
    const item = imageItem('edited', registerSource('blob:rb-old', [1, 1]))
    await saveCanvasItems([item], 'rb-replace')
    const replaced = { ...item, src: registerSource('blob:rb-new', [2, 2, 2]) } as CanvasItem
    await saveCanvasItems([replaced], 'rb-replace')

    expect(fake.blobBytes(legacyBlobKey('rb-replace', 'edited'))).toEqual([2, 2, 2])
    expect(loadLikePreviousRelease('rb-replace').get('edited')).toEqual([2, 2, 2])
    fake.resetLog()
    await saveCanvasItems([{ ...replaced, x: 4 } as CanvasItem], 'rb-replace')
    expect(fake.blobPuts()).toEqual([])
  })

  it('restores the bytes the previous release changed when its record carries no format marker', async () => {
    const item = imageItem('pic', registerSource('blob:rb-v2', [3, 3, 3]))
    await saveCanvasItems([item], 'rb-unmarked')
    const keyedBefore = fake.record('rb-unmarked')!.items[0].assetKey as string

    // The previous release replaced the image of 'pic' and saved: it carried the
    // item's old assetKey through, wrote the per-item blob and dropped the marker.
    const record = fake.record('rb-unmarked')! as unknown as Record<string, unknown>
    fake.committed.get('canvas-items')!.set('rb-unmarked', {
      items: record.items,
      groups: [],
      groupBranches: [],
      figmaBinding: null
    })
    fake.committed.get('canvas-blobs')!.set(legacyBlobKey('rb-unmarked', 'pic'), {
      data: new Uint8Array([9, 9]).buffer,
      mimeType: 'image/png'
    })

    const loaded = await loadCanvasItems('rb-unmarked')
    const restored = loaded.items[0] as CanvasItem & { src: string }
    const blob = restoredBlobs.get(restored.src)!
    expect(await readBlobBytes(blob)).toEqual([9, 9])
    expect(restored).not.toHaveProperty('assetKeySource')

    // The next save re-keys from those bytes and moves no other byte.
    fake.resetLog()
    await saveCanvasItems(loaded.items, 'rb-unmarked')
    const saved = fake.record('rb-unmarked')!.items[0]
    expect(saved.assetKey).toBe(contentKey([9, 9]))
    expect(saved.assetKey).not.toBe(keyedBefore)
    expect(fake.blobPuts().map((put) => put.key)).toEqual([assetBlobKey('rb-unmarked', [9, 9])])
    expect(fake.blobBytes(legacyBlobKey('rb-unmarked', 'pic'))).toEqual([9, 9])
  })

  it('still opens an unmarked record whose per-item blob is missing from its keyed blob', async () => {
    const item = imageItem('only-keyed', registerSource('blob:rb-keyed-only', [5, 6]))
    await saveCanvasItems([item], 'rb-keyed-only')
    const record = fake.record('rb-keyed-only')! as unknown as Record<string, unknown>
    fake.committed.get('canvas-items')!.set('rb-keyed-only', { items: record.items })
    fake.committed.get('canvas-blobs')!.delete(legacyBlobKey('rb-keyed-only', 'only-keyed'))

    const loaded = await loadCanvasItems('rb-keyed-only')
    expect(loaded.items).toHaveLength(1)
    const blob = restoredBlobs.get((loaded.items[0] as { src: string }).src)!
    expect(await readBlobBytes(blob)).toEqual([5, 6])
  })

  it('sweeps the keyed and the per-item blobs of deleted items once they leave the history', async () => {
    const a = imageItem('del-a', registerSource('blob:rb-del-a', [1]))
    const b = imageItem('del-b', registerSource('blob:rb-del-b', [2]))
    await saveCanvasItems([a, b], 'rb-delete')
    expect(fake.blobKeys()).toHaveLength(4)

    // Delete all: the undo history still holds both items, so all four blobs stay.
    await saveCanvasItems([], 'rb-delete', [], [], null, { getProtectedItems: () => [[a, b]] })
    expect(fake.blobKeys()).toHaveLength(4)
    // The history window moved on: nothing can bring them back.
    await saveCanvasItems([], 'rb-delete', [], [], null, { getProtectedItems: () => [[]] })
    await saveCanvasItems([], 'rb-delete', [], [], null, { getProtectedItems: () => [[]] })
    expect(fake.blobKeys()).toEqual([])
  })
})

// ─── The mirror never prunes the last copy of an asset ──────────────────────
describe('mirror prune with assets that cannot be staged', () => {
  const MANAGED_SHA = 'a1'.repeat(32)

  it('keeps the old mirror copy of a managed image whose managed file is gone', async () => {
    const mirror = createFakeMirror()
    mirror.state.applyPrune = true
    const managedPath = '/home/u/userData/managed/canvas/m1.png'
    mirror.localFiles.set(managedPath, new Uint8Array([8, 8, 8]))
    const managed = imageItem('managed', `local-media://${managedPath}`, {
      media: {
        version: 1,
        kind: 'managed',
        relativePath: 'canvas/m1.png',
        sha256: MANAGED_SHA,
        sizeBytes: 3,
        mimeType: 'image/png',
        originalFileName: 'm1.png'
      }
    })
    const note = { id: 'note', type: 'text', text: 'hi', x: 0, y: 0, zIndex: 2 } as unknown as CanvasItem
    await saveCanvasItems([managed, note], 'managed-gone')
    const copyName = `b-${MANAGED_SHA.slice(0, 40)}.png`
    expect(mirror.assetFiles()).toEqual([copyName])
    expect(mirror.project().items[0].src).toBe(`assets/${copyName}`)

    // The managed store loses the file; the app restarts (no session caches) and the board is edited.
    mirror.localFiles.delete(managedPath)
    vi.resetModules()
    const restarted = await import('./canvasStorage')
    const reopened = await restarted.loadCanvasItems('managed-gone')
    expect((reopened.items[0] as { src: string }).src).toBe(`local-media://${managedPath}`)
    mirror.resetCalls()
    await restarted.saveCanvasItems(
      reopened.items.map((item) => ({ ...item, x: 12 }) as CanvasItem),
      'managed-gone'
    )

    expect(mirror.assetFiles()).toEqual([copyName])
    expect([...mirror.files.get(`${mirror.projectDir()}/assets/${copyName}`)!]).toEqual([8, 8, 8])
    expect(mirror.project().items[0]).toMatchObject({ x: 12, src: `assets/${copyName}` })
  })

  it('carries the previous reference of a managed image without a recorded hash', async () => {
    const mirror = createFakeMirror()
    mirror.state.applyPrune = true
    const managedPath = '/home/u/userData/managed/m2.png'
    mirror.localFiles.set(managedPath, new Uint8Array([6, 6]))
    const managed = imageItem('managed', `local-media://${managedPath}`, {
      media: { kind: 'managed', id: 'media-2' }
    })
    await saveCanvasItems([managed], 'managed-nohash')
    const [copyName] = mirror.assetFiles()
    expect(copyName).toMatch(/^f-[0-9a-f]{40}\.png$/)

    mirror.localFiles.delete(managedPath)
    vi.resetModules()
    const restarted = await import('./canvasStorage')
    const reopened = await restarted.loadCanvasItems('managed-nohash')
    await restarted.saveCanvasItems(
      reopened.items.map((item) => ({ ...item, y: 4 }) as CanvasItem),
      'managed-nohash'
    )

    // The key cannot be computed now; the new project file keeps pointing at the old copy.
    expect(mirror.assetFiles()).toEqual([copyName])
    expect(mirror.project().items[0]).toMatchObject({ y: 4, src: `assets/${copyName}` })
    expect(mirror.calls.prune.at(-1)!.keepEntryNames).toContain(copyName)
  })

  it('keeps the snapshot folder of a board saved by an earlier version whose remote source is down', async () => {
    const mirror = createFakeMirror()
    mirror.state.applyPrune = true
    const remoteUrl = 'http://127.0.0.1:8188/view?filename=ComfyUI_00042_.png&type=output'
    const snapshotDir = 'snapshot-11111111-2222-3333-4444-555555555555'
    const projectDir = `${mirror.autoSaveRoot}/${buildProjectStorageDirName('old-board', 'old-board')}`
    // Saved by the earlier version: IndexedDB holds the remote URL, the mirror its only offline copy.
    fake.committed.get('canvas-items')!.set('old-board', {
      items: [{ ...(imageItem('remote', remoteUrl) as object) }],
      groups: [],
      groupBranches: [],
      figmaBinding: null
    })
    mirror.text.set(
      `${projectDir}/project.mpcanvas`,
      JSON.stringify({
        magic: 'MAGICPOT_CANVAS',
        version: 8,
        storageMode: 'project',
        items: [{ ...(imageItem('remote', `assets/${snapshotDir}/images/remote.png`) as object) }],
        groups: [],
        groupBranches: []
      })
    )
    mirror.files.set(`${projectDir}/assets/${snapshotDir}/images/remote.png`, new Uint8Array([4, 2]))
    mirror.files.set(`${projectDir}/assets/snapshot-99999999-2222-3333-4444-555555555555/images/x.png`, new Uint8Array([1]))

    // First save after the upgrade, with the server down.
    const loaded = await loadCanvasItems('old-board')
    expect((loaded.items[0] as { src: string }).src).toBe(remoteUrl)
    await saveCanvasItems(loaded.items.map((item) => ({ ...item, x: 3 }) as CanvasItem), 'old-board')

    expect(mirror.project().items[0]).toMatchObject({
      x: 3,
      src: `assets/${snapshotDir}/images/remote.png`
    })
    expect(mirror.files.has(`${projectDir}/assets/${snapshotDir}/images/remote.png`)).toBe(true)
    // An unreferenced old snapshot nothing needs is still cleaned up.
    expect([...mirror.files.keys()].some((key) => key.includes('snapshot-99999999'))).toBe(false)

    // IndexedDB is lost: the board comes back from the mirror alone, with its image.
    fake = createFakeIndexedDb()
    vi.stubGlobal('indexedDB', fake.api)
    const recovered = await loadCanvasItems('old-board')
    expect(recovered.items.map((item) => item.id)).toEqual(['remote'])
    expect((recovered.items[0] as { src: string }).src).toBe(
      `local-media://${projectDir}/assets/${snapshotDir}/images/remote.png`
    )
  })

  it('prunes nothing when an unstaged asset has no earlier copy to fall back to', async () => {
    const mirror = createFakeMirror()
    mirror.state.applyPrune = true
    const keep = imageItem('keep', registerSource('blob:unsafe-keep', [1, 2]))
    await saveCanvasItems([keep], 'unsafe-new')
    const orphan = `${mirror.projectDir()}/assets/b-${'0'.repeat(40)}.png`
    mirror.files.set(orphan, new Uint8Array([9]))

    mirror.resetCalls()
    await saveCanvasItems([keep, imageItem('down', 'https://example.invalid/down.png')], 'unsafe-new')
    expect(mirror.calls.prune).toEqual([])
    expect(mirror.files.has(orphan)).toBe(true)
    expect(mirror.project().items[1].src).toBe('https://example.invalid/down.png')
  })
})
