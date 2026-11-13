// Synthetic jsdom canvas: captures production draw arguments, not decoded pixels.
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCanvasExportWorkflow } from './useCanvasExportWorkflow'
import { buildProjectCanvasRenderableImage } from './projectCanvasRenderBoundary'
import { useCanvasMediaActions } from './useCanvasMediaActions'
import type { CanvasImageItem } from './types'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const transfer = vi.hoisted(() => ({ save: vi.fn(), copy: vi.fn(), dialog: vi.fn() }))
vi.mock('../../utils/windowUtils', () => ({
  api: () => ({
    svcDialog: { showSaveDialog: transfer.dialog },
    svcFs: { saveImageToPath: transfer.save },
    svcHyper: { writeImageToClipboard: transfer.copy }
  })
}))
vi.mock('./canvasStorage', () => ({ exportCanvasFile: vi.fn(), exportCanvasFileAsStandalone: vi.fn() }))

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('synthetic crop display and export coordinate comparison', () => {
  it.each(['copy', 'download'] as const)('rejects %s with both real hooks before raster or external transfer', async (operation) => {
    transfer.save.mockReset()
    transfer.copy.mockReset().mockResolvedValue({ success: true })
    transfer.dialog.mockReset().mockResolvedValue({ canceled: false, filePath: 'C:/synthetic/export.png' })
    const source = document.createElement('canvas')
    source.width = 100
    source.height = 100
    const cropped: CanvasImageItem = {
      id: 'private-crop', type: 'image', src: 'blob:synthetic-crop', image: source,
      crop: { x: 1, y: 2, width: 30, height: 40 }, x: 0, y: 0, width: 50, height: 60,
      rotation: 0, scaleX: 1, scaleY: 1, zIndex: 0, locked: false
    }
    const load = vi.fn(async () => ({ img: document.createElement('img'), width: 100, height: 100 }))
    const notifyError = vi.fn(() => 0)
    const notifySuccess = vi.fn(() => 0)
    const hook = renderHook(() => {
      const workflow = useCanvasExportWorkflow({
        canvasId: 'synthetic', projectName: 'Synthetic', items: [cropped], groups: [], groupBranches: [], figmaBinding: null,
        selectedIds: new Set([cropped.id]), setSelectedIds: vi.fn(), stageRef: { current: null }, canvasContainerRef: { current: null },
        stagePos: { x: 0, y: 0 }, stageScale: 1, bgColor: 'transparent', loadImageFromSrc: load,
        getCanvasItemVisualBounds: () => ({ x: 0, y: 0, width: 50, height: 60 }), notifyError, notifySuccess
      })
      return useCanvasMediaActions({ notifyError, notifySuccess, renderCanvasItemsImageBytes: workflow.renderCanvasItemsImageBytes })
    })
    await act(async () => {
      if (operation === 'copy') await hook.result.current.handleCopyCanvasItemsAsImage([cropped])
      else await hook.result.current.handleDownloadCanvasItemsAsImage([cropped])
    })
    expect(notifyError).toHaveBeenCalledExactlyOnceWith('canvas.export_cropped_image_failed')
    expect(load).not.toHaveBeenCalled()
    expect(transfer.dialog).not.toHaveBeenCalled()
    expect(transfer.copy).not.toHaveBeenCalled()
    expect(transfer.save).not.toHaveBeenCalled()
    expect(notifySuccess).not.toHaveBeenCalled()
    expect(cropped.crop).toEqual({ x: 1, y: 2, width: 30, height: 40 })
  })

  it('maps preview coordinates while export draws the corresponding source rectangle', async () => {
    const preview = document.createElement('canvas'); preview.width = 100; preview.height = 100
    const source = document.createElement('img')
    Object.defineProperty(source, 'naturalWidth', { value: 200 })
    Object.defineProperty(source, 'naturalHeight', { value: 200 })
    const item: CanvasImageItem = { id: 'synthetic', type: 'image', src: 'data:image/png;base64,c3ludGhldGlj', image: preview, sourceWidth: 200, sourceHeight: 200, crop: { x: 0, y: 0, width: 100, height: 100 }, x: 0, y: 0, width: 100, height: 100, rotation: 0, scaleX: 1, scaleY: 1, zIndex: 0, locked: false }
    const display = buildProjectCanvasRenderableImage(item, preview)
    expect(display?.image).toBe(preview)
    expect(display?.crop).toEqual({ x: 0, y: 0, width: 50, height: 50 })
    const drawImage = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      return { canvas: this, drawImage, save: vi.fn(), restore: vi.fn(), translate: vi.fn(), rotate: vi.fn(), scale: vi.fn(), fillRect: vi.fn() } as unknown as CanvasRenderingContext2D
    } as unknown as typeof HTMLCanvasElement.prototype.getContext)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback, type) => callback(new Blob(['synthetic'], { type: type || 'image/png' })))
    const loadImageFromSrc = vi.fn(async () => ({ img: source, width: 200, height: 200 }))
    const hook = renderHook(() => useCanvasExportWorkflow({ canvasId: 'synthetic', projectName: 'Synthetic', items: [item], groups: [], groupBranches: [], figmaBinding: null, selectedIds: new Set(), setSelectedIds: vi.fn(), stageRef: { current: null }, canvasContainerRef: { current: null }, stagePos: { x: 0, y: 0 }, stageScale: 1, bgColor: 'transparent', loadImageFromSrc, getCanvasItemVisualBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }), notifyError: vi.fn(() => 0), notifySuccess: vi.fn(() => 0) }))
    let output = ''
    await act(async () => { output = await hook.result.current.renderCanvasItemsImageDataUrl([item]) })
    expect(output.startsWith('data:image/png')).toBe(true)
    expect(loadImageFromSrc).toHaveBeenCalledExactlyOnceWith(item.src)
    expect(drawImage).toHaveBeenCalledWith(source, 0, 0, 100, 100, 0, 0, 100, 100)
    // A preview of the same whole source makes its 0..50 precisely source 0..100,
    // so this comparison does not demonstrate an export beyond displayed pixels.
    hook.unmount()
  })
})
