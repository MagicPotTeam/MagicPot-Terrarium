// Synthetic in-memory filesystem and staged IDB only; not native storage or image decoding.
import * as path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadCanvasItems, saveCanvasItems } from './canvasStorage'
import type { CanvasItem } from './types'

function fakeDb() {
  const stores = new Map<string, Map<string, unknown>>([['canvas-items', new Map()], ['canvas-blobs', new Map()]])
  const db = {
    objectStoreNames: { contains: (name: string) => stores.has(name) }, close: vi.fn(),
    transaction(names: string | string[]) {
      const scope = Array.isArray(names) ? names : [names]
      const staged = new Map(scope.map((name) => [name, new Map(stores.get(name)!)]))
      const operations: Array<() => void> = []
      const tx = { oncomplete: undefined as (() => void) | undefined, onerror: undefined as (() => void) | undefined,
        onabort: undefined as (() => void) | undefined, abort: vi.fn(), objectStore(name: string) {
          const store = staged.get(name)!
          return { put(value: unknown, id: string) { store.set(id, value); return {} },
            get(id: string) { const req: { result?: unknown; onsuccess?: () => void } = {}; operations.push(() => { req.result = store.get(id); req.onsuccess?.() }); return req } }
        } }
      setTimeout(() => { while (operations.length) operations.shift()!(); for (const [name, values] of staged) stores.set(name, values); tx.oncomplete?.() }, 0)
      return tx
    }
  }
  return { open: () => { const req: { result?: typeof db; onsuccess?: () => void } = {}; setTimeout(() => { req.result = db; req.onsuccess?.() }, 0); return req } }
}

const base = { x: 0, y: 0, width: 10, height: 10, rotation: 0, scaleX: 1, scaleY: 1, zIndex: 1, locked: false }
const input = [
  { ...base, id: 'image', type: 'image', src: 'blob:image', fileName: 'image.png' },
  { ...base, id: 'model', type: 'model3d', src: 'blob:model', fileName: 'model.glb', textures: { diffuse: 'blob:texture' } }
] as CanvasItem[]
const bytes = new Map([['blob:image', [1, 2]], ['blob:model', [3, 4]], ['blob:texture', [5, 6]]])

describe('project snapshot full reference paths with synthetic stores', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
  it.each([false, true])('saves and restores %s legacy asset references', async (legacy) => {
    const text = new Map<string, string>(), files = new Map<string, Uint8Array>()
    const root = 'C:\\synthetic-project-root'
    const fs = {
      writeTextFile: vi.fn(async ({ outputPath, filename, content }: { outputPath: string; filename: string; content: string }) => { const fullPath = path.win32.join(outputPath, filename); text.set(fullPath, content); return { success: true, fullPath } }),
      readTextFile: vi.fn(async ({ fullPath }: { fullPath: string }) => { const content = text.get(fullPath); if (content === undefined) throw new Error('File not found'); return { content, filename: path.win32.basename(fullPath) } }),
      saveImageToPath: vi.fn(async ({ outputPath, filename, image }: { outputPath: string; filename: string; image: Uint8Array }) => { const fullPath = path.win32.join(outputPath, filename); files.set(fullPath, new Uint8Array(image)); return { success: true, fullPath } }),
      readFileFromPath: vi.fn(async ({ fullPath }: { fullPath: string }) => { const data = files.get(fullPath); if (!data) throw new Error('File not found'); return { data, filename: path.win32.basename(fullPath) } }),
      listFilesInFolder: vi.fn(async () => ({ files: [...files.keys()].map((fullPath) => ({ fullPath })) }))
    }
    const priorPath = Object.getOwnPropertyDescriptor(window, 'path')
    Object.defineProperty(window, 'path', { configurable: true, value: path.win32 })
    vi.stubGlobal('api', { svcState: { getConfig: async () => ({ config: { download_dir: root } }), getUserDataDirectoryState: async () => ({ state: { projectRoot: root, autoSaveRoot: root } }) }, svcFs: fs })
    vi.stubGlobal('indexedDB', fakeDb())
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: bytes.has(url), arrayBuffer: async () => new Uint8Array(bytes.get(url) ?? []).buffer })))
    try {
      await saveCanvasItems(input, 'synthetic-project')
      const entry = [...text.entries()].find(([name]) => name.endsWith('.mpcanvas'))
      expect(entry).toBeDefined()
      const projectDir = path.win32.dirname(entry![0])
      const project = JSON.parse(entry![1]) as { items: Array<{ id: string; src: string; textures?: Record<string, string> }> }
      const image = project.items.find((item) => item.id === 'image')!
      const model = project.items.find((item) => item.id === 'model')!
      const refs: Array<[string, number[]]> = [[image.src, [1, 2]], [model.src, [3, 4]], [model.textures!.diffuse, [5, 6]]]
      for (const [ref, expected] of refs) {
        expect(ref).toMatch(/^assets\//)
        expect(files.get(path.win32.join(projectDir, ref))).toEqual(new Uint8Array(expected))
      }
      if (legacy) {
        refs.forEach(([ref], index) => { const legacyRef = `assets/legacy-${index}.bin`; files.set(path.win32.join(projectDir, legacyRef), files.get(path.win32.join(projectDir, ref))!); if (index === 0) image.src = legacyRef; else if (index === 1) model.src = legacyRef; else model.textures!.diffuse = legacyRef })
        text.set(entry![0], JSON.stringify(project))
      }
      vi.stubGlobal('indexedDB', fakeDb()) // Fresh empty IDB forces synthetic filesystem fallback.
      const restored = await loadCanvasItems('synthetic-project')
      const restoredImage = restored.items.find((item) => item.id === 'image')
      const restoredModel = restored.items.find((item) => item.id === 'model')
      expect(restoredImage?.type).toBe('image')
      expect(restoredModel?.type).toBe('model3d')
      if (restoredImage?.type !== 'image' || restoredModel?.type !== 'model3d') throw new Error('missing restored items')
      const expectedRefs = [image.src, model.src, model.textures!.diffuse]
      const urls = [restoredImage.src, restoredModel.src, restoredModel.textures!.diffuse]
      urls.forEach((url, index) => { expect(url.replace(/^local-media:\/\/\//, '').replace(/\//g, '\\')).toBe(path.win32.join(projectDir, expectedRefs[index])); expect(files.get(path.win32.join(projectDir, expectedRefs[index]))).toEqual(new Uint8Array(refs[index][1])) })
    } finally {
      if (priorPath) Object.defineProperty(window, 'path', priorPath)
      else Reflect.deleteProperty(window, 'path')
    }
  })
})
