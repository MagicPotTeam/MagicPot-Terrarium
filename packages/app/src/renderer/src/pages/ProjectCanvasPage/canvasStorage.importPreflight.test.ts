import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { importCanvasFile } from './canvasStorage'
import { parseCanvasImportText, CANVAS_IMPORT_PREFLIGHT_LIMITS as limits } from './canvasImportPreflight'
import { restoreGlobalQAppCache } from '../QuickAppPage/components/QAppContext'

vi.mock('../QuickAppPage/components/QAppContext', () => ({ restoreGlobalQAppCache: vi.fn() }))
vi.mock('../ChatPage/chatPageShared', () => ({
  getDownloadFileNameFromUrl: vi.fn(), normalizeLocalMediaUrl: (value: string) => value
}))

const message = 'Invalid or oversized MagicPot canvas import'
const canvasId = 'synthetic-import-target'
const textItem = () => ({ id: 'synthetic-text', type: 'text', text: 'Synthetic only', x: 0, y: 0,
  width: 100, height: 30, rotation: 0, scaleX: 1, scaleY: 1, zIndex: 0, locked: false,
  fontSize: 14, fontFamily: 'sans-serif', fill: '#111' })
const payload = () => ({ magic: 'MAGICPOT_CANVAS', version: 8, createdAt: 'synthetic', items: [textItem()] })
const asset = (base64 = 'AQ==') => ({ base64, mimeType: 'application/octet-stream' })
const createUrl = vi.fn<(...args: unknown[]) => string>()
const revokeUrl = vi.fn(), bridge = vi.fn(), dirname = vi.fn(), fetchBoundary = vi.fn()
const listFiles = vi.fn(), nativeRead = vi.fn(), nativeWrite = vi.fn()
const restoreQapp = vi.mocked(restoreGlobalQAppCache)
const databaseWrite = vi.fn(), databaseOpen = vi.fn(), databaseClose = vi.fn()
let undo: Array<() => void>, legacyPathRead: ReturnType<typeof vi.fn<() => string>>, decode: ReturnType<typeof vi.spyOn>
let originalAtob: typeof atob

function replace(object: object, key: string, value: unknown) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key)
  Object.defineProperty(object, key, { configurable: true, writable: true, value })
  undo.push(() => descriptor ? Object.defineProperty(object, key, descriptor) : Reflect.deleteProperty(object, key))
}
function syntheticFile(value: unknown, size?: unknown) {
  const read = vi.fn(async () => typeof value === 'string' ? value : JSON.stringify(value))
  const file = { text: read, size } as unknown as File
  Object.defineProperty(file, 'path', { configurable: true, get: legacyPathRead })
  return { file, read }
}
function fakeDatabase() {
  // Compatibility seam only, not the staged transaction MODEL used by the successor fixture.
  const store = { put: databaseWrite, add: (value: unknown, key: string) => {
    databaseWrite(value, key)
    return {}
  } }
  const db = { objectStoreNames: { contains: () => true }, close: databaseClose,
    transaction: () => {
      const tx: { objectStore: () => typeof store; oncomplete?: () => void; onerror?: () => void } = { objectStore: () => store }
      queueMicrotask(() => tx.oncomplete?.())
      return tx
    } }
  const request: { result: typeof db; onsuccess?: () => void; onerror?: () => void } = { result: db }
  queueMicrotask(() => request.onsuccess?.())
  return request
}
function expectNoRestorationEffects() {
  expect(legacyPathRead).not.toHaveBeenCalled(); expect(bridge).not.toHaveBeenCalled()
  expect(dirname).not.toHaveBeenCalled(); expect(decode).not.toHaveBeenCalled()
  expect(createUrl).not.toHaveBeenCalled(); expect(revokeUrl).not.toHaveBeenCalled()
  expect(databaseOpen).not.toHaveBeenCalled(); expect(databaseWrite).not.toHaveBeenCalled()
  expect(listFiles).not.toHaveBeenCalled(); expect(nativeRead).not.toHaveBeenCalled()
  expect(nativeWrite).not.toHaveBeenCalled(); expect(fetchBoundary).not.toHaveBeenCalled()
  expect(restoreQapp).not.toHaveBeenCalled()
}
async function expectAdmissionReject(file: File) {
  const result = await importCanvasFile(file, canvasId).then(() => ({ error: undefined }), (error: unknown) => ({ error }))
  expect(result.error).toBeInstanceOf(Error)
  expect((result.error as Error).message).toBe(message)
  expectNoRestorationEffects()
}

describe('P6 internal scene identities', () => {
  it.each(['items','groups','groupBranches'])('rejects duplicate %s before any asset restoration', async key => {
    const entry = key === 'items' ? textItem() : { id:'same', itemIds:[] }
    const file = syntheticFile({ ...payload(), [key]:[entry,entry], blobs:{ fixture:asset() } }).file
    await expectAdmissionReject(file)
  })
  it('keeps separate namespaces and distinct identities compatible', () => {
    const valid = { ...payload(), items:[textItem(),{...textItem(),id:'other'}],groups:[{id:'shared',itemIds:[]}],groupBranches:[{id:'shared'}] }
    expect(parseCanvasImportText(JSON.stringify(valid))).toEqual(valid)
    expectNoRestorationEffects()
  })
})

beforeEach(() => {
  undo = []
  for (const mock of [createUrl, revokeUrl, bridge, dirname, fetchBoundary, listFiles, nativeRead,
    nativeWrite, restoreQapp, databaseWrite, databaseOpen, databaseClose]) mock.mockReset()
  legacyPathRead = vi.fn(() => '')
  createUrl.mockImplementation(() => 'blob:synthetic-import-' + createUrl.mock.calls.length)
  dirname.mockImplementation((value) => path.win32.dirname(value as string))
  bridge.mockReturnValue('C:\\synthetic-import-source\\canvas.mpcanvas')
  listFiles.mockResolvedValue({ files: [] }); databaseOpen.mockImplementation(fakeDatabase)
  fetchBoundary.mockImplementation(() => { throw new Error('Unexpected fixture fetch') })
  nativeRead.mockImplementation(() => { throw new Error('Unexpected fixture native read') })
  nativeWrite.mockImplementation(() => { throw new Error('Unexpected fixture native write') })
  replace(globalThis, 'indexedDB', { open: databaseOpen }); replace(globalThis, 'fetch', fetchBoundary)
  replace(URL, 'createObjectURL', createUrl); replace(URL, 'revokeObjectURL', revokeUrl)
  replace(window, 'api', { svcFs: { listFilesInFolder: listFiles, readTextFile: nativeRead, saveImageToPath: nativeWrite } })
  replace(window, 'path', { ...path.win32, dirname })
  replace(window, 'electronFile', { getPathForFile: bridge })
  originalAtob = globalThis.atob
  decode = vi.spyOn(globalThis, 'atob').mockImplementation((value: string) => value.length > 1024 ? '' : originalAtob(value))
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  localStorage.clear()
})
afterEach(() => {
  try {
    expect(fetchBoundary).not.toHaveBeenCalled(); expect(nativeRead).not.toHaveBeenCalled()
    expect(nativeWrite).not.toHaveBeenCalled()
  } finally {
    vi.restoreAllMocks()
    for (const restore of undo.reverse()) restore()
    localStorage.clear()
  }
})

describe('REAL explicit canvas import preflight before substituted restoration boundaries', () => {
  for (const [name, size] of [['oversized', limits.maxFileBytes + 1], ['negative', -1], ['fractional', 1.5],
    ['nonfinite', Infinity], ['string', '1'], ['null', null]] as const) {
    it(`rejects ${name} advertised size BEFORE reading text or calling the file bridge`, async () => {
      const { file, read } = syntheticFile(payload(), size)
      await expectAdmissionReject(file); expect(read).not.toHaveBeenCalled()
    })
  }
  it('reads advertised size exactly once and does not coerce it', async () => {
    const coerce = vi.fn(() => 1), { file, read } = syntheticFile(payload())
    const sizeRead = vi.fn(() => ({ valueOf: coerce }))
    Object.defineProperty(file, 'size', { configurable: true, get: sizeRead })
    await expectAdmissionReject(file)
    expect(sizeRead).toHaveBeenCalledTimes(1); expect(read).not.toHaveBeenCalled(); expect(coerce).not.toHaveBeenCalled()
  })
  it('preserves original file.text rejection identity without invoking any restoration boundary', async () => {
    const original = new Error('synthetic file read failure'), { file, read } = syntheticFile(payload())
    read.mockRejectedValue(original)
    await expect(importCanvasFile(file, canvasId)).rejects.toBe(original)
    expect(read).toHaveBeenCalledTimes(1); expectNoRestorationEffects()
  })
  for (const [name, value] of [['syntax failure', '{'], ['null root', 'null'], ['wrong magic', { ...payload(), magic: 'OTHER' }],
    ['missing items', { magic: 'MAGICPOT_CANVAS' }], ['null item', { ...payload(), items: [null] }],
    ['unknown item kind', { ...payload(), items: [{ id: 'a', type: 'future' }] }],
    ['malformed group membership', { ...payload(), groups: [{ id: 'g', itemIds: null }] }],
    ['malformed branch', { ...payload(), groupBranches: [null] }],
    ['malformed model textures', { ...payload(), items: [{ id: 'm', type: 'model3d', src: '', textures: { t: 1 } }] }],
    ['nonstring source', { ...payload(), items: [{ id: 'i', type: 'image', src: {} }] }],
    ['nonstring MIME', { ...payload(), blobs: { a: { base64: 'AQ==', mimeType: 1 } } }],
    ['unsafe log label', { ...payload(), version: { toString: 1 }, blobs: { a: asset() } }]] as const) {
    it(`rejects ${name} before legacy path lookup, decoding, URL creation or IDB writes`, async () => {
      const { file, read } = syntheticFile(value)
      await expectAdmissionReject(file); expect(read).toHaveBeenCalledTimes(1)
    })
  }
  it('validates the last embedded entry before decoding or persisting the first', async () => {
    const { file } = syntheticFile({ ...payload(), blobs: { first: asset(), last: asset('AQ=') } })
    await expectAdmissionReject(file)
  })
  it('rejects oversized text before parse (parse boundary stubbed) and before file-context lookup', async () => {
    const { file, read } = syntheticFile(' '.repeat(limits.maxTextBytes + 1))
    const parse = vi.spyOn(JSON, 'parse').mockReturnValue(payload())
    await expectAdmissionReject(file); expect(read).toHaveBeenCalledTimes(1); expect(parse).not.toHaveBeenCalled()
  })
  it('rejects oversized UTF8 text before parse (parse boundary stubbed)', async () => {
    const { file } = syntheticFile('é'.repeat(Math.floor(limits.maxTextBytes / 2) + 1))
    const parse = vi.spyOn(JSON, 'parse').mockReturnValue(payload())
    await expectAdmissionReject(file); expect(parse).not.toHaveBeenCalled()
  })
  it('rejects advertised-allowed but returned nonprimitive text without coercion', async () => {
    const coerce = vi.fn(() => JSON.stringify(payload()))
    const file = { size: 1, text: async () => ({ toString: coerce }) } as unknown as File
    Object.defineProperty(file, 'path', { get: legacyPathRead })
    await expectAdmissionReject(file); expect(coerce).not.toHaveBeenCalled()
  })
  for (const [name, value] of [
    ['item count', { ...payload(), items: Array(limits.maxItems + 1).fill(textItem()) }],
    ['blob count', { ...payload(), blobs: Object.fromEntries(Array.from({ length: limits.maxBlobEntries + 1 }, (_, i) => ['b' + i, asset('')])) }],
    ['graph node count', { ...payload(), extra: Array(limits.maxNodes).fill(null) }]
  ] as const) {
    it(`rejects ${name} budget before restoration`, async () => {
      const { file } = syntheticFile(value); await expectAdmissionReject(file)
    })
  }
  it('rejects an oversized decoded asset before any binary decoding (large decode itself stubbed)', async () => {
    const bytes = limits.maxAssetBytes + 1
    const base64 = 'AAAA'.repeat(Math.floor(bytes / 3)) + ['', 'AA==', 'AAA='][bytes % 3]
    const { file } = syntheticFile({ ...payload(), blobs: { a: asset(base64) } })
    await expectAdmissionReject(file)
  })
  for (const version of [3, 7, 8]) {
    it(`preserves known v${version} example fields, legacy absent fields and ignored quick-app state`, async () => {
      const data = { ...payload(), version, currentQAppKey: 'legacy-not-applied', qAppCache: { legacy: {} },
        groups: [{ id: 'g', name: 'Group', itemIds: ['synthetic-text'], createdAt: 'synthetic', provenance: { kind: 'figma' } }] }
      const { file, read } = syntheticFile(data)
      const result = await importCanvasFile(file, canvasId)
      expect(result.items).toEqual(data.items); expect(result.groups).toEqual(data.groups)
      expect(result.groupBranches).toEqual([]); expect(result.qAppKey).toBeUndefined()
      expect(localStorage.getItem('qapp.currentQAppKey')).toBeNull(); expect(read).toHaveBeenCalledTimes(1)
      expect(decode).not.toHaveBeenCalled(); expect(databaseOpen).not.toHaveBeenCalled()
    })
  }
  it('accepts a genuine File advertised boundary with synthetic text and witnesses the Electron file bridge', async () => {
    const file = new File(['tiny owned fixture'], 'synthetic.mpcanvas')
    const read = vi.fn(async () => JSON.stringify(payload()))
    Object.defineProperty(file, 'text', { value: read }); Object.defineProperty(file, 'size', { value: limits.maxFileBytes })
    const result = await importCanvasFile(file, canvasId)
    expect(result.items).toEqual(payload().items); expect(bridge).toHaveBeenCalledExactlyOnceWith(file)
    expect(dirname).toHaveBeenCalledWith('C:\\synthetic-import-source\\canvas.mpcanvas')
    expect(read).toHaveBeenCalledTimes(1)
  })
  it('retains actual small embedded decode and target-scoped fake-IDB writes after complete admission', async () => {
    const data = { ...payload(), blobs: { orphan: asset(' A\tQ\n=\f=\r ') } }
    const { file } = syntheticFile(data)
    const result = await importCanvasFile(file, canvasId)
    expect(result.items).toEqual(data.items)
    expect(decode).toHaveBeenCalledTimes(2); expect(createUrl).toHaveBeenCalledTimes(1)
    expect(databaseOpen).toHaveBeenCalledTimes(1); expect(databaseWrite).toHaveBeenCalledTimes(1)
    const [stored, key] = databaseWrite.mock.calls[0]
    expect(key).toBe(canvasId + '::canvas::orphan')
    expect(stored.mimeType).toBe('application/octet-stream'); expect([...new Uint8Array(stored.data)]).toEqual([1])
    expect(databaseClose).toHaveBeenCalledTimes(1)
  })
  it('preserves original valid-payload second-URL failure and first-URL cleanup without persisting', async () => {
    const original = new Error('synthetic URL allocation failure')
    createUrl.mockReturnValueOnce('blob:synthetic-first').mockImplementationOnce(() => { throw original })
    const { file } = syntheticFile({ ...payload(), blobs: { first: asset(), last: asset('Ag==') } })
    await expect(importCanvasFile(file, canvasId)).rejects.toBe(original)
    expect(revokeUrl).toHaveBeenCalledExactlyOnceWith('blob:synthetic-first')
    expect(databaseOpen).not.toHaveBeenCalled()
  })
  it('keeps valid later project-reference failure cleanup but does not claim IDB rollback', async () => {
    const original = new Error('synthetic project-ref listing failure')
    listFiles.mockRejectedValue(original)
    const { file } = syntheticFile({ ...payload(), storageMode: 'project',
      items: [{ id: 'i', type: 'image', src: 'assets/images/synthetic.png' }], blobs: { orphan: asset() } })
    legacyPathRead.mockReturnValue('C:\\synthetic-source\\project.mpcanvas')
    await expect(importCanvasFile(file, canvasId)).rejects.toBe(original)
    expect(databaseWrite).toHaveBeenCalledTimes(1); expect(listFiles).toHaveBeenCalledTimes(1)
    expect(revokeUrl).toHaveBeenCalledExactlyOnceWith('blob:synthetic-import-1')
  })
})
