import { afterEach, describe, expect, it, vi } from 'vitest'
import { saveCanvasItems } from './canvasStorage'
import type { CanvasItem } from './types'

// A staged in-memory model of abort/commit, not evidence of native IndexedDB isolation.
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
      const staged = new Map([...committed].map(([name, store]) => [name, new Map(store)]))
      const tx = {
        oncomplete: null as (() => void) | null,
        onabort: null as (() => void) | null,
        onerror: null as (() => void) | null,
        error: null as Error | null,
        abort() {
          record.aborted = true
          setTimeout(() => tx.onabort?.(), 0)
        },
        objectStore(name: string) {
          if (!names.includes(name)) throw new Error('store not in transaction')
          return { put(value: unknown, key: string) {
            record.puts.push(name)
            if (mode === 'sync-throw' && name === 'canvas-items') throw new Error('synthetic metadata put failure')
            staged.get(name)!.set(key, value)
            return {}
          } }
        }
      }
      setTimeout(() => {
        if (record.aborted) return
        if (mode === 'async-abort') {
          tx.error = new Error('synthetic asynchronous request failure')
          record.aborted = true
          tx.onabort?.()
          return
        }
        for (const [name, store] of staged) committed.set(name, store)
        record.committed = true
        tx.oncomplete?.()
      }, 0)
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

function item(label: string): CanvasItem {
  return { id: 'image', type: 'image', src: 'blob:synthetic', fileName: 'fixture.png',
    x: 0, y: 0, width: 1, height: 1, rotation: 0, scaleX: 1, scaleY: 1,
    zIndex: 0, locked: false, caption: label } as CanvasItem
}

describe('canvas snapshot atomic staged fake', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it.each(['sync-throw', 'async-abort', 'success'] as const)(
    'keeps or commits both stores together in synthetic %s case', async mode => {
      const fake = createStagedIndexedDb()
      vi.stubGlobal('indexedDB', fake.api)
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2]).buffer })))
      vi.stubGlobal('api', undefined)
      vi.spyOn(console, 'error').mockImplementation(() => {})
      await saveCanvasItems([item('old')], 'atomic-fixture')
      expect(fake.transactions).toHaveLength(1)
      const oldMetadata = fake.committed.get('canvas-items')!.get('atomic-fixture')
      const blobKey = [...fake.committed.get('canvas-blobs')!.keys()][0]
      const oldBlob = fake.committed.get('canvas-blobs')!.get(blobKey)
      expect(oldMetadata).toBeDefined()
      expect(oldBlob).toBeDefined()
      expect(Array.from(new Uint8Array((oldBlob as { data: ArrayBuffer }).data))).toEqual([1, 2])
      fake.setMode(mode)
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([7, 8, 9]).buffer })))
      const pending = saveCanvasItems([item('new')], 'atomic-fixture')
      if (mode === 'success') await expect(pending).resolves.toBeUndefined()
      else await expect(pending).rejects.toThrow(/synthetic/)
      expect(fake.transactions).toHaveLength(2)
      const tx = fake.transactions[1]
      expect(tx.stores.slice().sort()).toEqual(['canvas-blobs', 'canvas-items'])
      expect(tx.mode).toBe('readwrite')
      expect(tx.puts).toEqual(['canvas-blobs', 'canvas-items'])
      if (mode === 'success') {
        expect(tx.committed).toBe(true)
        expect(fake.committed.get('canvas-items')!.get('atomic-fixture')).not.toEqual(oldMetadata)
        expect(Array.from(new Uint8Array((fake.committed.get('canvas-blobs')!.get(blobKey) as { data: ArrayBuffer }).data))).toEqual([7, 8, 9])
      } else {
        expect(tx.aborted).toBe(true)
        expect(tx.committed).toBe(false)
        expect(fake.committed.get('canvas-items')!.get('atomic-fixture')).toEqual(oldMetadata)
        expect(Array.from(new Uint8Array((fake.committed.get('canvas-blobs')!.get(blobKey) as { data: ArrayBuffer }).data))).toEqual([1, 2])
      }
    }
  )
})
