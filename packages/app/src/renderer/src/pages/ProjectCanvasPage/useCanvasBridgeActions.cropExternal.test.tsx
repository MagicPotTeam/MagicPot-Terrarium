import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasImageItem } from './types'

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(), photoshop: vi.fn(async () => ({ success: true })),
  clipboard: vi.fn(async () => ({ success: true })), adobe: vi.fn(async () => ({})),
  config: vi.fn(async () => ({ config: { adobe_bridge_config: { after_effects_export_dir: '/synthetic', premiere_export_dir: '/synthetic' } } }))
}))
vi.mock('react-redux', () => ({ useDispatch: () => mocks.dispatch }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key }) }))
vi.mock('../../utils/windowUtils', () => ({ api: () => ({ svcPhotoshop: { sendImageToPhotoshop: mocks.photoshop }, svcHyper: { writeSvgToClipboard: mocks.clipboard }, svcState: { getConfig: mocks.config }, svcAdobeBridge: { exportAsset: mocks.adobe } }) }))
import { useCanvasBridgeActions } from './useCanvasBridgeActions'

const plain: CanvasImageItem = { id: 'plain', type: 'image', src: 'data:image/png;base64,QQ==', x: 0, y: 0, width: 100, height: 100, rotation: 0, scaleX: 1, scaleY: 1, zIndex: 0, locked: false }
const cropped: CanvasImageItem = { ...plain, id: 'crop', src: 'data:image/png;base64,Qg==', crop: { x: 0, y: 0, width: 50, height: 50 } }

beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer }))) })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

function setup(items: CanvasImageItem[]) {
  const raster = vi.fn(async () => 'data:image/png;base64,QQ==')
  const svg = vi.fn(async () => '<svg/>')
  const error = vi.fn(), success = vi.fn()
  const before = structuredClone(items.map(({ image: _image, ...item }) => item))
  const events = vi.spyOn(window, 'dispatchEvent')
  const hook = renderHook(() => useCanvasBridgeActions({ canvasId: 'fixture', projectName: 'Fixture', items, groups: [], notifyError: error, notifySuccess: success, extractPromptTextFromCanvasItems: () => '', renderCanvasItemsImageDataUrl: raster, renderCanvasItemsSvgMarkup: svg }))
  return { hook, raster, svg, error, success, items, before, events }
}

async function selectTarget(test: ReturnType<typeof setup>, items: CanvasImageItem[], target: 'photoshop' | 'figma' | 'after-effects' | 'premiere') {
  act(() => test.hook.result.current.handleOpenAgentSendMenu(document.createElement('button'), items))
  await act(async () => { test.hook.result.current.handleSelectAgentTargetApp(target); await new Promise((resolve) => setTimeout(resolve, 0)) })
}

describe('external target menu cropped selection boundary', () => {
  it.each(['photoshop', 'figma', 'after-effects', 'premiere'] as const)('rejects mixed crop selection before %s side effects', async (target) => {
    const test = setup([cropped, plain])
    await selectTarget(test, [cropped, plain], target)
    expect.soft(test.error).toHaveBeenCalledOnce()
    expect.soft(String(test.error.mock.calls[0]?.[0] ?? '')).toMatch(/crop/i)
    expect.soft(test.raster).not.toHaveBeenCalled()
    expect.soft(test.svg).not.toHaveBeenCalled()
    expect.soft(fetch).not.toHaveBeenCalled()
    expect.soft(mocks.photoshop).not.toHaveBeenCalled()
    expect.soft(mocks.clipboard).not.toHaveBeenCalled()
    expect.soft(mocks.adobe).not.toHaveBeenCalled()
    expect.soft(mocks.config).not.toHaveBeenCalled()
    expect.soft(mocks.dispatch).not.toHaveBeenCalled()
    expect.soft(test.events).not.toHaveBeenCalled()
    expect.soft(test.success).not.toHaveBeenCalled()
    expect(test.items.map(({ image: _image, ...item }) => item)).toEqual(test.before)
    test.hook.unmount()
  })
  it('also rejects a direct cropped Photoshop call before rendering', async () => {
    const test = setup([cropped])
    await act(async () => { await test.hook.result.current.handleSendCanvasItemsSnapshotToPhotoshop([cropped]) })
    expect(test.error).toHaveBeenCalledWith('Cannot safely export or copy cropped images yet. Removing the crop exposes the full original.')
    expect(test.raster).not.toHaveBeenCalled()
    expect(mocks.photoshop).not.toHaveBeenCalled()
    expect(test.items.map(({ image: _image, ...item }) => item)).toEqual(test.before)
  })
  it('sends an uncropped selection to the mock Photoshop bridge', async () => {
    const test = setup([plain])
    await selectTarget(test, [plain], 'photoshop')
    expect(test.raster).toHaveBeenCalledWith([plain], false)
    expect(mocks.photoshop).toHaveBeenCalledWith(expect.objectContaining({ imageUrl: 'data:image/png;base64,QQ==' }))
    expect(test.error).not.toHaveBeenCalled()
    test.hook.unmount()
  })
  it('sends an uncropped selection to the mock Figma clipboard', async () => {
    const test = setup([plain])
    await selectTarget(test, [plain], 'figma')
    expect(test.svg).toHaveBeenCalledWith([plain], false)
    expect(mocks.clipboard).toHaveBeenCalledWith({ svg: '<svg/>' })
    expect(test.error).not.toHaveBeenCalled()
  })
  it.each(['after-effects', 'premiere'] as const)('sends an uncropped selection to mock %s', async (target) => {
    const test = setup([plain])
    await selectTarget(test, [plain], target)
    expect(test.raster).toHaveBeenCalledWith([plain], false)
    expect(mocks.config).toHaveBeenCalledOnce()
    expect(mocks.adobe).toHaveBeenCalledWith(expect.objectContaining({ target, mimeType: 'image/png' }))
    expect(test.error).not.toHaveBeenCalled()
  })
})
