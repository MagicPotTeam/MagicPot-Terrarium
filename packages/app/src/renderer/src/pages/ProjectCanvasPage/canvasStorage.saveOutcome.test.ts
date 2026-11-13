import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  exportCanvasFile,
  exportCanvasFileAsStandalone,
  getCanvasSaveTargetPath,
  rememberCanvasSaveTargetPath
} from './canvasStorage'
import type { CanvasTextItem } from './types'

vi.mock('../QuickAppPage/components/QAppContext', () => ({ restoreGlobalQAppCache: vi.fn() }))
vi.mock('../ChatPage/chatPageShared', () => ({
  getDownloadFileNameFromUrl: vi.fn(),
  normalizeLocalMediaUrl: (value: string) => value
}))

type Ack = { success: boolean; fullPath: string }
const text: CanvasTextItem = {
  id: 'synthetic-text', type: 'text', text: 'Synthetic canvas only', x: 0, y: 0,
  width: 80, height: 30, rotation: 0, scaleX: 1, scaleY: 1, zIndex: 0,
  locked: false, fontSize: 14, fontFamily: 'sans-serif', fill: '#fff'
}
const id = 'save-outcome-synthetic'
const selectedPath = 'C:\\synthetic-output\\selected.mpcanvas'
const cachedPath = 'C:\\synthetic-output\\cached.mpcanvas'
const dialog = vi.fn<(...args: unknown[]) => Promise<{ canceled: boolean; filePath?: string }>>()
const write = vi.fn<(...args: unknown[]) => Promise<unknown>>()
const fetchBoundary = vi.fn(() => { throw new Error('Unexpected fetch in text-only fixture') })
const dbOpen = vi.fn(() => { throw new Error('Unexpected IndexedDB in text-only fixture') })
const createUrl = vi.fn(() => 'blob:save-outcome-synthetic')
const revokeUrl = vi.fn()
let click: ReturnType<typeof vi.spyOn>
let restore: Array<() => void>
let settle: Array<() => void>

function replace(object: object, key: string, value: unknown) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key)
  Object.defineProperty(object, key, { configurable: true, writable: true, value })
  restore.push(() => descriptor
    ? Object.defineProperty(object, key, descriptor)
    : Reflect.deleteProperty(object, key))
}
function deferredAck() {
  let resolve!: (value: Ack) => void
  const promise = new Promise<Ack>((done) => { resolve = done })
  settle.push(() => resolve({ success: true, fullPath: selectedPath }))
  return { promise, resolve }
}
async function flushMicrotasks() {
  for (let i = 0; i < 24; i++) await Promise.resolve()
}
function native() {
  replace(window, 'api', { svcDialog: { showSaveDialog: dialog }, svcFs: { saveImageToPath: write } })
  replace(window, 'path', path.win32)
}
async function save(standalone = false) {
  return standalone
    ? await exportCanvasFileAsStandalone([text], 'synthetic.mpcanvas', id)
    : await exportCanvasFile([text], 'synthetic.mpcanvas', id)
}
function expectOnlyResult(value: unknown, status: string) {
  expect(value).toEqual({ status })
  expect(Object.keys(value as object)).toEqual(['status'])
}

beforeEach(() => {
  restore = []; settle = []
  localStorage.clear()
  dialog.mockReset().mockResolvedValue({ canceled: false, filePath: selectedPath })
  write.mockReset().mockResolvedValue({ success: true, fullPath: selectedPath })
  fetchBoundary.mockClear(); dbOpen.mockClear(); createUrl.mockClear(); revokeUrl.mockClear()
  replace(globalThis, 'fetch', fetchBoundary)
  replace(globalThis, 'indexedDB', { open: dbOpen })
  replace(URL, 'createObjectURL', createUrl); replace(URL, 'revokeObjectURL', revokeUrl)
  click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  native()
})
afterEach(async () => {
  try {
    for (const done of settle) done()
    await flushMicrotasks()
    expect(fetchBoundary).not.toHaveBeenCalled()
    expect(dbOpen).not.toHaveBeenCalled()
  } finally {
    vi.restoreAllMocks()
    for (const undo of restore.reverse()) undo()
    localStorage.clear()
    document.querySelectorAll('a[download]').forEach((anchor) => anchor.remove())
  }
})

describe('actual canvas export pathless save outcomes under synthetic boundaries', () => {
  for (const standalone of [false, true]) {
    const mode = standalone ? 'standalone' : 'ordinary'
    it.each([
      ['cancel flag', { canceled: true }],
      ['missing selected path', { canceled: false }]
    ] as const)(`${mode} direct dialog %s returns cancelled without native or download requests`, async (_name, response) => {
      dialog.mockResolvedValue(response)
      const outcome: unknown = await save(standalone)
      expect(dialog).toHaveBeenCalledTimes(1)
      expect(write).not.toHaveBeenCalled(); expect(click).not.toHaveBeenCalled()
      expect(createUrl).not.toHaveBeenCalled(); expect(getCanvasSaveTargetPath(id)).toBeNull()
      expectOnlyResult(outcome, 'cancelled')
    })
    it(`${mode} returns native-written only after a true acknowledgement and preserves JSON`, async () => {
      const outcome: unknown = await save(standalone)
      expect(write).toHaveBeenCalledTimes(1); expect(click).not.toHaveBeenCalled()
      const request = write.mock.calls[0][0] as { image: Uint8Array; outputPath: string; filename: string }
      expect(request.outputPath).toBe('C:\\synthetic-output')
      expect(request.filename).toBe('selected.mpcanvas')
      const payload = JSON.parse(new TextDecoder().decode(request.image))
      expect(payload).toMatchObject({ magic: 'MAGICPOT_CANVAS', version: 8, storageMode: 'embedded', items: [text], groups: [], groupBranches: [], figmaBinding: null })
      expect(getCanvasSaveTargetPath(id)).toBe(standalone ? null : selectedPath)
      expectOnlyResult(outcome, 'native-written')
    })
    it(`${mode} remains pending while native acknowledgement is unresolved`, async () => {
      const gate = deferredAck(); write.mockReturnValueOnce(gate.promise)
      let fulfilled = false
      const pending = save(standalone).then((outcome) => { fulfilled = true; return outcome })
      await flushMicrotasks()
      expect(write).toHaveBeenCalledTimes(1); expect(fulfilled).toBe(false)
      expect(getCanvasSaveTargetPath(id)).toBe(standalone ? null : selectedPath)
      gate.resolve({ success: true, fullPath: selectedPath })
      expectOnlyResult(await pending, 'native-written')
    })
    it(`${mode} propagates only download-requested when native support is absent`, async () => {
      replace(window, 'api', undefined); replace(window, 'path', undefined)
      const outcome: unknown = await save(standalone)
      expect(dialog).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled()
      expect(click).toHaveBeenCalledTimes(1); expect(createUrl).toHaveBeenCalledTimes(1)
      expect(revokeUrl).toHaveBeenCalledWith('blob:save-outcome-synthetic')
      expect(document.querySelector('a[download]')).toBeNull()
      expectOnlyResult(outcome, 'download-requested')
    })
  }

  it('ordinary cached Save overwrites its existing target without opening another dialog', async () => {
    rememberCanvasSaveTargetPath(id, cachedPath)
    const outcome: unknown = await save()
    expect(dialog).not.toHaveBeenCalled(); expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0][0]).toMatchObject({ filename: 'cached.mpcanvas' })
    expect(getCanvasSaveTargetPath(id)).toBe(cachedPath)
    expectOnlyResult(outcome, 'native-written')
  })
  it('Save As bypasses the cached target but retains pre-write selected-path rebinding', async () => {
    rememberCanvasSaveTargetPath(id, cachedPath)
    const gate = deferredAck(); write.mockReturnValueOnce(gate.promise)
    const pending = exportCanvasFile([text], 'synthetic.mpcanvas', id, true)
    await flushMicrotasks()
    expect(dialog).toHaveBeenCalledTimes(1); expect(write).toHaveBeenCalledTimes(1)
    expect(getCanvasSaveTargetPath(id)).toBe(selectedPath)
    gate.resolve({ success: true, fullPath: selectedPath })
    expectOnlyResult(await pending, 'native-written')
  })
  it('standalone forces a new destination without rebinding the current document path', async () => {
    rememberCanvasSaveTargetPath(id, cachedPath)
    const outcome: unknown = await save(true)
    expect(dialog).toHaveBeenCalledTimes(1); expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0][0]).toMatchObject({ filename: 'selected.mpcanvas' })
    expect(getCanvasSaveTargetPath(id)).toBe(cachedPath)
    expectOnlyResult(outcome, 'native-written')
  })

  it.each([
    ['false', { success: false, fullPath: selectedPath }],
    ['missing field', {}], ['missing response', undefined], ['null response', null],
    ['truthy nonboolean', { success: 'true' }]
  ])('selected native %s acknowledgement requests download, preserving pre-write cache for the next Save', async (_name, ack) => {
    write.mockResolvedValueOnce(ack)
    const outcome: unknown = await save()
    expect(write).toHaveBeenCalledTimes(1); expect(dialog).toHaveBeenCalledTimes(1)
    expect(getCanvasSaveTargetPath(id)).toBe(selectedPath)
    expect(click).toHaveBeenCalledTimes(1)
    expectOnlyResult(outcome, 'download-requested')
    const next: unknown = await save()
    expect(write).toHaveBeenCalledTimes(2); expect(dialog).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[1][0]).toMatchObject({ filename: 'selected.mpcanvas' })
    expectOnlyResult(next, 'native-written')
  })
  for (const [ackName, ack] of [['false', { success: false }], ['missing', {}]] as const) {
    for (const choose of ['cancel', 'success'] as const) {
      it(`cached ${ackName} acknowledgement then dialog ${choose} preserves fallback attempt counts`, async () => {
        rememberCanvasSaveTargetPath(id, cachedPath); write.mockResolvedValueOnce(ack)
        if (choose === 'cancel') dialog.mockResolvedValueOnce({ canceled: true })
        const outcome: unknown = await save()
        expect(dialog).toHaveBeenCalledTimes(1)
        expect(write).toHaveBeenCalledTimes(choose === 'cancel' ? 1 : 2)
        expect(write.mock.calls[0][0]).toMatchObject({ filename: 'cached.mpcanvas' })
        expect(click).not.toHaveBeenCalled(); expect(createUrl).not.toHaveBeenCalled()
        expect(getCanvasSaveTargetPath(id)).toBe(choose === 'cancel' ? null : selectedPath)
        if (choose === 'success') expect(write.mock.calls[1][0]).toMatchObject({ filename: 'selected.mpcanvas' })
        expectOnlyResult(outcome, choose === 'cancel' ? 'cancelled' : 'native-written')
      })
    }
  }
  it('cached rejection followed by cancellation makes no additional file or download request', async () => {
    rememberCanvasSaveTargetPath(id, cachedPath)
    write.mockRejectedValueOnce(new Error('synthetic cached write failure'))
    dialog.mockResolvedValueOnce({ canceled: true })
    const outcome: unknown = await save()
    expect(write).toHaveBeenCalledTimes(1); expect(dialog).toHaveBeenCalledTimes(1)
    expect(click).not.toHaveBeenCalled(); expect(getCanvasSaveTargetPath(id)).toBeNull()
    expectOnlyResult(outcome, 'cancelled')
  })
  it('selected write rejection preserves pre-write cache while requesting browser fallback', async () => {
    write.mockRejectedValueOnce(new Error('synthetic native failure'))
    const outcome: unknown = await save()
    expect(write).toHaveBeenCalledTimes(1); expect(click).toHaveBeenCalledTimes(1)
    expect(getCanvasSaveTargetPath(id)).toBe(selectedPath)
    expectOnlyResult(outcome, 'download-requested')
  })
  it('dialog rejection remains rejected and does not trigger a write or a browser download', async () => {
    const failure = new Error('synthetic dialog failure'); dialog.mockRejectedValueOnce(failure)
    await expect(save()).rejects.toBe(failure)
    expect(write).not.toHaveBeenCalled(); expect(click).not.toHaveBeenCalled()
  })
  it('a browser click failure remains rejected rather than reporting saved or requested', async () => {
    replace(window, 'api', undefined)
    const failure = new Error('synthetic click failure'); click.mockImplementation(() => { throw failure })
    await expect(save()).rejects.toBe(failure)
    expect(write).not.toHaveBeenCalled(); expect(click).toHaveBeenCalledTimes(1)
  })
  it('dialog-open notification does not settle or start any write before the user decides', async () => {
    let resolve!: (value: { canceled: boolean }) => void
    const gate = new Promise<{ canceled: boolean }>((done) => { resolve = done })
    settle.push(() => resolve({ canceled: true })); dialog.mockReturnValueOnce(gate)
    const opened = vi.fn()
    const pending = exportCanvasFile([text], 'synthetic.mpcanvas', id, false, [], null, [], true, opened)
    await flushMicrotasks()
    expect(opened).toHaveBeenCalledTimes(1); expect(write).not.toHaveBeenCalled()
    resolve({ canceled: true })
    expectOnlyResult(await pending, 'cancelled')
  })
})
