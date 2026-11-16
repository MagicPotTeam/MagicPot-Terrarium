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

  it.each([['structured_only', 'canvas'], ['structured_only', 'both']] as const)('blocks extract in %s with %s output', async (mode, output) => {
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

  // Re-expressed under owner decision 2: this fixture is a legacy crop with no
  // recorded source size or hash, so selection_region refuses it before
  // planning (the same contract as 'does not transmit an unverified cropped
  // selection screenshot in selection_region mode' above). The post-plan
  // extraction gate stays covered by the uncropped selection_region rows. A
  // verified-crop variant that reaches the plan arrives with crop provenance.
  it.each([['selection_region', 'canvas'], ['selection_region', 'both']] as const)('blocks extract in %s with %s output', async (mode, output) => {
    f.target = output
    const { result } = renderHook(() => useCanvasTargetWorkflow(options))
    await act(async () => { await result.current.handleOpenCanvasTargetDialog([image], { x: 0, y: 0, width: 50, height: 50 }) })
    expect(result.current.canvasTargetDialogOpen).toBe(true)
    act(() => { result.current.setCanvasTargetEvidenceMode(mode); result.current.setCanvasTargetUserIntent('fixture') })
    await act(async () => { await result.current.handleRunCanvasTarget() })
    expect(f.plan).not.toHaveBeenCalled()
    expect(result.current.canvasTargetError).toMatch(/crop/i)
    expect.soft(f.load).not.toHaveBeenCalledWith(source)
    expect.soft(f.extract).not.toHaveBeenCalled()
    expect.soft(f.commits).not.toHaveBeenCalled()
    expect.soft(f.chat.mock.calls.some(([message]) => message.attachments?.some((attachment: { url: string }) => attachment.url === 'blob:extracted-fixture'))).toBe(false)
  })

  // Selection authority (canvasTargetSelectionAuthority): every source a model
  // plan reads must be a selected original, unchanged since selection.
  const extractAction = { id: 'extract', kind: 'canvas', action: 'extract_image_region', phase: 'before_model_stages', outputTarget: 'both', source: 'item_ids', coordinateSpace: 'source_image_pixels', x: 0, y: 0, width: 20, height: 20 }
  const extractedInChat = () => f.chat.mock.calls.some(([message]) => message.attachments?.some((attachment: { url: string }) => attachment.url === 'blob:extracted-fixture'))

  it('refuses a selected_sources extraction that also names an id missing from the canvas', async () => {
    const plain: CanvasImageItem = { ...image, crop: undefined }
    f.plan.mockResolvedValue({ id: 'plan', generatedAt: '2026-01-01T00:00:00Z', summary: 'fixture', rawResponse: 'fixture', stageInstructions: [], capabilityActions: [{ ...extractAction, itemIds: ['source', 'ghost'] }] })
    const { result } = renderHook(() => useCanvasTargetWorkflow({ ...options, items: [plain] }))
    await act(async () => { await result.current.handleOpenCanvasTargetDialog([plain], { x: 0, y: 0, width: 50, height: 50 }) })
    act(() => { result.current.setCanvasTargetEvidenceMode('selected_sources'); result.current.setCanvasTargetUserIntent('fixture') })
    await act(async () => { await result.current.handleRunCanvasTarget() })
    expect(f.plan).toHaveBeenCalledOnce()
    expect(f.load).not.toHaveBeenCalled()
    expect(f.extract).not.toHaveBeenCalled()
    expect(f.commits).not.toHaveBeenCalled()
    expect(extractedInChat()).toBe(false)
    // The refusal is shown in the Agent conversation.
    expect(f.chat.mock.calls.some(([message]) => /Image extraction skipped because a source was not selected/.test(message.content || ''))).toBe(true)
  })

  it('refuses a selected_sources extraction from a selected source the run changed after selection', async () => {
    const plain: CanvasImageItem = { ...image, crop: undefined }
    f.plan.mockResolvedValue({
      id: 'plan', generatedAt: '2026-01-01T00:00:00Z', summary: 'fixture', rawResponse: 'fixture', stageInstructions: [],
      capabilityActions: [
        { type: 'canvas', id: 'crop', action: 'crop_image', phase: 'before_model_stages', outputTarget: 'canvas', source: 'item_ids', itemIds: ['source'], coordinateSpace: 'source_item_normalized', cropX: 0, cropY: 0, cropWidth: 0.5, cropHeight: 1 },
        { ...extractAction, itemIds: ['source'] }
      ]
    })
    const { result } = renderHook(() => useCanvasTargetWorkflow({ ...options, items: [plain] }))
    await act(async () => { await result.current.handleOpenCanvasTargetDialog([plain], { x: 0, y: 0, width: 50, height: 50 }) })
    act(() => { result.current.setCanvasTargetEvidenceMode('selected_sources'); result.current.setCanvasTargetUserIntent('fixture') })
    await act(async () => { await result.current.handleRunCanvasTarget() })
    expect(f.plan).toHaveBeenCalledOnce()
    // The crop itself is a canvas edit and is committed; the extraction that
    // would read the changed source is not.
    expect(f.commits).toHaveBeenCalledTimes(1)
    expect((f.commits.mock.calls[0][0] as CanvasImageItem[])[0].crop).toBeDefined()
    expect(f.load).not.toHaveBeenCalled()
    expect(f.extract).not.toHaveBeenCalled()
    expect(extractedInChat()).toBe(false)
  })

  it('refuses a structured_only run whose selection changed (undo) after the dialog opened', async () => {
    const plain: CanvasImageItem = { ...image, crop: undefined }
    const undone: CanvasImageItem = { ...plain, src: 'data:image/png;base64,BEFORE_UNDO' }
    const snapshot = vi.fn(async () => 'data:image/png;base64,SNAPSHOT')
    const { result, rerender } = renderHook(({ current }) => useCanvasTargetWorkflow({
      ...options, items: [current], renderCanvasItemsImageDataUrl: snapshot
    }), { initialProps: { current: plain } })
    await act(async () => { await result.current.handleOpenCanvasTargetDialog([plain], { x: 0, y: 0, width: 50, height: 50 }) })
    act(() => { result.current.setCanvasTargetEvidenceMode('structured_only'); result.current.setCanvasTargetUserIntent('fixture') })
    rerender({ current: undone })
    await act(async () => { await result.current.handleRunCanvasTarget() })
    expect(snapshot).not.toHaveBeenCalled()
    expect(f.plan).not.toHaveBeenCalled()
    expect(result.current.canvasTargetError).toMatch(/selection|changed/i)
  })

  it('stops a running target when the user starts a new selection before the model request', async () => {
    const plain: CanvasImageItem = { ...image, crop: undefined }
    let finish!: (url: string) => void
    const snapshot = vi.fn(() => new Promise<string>((resolve) => { finish = resolve }))
    const { result } = renderHook(() => useCanvasTargetWorkflow({ ...options, items: [plain], renderCanvasItemsImageDataUrl: snapshot }))
    await act(async () => { await result.current.handleOpenCanvasTargetDialog([plain], { x: 0, y: 0, width: 50, height: 50 }) })
    act(() => { result.current.setCanvasTargetEvidenceMode('selection_region'); result.current.setCanvasTargetUserIntent('fixture') })
    let pending!: Promise<void>
    await act(async () => { pending = result.current.handleRunCanvasTarget(); await Promise.resolve() })
    expect(snapshot).toHaveBeenCalledOnce()
    act(() => { result.current.handleBeginCanvasTargetSelection() })
    await act(async () => { finish('data:image/png;base64,SNAPSHOT'); await pending })
    expect(f.plan).not.toHaveBeenCalled()
    expect(f.chat).not.toHaveBeenCalled()
  })

  it('renders only the selected item into a selection_region screenshot when a neighbour lies inside the box', async () => {
    const plain: CanvasImageItem = { ...image, crop: undefined }
    const neighbour: CanvasImageItem = { ...plain, id: 'neighbour', src: 'data:image/png;base64,NEIGHBOUR', x: 10, y: 10 }
    const snapshot = vi.fn(async () => 'data:image/png;base64,SNAPSHOT')
    f.plan.mockResolvedValue({ id: 'plan', generatedAt: '2026-01-01T00:00:00Z', summary: 'fixture', rawResponse: 'fixture', stageInstructions: [], capabilityActions: [] })
    const { result } = renderHook(() => useCanvasTargetWorkflow({ ...options, items: [plain, neighbour], selectedIds: new Set(['source']), renderCanvasItemsImageDataUrl: snapshot }))
    await act(async () => { await result.current.handleOpenCanvasTargetDialog([plain], { x: 0, y: 0, width: 100, height: 100 }) })
    act(() => { result.current.setCanvasTargetEvidenceMode('selection_region'); result.current.setCanvasTargetUserIntent('fixture') })
    await act(async () => { await result.current.handleRunCanvasTarget() })
    expect(f.plan).toHaveBeenCalledOnce()
    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(snapshot).toHaveBeenCalledWith([plain], false, { x: 0, y: 0, width: 100, height: 100 })
    expect(JSON.stringify(f.plan.mock.calls[0][0])).not.toContain('NEIGHBOUR')
  })

  it.each(['selected_sources', 'selection_region', 'structured_only'] as const)('refuses an add_image whose model-authored URL is the source of an unselected item (%s)', async (mode) => {
    const plain: CanvasImageItem = { ...image, crop: undefined }
    const other: CanvasImageItem = { ...plain, id: 'unselected', src: 'blob:unselected-source', x: 200 }
    const added = vi.fn()
    window.addEventListener('canvas:add-image', added)
    f.plan.mockResolvedValue({
      id: 'plan', generatedAt: '2026-01-01T00:00:00Z', summary: 'fixture', rawResponse: 'fixture', stageInstructions: [],
      capabilityActions: [{ type: 'canvas', id: 'add', action: 'add_image', phase: 'before_model_stages', outputTarget: 'both', sourceUrl: other.src, fileName: 'b.png' }]
    })
    const { result } = renderHook(() => useCanvasTargetWorkflow({ ...options, items: [plain, other] }))
    await act(async () => { await result.current.handleOpenCanvasTargetDialog([plain], { x: 0, y: 0, width: 50, height: 50 }) })
    act(() => { result.current.setCanvasTargetEvidenceMode(mode); result.current.setCanvasTargetUserIntent('fixture') })
    await act(async () => { await result.current.handleRunCanvasTarget() })
    window.removeEventListener('canvas:add-image', added)
    expect(f.plan).toHaveBeenCalledOnce()
    expect(added).not.toHaveBeenCalled()
    // The plan's own text may echo the URL; no attachment may carry it.
    const attachmentUrls = [...f.chat.mock.calls, ...f.summary.mock.calls].flatMap(([request]) => (request?.attachments || []).map((attachment: { url: string }) => attachment.url))
    expect(attachmentUrls).not.toContain(other.src)
  })

  // A model-authored add_* URL may name only a selected, unchanged source (in
  // selected_sources) or a blob this run produced. The URL guard matches what
  // the browser resolves (fragment, scheme case, escapes, control characters)
  // and remembers sources the run deleted, so none of these variants of an
  // unselected item's blob URL reaches the canvas, the Agent conversation, a
  // stage or the summary model request.
  const unselectedBlob = 'blob:http://localhost/unselected-source'
  const blobVariants = [
    ['fragment', `${unselectedBlob}#x`],
    ['scheme case', `BLOB:${unselectedBlob.slice(5)}`],
    ['percent escape', 'blob:http://localhost/%75nselected-source'],
    ['tab inside', 'blob:http://local\thost/unselected-source'],
    ['upper-case origin', 'blob:HTTP://LOCALHOST/unselected-source']
  ] as const
  const placedUrlsIn = (calls: unknown[][]) => calls.flatMap(([request]) => ((request as { attachments?: Array<{ url: string }> })?.attachments || []).map((attachment) => attachment.url))
  const leakedUnselectedBlob = () => [...placedUrlsIn(f.chat.mock.calls), ...placedUrlsIn(f.stage.mock.calls), ...placedUrlsIn(f.summary.mock.calls)].some((url) => url.toLowerCase().replace(/%75/g, 'u').replace(/\s/g, '').includes('localhost/unselected-source'))
  const runAddPlan = async (mode: 'selected_sources' | 'structured_only', capabilityActions: unknown[], extraItems: CanvasImageItem[] = []) => {
    const plain: CanvasImageItem = { ...image, crop: undefined }
    const other: CanvasImageItem = { ...plain, id: 'unselected', src: unselectedBlob, x: 200 }
    const added = vi.fn()
    window.addEventListener('canvas:add-image', added)
    f.plan.mockResolvedValue({ id: 'plan', generatedAt: '2026-01-01T00:00:00Z', summary: 'fixture', rawResponse: 'fixture', stageInstructions: [], capabilityActions })
    const { result } = renderHook(() => useCanvasTargetWorkflow({ ...options, items: [plain, other, ...extraItems] }))
    await act(async () => { await result.current.handleOpenCanvasTargetDialog([plain], { x: 0, y: 0, width: 50, height: 50 }) })
    act(() => { result.current.setCanvasTargetEvidenceMode(mode); result.current.setCanvasTargetUserIntent('fixture') })
    await act(async () => { await result.current.handleRunCanvasTarget() })
    window.removeEventListener('canvas:add-image', added)
    expect(f.plan).toHaveBeenCalledOnce()
    return { added }
  }

  describe.each(['selected_sources', 'structured_only'] as const)('add_image URL guard in %s', (mode) => {
    it.each(blobVariants)('refuses a %s variant of an unselected item\'s blob URL', async (_label, sourceUrl) => {
      const { added } = await runAddPlan(mode, [{ type: 'canvas', id: 'add', action: 'add_image', phase: 'before_model_stages', outputTarget: 'both', sourceUrl, fileName: 'b.png' }])
      expect(added).not.toHaveBeenCalled()
      expect(leakedUnselectedBlob()).toBe(false)
      expect(f.chat.mock.calls.some(([message]) => /Canvas add_image skipped/.test(message.content || ''))).toBe(true)
    })

    it('refuses to re-add an unselected item\'s blob URL after the plan deleted the item', async () => {
      const { added } = await runAddPlan(mode, [
        { type: 'canvas', id: 'delete', action: 'delete_items', phase: 'before_model_stages', outputTarget: 'canvas', source: 'item_ids', itemIds: ['unselected'] },
        { type: 'canvas', id: 'add', action: 'add_image', phase: 'before_model_stages', outputTarget: 'both', sourceUrl: unselectedBlob, fileName: 'b.png' }
      ])
      expect(added).not.toHaveBeenCalled()
      expect(leakedUnselectedBlob()).toBe(false)
    })

    it('refuses an add_image whose URL is neither a selected source nor a result of this run', async () => {
      const { added } = await runAddPlan(mode, [{ type: 'canvas', id: 'add', action: 'add_image', phase: 'before_model_stages', outputTarget: 'both', sourceUrl: 'blob:http://localhost/unknown-origin', fileName: 'r.png' }])
      expect(added).not.toHaveBeenCalled()
      expect(f.chat.mock.calls.some(([message]) => /neither a selected source nor a result of this run/.test(message.content || ''))).toBe(true)
    })
  })

  it('places a selected source named by a variant URL in selected_sources, as its canonical URL', async () => {
    const selected: CanvasImageItem = { ...image, crop: undefined, src: 'blob:http://localhost/selected-source' }
    const added = vi.fn((event: Event) => {
      const detail = (event as CustomEvent<{ onAdded?: (item: unknown) => void }>).detail
      detail.onAdded?.({ ...selected, id: 'placed' })
    })
    window.addEventListener('canvas:add-image', added)
    f.plan.mockResolvedValue({
      id: 'plan', generatedAt: '2026-01-01T00:00:00Z', summary: 'fixture', rawResponse: 'fixture', stageInstructions: [],
      capabilityActions: [{ type: 'canvas', id: 'add', action: 'add_image', phase: 'before_model_stages', outputTarget: 'both', sourceUrl: `${selected.src}#copy`, fileName: 'a.png' }]
    })
    const { result } = renderHook(() => useCanvasTargetWorkflow({ ...options, items: [selected] }))
    await act(async () => { await result.current.handleOpenCanvasTargetDialog([selected], { x: 0, y: 0, width: 50, height: 50 }) })
    act(() => { result.current.setCanvasTargetEvidenceMode('selected_sources'); result.current.setCanvasTargetUserIntent('fixture') })
    await act(async () => { await result.current.handleRunCanvasTarget() })
    window.removeEventListener('canvas:add-image', added)
    expect(added).toHaveBeenCalledOnce()
    expect((added.mock.calls[0][0] as CustomEvent<{ src: string }>).detail.src).toBe(selected.src)
  })

  // A selected text note that holds the blob URL of media nobody selected
  // (another canvas tab, a deleted image whose blob is alive) is not that
  // media's source: the run must not place it or send its bytes.
  it('refuses an add_image whose URL a selected text note only mentions (selected_sources)', async () => {
    const offCanvas = 'blob:http://localhost/image-on-another-canvas'
    const note = { id: 'note', type: 'text', text: offCanvas, fontSize: 12, fontFamily: 'x', fill: '#000', x: 0, y: 0, width: 100, height: 20, rotation: 0, scaleX: 1, scaleY: 1, zIndex: 1, locked: false } as const
    const added = vi.fn((event: Event) => {
      const detail = (event as CustomEvent<{ src: string; onAdded?: (item: unknown) => void }>).detail
      detail.onAdded?.({ ...image, id: 'placed', src: detail.src })
    })
    window.addEventListener('canvas:add-image', added)
    f.plan.mockResolvedValue({
      id: 'plan', generatedAt: '2026-01-01T00:00:00Z', summary: 'fixture', rawResponse: 'fixture', stageInstructions: [],
      capabilityActions: [{ type: 'canvas', id: 'add', action: 'add_image', phase: 'before_model_stages', outputTarget: 'both', sourceUrl: offCanvas, fileName: 'x.png' }]
    })
    const { result } = renderHook(() => useCanvasTargetWorkflow({ ...options, items: [note], selectedIds: new Set(['note']) }))
    await act(async () => { await result.current.handleOpenCanvasTargetDialog([note], { x: 0, y: 0, width: 50, height: 50 }) })
    act(() => { result.current.setCanvasTargetEvidenceMode('selected_sources'); result.current.setCanvasTargetUserIntent('fixture') })
    await act(async () => { await result.current.handleRunCanvasTarget() })
    window.removeEventListener('canvas:add-image', added)
    expect(f.plan).toHaveBeenCalledOnce()
    expect(added).not.toHaveBeenCalled()
    expect([...placedUrlsIn(f.chat.mock.calls), ...placedUrlsIn(f.stage.mock.calls), ...placedUrlsIn(f.summary.mock.calls)]).not.toContain(offCanvas)
    expect(f.chat.mock.calls.some(([message]) => /Canvas add_image skipped/.test(message.content || ''))).toBe(true)
  })

  // Positive control (re-expressed from 'add_image with a URL no canvas item
  // carries is still placed'): add_* may place a blob this run produced, here
  // a model stage output. Like the real addImageToCanvas, the canvas keeps
  // the blob src, so the stage output is already on the canvas as the item
  // the run placed for it when the add action runs.
  it('positive control: add_image with a blob URL this run produced is placed', async () => {
    const plain: CanvasImageItem = { ...image, crop: undefined }
    const added = vi.fn((event: Event) => {
      const detail = (event as CustomEvent<{ src: string; onAdded?: (item: unknown) => void }>).detail
      detail.onAdded?.({ ...plain, id: `placed-${added.mock.calls.length}`, src: detail.src })
    })
    window.addEventListener('canvas:add-image', added)
    f.stage.mockResolvedValue({ content: 'fixture', attachments: [{ type: 'image', url: 'blob:http://localhost/stage-output', fileName: 'out.png' }] })
    f.plan.mockResolvedValue({
      id: 'plan', generatedAt: '2026-01-01T00:00:00Z', summary: 'fixture', rawResponse: 'fixture',
      stageInstructions: [{ id: 'stage-1', label: 'Stage', modelId: 'vision', prompt: 'fixture' }],
      capabilityActions: [{ type: 'canvas', id: 'add', action: 'add_image', phase: 'after_model_stages', outputTarget: 'both', sourceUrl: 'blob:http://localhost/stage-output', fileName: 'r.png' }]
    })
    const { result } = renderHook(() => useCanvasTargetWorkflow({ ...options, items: [plain] }))
    await act(async () => { await result.current.handleOpenCanvasTargetDialog([plain], { x: 0, y: 0, width: 50, height: 50 }) })
    act(() => { result.current.setCanvasTargetEvidenceMode('structured_only'); result.current.setCanvasTargetUserIntent('fixture') })
    await act(async () => { await result.current.handleRunCanvasTarget() })
    window.removeEventListener('canvas:add-image', added)
    expect(f.stage).toHaveBeenCalledOnce()
    const addDetails = added.mock.calls.map(([event]) => (event as CustomEvent<{ src: string; generationSessionId?: string }>).detail)
    // One dispatch materializes the stage output, the other is the add action.
    expect(addDetails.filter((detail) => !String(detail.generationSessionId).includes('media-output'))).toEqual([
      expect.objectContaining({ src: 'blob:http://localhost/stage-output' })
    ])
  })

  // Write side: a run may change or remove only the items the user selected
  // and the items it created itself. Everything else on the board, and the
  // user's groups around it, stays as it was.
  describe('canvas write authority', () => {
    const plain: CanvasImageItem = { ...image, crop: undefined }
    const board: CanvasImageItem = { ...plain, id: 'board', src: 'data:image/png;base64,BOARD', x: 300 }
    const userGroups = [{ id: 'g-board', name: 'Client moodboard', itemIds: ['board'], createdAt: '2026-01-01' }, { id: 'g-source', name: 'Source', itemIds: ['source'], createdAt: '2026-01-01' }]
    const runPlan = async (mode: 'selected_sources' | 'structured_only', capabilityActions: unknown[]) => {
      const setGroups = vi.fn()
      f.plan.mockResolvedValue({ id: 'plan', generatedAt: '2026-01-01T00:00:00Z', summary: 'fixture', rawResponse: 'fixture', stageInstructions: [], capabilityActions })
      const { result } = renderHook(() => useCanvasTargetWorkflow({ ...options, items: [plain, board], groups: userGroups, setGroups }))
      await act(async () => { await result.current.handleOpenCanvasTargetDialog([plain], { x: 0, y: 0, width: 50, height: 50 }) })
      act(() => { result.current.setCanvasTargetEvidenceMode(mode); result.current.setCanvasTargetUserIntent('fixture') })
      await act(async () => { await result.current.handleRunCanvasTarget() })
      expect(f.plan).toHaveBeenCalledOnce()
      return { setGroups }
    }
    const committedIds = () => f.commits.mock.calls.map(([next]) => (next as CanvasImageItem[]).map((item) => item.id))
    const shown = (pattern: RegExp) => f.chat.mock.calls.some(([message]) => pattern.test(message.content || ''))

    describe.each(['selected_sources', 'structured_only'] as const)('in %s', (mode) => {
      it.each([
        ['delete_items item_ids', { action: 'delete_items', source: 'item_ids', itemIds: ['board'] }],
        ['delete_items all_canvas', { action: 'delete_items', source: 'all_canvas' }],
        ['clear_canvas', { action: 'clear_canvas', explicitUserIntent: true }],
        ['transform_items', { action: 'transform_items', source: 'item_ids', itemIds: ['board'], deltaX: 50 }],
        ['arrange_items all_canvas', { action: 'arrange_items', source: 'all_canvas' }],
        ['delete_group', { action: 'delete_group', groupId: 'g-board' }]
      ])('refuses %s on an unselected item and leaves it and its group unchanged', async (_label, fields) => {
        const { setGroups } = await runPlan(mode, [{ type: 'canvas', id: 'write', phase: 'before_model_stages', outputTarget: 'canvas', label: 'tidy', ...fields }])
        expect(f.commits).not.toHaveBeenCalled()
        expect(setGroups).not.toHaveBeenCalled()
        expect(shown(new RegExp(`Canvas ${fields.action} skipped because a source was not selected`))).toBe(true)
        // The run goes on after the refusal, as for a refused read.
        expect(f.summary).toHaveBeenCalledOnce()
      })
    })

    it('deletes a selected item without pruning its group, so undo restores both', async () => {
      const { setGroups } = await runPlan('selected_sources', [{ type: 'canvas', id: 'delete', action: 'delete_items', phase: 'before_model_stages', outputTarget: 'canvas', source: 'item_ids', itemIds: ['source'], label: 'remove source' }])
      expect(committedIds()).toEqual([['board']])
      expect(setGroups).not.toHaveBeenCalled()
      // The confirmation names how many items the delete removes.
      expect(shown(/Canvas delete_items: remove source \(before_model_stages, 1 item\(s\)\)/)).toBe(true)
    })

    it('may change the items the run created itself (a duplicate of the selected item)', async () => {
      await runPlan('structured_only', [
        { type: 'canvas', id: 'copy', action: 'duplicate_items', phase: 'before_model_stages', outputTarget: 'canvas', source: 'item_ids', itemIds: ['source'], count: 1 },
        { type: 'canvas', id: 'move', action: 'transform_items', phase: 'before_model_stages', outputTarget: 'canvas', source: 'current_selection', deltaX: 40 },
        { type: 'canvas', id: 'delete', action: 'delete_items', phase: 'before_model_stages', outputTarget: 'canvas', source: 'current_selection' }
      ])
      expect(f.commits).toHaveBeenCalledTimes(3)
      expect(committedIds().at(-1)).toEqual(['source', 'board'])
      expect(shown(/skipped because a source was not selected/)).toBe(false)
    })
  })

  // The extraction's output is placed on the canvas with its own blob src; a
  // later add_image of that URL re-places the run's own output.
  it('re-places the run\'s own extraction output (selected_sources)', async () => {
    const plain: CanvasImageItem = { ...image, crop: undefined }
    const added = vi.fn((event: Event) => {
      const detail = (event as CustomEvent<{ src: string; onAdded?: (item: unknown) => void }>).detail
      detail.onAdded?.({ ...plain, id: 'replaced', src: detail.src })
    })
    window.addEventListener('canvas:add-image', added)
    f.plan.mockResolvedValue({
      id: 'plan', generatedAt: '2026-01-01T00:00:00Z', summary: 'fixture', rawResponse: 'fixture', stageInstructions: [],
      capabilityActions: [
        { ...extractAction, itemIds: ['source'] },
        { type: 'canvas', id: 'add', action: 'add_image', phase: 'before_model_stages', outputTarget: 'both', sourceUrl: 'blob:extracted-fixture', fileName: 'again.png' }
      ]
    })
    const { result } = renderHook(() => useCanvasTargetWorkflow({ ...options, items: [plain] }))
    await act(async () => { await result.current.handleOpenCanvasTargetDialog([plain], { x: 0, y: 0, width: 50, height: 50 }) })
    act(() => { result.current.setCanvasTargetEvidenceMode('selected_sources'); result.current.setCanvasTargetUserIntent('fixture') })
    await act(async () => { await result.current.handleRunCanvasTarget() })
    window.removeEventListener('canvas:add-image', added)
    expect(f.extract).toHaveBeenCalledOnce()
    expect(added).toHaveBeenCalledOnce()
    expect((added.mock.calls[0][0] as CustomEvent<{ src: string }>).detail.src).toBe('blob:extracted-fixture')
  })

  // An add_* placement of a canvas source is not a run output: once the
  // selected source is gone, the run's copy of it does not make its URL
  // placeable again.
  it('does not treat a re-placed selected source as a run output after the source is deleted', async () => {
    const selected: CanvasImageItem = { ...image, crop: undefined, src: 'blob:http://localhost/selected-source' }
    const added = vi.fn((event: Event) => {
      const detail = (event as CustomEvent<{ src: string; onAdded?: (item: unknown) => void }>).detail
      detail.onAdded?.({ ...selected, id: `copy-${added.mock.calls.length}`, src: detail.src })
    })
    window.addEventListener('canvas:add-image', added)
    f.plan.mockResolvedValue({
      id: 'plan', generatedAt: '2026-01-01T00:00:00Z', summary: 'fixture', rawResponse: 'fixture', stageInstructions: [],
      capabilityActions: [
        { type: 'canvas', id: 'add-1', action: 'add_image', phase: 'before_model_stages', outputTarget: 'both', sourceUrl: selected.src, fileName: 'a.png' },
        { type: 'canvas', id: 'delete', action: 'delete_items', phase: 'before_model_stages', outputTarget: 'canvas', source: 'item_ids', itemIds: ['source'] },
        { type: 'canvas', id: 'add-2', action: 'add_image', phase: 'before_model_stages', outputTarget: 'both', sourceUrl: selected.src, fileName: 'a.png' }
      ]
    })
    const { result } = renderHook(() => useCanvasTargetWorkflow({ ...options, items: [selected] }))
    await act(async () => { await result.current.handleOpenCanvasTargetDialog([selected], { x: 0, y: 0, width: 50, height: 50 }) })
    act(() => { result.current.setCanvasTargetEvidenceMode('selected_sources'); result.current.setCanvasTargetUserIntent('fixture') })
    await act(async () => { await result.current.handleRunCanvasTarget() })
    window.removeEventListener('canvas:add-image', added)
    expect(f.commits).toHaveBeenCalledOnce()
    expect(added).toHaveBeenCalledOnce()
    expect(f.chat.mock.calls.some(([message]) => /Canvas add_image skipped/.test(message.content || ''))).toBe(true)
  })

  it('stops a structured_only run when the user starts a new selection while the plan is pending', async () => {
    const plain: CanvasImageItem = { ...image, crop: undefined }
    let finishPlan!: (plan: unknown) => void
    f.plan.mockImplementation(() => new Promise((resolve) => { finishPlan = resolve }))
    const { result } = renderHook(() => useCanvasTargetWorkflow({ ...options, items: [plain] }))
    await act(async () => { await result.current.handleOpenCanvasTargetDialog([plain], { x: 0, y: 0, width: 50, height: 50 }) })
    act(() => { result.current.setCanvasTargetEvidenceMode('structured_only'); result.current.setCanvasTargetUserIntent('fixture') })
    let pending!: Promise<void>
    await act(async () => { pending = result.current.handleRunCanvasTarget() })
    await waitFor(() => expect(f.plan).toHaveBeenCalledOnce())
    act(() => { result.current.handleBeginCanvasTargetSelection() })
    await act(async () => {
      finishPlan({ id: 'plan', generatedAt: '2026-01-01T00:00:00Z', summary: 'fixture', rawResponse: 'fixture', stageInstructions: [], capabilityActions: [{ type: 'canvas', id: 'text', action: 'add_text', phase: 'before_model_stages', outputTarget: 'both', text: 'fixture' }] })
      await pending
    })
    expect(f.summary).not.toHaveBeenCalled()
  })
})
