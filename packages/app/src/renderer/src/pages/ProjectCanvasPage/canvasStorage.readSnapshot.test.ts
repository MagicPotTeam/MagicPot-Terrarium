// Deterministic serial-transaction model only; this is not a native IndexedDB isolation test.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadCanvasItems } from './canvasStorage'
import * as path from 'path'

const key = 'synthetic-snapshot'
const separator = '::canvas::'
const metadata = (version: number) => ({ items: [
  { id: 'image', type: 'image', src: 'blob:old-image', caption: `v${version}`, x: 0, y: 0, width: 1, height: 1, rotation: 0, scaleX: 1, scaleY: 1, zIndex: 0, locked: false },
  { id: 'model', type: 'model3d', src: 'blob:old-model', fileName: 'model.glb', textures: { diffuse: 'blob:old-texture' }, x: 0, y: 0, width: 1, height: 1, rotation: 0, scaleX: 1, scaleY: 1, zIndex: 1, locked: false }
], groups: [], groupBranches: [], figmaBinding: null })
const binary = (value: number) => ({ data: new Uint8Array([value]).buffer, mimeType: 'application/octet-stream' })

type Request = { result?: unknown; onsuccess?: () => void; onerror?: () => void }
type Operation = { store: string; key: string; request: Request }
type Tx = { names: string[]; operations: Operation[]; oncomplete?: () => void; onerror?: () => void; onabort?: () => void; objectStore: (name: string) => { get: (key: string) => Request } }

function createModel(interleave: boolean, legacy = false) {
  const stores = new Map<string, Map<string, unknown>>([
    ['canvas-items', new Map([[key, metadata(1)]])],
    ['canvas-blobs', new Map()]
  ])
  const blobs = stores.get('canvas-blobs')!
  const putVersion = (version: number) => {
    stores.get('canvas-items')!.set(key, metadata(version))
    for (const [id, base] of [['image', 10], ['model', 20], ['model::tex::diffuse', 30]] as const)
      blobs.set(legacy ? id : `${key}${separator}${id}`, binary(base + version))
  }
  putVersion(1)
  let writerPending = false
  let writerCommitted = false
  const transactions: Tx[] = []
  const db = {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    close: vi.fn(),
    transaction(names: string | string[]) {
      const scope = Array.isArray(names) ? names : [names]
      if (writerPending && !writerCommitted) { putVersion(2); writerCommitted = true }
      const snapshot = new Map(scope.map((name) => [name, new Map(stores.get(name)!)]))
      const tx: Tx = { names: scope, operations: [], objectStore(name) {
        if (!scope.includes(name)) throw new Error('invalid transaction scope')
        return { get(id) { const request: Request = {}; tx.operations.push({ store: name, key: id, request }); return request } }
      } }
      transactions.push(tx)
      setTimeout(() => {
        // Process requests queued by prior success handlers in this same active transaction.
        while (tx.operations.length) {
          const op = tx.operations.shift()!
          op.request.result = snapshot.get(op.store)!.get(op.key)
          op.request.onsuccess?.()
          if (interleave && op.store === 'canvas-items') writerPending = true
        }
        tx.oncomplete?.()
        // Competing writer can commit only after this transaction's requests finish.
        if (writerPending && !writerCommitted) { putVersion(2); writerCommitted = true }
      }, 0)
      return tx
    }
  }
  return { transactions, stores, api: { open: () => {
    const request: { result?: typeof db; onsuccess?: () => void } = {}
    setTimeout(() => { request.result = db; request.onsuccess?.() }, 0)
    return request
  } } }
}

describe('canvas load snapshot deterministic transaction model', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
  it.each([false, true])('preserves relative asset semantics when project root exists=%s', async (hasRoot) => {
    const model = createModel(false)
    const data = metadata(1)
    data.items[0].src = 'assets/missing.png'
    model.stores.get('canvas-items')!.set(key, data)
    vi.stubGlobal('indexedDB', model.api)
    const previousPath = Object.getOwnPropertyDescriptor(window, 'path')
    Object.defineProperty(window, 'path', { configurable: true, value: path.posix })
    vi.stubGlobal('api', hasRoot ? { svcState: { getConfig: async () => ({ config: { download_dir: '/synthetic-root' } }) } } : undefined)
    const created = vi.fn(() => 'blob:stale-synthetic')
    vi.stubGlobal('URL', class extends URL { static createObjectURL = created; static revokeObjectURL = vi.fn() })
    try {
      const snapshot = await loadCanvasItems(key)
      const item = snapshot.items.find((candidate) => candidate.id === 'image')
      expect(item?.type).toBe('image')
      if (item?.type !== 'image') throw new Error('missing synthetic image')
      if (hasRoot) expect(item.src).toMatch(/^blob:stale-synthetic$/)
      else expect(item.src).toBe('assets/missing.png')
    } finally {
      if (previousPath) Object.defineProperty(window, 'path', previousPath)
      else Reflect.deleteProperty(window, 'path')
    }
  })

  it.each([
    { name: 'no concurrent writer', interleave: false, legacy: false },
    { name: 'legacy unscoped blob keys', interleave: false, legacy: true },
    { name: 'writer commits between split reads', interleave: true, legacy: false }
  ])('returns one complete version: $name', async ({ interleave, legacy }) => {
    const model = createModel(interleave, legacy)
    vi.stubGlobal('indexedDB', model.api)
    vi.stubGlobal('api', undefined)
    const created = new Map<string, Blob>()
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL(blob: Blob) { const url = `blob:synthetic-${created.size}`; created.set(url, blob); return url }
      static revokeObjectURL = vi.fn()
    })
    const snapshot = await loadCanvasItems(key)
    const image = snapshot.items.find((item) => item.id === 'image')
    const modelItem = snapshot.items.find((item) => item.id === 'model')
    expect(image?.type).toBe('image')
    expect(modelItem?.type).toBe('model3d')
    if (image?.type !== 'image' || modelItem?.type !== 'model3d') throw new Error('missing fixture')
    const read = async (url: string) => await new Promise<number>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer)[0])
      reader.onerror = () => reject(reader.error)
      reader.readAsArrayBuffer(created.get(url)!)
    })
    const caption = 'caption' in image ? image.caption : undefined
    const version = caption === 'v1' ? 1 : caption === 'v2' ? 2 : 0
    expect(version).toBeGreaterThan(0)
    expect(await read(image.src)).toBe(10 + version)
    expect(await read(modelItem.src)).toBe(20 + version)
    expect(await read(modelItem.textures!.diffuse)).toBe(30 + version)
  })
})
