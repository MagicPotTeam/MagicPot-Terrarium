// Synthetic staged IndexedDB model, not a native transaction or isolation test.
import * as path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadCanvasItems } from './canvasStorage'

vi.mock('../MainPage/projectStore', () => ({
  getProjectById: () => ({ name: 'Synthetic', storageDirName: '.synthetic' }),
  buildProjectStorageDirName: () => '.synthetic'
}))

type Request = { result?: unknown; onsuccess?: () => void }
type Stored = { data: ArrayBuffer; mimeType: string }
const image = (caption: string) => ({ id: 'same', type: 'image', src: 'blob:original', caption,
  x: 0, y: 0, width: 1, height: 1, rotation: 0, scaleX: 1, scaleY: 1, zIndex: 0, locked: false })

function model() {
  const stores = new Map<string, Map<string, unknown>>([
    ['canvas-items', new Map([['default', { items: [image('default metadata')], groups: [], groupBranches: [] }]])],
    ['canvas-blobs', new Map([['default::canvas::same', { data: new Uint8Array([11]).buffer, mimeType: 'image/png' }]])]
  ])
  const db = {
    close: vi.fn(),
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    transaction(names: string | string[]) {
      const scope = Array.isArray(names) ? names : [names]
      const staged = new Map(scope.map(name => [name, new Map(stores.get(name)!)]))
      const operations: Array<() => void> = []
      const tx = { oncomplete: undefined as (() => void) | undefined, onerror: undefined as (() => void) | undefined,
        objectStore(name: string) { return {
          get(key: string) { const req: Request = {}; operations.push(() => { req.result = staged.get(name)!.get(key); req.onsuccess?.() }); return req },
          put(value: Stored, key: string) { operations.push(() => { staged.get(name)!.set(key, value) }); return {} }
        } }
      }
      setTimeout(() => {
        while (operations.length) operations.shift()!()
        for (const [name, data] of staged) stores.set(name, data)
        tx.oncomplete?.()
      }, 0)
      return tx
    }
  }
  return { stores, api: { open() { const req: Request = {}; setTimeout(() => { req.result = db; req.onsuccess?.() }, 0); return req } } }
}

describe('legacy canvas fallback scope (synthetic model)', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
  it('does not overwrite the default canvas when recovering another canvas with embedded image', async () => {
    const db = model()
    vi.stubGlobal('indexedDB', db.api)
    vi.stubGlobal('path', path.posix)
    const read = vi.fn(async ({ fullPath }: { fullPath: string }) => {
      if (fullPath !== '/root/synthetic/project.mpcanvas') throw new Error('file not found')
      return { content: JSON.stringify({ magic: 'MAGICPOT_CANVAS', version: 8, createdAt: 'synthetic', storageMode: 'embedded',
        items: [image('other metadata')], blobs: { same: { base64: 'Fg==', mimeType: 'image/png' } } }) }
    })
    vi.stubGlobal('api', { svcFs: { readTextFile: read }, svcState: {
      getConfig: async () => ({ config: { download_dir: '/root' } }),
      getUserDataDirectoryState: async () => ({ state: { autoSaveRoot: '/autosave' } })
    } })
    const urls = new Map<string, Blob>()
    vi.stubGlobal('URL', class extends URL { static createObjectURL(blob: Blob) { const url = `blob:fixture-${urls.size}`; urls.set(url, blob); return url }; static revokeObjectURL = vi.fn() })
    const readByte = async (url: string) => await new Promise<number>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer)[0])
      reader.onerror = () => reject(reader.error)
      reader.readAsArrayBuffer(urls.get(url)!)
    })
    const before = await loadCanvasItems('default')
    const other = await loadCanvasItems('other')
    const otherAgain = await loadCanvasItems('other')
    const after = await loadCanvasItems('default')
    expect(read.mock.calls.map(([arg]) => arg.fullPath)).toContain('/root/synthetic/project.mpcanvas')
    expect(other.items[0]).toMatchObject({ id: 'same', caption: 'other metadata' })
    expect(otherAgain.items[0]).toMatchObject({ id: 'same', caption: 'other metadata' })
    const otherImage = other.items[0], repeatedImage = otherAgain.items[0]
    const beforeImage = before.items[0], afterImage = after.items[0]
    if (otherImage?.type !== 'image' || repeatedImage?.type !== 'image' ||
        beforeImage?.type !== 'image' || afterImage?.type !== 'image') {
      throw new Error('expected four restored image fixtures')
    }
    expect(await readByte(otherImage.src)).toBe(22)
    expect(await readByte(repeatedImage.src)).toBe(22)
    expect(beforeImage).toMatchObject({ id: 'same', caption: 'default metadata' })
    expect(afterImage).toMatchObject({ id: 'same', caption: 'default metadata' })
    expect(await readByte(beforeImage.src)).toBe(11)
    expect(await readByte(afterImage.src)).toBe(11)
  })
})
