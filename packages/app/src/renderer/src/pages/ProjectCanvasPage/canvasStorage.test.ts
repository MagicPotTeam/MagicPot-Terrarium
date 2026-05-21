import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as path from 'path'
import {
  CANVAS_FILE_VERSION,
  clearCanvasItems,
  exportCanvasFile,
  exportCanvasFileAsStandalone,
  importCanvasFile,
  loadCanvasItems,
  saveCanvasItems
} from './canvasStorage'
import type { CanvasGroup, CanvasGroupBranch, CanvasItem } from './types'

type FakeStoreMap = Map<string, Map<string, unknown>>

function cloneValue<T>(value: T): T {
  if (value !== undefined && typeof structuredClone === 'function') {
    return structuredClone(value)
  }
  return value === undefined ? value : JSON.parse(JSON.stringify(value))
}

class FakeIDBObjectStore {
  constructor(
    private stores: FakeStoreMap,
    private storeName: string
  ) {}

  put(value: unknown, key: string): void {
    this.stores.get(this.storeName)?.set(key, cloneValue(value))
  }

  get(key: string): { result?: unknown; onsuccess?: () => void; onerror?: () => void } {
    const request: { result?: unknown; onsuccess?: () => void; onerror?: () => void } = {}
    setTimeout(() => {
      request.result = cloneValue(this.stores.get(this.storeName)?.get(key))
      request.onsuccess?.()
    }, 0)
    return request
  }

  getAllKeys(): { result?: string[]; onsuccess?: () => void; onerror?: () => void } {
    const request: { result?: string[]; onsuccess?: () => void; onerror?: () => void } = {}
    setTimeout(() => {
      request.result = [...(this.stores.get(this.storeName)?.keys() || [])]
      request.onsuccess?.()
    }, 0)
    return request
  }

  delete(key: string): void {
    this.stores.get(this.storeName)?.delete(key)
  }

  clear(): void {
    this.stores.get(this.storeName)?.clear()
  }
}

class FakeIDBTransaction {
  oncomplete: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(private stores: FakeStoreMap) {
    setTimeout(() => {
      this.oncomplete?.()
    }, 0)
  }

  objectStore(name: string): FakeIDBObjectStore {
    const store = this.stores.get(name)
    if (!store) {
      throw new Error(`Missing fake object store: ${name}`)
    }
    return new FakeIDBObjectStore(this.stores, name)
  }
}

class FakeIDBDatabase {
  objectStoreNames: { contains: (name: string) => boolean }

  constructor(private stores: FakeStoreMap) {
    this.objectStoreNames = {
      contains: (name: string) => this.stores.has(name)
    }
  }

  createObjectStore(name: string): FakeIDBObjectStore {
    if (!this.stores.has(name)) {
      this.stores.set(name, new Map())
    }
    return new FakeIDBObjectStore(this.stores, name)
  }

  transaction(_name: string, _mode: string): FakeIDBTransaction {
    return new FakeIDBTransaction(this.stores)
  }

  close(): void {
    /* noop for test double */
  }
}

function createFakeIndexedDB(): { open: (name: string, version: number) => unknown } {
  const stores: FakeStoreMap = new Map()
  let database: FakeIDBDatabase | null = null

  return {
    open: (_name: string, _version: number) => {
      const request: {
        result?: FakeIDBDatabase
        onupgradeneeded?: () => void
        onsuccess?: () => void
        onerror?: () => void
        error?: unknown
      } = {}

      setTimeout(() => {
        if (!database) {
          database = new FakeIDBDatabase(stores)
          request.result = database
          request.onupgradeneeded?.()
        }
        request.result = database
        request.onsuccess?.()
      }, 0)

      return request
    }
  }
}

function createFailingIndexedDBOpen(error?: unknown): {
  open: (name: string, version: number) => unknown
} {
  return {
    open: (_name: string, _version: number) => {
      const request: {
        onupgradeneeded?: () => void
        onsuccess?: () => void
        onerror?: () => void
        error?: unknown
      } = { error }

      setTimeout(() => {
        request.onerror?.()
      }, 0)

      return request
    }
  }
}

async function readBlobAsText(blob: Blob): Promise<string> {
  const blobWithReaders = blob as Blob & {
    text?: () => Promise<string>
    arrayBuffer?: () => Promise<ArrayBuffer>
  }

  if (typeof blobWithReaders.text === 'function') {
    return blobWithReaders.text()
  }

  if (typeof blobWithReaders.arrayBuffer === 'function') {
    const buffer = await blobWithReaders.arrayBuffer()
    return new TextDecoder().decode(buffer)
  }

  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
        return
      }
      resolve(new TextDecoder().decode(reader.result as ArrayBuffer))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read blob export payload'))
    reader.readAsText(blob)
  })
}

async function openFakeCanvasDb(): Promise<FakeIDBDatabase> {
  return await new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open('magicpot-canvas', 2) as unknown as {
      result?: FakeIDBDatabase
      onupgradeneeded?: () => void
      onsuccess?: () => void
      onerror?: () => void
      error?: unknown
    }
    request.onupgradeneeded = () => {
      const db = request.result as FakeIDBDatabase
      if (!db.objectStoreNames.contains('canvas-items')) {
        db.createObjectStore('canvas-items')
      }
      if (!db.objectStoreNames.contains('canvas-blobs')) {
        db.createObjectStore('canvas-blobs')
      }
    }
    request.onsuccess = () => resolve(request.result as FakeIDBDatabase)
    request.onerror = () => reject(request.error ?? new Error('Failed to open fake IndexedDB'))
  })
}

async function seedCanvasMetadataStore(storeKey: string, payload: unknown): Promise<void> {
  const db = await openFakeCanvasDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('canvas-items', 'readwrite') as FakeIDBTransaction
    tx.objectStore('canvas-items').put(payload, storeKey)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(new Error('Failed to seed fake canvas metadata'))
  })
  db.close()
}

function createCanvasItem(overrides: Partial<CanvasItem> = {}): CanvasItem {
  return {
    id: 'text-1',
    type: 'text',
    x: 40,
    y: 60,
    width: 220,
    height: 80,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false,
    text: 'MagicPot provenance',
    fontSize: 18,
    fontFamily: 'IBM Plex Sans',
    fill: '#111111',
    provenance: {
      kind: 'figma',
      sourceFileName: 'LandingPage.fig',
      sourceDocumentId: 'file-42',
      sourceNodeId: 'node-7',
      sourceNodeName: 'Hero Card',
      importedAt: '2026-03-28T06:45:00.000Z',
      bridgeTraceId: 'bridge-figma-1'
    },
    ...overrides
  } as CanvasItem
}

function createCanvasGroup(overrides: Partial<CanvasGroup> = {}): CanvasGroup {
  return {
    id: 'group-1',
    name: 'Imported group',
    itemIds: ['text-1'],
    createdAt: '2026-03-28T06:45:00.000Z',
    provenance: {
      kind: 'psd',
      sourceFileName: 'LandingPage.psd',
      sourceNodeName: 'Card Stack',
      importedAt: '2026-03-28T06:45:05.000Z'
    },
    ...overrides
  }
}

function createCanvasGroupBranch(overrides: Partial<CanvasGroupBranch> = {}): CanvasGroupBranch {
  return {
    id: 'branch-1',
    name: '2D',
    createdAt: '2026-03-28T06:45:02.000Z',
    ...overrides
  }
}

describe('canvasStorage provenance metadata', () => {
  const originalIndexedDb = globalThis.indexedDB
  const originalCreateObjectURL = URL.createObjectURL
  const originalRevokeObjectURL = URL.revokeObjectURL
  const originalFetch = globalThis.fetch
  const originalGlobalImage = globalThis.Image
  const originalWindowApi = window.api
  const originalWindowPath = window.path

  beforeEach(() => {
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      writable: true,
      value: createFakeIndexedDB()
    })
    URL.createObjectURL = vi.fn(() => 'blob:mock-export')
    URL.revokeObjectURL = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: undefined as unknown as Window['api']
    })
    Object.defineProperty(window, 'path', {
      configurable: true,
      writable: true,
      value: undefined as unknown as Window['path']
    })
    localStorage.clear()
  })

  afterEach(() => {
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      writable: true,
      value: originalIndexedDb
    })
    URL.createObjectURL = originalCreateObjectURL
    URL.revokeObjectURL = originalRevokeObjectURL
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: originalFetch
    })
    Object.defineProperty(globalThis, 'Image', {
      configurable: true,
      writable: true,
      value: originalGlobalImage
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: originalWindowApi
    })
    Object.defineProperty(window, 'path', {
      configurable: true,
      writable: true,
      value: originalWindowPath
    })
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('persists provenance metadata through saveCanvasItems and loadCanvasItems', async () => {
    const items = [createCanvasItem()]
    const groups = [createCanvasGroup()]
    const groupBranches = [createCanvasGroupBranch()]

    await saveCanvasItems(items, 'provenance-test', groups, groupBranches)
    const restored = await loadCanvasItems('provenance-test')

    expect(restored.items).toEqual(items)
    expect(restored.groups).toEqual(groups)
    expect(restored.groupBranches).toEqual(groupBranches)
  })

  it('strips full-image identity crop from unrelated image persistence payloads', async () => {
    const items = [
      {
        id: 'image-1',
        type: 'image',
        x: 32,
        y: 48,
        width: 82,
        height: 82,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        zIndex: 1,
        locked: false,
        src: 'data:image/png;base64,AAAA',
        fileName: 'identity.png',
        sourceWidth: 82,
        sourceHeight: 82,
        crop: {
          x: 0,
          y: 0,
          width: 82,
          height: 82
        }
      } as CanvasItem
    ]

    await saveCanvasItems(items, 'identity-crop-test')
    const restored = await loadCanvasItems('identity-crop-test')

    expect(restored.items).toHaveLength(1)
    expect(restored.items[0]).not.toHaveProperty('crop')
  })

  it('writes provenance metadata into .mpcanvas exports and restores it on import', async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const capturedBlobs: Blob[] = []
    URL.createObjectURL = vi.fn((blob: Blob | MediaSource) => {
      capturedBlobs.push(blob as Blob)
      return 'blob:mock-export'
    })

    const items = [createCanvasItem()]
    const groups = [createCanvasGroup()]
    const groupBranches = [createCanvasGroupBranch()]

    await exportCanvasFile(
      items,
      'provenance.mpcanvas',
      undefined,
      false,
      groups,
      null,
      groupBranches
    )

    expect(clickSpy).toHaveBeenCalledTimes(1)
    expect(capturedBlobs).toHaveLength(1)

    const exportedJson = JSON.parse(await readBlobAsText(capturedBlobs[0])) as {
      version: number
      storageMode?: string
      items: CanvasItem[]
      groups: CanvasGroup[]
      groupBranches: CanvasGroupBranch[]
    }

    expect(exportedJson.version).toBe(CANVAS_FILE_VERSION)
    expect(exportedJson.storageMode).toBe('embedded')
    expect(exportedJson.items[0].provenance).toEqual(items[0].provenance)
    expect(exportedJson.groups[0].provenance).toEqual(groups[0].provenance)
    expect(exportedJson.groupBranches[0]).toEqual(groupBranches[0])

    const file = {
      text: async () => JSON.stringify(exportedJson)
    } as File
    const imported = await importCanvasFile(file)

    expect(imported.items[0].provenance).toEqual(items[0].provenance)
    expect(imported.groups[0].provenance).toEqual(groups[0].provenance)
    expect(imported.groupBranches[0]).toEqual(groupBranches[0])
  })

  it('keeps default .mpcanvas exports limited to canvas data and embedded assets', async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const capturedBlobs: Blob[] = []
    URL.createObjectURL = vi.fn((blob: Blob | MediaSource) => {
      capturedBlobs.push(blob as Blob)
      return 'blob:ordinary-export'
    })

    localStorage.setItem('qapp.currentQAppKey', 'global-qapp')
    localStorage.setItem('qapp.currentQAppKey.canvas-share-test', 'canvas-qapp')

    await exportCanvasFile([createCanvasItem()], 'ordinary.mpcanvas', 'canvas-share-test')

    expect(clickSpy).toHaveBeenCalledTimes(1)
    expect(capturedBlobs).toHaveLength(1)

    const exportedJson = JSON.parse(await readBlobAsText(capturedBlobs[0])) as Record<
      string,
      unknown
    >

    expect(exportedJson.storageMode).toBe('embedded')
    expect(exportedJson.items).toBeDefined()
    expect(exportedJson).not.toHaveProperty('currentQAppKey')
    expect(exportedJson).not.toHaveProperty('qAppCache')
  })

  it('ignores legacy quick-app state during default .mpcanvas imports', async () => {
    const qAppSwitchEvents: string[] = []
    const handleQAppSwitch = (event: Event) => {
      qAppSwitchEvents.push((event as CustomEvent<{ qAppKey?: string }>).detail?.qAppKey || '')
    }
    window.addEventListener('qapp:switch', handleQAppSwitch)

    const legacyData = {
      magic: 'MAGICPOT_CANVAS',
      version: 7,
      createdAt: '2026-04-01T00:00:00.000Z',
      items: [createCanvasItem()],
      currentQAppKey: 'legacy-qapp',
      qAppCache: {
        'legacy-qapp': {
          cfg: { key: 'legacy-qapp' },
          workflow: {},
          formState: {}
        }
      }
    }

    try {
      const imported = await importCanvasFile({
        text: async () => JSON.stringify(legacyData)
      } as File)

      expect(imported.items).toHaveLength(1)
      expect(imported.qAppKey).toBeUndefined()
      expect(localStorage.getItem('qapp.currentQAppKey')).toBeNull()
      expect(qAppSwitchEvents).toEqual([])
    } finally {
      window.removeEventListener('qapp:switch', handleQAppSwitch)
    }
  })

  it('reuses the last Save As path for subsequent saves before falling back to the project mirror', async () => {
    const saveTargets: string[] = []
    const saveImageToPathSpy = vi.fn(async ({ outputPath, filename }) => {
      const fullPath = path.win32.join(outputPath, filename)
      saveTargets.push(fullPath)
      return { success: true, fullPath }
    })
    const writeTextFileSpy = vi.fn(async ({ outputPath, filename, content }) => ({
      success: true,
      fullPath: path.win32.join(outputPath, filename),
      content
    }))
    const showSaveDialogSpy = vi.fn(async () => ({
      canceled: false,
      filePath: 'C:\\exports\\hero-custom.mpcanvas'
    }))

    Object.defineProperty(window, 'path', {
      configurable: true,
      writable: true,
      value: {
        join: (...segments: string[]) => path.win32.join(...segments),
        basename: (targetPath: string) => path.win32.basename(targetPath),
        dirname: (targetPath: string) => path.win32.dirname(targetPath)
      } as unknown as Window['path']
    })

    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        svcDialog: {
          showSaveDialog: showSaveDialogSpy
        },
        svcFs: {
          saveImageToPath: saveImageToPathSpy,
          writeTextFile: writeTextFileSpy
        }
      } as unknown as Window['api']
    })

    localStorage.setItem('qapp.downloadDir', 'C:\\mock-project-root')

    const items = [createCanvasItem()]
    await exportCanvasFile(items, 'hero.mpcanvas', 'photoshop-save-test', true)
    await exportCanvasFile(items, 'hero.mpcanvas', 'photoshop-save-test', false)

    expect(localStorage.getItem('canvas.savePath.photoshop-save-test')).toBe(
      'C:\\exports\\hero-custom.mpcanvas'
    )
    expect(showSaveDialogSpy).toHaveBeenCalledTimes(1)
    expect(saveImageToPathSpy).toHaveBeenCalledTimes(2)
    expect(saveTargets).toEqual([
      'C:\\exports\\hero-custom.mpcanvas',
      'C:\\exports\\hero-custom.mpcanvas'
    ])
    expect(writeTextFileSpy).not.toHaveBeenCalled()
  })

  it('opens Save As instead of silently writing the project mirror when no document path is bound yet', async () => {
    const saveTargets: string[] = []
    const saveImageToPathSpy = vi.fn(async ({ outputPath, filename }) => {
      const fullPath = path.win32.join(outputPath, filename)
      saveTargets.push(fullPath)
      return { success: true, fullPath }
    })
    const writeTextFileSpy = vi.fn(async ({ outputPath, filename, content }) => ({
      success: true,
      fullPath: path.win32.join(outputPath, filename),
      content
    }))
    const showSaveDialogSpy = vi.fn(async () => ({
      canceled: false,
      filePath: 'C:\\exports\\fresh-save.mpcanvas'
    }))

    Object.defineProperty(window, 'path', {
      configurable: true,
      writable: true,
      value: {
        join: (...segments: string[]) => path.win32.join(...segments),
        basename: (targetPath: string) => path.win32.basename(targetPath),
        dirname: (targetPath: string) => path.win32.dirname(targetPath)
      } as unknown as Window['path']
    })

    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        svcDialog: {
          showSaveDialog: showSaveDialogSpy
        },
        svcFs: {
          saveImageToPath: saveImageToPathSpy,
          writeTextFile: writeTextFileSpy
        }
      } as unknown as Window['api']
    })

    localStorage.setItem('qapp.downloadDir', 'C:\\mock-project-root')

    const items = [createCanvasItem()]
    await exportCanvasFile(items, 'hero.mpcanvas', 'photoshop-first-save', false)

    expect(showSaveDialogSpy).toHaveBeenCalledTimes(1)
    expect(saveTargets).toEqual(['C:\\exports\\fresh-save.mpcanvas'])
    expect(writeTextFileSpy).not.toHaveBeenCalled()
    expect(localStorage.getItem('canvas.savePath.photoshop-first-save')).toBe(
      'C:\\exports\\fresh-save.mpcanvas'
    )
  })

  it('exports a standalone .mpcanvas file without overwriting the remembered save target', async () => {
    const saveTargets: string[] = []
    const saveImageToPathSpy = vi.fn(async ({ outputPath, filename }) => {
      const fullPath = path.win32.join(outputPath, filename)
      saveTargets.push(fullPath)
      return { success: true, fullPath }
    })
    const showSaveDialogSpy = vi.fn(async () => ({
      canceled: false,
      filePath: 'C:\\exports\\share-copy.mpcanvas'
    }))

    Object.defineProperty(window, 'path', {
      configurable: true,
      writable: true,
      value: {
        join: (...segments: string[]) => path.win32.join(...segments),
        basename: (targetPath: string) => path.win32.basename(targetPath),
        dirname: (targetPath: string) => path.win32.dirname(targetPath)
      } as unknown as Window['path']
    })

    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        svcDialog: {
          showSaveDialog: showSaveDialogSpy
        },
        svcFs: {
          saveImageToPath: saveImageToPathSpy,
          writeTextFile: vi.fn(async ({ outputPath, filename, content }) => ({
            success: true,
            fullPath: path.win32.join(outputPath, filename),
            content
          }))
        }
      } as unknown as Window['api']
    })

    localStorage.setItem(
      'canvas.savePath.photoshop-export-test',
      'C:\\work\\bound-document.mpcanvas'
    )

    await exportCanvasFileAsStandalone(
      [createCanvasItem()],
      'hero.mpcanvas',
      'photoshop-export-test'
    )

    expect(showSaveDialogSpy).toHaveBeenCalledTimes(1)
    expect(saveTargets).toEqual(['C:\\exports\\share-copy.mpcanvas'])
    expect(localStorage.getItem('canvas.savePath.photoshop-export-test')).toBe(
      'C:\\work\\bound-document.mpcanvas'
    )

    await exportCanvasFile([createCanvasItem()], 'hero.mpcanvas', 'photoshop-export-test', false)

    expect(saveTargets).toEqual([
      'C:\\exports\\share-copy.mpcanvas',
      'C:\\work\\bound-document.mpcanvas'
    ])
    expect(showSaveDialogSpy).toHaveBeenCalledTimes(1)
  })

  it('persists and restores blob-backed generated images', async () => {
    const blobPayload = new TextEncoder().encode('png-binary').buffer
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== 'blob:image-source') {
        return {
          ok: false,
          arrayBuffer: async () => new ArrayBuffer(0)
        } as Response
      }

      return {
        ok: true,
        arrayBuffer: async () => blobPayload.slice(0)
      } as Response
    })
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: fetchMock
    })

    URL.createObjectURL = vi.fn(() => 'blob:restored-image') as typeof URL.createObjectURL

    const items = [
      {
        id: 'image-blob-1',
        type: 'image',
        x: 24,
        y: 48,
        width: 320,
        height: 240,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        zIndex: 1,
        locked: false,
        src: 'blob:image-source',
        fileName: 'generated-image.png'
      } as CanvasItem
    ]

    await saveCanvasItems(items, 'blob-image-test')
    const restored = await loadCanvasItems('blob-image-test')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(restored.items).toHaveLength(1)
    expect(restored.items[0]).toMatchObject({
      id: 'image-blob-1',
      type: 'image',
      fileName: 'generated-image.png',
      src: 'blob:restored-image'
    })
  })

  it('persists generated images from Comfy metadata when the canvas blob URL is no longer readable', async () => {
    const comfyPayload = new TextEncoder().encode('comfy-output-binary')
    const fetchMock = vi.fn(async () => {
      return {
        ok: false,
        arrayBuffer: async () => new ArrayBuffer(0)
      } as Response
    })
    const getView = vi.fn(async () => ({ result: comfyPayload }))
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: fetchMock
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        svcComfy: {
          getView
        }
      } as unknown as Window['api']
    })
    URL.createObjectURL = vi.fn(() => 'blob:restored-comfy-image') as typeof URL.createObjectURL

    const items = [
      {
        id: 'image-comfy-1',
        type: 'image',
        x: 24,
        y: 48,
        width: 320,
        height: 240,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        zIndex: 1,
        locked: false,
        src: 'blob:revoked-image-source',
        fileName: 'generated-image.png',
        fileItem: {
          filename: 'generated-image.png',
          type: 'output'
        }
      } as CanvasItem
    ]

    await saveCanvasItems(items, 'comfy-fallback-test')
    const restored = await loadCanvasItems('comfy-fallback-test')

    expect(fetchMock).toHaveBeenCalled()
    expect(getView).toHaveBeenCalledWith({
      filename: 'generated-image.png',
      type: 'output'
    })
    expect(restored.items).toHaveLength(1)
    expect(restored.items[0]).toMatchObject({
      id: 'image-comfy-1',
      type: 'image',
      src: 'blob:restored-comfy-image'
    })
  })

  it('persists qApp sourceFile data when the temporary blob URL is no longer readable', async () => {
    const sourceFile = new Blob([new TextEncoder().encode('qapp-source-binary')], {
      type: 'image/png'
    })
    const fetchMock = vi.fn(async () => {
      return {
        ok: false,
        arrayBuffer: async () => new ArrayBuffer(0)
      } as Response
    })
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: fetchMock
    })
    URL.createObjectURL = vi.fn(() => 'blob:restored-qapp-source') as typeof URL.createObjectURL

    const items = [
      {
        id: 'image-qapp-source-1',
        type: 'image',
        x: 24,
        y: 48,
        width: 320,
        height: 240,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        zIndex: 1,
        locked: false,
        src: 'blob:revoked-qapp-source',
        fileName: 'qapp-source.png',
        sourceFile
      } as CanvasItem
    ]

    await saveCanvasItems(items, 'qapp-source-file-test')
    const restored = await loadCanvasItems('qapp-source-file-test')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(restored.items).toHaveLength(1)
    expect(restored.items[0]).toMatchObject({
      id: 'image-qapp-source-1',
      type: 'image',
      src: 'blob:restored-qapp-source'
    })
  })

  it('persists media sourceFile data when a video object URL is no longer readable', async () => {
    const sourceFile = new Blob([new TextEncoder().encode('video-source-binary')], {
      type: 'video/mp4'
    })
    const fetchMock = vi.fn(async () => {
      return {
        ok: false,
        arrayBuffer: async () => new ArrayBuffer(0)
      } as Response
    })
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: fetchMock
    })
    URL.createObjectURL = vi.fn(() => 'blob:restored-video-source') as typeof URL.createObjectURL

    const items = [
      {
        id: 'video-source-1',
        type: 'video',
        x: 24,
        y: 48,
        width: 320,
        height: 180,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        zIndex: 1,
        locked: false,
        src: 'blob:revoked-video-source',
        fileName: 'clip.mp4',
        sourceFile,
        playing: false,
        muted: true,
        volume: 0.5
      } as CanvasItem
    ]

    await saveCanvasItems(items, 'media-source-file-test')
    const restored = await loadCanvasItems('media-source-file-test')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(restored.items).toHaveLength(1)
    expect(restored.items[0]).toMatchObject({
      id: 'video-source-1',
      type: 'video',
      src: 'blob:restored-video-source'
    })
  })

  it('does not replace a valid snapshot when a blob-backed image cannot persist binary data', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchMock = vi.fn(async () => {
      return {
        ok: false,
        arrayBuffer: async () => new ArrayBuffer(0)
      } as Response
    })
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: fetchMock
    })
    URL.createObjectURL = vi.fn(() => 'blob:restored-stable-image') as typeof URL.createObjectURL

    const stableItem = {
      id: 'image-stable-1',
      type: 'image',
      x: 24,
      y: 48,
      width: 320,
      height: 240,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      zIndex: 1,
      locked: false,
      src: 'blob:stable-source',
      fileName: 'stable.png',
      sourceFile: new Blob([new TextEncoder().encode('stable-binary')], { type: 'image/png' })
    } as CanvasItem
    await saveCanvasItems([stableItem], 'failed-save-consistency-test')

    const brokenItem = {
      ...stableItem,
      src: 'blob:missing-source',
      fileName: 'missing.png',
      sourceFile: undefined
    } as CanvasItem
    await saveCanvasItems([brokenItem], 'failed-save-consistency-test')
    const restored = await loadCanvasItems('failed-save-consistency-test')

    expect(errorSpy).toHaveBeenCalled()
    expect(restored.items).toHaveLength(1)
    expect(restored.items[0]).toMatchObject({
      id: 'image-stable-1',
      type: 'image',
      fileName: 'stable.png',
      src: 'blob:restored-stable-image'
    })
  })

  it('keeps blob payloads isolated between canvas store keys', async () => {
    let restoredUrlIndex = 0
    URL.createObjectURL = vi.fn(
      () => `blob:restored-isolated-${++restoredUrlIndex}`
    ) as typeof URL.createObjectURL

    const itemA = {
      id: 'image-canvas-a',
      type: 'image',
      x: 24,
      y: 48,
      width: 320,
      height: 240,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      zIndex: 1,
      locked: false,
      src: 'blob:canvas-a-source',
      fileName: 'canvas-a.png',
      sourceFile: new Blob([new TextEncoder().encode('canvas-a-binary')], {
        type: 'image/png'
      })
    } as CanvasItem
    const itemB = {
      ...itemA,
      id: 'image-canvas-b',
      src: 'blob:canvas-b-source',
      fileName: 'canvas-b.png',
      sourceFile: new Blob([new TextEncoder().encode('canvas-b-binary')], {
        type: 'image/png'
      })
    } as CanvasItem

    await saveCanvasItems([itemA], 'canvas-a')
    await saveCanvasItems([itemB], 'canvas-b')

    const restoredA = await loadCanvasItems('canvas-a')
    const restoredB = await loadCanvasItems('canvas-b')

    expect(restoredA.items).toHaveLength(1)
    expect(restoredA.items[0]).toMatchObject({ id: 'image-canvas-a', type: 'image' })
    expect(restoredB.items).toHaveLength(1)
    expect(restoredB.items[0]).toMatchObject({ id: 'image-canvas-b', type: 'image' })
  })

  it('clears only the current canvas blob payloads', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:restored-after-clear') as typeof URL.createObjectURL

    const itemA = {
      id: 'image-clear-a',
      type: 'image',
      x: 24,
      y: 48,
      width: 320,
      height: 240,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      zIndex: 1,
      locked: false,
      src: 'blob:clear-a-source',
      fileName: 'clear-a.png',
      sourceFile: new Blob([new TextEncoder().encode('clear-a-binary')], { type: 'image/png' })
    } as CanvasItem
    const itemB = {
      ...itemA,
      id: 'image-clear-b',
      src: 'blob:clear-b-source',
      fileName: 'clear-b.png',
      sourceFile: new Blob([new TextEncoder().encode('clear-b-binary')], { type: 'image/png' })
    } as CanvasItem

    await saveCanvasItems([itemA], 'clear-canvas-a')
    await saveCanvasItems([itemB], 'clear-canvas-b')
    await clearCanvasItems('clear-canvas-a')

    const restoredA = await loadCanvasItems('clear-canvas-a')
    const restoredB = await loadCanvasItems('clear-canvas-b')

    expect(restoredA.items).toEqual([])
    expect(restoredB.items).toHaveLength(1)
    expect(restoredB.items[0]).toMatchObject({ id: 'image-clear-b', type: 'image' })
  })

  it('restores canvas items from the project canvas file when a new dev origin has an empty IndexedDB', async () => {
    const blobPayload = new TextEncoder().encode('mirror-image-binary').buffer
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== 'blob:mirror-image-source') {
        return {
          ok: false,
          arrayBuffer: async () => new ArrayBuffer(0)
        } as Response
      }

      return {
        ok: true,
        arrayBuffer: async () => blobPayload.slice(0)
      } as Response
    })
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: fetchMock
    })

    const textFiles = new Map<string, string>()
    const binaryFiles = new Map<string, Uint8Array>()
    const userDataDir = 'C:\\mock-user-data'

    Object.defineProperty(window, 'path', {
      configurable: true,
      writable: true,
      value: {
        join: (...segments: string[]) => path.win32.join(...segments),
        basename: (targetPath: string) => path.win32.basename(targetPath),
        dirname: (targetPath: string) => path.win32.dirname(targetPath)
      } as unknown as Window['path']
    })

    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        svcState: {
          getUserDataDirectoryState: vi.fn(async () => ({
            state: {
              currentPath: userDataDir,
              defaultPath: userDataDir,
              isCustom: false,
              source: 'default'
            }
          }))
        },
        svcFs: {
          writeTextFile: vi.fn(async ({ outputPath, filename, content }) => {
            const fullPath = path.win32.join(outputPath, filename)
            textFiles.set(fullPath, content)
            return { success: true, fullPath }
          }),
          readTextFile: vi.fn(async ({ fullPath }) => {
            const content = textFiles.get(fullPath)
            if (content === undefined) {
              throw new Error(`File not found: ${fullPath}`)
            }
            return {
              content,
              filename: path.win32.basename(fullPath)
            }
          }),
          saveImageToPath: vi.fn(async ({ image, outputPath, filename }) => {
            const fullPath = path.win32.join(outputPath, filename)
            binaryFiles.set(fullPath, new Uint8Array(image))
            return { success: true, fullPath }
          }),
          readFileFromPath: vi.fn(async ({ fullPath }) => {
            const data = binaryFiles.get(fullPath)
            if (!data) {
              throw new Error(`File not found: ${fullPath}`)
            }
            return {
              data,
              filename: path.win32.basename(fullPath)
            }
          })
        }
      } as unknown as Window['api']
    })

    const items = [
      {
        id: 'image-blob-mirror-1',
        type: 'image',
        x: 24,
        y: 48,
        width: 320,
        height: 240,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        zIndex: 1,
        locked: false,
        src: 'blob:mirror-image-source',
        fileName: 'generated-image.png'
      } as CanvasItem
    ]

    localStorage.setItem('qapp.currentQAppKey', 'global-qapp')
    localStorage.setItem('qapp.currentQAppKey.mirror-fallback-test', 'project-qapp')

    await saveCanvasItems(items, 'mirror-fallback-test')

    const projectCanvasPath = path.win32.join(
      userDataDir,
      'renderer-state',
      'project-canvas',
      '.mirror-fallback-test__mirror-fallback-test',
      'project.mpcanvas'
    )
    const projectCanvasJson = JSON.parse(textFiles.get(projectCanvasPath) || '{}') as {
      storageMode?: string
      blobs?: Record<string, unknown>
      items?: Array<{ src?: string }>
      currentQAppKey?: string
      qAppCache?: Record<string, unknown>
    }
    expect(projectCanvasJson.storageMode).toBe('project')
    expect(projectCanvasJson.blobs).toBeUndefined()
    expect(projectCanvasJson.currentQAppKey).toBeUndefined()
    expect(projectCanvasJson.qAppCache).toBeUndefined()
    expect(projectCanvasJson.items?.[0]?.src).toBe(
      'assets/images/image-blob-mirror-1__generated-image.png'
    )

    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      writable: true,
      value: createFakeIndexedDB()
    })

    const restored = await loadCanvasItems('mirror-fallback-test')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(restored.items).toHaveLength(1)
    expect(restored.items[0]).toMatchObject({
      id: 'image-blob-mirror-1',
      type: 'image',
      fileName: 'generated-image.png',
      src: 'local-media:///C:/mock-user-data/renderer-state/project-canvas/.mirror-fallback-test__mirror-fallback-test/assets/images/image-blob-mirror-1__generated-image.png'
    })
  })

  it('does not rewrite project canvas items to missing asset refs when binary staging fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchMock = vi.fn(async () => {
      return {
        ok: false,
        arrayBuffer: async () => new ArrayBuffer(0),
        blob: async () => new Blob()
      } as Response
    })
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: fetchMock
    })

    const textFiles = new Map<string, string>()
    const binaryFiles = new Map<string, Uint8Array>()
    const userDataDir = 'C:\\mock-user-data-unresolved'

    Object.defineProperty(window, 'path', {
      configurable: true,
      writable: true,
      value: {
        join: (...segments: string[]) => path.win32.join(...segments),
        basename: (targetPath: string) => path.win32.basename(targetPath),
        dirname: (targetPath: string) => path.win32.dirname(targetPath)
      } as unknown as Window['path']
    })

    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        svcState: {
          getUserDataDirectoryState: vi.fn(async () => ({
            state: {
              currentPath: userDataDir,
              defaultPath: userDataDir,
              isCustom: false,
              source: 'default'
            }
          }))
        },
        svcFs: {
          writeTextFile: vi.fn(async ({ outputPath, filename, content }) => {
            const fullPath = path.win32.join(outputPath, filename)
            textFiles.set(fullPath, content)
            return { success: true, fullPath }
          }),
          saveImageToPath: vi.fn(async ({ image, outputPath, filename }) => {
            const fullPath = path.win32.join(outputPath, filename)
            binaryFiles.set(fullPath, new Uint8Array(image))
            return { success: true, fullPath }
          })
        }
      } as unknown as Window['api']
    })

    const items = [
      {
        id: 'image-unresolved-1',
        type: 'image',
        x: 24,
        y: 48,
        width: 320,
        height: 240,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        zIndex: 1,
        locked: false,
        src: 'blob:unreadable-source',
        fileName: 'missing-image.png'
      } as CanvasItem
    ]

    await saveCanvasItems(items, 'unresolved-project-asset-test')

    const projectCanvasPath = path.win32.join(
      userDataDir,
      'renderer-state',
      'project-canvas',
      '.unresolved-project-asset-test__unresolved-project-asset-test',
      'project.mpcanvas'
    )

    expect(binaryFiles.size).toBe(0)
    expect(textFiles.has(projectCanvasPath)).toBe(false)
    expect(errorSpy).toHaveBeenCalled()
  })

  it('normalizes legacy relative project asset refs from IndexedDB into local-media URLs', async () => {
    const userDataDir = 'C:\\mock-user-data-legacy'

    Object.defineProperty(window, 'path', {
      configurable: true,
      writable: true,
      value: {
        join: (...segments: string[]) => path.win32.join(...segments),
        basename: (targetPath: string) => path.win32.basename(targetPath),
        dirname: (targetPath: string) => path.win32.dirname(targetPath)
      } as unknown as Window['path']
    })

    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        svcState: {
          getUserDataDirectoryState: vi.fn(async () => ({
            state: {
              currentPath: userDataDir,
              defaultPath: userDataDir,
              isCustom: false,
              source: 'default'
            }
          }))
        }
      } as unknown as Window['api']
    })

    await seedCanvasMetadataStore('legacy-relative-idb-test', {
      items: [
        {
          id: 'image-legacy-1',
          type: 'image',
          x: 32,
          y: 48,
          width: 240,
          height: 180,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          zIndex: 1,
          locked: false,
          src: 'assets/images/image-legacy-1__legacy.png',
          fileName: 'legacy.png',
          sourceWidth: 240,
          sourceHeight: 180
        }
      ]
    })

    const restored = await loadCanvasItems('legacy-relative-idb-test')

    expect(restored.items).toHaveLength(1)
    expect(restored.items[0]).toMatchObject({
      id: 'image-legacy-1',
      type: 'image',
      fileName: 'legacy.png',
      src: 'local-media:///C:/mock-user-data-legacy/renderer-state/project-canvas/.legacy-relative-idb-test__legacy-relative-idb-test/assets/images/image-legacy-1__legacy.png'
    })
  })

  it('loads existing project canvas files from the legacy unhidden project root', async () => {
    const userDataDir = 'C:\\mock-user-data-legacy-root'
    const legacyProjectRootDir = path.win32.join(
      userDataDir,
      'renderer-state',
      'project-canvas',
      'legacy-root-test__legacy-root-test'
    )
    const textFiles = new Map<string, string>([
      [
        path.win32.join(legacyProjectRootDir, 'project.mpcanvas'),
        JSON.stringify({
          magic: 'MAGICPOT_CANVAS',
          version: CANVAS_FILE_VERSION,
          createdAt: '2026-05-21T00:00:00.000Z',
          storageMode: 'project',
          items: [
            {
              id: 'text-legacy-root',
              type: 'text',
              x: 10,
              y: 20,
              width: 120,
              height: 48,
              rotation: 0,
              scaleX: 1,
              scaleY: 1,
              zIndex: 1,
              locked: false,
              text: 'legacy root'
            }
          ]
        })
      ]
    ])

    Object.defineProperty(window, 'path', {
      configurable: true,
      writable: true,
      value: {
        join: (...segments: string[]) => path.win32.join(...segments),
        basename: (targetPath: string) => path.win32.basename(targetPath),
        dirname: (targetPath: string) => path.win32.dirname(targetPath)
      } as unknown as Window['path']
    })

    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        svcState: {
          getUserDataDirectoryState: vi.fn(async () => ({
            state: {
              currentPath: userDataDir,
              defaultPath: userDataDir,
              isCustom: false,
              source: 'default'
            }
          }))
        },
        svcFs: {
          readTextFile: vi.fn(async ({ fullPath }) => {
            const content = textFiles.get(fullPath)
            if (content === undefined) {
              throw new Error(`File not found: ${fullPath}`)
            }
            return {
              content,
              filename: path.win32.basename(fullPath)
            }
          })
        }
      } as unknown as Window['api']
    })

    const restored = await loadCanvasItems('legacy-root-test')

    expect(restored.items).toHaveLength(1)
    expect(restored.items[0]).toMatchObject({
      id: 'text-legacy-root',
      type: 'text',
      text: 'legacy root'
    })
  })

  it('flattens cropped project cache images using the original raster format', async () => {
    const blobPayload = new TextEncoder().encode('crop-source-binary').buffer
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== 'blob:crop-image-source') {
        return {
          ok: false,
          arrayBuffer: async () => new ArrayBuffer(0)
        } as Response
      }

      return {
        ok: true,
        arrayBuffer: async () => blobPayload.slice(0)
      } as Response
    })
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: fetchMock
    })

    const drawImageMock = vi.fn()
    const toBlobMock = vi.fn((callback: BlobCallback, requestedType?: string) => {
      callback(new Blob([new Uint8Array([1, 2, 3, 4])], { type: requestedType || 'image/png' }))
    })
    const originalCreateElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation(((
      tagName: string,
      options?: ElementCreationOptions
    ) => {
      if (tagName.toLowerCase() === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext: vi.fn(() => ({ drawImage: drawImageMock })),
          toBlob: toBlobMock
        } as unknown as HTMLCanvasElement
      }

      return originalCreateElement(tagName, options)
    }) as typeof document.createElement)

    class MockImage {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      naturalWidth = 800
      naturalHeight = 600

      set src(_value: string) {
        setTimeout(() => this.onload?.(), 0)
      }
    }

    Object.defineProperty(globalThis, 'Image', {
      configurable: true,
      writable: true,
      value: MockImage
    })

    const textFiles = new Map<string, string>()
    const binaryFiles = new Map<string, Uint8Array>()
    const userDataDir = 'C:\\mock-user-data-crop'

    Object.defineProperty(window, 'path', {
      configurable: true,
      writable: true,
      value: {
        join: (...segments: string[]) => path.win32.join(...segments),
        basename: (targetPath: string) => path.win32.basename(targetPath),
        dirname: (targetPath: string) => path.win32.dirname(targetPath)
      } as unknown as Window['path']
    })

    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        svcState: {
          getUserDataDirectoryState: vi.fn(async () => ({
            state: {
              currentPath: userDataDir,
              defaultPath: userDataDir,
              isCustom: false,
              source: 'default'
            }
          }))
        },
        svcFs: {
          listFilesInFolder: vi.fn(async ({ folderPath }) => ({
            files: Array.from(binaryFiles.keys())
              .filter((fullPath) => fullPath.startsWith(folderPath))
              .map((fullPath, index) => ({
                filename: path.win32.basename(fullPath),
                fullPath,
                lastModifiedMs: 20_000 + index
              }))
          })),
          writeTextFile: vi.fn(async ({ outputPath, filename, content }) => {
            const fullPath = path.win32.join(outputPath, filename)
            textFiles.set(fullPath, content)
            return { success: true, fullPath }
          }),
          readTextFile: vi.fn(async ({ fullPath }) => {
            const content = textFiles.get(fullPath)
            if (content === undefined) {
              throw new Error(`File not found: ${fullPath}`)
            }
            return {
              content,
              filename: path.win32.basename(fullPath)
            }
          }),
          saveImageToPath: vi.fn(async ({ image, outputPath, filename }) => {
            const fullPath = path.win32.join(outputPath, filename)
            binaryFiles.set(fullPath, new Uint8Array(image))
            return { success: true, fullPath }
          }),
          readFileFromPath: vi.fn(async ({ fullPath }) => {
            const data = binaryFiles.get(fullPath)
            if (!data) {
              throw new Error(`File not found: ${fullPath}`)
            }
            return {
              data,
              filename: path.win32.basename(fullPath)
            }
          })
        }
      } as unknown as Window['api']
    })

    await saveCanvasItems(
      [
        {
          id: 'image-crop-1',
          type: 'image',
          x: 12,
          y: 16,
          width: 320,
          height: 180,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          zIndex: 1,
          locked: false,
          src: 'blob:crop-image-source',
          fileName: 'photo.jpg',
          sourceWidth: 800,
          sourceHeight: 600,
          crop: {
            x: 120,
            y: 80,
            width: 320,
            height: 180
          }
        } as CanvasItem
      ],
      'project-crop-cache-test'
    )

    const projectCanvasPath = path.win32.join(
      userDataDir,
      'renderer-state',
      'project-canvas',
      '.project-crop-cache-test__project-crop-cache-test',
      'project.mpcanvas'
    )
    const projectCanvasJson = JSON.parse(textFiles.get(projectCanvasPath) || '{}') as {
      items?: Array<{
        src?: string
        crop?: unknown
        sourceWidth?: number
        sourceHeight?: number
      }>
    }

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(drawImageMock).toHaveBeenCalledWith(expect.anything(), 120, 80, 320, 180, 0, 0, 320, 180)
    expect(toBlobMock).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg')
    expect(projectCanvasJson.items?.[0]).toMatchObject({
      src: 'assets/images/image-crop-1__photo.jpg',
      sourceWidth: 320,
      sourceHeight: 180
    })
    expect(projectCanvasJson.items?.[0]?.crop).toBeUndefined()
    expect(
      binaryFiles.has(
        path.win32.join(
          userDataDir,
          'renderer-state',
          'project-canvas',
          '.project-crop-cache-test__project-crop-cache-test',
          'assets',
          'images',
          'image-crop-1__photo.jpg'
        )
      )
    ).toBe(true)

    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      writable: true,
      value: createFakeIndexedDB()
    })

    const restored = await loadCanvasItems('project-crop-cache-test')

    expect(restored.items[0]).toMatchObject({
      id: 'image-crop-1',
      type: 'image',
      src: 'local-media:///C:/mock-user-data-crop/renderer-state/project-canvas/.project-crop-cache-test__project-crop-cache-test/assets/images/image-crop-1__photo.jpg',
      sourceWidth: 320,
      sourceHeight: 180
    })
    expect(restored.items[0]).not.toHaveProperty('crop')
  })

  it('logs missing project assets without showing UI prompts when the lightweight project file is moved alone', async () => {
    const blobPayload = new TextEncoder().encode('project-only-image-binary').buffer
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== 'blob:project-only-image-source') {
        return {
          ok: false,
          arrayBuffer: async () => new ArrayBuffer(0)
        } as Response
      }

      return {
        ok: true,
        arrayBuffer: async () => blobPayload.slice(0)
      } as Response
    })
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: fetchMock
    })

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const textFiles = new Map<string, string>()
    const binaryFiles = new Map<string, Uint8Array>()
    const userDataDir = 'C:\\mock-user-data-missing'

    Object.defineProperty(window, 'path', {
      configurable: true,
      writable: true,
      value: {
        join: (...segments: string[]) => path.win32.join(...segments),
        basename: (targetPath: string) => path.win32.basename(targetPath),
        dirname: (targetPath: string) => path.win32.dirname(targetPath)
      } as unknown as Window['path']
    })

    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        svcState: {
          getUserDataDirectoryState: vi.fn(async () => ({
            state: {
              currentPath: userDataDir,
              defaultPath: userDataDir,
              isCustom: false,
              source: 'default'
            }
          }))
        },
        svcFs: {
          listFilesInFolder: vi.fn(async ({ folderPath }) => ({
            files: Array.from(binaryFiles.keys())
              .filter((fullPath) => fullPath.startsWith(folderPath))
              .map((fullPath, index) => ({
                filename: path.win32.basename(fullPath),
                fullPath,
                lastModifiedMs: 10_000 + index
              }))
          })),
          writeTextFile: vi.fn(async ({ outputPath, filename, content }) => {
            const fullPath = path.win32.join(outputPath, filename)
            textFiles.set(fullPath, content)
            return { success: true, fullPath }
          }),
          readTextFile: vi.fn(async ({ fullPath }) => {
            const content = textFiles.get(fullPath)
            if (content === undefined) {
              throw new Error(`File not found: ${fullPath}`)
            }
            return {
              content,
              filename: path.win32.basename(fullPath)
            }
          }),
          saveImageToPath: vi.fn(async ({ image, outputPath, filename }) => {
            const fullPath = path.win32.join(outputPath, filename)
            binaryFiles.set(fullPath, new Uint8Array(image))
            return { success: true, fullPath }
          }),
          readFileFromPath: vi.fn(async ({ fullPath }) => {
            const data = binaryFiles.get(fullPath)
            if (!data) {
              throw new Error(`File not found: ${fullPath}`)
            }
            return {
              data,
              filename: path.win32.basename(fullPath)
            }
          })
        }
      } as unknown as Window['api']
    })

    await saveCanvasItems(
      [
        {
          id: 'image-project-missing-1',
          type: 'image',
          x: 12,
          y: 16,
          width: 200,
          height: 160,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          zIndex: 1,
          locked: false,
          src: 'blob:project-only-image-source',
          fileName: 'missing-image.png'
        } as CanvasItem
      ],
      'project-missing-test'
    )

    binaryFiles.clear()
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      writable: true,
      value: createFakeIndexedDB()
    })

    const restored = await loadCanvasItems('project-missing-test')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(restored.items).toHaveLength(1)
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[Canvas Storage] Project asset missing:',
      'c:/mock-user-data-missing/renderer-state/project-canvas/.project-missing-test__project-missing-test/assets/images/image-project-missing-1__missing-image.png'
    )
  })

  it('normalizes IndexedDB load failures when the browser does not expose an error object', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      writable: true,
      value: createFailingIndexedDBOpen()
    })

    const restored = await loadCanvasItems('open-failure-test')

    expect(restored).toEqual({ items: [], groups: [], groupBranches: [], figmaBinding: null })
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[Canvas Storage] 加载失败:',
      expect.objectContaining({
        message: expect.stringContaining('IndexedDB open failed.')
      })
    )
  })

  it('does not restore another project canvas file when the current project id has no local state', async () => {
    const blobPayload = new TextEncoder().encode('latest-mirror-image-binary').buffer
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== 'blob:latest-mirror-image-source') {
        return {
          ok: false,
          arrayBuffer: async () => new ArrayBuffer(0)
        } as Response
      }

      return {
        ok: true,
        arrayBuffer: async () => blobPayload.slice(0)
      } as Response
    })
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: fetchMock
    })

    const textFiles = new Map<string, string>()
    const binaryFiles = new Map<string, Uint8Array>()
    const userDataDir = 'C:\\mock-user-data-latest'
    const projectRootDir = path.win32.join(userDataDir, 'renderer-state', 'project-canvas')

    Object.defineProperty(window, 'path', {
      configurable: true,
      writable: true,
      value: {
        join: (...segments: string[]) => path.win32.join(...segments),
        basename: (targetPath: string) => path.win32.basename(targetPath),
        dirname: (targetPath: string) => path.win32.dirname(targetPath)
      } as unknown as Window['path']
    })

    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        svcState: {
          getUserDataDirectoryState: vi.fn(async () => ({
            state: {
              currentPath: userDataDir,
              defaultPath: userDataDir,
              isCustom: false,
              source: 'default'
            }
          }))
        },
        svcFs: {
          listFilesInFolder: vi.fn(async ({ folderPath }) => ({
            files:
              folderPath === projectRootDir
                ? Array.from(textFiles.keys())
                    .filter(
                      (fullPath) =>
                        fullPath.startsWith(projectRootDir) && fullPath.endsWith('.mpcanvas')
                    )
                    .map((fullPath, index) => ({
                      filename: path.win32.basename(fullPath),
                      fullPath,
                      lastModifiedMs: 1_000 + index
                    }))
                : Array.from(binaryFiles.keys())
                    .filter((fullPath) => fullPath.startsWith(folderPath))
                    .map((fullPath, index) => ({
                      filename: path.win32.basename(fullPath),
                      fullPath,
                      lastModifiedMs: 2_000 + index
                    }))
          })),
          writeTextFile: vi.fn(async ({ outputPath, filename, content }) => {
            const fullPath = path.win32.join(outputPath, filename)
            textFiles.set(fullPath, content)
            return { success: true, fullPath }
          }),
          readTextFile: vi.fn(async ({ fullPath }) => {
            const content = textFiles.get(fullPath)
            if (content === undefined) {
              throw new Error(`File not found: ${fullPath}`)
            }
            return {
              content,
              filename: path.win32.basename(fullPath)
            }
          }),
          saveImageToPath: vi.fn(async ({ image, outputPath, filename }) => {
            const fullPath = path.win32.join(outputPath, filename)
            binaryFiles.set(fullPath, new Uint8Array(image))
            return { success: true, fullPath }
          }),
          readFileFromPath: vi.fn(async ({ fullPath }) => {
            const data = binaryFiles.get(fullPath)
            if (!data) {
              throw new Error(`File not found: ${fullPath}`)
            }
            return {
              data,
              filename: path.win32.basename(fullPath)
            }
          })
        }
      } as unknown as Window['api']
    })

    const items = [
      {
        id: 'image-blob-latest-1',
        type: 'image',
        x: 24,
        y: 48,
        width: 320,
        height: 240,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        zIndex: 1,
        locked: false,
        src: 'blob:latest-mirror-image-source',
        fileName: 'latest-generated-image.png'
      } as CanvasItem
    ]

    await saveCanvasItems(items, 'previous-project-id')
    fetchMock.mockClear()

    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      writable: true,
      value: createFakeIndexedDB()
    })

    const restored = await loadCanvasItems('current-empty-project-id')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(restored).toEqual({
      items: [],
      groups: [],
      groupBranches: [],
      figmaBinding: null
    })
  })

  it('persists and restores blob-backed model sources with textures', async () => {
    const blobPayloads = new Map<string, ArrayBuffer>([
      ['blob:model-source', new TextEncoder().encode('glb-binary').buffer],
      ['blob:texture-diffuse', new TextEncoder().encode('diffuse-bytes').buffer],
      ['blob:texture-normal', new TextEncoder().encode('normal-bytes').buffer]
    ])
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const payload = blobPayloads.get(String(input))
      if (!payload) {
        return {
          ok: false,
          arrayBuffer: async () => new ArrayBuffer(0)
        } as Response
      }

      return {
        ok: true,
        arrayBuffer: async () => payload.slice(0)
      } as Response
    })
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: fetchMock
    })

    let restoredObjectUrlIndex = 0
    URL.createObjectURL = vi.fn(
      () => `blob:restored-${++restoredObjectUrlIndex}`
    ) as typeof URL.createObjectURL

    const items = [
      {
        id: 'model-blob-1',
        type: 'model3d',
        x: 24,
        y: 48,
        width: 320,
        height: 240,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        zIndex: 1,
        locked: false,
        src: 'blob:model-source',
        fileName: 'model.glb',
        textures: {
          'diffuse.png': 'blob:texture-diffuse',
          'normal.png': 'blob:texture-normal'
        }
      } as CanvasItem
    ]

    await saveCanvasItems(items, 'blob-model-test')
    const restored = await loadCanvasItems('blob-model-test')

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(restored.items).toHaveLength(1)
    expect(restored.items[0]).toMatchObject({
      id: 'model-blob-1',
      type: 'model3d',
      fileName: 'model.glb',
      src: 'blob:restored-1',
      textures: {
        'diffuse.png': 'blob:restored-2',
        'normal.png': 'blob:restored-3'
      }
    })
  })

  it('keeps older .mpcanvas files without provenance metadata compatible on import', async () => {
    const legacyData = {
      magic: 'MAGICPOT_CANVAS',
      version: 3,
      createdAt: '2026-03-28T06:45:00.000Z',
      items: [
        {
          id: 'text-legacy',
          type: 'text',
          x: 24,
          y: 32,
          width: 180,
          height: 60,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          zIndex: 1,
          locked: false,
          text: 'Legacy canvas',
          fontSize: 16,
          fontFamily: 'IBM Plex Sans',
          fill: '#222222'
        }
      ],
      groups: [
        {
          id: 'group-legacy',
          name: 'Legacy group',
          itemIds: ['text-legacy'],
          createdAt: '2026-03-28T06:45:00.000Z'
        }
      ]
    }

    const file = {
      text: async () => JSON.stringify(legacyData)
    } as File
    const imported = await importCanvasFile(file)

    expect(imported.items).toHaveLength(1)
    expect(imported.groups).toHaveLength(1)
    expect(imported.items[0].provenance).toBeUndefined()
    expect(imported.groups[0].provenance).toBeUndefined()
  })
})
