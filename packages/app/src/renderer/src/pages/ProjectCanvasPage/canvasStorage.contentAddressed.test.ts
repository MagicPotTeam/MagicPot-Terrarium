import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  canvasMirrorSeedStats,
  canvasMirrorDetachedCopyConfig,
  getCanvasMirrorDetachedCopyStats,
  waitForCanvasMirrorDetachedCopies,
  canvasProtectedStateWalkStats,
  canvasRecordReadStats,
  clearCanvasItems,
  countCanvasAssetKeyReferences,
  getCanvasMirrorEntryNameCacheStats,
  loadCanvasItems,
  loadCanvasItemsMetadata,
  saveCanvasItems
} from './canvasStorage'
import type { CanvasItem } from './types'
import { createCanvasHistorySnapshot } from './canvasHistory'
import { buildProjectStorageDirName } from '@shared/projectStorage'
import { formatLocalFileUnavailableMessage } from '@shared/api/svcFs'
import type { ChatAttachment } from '@shared/api/svcLLMProxy'
import {
  importIncomingChatImageAttachment,
  type IncomingChatImageImportOptions
} from '../ChatPage/chatManagedMediaAttachments'

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
    // tx: serial of the put's transaction; inFlight: puts into the same store in that
    // transaction still waiting for their success callback when this one was issued.
    puts: [] as Array<{ store: string; key: string; bytes: number; tx: number; inFlight: number }>,
    deletes: [] as Array<{ store: string; key: string }>,
    gets: [] as Array<{ store: string; key: string; stores: string[] }>,
    transactions: [] as Array<{
      stores: string[]
      mode: string
      committed: boolean
      aborted: boolean
      serial: number
      /** Serials of the transactions that had committed when this one was opened. */
      openedAfter: number[]
    }>
  }
  let nextTransactionSerial = 0
  const committedSerials: number[] = []
  let failure: { store: string; mode: 'sync-throw' | 'async-abort' } | null = null
  let beforeTransaction: ((stores: string[], mode: string) => void) | null = null

  const database = {
    objectStoreNames: { contains: (name: string) => committed.has(name) },
    createObjectStore: (name: string) => committed.set(name, new Map()),
    close: vi.fn(),
    transaction(names: string | string[], mode: string = 'readonly') {
      const scope = typeof names === 'string' ? [names] : [...names]
      beforeTransaction?.(scope, mode)
      nextTransactionSerial += 1
      const record = {
        stores: scope,
        mode,
        committed: false,
        aborted: false,
        serial: nextTransactionSerial,
        openedAfter: [...committedSerials]
      }
      const inFlightPuts = new Map<string, number>()
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
              log.puts.push({
                store: name,
                key,
                bytes: byteLengthOf(value),
                tx: record.serial,
                inFlight: inFlightPuts.get(name) ?? 0
              })
              ops.push({ store: name, kind: 'put', key, value: structuredClone(value) })
              inFlightPuts.set(name, (inFlightPuts.get(name) ?? 0) + 1)
              return request(() => {
                inFlightPuts.set(name, inFlightPuts.get(name)! - 1)
                return key
              })
            },
            delete(key: string) {
              if (mode !== 'readwrite') throw new Error('readonly transaction')
              log.deletes.push({ store: name, key })
              ops.push({ store: name, kind: 'delete', key })
              return request(() => undefined)
            },
            get(key: string) {
              log.gets.push({ store: name, key, stores: scope })
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
          committedSerials.push(record.serial)
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
      log.gets.length = 0
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
    // The record, plus its small revision marker.
    expect(fake.recordPuts().map((put) => put.key)).toEqual(['twice', 'twice::canvas-save-revision'])
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

    // With the last reference gone the blob is deleted (after one save of grace).
    await saveCanvasItems([], 'shared')
    expect(keyedBlobKeys()).toEqual([assetBlobKey('shared', [3, 3, 3])])
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
function createFakeMirror(autoSaveRoot = '/home/u/AutoSave') {
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
  const state = {
    failProjectFileWrite: false,
    refuseCopy: false,
    /** Main reports no free disk space for every asset (copy and write). */
    noSpace: false,
    applyPrune: false,
    failWrite: null as ((assetFileName: string) => boolean) | null,
    /** Sizes the metadata call reports instead of the real ones, by full path. */
    reportedSizes: new Map<string, number>(),
    /** While set, every direct copy waits for it (a long copy on a slow disk). */
    holdCopy: null as Promise<void> | null
  }
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
      if (state.holdCopy) await state.holdCopy
      const data = readable(req.sourcePath)
      if (state.refuseCopy || !data) throw new Error('Canvas mirror asset source is not authorized')
      if (state.noSpace) return { status: 'no-space' as const, sizeBytes: data.byteLength }
      events.push(`asset:${req.assetFileName}`)
      return publish(assetPath(req.projectDirName, req.assetFileName), data)
    },
    writeCanvasMirrorAsset: async (req: {
      projectDirName: string
      assetFileName: string
      data: Uint8Array
    }) => {
      calls.write.push({ assetFileName: req.assetFileName, bytes: req.data.byteLength })
      if (state.failWrite?.(req.assetFileName)) throw new Error('synthetic asset write failure')
      if (state.noSpace) return { status: 'no-space' as const, sizeBytes: req.data.byteLength }
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
              sizeBytes: state.reportedSizes.get(fullPath) ?? data.byteLength,
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

  it('lets go of the bytes read for IndexedDB that the mirror does not send itself', async () => {
    const mirror = createFakeMirror()
    mirror.localFiles.set('/home/u/pics/seed.png', new Uint8Array([9, 9, 9, 9]))
    const pathBacked = imageItem('path', 'local-media:///home/u/pics/seed.png')
    const pasted = imageItem('pasted', registerSource('blob:seed-pasted', [1, 2]))
    await saveCanvasItems([pathBacked, pasted], 'mirror-seeds')

    // Both were read for IndexedDB. Main copies the file by its path, so only the pasted
    // bytes (which exist only in the renderer) are kept for the mirror copies.
    expect(canvasMirrorSeedStats).toEqual({ readEntries: 2, keptEntries: 1, keptBytes: 2 })
    expect(mirror.calls.copy.map((call) => call.sourcePath)).toEqual(['/home/u/pics/seed.png'])
    expect(mirror.calls.write).toEqual([{ assetFileName: `${contentKey([1, 2])}.png`, bytes: 2 }])
    expect(fetchCalls).toEqual(['blob:seed-pasted'])
    expect(mirror.calls.readFileFromPath).toEqual(['/home/u/pics/seed.png'])

    // An asset the mirror already holds keeps no bytes either.
    const another = imageItem('another', registerSource('blob:seed-another', [1, 2]))
    await saveCanvasItems([pathBacked, pasted, another], 'mirror-seeds')
    expect(canvasMirrorSeedStats.keptEntries).toBe(0)
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
    expect(keepEntryNames).toContain(snapshotDir)
    // Besides it only the asset files last mirrored for the live and undo items.
    expect(
      keepEntryNames
        .filter((name) => name !== snapshotDir)
        .sort()
    ).toEqual(
      [`${contentKey([1])}.png`, `${contentKey([2, 2])}.png`, mirror.project().items[1].src.slice('assets/'.length)].sort()
    )
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

  it('writes the per-item blob of a newly imported image from the bytes in hand, not by reading it back in the commit', async () => {
    const kept = imageItem('kept', registerSource('blob:rb-hand-kept', [3, 3]))
    await saveCanvasItems([kept], 'rb-hand')
    fake.resetLog()
    const imported = [
      imageItem('import-a', registerSource('blob:rb-hand-a', [4, 4, 4])),
      imageItem('import-b', registerSource('blob:rb-hand-b', [5, 5]))
    ]
    await saveCanvasItems([kept, ...imported], 'rb-hand')

    // The record's transaction reads no keyed blob back.
    expect(fake.log.gets.filter((get) => get.key.includes('::canvas::asset::'))).toEqual([])
    expect(fake.blobBytes(legacyBlobKey('rb-hand', 'import-a'))).toEqual([4, 4, 4])
    expect(fake.blobBytes(legacyBlobKey('rb-hand', 'import-b'))).toEqual([5, 5])
    expect(loadLikePreviousRelease('rb-hand')).toEqual(
      new Map([
        ['kept', [3, 3]],
        ['import-a', [4, 4, 4]],
        ['import-b', [5, 5]]
      ])
    )
    // Each byte is written once per blob, and the next save moves nothing.
    expect(fake.blobPuts().map((put) => put.key).sort()).toEqual(
      [
        assetBlobKey('rb-hand', [4, 4, 4]),
        assetBlobKey('rb-hand', [5, 5]),
        legacyBlobKey('rb-hand', 'import-a'),
        legacyBlobKey('rb-hand', 'import-b')
      ].sort()
    )
    fake.resetLog()
    await saveCanvasItems([kept, ...imported.map((item) => ({ ...item, x: 3 }) as CanvasItem)], 'rb-hand')
    expect(fake.blobPuts()).toEqual([])
  })

  it('writes the per-item copy of new bytes only after their keyed blob has committed', async () => {
    const fresh = imageItem('fresh', registerSource('blob:rb-two-tx', [6, 6, 6]))
    const other = imageItem('other', registerSource('blob:rb-two-tx-b', [2, 6]))
    fake.resetLog()
    await saveCanvasItems([fresh, other], 'rb-two-tx')

    for (const [id, bytes] of [['fresh', [6, 6, 6]], ['other', [2, 6]]] as const) {
      const keyed = fake.blobPuts().find((put) => put.key === assetBlobKey('rb-two-tx', [...bytes]))!
      const perItem = fake.blobPuts().find((put) => put.key === legacyBlobKey('rb-two-tx', id))!
      // Two transactions, the second opened once the first had committed: the clone the
      // keyed put made is gone before the per-item put makes its own.
      expect(perItem.tx).not.toBe(keyed.tx)
      expect(fake.log.transactions.find((tx) => tx.serial === perItem.tx)!.openedAfter).toContain(keyed.tx)
    }
    // Both still land before the record that names them.
    const recordTx = fake.recordPuts()[0].tx
    expect(Math.max(...fake.blobPuts().map((put) => put.tx))).toBeLessThan(recordTx)
    expect(Object.fromEntries(loadLikePreviousRelease('rb-two-tx'))).toEqual({
      fresh: [6, 6, 6],
      other: [2, 6]
    })
  })

  it('copies stored bytes to the per-item blobs of several duplicates one put at a time', async () => {
    const original = imageItem('first', registerSource('blob:rb-serial', [5, 4, 3]))
    await saveCanvasItems([original], 'rb-serial')
    const duplicates = ['d1', 'd2', 'd3'].map((id, index) => ({ ...original, id, x: index }) as CanvasItem)
    fake.resetLog()
    await saveCanvasItems([original, ...duplicates], 'rb-serial')

    const copies = fake.blobPuts()
    expect(copies.map((put) => put.key).sort()).toEqual(
      ['d1', 'd2', 'd3'].map((id) => legacyBlobKey('rb-serial', id)).sort()
    )
    // Each put clones the bytes; none is issued while another copy is still pending.
    expect(copies.map((put) => put.inFlight)).toEqual([0, 0, 0])
    expect(new Set(copies.map((put) => put.tx)).size).toBe(1)
    for (const id of ['d1', 'd2', 'd3']) {
      expect(loadLikePreviousRelease('rb-serial').get(id)).toEqual([5, 4, 3])
    }
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

  it('moves no byte when delete-all is undone', async () => {
    const a = imageItem('undo-all-a', registerSource('blob:rb-undo-all-a', [1, 3]))
    const b = imageItem('undo-all-b', registerSource('blob:rb-undo-all-b', [2, 4]))
    await saveCanvasItems([a, b], 'rb-undo-all')
    await saveCanvasItems([], 'rb-undo-all', [], [], null, { getProtectedItems: () => [[a, b]] })

    fake.resetLog()
    fetchCalls = []
    await saveCanvasItems([a, b], 'rb-undo-all', [], [], null, { getProtectedItems: () => [[]] })
    expect(fake.blobPuts()).toEqual([])
    expect(fetchCalls).toEqual([])
    expect(fake.blobBytes(legacyBlobKey('rb-undo-all', 'undo-all-a'))).toEqual([1, 3])
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

  /** A board of an earlier version: a remote image whose only offline copy is a snapshot folder. */
  function seedRemoteBoardOfEarlierVersion(mirror: ReturnType<typeof createFakeMirror>, storeKey: string) {
    const remoteUrl = 'http://127.0.0.1:8188/view?filename=ComfyUI_00042_.png&type=output'
    const snapshotDir = 'snapshot-11111111-2222-3333-4444-555555555555'
    const projectDir = `${mirror.autoSaveRoot}/${buildProjectStorageDirName(storeKey, storeKey)}`
    fake.committed.get('canvas-items')!.set(storeKey, {
      items: [
        { ...(imageItem('remote', remoteUrl) as object) },
        { id: 'note', type: 'text', text: 'hi', x: 0, y: 0, zIndex: 2 }
      ],
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
    const copyPath = `${projectDir}/assets/${snapshotDir}/images/remote.png`
    mirror.files.set(copyPath, new Uint8Array([4, 2]))
    return { remoteUrl, copyRef: `assets/${snapshotDir}/images/remote.png`, copyPath }
  }

  it('keeps the snapshot copy of an unreachable remote image while it is only in the undo history', async () => {
    const mirror = createFakeMirror()
    mirror.state.applyPrune = true
    const { remoteUrl, copyRef, copyPath } = seedRemoteBoardOfEarlierVersion(mirror, 'undo-remote')
    const loaded = await loadCanvasItems('undo-remote')
    await saveCanvasItems(loaded.items, 'undo-remote')
    expect(mirror.files.has(copyPath)).toBe(true)

    // The user deletes the remote image (the server is still down); undo can bring it back.
    const remoteItem = loaded.items.find((item) => item.id === 'remote')!
    const rest = loaded.items.filter((item) => item.id !== 'remote')
    await saveCanvasItems(rest, 'undo-remote', [], [], null, { getProtectedItems: () => [loaded.items] })
    expect(mirror.files.has(copyPath)).toBe(true)
    expect(mirror.calls.prune.at(-1)!.keepEntryNames).toContain(copyRef.split('/')[1])
    // Another save while it stays in the history: the copy is still kept.
    await saveCanvasItems(
      rest.map((item) => ({ ...item, x: 5 }) as CanvasItem),
      'undo-remote',
      [],
      [],
      null,
      { getProtectedItems: () => [loaded.items, rest] }
    )
    expect(mirror.files.has(copyPath)).toBe(true)

    // Undo: the item is back, its source is still down, and the project file points at the copy.
    await saveCanvasItems([...rest, remoteItem], 'undo-remote', [], [], null, {
      getProtectedItems: () => [rest]
    })
    expect(mirror.files.has(copyPath)).toBe(true)
    expect(mirror.project().items.find((item) => item.id === 'remote')!.src).toBe(copyRef)
    expect(remoteItem).toMatchObject({ src: remoteUrl })
  })

  it('keeps the snapshot copy of an image deleted before the first save of the session', async () => {
    const mirror = createFakeMirror()
    mirror.state.applyPrune = true
    const { copyRef, copyPath } = seedRemoteBoardOfEarlierVersion(mirror, 'undo-first')
    const loaded = await loadCanvasItems('undo-first')
    const rest = loaded.items.filter((item) => item.id !== 'remote')
    await saveCanvasItems(rest, 'undo-first', [], [], null, { getProtectedItems: () => [loaded.items] })
    expect(mirror.files.has(copyPath)).toBe(true)

    await saveCanvasItems(loaded.items, 'undo-first', [], [], null, { getProtectedItems: () => [rest] })
    expect(mirror.files.has(copyPath)).toBe(true)
    expect(mirror.project().items.find((item) => item.id === 'remote')!.src).toBe(copyRef)
  })

  it('prunes nothing while main cannot tell whether the previous project file is there', async () => {
    // Its autosave folder spells "File not found": only the mark of the error may decide.
    const mirror = createFakeMirror('/home/u/File not found/AutoSave')
    mirror.state.applyPrune = true
    const { copyRef, copyPath } = seedRemoteBoardOfEarlierVersion(mirror, 'undo-unavailable')
    const loaded = await loadCanvasItems('undo-unavailable')
    // Every slot of main's renderer path gate is held by reads of a share that stopped answering:
    // main answers that it cannot read the previous project file now, as it does over IPC.
    const svcFs = (window as unknown as { api: { svcFs: Record<string, unknown> } }).api.svcFs
    const readTextFile = svcFs.readTextFile as (req: { fullPath: string }) => Promise<unknown>
    svcFs.readTextFile = async (req: { fullPath: string }) => {
      if (req.fullPath.endsWith('project.mpcanvas')) {
        const message = formatLocalFileUnavailableMessage(req.fullPath)
        throw new Error(`Error invoking remote method 'svcFs.readTextFile': Error: ${message}`)
      }
      return readTextFile(req)
    }

    // The remote image is deleted before the first save of the session: only the previous
    // project file names its offline copy, which undo can still need.
    const rest = loaded.items.filter((item) => item.id !== 'remote')
    mirror.resetCalls()
    await saveCanvasItems(rest, 'undo-unavailable', [], [], null, {
      getProtectedItems: () => [loaded.items]
    })
    expect(mirror.calls.prune).toEqual([])
    expect(mirror.files.has(copyPath)).toBe(true)
    // The previous project file stays as it is: it still names the copy.
    expect(mirror.events).not.toContain('project-file')
    expect(mirror.text.get(mirror.projectFilePath())).toContain(copyRef)

    // Main answers again: the copy is carried, and undo finds it.
    svcFs.readTextFile = readTextFile
    await saveCanvasItems(rest, 'undo-unavailable', [], [], null, {
      getProtectedItems: () => [loaded.items]
    })
    expect(mirror.files.has(copyPath)).toBe(true)
    expect(mirror.calls.prune.at(-1)!.keepEntryNames).toContain(copyRef.split('/')[1])
  })

  it('never mirrors the per-item blob of another version under the key of an unreachable remote image', async () => {
    // Move, replace the image under the same item id, delete, then undo back to the remote version.
    const mirror = createFakeMirror()
    mirror.state.applyPrune = true
    const { remoteUrl, copyRef, copyPath } = seedRemoteBoardOfEarlierVersion(mirror, 'undo-replace')
    const loaded = await loadCanvasItems('undo-replace')
    await saveCanvasItems(loaded.items, 'undo-replace')
    const history: CanvasItem[][] = []
    const withHistory = (future: CanvasItem[][] = []) => ({
      getProtectedItems: () => [...history, ...future]
    })
    history.push(createCanvasHistorySnapshot(loaded.items))
    const moved = loaded.items.map((item) =>
      item.id === 'remote' ? ({ ...item, x: 5 } as CanvasItem) : item
    )
    await saveCanvasItems(moved, 'undo-replace', [], [], null, withHistory())
    history.push(createCanvasHistorySnapshot(moved))
    const replaced = moved.map((item) =>
      item.id === 'remote' ? ({ ...item, src: registerSource('blob:undo-replace-new', [7, 7]) } as CanvasItem) : item
    )
    await saveCanvasItems(replaced, 'undo-replace', [], [], null, withHistory())
    // The dual write gave the item id a per-item blob with the bytes of the replacement.
    expect(fake.blobBytes(legacyBlobKey('undo-replace', 'remote'))).toEqual([7, 7])
    history.push(createCanvasHistorySnapshot(replaced))
    const deleted = replaced.filter((item) => item.id !== 'remote')
    await saveCanvasItems(deleted, 'undo-replace', [], [], null, withHistory())
    await saveCanvasItems(
      deleted.map((item) => ({ ...item, x: 9 }) as CanvasItem),
      'undo-replace',
      [],
      [],
      null,
      withHistory()
    )
    expect(mirror.files.has(copyPath)).toBe(true)

    // Undo twice: the remote version is back while its server is still down.
    const future = [createCanvasHistorySnapshot(deleted)]
    history.pop()
    future.unshift(createCanvasHistorySnapshot(replaced))
    const back = history.pop()!.map((item) => ({ ...item }) as CanvasItem)
    await saveCanvasItems(back, 'undo-replace', [], [], null, withHistory(future))
    await saveCanvasItems(
      back.map((item) => ({ ...item, y: 1 }) as CanvasItem),
      'undo-replace',
      [],
      [],
      null,
      withHistory(future)
    )

    expect((back.find((item) => item.id === 'remote') as { src: string }).src).toBe(remoteUrl)
    // The original bytes stay the remote image's copy; no file holds [7, 7] under the URL's key.
    expect(mirror.files.has(copyPath)).toBe(true)
    expect(Array.from(mirror.files.get(copyPath)!)).toEqual([4, 2])
    expect(mirror.project().items.find((item) => item.id === 'remote')!.src).toBe(copyRef)
    expect(mirror.assetFiles().some((name) => name.startsWith('u-'))).toBe(false)
  })

  it('lets the copy go once the deleted image has left the undo history', async () => {
    const mirror = createFakeMirror()
    mirror.state.applyPrune = true
    const { copyPath } = seedRemoteBoardOfEarlierVersion(mirror, 'undo-gone')
    const loaded = await loadCanvasItems('undo-gone')
    await saveCanvasItems(loaded.items, 'undo-gone')
    const rest = loaded.items.filter((item) => item.id !== 'remote')
    await saveCanvasItems(rest, 'undo-gone', [], [], null, { getProtectedItems: () => [loaded.items] })
    expect(mirror.files.has(copyPath)).toBe(true)
    await saveCanvasItems(rest, 'undo-gone', [], [], null, { getProtectedItems: () => [rest] })
    expect(mirror.files.has(copyPath)).toBe(false)
  })

  it('keeps the old copy of a managed image without a hash whose file is gone while it is only in the undo history', async () => {
    const mirror = createFakeMirror()
    mirror.state.applyPrune = true
    const managedPath = '/home/u/userData/managed/m2.png'
    mirror.localFiles.set(managedPath, new Uint8Array([6, 6]))
    const managed = imageItem('managed', `local-media://${managedPath}`, {
      media: { kind: 'managed', id: 'media-2' }
    })
    const note = { id: 'note', type: 'text', text: 'hi', x: 0, y: 0, zIndex: 2 } as unknown as CanvasItem
    await saveCanvasItems([managed, note], 'undo-managed')
    const [copyName] = mirror.assetFiles()

    mirror.localFiles.delete(managedPath)
    vi.resetModules()
    const restarted = await import('./canvasStorage')
    const reopened = await restarted.loadCanvasItems('undo-managed')
    await restarted.saveCanvasItems(
      reopened.items.map((item) => ({ ...item, y: 4 }) as CanvasItem),
      'undo-managed'
    )
    expect(mirror.assetFiles()).toEqual([copyName])

    // Deleted; the version before the move is what the undo history holds.
    const rest = reopened.items.filter((item) => item.id !== 'managed')
    await restarted.saveCanvasItems(rest, 'undo-managed', [], [], null, {
      getProtectedItems: () => [reopened.items]
    })
    expect(mirror.assetFiles()).toEqual([copyName])

    await restarted.saveCanvasItems(reopened.items, 'undo-managed', [], [], null, {
      getProtectedItems: () => [rest]
    })
    expect(mirror.assetFiles()).toEqual([copyName])
    expect(mirror.project().items.find((item) => item.id === 'managed')!.src).toBe(`assets/${copyName}`)
  })
})

// ─── Stale writers ──────────────────────────────────────────────────────────
describe('writers that load a board and save it back', () => {
  it('load waits for a save already queued for the same canvas', async () => {
    const a = imageItem('a', registerSource('blob:queue-a', [1]))
    const b = imageItem('b', registerSource('blob:queue-b', [2, 2]))
    await saveCanvasItems([a], 'queued')
    const saving = saveCanvasItems([a, b], 'queued')
    const loaded = await loadCanvasItems('queued')
    await saving
    expect(loaded.items.map((item) => item.id)).toEqual(['a', 'b'])
  })

  it('keeps the bytes a stale snapshot dropped for one more save', async () => {
    const a = imageItem('a', registerSource('blob:stale-a', [1, 1]))
    const b = imageItem('b', registerSource('blob:stale-b', [2, 2]))
    await saveCanvasItems([a, b], 'stale')

    // A writer saves a snapshot it took before b was added.
    await saveCanvasItems([a], 'stale')
    expect(fake.blobKeys()).toEqual(
      [
        assetBlobKey('stale', [1, 1]),
        assetBlobKey('stale', [2, 2]),
        legacyBlobKey('stale', 'a'),
        legacyBlobKey('stale', 'b')
      ].sort()
    )
    // Nothing references b for a whole save: now it goes.
    await saveCanvasItems([a], 'stale')
    expect(fake.blobKeys()).toEqual(
      [assetBlobKey('stale', [1, 1]), legacyBlobKey('stale', 'a')].sort()
    )
  })

  it('an unmount save in flight plus a Figma bind save keeps the new images', async () => {
    const { rememberPendingCanvasSave, waitForPendingCanvasSave } = await import('./canvasPendingSaves')
    const old = imageItem('old', registerSource('blob:figma-old', [3]))
    await saveCanvasItems([old], 'figma')

    // The canvas page leaves with two new images: its run tries metadata only, then saves in full.
    const added = [
      imageItem('new-1', registerSource('blob:figma-new-1', [4, 4])),
      imageItem('new-2', registerSource('blob:figma-new-2', [5, 5, 5]))
    ]
    const board = [old, ...added]
    const run = (async () => {
      const outcome = await saveCanvasItems(board, 'figma', [], [], null, { metadataOnly: true })
      expect(outcome).toBe('needs-bytes')
      await new Promise((resolve) => setTimeout(resolve, 5))
      await saveCanvasItems(board, 'figma')
    })()
    rememberPendingCanvasSave('figma', run)

    // Settings opens the Figma binding at the same time and saves the binding back.
    await waitForPendingCanvasSave('figma')
    const snapshot = await loadCanvasItems('figma')
    const binding = { fileKey: 'k', fileName: 'f', fileUrl: 'k', pages: [] } as unknown as Parameters<
      typeof saveCanvasItems
    >[4]
    await saveCanvasItems(snapshot.items, 'figma', snapshot.groups, snapshot.groupBranches, binding)
    await run

    const record = fake.record('figma')! as unknown as {
      figmaBinding: unknown
      items: Array<{ id: string; assetKey: string }>
    }
    expect(record.items.map((item) => item.id)).toEqual(['old', 'new-1', 'new-2'])
    expect(record.figmaBinding).toMatchObject({ fileKey: 'k' })
    for (const [id, bytes] of [['new-1', [4, 4]], ['new-2', [5, 5, 5]]] as const) {
      expect(fake.blobBytes(assetBlobKey('figma', [...bytes]))).toEqual(bytes)
      expect(fake.blobBytes(legacyBlobKey('figma', id))).toEqual(bytes)
    }
  })
})

describe('reopening a board the mirror holds', () => {
  // A reopen never shows an image from its file in the autosave mirror: that file is in a
  // cache the mirror prunes, so a source pointing into it could outlive the bytes it names.
  const authorizedPaths: string[] = []
  beforeEach(() => {
    authorizedPaths.length = 0
    vi.stubGlobal('electronFile', {
      resolveAuthorizedLocalMediaPath: async (filePath: string) => {
        authorizedPaths.push(filePath)
        return filePath
      }
    })
  })

  it('restores every image from its IndexedDB bytes, never from its mirror file', async () => {
    const mirror = createFakeMirror()
    const a = imageItem('a', registerSource('blob:reopen-a', [1, 2, 3]))
    const b = imageItem('b', registerSource('blob:reopen-b', [4, 5]))
    const twin = imageItem('twin', 'blob:reopen-a', { x: 40 })
    await saveCanvasItems([a, b, twin], 'reopen-mirror')
    const recordBefore = fake.record('reopen-mirror')!.items.map((item) => [item.id, item.assetKey])
    expect(mirror.assetFiles().sort()).toEqual(
      [`${contentKey([1, 2, 3])}.png`, `${contentKey([4, 5])}.png`].sort()
    )

    const reopened = await loadCanvasItems('reopen-mirror')

    // The window holds the bytes of every image; no source points into the mirror and
    // the window was not asked to read it.
    const sources = reopened.items.map((item) => (item as { src: string }).src)
    expect(sources.every((src) => src.startsWith('blob:'))).toBe(true)
    expect(sources[2]).toBe(sources[0])
    expect(await readBlobBytes(restoredBlobs.get(sources[0])!)).toEqual([1, 2, 3])
    expect(await readBlobBytes(restoredBlobs.get(sources[1])!)).toEqual([4, 5])
    expect(authorizedPaths).toEqual([])

    // The next saves move nothing and keep every key.
    for (let round = 0; round < 2; round += 1) {
      mirror.resetCalls()
      fake.resetLog()
      fetchCalls = []
      await saveCanvasItems(
        reopened.items.map((item) => ({ ...item, y: round }) as CanvasItem),
        'reopen-mirror'
      )
      expect(fake.blobPuts()).toEqual([])
      expect(mirror.calls.copy).toEqual([])
      expect(mirror.calls.write).toEqual([])
      expect(mirror.calls.readFileFromPath).toEqual([])
      expect(fetchCalls).toEqual([])
    }
    expect(fake.record('reopen-mirror')!.items.map((item) => [item.id, item.assetKey])).toEqual(recordBefore)
    // The previous release still finds every image in its per-item blobs.
    expect(Object.fromEntries(loadLikePreviousRelease('reopen-mirror'))).toEqual({
      a: [1, 2, 3],
      b: [4, 5],
      twin: [1, 2, 3]
    })
  })

  it('reads the images of a record the previous release wrote from IndexedDB, mirror or not', async () => {
    const mirror = createFakeMirror()
    const item = imageItem('pic', registerSource('blob:reopen-prev', [3, 3, 3]))
    await saveCanvasItems([item], 'reopen-prev')
    // The previous release changed the image and saved: no format marker, a new per-item blob.
    const record = fake.record('reopen-prev')! as unknown as Record<string, unknown>
    fake.committed.get('canvas-items')!.set('reopen-prev', { items: record.items, groups: [], groupBranches: [] })
    fake.committed.get('canvas-blobs')!.set(legacyBlobKey('reopen-prev', 'pic'), {
      data: new Uint8Array([9, 9]).buffer,
      mimeType: 'image/png'
    })
    expect(mirror.assetFiles()).toContain(`${contentKey([3, 3, 3])}.png`)

    const reopened = await loadCanvasItems('reopen-prev')
    const restored = reopened.items[0] as CanvasItem & { src: string }
    expect(restored.src.startsWith('blob:')).toBe(true)
    expect(await readBlobBytes(restoredBlobs.get(restored.src)!)).toEqual([9, 9])
  })

  it('hands a reopened image to the Agent as bytes, so the conversation keeps it after the board prunes it', async () => {
    const mirror = createFakeMirror()
    mirror.state.applyPrune = true
    const scanBytes = [0x42, 0x4d, 1, 2, 3]
    const photoBytes = [9, 8, 7]
    const scan = imageItem('scan', registerSource('blob:reopen-bmp', scanBytes), { fileName: 'scan.bmp' })
    const photo = imageItem('photo', registerSource('blob:reopen-png', photoBytes))
    await saveCanvasItems([scan, photo], 'reopen-bmp')
    const scanFile = `${mirror.projectDir()}/assets/${contentKey(scanBytes)}.bmp`
    const photoFile = `${mirror.projectDir()}/assets/${contentKey(photoBytes)}.png`
    expect(mirror.files.has(scanFile)).toBe(true)
    expect(mirror.files.has(photoFile)).toBe(true)

    const reopened = await loadCanvasItems('reopen-bmp')
    const [restoredScan, restoredPhoto] = reopened.items as Array<CanvasItem & { src: string }>
    expect(restoredScan.src.startsWith('blob:')).toBe(true)
    expect(restoredPhoto.src.startsWith('blob:')).toBe(true)

    // The Agent hand-off reads the bytes: a format the managed store does not hold (BMP)
    // is inlined, a PNG is imported into managed media. Neither keeps a path.
    const importFile = vi.fn()
    const importDataUrl = vi.fn()
    // Path-less bytes (a blob: URL) are imported as bytes, never as a base64 string.
    const importBytes = vi.fn(async (req: { bytes: Uint8Array }) => ({
      reference: { version: 1, kind: 'managed', relativePath: 'chat/p.png', mimeType: 'image/png', sizeBytes: 3 },
      localMediaUrl: `local-media:///home/u/Media/imported-${req.bytes.length}.png`
    }))
    const service = { importFile, importDataUrl, importBytes } as unknown as IncomingChatImageImportOptions['service']
    const fetchImpl = (async (url: string) => ({
      ok: true,
      blob: async () => restoredBlobs.get(url)!
    })) as unknown as typeof fetch
    const handedScan = await importIncomingChatImageAttachment(
      { type: 'image', url: restoredScan.src, fileName: 'scan.bmp' } as ChatAttachment,
      { service, fetchImpl }
    )
    const handedPhoto = await importIncomingChatImageAttachment(
      { type: 'image', url: restoredPhoto.src, fileName: 'photo.png' } as ChatAttachment,
      { service, fetchImpl }
    )
    expect(handedScan.url.startsWith('data:')).toBe(true)
    expect(importFile).not.toHaveBeenCalled()
    expect(importDataUrl).not.toHaveBeenCalled()
    expect(importBytes).toHaveBeenCalledTimes(1)
    expect([...importBytes.mock.calls[0][0].bytes]).toEqual(photoBytes)
    expect(handedPhoto.url.startsWith('local-media:///home/u/Media/')).toBe(true)

    // Both images are deleted (outside undo) and the board is saved until it prunes.
    for (let round = 0; round < 3; round += 1) await saveCanvasItems([], 'reopen-bmp')
    expect(mirror.files.has(scanFile)).toBe(false)
    expect(mirror.files.has(photoFile)).toBe(false)
    expect(fake.committed.get('canvas-blobs')!.has(assetBlobKey('reopen-bmp', scanBytes))).toBe(false)
    // What the conversation keeps still holds the bytes and names nothing in the mirror.
    const inlined = Buffer.from(handedScan.url.slice(handedScan.url.indexOf(',') + 1), 'base64')
    expect([...inlined]).toEqual(scanBytes)
    expect(handedScan.url.includes('/AutoSave/')).toBe(false)
    expect(handedPhoto.url.includes('/AutoSave/')).toBe(false)
  })

  it('still saves an open board after another writer removed one of its images and pruned it', async () => {
    const mirror = createFakeMirror()
    mirror.state.applyPrune = true
    const a = imageItem('a', registerSource('blob:reopen-other-a', [1, 2, 3]))
    const b = imageItem('b', registerSource('blob:reopen-other-b', [4, 5]))
    await saveCanvasItems([a, b], 'reopen-other')
    const fileA = `${mirror.projectDir()}/assets/${contentKey([1, 2, 3])}.png`

    // The board is open; another writer of the same record drops "a" and saves until
    // the stored blob and the mirror file of "a" are pruned.
    const open = await loadCanvasItems('reopen-other')
    const other = await loadCanvasItems('reopen-other')
    for (let round = 0; round < 3; round += 1) {
      await saveCanvasItems([{ ...other.items[1], x: round } as CanvasItem], 'reopen-other')
    }
    expect(mirror.files.has(fileA)).toBe(false)
    expect(fake.committed.get('canvas-blobs')!.has(assetBlobKey('reopen-other', [1, 2, 3]))).toBe(false)

    // The open board still holds the bytes of "a": its save stores them again and its
    // other changes are kept.
    await saveCanvasItems(
      open.items.map((item) => ({ ...item, y: 5 }) as CanvasItem),
      'reopen-other'
    )
    expect(
      fake.record('reopen-other')!.items.map((item) => [item.id, item.assetKey, (item as { y?: number }).y])
    ).toEqual([
      ['a', contentKey([1, 2, 3]), 5],
      ['b', contentKey([4, 5]), 5]
    ])
    expect(fake.committed.get('canvas-blobs')!.has(assetBlobKey('reopen-other', [1, 2, 3]))).toBe(true)
    expect(mirror.files.has(fileA)).toBe(true)
    const again = await loadCanvasItems('reopen-other')
    const restoredA = again.items[0] as CanvasItem & { src: string }
    expect(await readBlobBytes(restoredBlobs.get(restoredA.src)!)).toEqual([1, 2, 3])
  })

  it('reads an image keyed by its file identity from IndexedDB, not from its mirror copy', async () => {
    const mirror = createFakeMirror()
    const filePath = '/home/u/Projects/refs/ref.png'
    mirror.localFiles.set(filePath, new Uint8Array([5, 5, 5]))
    const sourceIdentity = { kind: 'local-file', canonicalPath: filePath, sizeBytes: 3, lastModifiedMs: 1_700_000_000_000 }
    const ref = imageItem('ref', `local-media://${filePath}`, { sourceIdentity })
    await saveCanvasItems([ref], 'reopen-identity')
    const key = fileIdentityKey(filePath, 3, 1_700_000_000_000)
    const mirrorFile = `${mirror.projectDir()}/assets/${key}.png`
    expect(fake.record('reopen-identity')!.items[0].assetKey).toBe(key)
    // A copy by path made after the file was changed holds the new bytes under the old key.
    mirror.files.set(mirrorFile, new Uint8Array([6, 6, 6]))

    const reopened = await loadCanvasItems('reopen-identity')
    const restored = reopened.items[0] as CanvasItem & { src: string }
    expect(restored.src.startsWith('blob:')).toBe(true)
    expect(await readBlobBytes(restoredBlobs.get(restored.src)!)).toEqual([5, 5, 5])
  })
})

describe('metadata-only reads', () => {
  it('gives the managed-media scan every item without reading an image or making an object URL', async () => {
    const managed = imageItem('managed', registerSource('blob:meta-managed', [6, 6]), {
      media: { kind: 'managed', id: 'media-7' }
    })
    const plain = imageItem('plain', registerSource('blob:meta-plain', [5]))
    await saveCanvasItems([managed, plain], 'meta-scan')

    fake.resetLog()
    const createObjectUrl = vi.mocked(URL.createObjectURL)
    createObjectUrl.mockClear()
    const { items } = await loadCanvasItemsMetadata('meta-scan')
    expect(createObjectUrl).not.toHaveBeenCalled()
    expect(fake.log.gets.map((get) => get.key)).toEqual(['meta-scan'])
    expect(items.map((item) => (item as { id: string }).id)).toEqual(['managed', 'plain'])
    expect((items[0] as { media?: unknown }).media).toEqual({ kind: 'managed', id: 'media-7' })
  })

  const managedMedia = { kind: 'managed', id: 'media-8' }
  const writeBoardFile = (
    mirror: ReturnType<typeof createFakeMirror>,
    storeKey: string,
    content: string
  ): void => {
    const projectDir = `${mirror.autoSaveRoot}/${buildProjectStorageDirName(storeKey, storeKey)}`
    mirror.text.set(`${projectDir}/project.mpcanvas`, content)
  }

  it('reads a board IndexedDB does not hold from its mirror file, as stored, without its bytes', async () => {
    const mirror = createFakeMirror()
    writeBoardFile(
      mirror,
      'meta-lost',
      JSON.stringify({
        magic: 'MAGICPOT_CANVAS',
        version: 8,
        createdAt: '2026-01-01T00:00:00.000Z',
        items: [{ ...(imageItem('embedded', '') as object), media: managedMedia }],
        groups: [],
        groupBranches: [],
        blobs: { embedded: { base64: 'AQID', mimeType: 'image/png' } }
      })
    )
    const createObjectUrl = vi.mocked(URL.createObjectURL)
    createObjectUrl.mockClear()

    const { items } = await loadCanvasItemsMetadata('meta-lost')

    expect(createObjectUrl).not.toHaveBeenCalled()
    expect(fake.log.gets.map((get) => `${get.store}:${get.key}`)).toEqual([
      'canvas-items:meta-lost'
    ])
    expect(mirror.calls.readFileFromPath).toEqual([])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ id: 'embedded', media: managedMedia })
  })

  it('reads an empty board with no file anywhere as empty', async () => {
    createFakeMirror()
    fake.committed
      .get('canvas-items')!
      .set('meta-empty', { items: [], groups: [], groupBranches: [] })
    await expect(loadCanvasItemsMetadata('meta-empty')).resolves.toEqual({ items: [] })
  })

  it('rejects when the board cannot be read instead of taking it for an empty board', async () => {
    createFakeMirror()
    vi.stubGlobal('indexedDB', {
      open: () => {
        const request: { error?: DOMException; onerror?: () => void } = {}
        setTimeout(() => {
          request.error = new DOMException('Denied', 'UnknownError')
          request.onerror?.()
        }, 0)
        return request
      }
    })
    await expect(loadCanvasItemsMetadata('meta-unreadable')).rejects.toThrow()
  })

  it('rejects when the file of a board IndexedDB does not hold cannot be parsed', async () => {
    const mirror = createFakeMirror()
    writeBoardFile(mirror, 'meta-corrupt', '{"magic": "MAGICPOT_CANVAS", "items": [')
    await expect(loadCanvasItemsMetadata('meta-corrupt')).rejects.toThrow()
  })
})

describe('mirror staging failures', () => {
  it('stages the other assets and writes the project file when one asset write fails', async () => {
    const mirror = createFakeMirror()
    const good = imageItem('good', registerSource('blob:stage-good', [1, 2, 3]))
    const bad = imageItem('bad', registerSource('blob:stage-bad', [4, 5]))
    mirror.state.failWrite = (name) => name.startsWith(contentKey([4, 5]))
    await saveCanvasItems([good, bad], 'stage-fail')

    expect(mirror.assetFiles()).toEqual([`${contentKey([1, 2, 3])}.png`])
    expect(mirror.project().items.map((item) => item.src)).toEqual([
      `assets/${contentKey([1, 2, 3])}.png`,
      'blob:stage-bad'
    ])
    // No earlier copy of the failed asset: nothing is pruned in this save.
    expect(mirror.calls.prune).toEqual([])

    // The next save retries the failed asset only.
    mirror.state.failWrite = null
    mirror.resetCalls()
    await saveCanvasItems([good, bad], 'stage-fail')
    expect(mirror.calls.write.map((call) => call.assetFileName)).toEqual([`${contentKey([4, 5])}.png`])
    expect(mirror.project().items[1].src).toBe(`assets/${contentKey([4, 5])}.png`)
  })

  it('treats a full disk as final for the save: no second send, the previous copy stays', async () => {
    const mirror = createFakeMirror()
    mirror.state.applyPrune = true
    const filePath = '/home/u/Projects/full/photo.png'
    mirror.localFiles.set(filePath, new Uint8Array([6, 6, 6]))
    const photo = imageItem('photo', `local-media://${filePath}`, {
      sourceIdentity: { kind: 'local-file', canonicalPath: filePath, sizeBytes: 3, lastModifiedMs: 1_700_000_000_000 }
    })
    const first = imageItem('first', registerSource('blob:full-first', [1, 1]))
    await saveCanvasItems([first], 'full-disk')
    const firstRef = `assets/${contentKey([1, 1])}.png`
    expect(mirror.project().items[0].src).toBe(firstRef)

    // The image is replaced while the disk is full.
    mirror.state.noSpace = true
    mirror.resetCalls()
    const replaced = { ...first, src: registerSource('blob:full-second', [2, 2]) } as CanvasItem
    await saveCanvasItems([replaced, photo], 'full-disk')

    // One attempt per asset, nothing sent again through the renderer. The file is read
    // once, by the IndexedDB store; the mirror does not read it to write it itself.
    expect(mirror.calls.copy.map((call) => call.sourcePath)).toEqual([filePath])
    expect(mirror.calls.write.map((call) => call.assetFileName)).toEqual([`${contentKey([2, 2])}.png`])
    expect(mirror.calls.readFileFromPath).toEqual([filePath])
    // The replaced image keeps its previous copy; the photo has none and keeps its source,
    // so nothing is pruned.
    expect(mirror.project().items.map((item) => item.src)).toEqual([firstRef, `local-media://${filePath}`])
    expect(mirror.calls.prune).toEqual([])
    expect(mirror.assetFiles()).toEqual([`${contentKey([1, 1])}.png`])

    // Room again: the next save mirrors both.
    mirror.state.noSpace = false
    await saveCanvasItems([replaced, photo], 'full-disk')
    expect(mirror.project().items[0].src).toBe(`assets/${contentKey([2, 2])}.png`)
    expect(mirror.project().items[1].src).toMatch(/^assets\/f-[0-9a-f]{40}\.png$/)
  })

  it('never reads a source larger than the IPC limit through the renderer when main cannot copy it', async () => {
    const mirror = createFakeMirror()
    mirror.state.refuseCopy = true
    const bigPath = '/home/u/userData/managed/huge.png'
    mirror.localFiles.set(bigPath, new Uint8Array([7]))
    mirror.state.reportedSizes.set(bigPath, 300 * 1024 * 1024)
    // A managed image is not stored in IndexedDB, so only the mirror would read it.
    const huge = imageItem('huge', `local-media://${bigPath}`, { media: { kind: 'managed', id: 'm-huge' } })
    const small = imageItem('small', registerSource('blob:stage-small', [9]))
    await saveCanvasItems([huge, small], 'stage-huge')

    expect(mirror.calls.copy.map((call) => call.sourcePath)).toEqual([bigPath])
    expect(mirror.calls.readFileFromPath).toEqual([])
    expect(fetchCalls.filter((url) => url.includes('huge'))).toEqual([])
    expect(mirror.calls.write.map((call) => call.assetFileName)).toEqual([`${contentKey([9])}.png`])
    expect(mirror.project().items[0].src).toBe(`local-media://${bigPath}`)
  })
})

describe('large mirror copies', () => {
  // Files from 4 bytes on count as large here (64 MB in the app).
  beforeEach(() => {
    canvasMirrorDetachedCopyConfig.minBytes = 4
  })
  afterEach(() => {
    canvasMirrorDetachedCopyConfig.minBytes = 64 * 1024 * 1024
  })

  it('does not hold up the IndexedDB saves while a large file is copied', async () => {
    const mirror = createFakeMirror()
    mirror.localFiles.set('/slow/disk/video.mp4', new Uint8Array([1, 9, 9, 1]))
    let releaseCopy = (): void => {}
    mirror.state.holdCopy = new Promise<void>((resolve) => {
      releaseCopy = resolve
    })
    const video = imageItem('video', 'local-media:///slow/disk/video.mp4', { fileName: 'video.mp4' })
    await saveCanvasItems([video], 'mirror-detached')
    expect(mirror.calls.copy).toHaveLength(1)
    expect(getCanvasMirrorDetachedCopyStats('mirror-detached').running).toBe(1)
    // The copy is still running: the slot has no copy yet, so it keeps its source and
    // nothing is pruned.
    expect(mirror.project().items[0].src).toBe('local-media:///slow/disk/video.mp4')
    expect(mirror.calls.prune).toEqual([])

    // A pasted image (bytes only in the renderer) is stored while the copy runs, and
    // the save does not start the same copy again.
    const pasted = imageItem('pasted', registerSource('blob:detached-pasted', [4, 2]))
    await saveCanvasItems([video, pasted], 'mirror-detached')
    expect(fake.record('mirror-detached')!.items.map((item) => item.id)).toEqual(['video', 'pasted'])
    expect(mirror.calls.copy).toHaveLength(1)
    expect(mirror.assetFiles()).toEqual([`${contentKey([4, 2])}.png`])

    // The video is deleted while its copy runs: a prune keeps the file the copy publishes.
    mirror.state.applyPrune = true
    const videoFile = mirror.calls.copy[0].assetFileName
    expect(videoFile).toMatch(/^f-[0-9a-f]{40}\.mp4$/)
    await saveCanvasItems([pasted], 'mirror-detached')
    expect(mirror.calls.prune.at(-1)!.keepEntryNames).toContain(videoFile)

    releaseCopy()
    mirror.state.holdCopy = null
    await waitForCanvasMirrorDetachedCopies()
    expect(getCanvasMirrorDetachedCopyStats('mirror-detached').running).toBe(0)
    expect(mirror.assetFiles()).toContain(videoFile)

    // Undo brings the video back: the next save names the copied file, with no second
    // copy, and the job is forgotten.
    mirror.resetCalls()
    await saveCanvasItems([video, pasted], 'mirror-detached')
    expect(mirror.calls.copy).toEqual([])
    expect(mirror.project().items.find((item) => item.id === 'video')!.src).toBe(`assets/${videoFile}`)
    expect(getCanvasMirrorDetachedCopyStats('mirror-detached').remembered).toBe(0)
  })

  it('does not let a copy that never settles hold up the large copies queued behind it', async () => {
    const mirror = createFakeMirror()
    canvasMirrorDetachedCopyConfig.queueReleaseMs = 20
    try {
      mirror.localFiles.set('/mnt/gone/stuck.mov', new Uint8Array([7, 7, 7, 7]))
      mirror.localFiles.set('/home/u/Videos/next.mov', new Uint8Array([8, 8, 8, 8, 8]))
      // The share stops answering: the first copy does not settle until the end of the test.
      let answer = (): void => {}
      mirror.state.holdCopy = new Promise<void>((resolve) => {
        answer = resolve
      })
      const stuck = imageItem('stuck', 'local-media:///mnt/gone/stuck.mov', { fileName: 'stuck.mov' })
      await saveCanvasItems([stuck], 'mirror-detached-stuck')
      expect(mirror.calls.copy).toHaveLength(1)
      mirror.state.holdCopy = null

      const next = imageItem('next', 'local-media:///home/u/Videos/next.mov', { fileName: 'next.mov' })
      await saveCanvasItems([next], 'mirror-detached-next')
      await vi.waitFor(() => expect(mirror.calls.copy).toHaveLength(2), { timeout: 2000, interval: 10 })
      await vi.waitFor(
        () => expect(getCanvasMirrorDetachedCopyStats('mirror-detached-next').running).toBe(0),
        { timeout: 2000, interval: 10 }
      )
      // The stuck copy still runs: its slot keeps its source and its board is not pruned.
      expect(getCanvasMirrorDetachedCopyStats('mirror-detached-stuck').running).toBe(1)
      await saveCanvasItems([next], 'mirror-detached-next')
      const nextProject = [...mirror.text].find(
        ([name, content]) => name.endsWith('.mpcanvas') && content.includes('next.mov')
      )!
      expect((JSON.parse(nextProject[1]) as { items: Array<{ src: string }> }).items.map((item) => item.src)).toEqual([
        `assets/${mirror.calls.copy[1].assetFileName}`
      ])

      answer()
      await waitForCanvasMirrorDetachedCopies()
      expect(getCanvasMirrorDetachedCopyStats('mirror-detached-stuck').running).toBe(0)
    } finally {
      canvasMirrorDetachedCopyConfig.queueReleaseMs = 5 * 60 * 1000
    }
  })

  it('copies a large file within the save once a detached copy failed, falling back to the renderer', async () => {
    const mirror = createFakeMirror()
    mirror.state.refuseCopy = true
    mirror.localFiles.set('/mnt/share/big.mov', new Uint8Array([3, 3, 3, 3, 3]))
    const big = imageItem('big', 'local-media:///mnt/share/big.mov', { fileName: 'big.mov' })
    await saveCanvasItems([big], 'mirror-detached-refused')
    await waitForCanvasMirrorDetachedCopies()
    expect(mirror.calls.copy).toHaveLength(1)
    expect(mirror.calls.write).toEqual([])

    mirror.resetCalls()
    await saveCanvasItems([{ ...big, x: 1 } as CanvasItem], 'mirror-detached-refused')
    expect(mirror.calls.copy).toHaveLength(1)
    expect(mirror.calls.write).toHaveLength(1)
    expect(mirror.project().items[0].src).toBe(`assets/${mirror.assetFiles()[0]}`)
    expect(getCanvasMirrorDetachedCopyStats('mirror-detached-refused').remembered).toBe(0)
  })

  it('treats a detached copy refused for lack of space as final and does not retry it in that save', async () => {
    const mirror = createFakeMirror()
    mirror.state.noSpace = true
    mirror.localFiles.set('/data/huge.mp4', new Uint8Array([5, 5, 5, 5, 5]))
    const huge = imageItem('huge', 'local-media:///data/huge.mp4', { fileName: 'huge.mp4' })
    await saveCanvasItems([huge], 'mirror-detached-full')
    await waitForCanvasMirrorDetachedCopies()
    expect(mirror.calls.copy).toHaveLength(1)
    expect(mirror.calls.write).toEqual([])
    expect(mirror.assetFiles()).toEqual([])
    expect(getCanvasMirrorDetachedCopyStats('mirror-detached-full').remembered).toBe(0)
  })
})

describe('save-time cost on big boards', () => {
  it('keeps no copy of an inline source in the mirror entry-name cache', async () => {
    createFakeMirror()
    const inline = Array.from({ length: 5 }, (_, index) =>
      imageItem(`inline-${index}`, `data:image/png;base64,${String(index).repeat(20_000)}`)
    )
    const remote = imageItem('remote-cache', registerSource('https://example.invalid/cache.png', [3]))
    const local = imageItem('local-cache', 'local-media:///home/u/Pictures/cache-probe.png')
    const before = getCanvasMirrorEntryNameCacheStats()
    await saveCanvasItems([...inline, remote], 'entry-cache', [], [], null, {
      getProtectedItems: () => [createCanvasHistorySnapshot([...inline, remote, local])]
    })
    const after = getCanvasMirrorEntryNameCacheStats()
    // Only the local source is remembered, and no key is anywhere near an inline source's length.
    expect(after.entries - before.entries).toBe(1)
    expect(after.longestKeyLength).toBeLessThan(2048 + 256)
  })

  it('reads the stored record once per session instead of up to three times per save', async () => {
    const items = Array.from({ length: 40 }, (_, index) =>
      imageItem(`r${index}`, registerSource(`blob:rev-${index}`, [index, 1]))
    )
    await saveCanvasItems(items, 'rev-cache')
    canvasRecordReadStats.fullReads = 0
    fake.resetLog()
    for (let save = 0; save < 5; save += 1) {
      await saveCanvasItems(items.map((item) => ({ ...item, x: save }) as CanvasItem), 'rev-cache')
    }
    // Blur flushes too.
    await saveCanvasItems(items, 'rev-cache', [], [], null, { metadataOnly: true })
    expect(canvasRecordReadStats.fullReads).toBe(0)
    expect(fake.log.gets.filter((get) => get.key === 'rev-cache')).toEqual([])

    // Deleting, adding and the one save of grace work from the cached summary as before.
    const added = imageItem('added', registerSource('blob:rev-added', [9, 9]))
    await saveCanvasItems([...items.slice(1), added], 'rev-cache')
    expect(fake.blobKeys()).toContain(assetBlobKey('rev-cache', [0, 1]))
    expect(fake.blobKeys()).toContain(legacyBlobKey('rev-cache', 'r0'))
    await saveCanvasItems([...items.slice(1), added], 'rev-cache')
    expect(fake.blobKeys()).not.toContain(assetBlobKey('rev-cache', [0, 1]))
    expect(fake.blobKeys()).not.toContain(legacyBlobKey('rev-cache', 'r0'))
    expect(fake.blobBytes(legacyBlobKey('rev-cache', 'added'))).toEqual([9, 9])
    expect(loadLikePreviousRelease('rev-cache').size).toBe(40)
    expect(canvasRecordReadStats.fullReads).toBe(0)
  })

  it('reads the record again once another writer has committed since', async () => {
    const kept = imageItem('kept', registerSource('blob:rev-kept', [1, 1]))
    await saveCanvasItems([kept], 'rev-other')
    // Another window adds an image and commits (its own revision marker).
    const theirs = imageItem('theirs', registerSource('blob:rev-theirs', [2, 2]))
    const ours = fake.record('rev-other')!
    fake.committed.get('canvas-blobs')!.set(assetBlobKey('rev-other', [2, 2]), {
      data: new Uint8Array([2, 2]).buffer,
      mimeType: 'image/png'
    })
    fake.committed.get('canvas-blobs')!.set(legacyBlobKey('rev-other', 'theirs'), {
      data: new Uint8Array([2, 2]).buffer,
      mimeType: 'image/png'
    })
    fake.committed.get('canvas-items')!.set('rev-other', {
      ...ours,
      items: [...ours.items, { ...theirs, src: '', assetKey: contentKey([2, 2]) }],
      legacyBlobAssetKeys: { kept: contentKey([1, 1]), theirs: contentKey([2, 2]) }
    })
    fake.committed.get('canvas-items')!.set('rev-other::canvas-save-revision', 'another-window:1')

    // This window saves a stale snapshot over it: the record is read again, so what the
    // other window's record named survives this save (one save of grace).
    canvasRecordReadStats.fullReads = 0
    await saveCanvasItems([{ ...kept, x: 3 } as CanvasItem], 'rev-other')
    expect(canvasRecordReadStats.fullReads).toBeGreaterThan(0)
    expect(fake.blobKeys()).toContain(assetBlobKey('rev-other', [2, 2]))
    expect(fake.blobKeys()).toContain(legacyBlobKey('rev-other', 'theirs'))

    // A clear drops the marker with the record.
    await clearCanvasItems('rev-other')
    expect(fake.committed.get('canvas-items')!.has('rev-other::canvas-save-revision')).toBe(false)
  })

  it('visits each item object once across 50 history lists of a 2000-item board', async () => {
    const mirror = createFakeMirror()
    const N = 2000
    const H = 50
    const items = Array.from({ length: N }, (_, index) =>
      imageItem(`big-${index}`, `local-media://${mirror.autoSaveRoot}/elsewhere/${index}.png`, {
        x: index
      })
    )
    // Undo history with structural sharing: every step moved one item.
    const history: CanvasItem[][] = []
    let current = items
    for (let step = 0; step < H; step += 1) {
      current = current.map((item, index) =>
        index === step ? ({ ...item, y: step } as CanvasItem) : item
      )
      history.push(current)
    }
    // No source can be read, so the saves stay cheap: only the walk is measured.
    await saveCanvasItems([], 'big-board', [], [], null, { getProtectedItems: () => history })
    expect(canvasProtectedStateWalkStats.visitedItems).toBeLessThanOrEqual(N + H)
    expect(canvasProtectedStateWalkStats.visitedItems).toBeGreaterThanOrEqual(N)
    expect(mirror.calls.prune).toHaveLength(1)
  })

  it('examines each item once across 50 undo snapshots that copy every image item', async () => {
    const mirror = createFakeMirror()
    const N = 2000
    const H = 50
    let current: CanvasItem[] = Array.from({ length: N }, (_, index) =>
      imageItem(`snap-${index}`, `local-media://${mirror.autoSaveRoot}/elsewhere/${index}.png`, {
        x: index,
        sourceIdentity: {
          version: 1,
          kind: 'local-file',
          canonicalPath: `${mirror.autoSaveRoot}/elsewhere/${index}.png`,
          sizeBytes: 3,
          lastModifiedMs: 1_700_000_000_000,
          cacheKey: `k${index}`
        }
      })
    )
    // The canvas history stores snapshots made by createCanvasHistorySnapshot: new objects.
    const history: CanvasItem[][] = []
    for (let step = 0; step < H; step += 1) {
      history.push(createCanvasHistorySnapshot(current))
      current = current.map((item, index) => (index === step ? ({ ...item, y: step } as CanvasItem) : item))
    }
    await saveCanvasItems([], 'snap-board', [], [], null, { getProtectedItems: () => history })
    expect(canvasProtectedStateWalkStats.visitedItems).toBe(N * H)
    expect(canvasProtectedStateWalkStats.examinedItems).toBeLessThanOrEqual(N + H)
    expect(mirror.calls.prune).toHaveLength(1)
  })

  it('still protects a snapshot copy whose source file identity differs from the live item', async () => {
    const mirror = createFakeMirror()
    mirror.state.applyPrune = true
    const filePath = '/home/u/pics/changing.png'
    mirror.localFiles.set(filePath, new Uint8Array([1, 1, 1]))
    const identity = (sizeBytes: number, lastModifiedMs: number) => ({
      version: 1,
      kind: 'local-file',
      canonicalPath: filePath,
      sizeBytes,
      lastModifiedMs,
      cacheKey: `k${lastModifiedMs}`
    })
    const before = imageItem('changing', `local-media://${filePath}`, { sourceIdentity: identity(3, 1_700_000_000_000) })
    await saveCanvasItems([before], 'snap-identity')
    const [oldCopy] = mirror.assetFiles()
    expect(oldCopy).toBe(`${fileIdentityKey(filePath, 3, 1_700_000_000_000)}.png`)

    // The file is rewritten; the item picks up its new identity. Undo still holds the old version.
    mirror.localFiles.set(filePath, new Uint8Array([2, 2, 2, 2]))
    const after = { ...before, sourceIdentity: identity(4, 1_700_000_000_001) } as CanvasItem
    await saveCanvasItems([after], 'snap-identity', [], [], null, {
      getProtectedItems: () => [createCanvasHistorySnapshot([before])]
    })
    // Redo holds a copy of the new version, undo a copy of the old one: same id, same source.
    const history = [createCanvasHistorySnapshot([after]), createCanvasHistorySnapshot([before])]
    await saveCanvasItems([{ ...after, x: 9 } as CanvasItem], 'snap-identity', [], [], null, {
      getProtectedItems: () => history
    })
    expect(mirror.assetFiles()).toContain(oldCopy)
    expect(mirror.assetFiles()).toContain(`${fileIdentityKey(filePath, 4, 1_700_000_000_001)}.png`)
  })
})

describe('empty and changing source files', () => {
  it('stores a file that is empty at the first save with its full bytes once it is complete', async () => {
    const mirror = createFakeMirror()
    const generated = '/home/u/comfy/output/ComfyUI_00001_.png'
    mirror.localFiles.set(generated, new Uint8Array(0))
    // An Agent / ComfyUI result added by URL, while the generator is still writing it.
    const item = imageItem('gen', `local-media://${generated}`)
    await saveCanvasItems([item], 'empty-first')

    const first = fake.record('empty-first')!.items[0]
    expect(first.assetKey).toBeUndefined()
    expect(first.src).toBe(`local-media://${generated}`)
    expect(keyedBlobKeys()).toEqual([])
    expect(mirror.assetFiles()).toEqual([])
    expect(mirror.project().items[0].src).toBe(`local-media://${generated}`)

    // The file is complete now; the item object never changed.
    mirror.localFiles.set(generated, new Uint8Array([1, 2, 3, 4]))
    await saveCanvasItems([item], 'empty-first')
    const second = fake.record('empty-first')!.items[0]
    expect(second.assetKey).toMatch(/^f-[0-9a-f]{40}$/)
    expect(second.src).toBe('')
    expect(fake.blobBytes(`empty-first::canvas::asset::${second.assetKey as string}`)).toEqual([1, 2, 3, 4])
    expect(fake.blobBytes(legacyBlobKey('empty-first', 'gen'))).toEqual([1, 2, 3, 4])
    const [assetFile] = mirror.assetFiles()
    expect([...mirror.files.get(`${mirror.projectDir()}/assets/${assetFile}`)!]).toEqual([1, 2, 3, 4])
    expect(mirror.project().items[0].src).toBe(`assets/${assetFile}`)
  })

  it('stores an empty blob-backed model as it is and saves the rest of the board', async () => {
    // A blob: URL never changes, so waiting for its bytes would block every save for good.
    const model = {
      ...(imageItem('mdl', registerSource('blob:empty-model', [])) as object),
      type: 'model3d',
      fileName: 'mdl.glb'
    } as unknown as CanvasItem
    const note = { id: 'note2', type: 'text', text: 'v1', x: 0, y: 0, zIndex: 2 } as unknown as CanvasItem
    await saveCanvasItems([model, note], 'empty-blob')
    const record = fake.record('empty-blob')!
    expect(record.items.map((item) => item.id)).toEqual(['mdl', 'note2'])
    expect(record.items[0].assetKey).toBe(contentKey([]))
    expect(fake.blobBytes(assetBlobKey('empty-blob', []))).toEqual([])

    await saveCanvasItems([model, { ...note, text: 'v2' } as CanvasItem], 'empty-blob')
    expect(fake.record('empty-blob')!.items[1].text).toBe('v2')
  })

  it('saves a board of the previous release that holds an empty per-item blob of an image', async () => {
    // Previous release: unmarked record, src '' and per-item blobs; one of them was stored empty.
    fake.committed.get('canvas-items')!.set('empty-legacy', {
      items: [
        { ...(imageItem('empty-img', '') as object), src: '' },
        { ...(imageItem('ok-img', '') as object), src: '' },
        { id: 'note', type: 'text', text: 'hi', x: 0, y: 0, zIndex: 2 }
      ],
      groups: [],
      groupBranches: [],
      figmaBinding: null
    })
    fake.committed
      .get('canvas-blobs')!
      .set('empty-legacy::canvas::empty-img', { data: new ArrayBuffer(0), mimeType: 'image/png' })
    fake.committed
      .get('canvas-blobs')!
      .set('empty-legacy::canvas::ok-img', { data: new Uint8Array([1, 2, 3]).buffer, mimeType: 'image/png' })
    const loaded = await loadCanvasItems('empty-legacy')
    expect(loaded.items.map((item) => item.id)).toEqual(['empty-img', 'ok-img', 'note'])

    await saveCanvasItems(
      loaded.items.map((item) => (item.id === 'note' ? ({ ...item, text: 'edited' } as CanvasItem) : item)),
      'empty-legacy'
    )
    const record = fake.record('empty-legacy')!
    expect(record.items.find((item) => item.id === 'note')!.text).toBe('edited')
    expect(record.items.find((item) => item.id === 'ok-img')!.assetKey).toBe(contentKey([1, 2, 3]))
    expect(fake.blobBytes(legacyBlobKey('empty-legacy', 'ok-img'))).toEqual([1, 2, 3])
    expect(fake.blobBytes(legacyBlobKey('empty-legacy', 'empty-img'))).toEqual([])
  })

  it('keys by content the bytes of a file whose size changed since its key was derived', async () => {
    const mirror = createFakeMirror()
    mirror.localFiles.set('/home/u/pics/grown.png', new Uint8Array([5, 5, 5]))
    const sourceIdentity = {
      version: 1,
      kind: 'local-file',
      canonicalPath: '/home/u/pics/grown.png',
      sizeBytes: 9,
      lastModifiedMs: 1_700_000_000_000,
      cacheKey: 'k'
    }
    const item = imageItem('grown', 'local-media:///home/u/pics/grown.png', { sourceIdentity })
    await saveCanvasItems([item], 'resized')
    const saved = fake.record('resized')!.items[0]
    expect(saved.assetKey).toBe(contentKey([5, 5, 5]))
    expect(fake.blobBytes(assetBlobKey('resized', [5, 5, 5]))).toEqual([5, 5, 5])
    expect(keyedBlobKeys()).toEqual([assetBlobKey('resized', [5, 5, 5])])

    // The next save of the unchanged item moves nothing.
    fake.resetLog()
    mirror.resetCalls()
    await saveCanvasItems([{ ...item, x: 1 } as CanvasItem], 'resized')
    expect(fake.blobPuts()).toEqual([])
    expect(mirror.calls.readFileFromPath).toEqual([])
  })

  it('mirrors the bytes a re-keyed file was keyed by, even when the file changes again before the copy', async () => {
    const mirror = createFakeMirror()
    const filePath = '/home/u/pics/growing.png'
    mirror.localFiles.set(filePath, new Uint8Array([5, 5, 5]))
    const svcFs = (window as unknown as { api: { svcFs: Record<string, (...args: never[]) => unknown> } }).api.svcFs
    const copy = svcFs.copyCanvasMirrorAsset
    // The generator appends to the file between the read for IndexedDB and the mirror.
    svcFs.copyCanvasMirrorAsset = async (...args: never[]) => {
      mirror.localFiles.set(filePath, new Uint8Array([5, 5, 5, 7, 7]))
      return await copy(...args)
    }
    const sourceIdentity = {
      version: 1,
      kind: 'local-file',
      canonicalPath: filePath,
      sizeBytes: 9,
      lastModifiedMs: 1_700_000_000_000,
      cacheKey: 'k'
    }
    const item = imageItem('growing', `local-media://${filePath}`, { sourceIdentity })
    await saveCanvasItems([item], 'regrown')

    const assetFile = `${contentKey([5, 5, 5])}.png`
    expect(mirror.assetFiles()).toEqual([assetFile])
    expect([...mirror.files.get(`${mirror.projectDir()}/assets/${assetFile}`)!]).toEqual([5, 5, 5])
    expect(mirror.calls.copy).toEqual([])
  })

  it('carries an absolute previous reference that spells a folder in another case of another length', async () => {
    // 'İ'.toLowerCase() is 'i̇', two code units: the previous project file spells the folder that way.
    const mirror = createFakeMirror('/home/İlkay/AutoSave')
    mirror.state.applyPrune = true
    const projectDirName = buildProjectStorageDirName('spelled', 'spelled')
    const projectDir = `${mirror.autoSaveRoot}/${projectDirName}`
    const assetFile = `f-${'1'.repeat(40)}.png`
    mirror.files.set(`${projectDir}/assets/${assetFile}`, new Uint8Array([3, 1]))
    const spelled = `${'/home/İlkay'.toLowerCase()}/AutoSave/${projectDirName}/assets/${assetFile}`
    expect(spelled.length).toBe(`${projectDir}/assets/${assetFile}`.length + 1)
    // A managed image whose file is gone and that has no recorded hash: its key cannot be computed.
    const managed = imageItem('managed', 'local-media:///home/u/userData/managed/gone.png', {
      media: { kind: 'managed', id: 'media-gone' }
    })
    mirror.text.set(
      `${projectDir}/project.mpcanvas`,
      JSON.stringify({ magic: 'MAGICPOT_CANVAS', version: 8, storageMode: 'project', items: [{ ...managed, src: `local-media://${spelled}` }] })
    )
    await saveCanvasItems([managed], 'spelled')
    expect(mirror.project().items[0].src).toBe(`assets/${assetFile}`)
    expect(mirror.calls.prune.at(-1)!.keepEntryNames).toContain(assetFile)
    expect(mirror.assetFiles()).toEqual([assetFile])
  })
})
