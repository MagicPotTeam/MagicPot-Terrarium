import React from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_CONFIG } from '@shared/config/config'
import type { CanvasGroup, CanvasGroupBranch, CanvasImageItem, CanvasItem } from './types'
import type { CanvasFigmaBinding } from '@shared/figma'
import { PROJECT_CANVAS_MAX_STAGE_SCALE } from './projectCanvasViewportScale'
import { useCanvasViewportPersistence } from './useCanvasViewportPersistence'

const mockClearCanvasItems = vi.fn()
const mockLoadCanvasItems = vi.fn()
const mockSaveCanvasItems = vi.fn()

vi.mock('./canvasStorage', () => ({
  clearCanvasItems: (...args: unknown[]) => mockClearCanvasItems(...args),
  loadCanvasItems: (...args: unknown[]) => mockLoadCanvasItems(...args),
  saveCanvasItems: (...args: unknown[]) => mockSaveCanvasItems(...args)
}))

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })

  return { promise, resolve, reject }
}

function createImageItem(overrides: Partial<CanvasImageItem> = {}): CanvasImageItem {
  return {
    id: 'img-1',
    type: 'image',
    src: 'https://example.com/canvas.png',
    x: 120,
    y: 80,
    width: 320,
    height: 180,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 4,
    locked: false,
    ...overrides
  }
}

describe('useCanvasViewportPersistence', () => {
  beforeEach(() => {
    mockClearCanvasItems.mockReset()
    mockLoadCanvasItems.mockReset()
    mockSaveCanvasItems.mockReset()
    mockSaveCanvasItems.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('allows fit view to zoom small selected images beyond 200 percent', () => {
    mockLoadCanvasItems.mockReturnValue(new Promise(() => {}))

    const { result } = renderHook(() => {
      const [items, setItems] = React.useState<CanvasItem[]>([
        createImageItem({
          id: 'small-wide-image',
          x: 40,
          y: 60,
          width: 144,
          height: 38
        })
      ])
      const [groups, setGroups] = React.useState<CanvasGroup[]>([])
      const [groupBranches, setGroupBranches] = React.useState<CanvasGroupBranch[]>([])
      const [selectedIds, setSelectedIds] = React.useState<Set<string>>(
        new Set(['small-wide-image'])
      )
      const [stagePos, setStagePos] = React.useState({ x: 0, y: 0 })
      const [stageScale, setStageScale] = React.useState(1)
      const [figmaBinding, setFigmaBinding] = React.useState<CanvasFigmaBinding | null>(null)

      const viewportPersistence = useCanvasViewportPersistence({
        config: DEFAULT_CONFIG,
        canvasId: 'canvas-fit-small-image-test',
        items,
        groups,
        groupBranches,
        selectedIds,
        figmaBinding,
        stagePos,
        stageScale,
        stageSize: { width: 1280, height: 720 },
        maxFitStageScale: PROJECT_CANVAS_MAX_STAGE_SCALE,
        clampStageScale: (value: number, max = PROJECT_CANVAS_MAX_STAGE_SCALE) =>
          Math.min(max, value),
        getCanvasItemsVisualBounds: () => null,
        hydrateCanvasImageItemForCanvas: vi.fn(async (item) => item),
        nextZIndexRef: { current: 1 },
        setItems,
        setItemsWithHistory: setItems,
        setGroups,
        setGroupBranches,
        setSelectedIds,
        setStagePos,
        setStageScale,
        setFigmaBinding,
        handleImportFiles: vi.fn(),
        addModel3DToCanvas: vi.fn(),
        addVideoToCanvas: vi.fn()
      })

      return { ...viewportPersistence, stageScale, stagePos }
    })

    act(() => {
      result.current.handleFitAll()
    })

    expect(result.current.stageScale).toBeGreaterThan(2)
    expect(result.current.stageScale).toBeCloseTo((1280 - 120) / 144)
    expect(result.current.stagePos.x).toBeCloseTo(
      1280 / 2 - (40 + 144 / 2) * result.current.stageScale
    )
  })

  it('restores the persisted scene before image hydration finishes', async () => {
    const restoredItem = createImageItem()
    const hydratedImage = document.createElement('img')
    const hydration = createDeferred<CanvasImageItem | null>()
    const hydrateCanvasImageItemForCanvas = vi.fn(() => hydration.promise)

    mockLoadCanvasItems.mockResolvedValue({
      items: [restoredItem],
      groups: [],
      groupBranches: [],
      figmaBinding: null
    })

    const nextZIndexRef = { current: 1 }

    const { result } = renderHook(() => {
      const [items, setItems] = React.useState<CanvasItem[]>([])
      const [groups, setGroups] = React.useState<CanvasGroup[]>([])
      const [groupBranches, setGroupBranches] = React.useState<CanvasGroupBranch[]>([])
      const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set())
      const [stagePos, setStagePos] = React.useState({ x: 0, y: 0 })
      const [stageScale, setStageScale] = React.useState(1)
      const [figmaBinding, setFigmaBinding] = React.useState<CanvasFigmaBinding | null>(null)

      useCanvasViewportPersistence({
        config: DEFAULT_CONFIG,
        canvasId: 'canvas-restore-test',
        items,
        groups,
        groupBranches,
        selectedIds,
        figmaBinding,
        stagePos,
        stageScale,
        stageSize: { width: 1280, height: 720 },
        maxFitStageScale: 2,
        clampStageScale: (value: number) => value,
        getCanvasItemsVisualBounds: () => null,
        hydrateCanvasImageItemForCanvas,
        nextZIndexRef,
        setItems,
        setItemsWithHistory: setItems,
        setGroups,
        setGroupBranches,
        setSelectedIds,
        setStagePos,
        setStageScale,
        setFigmaBinding,
        handleImportFiles: vi.fn(),
        addModel3DToCanvas: vi.fn(),
        addVideoToCanvas: vi.fn()
      })

      return { items }
    })

    await waitFor(() => {
      expect(result.current.items).toHaveLength(1)
    })

    expect(result.current.items[0]).toMatchObject(restoredItem)
    expect(result.current.items[0]).not.toHaveProperty('image')
    expect(hydrateCanvasImageItemForCanvas).toHaveBeenCalledWith(restoredItem)

    await act(async () => {
      hydration.resolve({
        ...restoredItem,
        image: hydratedImage
      })
      await hydration.promise
    })

    await waitFor(() => {
      expect((result.current.items[0] as CanvasImageItem).image).toBe(hydratedImage)
    })
  })

  it('does not save an empty canvas when unmounted during restore and restores again after remount', async () => {
    const pendingRestore = createDeferred<{
      items: CanvasItem[]
      groups: CanvasGroup[]
      groupBranches: CanvasGroupBranch[]
      figmaBinding: CanvasFigmaBinding | null
    }>()
    const restoredItem = createImageItem({ id: 'route-return-image' })

    mockLoadCanvasItems.mockReturnValueOnce(pendingRestore.promise).mockResolvedValueOnce({
      items: [restoredItem],
      groups: [],
      groupBranches: [],
      figmaBinding: null
    })
    const hydrateCanvasImageItemForCanvas = vi.fn(async (item: CanvasImageItem) => item)
    const handleImportFiles = vi.fn()
    const addModel3DToCanvas = vi.fn()
    const addVideoToCanvas = vi.fn()

    const renderPersistenceHook = () =>
      renderHook(() => {
        const [items, setItems] = React.useState<CanvasItem[]>([])
        const [groups, setGroups] = React.useState<CanvasGroup[]>([])
        const [groupBranches, setGroupBranches] = React.useState<CanvasGroupBranch[]>([])
        const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set())
        const [stagePos, setStagePos] = React.useState({ x: 0, y: 0 })
        const [stageScale, setStageScale] = React.useState(1)
        const [figmaBinding, setFigmaBinding] = React.useState<CanvasFigmaBinding | null>(null)

        useCanvasViewportPersistence({
          config: DEFAULT_CONFIG,
          canvasId: 'canvas-route-return-test',
          items,
          groups,
          groupBranches,
          selectedIds,
          figmaBinding,
          stagePos,
          stageScale,
          stageSize: { width: 1280, height: 720 },
          maxFitStageScale: 2,
          clampStageScale: (value: number) => value,
          getCanvasItemsVisualBounds: () => null,
          hydrateCanvasImageItemForCanvas,
          nextZIndexRef: React.useRef(1),
          setItems,
          setItemsWithHistory: setItems,
          setGroups,
          setGroupBranches,
          setSelectedIds,
          setStagePos,
          setStageScale,
          setFigmaBinding,
          handleImportFiles,
          addModel3DToCanvas,
          addVideoToCanvas
        })

        return { items }
      })

    const firstMount = renderPersistenceHook()

    expect(mockLoadCanvasItems).toHaveBeenCalledWith('canvas-route-return-test')

    firstMount.unmount()

    await act(async () => {
      pendingRestore.resolve({
        items: [createImageItem({ id: 'abandoned-route-image' })],
        groups: [],
        groupBranches: [],
        figmaBinding: null
      })
      await pendingRestore.promise
      await Promise.resolve()
    })

    expect(mockSaveCanvasItems).not.toHaveBeenCalledWith(
      [],
      'canvas-route-return-test',
      [],
      [],
      null
    )

    const secondMount = renderPersistenceHook()

    await waitFor(() => {
      expect(secondMount.result.current.items).toHaveLength(1)
    })

    expect(secondMount.result.current.items[0]).toMatchObject(restoredItem)
    expect(mockLoadCanvasItems).toHaveBeenCalledTimes(2)
    expect(mockLoadCanvasItems).toHaveBeenLastCalledWith('canvas-route-return-test')
  })

  it('persists locally without attempting automatic remote canvas sync, even in remote mode', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    mockLoadCanvasItems.mockResolvedValue({
      items: [],
      groups: [],
      groupBranches: [],
      figmaBinding: null
    })

    const { result } = renderHook(() => {
      const [items, setItems] = React.useState<CanvasItem[]>([])
      const [groups, setGroups] = React.useState<CanvasGroup[]>([])
      const [groupBranches, setGroupBranches] = React.useState<CanvasGroupBranch[]>([])
      const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set())
      const [stagePos, setStagePos] = React.useState({ x: 0, y: 0 })
      const [stageScale, setStageScale] = React.useState(1)
      const [figmaBinding, setFigmaBinding] = React.useState<CanvasFigmaBinding | null>(null)

      useCanvasViewportPersistence({
        config: {
          ...DEFAULT_CONFIG,
          use_remote_llm: true,
          remote_llm_server_config: {
            ...DEFAULT_CONFIG.remote_llm_server_config,
            server_origin: 'http://example.com:3721',
            access_token: 'proxy-secret'
          }
        },
        canvasId: 'canvas-sync-test',
        items,
        groups,
        groupBranches,
        selectedIds,
        figmaBinding,
        stagePos,
        stageScale,
        stageSize: { width: 1280, height: 720 },
        maxFitStageScale: 2,
        clampStageScale: (value: number) => value,
        getCanvasItemsVisualBounds: () => null,
        hydrateCanvasImageItemForCanvas: vi.fn(async (item) => item),
        nextZIndexRef: { current: 1 },
        setItems,
        setItemsWithHistory: setItems,
        setGroups,
        setGroupBranches,
        setSelectedIds,
        setStagePos,
        setStageScale,
        setFigmaBinding,
        handleImportFiles: vi.fn(),
        addModel3DToCanvas: vi.fn(),
        addVideoToCanvas: vi.fn()
      })

      return { items, setItems }
    })

    await act(async () => {
      await Promise.resolve()
    })
    expect(mockLoadCanvasItems).toHaveBeenCalledWith('canvas-sync-test')
    mockSaveCanvasItems.mockClear()

    act(() => {
      result.current.setItems([createImageItem({ id: 'sync-image-1' })])
    })

    await act(async () => {
      await Promise.resolve()
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200)
      await Promise.resolve()
    })

    expect(
      mockSaveCanvasItems.mock.calls.some(
        ([savedItems, savedCanvasId]) =>
          savedCanvasId === 'canvas-sync-test' &&
          Array.isArray(savedItems) &&
          savedItems.some(
            (item) =>
              typeof item === 'object' &&
              item !== null &&
              'id' in item &&
              item.id === 'sync-image-1'
          )
      )
    ).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('serializes autosaves so an older slow save cannot overwrite newer canvas state', async () => {
    vi.useFakeTimers()
    mockLoadCanvasItems.mockResolvedValue({
      items: [],
      groups: [],
      groupBranches: [],
      figmaBinding: null
    })
    const firstSave = createDeferred<void>()
    mockSaveCanvasItems.mockReturnValueOnce(firstSave.promise).mockResolvedValue(undefined)

    const { result } = renderHook(() => {
      const [items, setItems] = React.useState<CanvasItem[]>([])
      const [groups, setGroups] = React.useState<CanvasGroup[]>([])
      const [groupBranches, setGroupBranches] = React.useState<CanvasGroupBranch[]>([])
      const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set())
      const [stagePos, setStagePos] = React.useState({ x: 0, y: 0 })
      const [stageScale, setStageScale] = React.useState(1)
      const [figmaBinding, setFigmaBinding] = React.useState<CanvasFigmaBinding | null>(null)

      useCanvasViewportPersistence({
        config: DEFAULT_CONFIG,
        canvasId: 'canvas-serialized-save-test',
        items,
        groups,
        groupBranches,
        selectedIds,
        figmaBinding,
        stagePos,
        stageScale,
        stageSize: { width: 1280, height: 720 },
        maxFitStageScale: 2,
        clampStageScale: (value: number) => value,
        getCanvasItemsVisualBounds: () => null,
        hydrateCanvasImageItemForCanvas: vi.fn(async (item) => item),
        nextZIndexRef: { current: 1 },
        setItems,
        setItemsWithHistory: setItems,
        setGroups,
        setGroupBranches,
        setSelectedIds,
        setStagePos,
        setStageScale,
        setFigmaBinding,
        handleImportFiles: vi.fn(),
        addModel3DToCanvas: vi.fn(),
        addVideoToCanvas: vi.fn()
      })

      return { setItems }
    })

    await act(async () => {
      await Promise.resolve()
    })
    mockSaveCanvasItems.mockClear()

    act(() => {
      result.current.setItems([createImageItem({ id: 'slow-save-image' })])
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
      await Promise.resolve()
    })

    expect(mockSaveCanvasItems).toHaveBeenCalledTimes(1)
    expect(mockSaveCanvasItems).toHaveBeenLastCalledWith(
      [expect.objectContaining({ id: 'slow-save-image' })],
      'canvas-serialized-save-test',
      [],
      [],
      null
    )

    act(() => {
      result.current.setItems([createImageItem({ id: 'newer-save-image' })])
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
      await Promise.resolve()
    })

    expect(mockSaveCanvasItems).toHaveBeenCalledTimes(1)

    await act(async () => {
      firstSave.resolve()
      await firstSave.promise
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mockSaveCanvasItems).toHaveBeenCalledTimes(2)
    expect(mockSaveCanvasItems).toHaveBeenLastCalledWith(
      [expect.objectContaining({ id: 'newer-save-image' })],
      'canvas-serialized-save-test',
      [],
      [],
      null
    )
  })

  it('defers automatic canvas saves while large image import is active', async () => {
    vi.useFakeTimers()
    mockLoadCanvasItems.mockResolvedValue({
      items: [],
      groups: [],
      groupBranches: [],
      figmaBinding: null
    })

    const { result } = renderHook(() => {
      const [items, setItems] = React.useState<CanvasItem[]>([])
      const [groups, setGroups] = React.useState<CanvasGroup[]>([])
      const [groupBranches, setGroupBranches] = React.useState<CanvasGroupBranch[]>([])
      const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set())
      const [stagePos, setStagePos] = React.useState({ x: 0, y: 0 })
      const [stageScale, setStageScale] = React.useState(1)
      const [figmaBinding, setFigmaBinding] = React.useState<CanvasFigmaBinding | null>(null)
      const [suspendAutoSave, setSuspendAutoSave] = React.useState(false)

      useCanvasViewportPersistence({
        config: DEFAULT_CONFIG,
        canvasId: 'canvas-import-save-test',
        items,
        groups,
        groupBranches,
        selectedIds,
        figmaBinding,
        stagePos,
        stageScale,
        stageSize: { width: 1280, height: 720 },
        maxFitStageScale: 2,
        clampStageScale: (value: number) => value,
        getCanvasItemsVisualBounds: () => null,
        hydrateCanvasImageItemForCanvas: vi.fn(async (item) => item),
        nextZIndexRef: { current: 1 },
        setItems,
        setItemsWithHistory: setItems,
        setGroups,
        setGroupBranches,
        setSelectedIds,
        setStagePos,
        setStageScale,
        setFigmaBinding,
        handleImportFiles: vi.fn(),
        addModel3DToCanvas: vi.fn(),
        addVideoToCanvas: vi.fn(),
        suspendAutoSave
      })

      return { setItems, setSuspendAutoSave }
    })

    await act(async () => {
      await Promise.resolve()
    })
    mockSaveCanvasItems.mockClear()

    act(() => {
      result.current.setSuspendAutoSave(true)
      result.current.setItems([createImageItem({ id: 'import-image-1' })])
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200)
      await Promise.resolve()
    })

    expect(mockSaveCanvasItems).not.toHaveBeenCalled()

    act(() => {
      result.current.setSuspendAutoSave(false)
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
      await Promise.resolve()
    })

    expect(mockSaveCanvasItems).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'import-image-1' })],
      'canvas-import-save-test',
      [],
      [],
      null
    )
  })
})
