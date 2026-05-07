import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'

import ProjectCanvasPageStageScene from './ProjectCanvasPageStageScene'
import type {
  CanvasAnnotationItem,
  CanvasFileItem,
  CanvasImageItem,
  CanvasItem,
  CanvasModel3DItem,
  CanvasTextItem,
  CanvasVideoItem
} from './types'
import type { ProjectCanvasImagePreview } from './projectCanvasRenderBoundary'

const {
  measureCanvasAnnotationTextHeightMock,
  measureCanvasTextBoxHeightMock,
  syncItemPreviewSpy,
  syncViewportSpy,
  scheduleCanvasSyncMock,
  cancelCanvasSyncMock
} = vi.hoisted(() => ({
  measureCanvasAnnotationTextHeightMock: vi.fn(
    ({
      width,
      fontSize
    }: {
      width: number
      fontSize: number
      text?: string
      fontWeight?: 'normal' | 'bold'
    }) => Math.max(20, Math.round(fontSize * 1.15 + width * 0.06))
  ),
  measureCanvasTextBoxHeightMock: vi.fn(
    ({
      width,
      fontSize
    }: {
      width: number
      fontSize: number
      text?: string
      fontFamily?: string
    }) => Math.max(40, Math.round(fontSize * 1.5 + width * 0.12))
  ),
  syncItemPreviewSpy: vi.fn(),
  syncViewportSpy: vi.fn(),
  scheduleCanvasSyncMock: vi.fn(),
  cancelCanvasSyncMock: vi.fn()
}))

const canvasPlaceholderProps = new Map<string, Record<string, unknown>>()
const canvasPlaceholderRenderCounts = new Map<string, number>()
const imageInteractionOverlayProps = new Map<string, Record<string, unknown>>()
const cropOverlayProps = new Map<string, Record<string, unknown>>()
let latestMultiSelectionTransformOverlayProps: Record<string, unknown> | null = null
const rectInteractionOverlayProps = new Map<string, Record<string, unknown>>()
let latestWebGLItems: CanvasImageItem[] = []
let webglLayerRenderCount = 0
let webglReady = false
let webglLoadedIds = new Set<string>()
let webglResidentIds = new Set<string>()
let webglFailedIds = new Set<string>()
let latestWebGLMetrics: {
  isInitialized: boolean
  imageCount: number
  loadedImageCount: number
  failedImageCount: number
  residentImageCount: number
  residentTextureBytes: number
  residentCandidateTextureBytes: number
  residentTextureBudgetBytes: number
  pendingImageCount: number
  spriteCount: number
  residentCandidateImageCount: number
  viewportCulledImageCount: number
  usingPreviewImageCount: number
  usingSourceImageCount: number
  thumbnailPreviewImageCount: number
  placeholderImageCount: number
  sourceUpgradeSuppressedImageCount: number
  sourceUpgradeablePreviewImageCount: number
  sourceUpgradePendingImageCount: number
  sourceUpgradeFailedImageCount: number
  missingImageCount: number
  renderCount: number
  lastRenderDurationMs: number | null
  lastUpdateReason: 'initialize' | 'items' | 'preview' | 'cleanup'
} = {
  isInitialized: false,
  imageCount: 0,
  loadedImageCount: 0,
  failedImageCount: 0,
  residentImageCount: 0,
  residentTextureBytes: 0,
  residentCandidateTextureBytes: 0,
  residentTextureBudgetBytes: 768 * 1024 * 1024,
  pendingImageCount: 0,
  spriteCount: 0,
  residentCandidateImageCount: 0,
  viewportCulledImageCount: 0,
  usingPreviewImageCount: 0,
  usingSourceImageCount: 0,
  thumbnailPreviewImageCount: 0,
  placeholderImageCount: 0,
  sourceUpgradeSuppressedImageCount: 0,
  sourceUpgradeablePreviewImageCount: 0,
  sourceUpgradePendingImageCount: 0,
  sourceUpgradeFailedImageCount: 0,
  missingImageCount: 0,
  renderCount: 0,
  lastRenderDurationMs: null,
  lastUpdateReason: 'cleanup'
}
let latestWebGLLayerProps: {
  items: CanvasImageItem[]
  onReadyChange?: (ready: boolean) => void
  onResidentIdsChange?: (residentIds: Set<string>) => void
  onResolvedIdsChange?: (resolvedIds: Set<string>) => void
  onFailedIdsChange?: (failedIds: Set<string>) => void
  onMetricsChange?: (metrics: typeof latestWebGLMetrics) => void
} | null = null

vi.mock('./canvasTextLayout', () => ({
  CANVAS_TEXT_LINE_HEIGHT: 1.5,
  CANVAS_TEXT_PADDING: 12,
  CANVAS_TEXT_WRAP: 'char',
  measureCanvasAnnotationTextHeight: measureCanvasAnnotationTextHeightMock,
  measureCanvasTextBoxHeight: measureCanvasTextBoxHeightMock
}))

vi.mock('./components/canvasSync', () => ({
  scheduleCanvasSync: scheduleCanvasSyncMock,
  cancelCanvasSync: cancelCanvasSyncMock
}))

vi.mock('react-konva', async () => {
  const ReactModule = await import('react')

  const MockNode = ReactModule.forwardRef(function MockNode(
    props: { children?: React.ReactNode },
    _ref
  ) {
    return <div>{props.children}</div>
  })

  return {
    Stage: MockNode,
    Layer: MockNode,
    Rect: MockNode,
    Line: MockNode,
    Ellipse: MockNode,
    Arrow: MockNode,
    Group: MockNode
  }
})

vi.mock('../../components/MaxSizeLayout', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('./components/ProjectCanvasImageCropOverlay', () => ({
  default: (props: Record<string, unknown> & { item: CanvasImageItem }) => {
    cropOverlayProps.set(props.item.id, props)
    return <div data-testid={`crop-overlay-${props.item.id}`} />
  }
}))

vi.mock('./components/CanvasItemPlaceholder', () => ({
  default: function MockCanvasItemPlaceholder(
    props: Record<string, unknown> & { item: CanvasItem }
  ) {
    canvasPlaceholderRenderCounts.set(
      props.item.id,
      (canvasPlaceholderRenderCounts.get(props.item.id) ?? 0) + 1
    )

    React.useEffect(() => {
      canvasPlaceholderProps.set(props.item.id, props)
      return () => {
        canvasPlaceholderProps.delete(props.item.id)
      }
    })

    return <div data-testid={`canvas-placeholder-${props.item.id}`} />
  }
}))

vi.mock('./components/ProjectCanvasImageInteractionOverlay', () => ({
  default: function MockImageInteractionOverlay(
    props: Record<string, unknown> & { item: CanvasImageItem }
  ) {
    React.useEffect(() => {
      imageInteractionOverlayProps.set(props.item.id, props)
      return () => {
        imageInteractionOverlayProps.delete(props.item.id)
      }
    })

    return <div data-testid={`image-overlay-${props.item.id}`} />
  }
}))

vi.mock('./components/ProjectCanvasMultiSelectionTransformOverlay', () => ({
  default: function MockProjectCanvasMultiSelectionTransformOverlay(
    props: Record<string, unknown> & { items: CanvasImageItem[] }
  ) {
    latestMultiSelectionTransformOverlayProps = props

    return (
      <div
        data-testid="mock-multi-selection-transform-overlay"
        data-project-canvas-multi-selection-transform-overlay="true"
        data-item-ids={props.items.map((item) => item.id).join(',')}
      >
        <div data-canvas-multi-select-drag-surface="true" />
      </div>
    )
  }
}))

vi.mock('./components/ProjectCanvasRectItemInteractionOverlay', () => ({
  default: function MockProjectCanvasRectItemInteractionOverlay(
    props: Record<string, unknown> & { item: CanvasItem; overlayRole: string }
  ) {
    React.useEffect(() => {
      rectInteractionOverlayProps.set(props.item.id, props)
      return () => {
        rectInteractionOverlayProps.delete(props.item.id)
      }
    })

    return (
      <div data-testid={`rect-overlay-${props.item.id}`} data-overlay-role={props.overlayRole} />
    )
  }
}))

vi.mock('./components/ProjectCanvasWebGLImageLayer', async () => {
  const ReactModule = await import('react')

  return {
    __esModule: true,
    PROJECT_CANVAS_WEBGL_IMAGE_RESIDENT_LIMIT: 512,
    PROJECT_CANVAS_WEBGL_SOURCE_TEXTURE_MAX_SIDE: 4096,
    PROJECT_CANVAS_WEBGL_TEXTURE_BUDGET_BYTES: 768 * 1024 * 1024,
    default: ReactModule.memo(
      ReactModule.forwardRef(function MockProjectCanvasWebGLImageLayer(
        props: {
          items: CanvasImageItem[]
          onReadyChange?: (ready: boolean) => void
          onResidentIdsChange?: (residentIds: Set<string>) => void
          onResolvedIdsChange?: (resolvedIds: Set<string>) => void
          onFailedIdsChange?: (failedIds: Set<string>) => void
          onMetricsChange?: (metrics: typeof latestWebGLMetrics) => void
        },
        ref: React.ForwardedRef<{
          syncItemPreview: typeof syncItemPreviewSpy
          syncViewport: typeof syncViewportSpy
        }>
      ) {
        webglLayerRenderCount += 1
        latestWebGLItems = props.items
        latestWebGLLayerProps = props

        ReactModule.useImperativeHandle(ref, () => ({
          syncItemPreview: syncItemPreviewSpy,
          syncViewport: syncViewportSpy
        }))

        ReactModule.useEffect(() => {
          props.onReadyChange?.(webglReady)
          props.onResidentIdsChange?.(webglResidentIds)
          props.onResolvedIdsChange?.(webglLoadedIds)
          props.onFailedIdsChange?.(webglFailedIds)
          props.onMetricsChange?.(latestWebGLMetrics)
        }, [
          props.onFailedIdsChange,
          props.onResidentIdsChange,
          props.onMetricsChange,
          props.onReadyChange,
          props.onResolvedIdsChange
        ])

        return <div data-testid="mock-webgl-layer" />
      })
    )
  }
})

function createImageItem(id: string): CanvasImageItem {
  const image = document.createElement('img')
  Object.defineProperty(image, 'naturalWidth', { value: 200 })
  Object.defineProperty(image, 'naturalHeight', { value: 120 })

  return {
    id,
    type: 'image',
    src: `file:///${id}.png`,
    fileName: `${id}.png`,
    x: 100,
    y: 140,
    width: 200,
    height: 120,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false,
    hasAlpha: false,
    image
  }
}

function createFileItem(id: string): CanvasFileItem {
  return {
    id,
    type: 'file',
    src: `file:///${id}.md`,
    fileName: `${id}.md`,
    mimeType: 'text/markdown',
    fileKind: 'markdown',
    x: 180,
    y: 120,
    width: 320,
    height: 200,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 2,
    locked: false,
    editable: true
  }
}

function createModel3DItem(id: string): CanvasModel3DItem {
  return {
    id,
    type: 'model3d',
    src: `file:///${id}.glb`,
    fileName: `${id}.glb`,
    x: 120,
    y: 96,
    width: 240,
    height: 320,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 2,
    locked: false
  }
}

function createVideoItem(id: string): CanvasVideoItem {
  return {
    id,
    type: 'video',
    src: `file:///${id}.mp4`,
    fileName: `${id}.mp4`,
    x: 120,
    y: 96,
    width: 320,
    height: 180,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 2,
    locked: false,
    playing: false,
    muted: true,
    volume: 1
  }
}

function createTextItem(id: string): CanvasTextItem {
  return {
    id,
    type: 'text',
    text: 'Hello world',
    fontSize: 18,
    fontFamily: 'system-ui, sans-serif',
    fill: '#e0e0e0',
    x: 64,
    y: 96,
    width: 180,
    height: 51,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 3,
    locked: false
  }
}

function createAnnotationItem(
  id: string,
  overrides: Partial<CanvasAnnotationItem> = {}
): CanvasAnnotationItem {
  return {
    id,
    type: 'annotation',
    shape: 'rect',
    stroke: '#22c55e',
    fillOpacity: 0.25,
    strokeWidth: 4,
    label: 'Focus',
    x: 72,
    y: 84,
    width: 160,
    height: 100,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 4,
    locked: false,
    ...overrides
  }
}

function createBaseProps(visibleItems: CanvasItem[]) {
  return {
    activeOcrHover: null,
    annotationColor: '#ffffff',
    annotationFillOpacity: 0.5,
    bgColor: '#000000',
    canvasContainerRef: React.createRef<HTMLDivElement>(),
    canvasActiveRef: { current: false },
    croppingImageId: null,
    extractingImageId: null,
    cropOverlayRef: React.createRef<unknown>(),
    cursorStyle: 'default',
    drawingState: null,
    exactSelectedGroup: null,
    guidesGroupRef: React.createRef<unknown>(),
    gridColor: '#333333',
    handleDragEnd: vi.fn(),
    handleDragOver: vi.fn(),
    handleDrop: vi.fn(),
    handleImageContextMenu: vi.fn(),
    handleExtractImageRegion: vi.fn(),
    handleLayerDragEnd: vi.fn(),
    handleLayerDragMove: vi.fn(),
    handleLayerDragStart: vi.fn(),
    handleOpenFileDialog: vi.fn(),
    handleOpenModel3DViewer: vi.fn(),
    handleResize: vi.fn(),
    handleStageMouseDown: vi.fn(),
    handleStageMouseMove: vi.fn(),
    handleStageMouseUp: vi.fn(),
    handleStageWheel: vi.fn(),
    handleTransformEnd: vi.fn(),
    dragContextRef: {
      current: {
        draggingId: null,
        startPositions: new Map()
      }
    },
    itemIdSet: new Set(visibleItems.map((item) => item.id)),
    isFillableAnnotationShape: vi.fn(),
    isMiddleMouseRef: { current: false },
    lastClickedIdRef: { current: null },
    layerRef: React.createRef<unknown>(),
    selectedIds: new Set<string>([visibleItems[0]?.id].filter(Boolean)),
    selectionOverlayGroups: [],
    selectionRect: null,
    setActiveOcrHover: vi.fn(),
    setCroppingImageId: vi.fn(),
    setExtractingImageId: vi.fn(),
    setInlineTextEdit: vi.fn(),
    setItemsWithHistory: vi.fn(),
    setLabelDialogItemId: vi.fn(),
    setLabelDialogOpen: vi.fn(),
    setLabelDialogText: vi.fn(),
    setSelectedIds: vi.fn(),
    setTool: vi.fn(),
    showGrid: false,
    shouldForceShapeCreationCrosshair: false,
    stagePos: { x: 0, y: 0 },
    stageRef: { current: { getStage: () => null } },
    stageScale: 1,
    stageSize: { width: 1280, height: 720 },
    tool: 'select',
    transparentPattern: '',
    visibleItems
  }
}

describe('ProjectCanvasPageStageScene WebGL integration seam', () => {
  beforeEach(() => {
    syncItemPreviewSpy.mockReset()
    syncViewportSpy.mockReset()
    measureCanvasAnnotationTextHeightMock.mockClear()
    measureCanvasTextBoxHeightMock.mockClear()
    scheduleCanvasSyncMock.mockReset()
    cancelCanvasSyncMock.mockReset()
    canvasPlaceholderProps.clear()
    canvasPlaceholderRenderCounts.clear()
    imageInteractionOverlayProps.clear()
    cropOverlayProps.clear()
    latestMultiSelectionTransformOverlayProps = null
    rectInteractionOverlayProps.clear()
    latestWebGLItems = []
    latestWebGLLayerProps = null
    webglLayerRenderCount = 0
    webglReady = false
    webglLoadedIds = new Set()
    webglResidentIds = new Set()
    webglFailedIds = new Set()
    latestWebGLMetrics = {
      isInitialized: false,
      imageCount: 0,
      loadedImageCount: 0,
      failedImageCount: 0,
      residentImageCount: 0,
      residentTextureBytes: 0,
      residentCandidateTextureBytes: 0,
      residentTextureBudgetBytes: 768 * 1024 * 1024,
      pendingImageCount: 0,
      spriteCount: 0,
      residentCandidateImageCount: 0,
      viewportCulledImageCount: 0,
      usingPreviewImageCount: 0,
      usingSourceImageCount: 0,
      thumbnailPreviewImageCount: 0,
      placeholderImageCount: 0,
      sourceUpgradeSuppressedImageCount: 0,
      sourceUpgradeablePreviewImageCount: 0,
      sourceUpgradePendingImageCount: 0,
      sourceUpgradeFailedImageCount: 0,
      missingImageCount: 0,
      renderCount: 0,
      lastRenderDurationMs: null,
      lastUpdateReason: 'cleanup'
    }
    delete (window as typeof window & { event?: Event }).event
  })

  it('switches loaded single-select images into the DOM interaction overlay and forwards preview updates to WebGL', async () => {
    const item = createImageItem('image-1')
    webglReady = true
    webglLoadedIds = new Set([item.id])
    webglResidentIds = new Set([item.id])
    latestWebGLMetrics = {
      isInitialized: true,
      imageCount: 1,
      loadedImageCount: 1,
      failedImageCount: 0,
      residentImageCount: 1,
      residentTextureBytes: 24000,
      residentCandidateTextureBytes: 24000,
      residentTextureBudgetBytes: 768 * 1024 * 1024,
      pendingImageCount: 0,
      spriteCount: 1,
      residentCandidateImageCount: 1,
      viewportCulledImageCount: 0,
      usingPreviewImageCount: 0,
      usingSourceImageCount: 1,
      thumbnailPreviewImageCount: 0,
      placeholderImageCount: 0,
      sourceUpgradeSuppressedImageCount: 0,
      sourceUpgradeablePreviewImageCount: 0,
      sourceUpgradePendingImageCount: 0,
      sourceUpgradeFailedImageCount: 0,
      missingImageCount: 0,
      renderCount: 4,
      lastRenderDurationMs: 5.25,
      lastUpdateReason: 'items'
    }

    render(<ProjectCanvasPageStageScene {...createBaseProps([item])} />)

    const root = screen.getByTestId('project-canvas-stage-root')
    expect(root).toHaveAttribute(
      'data-project-canvas-render-surface-summary',
      JSON.stringify({
        totalItems: 1,
        imageItems: 1,
        webglImageItems: 1,
        webglModel3DItems: 0,
        budgetDowngradedImageItems: 0,
        fallbackImageItems: 0,
        cropExcludedImageItems: 0,
        videoOverlayItems: 0,
        htmlOverlayItems: 0
      })
    )
    expect(root).toHaveAttribute('data-project-canvas-webgl-primary-image-count', '1')
    expect(root).toHaveAttribute('data-project-canvas-budget-downgraded-image-count', '0')
    expect(root).toHaveAttribute('data-project-canvas-fallback-image-count', '0')
    expect(root).toHaveAttribute('data-project-canvas-crop-excluded-image-count', '0')
    expect(root).toHaveAttribute('data-project-canvas-webgl-initialized', 'true')
    expect(root).toHaveAttribute('data-project-canvas-webgl-loaded-image-count', '1')
    expect(root).toHaveAttribute('data-project-canvas-webgl-failed-image-count', '0')
    expect(root).toHaveAttribute('data-project-canvas-webgl-resident-image-count', '1')
    expect(root).toHaveAttribute('data-project-canvas-webgl-resident-candidate-image-count', '1')
    expect(root).toHaveAttribute('data-project-canvas-webgl-viewport-culled-image-count', '0')
    expect(root).toHaveAttribute('data-project-canvas-webgl-using-preview-image-count', '0')
    expect(root).toHaveAttribute('data-project-canvas-webgl-using-source-image-count', '1')
    expect(root).toHaveAttribute(
      'data-project-canvas-webgl-source-upgrade-pending-image-count',
      '0'
    )
    expect(root).toHaveAttribute('data-project-canvas-webgl-source-upgrade-failed-image-count', '0')
    expect(root).toHaveAttribute('data-project-canvas-webgl-missing-image-count', '0')
    expect(root).toHaveAttribute('data-project-canvas-webgl-resident-limit', '512')
    expect(root).toHaveAttribute('data-project-canvas-webgl-resident-remaining-capacity', '511')
    expect(root).toHaveAttribute('data-project-canvas-webgl-resident-texture-bytes', '24000')
    expect(root).toHaveAttribute(
      'data-project-canvas-webgl-resident-texture-budget-bytes',
      String(768 * 1024 * 1024)
    )
    expect(root).toHaveAttribute(
      'data-project-canvas-webgl-resident-texture-remaining-bytes',
      String(768 * 1024 * 1024 - 24000)
    )
    expect(root).toHaveAttribute(
      'data-project-canvas-webgl-resident-candidate-texture-bytes',
      '24000'
    )
    expect(root).toHaveAttribute('data-project-canvas-webgl-resident-budget-state', 'available')
    expect(root).toHaveAttribute('data-project-canvas-webgl-render-count', '4')
    expect(root).toHaveAttribute('data-project-canvas-webgl-last-render-duration-ms', '5.25')
    expect(root).toHaveAttribute('data-project-canvas-webgl-last-update-reason', 'items')

    await waitFor(() => {
      expect(imageInteractionOverlayProps.has(item.id)).toBe(true)
    })
    expect(canvasPlaceholderProps.has(item.id)).toBe(false)
    expect(rectInteractionOverlayProps.has(item.id)).toBe(false)
    expect(imageInteractionOverlayProps.get(item.id)?.suppressImagePreview).toBe(true)
    expect(imageInteractionOverlayProps.get(item.id)?.broadcastDomPreviewSync).toBe(false)

    const preview: ProjectCanvasImagePreview = {
      x: 140,
      y: 180,
      width: 200,
      height: 120,
      scaleX: 1.2,
      scaleY: 0.8,
      rotation: 12
    }

    act(() => {
      const onPreviewChange = imageInteractionOverlayProps.get(item.id)?.onPreviewChange as
        | ((itemId: string, next: ProjectCanvasImagePreview | null) => void)
        | undefined
      onPreviewChange?.(item.id, preview)
      onPreviewChange?.(item.id, null)
    })

    expect(syncItemPreviewSpy).toHaveBeenNthCalledWith(1, item.id, preview)
    expect(syncItemPreviewSpy).toHaveBeenNthCalledWith(2, item.id, null)
  })

  it('keeps full image metadata in WebGL while DOM overlays use the current visible subset', async () => {
    const visibleItem = createImageItem('image-visible-subset')
    const offscreenItem = createImageItem('image-offscreen-subset')
    offscreenItem.x = 100_000
    offscreenItem.y = 100_000
    offscreenItem.zIndex = visibleItem.zIndex + 1

    webglReady = true
    webglLoadedIds = new Set([visibleItem.id, offscreenItem.id])
    webglResidentIds = new Set([visibleItem.id])

    render(
      <ProjectCanvasPageStageScene
        {...createBaseProps([visibleItem])}
        items={[visibleItem, offscreenItem]}
        visibleItems={[visibleItem]}
        selectedIds={new Set()}
      />
    )

    await waitFor(() => {
      expect(latestWebGLItems.map((item) => item.id)).toEqual([visibleItem.id, offscreenItem.id])
    })
    expect(canvasPlaceholderProps.has(offscreenItem.id)).toBe(false)
    expect(imageInteractionOverlayProps.has(offscreenItem.id)).toBe(false)
  })

  it('adds a high-resolution source overlay for jumbo resident WebGL images at close zoom', async () => {
    const item = {
      ...createImageItem('image-jumbo-webgl-source'),
      width: 6_000,
      height: 2_000,
      sourceWidth: 6_000,
      sourceHeight: 2_000,
      image: createImageItem('image-jumbo-preview').image
    }
    webglReady = true
    webglLoadedIds = new Set([item.id])
    webglResidentIds = new Set([item.id])

    render(<ProjectCanvasPageStageScene {...createBaseProps([item])} />)

    const root = screen.getByTestId('project-canvas-stage-root')
    await waitFor(() => {
      expect(root).toHaveAttribute('data-project-canvas-webgl-primary-image-count', '1')
      expect(root).toHaveAttribute('data-project-canvas-high-res-dom-image-count', '1')
    })

    const highResImage = document.querySelector(
      '[data-project-canvas-high-res-image-layer="dom"] img[data-canvas-source-image-preview="true"]'
    )
    expect(highResImage?.getAttribute('src')).toBe('file:///image-jumbo-webgl-source.png')
  })

  it('budgets jumbo source overlays by visible pixels instead of a four item cap', async () => {
    const items = Array.from({ length: 6 }, (_, index) => ({
      ...createImageItem(`image-jumbo-webgl-source-${index + 1}`),
      x: 0,
      y: 0,
      width: 6_000,
      height: 1_000,
      sourceWidth: 6_000,
      sourceHeight: 1_000,
      zIndex: index + 1,
      image: createImageItem(`image-jumbo-preview-${index + 1}`).image
    }))
    webglReady = true
    webglLoadedIds = new Set(items.map((item) => item.id))
    webglResidentIds = new Set(items.map((item) => item.id))

    render(<ProjectCanvasPageStageScene {...createBaseProps(items)} />)

    const root = screen.getByTestId('project-canvas-stage-root')
    await waitFor(() => {
      expect(root).toHaveAttribute('data-project-canvas-high-res-dom-image-count', '6')
    })

    expect(
      document.querySelectorAll(
        '[data-project-canvas-high-res-image-layer="dom"] img[data-canvas-source-image-preview="true"]'
      )
    ).toHaveLength(6)
  })

  it('allows a sparse high-zoom ultra-jumbo source overlay instead of staying on the 4096 proxy', async () => {
    const item = {
      ...createImageItem('image-ultra-jumbo-webgl-source'),
      width: 24_000,
      height: 6_000,
      sourceWidth: 24_000,
      sourceHeight: 6_000,
      image: createImageItem('image-ultra-jumbo-preview').image
    }
    webglReady = true
    webglLoadedIds = new Set([item.id])
    webglResidentIds = new Set([item.id])

    render(<ProjectCanvasPageStageScene {...createBaseProps([item])} stageScale={4} />)

    const root = screen.getByTestId('project-canvas-stage-root')
    await waitFor(() => {
      expect(root).toHaveAttribute('data-project-canvas-webgl-primary-image-count', '1')
      expect(root).toHaveAttribute('data-project-canvas-high-res-dom-image-count', '1')
    })
  })

  it('uses a high-resolution source overlay for sparse alpha ultra-jumbo images before 4096 projected pixels', async () => {
    const previewImage = document.createElement('img')
    Object.defineProperty(previewImage, 'naturalWidth', { value: 512 })
    Object.defineProperty(previewImage, 'naturalHeight', { value: 134 })
    const item = {
      ...createImageItem('image-ultra-jumbo-mid-zoom-source'),
      width: 1_500,
      height: 393,
      sourceWidth: 23_126,
      sourceHeight: 6_055,
      hasAlpha: true,
      image: previewImage
    }
    webglReady = true
    webglLoadedIds = new Set([item.id])
    webglResidentIds = new Set([item.id])

    render(<ProjectCanvasPageStageScene {...createBaseProps([item])} stageScale={0.82} />)

    const root = screen.getByTestId('project-canvas-stage-root')
    await waitFor(() => {
      expect(root).toHaveAttribute('data-project-canvas-webgl-primary-image-count', '1')
      expect(root).toHaveAttribute('data-project-canvas-high-res-dom-image-count', '1')
    })
  })

  it('does not mount high-resolution DOM source overlays for dense low-zoom boards', async () => {
    const items = Array.from({ length: 17 }, (_, index) => ({
      ...createImageItem(`image-dense-ultra-jumbo-webgl-source-${index + 1}`),
      width: 24_000,
      height: 6_000,
      sourceWidth: 24_000,
      sourceHeight: 6_000,
      zIndex: index + 1,
      image: createImageItem(`image-dense-ultra-jumbo-preview-${index + 1}`).image
    }))
    webglReady = true
    webglLoadedIds = new Set(items.map((item) => item.id))
    webglResidentIds = new Set(items.map((item) => item.id))

    render(<ProjectCanvasPageStageScene {...createBaseProps(items)} stageScale={0.27} />)

    const root = screen.getByTestId('project-canvas-stage-root')
    await waitFor(() => {
      expect(root).toHaveAttribute('data-project-canvas-webgl-primary-image-count', '17')
      expect(root).toHaveAttribute('data-project-canvas-high-res-dom-image-count', '0')
    })
  })

  it('only asks image overlays to broadcast DOM preview sync when attached overlays depend on them', async () => {
    const imageWithAttachment = createImageItem('image-with-caption')
    const attachedCaption = {
      ...createAnnotationItem('caption-attached', {
        shape: 'text-anno',
        label: '',
        text: 'caption'
      }),
      attachedToId: imageWithAttachment.id,
      attachmentPlacement: 'bottom-center'
    } as CanvasAnnotationItem
    webglReady = true
    webglLoadedIds = new Set([imageWithAttachment.id])
    webglResidentIds = new Set([imageWithAttachment.id])

    render(
      <ProjectCanvasPageStageScene {...createBaseProps([imageWithAttachment, attachedCaption])} />
    )

    await waitFor(() => {
      expect(imageInteractionOverlayProps.has(imageWithAttachment.id)).toBe(true)
    })

    expect(imageInteractionOverlayProps.get(imageWithAttachment.id)?.broadcastDomPreviewSync).toBe(
      true
    )
  })

  it('falls back to DOM image rendering when WebGL becomes unavailable after mounting', async () => {
    const item = createImageItem('image-webgl-runtime-failure')
    webglReady = true
    webglLoadedIds = new Set([item.id])
    webglResidentIds = new Set([item.id])

    render(<ProjectCanvasPageStageScene {...createBaseProps([item])} />)

    const root = screen.getByTestId('project-canvas-stage-root')
    await waitFor(() => {
      expect(imageInteractionOverlayProps.has(item.id)).toBe(true)
    })
    expect(root).toHaveAttribute('data-project-canvas-webgl-primary-image-count', '1')
    expect(root).toHaveAttribute('data-project-canvas-fallback-image-count', '0')
    expect(imageInteractionOverlayProps.get(item.id)?.renderMode).toBe('webgl-primary')
    expect(imageInteractionOverlayProps.get(item.id)?.suppressImagePreview).toBe(true)

    latestWebGLMetrics = {
      ...latestWebGLMetrics,
      isInitialized: false,
      loadedImageCount: 0,
      residentImageCount: 0,
      residentTextureBytes: 0,
      residentCandidateTextureBytes: 0,
      spriteCount: 0,
      residentCandidateImageCount: 0,
      usingSourceImageCount: 0,
      thumbnailPreviewImageCount: 0,
      placeholderImageCount: 0,
      sourceUpgradeSuppressedImageCount: 0,
      lastRenderDurationMs: null,
      lastUpdateReason: 'cleanup'
    }

    act(() => {
      latestWebGLLayerProps?.onReadyChange?.(false)
      latestWebGLLayerProps?.onResidentIdsChange?.(new Set())
      latestWebGLLayerProps?.onResolvedIdsChange?.(new Set())
      latestWebGLLayerProps?.onFailedIdsChange?.(new Set())
      latestWebGLLayerProps?.onMetricsChange?.({ ...latestWebGLMetrics })
    })

    await waitFor(() => {
      expect(root).toHaveAttribute('data-project-canvas-webgl-primary-image-count', '0')
      expect(root).toHaveAttribute('data-project-canvas-fallback-image-count', '1')
      expect(imageInteractionOverlayProps.get(item.id)?.renderMode).toBe('fallback-image-proxy')
    })
    expect(root).toHaveAttribute('data-project-canvas-webgl-initialized', 'false')
    expect(root).toHaveAttribute('data-project-canvas-webgl-loaded-image-count', '0')
    expect(root).toHaveAttribute('data-project-canvas-webgl-resident-image-count', '0')
    expect(imageInteractionOverlayProps.get(item.id)?.suppressImagePreview).toBe(false)
    expect(canvasPlaceholderProps.has(item.id)).toBe(false)
  })

  it('keeps selected alpha WebGL images on the WebGL visual layer', async () => {
    const item = {
      ...createImageItem('image-webgl-alpha-dom-preview'),
      hasAlpha: true
    }
    webglReady = true
    webglLoadedIds = new Set([item.id])
    webglResidentIds = new Set([item.id])

    render(<ProjectCanvasPageStageScene {...createBaseProps([item])} />)

    await waitFor(() => {
      expect(imageInteractionOverlayProps.has(item.id)).toBe(true)
    })

    const overlayProps = imageInteractionOverlayProps.get(item.id)
    expect(overlayProps?.renderMode).toBe('webgl-primary')
    expect(overlayProps?.suppressImagePreview).toBe(true)
    expect(overlayProps?.preferDomImagePreview).toBe(false)
    expect(overlayProps?.domImagePreviewBackdropColor).toBeUndefined()
    expect(canvasPlaceholderProps.has(item.id)).toBe(false)
    expect(rectInteractionOverlayProps.has(item.id)).toBe(false)
  })

  it('keeps selected alpha-capable PNG images on the WebGL visual layer while alpha is unknown', async () => {
    const item = {
      ...createImageItem('image-webgl-unknown-alpha-png'),
      hasAlpha: undefined
    }
    webglReady = true
    webglLoadedIds = new Set([item.id])
    webglResidentIds = new Set([item.id])

    render(<ProjectCanvasPageStageScene {...createBaseProps([item])} />)

    await waitFor(() => {
      expect(imageInteractionOverlayProps.has(item.id)).toBe(true)
    })

    const overlayProps = imageInteractionOverlayProps.get(item.id)
    expect(overlayProps?.renderMode).toBe('webgl-primary')
    expect(overlayProps?.suppressImagePreview).toBe(true)
    expect(overlayProps?.preferDomImagePreview).toBe(false)
    expect(overlayProps?.domImagePreviewBackdropColor).toBeUndefined()
  })

  it('does not cover selected oversized WebGL images with a deferred placeholder preview', async () => {
    const placeholder = document.createElement('canvas')
    placeholder.width = 512
    placeholder.height = 314
    const item = {
      ...createImageItem('image-webgl-deferred-placeholder'),
      src: 'local-media:///C:/real-board/huge.png',
      fileName: 'huge.png',
      width: 19717,
      height: 12079,
      sourceWidth: 19717,
      sourceHeight: 12079,
      hasAlpha: true,
      image: placeholder
    }
    webglReady = true
    webglLoadedIds = new Set([item.id])
    webglResidentIds = new Set([item.id])

    render(<ProjectCanvasPageStageScene {...createBaseProps([item])} />)

    await waitFor(() => {
      expect(imageInteractionOverlayProps.has(item.id)).toBe(true)
    })

    const overlayProps = imageInteractionOverlayProps.get(item.id)
    expect(overlayProps?.renderMode).toBe('webgl-primary')
    expect(overlayProps?.suppressImagePreview).toBe(true)
    expect(overlayProps?.preferDomImagePreview).toBe(false)
    expect(overlayProps?.domImagePreviewBackdropColor).toBeUndefined()
  })

  it('ignores duplicate WebGL runtime reports and does not pass a spatial index prop', async () => {
    const item = createImageItem('image-webgl-duplicate-report')
    webglReady = true
    webglLoadedIds = new Set([item.id])
    webglResidentIds = new Set([item.id])
    latestWebGLMetrics = {
      isInitialized: true,
      imageCount: 1,
      loadedImageCount: 1,
      failedImageCount: 0,
      residentImageCount: 1,
      residentTextureBytes: 24000,
      residentCandidateTextureBytes: 24000,
      residentTextureBudgetBytes: 768 * 1024 * 1024,
      pendingImageCount: 0,
      spriteCount: 1,
      residentCandidateImageCount: 1,
      viewportCulledImageCount: 0,
      usingPreviewImageCount: 0,
      usingSourceImageCount: 1,
      thumbnailPreviewImageCount: 0,
      placeholderImageCount: 0,
      sourceUpgradeSuppressedImageCount: 0,
      sourceUpgradeablePreviewImageCount: 0,
      sourceUpgradePendingImageCount: 0,
      sourceUpgradeFailedImageCount: 0,
      missingImageCount: 0,
      renderCount: 4,
      lastRenderDurationMs: 5.25,
      lastUpdateReason: 'items'
    }

    render(<ProjectCanvasPageStageScene {...createBaseProps([item])} />)

    await waitFor(() => {
      expect(screen.getByTestId('project-canvas-stage-root')).toHaveAttribute(
        'data-project-canvas-webgl-resident-image-count',
        '1'
      )
    })

    expect(latestWebGLLayerProps).not.toBeNull()
    expect(latestWebGLLayerProps).not.toHaveProperty('spatialIndex')
    const settledRenderCount = webglLayerRenderCount

    act(() => {
      latestWebGLLayerProps?.onResidentIdsChange?.(new Set([item.id]))
      latestWebGLLayerProps?.onResolvedIdsChange?.(new Set([item.id]))
      latestWebGLLayerProps?.onFailedIdsChange?.(new Set())
      latestWebGLLayerProps?.onMetricsChange?.({ ...latestWebGLMetrics })
    })

    expect(webglLayerRenderCount).toBe(settledRenderCount)
  })

  it('captures drop events at the stage root even when a child element stops bubbling', () => {
    const item = createImageItem('image-drop-capture')
    const props = createBaseProps([item])

    render(<ProjectCanvasPageStageScene {...props} />)

    const childLayer = document.querySelector(
      '[data-project-canvas-stage-event-layer="dom"]'
    ) as HTMLElement | null
    expect(childLayer).not.toBeNull()

    childLayer!.addEventListener('dragover', (event) => {
      event.stopPropagation()
    })
    childLayer!.addEventListener('drop', (event) => {
      event.stopPropagation()
    })

    fireEvent.dragOver(childLayer!, {
      dataTransfer: { files: [] }
    })
    fireEvent.drop(childLayer!, {
      dataTransfer: { files: [] }
    })

    expect(props.handleDragOver).toHaveBeenCalledTimes(1)
    expect(props.handleDrop).toHaveBeenCalledTimes(1)
  })

  it('keeps the active crop target out of the WebGL layer and on the crop overlay path', async () => {
    const cropItem = createImageItem('crop-target')
    const siblingItem = createImageItem('sibling-image')
    webglReady = true
    webglLoadedIds = new Set([cropItem.id, siblingItem.id])
    webglResidentIds = new Set([cropItem.id, siblingItem.id])

    render(
      <ProjectCanvasPageStageScene
        {...createBaseProps([cropItem, siblingItem])}
        tool="crop-select"
        croppingImageId={cropItem.id}
      />
    )

    expect(screen.getByTestId(`crop-overlay-${cropItem.id}`)).toBeInTheDocument()

    await waitFor(() => {
      expect(latestWebGLItems.map((item) => item.id)).toEqual([siblingItem.id])
    })

    expect(typeof cropOverlayProps.get(cropItem.id)?.registerViewportLayer).toBe('function')
    const root = screen.getByTestId('project-canvas-stage-root')
    expect(root).toHaveAttribute(
      'data-project-canvas-render-surface-summary',
      JSON.stringify({
        totalItems: 2,
        imageItems: 2,
        webglImageItems: 1,
        webglModel3DItems: 0,
        budgetDowngradedImageItems: 0,
        fallbackImageItems: 0,
        cropExcludedImageItems: 1,
        videoOverlayItems: 0,
        htmlOverlayItems: 0
      })
    )
    expect(root).toHaveAttribute('data-project-canvas-webgl-primary-image-count', '1')
    expect(root).toHaveAttribute('data-project-canvas-budget-downgraded-image-count', '0')
    expect(root).toHaveAttribute('data-project-canvas-fallback-image-count', '0')
    expect(root).toHaveAttribute('data-project-canvas-crop-excluded-image-count', '1')
    expect(canvasPlaceholderProps.has(cropItem.id)).toBe(false)
    expect(imageInteractionOverlayProps.has(siblingItem.id)).toBe(false)
    expect(canvasPlaceholderProps.has(siblingItem.id)).toBe(true)
    expect(canvasPlaceholderProps.get(siblingItem.id)?.visualVariant).toBe('transparent')
  })

  it('keeps the active extract target out of the WebGL layer and on the selection overlay path', async () => {
    const extractItem = createImageItem('extract-target')
    const siblingItem = createImageItem('extract-sibling')
    webglReady = true
    webglLoadedIds = new Set([extractItem.id, siblingItem.id])
    webglResidentIds = new Set([extractItem.id, siblingItem.id])

    render(
      <ProjectCanvasPageStageScene
        {...createBaseProps([extractItem, siblingItem])}
        tool="extract-select"
        extractingImageId={extractItem.id}
      />
    )

    expect(screen.getByTestId(`crop-overlay-${extractItem.id}`)).toBeInTheDocument()

    await waitFor(() => {
      expect(latestWebGLItems.map((item) => item.id)).toEqual([siblingItem.id])
    })

    const root = screen.getByTestId('project-canvas-stage-root')
    expect(root).toHaveAttribute('data-project-canvas-crop-excluded-image-count', '1')
    expect(canvasPlaceholderProps.has(extractItem.id)).toBe(false)
  })

  it('preserves selection, drag, and transform handlers for a loaded DOM overlay image', async () => {
    const item = createImageItem('image-1')
    const setSelectedIds = vi.fn()
    const handleDragEnd = vi.fn()
    const handleTransformEnd = vi.fn()
    webglReady = true
    webglLoadedIds = new Set([item.id])
    webglResidentIds = new Set([item.id])

    render(
      <ProjectCanvasPageStageScene
        {...createBaseProps([item])}
        setSelectedIds={setSelectedIds}
        handleDragEnd={handleDragEnd}
        handleTransformEnd={handleTransformEnd}
      />
    )

    await waitFor(() => {
      expect(imageInteractionOverlayProps.has(item.id)).toBe(true)
    })
    expect(canvasPlaceholderProps.has(item.id)).toBe(false)
    expect(rectInteractionOverlayProps.has(item.id)).toBe(false)

    act(() => {
      ;(imageInteractionOverlayProps.get(item.id)?.onSelect as (() => void) | undefined)?.()
    })

    expect(setSelectedIds).toHaveBeenCalledTimes(1)
    const updateSelection = setSelectedIds.mock.calls[0][0] as (prev: Set<string>) => Set<string>
    expect(Array.from(updateSelection(new Set(['stale-id'])))).toEqual([item.id])

    const dragEvt = { type: 'drag-end' }
    act(() => {
      ;(
        imageInteractionOverlayProps.get(item.id)?.onDragEnd as
          | ((id: string, x: number, y: number, evt?: unknown) => void)
          | undefined
      )?.(item.id, 220, 260, dragEvt)
    })

    expect(handleDragEnd).toHaveBeenCalledWith(item.id, 220, 260, dragEvt)

    act(() => {
      ;(
        imageInteractionOverlayProps.get(item.id)?.onTransformEnd as
          | ((id: string, attrs: Partial<CanvasImageItem>) => void)
          | undefined
      )?.(item.id, {
        x: 180,
        y: 210,
        rotation: 18,
        scaleX: 1.4,
        scaleY: 0.9
      })
    })

    expect(handleTransformEnd).toHaveBeenCalledWith(item.id, {
      x: 180,
      y: 210,
      rotation: 18,
      scaleX: 1.4,
      scaleY: 0.9
    })
  })

  it('skips redundant selection updates for an already selected DOM overlay image', async () => {
    const item = createImageItem('image-already-selected')
    const setSelectedIds = vi.fn()
    webglReady = true
    webglLoadedIds = new Set([item.id])
    webglResidentIds = new Set([item.id])

    render(
      <ProjectCanvasPageStageScene
        {...createBaseProps([item])}
        selectedIds={new Set([item.id])}
        setSelectedIds={setSelectedIds}
      />
    )

    await waitFor(() => {
      expect(imageInteractionOverlayProps.has(item.id)).toBe(true)
    })

    act(() => {
      ;(imageInteractionOverlayProps.get(item.id)?.onSelect as (() => void) | undefined)?.()
    })

    expect(setSelectedIds).toHaveBeenCalledTimes(1)
    const updateSelection = setSelectedIds.mock.calls[0][0] as (prev: Set<string>) => Set<string>
    const currentSelection = new Set([item.id])
    expect(updateSelection(currentSelection)).toBe(currentSelection)
  })

  it('mounts the DOM image interaction overlay only for the active select-tool image', async () => {
    const selectedItem = createImageItem('image-selected')
    const siblingItem = createImageItem('image-sibling')
    siblingItem.x = 420
    webglReady = true
    webglLoadedIds = new Set([selectedItem.id, siblingItem.id])
    webglResidentIds = new Set([selectedItem.id, siblingItem.id])

    render(<ProjectCanvasPageStageScene {...createBaseProps([selectedItem, siblingItem])} />)

    await waitFor(() => {
      expect(imageInteractionOverlayProps.has(selectedItem.id)).toBe(true)
    })

    const root = screen.getByTestId('project-canvas-stage-root')
    expect(root).toHaveAttribute('data-project-canvas-proxy-layer-candidate-count', '1')
    expect(imageInteractionOverlayProps.has(siblingItem.id)).toBe(false)
    expect(canvasPlaceholderProps.has(selectedItem.id)).toBe(false)
    expect(canvasPlaceholderProps.has(siblingItem.id)).toBe(true)
    expect(rectInteractionOverlayProps.has(selectedItem.id)).toBe(false)
    expect(rectInteractionOverlayProps.has(siblingItem.id)).toBe(false)
    expect(imageInteractionOverlayProps.get(selectedItem.id)?.isSelected).toBe(true)
    expect(imageInteractionOverlayProps.get(selectedItem.id)?.showTransformer).toBe(true)
    expect(canvasPlaceholderProps.get(siblingItem.id)?.visualVariant).toBe('transparent')
  })

  it('suppresses per-image WebGL hit proxies for dense selected image boards', async () => {
    const items = Array.from({ length: 300 }, (_, index) => {
      const item = createImageItem(`dense-image-${index}`)
      item.x = (index % 30) * 220
      item.y = Math.floor(index / 30) * 180
      item.zIndex = index
      return item
    })
    const imageIds = items.map((item) => item.id)
    const selectedIds = new Set(imageIds)
    webglReady = true
    webglLoadedIds = new Set(imageIds)
    webglResidentIds = new Set(imageIds)

    render(<ProjectCanvasPageStageScene {...createBaseProps(items)} selectedIds={selectedIds} />)

    await waitFor(() => {
      expect(latestWebGLItems).toHaveLength(items.length)
    })

    const root = screen.getByTestId('project-canvas-stage-root')
    expect(root).toHaveAttribute('data-project-canvas-dense-webgl-image-proxy-mode', 'true')
    expect(root).toHaveAttribute('data-project-canvas-proxy-layer-candidate-count', '0')
    expect(root).toHaveAttribute('data-project-canvas-image-interaction-overlay-count', '0')
    expect(root).toHaveAttribute('data-project-canvas-placeholder-image-proxy-count', '0')
    expect(canvasPlaceholderProps.size).toBe(0)
    expect(imageInteractionOverlayProps.size).toBe(0)
    expect(screen.getByTestId('mock-multi-selection-transform-overlay')).toBeInTheDocument()
  })

  it('keeps a single selected WebGL image interactive on dense boards', async () => {
    const items = Array.from({ length: 300 }, (_, index) => {
      const item = createImageItem(`dense-single-image-${index}`)
      item.x = (index % 30) * 220
      item.y = Math.floor(index / 30) * 180
      item.zIndex = index
      return item
    })
    const imageIds = items.map((item) => item.id)
    const selectedItem = items[0]
    webglReady = true
    webglLoadedIds = new Set(imageIds)
    webglResidentIds = new Set(imageIds)

    render(
      <ProjectCanvasPageStageScene
        {...createBaseProps(items)}
        selectedIds={new Set([selectedItem.id])}
      />
    )

    await waitFor(() => {
      expect(imageInteractionOverlayProps.has(selectedItem.id)).toBe(true)
    })

    const root = screen.getByTestId('project-canvas-stage-root')
    expect(root).toHaveAttribute('data-project-canvas-dense-webgl-image-proxy-mode', 'true')
    expect(root).toHaveAttribute('data-project-canvas-proxy-layer-candidate-count', '0')
    expect(root).toHaveAttribute('data-project-canvas-image-interaction-overlay-count', '1')
    expect(root).toHaveAttribute('data-project-canvas-placeholder-image-proxy-count', '0')
    expect(canvasPlaceholderProps.size).toBe(0)
    expect(imageInteractionOverlayProps.size).toBe(1)
    expect(imageInteractionOverlayProps.get(selectedItem.id)?.isSelected).toBe(true)
  })

  it('suppresses unloaded fallback hit proxies on dense boards while WebGL catches up', async () => {
    const items = Array.from({ length: 300 }, (_, index) => {
      const item = createImageItem(`dense-unloaded-image-${index}`)
      item.x = (index % 30) * 220
      item.y = Math.floor(index / 30) * 180
      item.zIndex = index
      return item
    })
    webglReady = true
    webglLoadedIds = new Set()
    webglResidentIds = new Set()

    render(<ProjectCanvasPageStageScene {...createBaseProps(items)} selectedIds={new Set()} />)

    await waitFor(() => {
      expect(latestWebGLItems).toHaveLength(items.length)
    })

    const root = screen.getByTestId('project-canvas-stage-root')
    expect(root).toHaveAttribute('data-project-canvas-dense-webgl-image-proxy-mode', 'true')
    expect(root).toHaveAttribute('data-project-canvas-fallback-image-count', `${items.length}`)
    expect(root).toHaveAttribute('data-project-canvas-proxy-layer-candidate-count', '0')
    expect(root).toHaveAttribute('data-project-canvas-image-interaction-overlay-count', '0')
    expect(root).toHaveAttribute('data-project-canvas-placeholder-image-proxy-count', '0')
    expect(canvasPlaceholderProps.size).toBe(0)
    expect(imageInteractionOverlayProps.size).toBe(0)
  })

  it('suspends WebGL image proxy content and multi-selection transform chrome during viewport interaction', async () => {
    const selectedItem = createImageItem('image-selected')
    const siblingItem = createImageItem('image-sibling')
    siblingItem.x = 420
    webglReady = true
    webglLoadedIds = new Set([selectedItem.id, siblingItem.id])
    webglResidentIds = new Set([selectedItem.id, siblingItem.id])
    const selectedIds = new Set([selectedItem.id, siblingItem.id])
    const baseProps = createBaseProps([selectedItem, siblingItem])

    const { rerender } = render(
      <ProjectCanvasPageStageScene {...baseProps} isViewportInteracting selectedIds={selectedIds} />
    )

    await waitFor(() => {
      expect(latestWebGLItems.map((item) => item.id)).toEqual([selectedItem.id, siblingItem.id])
    })

    expect(
      screen
        .getByTestId('project-canvas-stage-root')
        .querySelector('[data-project-canvas-proxy-layer="dom"]')
    ).toBeNull()
    expect(canvasPlaceholderProps.size).toBe(0)
    expect(imageInteractionOverlayProps.size).toBe(0)
    expect(rectInteractionOverlayProps.size).toBe(0)
    expect(screen.getByTestId('project-canvas-stage-root')).toHaveAttribute(
      'data-project-canvas-proxy-layer-candidate-count',
      '0'
    )
    expect(screen.queryByTestId('mock-multi-selection-transform-overlay')).toBeNull()

    rerender(
      <ProjectCanvasPageStageScene
        {...baseProps}
        isViewportInteracting={false}
        selectedIds={selectedIds}
      />
    )

    await waitFor(() => {
      expect(canvasPlaceholderProps.size).toBe(2)
    })
    expect(
      screen
        .getByTestId('project-canvas-stage-root')
        .querySelector('[data-project-canvas-proxy-layer="dom"]')
    ).not.toBeNull()
    expect(screen.getByTestId('mock-multi-selection-transform-overlay')).toBeInTheDocument()
  })

  it('forwards viewport driver callbacks into the WebGL layer imperative viewport sync', async () => {
    const item = createImageItem('image-viewport-sync')
    let viewportCallback: ((pos: { x: number; y: number }, scale: number) => void) | null = null
    const unregister = vi.fn()
    const registerViewportCallback = vi.fn(
      (fn: (pos: { x: number; y: number }, scale: number) => void) => {
        viewportCallback = fn
        return unregister
      }
    )

    render(
      <ProjectCanvasPageStageScene
        {...({
          ...createBaseProps([item]),
          registerViewportCallback
        } as any)}
      />
    )

    await waitFor(() => {
      expect(registerViewportCallback).toHaveBeenCalled()
    })

    act(() => {
      viewportCallback?.({ x: 96, y: 72 }, 1.25)
    })

    expect(syncViewportSpy).toHaveBeenCalledWith({ x: 96, y: 72 }, 1.25)
  })

  it('temporarily suspends DOM image interaction overlays during marquee selection', async () => {
    const selectedItem = createImageItem('image-selected')
    const siblingItem = createImageItem('image-sibling')
    siblingItem.x = 420
    webglReady = true
    webglLoadedIds = new Set([selectedItem.id, siblingItem.id])
    webglResidentIds = new Set([selectedItem.id, siblingItem.id])

    render(
      <ProjectCanvasPageStageScene
        {...createBaseProps([selectedItem, siblingItem])}
        selectionRect={{
          startX: 100,
          startY: 100,
          x: 100,
          y: 100,
          w: 240,
          h: 160
        }}
      />
    )

    await waitFor(() => {
      expect(imageInteractionOverlayProps.size).toBe(0)
    })
    expect(canvasPlaceholderProps.has(selectedItem.id)).toBe(false)
    expect(canvasPlaceholderProps.has(siblingItem.id)).toBe(true)
    expect(canvasPlaceholderProps.get(siblingItem.id)?.visualVariant).toBe('transparent')
  })

  it('keeps DOM image interaction overlays mounted for zero-size marquee noise', async () => {
    const selectedItem = createImageItem('image-selected-noise')
    const siblingItem = createImageItem('image-sibling-noise')
    siblingItem.x = 420
    webglReady = true
    webglLoadedIds = new Set([selectedItem.id, siblingItem.id])
    webglResidentIds = new Set([selectedItem.id, siblingItem.id])

    render(
      <ProjectCanvasPageStageScene
        {...createBaseProps([selectedItem, siblingItem])}
        selectionRect={{
          startX: 100,
          startY: 100,
          x: 100,
          y: 100,
          w: 0,
          h: 0
        }}
      />
    )

    await waitFor(() => {
      expect(imageInteractionOverlayProps.has(selectedItem.id)).toBe(true)
    })
    expect(canvasPlaceholderProps.has(selectedItem.id)).toBe(false)
  })

  it('hides proxy hit layers while the canvas marquee flag is active', async () => {
    const selectedItem = createImageItem('image-marquee-proxy-selected')
    const siblingItem = createImageItem('image-marquee-proxy-sibling')
    siblingItem.x = 420
    webglReady = true
    webglLoadedIds = new Set([selectedItem.id, siblingItem.id])
    webglResidentIds = new Set([selectedItem.id, siblingItem.id])

    render(
      <ProjectCanvasPageStageScene
        {...createBaseProps([selectedItem, siblingItem])}
        selectedIds={new Set([selectedItem.id, siblingItem.id])}
      />
    )

    const root = screen.getByTestId('project-canvas-stage-root')
    const proxyLayer = await waitFor(() => {
      const node = root.querySelector(
        '[data-project-canvas-proxy-layer="dom"]'
      ) as HTMLElement | null
      expect(node).toBeTruthy()
      return node as HTMLElement
    })

    expect(getComputedStyle(proxyLayer).display).not.toBe('none')

    act(() => {
      root.setAttribute('data-project-canvas-marquee-active', 'true')
    })

    expect(getComputedStyle(proxyLayer).display).toBe('none')
  })

  it('does not rerender proxy placeholders when only marquee bounds change', async () => {
    const item = createModel3DItem('model-marquee')
    const baseProps = createBaseProps([item])
    const { rerender } = render(<ProjectCanvasPageStageScene {...baseProps} />)

    await waitFor(() => {
      expect(canvasPlaceholderProps.has(item.id)).toBe(true)
    })
    const settledRenderCount = canvasPlaceholderRenderCounts.get(item.id) ?? 0
    expect(settledRenderCount).toBeGreaterThan(0)

    rerender(
      <ProjectCanvasPageStageScene
        {...baseProps}
        selectionRect={{
          startX: 40,
          startY: 60,
          x: 40,
          y: 60,
          w: 220,
          h: 140
        }}
      />
    )

    expect(canvasPlaceholderRenderCounts.get(item.id)).toBe(settledRenderCount)
  })

  it('does not rerender the WebGL image layer when only marquee bounds change', async () => {
    const selectedItem = createImageItem('image-marquee-selected')
    const siblingItem = createImageItem('image-marquee-sibling')
    siblingItem.x = 420
    webglReady = true
    webglLoadedIds = new Set([selectedItem.id, siblingItem.id])
    webglResidentIds = new Set([selectedItem.id, siblingItem.id])

    const baseProps = createBaseProps([selectedItem, siblingItem])
    const { rerender } = render(<ProjectCanvasPageStageScene {...baseProps} />)

    await waitFor(() => {
      expect(imageInteractionOverlayProps.has(selectedItem.id)).toBe(true)
    })
    const settledRenderCount = webglLayerRenderCount
    expect(settledRenderCount).toBeGreaterThan(0)

    rerender(
      <ProjectCanvasPageStageScene
        {...baseProps}
        selectionRect={{
          startX: 80,
          startY: 90,
          x: 80,
          y: 90,
          w: 260,
          h: 180
        }}
      />
    )

    expect(webglLayerRenderCount).toBe(settledRenderCount)
  })

  it('renders a DOM multi-selection transform overlay and commits grouped updates', async () => {
    const targetItem = createImageItem('image-target')
    const siblingItem = createImageItem('image-sibling')
    siblingItem.x = 420
    siblingItem.y = 140

    const setItemsWithHistory = vi.fn()
    webglReady = true
    webglLoadedIds = new Set([targetItem.id, siblingItem.id])
    webglResidentIds = new Set([targetItem.id, siblingItem.id])

    render(
      <ProjectCanvasPageStageScene
        {...createBaseProps([targetItem, siblingItem])}
        selectedIds={new Set([targetItem.id, siblingItem.id])}
        setItemsWithHistory={setItemsWithHistory}
      />
    )

    await waitFor(() => {
      expect(latestMultiSelectionTransformOverlayProps).not.toBeNull()
    })
    expect(canvasPlaceholderProps.has(targetItem.id)).toBe(true)
    expect(canvasPlaceholderProps.has(siblingItem.id)).toBe(true)
    expect(imageInteractionOverlayProps.size).toBe(0)
    expect(canvasPlaceholderProps.get(targetItem.id)?.visualVariant).toBe('transparent')
    expect(canvasPlaceholderProps.get(siblingItem.id)?.visualVariant).toBe('transparent')
    expect(screen.getByTestId('mock-multi-selection-transform-overlay')).toHaveAttribute(
      'data-item-ids',
      `${targetItem.id},${siblingItem.id}`
    )

    act(() => {
      ;(
        latestMultiSelectionTransformOverlayProps?.onTransformEnd as
          | ((updates: Array<{ id: string; attrs: Partial<CanvasImageItem> }>) => void)
          | undefined
      )?.([
        {
          id: targetItem.id,
          attrs: {
            x: 120,
            y: 150,
            scaleX: 1.25,
            scaleY: 0.9
          }
        },
        {
          id: siblingItem.id,
          attrs: {
            x: 460,
            y: 156,
            scaleX: 1.1,
            scaleY: 0.95
          }
        }
      ])
    })

    expect(setItemsWithHistory).toHaveBeenCalledTimes(1)
    const updateItems = setItemsWithHistory.mock.calls[0][0] as (
      prev: CanvasImageItem[]
    ) => CanvasImageItem[]
    expect(updateItems([targetItem, siblingItem])).toEqual([
      expect.objectContaining({
        id: targetItem.id,
        x: 120,
        y: 150,
        scaleX: 1.25,
        scaleY: 0.9
      }),
      expect.objectContaining({
        id: siblingItem.id,
        x: 460,
        y: 156,
        scaleX: 1.1,
        scaleY: 0.95
      })
    ])
  })

  it('defers selection chrome after marquee release', async () => {
    const targetItem = createImageItem('image-marquee-target')
    const siblingItem = createImageItem('image-marquee-sibling')
    siblingItem.x = 420
    siblingItem.y = 140

    webglReady = true
    webglLoadedIds = new Set([targetItem.id, siblingItem.id])
    webglResidentIds = new Set([targetItem.id, siblingItem.id])

    const { rerender } = render(
      <ProjectCanvasPageStageScene
        {...createBaseProps([targetItem, siblingItem])}
        selectedIds={new Set([targetItem.id, siblingItem.id])}
        suppressSelectionChromeAfterMarquee
      />
    )

    expect(screen.queryByTestId('mock-multi-selection-transform-overlay')).not.toBeInTheDocument()
    expect(latestMultiSelectionTransformOverlayProps).toBeNull()

    rerender(
      <ProjectCanvasPageStageScene
        {...createBaseProps([targetItem, siblingItem])}
        selectedIds={new Set([targetItem.id, siblingItem.id])}
        suppressSelectionChromeAfterMarquee={false}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('mock-multi-selection-transform-overlay')).toBeInTheDocument()
    })
  })

  it('routes a selected file node through the DOM rect interaction overlay', async () => {
    const item = createFileItem('file-1')
    const handleDragEnd = vi.fn()
    const handleTransformEnd = vi.fn()

    render(
      <ProjectCanvasPageStageScene
        {...createBaseProps([item])}
        handleDragEnd={handleDragEnd}
        handleTransformEnd={handleTransformEnd}
      />
    )

    await waitFor(() => {
      expect(rectInteractionOverlayProps.has(item.id)).toBe(true)
    })

    expect(screen.getByTestId(`rect-overlay-${item.id}`)).toHaveAttribute(
      'data-overlay-role',
      'file-interaction'
    )
    expect(canvasPlaceholderProps.get(item.id)?.renderMode).toBe('dom-file-proxy')
    expect(canvasPlaceholderProps.get(item.id)?.isDraggable).toBe(false)

    act(() => {
      ;(
        rectInteractionOverlayProps.get(item.id)?.onDragEnd as
          | ((id: string, x: number, y: number) => void)
          | undefined
      )?.(item.id, 240, 180)
    })

    expect(handleDragEnd).toHaveBeenCalledWith(item.id, 240, 180)

    act(() => {
      ;(
        rectInteractionOverlayProps.get(item.id)?.onTransformEnd as
          | ((
              id: string,
              attrs: { x: number; y: number; scaleX: number; scaleY: number; rotation: number }
            ) => void)
          | undefined
      )?.(item.id, {
        x: 220,
        y: 132,
        scaleX: 1.5,
        scaleY: 1.25,
        rotation: 14
      })
    })

    expect(handleTransformEnd).toHaveBeenCalledWith(item.id, {
      x: 220,
      y: 132,
      width: 480,
      height: 250,
      rotation: 14
    })
  })

  it('routes a selected text node through the DOM rect interaction overlay', async () => {
    const item = createTextItem('text-1')
    const handleTransformEnd = vi.fn()
    const expectedWidth = 252
    const expectedFontSize = 18
    const expectedHeight = measureCanvasTextBoxHeightMock({
      text: item.text,
      fontSize: expectedFontSize,
      fontFamily: item.fontFamily,
      width: expectedWidth
    })

    render(
      <ProjectCanvasPageStageScene
        {...createBaseProps([item])}
        handleTransformEnd={handleTransformEnd}
      />
    )

    await waitFor(() => {
      expect(rectInteractionOverlayProps.has(item.id)).toBe(true)
    })

    expect(screen.getByTestId(`rect-overlay-${item.id}`)).toHaveAttribute(
      'data-overlay-role',
      'text-interaction'
    )
    expect(canvasPlaceholderProps.get(item.id)?.renderMode).toBe('dom-text-proxy')
    expect(canvasPlaceholderProps.get(item.id)?.isDraggable).toBe(false)

    const previewContent = rectInteractionOverlayProps.get(item.id)?.previewContent
    expect(previewContent).toBeTruthy()
    const previewRender = render(<>{previewContent as React.ReactNode}</>)
    expect(previewRender.getByText(item.text)).toBeInTheDocument()
    previewRender.unmount()

    act(() => {
      ;(
        rectInteractionOverlayProps.get(item.id)?.onTransformEnd as
          | ((
              id: string,
              attrs: { x: number; y: number; scaleX: number; scaleY: number; rotation: number },
              handle: string
            ) => void)
          | undefined
      )?.(
        item.id,
        {
          x: 120,
          y: 132,
          scaleX: 1.4,
          scaleY: 1.15,
          rotation: 11
        },
        'middle-right'
      )
    })

    expect(handleTransformEnd).toHaveBeenCalledTimes(1)
    expect(handleTransformEnd.mock.calls[0]?.[0]).toBe(item.id)
    expect(handleTransformEnd.mock.calls[0]?.[1]).toEqual({
      x: 120,
      y: 132,
      width: expect.closeTo(expectedWidth, 6),
      height: expectedHeight,
      fontSize: expectedFontSize,
      rotation: 11
    })
  })

  it('emits drag preview sync for a selected text node', async () => {
    const item = createTextItem('text-preview-sync')
    const handleDragEnd = vi.fn()
    const syncListener = vi.fn()
    window.addEventListener(`canvas-sync-${item.id}`, syncListener)

    render(
      <ProjectCanvasPageStageScene {...createBaseProps([item])} handleDragEnd={handleDragEnd} />
    )

    await waitFor(() => {
      expect(rectInteractionOverlayProps.has(item.id)).toBe(true)
    })

    act(() => {
      ;(
        rectInteractionOverlayProps.get(item.id)?.onPreviewChange as
          | ((
              id: string,
              preview: {
                x: number
                y: number
                scaleX: number
                scaleY: number
                rotation: number
              },
              handle: string
            ) => void)
          | undefined
      )?.(
        item.id,
        {
          x: 180,
          y: 210,
          scaleX: 1,
          scaleY: 1,
          rotation: 0
        },
        'drag'
      )
    })

    expect(cancelCanvasSyncMock).toHaveBeenCalledWith(item.id)
    expect(syncListener).toHaveBeenCalledTimes(1)
    expect((syncListener.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      x: 180,
      y: 210,
      scaleX: 1,
      scaleY: 1,
      rotation: 0
    })

    act(() => {
      ;(
        rectInteractionOverlayProps.get(item.id)?.onDragEnd as
          | ((id: string, x: number, y: number) => void)
          | undefined
      )?.(item.id, 180, 210)
    })

    expect(cancelCanvasSyncMock).toHaveBeenCalledWith(item.id)
    expect(handleDragEnd).toHaveBeenCalledWith(item.id, 180, 210, undefined)
    window.removeEventListener(`canvas-sync-${item.id}`, syncListener)
  })

  it('emits drag preview sync for a selected text annotation', async () => {
    const item = createAnnotationItem('annotation-text-preview-sync', {
      shape: 'text-anno',
      label: '',
      text: '123',
      fontSize: 24,
      x: 96,
      y: 128,
      width: 180,
      height: 40
    })
    const handleDragEnd = vi.fn()
    const syncListener = vi.fn()
    window.addEventListener(`canvas-sync-${item.id}`, syncListener)

    render(
      <ProjectCanvasPageStageScene {...createBaseProps([item])} handleDragEnd={handleDragEnd} />
    )

    await waitFor(() => {
      expect(rectInteractionOverlayProps.has(item.id)).toBe(true)
    })

    act(() => {
      ;(
        rectInteractionOverlayProps.get(item.id)?.onPreviewChange as
          | ((
              id: string,
              preview: {
                x: number
                y: number
                scaleX: number
                scaleY: number
                rotation: number
              },
              handle: string
            ) => void)
          | undefined
      )?.(
        item.id,
        {
          x: 180,
          y: 210,
          scaleX: 1,
          scaleY: 1,
          rotation: 0
        },
        'drag'
      )
    })

    expect(cancelCanvasSyncMock).toHaveBeenCalledWith(item.id)
    expect(syncListener).toHaveBeenCalledTimes(1)
    expect((syncListener.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      x: 180,
      y: 210,
      scaleX: 1,
      scaleY: 1,
      rotation: 0
    })

    act(() => {
      ;(
        rectInteractionOverlayProps.get(item.id)?.onDragEnd as
          | ((id: string, x: number, y: number) => void)
          | undefined
      )?.(item.id, 180, 210)
    })

    expect(cancelCanvasSyncMock).toHaveBeenCalledWith(item.id)
    expect(handleDragEnd).toHaveBeenCalledWith(item.id, 180, 210, undefined)
    window.removeEventListener(`canvas-sync-${item.id}`, syncListener)
  })

  it('passes the committed text font settings into the inline editor when a text node enters edit mode', async () => {
    const item = {
      ...createTextItem('text-inline-editor'),
      fontFamily: 'ProjectFont',
      fontWeight: 'bold' as const
    }
    const setInlineTextEdit = vi.fn()
    const setSelectedIds = vi.fn()

    render(
      <ProjectCanvasPageStageScene
        {...createBaseProps([item])}
        setInlineTextEdit={setInlineTextEdit}
        setSelectedIds={setSelectedIds}
      />
    )

    await waitFor(() => {
      expect(rectInteractionOverlayProps.has(item.id)).toBe(true)
    })

    act(() => {
      ;(rectInteractionOverlayProps.get(item.id)?.onDoubleClick as (() => void) | undefined)?.()
    })

    expect(setSelectedIds).toHaveBeenCalledWith(new Set())
    expect(setInlineTextEdit).toHaveBeenCalledWith({
      id: item.id,
      x: item.x,
      y: item.y,
      w: item.width,
      h: item.height,
      text: item.text,
      isNew: false,
      fontSize: item.fontSize,
      fontFamily: item.fontFamily,
      fontWeight: item.fontWeight,
      fill: item.fill
    })
  })

  it('keeps a text placeholder draggable while selection promotes during an active drag', async () => {
    const item = createTextItem('text-promote-drag')
    const handleDragEnd = vi.fn()
    const props = createBaseProps([item])
    props.selectedIds = new Set()
    props.handleDragEnd = handleDragEnd

    const { rerender } = render(<ProjectCanvasPageStageScene {...props} />)

    await waitFor(() => {
      expect(canvasPlaceholderProps.has(item.id)).toBe(true)
    })

    act(() => {
      ;(
        canvasPlaceholderProps.get(item.id)?.onDragStart as ((itemId: string) => void) | undefined
      )?.(item.id)
    })

    expect(props.dragContextRef.current.draggingId).toBe(item.id)

    rerender(<ProjectCanvasPageStageScene {...props} selectedIds={new Set([item.id])} />)

    await waitFor(() => {
      expect(canvasPlaceholderProps.get(item.id)?.isDraggable).toBe(true)
    })

    expect(rectInteractionOverlayProps.has(item.id)).toBe(false)

    act(() => {
      ;(
        canvasPlaceholderProps.get(item.id)?.onDragEnd as
          | ((id: string, x: number, y: number) => void)
          | undefined
      )?.(item.id, 150, 180)
    })

    expect(handleDragEnd).toHaveBeenCalledWith(item.id, 150, 180, undefined)
    expect(props.dragContextRef.current.draggingId).toBeNull()

    rerender(<ProjectCanvasPageStageScene {...props} selectedIds={new Set([item.id])} />)

    await waitFor(() => {
      expect(rectInteractionOverlayProps.has(item.id)).toBe(true)
    })

    expect(canvasPlaceholderProps.get(item.id)?.isDraggable).toBe(false)
  })

  it('keeps an image placeholder draggable while selection promotes during an active drag', async () => {
    const item = createImageItem('image-promote-drag')
    const handleDragEnd = vi.fn()
    const props = createBaseProps([item])
    props.selectedIds = new Set()
    props.handleDragEnd = handleDragEnd
    webglReady = true
    webglLoadedIds = new Set([item.id])
    webglResidentIds = new Set([item.id])

    const { rerender } = render(<ProjectCanvasPageStageScene {...props} />)

    await waitFor(() => {
      expect(canvasPlaceholderProps.has(item.id)).toBe(true)
    })

    expect(imageInteractionOverlayProps.has(item.id)).toBe(false)

    act(() => {
      ;(
        canvasPlaceholderProps.get(item.id)?.onDragStart as ((itemId: string) => void) | undefined
      )?.(item.id)
    })

    expect(props.dragContextRef.current.draggingId).toBe(item.id)

    rerender(<ProjectCanvasPageStageScene {...props} selectedIds={new Set([item.id])} />)

    await waitFor(() => {
      expect(canvasPlaceholderProps.get(item.id)?.isDraggable).toBe(true)
    })

    expect(imageInteractionOverlayProps.has(item.id)).toBe(false)

    act(() => {
      ;(
        canvasPlaceholderProps.get(item.id)?.onDragEnd as
          | ((id: string, x: number, y: number) => void)
          | undefined
      )?.(item.id, 188, 232)
    })

    expect(handleDragEnd).toHaveBeenCalledWith(item.id, 188, 232, undefined)
    expect(props.dragContextRef.current.draggingId).toBeNull()

    rerender(<ProjectCanvasPageStageScene {...props} selectedIds={new Set([item.id])} />)

    await waitFor(() => {
      expect(imageInteractionOverlayProps.has(item.id)).toBe(true)
    })

    expect(canvasPlaceholderProps.has(item.id)).toBe(false)
  })

  it('keeps a text annotation placeholder syncing drag preview while selection promotes', async () => {
    const item = createAnnotationItem('annotation-text-promote-drag', {
      shape: 'text-anno',
      text: 'Preview label',
      label: '',
      fontSize: 24,
      width: 180,
      height: 36
    })
    const handleDragEnd = vi.fn()
    const props = createBaseProps([item])
    props.selectedIds = new Set()
    props.handleDragEnd = handleDragEnd

    const { rerender } = render(<ProjectCanvasPageStageScene {...props} />)

    await waitFor(() => {
      expect(canvasPlaceholderProps.has(item.id)).toBe(true)
    })

    act(() => {
      ;(
        canvasPlaceholderProps.get(item.id)?.onDragStart as ((itemId: string) => void) | undefined
      )?.(item.id)
    })

    expect(props.dragContextRef.current.draggingId).toBe(item.id)

    rerender(<ProjectCanvasPageStageScene {...props} selectedIds={new Set([item.id])} />)

    await waitFor(() => {
      expect(canvasPlaceholderProps.get(item.id)?.isDraggable).toBe(true)
    })

    expect(rectInteractionOverlayProps.has(item.id)).toBe(false)

    act(() => {
      ;(
        canvasPlaceholderProps.get(item.id)?.onRectPreviewChange as
          | ((
              itemId: string,
              preview: {
                x: number
                y: number
                scaleX: number
                scaleY: number
                rotation: number
              } | null
            ) => void)
          | undefined
      )?.(item.id, {
        x: 104,
        y: 132,
        scaleX: 1,
        scaleY: 1,
        rotation: 0
      })
    })

    expect(scheduleCanvasSyncMock).toHaveBeenCalledWith(item.id, {
      x: 104,
      y: 132,
      scaleX: 1,
      scaleY: 1,
      rotation: 0
    })

    act(() => {
      ;(
        canvasPlaceholderProps.get(item.id)?.onDragEnd as
          | ((id: string, x: number, y: number) => void)
          | undefined
      )?.(item.id, 104, 132)
    })

    expect(cancelCanvasSyncMock).toHaveBeenCalledWith(item.id)
    expect(handleDragEnd).toHaveBeenCalledWith(item.id, 104, 132, undefined)
    expect(props.dragContextRef.current.draggingId).toBeNull()

    rerender(<ProjectCanvasPageStageScene {...props} selectedIds={new Set([item.id])} />)

    await waitFor(() => {
      expect(rectInteractionOverlayProps.has(item.id)).toBe(true)
    })

    expect(canvasPlaceholderProps.get(item.id)?.isDraggable).toBe(false)
  })

  it('keeps the text annotation transform overlay mounted while the viewport is interacting', async () => {
    const item = createAnnotationItem('annotation-text-viewport-interacting', {
      shape: 'text-anno',
      text: 'Zoom label',
      label: '',
      fontSize: 24,
      width: 180,
      height: 36
    })

    render(
      <ProjectCanvasPageStageScene
        {...createBaseProps([item])}
        isViewportInteracting
        selectedIds={new Set([item.id])}
      />
    )

    await waitFor(() => {
      expect(canvasPlaceholderProps.has(item.id)).toBe(true)
    })

    expect(canvasPlaceholderProps.get(item.id)?.renderMode).toBe('dom-annotation-proxy')
    expect(rectInteractionOverlayProps.has(item.id)).toBe(true)
  })

  it('keeps a 3D placeholder draggable while selection promotes during an active drag', async () => {
    const item = createModel3DItem('model-promote-drag')
    const handleDragEnd = vi.fn()
    const props = createBaseProps([item])
    props.selectedIds = new Set()
    props.handleDragEnd = handleDragEnd

    const { rerender } = render(<ProjectCanvasPageStageScene {...props} />)

    await waitFor(() => {
      expect(canvasPlaceholderProps.has(item.id)).toBe(true)
    })

    act(() => {
      ;(
        canvasPlaceholderProps.get(item.id)?.onDragStart as ((itemId: string) => void) | undefined
      )?.(item.id)
    })

    expect(props.dragContextRef.current.draggingId).toBe(item.id)

    rerender(<ProjectCanvasPageStageScene {...props} selectedIds={new Set([item.id])} />)

    await waitFor(() => {
      expect(canvasPlaceholderProps.get(item.id)?.isDraggable).toBe(true)
    })

    expect(rectInteractionOverlayProps.has(item.id)).toBe(false)

    act(() => {
      ;(
        canvasPlaceholderProps.get(item.id)?.onDragEnd as
          | ((id: string, x: number, y: number) => void)
          | undefined
      )?.(item.id, 188, 232)
    })

    expect(handleDragEnd).toHaveBeenCalledWith(item.id, 188, 232, undefined)
    expect(props.dragContextRef.current.draggingId).toBeNull()

    rerender(<ProjectCanvasPageStageScene {...props} selectedIds={new Set([item.id])} />)

    await waitFor(() => {
      expect(rectInteractionOverlayProps.has(item.id)).toBe(true)
    })

    expect(canvasPlaceholderProps.get(item.id)?.isDraggable).toBe(false)
  })

  it('routes a selected rectangle annotation through the DOM rect interaction overlay', async () => {
    const item = createAnnotationItem('annotation-rect')
    const handleTransformEnd = vi.fn()

    render(
      <ProjectCanvasPageStageScene
        {...createBaseProps([item])}
        handleTransformEnd={handleTransformEnd}
      />
    )

    await waitFor(() => {
      expect(rectInteractionOverlayProps.has(item.id)).toBe(true)
    })

    expect(screen.getByTestId(`rect-overlay-${item.id}`)).toHaveAttribute(
      'data-overlay-role',
      'annotation-interaction'
    )
    expect(canvasPlaceholderProps.get(item.id)?.renderMode).toBe('dom-annotation-proxy')
    expect(canvasPlaceholderProps.get(item.id)?.isSelected).toBe(false)
    expect(canvasPlaceholderProps.get(item.id)?.isDraggable).toBe(false)

    act(() => {
      ;(
        rectInteractionOverlayProps.get(item.id)?.onTransformEnd as
          | ((
              id: string,
              attrs: { x: number; y: number; scaleX: number; scaleY: number; rotation: number },
              handle: string
            ) => void)
          | undefined
      )?.(
        item.id,
        {
          x: 96,
          y: 112,
          scaleX: 1.25,
          scaleY: 0.8,
          rotation: 17
        },
        'bottom-right'
      )
    })

    expect(handleTransformEnd).toHaveBeenCalledWith(item.id, {
      x: 96,
      y: 112,
      width: 200,
      height: 80,
      rotation: 17,
      scaleX: 1,
      scaleY: 1
    })
  })

  it('routes a flipped rectangle annotation through the DOM rect overlay and preserves drag deltas', async () => {
    const item = createAnnotationItem('annotation-flipped-rect', {
      x: 120,
      y: 160,
      width: 80,
      height: 50,
      scaleX: -1,
      scaleY: 1
    })
    const handleDragEnd = vi.fn()
    const handleTransformEnd = vi.fn()

    render(
      <ProjectCanvasPageStageScene
        {...createBaseProps([item])}
        handleDragEnd={handleDragEnd}
        handleTransformEnd={handleTransformEnd}
      />
    )

    await waitFor(() => {
      expect(rectInteractionOverlayProps.has(item.id)).toBe(true)
    })

    expect(screen.getByTestId(`rect-overlay-${item.id}`)).toHaveAttribute(
      'data-overlay-role',
      'annotation-interaction'
    )
    expect(canvasPlaceholderProps.get(item.id)?.renderMode).toBe('dom-annotation-proxy')
    expect(canvasPlaceholderProps.get(item.id)?.isSelected).toBe(false)
    expect(canvasPlaceholderProps.get(item.id)?.isDraggable).toBe(false)

    act(() => {
      ;(
        rectInteractionOverlayProps.get(item.id)?.onDragEnd as
          | ((id: string, x: number, y: number) => void)
          | undefined
      )?.(item.id, 70, 180)
    })

    expect(handleDragEnd).toHaveBeenCalledWith(item.id, 150, 180, undefined)

    act(() => {
      ;(
        rectInteractionOverlayProps.get(item.id)?.onTransformEnd as
          | ((
              id: string,
              attrs: { x: number; y: number; scaleX: number; scaleY: number; rotation: number },
              handle: string
            ) => void)
          | undefined
      )?.(
        item.id,
        {
          x: 70,
          y: 180,
          scaleX: 1.5,
          scaleY: 0.8,
          rotation: 12
        },
        'bottom-right'
      )
    })

    expect(handleTransformEnd).toHaveBeenCalledWith(item.id, {
      x: 70,
      y: 180,
      width: 120,
      height: 40,
      rotation: 12,
      scaleX: 1,
      scaleY: 1
    })
  })

  it('keeps text-anno transform semantics on the DOM annotation overlay', async () => {
    const item = createAnnotationItem('annotation-text', {
      shape: 'text-anno',
      text: 'Label copy',
      label: '',
      fontSize: 24,
      width: 180,
      height: 36
    })
    const handleTransformEnd = vi.fn()
    const expectedWidth = 216
    const expectedFontSize = 24
    const expectedHeight = measureCanvasAnnotationTextHeightMock({
      text: item.text,
      width: expectedWidth,
      fontSize: expectedFontSize,
      fontWeight: item.fontWeight
    })

    render(
      <ProjectCanvasPageStageScene
        {...createBaseProps([item])}
        handleTransformEnd={handleTransformEnd}
      />
    )

    await waitFor(() => {
      expect(rectInteractionOverlayProps.has(item.id)).toBe(true)
    })

    act(() => {
      ;(
        rectInteractionOverlayProps.get(item.id)?.onTransformEnd as
          | ((
              id: string,
              attrs: { x: number; y: number; scaleX: number; scaleY: number; rotation: number },
              handle: string
            ) => void)
          | undefined
      )?.(
        item.id,
        {
          x: 88,
          y: 118,
          scaleX: 1.2,
          scaleY: 0.9,
          rotation: 9
        },
        'middle-right'
      )
    })

    expect(handleTransformEnd).toHaveBeenCalledWith(item.id, {
      x: 88,
      y: 118,
      width: expectedWidth,
      height: expectedHeight,
      fontSize: expectedFontSize,
      rotation: 9,
      scaleX: 1,
      scaleY: 1
    })
  })

  it('routes line annotations through the DOM rect overlay and remaps endpoints', async () => {
    const item = createAnnotationItem('annotation-line', {
      shape: 'line',
      x: 100,
      y: 120,
      width: 0,
      height: 0,
      endX: 160,
      endY: 200
    })
    const handleTransformEnd = vi.fn()

    render(
      <ProjectCanvasPageStageScene
        {...createBaseProps([item])}
        handleTransformEnd={handleTransformEnd}
      />
    )

    await waitFor(() => {
      expect(rectInteractionOverlayProps.has(item.id)).toBe(true)
    })

    expect(screen.getByTestId(`rect-overlay-${item.id}`)).toHaveAttribute(
      'data-overlay-role',
      'annotation-interaction'
    )
    expect(canvasPlaceholderProps.get(item.id)?.renderMode).toBe('dom-annotation-proxy')

    act(() => {
      ;(
        rectInteractionOverlayProps.get(item.id)?.onTransformEnd as
          | ((
              id: string,
              attrs: { x: number; y: number; scaleX: number; scaleY: number; rotation: number },
              handle: string
            ) => void)
          | undefined
      )?.(
        item.id,
        {
          x: 140,
          y: 160,
          scaleX: 1.5,
          scaleY: 0.5,
          rotation: 15
        },
        'bottom-right'
      )
    })

    expect(handleTransformEnd).toHaveBeenCalledWith(item.id, {
      x: 140,
      y: 160,
      width: 90,
      height: 40,
      endX: 230,
      endY: 200,
      rotation: 15,
      scaleX: 1,
      scaleY: 1
    })
  })

  it('moves line annotations through the DOM rect overlay and shifts endpoints on drag', async () => {
    const item = createAnnotationItem('annotation-line-drag', {
      shape: 'line',
      x: 100,
      y: 120,
      width: 0,
      height: 0,
      endX: 160,
      endY: 200
    })
    const handleTransformEnd = vi.fn()

    render(
      <ProjectCanvasPageStageScene
        {...createBaseProps([item])}
        handleTransformEnd={handleTransformEnd}
      />
    )

    await waitFor(() => {
      expect(rectInteractionOverlayProps.has(item.id)).toBe(true)
    })

    act(() => {
      ;(
        rectInteractionOverlayProps.get(item.id)?.onDragEnd as
          | ((id: string, x: number, y: number) => void)
          | undefined
      )?.(item.id, 140, 150)
    })

    expect(handleTransformEnd).toHaveBeenCalledWith(item.id, {
      x: 140,
      y: 150,
      endX: 200,
      endY: 230
    })
  })

  it('routes free-draw annotations through the DOM rect overlay and rescales points', async () => {
    const item = createAnnotationItem('annotation-freedraw', {
      shape: 'freedraw',
      x: 10,
      y: 10,
      width: 30,
      height: 20,
      points: [10, 10, 30, 30, 40, 20]
    })
    const handleTransformEnd = vi.fn()

    render(
      <ProjectCanvasPageStageScene
        {...createBaseProps([item])}
        handleTransformEnd={handleTransformEnd}
      />
    )

    await waitFor(() => {
      expect(rectInteractionOverlayProps.has(item.id)).toBe(true)
    })

    act(() => {
      ;(
        rectInteractionOverlayProps.get(item.id)?.onTransformEnd as
          | ((
              id: string,
              attrs: { x: number; y: number; scaleX: number; scaleY: number; rotation: number },
              handle: string
            ) => void)
          | undefined
      )?.(
        item.id,
        {
          x: 20,
          y: 25,
          scaleX: 2,
          scaleY: 1.5,
          rotation: 10
        },
        'bottom-right'
      )
    })

    expect(handleTransformEnd).toHaveBeenCalledWith(item.id, {
      x: 20,
      y: 25,
      width: 60,
      height: 30,
      points: [20, 25, 60, 55, 80, 40],
      rotation: 10,
      scaleX: 1,
      scaleY: 1
    })
  })

  it('keeps loaded annotate images on the placeholder proxy path without obscuring the WebGL image', async () => {
    const item = createImageItem('image-placeholder')
    webglReady = true
    webglLoadedIds = new Set([item.id])
    webglResidentIds = new Set([item.id])

    render(
      <ProjectCanvasPageStageScene
        {...createBaseProps([item])}
        tool="annotate"
        selectedIds={new Set([item.id])}
      />
    )

    await waitFor(() => {
      expect(canvasPlaceholderProps.has(item.id)).toBe(true)
    })
    expect(imageInteractionOverlayProps.has(item.id)).toBe(false)
    expect(rectInteractionOverlayProps.has(item.id)).toBe(false)
    expect(canvasPlaceholderProps.get(item.id)?.isSelected).toBe(false)
    expect(canvasPlaceholderProps.get(item.id)?.isDraggable).toBe(false)
    expect(canvasPlaceholderProps.get(item.id)?.renderMode).toBe('dom-placeholder-proxy')
    expect(canvasPlaceholderProps.get(item.id)?.visualVariant).toBe('transparent')
    expect(canvasPlaceholderProps.get(item.id)?.onPreviewChange).toBeUndefined()
  })

  it('classifies loaded-but-nonresident images as budget proxies instead of fallback', async () => {
    const item = createImageItem('image-budget-proxy')
    webglReady = true
    webglLoadedIds = new Set([item.id])
    webglResidentIds = new Set()
    latestWebGLMetrics = {
      isInitialized: true,
      imageCount: 1,
      loadedImageCount: 1,
      failedImageCount: 0,
      residentImageCount: 0,
      residentTextureBytes: 0,
      residentCandidateTextureBytes: 24000,
      residentTextureBudgetBytes: 768 * 1024 * 1024,
      pendingImageCount: 0,
      spriteCount: 0,
      residentCandidateImageCount: 1,
      viewportCulledImageCount: 0,
      usingPreviewImageCount: 0,
      usingSourceImageCount: 0,
      thumbnailPreviewImageCount: 0,
      placeholderImageCount: 0,
      sourceUpgradeSuppressedImageCount: 0,
      sourceUpgradeablePreviewImageCount: 0,
      sourceUpgradePendingImageCount: 0,
      sourceUpgradeFailedImageCount: 0,
      missingImageCount: 0,
      renderCount: 2,
      lastRenderDurationMs: 4,
      lastUpdateReason: 'items'
    }

    render(
      <ProjectCanvasPageStageScene
        {...createBaseProps([item])}
        tool="select"
        selectedIds={new Set([item.id])}
      />
    )

    await waitFor(() => {
      expect(imageInteractionOverlayProps.has(item.id)).toBe(true)
    })

    const root = screen.getByTestId('project-canvas-stage-root')
    expect(root).toHaveAttribute('data-project-canvas-budget-downgraded-image-count', '1')
    expect(root).toHaveAttribute('data-project-canvas-fallback-image-count', '0')
    expect(imageInteractionOverlayProps.get(item.id)?.renderMode).toBe('budget-image-proxy')
    expect(imageInteractionOverlayProps.get(item.id)?.suppressImagePreview).toBe(false)
  })

  it('keeps unselected fallback images visible through the DOM placeholder proxy', async () => {
    const item = createImageItem('image-fallback-unselected')
    item.image = undefined
    webglReady = true
    webglLoadedIds = new Set()
    webglResidentIds = new Set()

    render(
      <ProjectCanvasPageStageScene
        {...createBaseProps([item])}
        tool="select"
        selectedIds={new Set()}
      />
    )

    await waitFor(() => {
      expect(canvasPlaceholderProps.has(item.id)).toBe(true)
    })

    const root = screen.getByTestId('project-canvas-stage-root')
    expect(root).toHaveAttribute('data-project-canvas-fallback-image-count', '1')
    expect(root).toHaveAttribute('data-project-canvas-unloaded-fallback-image-count', '1')
    expect(imageInteractionOverlayProps.has(item.id)).toBe(false)
    expect(canvasPlaceholderProps.get(item.id)?.isSelected).toBe(false)
    expect(canvasPlaceholderProps.get(item.id)?.renderMode).toBe('dom-placeholder-proxy')
    expect(canvasPlaceholderProps.get(item.id)?.visualVariant).toBe('image-fallback')
  })

  it('keeps multi-selected fallback images visible while a large selection rect is present', async () => {
    const imageItem = createImageItem('image-fallback-multi-selected')
    const shapeItem = createAnnotationItem('shape-fallback-multi-selected')
    shapeItem.x = 900
    webglReady = true
    webglLoadedIds = new Set()
    webglResidentIds = new Set()

    render(
      <ProjectCanvasPageStageScene
        {...createBaseProps([imageItem, shapeItem])}
        tool="select"
        selectedIds={new Set([imageItem.id, shapeItem.id])}
        selectionRect={{
          startX: 40,
          startY: 60,
          x: 40,
          y: 60,
          w: 920,
          h: 180
        }}
      />
    )

    await waitFor(() => {
      expect(canvasPlaceholderProps.has(imageItem.id)).toBe(true)
    })

    expect(imageInteractionOverlayProps.has(imageItem.id)).toBe(false)
    expect(canvasPlaceholderProps.get(imageItem.id)?.isSelected).toBe(true)
    expect(canvasPlaceholderProps.get(imageItem.id)?.visualVariant).toBe('image-fallback')
  })

  it('routes a selected fallback image through the DOM image interaction overlay', async () => {
    const item = createImageItem('image-placeholder-dom')
    const handleTransformEnd = vi.fn()
    webglReady = false
    webglLoadedIds = new Set()

    const view = render(
      <ProjectCanvasPageStageScene
        {...createBaseProps([item])}
        handleTransformEnd={handleTransformEnd}
        tool="annotate"
        selectedIds={new Set([item.id])}
      />
    )

    expect(rectInteractionOverlayProps.size).toBe(0)

    view.rerender(
      <ProjectCanvasPageStageScene
        {...createBaseProps([item])}
        handleTransformEnd={handleTransformEnd}
        selectedIds={new Set([item.id])}
      />
    )

    await waitFor(() => {
      expect(imageInteractionOverlayProps.has(item.id)).toBe(true)
    })

    expect(rectInteractionOverlayProps.has(item.id)).toBe(false)
    expect(canvasPlaceholderProps.has(item.id)).toBe(false)
    expect(imageInteractionOverlayProps.get(item.id)?.isSelected).toBe(true)
    expect(imageInteractionOverlayProps.get(item.id)?.showTransformer).toBe(true)
    expect(imageInteractionOverlayProps.get(item.id)?.renderMode).toBe('fallback-image-proxy')
    expect(imageInteractionOverlayProps.get(item.id)?.suppressImagePreview).toBe(false)

    act(() => {
      ;(
        imageInteractionOverlayProps.get(item.id)?.onPreviewChange as
          | ((itemId: string, preview: ProjectCanvasImagePreview | null) => void)
          | undefined
      )?.(item.id, {
        x: 124,
        y: 156,
        width: 200,
        height: 120,
        scaleX: 1.1,
        scaleY: 0.95,
        rotation: 10
      })
    })

    expect(syncItemPreviewSpy).toHaveBeenCalledWith(item.id, {
      x: 124,
      y: 156,
      width: 200,
      height: 120,
      scaleX: 1.1,
      scaleY: 0.95,
      rotation: 10
    })

    act(() => {
      ;(
        imageInteractionOverlayProps.get(item.id)?.onTransformEnd as
          | ((
              id: string,
              attrs: { x: number; y: number; scaleX: number; scaleY: number; rotation: number }
            ) => void)
          | undefined
      )?.(item.id, {
        x: 124,
        y: 156,
        scaleX: 1.1,
        scaleY: 0.95,
        rotation: 10
      })
    })

    expect(handleTransformEnd).toHaveBeenCalledWith(item.id, {
      x: 124,
      y: 156,
      scaleX: 1.1,
      scaleY: 0.95,
      rotation: 10
    })
  })

  it('suppresses the Konva placeholder selection stroke when a selected 3D item uses the DOM rect overlay', async () => {
    const item = createModel3DItem('model-dom')

    render(<ProjectCanvasPageStageScene {...createBaseProps([item])} />)

    await waitFor(() => {
      expect(rectInteractionOverlayProps.has(item.id)).toBe(true)
    })

    expect(screen.getByTestId(`rect-overlay-${item.id}`)).toHaveAttribute(
      'data-overlay-role',
      'placeholder-interaction'
    )
    expect(canvasPlaceholderProps.get(item.id)?.isSelected).toBe(false)
    expect(canvasPlaceholderProps.get(item.id)?.isDraggable).toBe(false)
  })

  it('lets selected video content keep pointer access while the DOM rect overlay owns selection chrome', async () => {
    const item = createVideoItem('video-dom')

    render(
      <ProjectCanvasPageStageScene {...createBaseProps([item])} selectedIds={new Set([item.id])} />
    )

    await waitFor(() => {
      expect(rectInteractionOverlayProps.has(item.id)).toBe(true)
    })

    expect(screen.getByTestId(`rect-overlay-${item.id}`)).toHaveAttribute(
      'data-overlay-role',
      'placeholder-interaction'
    )
    expect(rectInteractionOverlayProps.get(item.id)?.contentPointerPassthrough).toBe(true)
    expect(rectInteractionOverlayProps.get(item.id)?.contentDragSurfaceInset).toEqual({
      bottom: 40
    })
    expect(canvasPlaceholderProps.has(item.id)).toBe(false)
  })

  it('keeps the selected video DOM interaction layer on the item z-index so higher overlaps stay draggable', async () => {
    const item = createVideoItem('video-selected-z-index')
    item.zIndex = 2

    render(
      <ProjectCanvasPageStageScene {...createBaseProps([item])} selectedIds={new Set([item.id])} />
    )

    await waitFor(() => {
      expect(rectInteractionOverlayProps.has(item.id)).toBe(true)
    })

    const wrapper = document.querySelector(
      '[data-project-canvas-rect-interaction-layer="dom-placeholder"]'
    )

    expect(wrapper).not.toBeNull()
    expect(window.getComputedStyle(wrapper as HTMLElement).zIndex).toBe(String(item.zIndex))
  })

  it('keeps each DOM image interaction wrapper on the image z-index instead of lifting the whole layer', async () => {
    const item = createImageItem('image-selected-z-index')
    item.zIndex = 4
    webglReady = true
    webglLoadedIds = new Set([item.id])
    webglResidentIds = new Set([item.id])

    render(
      <ProjectCanvasPageStageScene {...createBaseProps([item])} selectedIds={new Set([item.id])} />
    )

    await waitFor(() => {
      expect(imageInteractionOverlayProps.has(item.id)).toBe(true)
    })

    const wrapper = document.querySelector(
      `[data-project-canvas-image-interaction-item-id="${item.id}"]`
    )

    expect(wrapper).not.toBeNull()
    expect(window.getComputedStyle(wrapper as HTMLElement).zIndex).toBe(String(item.zIndex))
  })

  it('routes hand-tool left-drag events from WebGL image placeholder proxies back to the stage handlers', async () => {
    const item = createImageItem('image-hand-pan')
    webglReady = true
    webglLoadedIds = new Set([item.id])
    webglResidentIds = new Set([item.id])
    const props = createBaseProps([item])
    props.tool = 'hand'

    render(<ProjectCanvasPageStageScene {...props} />)

    await waitFor(() => {
      expect(canvasPlaceholderProps.has(item.id)).toBe(true)
    })

    expect(imageInteractionOverlayProps.has(item.id)).toBe(false)
    expect(canvasPlaceholderProps.get(item.id)?.visualVariant).toBe('transparent')

    const overlay = screen.getByTestId(`canvas-placeholder-${item.id}`)

    fireEvent.mouseDown(overlay, { button: 0, clientX: 120, clientY: 140 })
    fireEvent.mouseMove(overlay, { buttons: 1, clientX: 168, clientY: 196 })
    fireEvent.mouseUp(overlay, { button: 0, clientX: 168, clientY: 196 })

    const mouseDownArg = (props.handleStageMouseDown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(mouseDownArg?.type).toBe('mousedown')
    expect(mouseDownArg?.evt.button).toBe(0)
    expect(mouseDownArg?.evt.clientX).toBe(120)
    expect(mouseDownArg?.evt.clientY).toBe(140)

    const mouseMoveArg = (props.handleStageMouseMove as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(mouseMoveArg?.type).toBe('mousemove')
    expect(mouseMoveArg?.evt.clientX).toBe(168)
    expect(mouseMoveArg?.evt.clientY).toBe(196)

    const mouseUpArg = (props.handleStageMouseUp as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(mouseUpArg?.type).toBe('mouseup')
    expect(mouseUpArg?.evt.button).toBe(0)
  })

  it('routes hand-tool left-drag events from placeholder proxies back to the stage handlers', async () => {
    const item = createFileItem('file-hand-pan')
    const props = createBaseProps([item])
    props.tool = 'hand'

    render(<ProjectCanvasPageStageScene {...props} />)

    await waitFor(() => {
      expect(canvasPlaceholderProps.has(item.id)).toBe(true)
    })

    const overlay = screen.getByTestId(`canvas-placeholder-${item.id}`)

    fireEvent.mouseDown(overlay, { button: 0, clientX: 140, clientY: 160 })
    fireEvent.mouseMove(overlay, { buttons: 1, clientX: 190, clientY: 214 })
    fireEvent.mouseUp(overlay, { button: 0, clientX: 190, clientY: 214 })

    const mouseDownArg = (props.handleStageMouseDown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(mouseDownArg?.type).toBe('mousedown')
    expect(mouseDownArg?.evt.button).toBe(0)
    expect(mouseDownArg?.evt.clientX).toBe(140)
    expect(mouseDownArg?.evt.clientY).toBe(160)

    const mouseMoveArg = (props.handleStageMouseMove as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(mouseMoveArg?.type).toBe('mousemove')
    expect(mouseMoveArg?.evt.clientX).toBe(190)
    expect(mouseMoveArg?.evt.clientY).toBe(214)

    const mouseUpArg = (props.handleStageMouseUp as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(mouseUpArg?.type).toBe('mouseup')
    expect(mouseUpArg?.evt.button).toBe(0)
  })

  it('starts marquee capture from non-interactive stage wrapper elements above the stage event layer', () => {
    const props = createBaseProps([])

    render(<ProjectCanvasPageStageScene {...props} />)

    const stageRoot = screen.getByTestId('project-canvas-stage-root')
    const sizeWrapper = stageRoot.firstElementChild as HTMLElement | null
    const blankWrapper = sizeWrapper?.firstElementChild as HTMLElement | null

    expect(blankWrapper).not.toBeNull()

    fireEvent.mouseDown(blankWrapper as Element, { button: 0, clientX: 52, clientY: 68 })
    fireEvent.mouseMove(blankWrapper as Element, { buttons: 0, clientX: 128, clientY: 164 })
    fireEvent.mouseUp(blankWrapper as Element, { button: 0, clientX: 128, clientY: 164 })

    const mouseDownArg = (props.handleStageMouseDown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(mouseDownArg?.type).toBe('mousedown')
    expect(mouseDownArg?.evt.button).toBe(0)
    expect(mouseDownArg?.evt.clientX).toBe(52)
    expect(mouseDownArg?.evt.clientY).toBe(68)

    const mouseMoveArg = (props.handleStageMouseMove as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(mouseMoveArg?.type).toBe('mousemove')
    expect(mouseMoveArg?.evt.clientX).toBe(128)
    expect(mouseMoveArg?.evt.clientY).toBe(164)

    const mouseUpArg = (props.handleStageMouseUp as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(mouseUpArg?.type).toBe('mouseup')
    expect(mouseUpArg?.evt.button).toBe(0)
    expect(mouseUpArg?.evt.clientX).toBe(128)
    expect(mouseUpArg?.evt.clientY).toBe(164)
  })

  it('routes pointer-driven marquee capture from non-interactive stage wrapper elements', () => {
    const props = createBaseProps([])

    render(<ProjectCanvasPageStageScene {...props} />)

    const stageRoot = screen.getByTestId('project-canvas-stage-root')
    const sizeWrapper = stageRoot.firstElementChild as HTMLElement | null
    const blankWrapper = sizeWrapper?.firstElementChild as HTMLElement | null

    expect(blankWrapper).not.toBeNull()

    fireEvent.pointerDown(blankWrapper as Element, {
      button: 0,
      buttons: 1,
      clientX: 52,
      clientY: 68,
      pointerId: 1,
      pointerType: 'mouse'
    })
    fireEvent.pointerMove(blankWrapper as Element, {
      buttons: 1,
      clientX: 128,
      clientY: 164,
      pointerId: 1,
      pointerType: 'mouse'
    })
    fireEvent.pointerUp(blankWrapper as Element, {
      button: 0,
      clientX: 128,
      clientY: 164,
      pointerId: 1,
      pointerType: 'mouse'
    })

    const mouseDownArg = (props.handleStageMouseDown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(mouseDownArg?.type).toBe('pointerdown')
    expect(mouseDownArg?.evt.button).toBe(0)
    expect(mouseDownArg?.evt.clientX).toBe(52)
    expect(mouseDownArg?.evt.clientY).toBe(68)

    const mouseMoveArg = (props.handleStageMouseMove as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(mouseMoveArg?.type).toBe('pointermove')
    expect(mouseMoveArg?.evt.clientX).toBe(128)
    expect(mouseMoveArg?.evt.clientY).toBe(164)

    const mouseUpArg = (props.handleStageMouseUp as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(mouseUpArg?.type).toBe('pointerup')
    expect(mouseUpArg?.evt.button).toBe(0)
    expect(mouseUpArg?.evt.clientX).toBe(128)
    expect(mouseUpArg?.evt.clientY).toBe(164)
  })

  it('does not start marquee fallback capture from the multi-selection drag surface', () => {
    const firstItem = createImageItem('image-multi-a')
    const secondItem = createImageItem('image-multi-b')
    secondItem.x = 420
    const props = createBaseProps([firstItem, secondItem])
    props.selectedIds = new Set([firstItem.id, secondItem.id])

    render(<ProjectCanvasPageStageScene {...props} />)

    const dragSurface = document.querySelector(
      '[data-canvas-multi-select-drag-surface="true"]'
    ) as HTMLElement | null

    expect(dragSurface).not.toBeNull()

    fireEvent.pointerDown(dragSurface as Element, {
      button: 0,
      buttons: 1,
      clientX: 240,
      clientY: 180,
      pointerId: 11,
      pointerType: 'mouse'
    })

    expect(props.handleStageMouseDown).not.toHaveBeenCalled()
  })

  it('keeps marquee move and mouseup events flowing when the drag starts on the stage surface and crosses a proxy placeholder', async () => {
    const item = createFileItem('file-marquee-proxy')
    const props = createBaseProps([item])

    render(<ProjectCanvasPageStageScene {...props} />)

    await waitFor(() => {
      expect(canvasPlaceholderProps.has(item.id)).toBe(true)
    })

    const stageEventLayer = screen
      .getByTestId('project-canvas-stage-root')
      .querySelector('[data-project-canvas-stage-event-layer="dom"]')
    expect(stageEventLayer).not.toBeNull()

    const overlay = screen.getByTestId(`canvas-placeholder-${item.id}`)

    fireEvent.mouseDown(stageEventLayer as Element, { button: 0, clientX: 40, clientY: 60 })
    fireEvent.mouseLeave(stageEventLayer as Element, {
      buttons: 1,
      clientX: 120,
      clientY: 140
    })
    fireEvent.mouseMove(overlay, { buttons: 0, clientX: 188, clientY: 214 })
    fireEvent.mouseUp(overlay, { button: 0, clientX: 188, clientY: 214 })

    const mouseDownArg = (props.handleStageMouseDown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(mouseDownArg?.type).toBe('mousedown')
    expect(mouseDownArg?.evt.button).toBe(0)
    expect(mouseDownArg?.evt.clientX).toBe(40)
    expect(mouseDownArg?.evt.clientY).toBe(60)

    const mouseMoveArg = (props.handleStageMouseMove as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(mouseMoveArg?.type).toBe('mousemove')
    expect(mouseMoveArg?.evt.clientX).toBe(188)
    expect(mouseMoveArg?.evt.clientY).toBe(214)

    const mouseUpArg = (props.handleStageMouseUp as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(mouseUpArg?.type).toBe('mouseup')
    expect(mouseUpArg?.evt.button).toBe(0)
    expect(mouseUpArg?.evt.clientX).toBe(188)
    expect(mouseUpArg?.evt.clientY).toBe(214)
  })

  it('keeps marquee capture alive when stage mouseleave reports buttons as 0 before crossing a proxy placeholder', async () => {
    const item = createFileItem('file-marquee-proxy-zero-buttons')
    const props = createBaseProps([item])

    render(<ProjectCanvasPageStageScene {...props} />)

    await waitFor(() => {
      expect(canvasPlaceholderProps.has(item.id)).toBe(true)
    })

    const stageEventLayer = screen
      .getByTestId('project-canvas-stage-root')
      .querySelector('[data-project-canvas-stage-event-layer="dom"]')
    expect(stageEventLayer).not.toBeNull()

    const overlay = screen.getByTestId(`canvas-placeholder-${item.id}`)

    fireEvent.mouseDown(stageEventLayer as Element, { button: 0, clientX: 40, clientY: 60 })
    fireEvent.mouseLeave(stageEventLayer as Element, {
      buttons: 0,
      clientX: 120,
      clientY: 140
    })
    fireEvent.mouseMove(overlay, { buttons: 1, clientX: 188, clientY: 214 })
    fireEvent.mouseUp(overlay, { button: 0, clientX: 188, clientY: 214 })

    expect(props.handleStageMouseUp).toHaveBeenCalledTimes(1)

    const mouseMoveArg = (props.handleStageMouseMove as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(mouseMoveArg?.type).toBe('mousemove')
    expect(mouseMoveArg?.evt.clientX).toBe(188)
    expect(mouseMoveArg?.evt.clientY).toBe(214)

    const mouseUpArg = (props.handleStageMouseUp as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(mouseUpArg?.type).toBe('mouseup')
    expect(mouseUpArg?.evt.button).toBe(0)
    expect(mouseUpArg?.evt.clientX).toBe(188)
    expect(mouseUpArg?.evt.clientY).toBe(214)
  })

  it('keeps marquee move and mouseup events flowing when the pointer leaves the stage root', () => {
    const props = createBaseProps([])

    render(<ProjectCanvasPageStageScene {...props} />)

    const stageEventLayer = screen
      .getByTestId('project-canvas-stage-root')
      .querySelector('[data-project-canvas-stage-event-layer="dom"]')
    expect(stageEventLayer).not.toBeNull()

    fireEvent.mouseDown(stageEventLayer as Element, { button: 0, clientX: 52, clientY: 68 })
    window.dispatchEvent(new MouseEvent('mousemove', { buttons: 1, clientX: 604, clientY: 412 }))
    window.dispatchEvent(new MouseEvent('mouseup', { button: 0, clientX: 604, clientY: 412 }))

    const mouseDownArg = (props.handleStageMouseDown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(mouseDownArg?.type).toBe('mousedown')
    expect(mouseDownArg?.evt.clientX).toBe(52)
    expect(mouseDownArg?.evt.clientY).toBe(68)

    const mouseMoveArg = (props.handleStageMouseMove as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(mouseMoveArg?.type).toBe('mousemove')
    expect(mouseMoveArg?.evt.clientX).toBe(604)
    expect(mouseMoveArg?.evt.clientY).toBe(412)

    const mouseUpArg = (props.handleStageMouseUp as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(mouseUpArg?.type).toBe('mouseup')
    expect(mouseUpArg?.evt.button).toBe(0)
    expect(mouseUpArg?.evt.clientX).toBe(604)
    expect(mouseUpArg?.evt.clientY).toBe(412)
  })

  it('routes middle-mouse pan events from the active DOM image overlay back to the stage handlers', async () => {
    const item = createImageItem('image-middle-pan')
    webglReady = true
    webglLoadedIds = new Set([item.id])
    webglResidentIds = new Set([item.id])
    const props = createBaseProps([item])
    props.isMiddleMouseRef = { current: false }

    render(<ProjectCanvasPageStageScene {...props} />)

    await waitFor(() => {
      expect(imageInteractionOverlayProps.has(item.id)).toBe(true)
    })

    expect(canvasPlaceholderProps.has(item.id)).toBe(false)

    const overlay = screen.getByTestId(`image-overlay-${item.id}`)

    fireEvent.mouseDown(overlay, { button: 1, clientX: 120, clientY: 140 })

    const mouseDownArg = (props.handleStageMouseDown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(mouseDownArg?.type).toBe('mousedown')
    expect(mouseDownArg?.evt.button).toBe(1)
    expect(mouseDownArg?.evt.clientX).toBe(120)
    expect(mouseDownArg?.evt.clientY).toBe(140)

    props.isMiddleMouseRef.current = true

    fireEvent.mouseMove(overlay, { buttons: 4, clientX: 168, clientY: 196 })
    fireEvent.mouseUp(overlay, { button: 1, clientX: 168, clientY: 196 })

    const mouseMoveArg = (props.handleStageMouseMove as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(mouseMoveArg?.type).toBe('mousemove')
    expect(mouseMoveArg?.evt.clientX).toBe(168)
    expect(mouseMoveArg?.evt.clientY).toBe(196)

    const mouseUpArg = (props.handleStageMouseUp as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(mouseUpArg?.type).toBe('mouseup')
    expect(mouseUpArg?.evt.button).toBe(1)
  })

  it('registers a non-passive wheel capture listener on the stage root', () => {
    const addEventListenerSpy = vi.spyOn(HTMLDivElement.prototype, 'addEventListener')
    const removeEventListenerSpy = vi.spyOn(HTMLDivElement.prototype, 'removeEventListener')
    const props = createBaseProps([])

    const { unmount } = render(<ProjectCanvasPageStageScene {...props} />)

    const wheelRegistration = addEventListenerSpy.mock.calls.find(
      ([type, _listener, options]) =>
        type === 'wheel' &&
        Boolean(options) &&
        typeof options === 'object' &&
        'capture' in options &&
        'passive' in options &&
        options.capture === true &&
        options.passive === false
    )

    expect(wheelRegistration).toBeDefined()

    const wheelListener = wheelRegistration?.[1]
    expect(typeof wheelListener).toBe('function')

    unmount()

    expect(removeEventListenerSpy).toHaveBeenCalledWith('wheel', wheelListener, true)
  })

  it('coalesces canvas focus requests during wheel bursts', () => {
    const callbacks: FrameRequestCallback[] = []
    const requestAnimationFrameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        callbacks.push(callback)
        return callbacks.length
      })
    const props = createBaseProps([])

    render(<ProjectCanvasPageStageScene {...props} />)

    const root = screen.getByTestId('project-canvas-stage-root') as HTMLDivElement
    const focusSpy = vi.spyOn(root, 'focus').mockImplementation(() => {})

    fireEvent.wheel(root, { clientX: 160, clientY: 180, deltaY: -120 })
    fireEvent.wheel(root, { clientX: 160, clientY: 180, deltaY: -120 })
    fireEvent.wheel(root, { clientX: 160, clientY: 180, deltaY: -120 })

    expect(props.handleStageWheel).toHaveBeenCalledTimes(3)
    expect(requestAnimationFrameSpy).toHaveBeenCalledTimes(1)

    callbacks[0]?.(performance.now())

    expect(focusSpy).toHaveBeenCalledTimes(1)

    vi.restoreAllMocks()
  })

  it('does not schedule focus when the canvas already has focus', () => {
    const requestAnimationFrameSpy = vi.spyOn(window, 'requestAnimationFrame')
    const props = createBaseProps([])

    render(<ProjectCanvasPageStageScene {...props} />)

    const root = screen.getByTestId('project-canvas-stage-root') as HTMLDivElement
    root.focus()

    fireEvent.wheel(root, { clientX: 160, clientY: 180, deltaY: -120 })

    expect(props.handleStageWheel).toHaveBeenCalledTimes(1)
    expect(requestAnimationFrameSpy).not.toHaveBeenCalled()

    vi.restoreAllMocks()
  })

  it('clips overlay chrome to the stage stacking context', () => {
    const item = createImageItem('image-stage-clip')

    render(<ProjectCanvasPageStageScene {...createBaseProps([item])} />)

    expect(screen.getByTestId('project-canvas-stage-root')).toHaveStyle({
      overflow: 'hidden',
      zIndex: '0'
    })
  })

  it('routes wheel zoom events from DOM overlays back to the stage handler', async () => {
    const item = createImageItem('image-wheel-zoom')
    webglReady = true
    webglLoadedIds = new Set([item.id])
    webglResidentIds = new Set([item.id])
    const props = createBaseProps([item])

    render(<ProjectCanvasPageStageScene {...props} />)

    await waitFor(() => {
      expect(imageInteractionOverlayProps.has(item.id)).toBe(true)
    })

    const overlay = screen.getByTestId(`image-overlay-${item.id}`)

    fireEvent.wheel(overlay, { clientX: 160, clientY: 180, deltaY: -120 })

    const wheelArg = (props.handleStageWheel as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(wheelArg?.type).toBe('wheel')
    expect(wheelArg?.evt.clientX).toBe(160)
    expect(wheelArg?.evt.clientY).toBe(180)
    expect(wheelArg?.evt.deltaY).toBe(-120)
  })

  it('routes a flipped loaded image through the DOM image interaction overlay and preserves signed transforms', async () => {
    const item = createImageItem('image-placeholder-negative')
    const handleTransformEnd = vi.fn()
    item.x = 100
    item.y = 140
    item.scaleX = -1.25
    item.scaleY = -0.5
    webglReady = true
    webglLoadedIds = new Set([item.id])
    webglResidentIds = new Set([item.id])

    render(
      <ProjectCanvasPageStageScene
        {...createBaseProps([item])}
        handleTransformEnd={handleTransformEnd}
      />
    )

    await waitFor(() => {
      expect(imageInteractionOverlayProps.has(item.id)).toBe(true)
    })

    expect(canvasPlaceholderProps.has(item.id)).toBe(false)
    expect(rectInteractionOverlayProps.has(item.id)).toBe(false)
    expect(imageInteractionOverlayProps.get(item.id)?.suppressImagePreview).toBe(true)

    act(() => {
      ;(
        imageInteractionOverlayProps.get(item.id)?.onPreviewChange as
          | ((itemId: string, preview: ProjectCanvasImagePreview | null) => void)
          | undefined
      )?.(item.id, {
        x: 100,
        y: 140,
        width: 200,
        height: 120,
        scaleX: -1.5,
        scaleY: -0.7,
        rotation: 0
      })
    })

    expect(syncItemPreviewSpy).toHaveBeenCalledWith(item.id, {
      x: 100,
      y: 140,
      width: 200,
      height: 120,
      scaleX: -1.5,
      scaleY: -0.7,
      rotation: 0
    })

    act(() => {
      ;(
        imageInteractionOverlayProps.get(item.id)?.onTransformEnd as
          | ((id: string, attrs: ProjectCanvasImagePreview) => void)
          | undefined
      )?.(item.id, {
        x: 100,
        y: 140,
        width: 200,
        height: 120,
        scaleX: -1.5,
        scaleY: -0.7,
        rotation: 0
      })
    })

    expect(handleTransformEnd).toHaveBeenCalledWith(item.id, {
      x: 100,
      y: 140,
      width: 200,
      height: 120,
      scaleX: -1.5,
      scaleY: -0.7,
      rotation: 0
    })
  })

  it('routes unloaded annotate images through the placeholder proxy path while keeping fallback metrics explicit', async () => {
    const item = createImageItem('image-unloaded')
    item.image = undefined
    webglReady = false
    webglLoadedIds = new Set()

    render(
      <ProjectCanvasPageStageScene
        {...createBaseProps([item])}
        tool="annotate"
        selectedIds={new Set([item.id])}
      />
    )

    await waitFor(() => {
      expect(canvasPlaceholderProps.has(item.id)).toBe(true)
    })

    const root = screen.getByTestId('project-canvas-stage-root')
    expect(root).toHaveAttribute(
      'data-project-canvas-render-surface-summary',
      JSON.stringify({
        totalItems: 1,
        imageItems: 1,
        webglImageItems: 0,
        webglModel3DItems: 0,
        budgetDowngradedImageItems: 0,
        fallbackImageItems: 1,
        cropExcludedImageItems: 0,
        videoOverlayItems: 0,
        htmlOverlayItems: 0
      })
    )
    expect(root).toHaveAttribute('data-project-canvas-webgl-primary-image-count', '0')
    expect(root).toHaveAttribute('data-project-canvas-budget-downgraded-image-count', '0')
    expect(root).toHaveAttribute('data-project-canvas-fallback-image-count', '1')
    expect(root).toHaveAttribute('data-project-canvas-proxy-layer-candidate-count', '1')
    expect(root).toHaveAttribute('data-project-canvas-unloaded-fallback-image-count', '1')
    expect(root).toHaveAttribute('data-project-canvas-failed-fallback-image-count', '0')
    expect(root).toHaveAttribute('data-project-canvas-unsupported-fallback-image-count', '0')
    expect(root).toHaveAttribute('data-project-canvas-crop-excluded-image-count', '0')
    expect(imageInteractionOverlayProps.has(item.id)).toBe(false)
    expect(rectInteractionOverlayProps.has(item.id)).toBe(false)
    expect(canvasPlaceholderProps.get(item.id)?.renderMode).toBe('dom-placeholder-proxy')
    expect(canvasPlaceholderProps.get(item.id)?.visualVariant).toBe('transparent')
  })

  it('commits crop confirmation back into history and resets crop mode', async () => {
    const cropItem = createImageItem('crop-target')
    const setItemsWithHistory = vi.fn()
    const setTool = vi.fn()
    const setCroppingImageId = vi.fn()
    const setSelectedIds = vi.fn()

    render(
      <ProjectCanvasPageStageScene
        {...createBaseProps([cropItem])}
        tool="crop-select"
        croppingImageId={cropItem.id}
        setItemsWithHistory={setItemsWithHistory}
        setTool={setTool}
        setCroppingImageId={setCroppingImageId}
        setSelectedIds={setSelectedIds}
      />
    )

    expect(screen.getByTestId(`crop-overlay-${cropItem.id}`)).toBeInTheDocument()

    act(() => {
      ;(
        cropOverlayProps.get(cropItem.id)?.onConfirm as
          | ((updates: Partial<CanvasImageItem>) => void)
          | undefined
      )?.({
        x: 132,
        y: 156,
        width: 80,
        height: 60
      })
    })

    expect(setItemsWithHistory).toHaveBeenCalledTimes(1)
    const updateItems = setItemsWithHistory.mock.calls[0][0] as (
      prev: CanvasImageItem[]
    ) => CanvasImageItem[]
    expect(updateItems([cropItem])).toEqual([
      expect.objectContaining({
        id: cropItem.id,
        x: 132,
        y: 156,
        width: 80,
        height: 60
      })
    ])
    expect(setSelectedIds).toHaveBeenCalledTimes(1)
    expect(setSelectedIds).toHaveBeenCalledWith(new Set([cropItem.id]))
    expect(setTool).toHaveBeenCalledWith('select')
    expect(setCroppingImageId).toHaveBeenCalledWith(null)
  })

  it('cancels crop mode without mutating history', async () => {
    const cropItem = createImageItem('crop-target')
    const setItemsWithHistory = vi.fn()
    const setTool = vi.fn()
    const setCroppingImageId = vi.fn()

    render(
      <ProjectCanvasPageStageScene
        {...createBaseProps([cropItem])}
        tool="crop-select"
        croppingImageId={cropItem.id}
        setItemsWithHistory={setItemsWithHistory}
        setTool={setTool}
        setCroppingImageId={setCroppingImageId}
      />
    )

    act(() => {
      ;(cropOverlayProps.get(cropItem.id)?.onCancel as (() => void) | undefined)?.()
    })

    expect(setItemsWithHistory).not.toHaveBeenCalled()
    expect(setTool).toHaveBeenCalledWith('select')
    expect(setCroppingImageId).toHaveBeenCalledWith(null)
  })
})
