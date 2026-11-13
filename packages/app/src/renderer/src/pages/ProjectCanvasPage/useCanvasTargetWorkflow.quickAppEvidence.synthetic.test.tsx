// Synthetic jsdom seam: real workflow and assignment binding; model and QuickApp runtime are mocked.
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasImageItem } from './types'

const f = vi.hoisted(() => ({ plan: vi.fn(), quickApp: vi.fn(), stage: vi.fn(), summary: vi.fn(), chat: vi.fn() }))
vi.mock('react-redux', () => ({ useDispatch: () => vi.fn() }))
vi.mock('../../hooks/useConfig', () => ({ useConfig: () => ({ config: { llm_config: { api_profiles: [] }, plugin_config: {}, download_dir: '' }, buildEnv: { pathMap: { data: '' } } }) }))
vi.mock('../../utils/windowUtils', () => ({ api: () => ({ svcTargetScheme: { listTargetSchemes: async () => ({ schemes: [{ id: 'scheme', name: 'Scheme', description: 'fixture', files: [], enabled: true, createdAt: '2026-01-01', updatedAt: '2026-01-01' }] }), listTargetHistoryTargets: async () => ({ targets: [] }), saveTargetHistoryTarget: async () => ({}) }, svcLLMProxy: { listProfiles: async () => ({ profiles: [{ id: 'vision', model_name: 'Vision', is_vision_model: true }] }) }, svcQApp: {} }) }))
vi.mock('@renderer/features/projectTrace/projectTraceRuntime', () => ({ emitProjectTraceRuntimeEvent: vi.fn(), writeProjectTraceTargetReferenceState: vi.fn() }))
vi.mock('@renderer/features/projectTrace/projectTraceProjectRef', () => ({ resolveCanvasProjectTraceProjectRef: async () => null }))
vi.mock('./canvasTargetCapabilityQApps', () => ({ loadCanvasTargetCapabilityCatalog: async () => ({ quickApps: [], canvasActions: [] }) }))
vi.mock('./canvasTargetExternalAgentBridge', () => ({ waitForCanvasTargetProgressPaint: async () => {}, appendMessageToExternalChat: f.chat, openExternalAgentPane: async () => ({}), openExternalChatSession: async () => 'fixture-session', requestExternalChatConfirmation: async () => true, setExternalChatSessionLoading: vi.fn(), terminateExternalChatSession: vi.fn() }))
vi.mock('./canvasTargetWorkflow', async (original) => ({ ...await original<object>(), requestCanvasTargetControlPlan: f.plan, requestCanvasTargetStageExecution: f.stage, requestCanvasTargetSummaryExecution: f.summary }))
vi.mock('./canvasTargetQuickAppRuntime', () => ({ runCanvasTargetQuickAppAction: f.quickApp }))
import { useCanvasTargetWorkflow } from './useCanvasTargetWorkflow'

const base: CanvasImageItem = { id: 'A', type: 'image', src: 'data:image/png;base64,QQ==', x: 0, y: 0, width: 100, height: 100, rotation: 0, scaleX: 1, scaleY: 1, zIndex: 1, locked: false }
const other: CanvasImageItem = { ...base, id: 'B', src: 'data:image/png;base64,Qg==', x: 200 }
const noop = vi.fn()
const options: Parameters<typeof useCanvasTargetWorkflow>[0] = { canvasId: 'canvas', projectName: 'Fixture', isChineseUi: false, items: [base, other], selectedIds: new Set(['A']), groups: [], buildCanvasAssetMetadata: () => [], resolveCanvasTargetItemBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }), renderCanvasItemsImageDataUrl: async () => 'data:image/png;base64,U05BUA==', setSelectionRect: noop, setItemsWithHistory: noop, setSelectedIds: noop, setGroups: noop, setTool: noop, handleBgColorChange: noop, setShowGrid: noop, setAnnoTool: noop, setAnnotationColor: noop, setAnnotationStrokeWidth: noop, setAnnotationFillOpacity: noop, nextZIndexRef: { current: 2 }, notifySuccess: noop, notifyError: noop, notifyWarning: noop, notifyInfo: noop, resolveActiveAgentScope: () => 'fixture', openTargetManager: noop }

beforeEach(() => {
  vi.clearAllMocks()
  f.quickApp.mockResolvedValue({ content: 'ok', attachments: [], placedCanvasItems: [], placedCanvasItemIds: [], qAppName: 'fixture', canvasDispatchCount: 0 })
  f.stage.mockResolvedValue({ content: 'fixture', attachments: [] })
  f.summary.mockResolvedValue({ content: 'fixture', attachments: [] })
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network prohibited')))
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(cb, 0))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('QuickApp planned item references and evidence mode boundary', () => {
  it.each([
    { mode: 'selected_sources', id: 'B' },
    { mode: 'structured_only', id: 'B' },
    { mode: 'selection_region', id: 'B' }
  ] as const)('$mode rejects a mixed authorized/unauthorized assignment atomically', async ({ mode, id }) => {
    f.plan.mockResolvedValue({ id: 'plan', generatedAt: '2026-01-01T00:00:00Z', summary: 'fixture', rawResponse: 'fixture', stageInstructions: [], capabilityActions: [{ id: 'quick', type: 'quick_app', qAppKey: 'fixture-app', phase: 'before_model_stages', outputTarget: 'agent', inputAssignments: [{ slot: 'image', itemIds: ['A', id] }] }] })
    const hook = renderHook(() => useCanvasTargetWorkflow(options))
    await act(async () => { await hook.result.current.handleOpenCanvasTargetDialog([base], { x: 0, y: 0, width: 50, height: 50 }) })
    act(() => { hook.result.current.setCanvasTargetEvidenceMode(mode); hook.result.current.setCanvasTargetUserIntent('fixture') })
    await act(async () => { await hook.result.current.handleRunCanvasTarget() })
    expect(f.plan).toHaveBeenCalledOnce()
    expect(f.quickApp).not.toHaveBeenCalled()
    hook.unmount()
  })

  it.each(['structured_only', 'selection_region'] as const)('%s rejects even selected original item as a QuickApp reference', async (mode) => {
    f.plan.mockResolvedValue({ id: 'plan', generatedAt: '2026-01-01T00:00:00Z', summary: 'fixture', rawResponse: 'fixture', stageInstructions: [], capabilityActions: [{ id: 'quick', type: 'quick_app', qAppKey: 'fixture-app', phase: 'before_model_stages', outputTarget: 'agent', inputAssignments: [{ slot: 'image', itemIds: ['A'] }] }] })
    const hook = renderHook(() => useCanvasTargetWorkflow(options))
    await act(async () => { await hook.result.current.handleOpenCanvasTargetDialog([base], { x: 0, y: 0, width: 50, height: 50 }) })
    act(() => { hook.result.current.setCanvasTargetEvidenceMode(mode); hook.result.current.setCanvasTargetUserIntent('fixture') })
    await act(async () => { await hook.result.current.handleRunCanvasTarget() })
    expect(f.plan).toHaveBeenCalledOnce()
    expect(f.quickApp).not.toHaveBeenCalled()
    hook.unmount()
  })

  it.each([
    { mode: 'selected_sources', id: 'B', allowed: false },
    { mode: 'structured_only', id: 'B', allowed: false },
    { mode: 'selection_region', id: 'B', allowed: false },
    { mode: 'selected_sources', id: 'A', allowed: true }
  ] as const)('$mode references $id', async ({ mode, id, allowed }) => {
    f.plan.mockResolvedValue({ id: 'plan', generatedAt: '2026-01-01T00:00:00Z', summary: 'fixture', rawResponse: 'fixture', stageInstructions: [], capabilityActions: [{ id: 'quick', type: 'quick_app', qAppKey: 'fixture-app', phase: 'before_model_stages', outputTarget: 'agent', inputAssignments: [{ slot: 'image', itemIds: [id] }] }] })
    const hook = renderHook(() => useCanvasTargetWorkflow(options))
    await act(async () => { await hook.result.current.handleOpenCanvasTargetDialog([base], { x: 0, y: 0, width: 50, height: 50 }) })
    act(() => { hook.result.current.setCanvasTargetEvidenceMode(mode); hook.result.current.setCanvasTargetUserIntent('fixture') })
    await act(async () => { await hook.result.current.handleRunCanvasTarget() })
    expect(f.plan).toHaveBeenCalledOnce()
    const calls = f.quickApp.mock.calls.map(([arg]) => arg)
    if (allowed) {
      expect(calls).toHaveLength(1)
      expect(calls[0].resolvedInputAssignmentAttachments[0]).toEqual(expect.arrayContaining([expect.objectContaining({ url: base.src })]))
    } else {
      expect(JSON.stringify(calls)).not.toContain(other.src)
    }
    hook.unmount()
  })
})
