// Synthetic only: real menu dispatch and export hook, no filesystem or network.
import { posix as path } from 'node:path'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasImageItem } from './types'

const m = vi.hoisted(() => ({ saveProject: vi.fn(async (..._args: unknown[]) => ({ status: 'native-written' })), saveDialog: vi.fn(async () => ({ canceled: false, filePath: '/synthetic/result.png' })), openDialog: vi.fn(async () => ({ canceled: false, filePaths: ['/synthetic'] })), saveFile: vi.fn(async () => ({})), saveDir: vi.fn(async () => ({})) }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key }) }))
vi.mock('../../utils/windowUtils', () => ({ api: () => ({ svcDialog: { showSaveDialog: m.saveDialog, showOpenDialog: m.openDialog }, svcFs: { saveImageToPath: m.saveFile }, svcHyper: { saveImageToDir: m.saveDir } }) }))
vi.mock('./canvasStorage', () => ({ exportCanvasFile: m.saveProject, exportCanvasFileAsStandalone: vi.fn() }))
import { useCanvasExportWorkflow } from './useCanvasExportWorkflow'

const plain: CanvasImageItem = { id: 'plain', type: 'image', src: 'data:image/png;base64,QQ==', x: 0, y: 0, width: 100, height: 100, rotation: 0, scaleX: 1, scaleY: 1, zIndex: 0, locked: false }
const cropped: CanvasImageItem = { ...plain, id: 'crop', x: 120, src: 'data:image/png;base64,Qg==', crop: { x: 0, y: 0, width: 50, height: 50 } }
let draw: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('path', path)
  vi.clearAllMocks()
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network prohibited')))
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(callback, 0))
  draw = vi.fn()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) { return { canvas: this, drawImage: draw, save: vi.fn(), restore: vi.fn(), translate: vi.fn(), rotate: vi.fn(), scale: vi.fn(), fillRect: vi.fn() } as unknown as CanvasRenderingContext2D } as unknown as typeof HTMLCanvasElement.prototype.getContext)
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb, type) => cb(Object.assign(new Blob(['fixture'], { type: type || 'image/png' }), { arrayBuffer: async () => new Uint8Array([1]).buffer })))
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

function setup(items: CanvasImageItem[], selectedIds = items.map((i) => i.id)) {
  const before = structuredClone(items)
  const img = document.createElement('img')
  Object.defineProperty(img, 'naturalWidth', { value: 200 }); Object.defineProperty(img, 'naturalHeight', { value: 200 })
  const load = vi.fn(async () => ({ img, width: 200, height: 200 }))
  const error = vi.fn((_message: string) => 0), success = vi.fn(() => 0), setSelectedIds = vi.fn()
  const hook = renderHook(() => useCanvasExportWorkflow({ canvasId: 'fixture', projectName: 'Fixture', items, groups: [], groupBranches: [], figmaBinding: null, selectedIds: new Set(selectedIds), setSelectedIds, stageRef: { current: null }, canvasContainerRef: { current: null }, stagePos: { x: 0, y: 0 }, stageScale: 1, bgColor: '#ffffff', loadImageFromSrc: load, getCanvasItemVisualBounds: (item) => ({ x: item.x, y: item.y, width: item.width, height: item.height }), notifyError: error, notifySuccess: success }))
  return { hook, before, items, load, error, success, setSelectedIds }
}

const cases = [
  ['scene', 'png'], ['scene', 'jpeg'], ['scene', 'svg'],
  ['selected-scene', 'png'], ['selected-scene', 'jpeg'], ['selected-scene', 'svg'],
  ['all-elements', 'png'], ['all-elements', 'svg'], ['selected-elements', 'png'], ['selected-elements', 'svg']
] as const

describe('crop export boundary', () => {
  it.each(cases)('rejects mixed %s %s before dialogs or work', async (scope, format) => {
    const t = setup([cropped, plain])
    await act(async () => { t.hook.result.current.handleExportScopeWithFormat(scope, format); await vi.runAllTimersAsync() })
    expect.soft(t.error).toHaveBeenCalledOnce()
    const message = String(t.error.mock.calls[0]?.[0] ?? '')
    expect.soft(message).toMatch(/crop/i)
    expect.soft(message).toMatch(/(remov|uncrop)/i)
    expect.soft(message).toMatch(/(full|original)/i)
    expect.soft(m.saveDialog).not.toHaveBeenCalled()
    expect.soft(m.openDialog).not.toHaveBeenCalled()
    expect.soft(t.load).not.toHaveBeenCalled()
    expect.soft(draw).not.toHaveBeenCalled()
    expect.soft(fetch).not.toHaveBeenCalled()
    expect.soft(m.saveFile).not.toHaveBeenCalled()
    expect.soft(m.saveDir).not.toHaveBeenCalled()
    expect.soft(t.setSelectedIds).not.toHaveBeenCalled()
    expect.soft(t.success).not.toHaveBeenCalled()
    expect(t.items).toEqual(t.before)
    t.hook.unmount()
  })
  it.each(['selected-scene', 'selected-elements'] as const)('%s excludes an unselected crop', async (scope) => {
    const t = setup([plain, cropped], ['plain'])
    await act(async () => { t.hook.result.current.handleExportScopeWithFormat(scope, 'png'); await vi.runAllTimersAsync() })
    expect(t.error).not.toHaveBeenCalled()
    expect(t.load).toHaveBeenCalledExactlyOnceWith(plain.src)
    expect(draw).toHaveBeenCalledOnce()
    if (scope === 'selected-scene') { expect(m.saveDialog).toHaveBeenCalledOnce(); expect(m.saveFile).toHaveBeenCalledOnce() }
    else { expect(m.openDialog).toHaveBeenCalledOnce(); expect(m.saveDir).toHaveBeenCalledOnce() }
    expect(t.items).toEqual(t.before)
    t.hook.unmount()
  })
  it.each(['scene', 'all-elements'] as const)('%s rejects an unselected crop before any side effect', async (scope) => {
    const t = setup([plain, cropped], ['plain'])
    await act(async () => { t.hook.result.current.handleExportScopeWithFormat(scope, 'png'); await vi.runAllTimersAsync() })
    expect.soft(t.error).toHaveBeenCalledOnce()
    const message = String(t.error.mock.calls[0]?.[0] ?? '')
    expect.soft(message).toMatch(/crop/i)
    expect.soft(message).toMatch(/(remov|uncrop)/i)
    expect.soft(message).toMatch(/(full|original)/i)
    expect.soft(m.saveDialog).not.toHaveBeenCalled(); expect.soft(m.openDialog).not.toHaveBeenCalled()
    expect.soft(t.load).not.toHaveBeenCalled(); expect.soft(draw).not.toHaveBeenCalled()
    expect.soft(fetch).not.toHaveBeenCalled(); expect.soft(m.saveFile).not.toHaveBeenCalled(); expect.soft(m.saveDir).not.toHaveBeenCalled()
    expect(t.items).toEqual(t.before)
    t.hook.unmount()
  })
  it.each([['scene','png'], ['scene','jpeg'], ['scene','svg'], ['all-elements','png'], ['all-elements','jpeg'], ['all-elements','svg']] as const)('exports uncropped %s %s to mock storage', async (scope, format) => {
    const t = setup([plain])
    await act(async () => { t.hook.result.current.handleExportScopeWithFormat(scope, format); await vi.runAllTimersAsync() })
    expect(t.error).not.toHaveBeenCalled()
    expect(t.load).toHaveBeenCalledExactlyOnceWith(plain.src)
    expect(draw).toHaveBeenCalledOnce()
    if (scope === 'scene') { expect(m.saveDialog).toHaveBeenCalledOnce(); expect(m.saveFile).toHaveBeenCalledOnce() }
    else { expect(m.openDialog).toHaveBeenCalledOnce(); expect(m.saveDir).toHaveBeenCalledOnce() }
    expect(t.items).toEqual(t.before)
    t.hook.unmount()
  })
  it('project save preserves mixed sources and bypasses export crop guard', async () => {
    const t = setup([plain, cropped], ['plain'])
    await act(async () => { await t.hook.result.current.handleSaveCanvas({ suppressNotifications: true }) })
    expect(m.saveProject).toHaveBeenCalledOnce()
    expect(m.saveProject.mock.calls[0][0]).toEqual([plain, cropped])
    expect(t.error).not.toHaveBeenCalled()
    expect(t.items).toEqual(t.before)
    t.hook.unmount()
  })
  it('exports an uncropped selected scene through mocked save', async () => {
    const t = setup([plain])
    await act(async () => { t.hook.result.current.handleExportScopeWithFormat('selected-scene', 'png'); await vi.runAllTimersAsync() })
    expect(m.saveDialog).toHaveBeenCalledOnce()
    expect(t.load).toHaveBeenCalledOnce()
    expect(draw).toHaveBeenCalled()
    expect(m.saveFile).toHaveBeenCalledOnce()
    expect(t.error).not.toHaveBeenCalled()
    expect(t.items).toEqual(t.before)
    t.hook.unmount()
  })
})
