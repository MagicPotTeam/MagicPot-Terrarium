import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasImageItem } from './types'

const f = vi.hoisted(() => ({
  plan: vi.fn(), stage: vi.fn(), summary: vi.fn(), load: vi.fn(), extract: vi.fn(), hydrate: vi.fn(), chat: vi.fn(), commits: vi.fn(), errors: vi.fn(), target: 'both',
}))
vi.mock('react-redux', () => ({ useDispatch: () => vi.fn() }))
vi.mock('../../hooks/useConfig', () => ({ useConfig: () => ({ config: { llm_config: { api_profiles: [] }, plugin_config: {}, download_dir: '' }, buildEnv: { pathMap: { data: '' } } }) }))
vi.mock('../../utils/windowUtils', () => ({ api: () => ({ svcTargetScheme: { listTargetSchemes: async () => ({ schemes: [{ id: 'scheme', name: 'Scheme', description: 'fixture', files: [], enabled: true, createdAt: '2026-01-01', updatedAt: '2026-01-01' }] }), listTargetHistoryTargets: async () => ({ targets: [] }), saveTargetHistoryTarget: async () => ({}) }, svcLLMProxy: { listProfiles: async () => ({ profiles: [{ id: 'vision', model_name: 'Vision', is_vision_model: true }] }) }, svcQApp: {} }) }))
vi.mock('@renderer/features/projectTrace/projectTraceRuntime', () => ({ emitProjectTraceRuntimeEvent: vi.fn(), writeProjectTraceTargetReferenceState: vi.fn() }))
vi.mock('@renderer/features/projectTrace/projectTraceProjectRef', () => ({ resolveCanvasProjectTraceProjectRef: async () => null }))
vi.mock('./canvasTargetCapabilityQApps', () => ({ loadCanvasTargetCapabilityCatalog: async () => ({ quickApps: [], canvasActions: [] }) }))
vi.mock('./canvasAssetIntakeHelpers', async (importOriginal) => ({ ...await importOriginal<object>(), loadImageFromSrc: f.load, hydrateCanvasImageItemForCanvas: f.hydrate }))
vi.mock('./localImageExtract', () => ({ extractImageRegionLocally: f.extract }))
vi.mock('./canvasTargetExternalAgentBridge', () => ({ waitForCanvasTargetProgressPaint: async () => {}, appendMessageToExternalChat: f.chat, openExternalAgentPane: async () => ({}), openExternalChatSession: async () => 'fixture-session', requestExternalChatConfirmation: async () => true, setExternalChatSessionLoading: vi.fn(), terminateExternalChatSession: vi.fn() }))
vi.mock('./canvasTargetWorkflow', async (importOriginal) => ({ ...await importOriginal<object>(), requestCanvasTargetControlPlan: f.plan, requestCanvasTargetStageExecution: f.stage, requestCanvasTargetSummaryExecution: f.summary }))
import { useCanvasTargetWorkflow } from './useCanvasTargetWorkflow'

const source = 'data:image/png;base64,SYNTHETIC_SOURCE'
const image: CanvasImageItem = { id: 'source', type: 'image', src: source, sourceWidth: 200, sourceHeight: 200, crop: { x: 50, y: 50, width: 100, height: 100 }, x: 0, y: 0, width: 100, height: 100, rotation: 0, scaleX: 1, scaleY: 1, zIndex: 1, locked: false }
const noop = vi.fn()
const options: Parameters<typeof useCanvasTargetWorkflow>[0] = { canvasId: 'canvas', projectName: 'Fixture', isChineseUi: false, items: [image], selectedIds: new Set(['source']), groups: [], buildCanvasAssetMetadata: () => [], resolveCanvasTargetItemBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }), renderCanvasItemsImageDataUrl: async () => 'data:image/png;base64,SNAPSHOT', setSelectionRect: noop, setItemsWithHistory: f.commits, setSelectedIds: noop, setGroups: noop, setTool: noop, handleBgColorChange: noop, setShowGrid: noop, setAnnoTool: noop, setAnnotationColor: noop, setAnnotationStrokeWidth: noop, setAnnotationFillOpacity: noop, nextZIndexRef: { current: 2 }, notifySuccess: noop, notifyError: f.errors, notifyWarning: noop, notifyInfo: noop, resolveActiveAgentScope: () => 'fixture', openTargetManager: noop }

beforeEach(() => {
  vi.clearAllMocks()
  f.load.mockResolvedValue({ width: 200, height: 200 })
  f.extract.mockResolvedValue({ blob: new Blob(['synthetic'], { type: 'image/png' }), sizeBytes: 9, sourceWidth: 20, sourceHeight: 20 })
  f.hydrate.mockImplementation(async ({ item }) => item)
  f.plan.mockImplementation(async () => ({ id: 'plan', generatedAt: '2026-01-01T00:00:00Z', summary: 'fixture', rawResponse: 'fixture', stageInstructions: [], capabilityActions: [{ id: 'extract', kind: 'canvas', action: 'extract_image_region', phase: 'before_model_stages', outputTarget: f.target, source: 'item_ids', itemIds: ['source'], coordinateSpace: 'source_image_pixels', x: 0, y: 0, width: 20, height: 20 }] }))
  f.stage.mockResolvedValue({ content: 'fixture', attachments: [] })
  f.summary.mockResolvedValue({ content: 'fixture', attachments: [] })
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unexpected network')))
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(cb, 0))
  vi.stubGlobal('URL', class extends URL { static createObjectURL = vi.fn(() => 'blob:extracted-fixture') })
})
afterEach(() => vi.unstubAllGlobals())

describe('Canvas Target evidence action gate', () => {
  it('does not render or retain a canvas screenshot for structured-only evidence', async () => {
    const snapshot = vi.fn(async () => 'data:image/png;base64,SYNTHETIC_PRIVATE_PIXELS')
    const { result } = renderHook(() => useCanvasTargetWorkflow({ ...options, renderCanvasItemsImageDataUrl: snapshot }))
    await act(async () => { await result.current.handleOpenCanvasTargetDialog([image], { x: 0, y: 0, width: 50, height: 50 }) })
    act(() => { result.current.setCanvasTargetEvidenceMode('structured_only'); result.current.setCanvasTargetUserIntent('fixture') })
    await act(async () => { await result.current.handleRunCanvasTarget() })
    expect(f.plan).toHaveBeenCalledOnce()
    expect(snapshot).not.toHaveBeenCalled()
    const request = f.plan.mock.calls[0][0] as { contextPack: { canvasSnapshot: unknown; designContext: { canvasSnapshot: unknown } }; attachments?: Array<{ url: string }> }
    expect(request.contextPack.canvasSnapshot).toBeNull()
    expect(request.contextPack.designContext.canvasSnapshot).toBeNull()
    expect(request.attachments?.some((attachment) => attachment.url === 'data:image/png;base64,SYNTHETIC_PRIVATE_PIXELS') ?? false).toBe(false)
  })

  it('does not transmit an unverified cropped selection screenshot in selection_region mode', async () => {
    const snapshotUrl = 'data:image/png;base64,SYNTHETIC_UNVERIFIED_PIXELS'
    const snapshot = vi.fn(async () => snapshotUrl)
    const { result } = renderHook(() => useCanvasTargetWorkflow({ ...options, renderCanvasItemsImageDataUrl: snapshot }))
    await act(async () => { await result.current.handleOpenCanvasTargetDialog([image], { x: 0, y: 0, width: 50, height: 50 }) })
    expect(result.current.canvasTargetDialogOpen).toBe(true)
    act(() => { result.current.setCanvasTargetEvidenceMode('selection_region'); result.current.setCanvasTargetUserIntent('fixture') })
    await act(async () => { await result.current.handleRunCanvasTarget() })
    expect(snapshot).not.toHaveBeenCalled()
    expect(f.plan).not.toHaveBeenCalled()
    expect(f.chat).not.toHaveBeenCalled()
    expect(result.current.canvasTargetError).toMatch(/crop/i)
  })
  it('does not add an unclipped final runtime snapshot to a selection_region run', async () => {
    const plain: CanvasImageItem = { ...image, crop: undefined }
    const snapshot = vi.fn(async () => 'data:image/png;base64,SNAPSHOT')
    const { result } = renderHook(() => useCanvasTargetWorkflow({ ...options, items: [plain], renderCanvasItemsImageDataUrl: snapshot }))
    const bounds = { x: 0, y: 0, width: 25, height: 25 }
    await act(async () => { await result.current.handleOpenCanvasTargetDialog([plain], bounds) })
    act(() => { result.current.setCanvasTargetEvidenceMode('selection_region'); result.current.setCanvasTargetUserIntent('fixture') })
    await act(async () => { await result.current.handleRunCanvasTarget() })
    expect(f.plan).toHaveBeenCalledOnce()
    expect(f.summary).toHaveBeenCalledOnce()
    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(snapshot).toHaveBeenCalledWith([plain], false, bounds)
    const summaryRequest = f.summary.mock.calls[0][0] as { attachments?: Array<{ fileName?: string }> }
    expect(summaryRequest.attachments?.some((attachment) => attachment.fileName === 'canvas-target-final-evidence.png') ?? false).toBe(false)
  })

  it('does not label the original selection as final canvas evidence', async () => {
    const plain: CanvasImageItem = { ...image, crop: undefined }
    const other: CanvasImageItem = { ...plain, id: 'unselected', src: 'data:image/png;base64,UNSELECTED', x: 200 }
    const snapshot = vi.fn(async () => 'data:image/png;base64,SNAPSHOT')
    f.plan.mockResolvedValue({ id: 'plan', generatedAt: '2026-01-01T00:00:00Z', summary: 'fixture', rawResponse: 'fixture', stageInstructions: [], capabilityActions: [] })
    const { result } = renderHook(() => useCanvasTargetWorkflow({
      ...options, items: [plain, other], selectedIds: new Set(['source', 'unselected']), renderCanvasItemsImageDataUrl: snapshot
    }))
    await act(async () => { await result.current.handleOpenCanvasTargetDialog([plain], { x: 0, y: 0, width: 50, height: 50 }) })
    act(() => { result.current.setCanvasTargetEvidenceMode('selected_sources'); result.current.setCanvasTargetUserIntent('fixture') })
    await act(async () => { await result.current.handleRunCanvasTarget() })
    expect(f.plan).toHaveBeenCalledOnce()
    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(snapshot).toHaveBeenCalledWith([plain], false, { x: 0, y: 0, width: 50, height: 50 })
    const summary = f.summary.mock.calls[0][0] as { attachments?: Array<{ fileName?: string }> }
    expect(summary.attachments?.some((attachment) => attachment.fileName === 'canvas-target-final-evidence.png') ?? false).toBe(false)
  })

  it('warns that final visual acceptance is unverified even if the summary claims ACCEPTED', async () => {
    const plain: CanvasImageItem = { ...image, crop: undefined }
    const warnings = vi.fn()
    const success = vi.fn()
    f.plan.mockResolvedValue({ id: 'plan', generatedAt: '2026-01-01T00:00:00Z', summary: 'fixture', rawResponse: 'fixture', stageInstructions: [], capabilityActions: [] })
    f.summary.mockResolvedValue({ content: 'ACCEPTED\nLooks good.', attachments: [] })
    const { result } = renderHook(() => useCanvasTargetWorkflow({ ...options, items: [plain], notifyWarning: warnings, notifySuccess: success }))
    await act(async () => { await result.current.handleOpenCanvasTargetDialog([plain], { x: 0, y: 0, width: 50, height: 50 }) })
    act(() => { result.current.setCanvasTargetEvidenceMode('selected_sources'); result.current.setCanvasTargetUserIntent('fixture') })
    await act(async () => { await result.current.handleRunCanvasTarget() })
    expect(f.summary).toHaveBeenCalledOnce()
    expect(success).not.toHaveBeenCalled()
    expect(warnings.mock.calls.some(([message]) => /final|visual/i.test(message) && /not|unverif/i.test(message))).toBe(true)
    expect(f.chat.mock.calls.some(([message]) => /final|visual/i.test(message.content || '') && /not|unverif/i.test(message.content || ''))).toBe(true)
  })

  it('does not send final evidence from a copy of an unselected canvas source', async () => {
    const selected: CanvasImageItem = { ...image, crop: undefined, src: 'data:image/png;base64,SELECTED' }
    const other: CanvasImageItem = { ...selected, id: 'unselected', src: 'data:image/png;base64,UNSELECTED', x: 200 }
    const snapshot = vi.fn(async () => 'data:image/png;base64,SNAPSHOT')
    f.plan.mockResolvedValue({
      id: 'plan', generatedAt: '2026-01-01T00:00:00Z', summary: 'fixture', rawResponse: 'fixture', stageInstructions: [],
      capabilityActions: [{ type: 'canvas', id: 'copy-all', action: 'duplicate_items', phase: 'before_model_stages', outputTarget: 'canvas', source: 'all_canvas', count: 1 }]
    })
    const { result } = renderHook(() => useCanvasTargetWorkflow({
      ...options, items: [selected, other], selectedIds: new Set([selected.id]), renderCanvasItemsImageDataUrl: snapshot
    }))
    await act(async () => { await result.current.handleOpenCanvasTargetDialog([selected], { x: 0, y: 0, width: 50, height: 50 }) })
    act(() => { result.current.setCanvasTargetEvidenceMode('selected_sources'); result.current.setCanvasTargetUserIntent('fixture') })
    await act(async () => { await result.current.handleRunCanvasTarget() })
    expect(f.plan).toHaveBeenCalledOnce()
    expect(f.commits).toHaveBeenCalled()
    const copiedItems = f.commits.mock.calls.at(-1)?.[0] as CanvasImageItem[]
    expect(copiedItems.some((item) => item.id !== other.id && item.src === other.src)).toBe(true)
    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(snapshot).toHaveBeenCalledWith([selected], false, { x: 0, y: 0, width: 50, height: 50 })
    const summary = f.summary.mock.calls[0][0] as { attachments?: Array<{ fileName?: string }> }
    expect(summary.attachments?.some((attachment) => attachment.fileName === 'canvas-target-final-evidence.png') ?? false).toBe(false)
  })

  it('rejects a changed source selection before sending selection-region evidence', async () => {
    const plain: CanvasImageItem = { ...image, crop: undefined }
    const changed: CanvasImageItem = { ...plain, src: 'data:image/png;base64,DIFFERENT' }
    const snapshot = vi.fn(async () => 'data:image/png;base64,SNAPSHOT')
    const { result, rerender } = renderHook(({ current }) => useCanvasTargetWorkflow({
      ...options, items: [current], renderCanvasItemsImageDataUrl: snapshot
    }), { initialProps: { current: plain } })
    await act(async () => { await result.current.handleOpenCanvasTargetDialog([plain], { x: 0, y: 0, width: 50, height: 50 }) })
    act(() => { result.current.setCanvasTargetEvidenceMode('selection_region'); result.current.setCanvasTargetUserIntent('fixture') })
    rerender({ current: changed })
    await act(async () => { await result.current.handleRunCanvasTarget() })
    expect(snapshot).not.toHaveBeenCalled()
    expect(f.plan).not.toHaveBeenCalled()
    expect(result.current.canvasTargetError).toMatch(/selection|changed/i)
  })

  it('rejects a changed source during screenshot preparation before issuing a model request', async () => {
    const plain: CanvasImageItem = { ...image, crop: undefined }
    const changed: CanvasImageItem = { ...plain, src: 'data:image/png;base64,CHANGED_DURING_CAPTURE' }
    let finish!: (url: string) => void
    const snapshot = vi.fn(() => new Promise<string>((resolve) => { finish = resolve }))
    const { result, rerender } = renderHook(({ current }) => useCanvasTargetWorkflow({
      ...options, items: [current], renderCanvasItemsImageDataUrl: snapshot
    }), { initialProps: { current: plain } })
    await act(async () => { await result.current.handleOpenCanvasTargetDialog([plain], { x: 0, y: 0, width: 50, height: 50 }) })
    act(() => { result.current.setCanvasTargetEvidenceMode('selection_region'); result.current.setCanvasTargetUserIntent('fixture') })
    let pending!: Promise<void>
    await act(async () => { pending = result.current.handleRunCanvasTarget(); await Promise.resolve() })
    expect(snapshot).toHaveBeenCalledOnce()
    rerender({ current: changed })
    await act(async () => { finish('data:image/png;base64,UNTRUSTED'); await pending })
    expect(f.plan).not.toHaveBeenCalled()
    expect(f.chat).not.toHaveBeenCalled()
    expect(result.current.canvasTargetError).toMatch(/selection|changed/i)
  })

  it('positive control: selected_sources executes model-plan extract', async () => {
    f.target = 'both'
    const { result } = renderHook(() => useCanvasTargetWorkflow(options))
    await act(async () => { await result.current.handleOpenCanvasTargetDialog([image], { x: 0, y: 0, width: 50, height: 50 }) })
    expect(result.current.canvasTargetDialogOpen).toBe(true)
    act(() => { result.current.setCanvasTargetEvidenceMode('selected_sources'); result.current.setCanvasTargetUserIntent('fixture') })
    await act(async () => { await result.current.handleRunCanvasTarget() })
    expect(result.current.canvasTargetError).toBeNull()
    await waitFor(() => expect(f.extract).toHaveBeenCalled())
    expect(f.load).toHaveBeenCalledWith(source)
    expect(f.plan).toHaveBeenCalledOnce()
    expect(f.commits).toHaveBeenCalled()
  })
  it.each(['all_canvas', 'item_ids'] as const)('rejects the whole selected_sources action when %s includes an unselected image', async (kind) => {
    const other: CanvasImageItem = { ...image, id: 'unselected', src: 'data:image/png;base64,UNSELECTED', x: 200 }
    f.target = 'both'
    const originalPlan = f.plan.getMockImplementation()!
    f.plan.mockImplementation(async (...args) => {
      const plan = await originalPlan(...args)
      const action = { ...plan.capabilityActions[0], source: kind, itemIds: kind === 'item_ids' ? ['source', 'unselected'] : undefined }
      return { ...plan, capabilityActions: [action] }
    })
    const { result } = renderHook(() => useCanvasTargetWorkflow({ ...options, items: [image, other], nextZIndexRef: { current: 2 } }))
    await act(async () => { await result.current.handleOpenCanvasTargetDialog([image], { x: 0, y: 0, width: 50, height: 50 }) })
    expect(result.current.canvasTargetDialogOpen).toBe(true)
    act(() => { result.current.setCanvasTargetEvidenceMode('selected_sources'); result.current.setCanvasTargetUserIntent('fixture') })
    await act(async () => { await result.current.handleRunCanvasTarget() })
    expect(f.plan).toHaveBeenCalledOnce()
    const plannedAction = (await f.plan.mock.results[0].value).capabilityActions[0]
    expect(plannedAction.source).toBe(kind)
    if (kind === 'item_ids') expect(plannedAction.itemIds).toEqual(['source', 'unselected'])
    expect.soft(f.load).not.toHaveBeenCalled()
    expect.soft(f.extract).not.toHaveBeenCalled()
    expect.soft(f.commits).not.toHaveBeenCalled()
    expect.soft(f.chat.mock.calls.some(([message]) => message.attachments?.some((attachment: { url: string }) => attachment.url === 'blob:extracted-fixture'))).toBe(false)
  })
  it.each(['canvas', 'both'] as const)('blocks extract in selection_region for an uncropped source with %s output', async (output) => {
    f.target = output
    const plain: CanvasImageItem = { ...image, crop: undefined }
    const { result } = renderHook(() => useCanvasTargetWorkflow({ ...options, items: [plain] }))
    await act(async () => { await result.current.handleOpenCanvasTargetDialog([plain], { x: 0, y: 0, width: 50, height: 50 }) })
    act(() => { result.current.setCanvasTargetEvidenceMode('selection_region'); result.current.setCanvasTargetUserIntent('fixture') })
    await act(async () => { await result.current.handleRunCanvasTarget() })
    expect(f.plan).toHaveBeenCalledOnce()
    expect(f.load).not.toHaveBeenCalledWith(source)
    expect(f.extract).not.toHaveBeenCalled()
    expect(f.commits).not.toHaveBeenCalled()
    expect(f.chat.mock.calls.some(([message]) => message.attachments?.some((attachment: { url: string }) => attachment.url === 'blob:extracted-fixture'))).toBe(false)
  })

  it.each([['structured_only', 'canvas'], ['structured_only', 'both'], ['selection_region', 'canvas'], ['selection_region', 'both']] as const)('blocks extract in %s with %s output', async (mode, output) => {
    f.target = output
    const { result } = renderHook(() => useCanvasTargetWorkflow(options))
    await act(async () => { await result.current.handleOpenCanvasTargetDialog([image], { x: 0, y: 0, width: 50, height: 50 }) })
    expect(result.current.canvasTargetDialogOpen).toBe(true)
    act(() => { result.current.setCanvasTargetEvidenceMode(mode); result.current.setCanvasTargetUserIntent('fixture') })
    await act(async () => { await result.current.handleRunCanvasTarget() })
    expect(f.plan).toHaveBeenCalledOnce()
    expect.soft(f.load).not.toHaveBeenCalledWith(source)
    expect.soft(f.extract).not.toHaveBeenCalled()
    expect.soft(f.commits).not.toHaveBeenCalled()
    expect.soft(f.chat.mock.calls.some(([message]) => message.attachments?.some((attachment: { url: string }) => attachment.url === 'blob:extracted-fixture'))).toBe(false)
    // No model stage is configured in this fixture; downstream model transmission is not covered.
  })
})
