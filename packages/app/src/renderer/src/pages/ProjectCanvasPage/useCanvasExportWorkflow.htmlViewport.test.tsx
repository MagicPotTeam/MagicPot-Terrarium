import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_SELECTION_RASTER_LIMITS } from './canvasExportRasterUtils'
import type { CanvasHtmlItem } from './types'
import { useCanvasExportWorkflow } from './useCanvasExportWorkflow'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../../utils/windowUtils', () => ({ api: () => ({}) }))
vi.mock('./canvasStorage', () => ({ exportCanvasFile: vi.fn(), exportCanvasFileAsStandalone: vi.fn() }))

type WorkflowOptions = Parameters<typeof useCanvasExportWorkflow>[0]
const htmlItem = (width: number, height: number): CanvasHtmlItem => ({
  id: 'html-1', type: 'html', htmlData: '<p>Owned HTML</p>', x: 0, y: 0,
  width, height, rotation: 0, scaleX: 1, scaleY: 1, zIndex: 0, locked: false
})
const readBlob = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(String(reader.result))
  reader.onerror = () => reject(reader.error)
  reader.readAsText(blob)
})

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('bounded HTML overview raster viewport', () => {
  it.each([
    { width: 12000, height: 6000, clipped: false, viewport: [2000, 1000] },
    { width: 8000, height: 7000, clipped: true, viewport: [2000, 1750] },
    { width: 400, height: 200, clipped: false, viewport: [400, 200] },
    { width: 8000, height: 4000, clipped: false, viewport: null }
  ])('bounds the SVG viewport for a $width × $height item (clipped=$clipped)', async ({ width, height, clipped, viewport }) => {
    const item = htmlItem(width, height)
    const drawImage = vi.fn()
    const contexts: Array<{ canvas: HTMLCanvasElement; drawImage: typeof drawImage }> = []
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      const context = { canvas: this, drawImage, save: vi.fn(), restore: vi.fn(), translate: vi.fn(), rotate: vi.fn(), scale: vi.fn(), fillRect: vi.fn(), clearRect: vi.fn() }
      contexts.push(context)
      return context as unknown as CanvasRenderingContext2D
    } as unknown as typeof HTMLCanvasElement.prototype.getContext)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => callback(new Blob(['owned-image'], { type: 'image/png' })))
    const blobs: Blob[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0))
    vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { blobs.push(blob as Blob); return 'blob:owned-html' })
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const image = document.createElement('img')
    const loadImageFromSrc = vi.fn(async () => ({ img: image, width: viewport?.[0] ?? width, height: viewport?.[1] ?? height }))
    const options: WorkflowOptions = {
      canvasId: 'owned-overview', projectName: 'Owned', items: [item], groups: [], groupBranches: [], figmaBinding: null,
      selectedIds: new Set([item.id]), setSelectedIds: vi.fn(), stageRef: { current: null },
      canvasContainerRef: { current: document.createElement('div') }, stagePos: { x: 0, y: 0 }, stageScale: 1,
      bgColor: 'transparent', loadImageFromSrc,
      getCanvasItemVisualBounds: () => ({ x: 0, y: 0, width, height }),
      notifyError: vi.fn(() => 0), notifySuccess: vi.fn(() => 0)
    }
    const { result } = renderHook(() => useCanvasExportWorkflow(options))
    let data = ''
    await act(async () => {
      data = await result.current.renderCanvasItemsImageDataUrl(
        [item], false, clipped ? { x: 0, y: 0, width: 1000, height: 500 } : undefined,
        viewport ? AGENT_SELECTION_RASTER_LIMITS : undefined
      )
    })
    expect(data).toMatch(/^data:image\/png;base64,/)
    expect(blobs).toHaveLength(1)
    const markup = await readBlob(blobs[0])
    if (viewport) {
      expect(markup).toContain(`width="${viewport[0]}" height="${viewport[1]}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"`)
    } else {
      expect(markup).toContain(`width="${width}" height="${height}"`)
      expect(markup).not.toContain('viewBox=')
    }
    expect(markup).toContain('<p>Owned HTML</p>')
    expect(loadImageFromSrc).toHaveBeenCalledExactlyOnceWith('blob:owned-html')
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:owned-html')
    expect(drawImage).toHaveBeenCalledExactlyOnceWith(image, 0, 0, width, height)
    if (viewport) {
      expect(contexts[0].canvas.width).toBeLessThanOrEqual(2000)
      expect(contexts[0].canvas.height).toBeLessThanOrEqual(2000)
      expect(contexts[0].canvas.width * contexts[0].canvas.height).toBeLessThanOrEqual(4_000_000)
    }
  })
})
