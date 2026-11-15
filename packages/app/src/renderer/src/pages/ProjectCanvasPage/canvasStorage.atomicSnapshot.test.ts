import { afterEach, describe, expect, it, vi } from 'vitest'
import { saveCanvasItems } from './canvasStorage'
import type { CanvasItem } from './types'

// A staged in-memory model of abort/commit, not evidence of native IndexedDB isolation.
// Writes are staged per transaction and applied when it completes; the failure modes hit
// the transaction that writes the metadata record, i.e. the moment after the asset bytes
// of a save were written and before the record that names them is committed.
type StagedOp = { store: string; kind: 'put' | 'delete'; key: string; value?: unknown }

function createStagedIndexedDb() {
  const committed = new Map<string, Map<string, unknown>>([
    ['canvas-items', new Map()], ['canvas-blobs', new Map()]
  ])
  let mode: 'success' | 'sync-throw' | 'async-abort' = 'success'
  const transactions: Array<{ stores: string[]; mode: string; puts: string[]; aborted: boolean; committed: boolean }> = []
  const database = {
    objectStoreNames: { contains: (name: string) => committed.has(name) },
    createObjectStore: (name: string) => committed.set(name, new Map()),
    close: vi.fn(),
    transaction(names: string[], txMode: string) {
      const record = { stores: [...names], mode: txMode, puts: [] as string[], aborted: false, committed: false }
      transactions.push(record)
      const ops: StagedOp[] = []
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
          if (!names.includes(name)) throw new Error('store not in transaction')
          const request = <T>(produce: () => T) => {
            const req: { result?: T; onsuccess?: (() => void) | null } = {}
            pending += 1
            setTimeout(() => {
              if (!settled) { req.result = produce(); req.onsuccess?.() }
              pending -= 1
              scheduleCompletion()
            }, 0)
            return req
          }
          const visibleKeys = () => {
            const keys = new Set(committed.get(name)!.keys())
            for (const op of ops) {
              if (op.store !== name) continue
              if (op.kind === 'put') keys.add(op.key)
              else keys.delete(op.key)
            }
            return [...keys]
          }
          return {
            put(value: unknown, key: string) {
              record.puts.push(name)
              if (mode === 'sync-throw' && name === 'canvas-items') throw new Error('synthetic metadata put failure')
              ops.push({ store: name, kind: 'put', key, value })
              return request(() => key)
            },
            delete(key: string) {
              ops.push({ store: name, kind: 'delete', key })
              return request(() => undefined)
            },
            get(key: string) {
              return request(() => {
                const staged = [...ops].reverse().find((op) => op.store === name && op.key === key)
                return staged ? (staged.kind === 'put' ? staged.value : undefined) : committed.get(name)!.get(key)
              })
            },
            getAllKeys() { return request(() => visibleKeys()) }
          }
        }
      }
      const scheduleCompletion = () => {
        setTimeout(() => {
          if (settled || pending > 0) return
          settled = true
          if (mode === 'async-abort' && ops.some((op) => op.store === 'canvas-items')) {
            tx.error = new Error('synthetic asynchronous request failure')
            record.aborted = true
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
    committed, transactions,
    setMode(value: typeof mode) { mode = value },
    api: { open: () => {
      const request: { result?: typeof database; onsuccess?: () => void } = {}
      setTimeout(() => { request.result = database; request.onsuccess?.() }, 0)
      return request
    } }
  }
}

function item(label: string, src: string): CanvasItem {
  return { id: 'image', type: 'image', src, fileName: 'fixture.png',
    x: 0, y: 0, width: 1, height: 1, rotation: 0, scaleX: 1, scaleY: 1,
    zIndex: 0, locked: false, caption: label } as CanvasItem
}

const bytesOf = (value: unknown): number[] => Array.from(new Uint8Array((value as { data: ArrayBuffer }).data))

describe('canvas snapshot atomic staged fake', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it.each(['sync-throw', 'async-abort', 'success'] as const)(
    'never leaves the record pointing at unwritten or replaced bytes in synthetic %s case', async mode => {
      const fake = createStagedIndexedDb()
      const sources = new Map([
        ['blob:synthetic-old', [1, 2]],
        ['blob:synthetic-new', [7, 8, 9]]
      ])
      vi.stubGlobal('indexedDB', fake.api)
      vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, arrayBuffer: async () => new Uint8Array(sources.get(url)!).buffer })))
      vi.stubGlobal('api', undefined)
      vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const blobs = fake.committed.get('canvas-blobs')!
      const records = fake.committed.get('canvas-items')!
      const recordedAssetKey = () => (records.get('atomic-fixture') as { items: Array<{ assetKey: string }> }).items[0].assetKey

      await saveCanvasItems([item('old', 'blob:synthetic-old')], 'atomic-fixture')
      const oldMetadata = records.get('atomic-fixture')
      expect(oldMetadata).toBeDefined()
      const oldBlobKey = `atomic-fixture::canvas::asset::${recordedAssetKey()}`
      expect([...blobs.keys()]).toEqual([oldBlobKey])
      expect(bytesOf(blobs.get(oldBlobKey))).toEqual([1, 2])

      fake.setMode(mode)
      fake.transactions.length = 0
      const pending = saveCanvasItems([item('new', 'blob:synthetic-new')], 'atomic-fixture')
      if (mode === 'success') await expect(pending).resolves.toBeUndefined()
      else await expect(pending).rejects.toThrow(/synthetic/)

      // The new bytes are written before, and in a different transaction than, the record.
      const metadataTx = fake.transactions.find((tx) => tx.puts.includes('canvas-items'))!
      expect(metadataTx.mode).toBe('readwrite')
      expect(metadataTx.puts).toEqual(['canvas-items'])
      const assetTx = fake.transactions.find((tx) => tx.puts.includes('canvas-blobs'))!
      expect(assetTx.committed).toBe(true)
      expect(fake.transactions.indexOf(assetTx)).toBeLessThan(fake.transactions.indexOf(metadataTx))

      if (mode === 'success') {
        expect(metadataTx.committed).toBe(true)
        expect(records.get('atomic-fixture')).not.toEqual(oldMetadata)
        const newBlobKey = `atomic-fixture::canvas::asset::${recordedAssetKey()}`
        expect(newBlobKey).not.toBe(oldBlobKey)
        expect(bytesOf(blobs.get(newBlobKey))).toEqual([7, 8, 9])
        // The replaced asset is unreferenced after the commit and is pruned.
        expect([...blobs.keys()]).toEqual([newBlobKey])
      } else {
        expect(metadataTx.aborted).toBe(true)
        expect(metadataTx.committed).toBe(false)
        // The previous board is intact: same record, and the bytes it names are untouched.
        expect(records.get('atomic-fixture')).toEqual(oldMetadata)
        expect(bytesOf(blobs.get(oldBlobKey))).toEqual([1, 2])
        // Nothing was deleted, and no stored key was rewritten: the failed save only left
        // an unreferenced blob behind.
        expect(fake.transactions.some((tx) => tx.stores.includes('canvas-blobs') && tx !== assetTx && tx.puts.includes('canvas-blobs'))).toBe(false)
        expect([...blobs.keys()].filter((key) => key !== oldBlobKey)).toHaveLength(1)
      }
    }
  )
})
