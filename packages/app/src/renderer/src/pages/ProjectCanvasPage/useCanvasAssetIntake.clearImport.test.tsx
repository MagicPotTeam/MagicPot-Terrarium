import React from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import { useCanvasAssetIntake } from './useCanvasAssetIntake'
import { useCanvasViewportPersistence } from './useCanvasViewportPersistence'
import { useProjectCanvasPageRuntimeState } from './useProjectCanvasPageRuntimeState'
import type { CanvasImageItem, CanvasTextItem } from './types'

const storage = vi.hoisted(() => ({ importFile: vi.fn(), load: vi.fn(), save: vi.fn(), clear: vi.fn() }))
vi.mock('./canvasStorage', () => ({
  importCanvasFile: storage.importFile,
  loadCanvasItems: storage.load,
  saveCanvasItems: storage.save,
  clearCanvasItems: storage.clear
}))
vi.mock('./canvasAssetIntakeHelpers', async (importOriginal) => ({
  ...await importOriginal<typeof import('./canvasAssetIntakeHelpers')>(),
  hydrateCanvasImageItemForCanvas: async (item: CanvasImageItem) => item
}))
vi.mock('../../utils/windowUtils', () => ({ api: () => ({}) }))

function text(id: string): CanvasTextItem {
  return { id, type: 'text', text: id, fontSize: 16, fontFamily: 'sans-serif', fill: '#fff',
    x: 0, y: 0, width: 100, height: 32, rotation: 0, scaleX: 1, scaleY: 1, zIndex: 0, locked: false }
}
function snapshot(id?: string) {
  return { items: id ? [text(id)] : [], groups: [], groupBranches: [], figmaBinding: null }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
async function flush() {
  for (let index = 0; index < 12; index++) await Promise.resolve()
}
const notify = () => undefined
const center = () => ({ x: 0, y: 0 })
const bounds = () => null
const clamp = (value: number) => value
const hydrate = async (item: CanvasImageItem) => item
const importFiles = async () => undefined

function linked(guardClear = true) {
  return renderHook(() => {
    const runtime = useProjectCanvasPageRuntimeState()
    const restoreGenerationRef = React.useRef(0)
    const nextZIndexRef = React.useRef(1)
    const [figmaBinding, setFigmaBinding] = React.useState<Parameters<typeof useCanvasViewportPersistence>[0]['figmaBinding']>(null)
    const intake = useCanvasAssetIntake({
      canvasId: 'clear-import-test', restoreGenerationRef, nextZIndexRef,
      setItemsWithHistory: runtime.setItemsWithHistory,
      setGroups: runtime.setGroups, setGroupBranches: runtime.setGroupBranches,
      setSelectedIds: runtime.setSelectedIds, setTool: runtime.setTool,
      notifyError: notify, notifyWarning: notify, notifySuccess: notify, getCenterPosition: center
    })
    const persistence = useCanvasViewportPersistence({
      config: DEFAULT_CONFIG, canvasId: 'clear-import-test', restoreGenerationRef,
      isCanvasSceneImporting: guardClear ? intake.isCanvasSceneImporting : undefined,
      items: runtime.items, groups: runtime.groups, groupBranches: runtime.groupBranches,
      selectedIds: runtime.selectedIds, figmaBinding,
      stagePos: runtime.stagePos, stageScale: runtime.stageScale, stageSize: runtime.stageSize,
      maxFitStageScale: 2, clampStageScale: clamp, getCanvasItemsVisualBounds: bounds,
      hydrateCanvasImageItemForCanvas: hydrate, nextZIndexRef,
      setItems: runtime.setItems, setItemsWithHistory: runtime.setItemsWithHistory,
      setGroups: runtime.setGroups, setGroupBranches: runtime.setGroupBranches,
      setSelectedIds: runtime.setSelectedIds, setStagePos: runtime.setStagePos,
      setStageScale: runtime.setStageScale, setFigmaBinding,
      handleImportFiles: importFiles, addModel3DToCanvas: notify, addVideoToCanvas: notify
    })
    return { runtime, intake, persistence, restoreGenerationRef }
  })
}
const file = () => new File(['synthetic'], 'test.mpcanvas')

beforeEach(() => {
  vi.useFakeTimers()
  storage.importFile.mockReset().mockResolvedValue(snapshot('fresh'))
  storage.load.mockReset().mockResolvedValue(snapshot())
  storage.save.mockReset().mockResolvedValue(undefined)
  storage.clear.mockReset().mockResolvedValue(undefined)
})
afterEach(async () => {
  cleanup()
  await flush()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('same-canvas Clear and import', () => {
  it('refuses Clear during an import without opening the confirmation dialog', async () => {
    const pending = deferred<ReturnType<typeof snapshot>>()
    storage.importFile.mockReturnValue(pending.promise)
    const hook = linked()
    await act(flush)
    const generation = hook.result.current.restoreGenerationRef.current
    let importing!: Promise<unknown>
    act(() => {
      importing = hook.result.current.intake.handleImportCanvasSceneFile(file())
      expect(hook.result.current.intake.isCanvasSceneImporting()).toBe(true)
      hook.result.current.persistence.openClearConfirmDialog()
      hook.result.current.persistence.handleConfirmClearDialog()
    })
    expect(hook.result.current.persistence.clearConfirmOpen).toBe(false)
    expect(hook.result.current.restoreGenerationRef.current).toBe(generation)
    expect(storage.clear).not.toHaveBeenCalled()
    await act(async () => {
      pending.resolve(snapshot('imported'))
      await importing
    })
    expect(hook.result.current.runtime.items.map(item => item.id)).toEqual(['imported'])
    expect(hook.result.current.intake.isCanvasSceneImporting()).toBe(false)
  })

  it('silently discards a late import result after Clear advances the shared generation', async () => {
    const pendingClear = deferred<void>()
    const pendingImport = deferred<ReturnType<typeof snapshot>>()
    storage.clear.mockReturnValue(pendingClear.promise)
    storage.importFile.mockReturnValue(pendingImport.promise)
    // Exercise the generation fallback for an independent Clear entry without the button guard.
    const hook = linked(false)
    await act(flush)
    const generation = hook.result.current.restoreGenerationRef.current
    let importing!: Promise<unknown>
    act(() => { importing = hook.result.current.intake.handleImportCanvasSceneFile(file()) })
    act(() => { hook.result.current.persistence.handleConfirmClearDialog() })
    expect(hook.result.current.restoreGenerationRef.current).toBe(generation + 1)
    await act(flush)
    expect(storage.clear).toHaveBeenCalledTimes(1)
    const late = snapshot('late')
    const lateItems = late.items
    const readItems = vi.fn(() => lateItems)
    Object.defineProperty(late, 'items', { get: readItems })
    let outcome: unknown
    await act(async () => {
      pendingClear.resolve()
      pendingImport.resolve(late)
      outcome = await importing
      await flush()
    })
    expect(hook.result.current.restoreGenerationRef.current).toBe(generation + 1)
    expect(outcome).toEqual([])
    expect(readItems).not.toHaveBeenCalled()
    expect(hook.result.current.runtime.items).toEqual([])
    expect(storage.save).not.toHaveBeenCalled()
  })

  it('allows a fresh import and normal saving after Clear completes', async () => {
    const hook = linked()
    await act(flush)
    act(() => { hook.result.current.persistence.openClearConfirmDialog() })
    expect(hook.result.current.persistence.clearConfirmOpen).toBe(true)
    await act(async () => {
      hook.result.current.persistence.handleConfirmClearDialog()
      await flush()
    })
    expect(storage.clear).toHaveBeenCalledExactlyOnceWith('clear-import-test')
    expect(hook.result.current.persistence.clearConfirmOpen).toBe(false)
    await act(async () => { await hook.result.current.intake.handleImportCanvasSceneFile(file()) })
    expect(hook.result.current.runtime.items.map(item => item.id)).toEqual(['fresh'])
    await act(async () => { await vi.advanceTimersByTimeAsync(1600) })
    expect(storage.save).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 'fresh' })]),
      'clear-import-test', [], [], null
    )
  })
})
