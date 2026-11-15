import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { countCanvasAssetKeyReferences, loadCanvasItems, saveCanvasItems } from './canvasStorage'
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

describe('content-addressed canvas blob store', () => {
  it('stores the bytes once: saving the same board again writes metadata only', async () => {
    const items = [
      imageItem('a', registerSource('blob:twice-a', [1, 1, 1, 1])),
      imageItem('b', registerSource('blob:twice-b', [2, 2, 2, 2, 2]))
    ]
    await saveCanvasItems(items, 'twice')
    expect(fake.blobPuts().map((put) => put.key).sort()).toEqual(
      [assetBlobKey('twice', [1, 1, 1, 1]), assetBlobKey('twice', [2, 2, 2, 2, 2])].sort()
    )
    expect(fake.blobPuts().reduce((sum, put) => sum + put.bytes, 0)).toBe(9)

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
    expect(fake.blobPuts()).toHaveLength(1)

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

    expect(fake.blobKeys()).toEqual([assetBlobKey('shared', [3, 3, 3])])
    expect(countCanvasAssetKeyReferences(fake.record('shared')!.items)).toEqual(
      new Map([[contentKey([3, 3, 3]), 2]])
    )

    // Deleting one of the two must not take the blob the other still uses.
    await saveCanvasItems([copy], 'shared')
    expect(fake.blobKeys()).toEqual([assetBlobKey('shared', [3, 3, 3])])
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
    expect(fake.blobKeys()).toEqual([assetBlobKey('undo', [8])])
  })

  it('stores the bytes again when a pruned asset comes back', async () => {
    const item = imageItem('back', registerSource('blob:back-1', [9, 8, 7]))
    await saveCanvasItems([item], 'back')
    await saveCanvasItems([], 'back')
    expect(fake.blobKeys()).toEqual([])

    await saveCanvasItems([item], 'back')
    expect(fake.blobKeys()).toEqual([assetBlobKey('back', [9, 8, 7])])
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
    expect(fake.blobKeys()).toEqual([assetBlobKey('history-fail', [1, 2])])
  })

  it('never deletes blobs of another canvas, legacy per-item blobs or foreign keys', async () => {
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

    expect(fake.blobKeys()).toEqual(
      [
        'other-canvas::canvas::asset::' + contentKey([1]),
        'prune-scope::canvas::legacy-item-id',
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
    expect(fake.blobKeys()).toEqual([assetBlobKey('refuse', [1, 2, 3])])
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
    expect(fake.blobKeys()).toEqual(
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
    expect(fake.blobKeys()).toEqual(
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
