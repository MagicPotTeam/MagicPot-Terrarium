import React, { type DragEvent as ReactDragEvent } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'

import ProjectCanvasPageVisualOverlays from './ProjectCanvasPageVisualOverlays'
import type { CanvasOcrHoverDetail } from './ocrCanvasUtils'
import type {
  CanvasAnnotationItem,
  CanvasFileItem,
  CanvasHtmlItem,
  CanvasImageItem,
  CanvasItem,
  CanvasModel3DItem,
  CanvasTextItem,
  CanvasVideoItem
} from './types'

let latestCanvas3DStageProps: Record<string, unknown> | null = null
const canvas3DStageSyncViewportMock = vi.fn()
const videoOverlayProps = new Map<string, Record<string, unknown>>()
const htmlOverlayProps = new Map<string, Record<string, unknown>>()
const fileOverlayProps = new Map<string, Record<string, unknown>>()
const textOverlayProps = new Map<string, Record<string, unknown>>()
const annotationOverlayProps = new Map<string, Record<string, unknown>>()
const renderedOverlayOrder: string[] = []

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}))

vi.mock('./components/LazyCanvas3DStage', () => ({
  default: function MockCanvas3DStage(props: Record<string, unknown>) {
    React.useEffect(() => {
      const onViewportSyncReady = props.onViewportSyncReady as
        | ((sync: ((pos: { x: number; y: number }, scale: number) => void) | null) => void)
        | undefined
      onViewportSyncReady?.(canvas3DStageSyncViewportMock)

      return () => {
        onViewportSyncReady?.(null)
      }
    }, [props.onViewportSyncReady])
    latestCanvas3DStageProps = props
    return <div data-testid="canvas-3d-stage" />
  }
}))

vi.mock('./components/VideoOverlay', () => ({
  default: function MockVideoOverlay(props: Record<string, unknown> & { item: CanvasVideoItem }) {
    videoOverlayProps.set(props.item.id, props)
    renderedOverlayOrder.push(`video:${props.item.id}`)
    return <div data-testid={`video-overlay-${props.item.id}`} />
  }
}))

vi.mock('./components/HtmlOverlay', () => ({
  default: function MockHtmlOverlay(props: Record<string, unknown> & { item: CanvasHtmlItem }) {
    htmlOverlayProps.set(props.item.id, props)
    renderedOverlayOrder.push(`html:${props.item.id}`)
    return <div data-testid={`html-overlay-${props.item.id}`} />
  }
}))

vi.mock('./components/CanvasFileOverlay', () => ({
  default: function MockCanvasFileOverlay(
    props: Record<string, unknown> & { item: CanvasFileItem }
  ) {
    fileOverlayProps.set(props.item.id, props)
    renderedOverlayOrder.push(`file:${props.item.id}`)
    return <div data-testid={`file-overlay-${props.item.id}`} />
  }
}))

vi.mock('./components/CanvasTextOverlay', () => ({
  default: function MockCanvasTextOverlay(
    props: Record<string, unknown> & { item: CanvasTextItem }
  ) {
    textOverlayProps.set(props.item.id, props)
    renderedOverlayOrder.push(`text:${props.item.id}`)
    return <div data-testid={`text-overlay-${props.item.id}`} />
  }
}))

vi.mock('./components/CanvasAnnotationOverlay', () => ({
  default: function MockCanvasAnnotationOverlay(
    props: Record<string, unknown> & { item: CanvasAnnotationItem }
  ) {
    annotationOverlayProps.set(props.item.id, props)
    renderedOverlayOrder.push(`annotation:${props.item.id}`)
    return <div data-testid={`annotation-overlay-${props.item.id}`} />
  }
}))

vi.mock('./components/GroupPlaybackOverlay', () => ({
  default: () => null
}))

function createModel3DItem(id: string): CanvasModel3DItem {
  return {
    id,
    type: 'model3d',
    src: `${id}.glb`,
    fileName: `${id}.glb`,
    x: 120,
    y: 80,
    width: 240,
    height: 240,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false
  }
}

function createVideoItem(id: string): CanvasVideoItem {
  return {
    id,
    type: 'video',
    src: `${id}.mp4`,
    fileName: `${id}.mp4`,
    x: 80,
    y: 60,
    width: 320,
    height: 180,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false,
    playing: false,
    muted: true,
    volume: 0
  }
}

function createImageItem(id: string): CanvasImageItem {
  return {
    id,
    type: 'image',
    src: `${id}.png`,
    x: 80,
    y: 60,
    width: 320,
    height: 180,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false
  }
}

function createFileItem(id: string): CanvasFileItem {
  return {
    id,
    type: 'file',
    src: `${id}.md`,
    fileName: `${id}.md`,
    mimeType: 'text/markdown',
    fileKind: 'markdown',
    x: 48,
    y: 72,
    width: 320,
    height: 220,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false,
    editable: true
  }
}

function createTextItem(id: string): CanvasTextItem {
  return {
    id,
    type: 'text',
    text: 'Overlay text',
    fontSize: 18,
    fontFamily: 'system-ui, sans-serif',
    fill: '#f8fafc',
    x: 36,
    y: 54,
    width: 180,
    height: 64,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false
  }
}

function createAnnotationItem(id: string): CanvasAnnotationItem {
  return {
    id,
    type: 'annotation',
    shape: 'rect',
    stroke: '#22c55e',
    fillOpacity: 0.15,
    strokeWidth: 2,
    label: 'OCR Box',
    x: 24,
    y: 28,
    width: 180,
    height: 96,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false,
    ocrBundleId: 'bundle-1',
    ocrBoxId: 'bbox-1'
  }
}

function createHtmlItem(id: string): CanvasHtmlItem {
  return {
    id,
    type: 'html',
    htmlData: '<div>Overlay</div>',
    x: 56,
    y: 80,
    width: 240,
    height: 180,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false
  }
}

function renderVisualOverlays(options?: {
  renderedModel3DItems?: CanvasModel3DItem[]
  videoItems?: CanvasVideoItem[]
  htmlItems?: CanvasHtmlItem[]
  annotationItems?: CanvasAnnotationItem[]
  fileItems?: CanvasFileItem[]
  textItems?: CanvasTextItem[]
  items?: CanvasItem[]
  editingTextItemId?: string | null
  activeOcrHover?: CanvasOcrHoverDetail | null
  selectedIds?: Set<string>
  sessionKey?: string
  isViewportInteracting?: boolean
  forceRenderAllItemsForExport?: boolean
  tool?: 'select' | 'hand' | 'annotate'
  onDragOver?: (event: ReactDragEvent<Element>) => void
  onDrop?: (event: ReactDragEvent<Element>) => void
  registerViewportLayer?: (element: HTMLElement | null) => void
  registerViewportCallback?: (
    fn: (pos: { x: number; y: number }, scale: number) => void
  ) => () => void
}) {
  const portalHost = document.createElement('div')
  document.body.appendChild(portalHost)
  const items: CanvasItem[] = options?.items ?? [
    ...(options?.renderedModel3DItems ?? []),
    ...(options?.videoItems ?? []),
    ...(options?.htmlItems ?? []),
    ...(options?.annotationItems ?? []),
    ...(options?.fileItems ?? []),
    ...(options?.textItems ?? [])
  ]

  render(
    <ProjectCanvasPageVisualOverlays
      canvasContainerRef={{ current: portalHost }}
      canvasContainerElement={portalHost}
      sessionKey={options?.sessionKey ?? 'canvas:thread:project-1:thread:agent-1'}
      renderedModel3DItems={options?.renderedModel3DItems ?? []}
      videoItems={options?.videoItems ?? []}
      htmlItems={options?.htmlItems ?? []}
      annotationItems={options?.annotationItems ?? []}
      textItems={options?.textItems ?? []}
      fileItems={options?.fileItems ?? []}
      items={items}
      editingTextItemId={options?.editingTextItemId ?? null}
      activeOcrHover={options?.activeOcrHover ?? null}
      selectedIds={options?.selectedIds ?? new Set()}
      tool={options?.tool ?? 'select'}
      stagePos={{ x: 0, y: 0 }}
      stageScale={1}
      stageSize={{ width: 1280, height: 720 }}
      itemsLength={
        (options?.renderedModel3DItems?.length ?? 0) +
        (options?.videoItems?.length ?? 0) +
        (options?.htmlItems?.length ?? 0) +
        (options?.annotationItems?.length ?? 0) +
        (options?.fileItems?.length ?? 0) +
        (options?.textItems?.length ?? 0)
      }
      isViewportInteracting={options?.isViewportInteracting ?? false}
      forceRenderAllItemsForExport={options?.forceRenderAllItemsForExport ?? false}
      onSelectItem={vi.fn()}
      onDragOver={options?.onDragOver ?? vi.fn<(event: ReactDragEvent<Element>) => void>()}
      onDrop={options?.onDrop ?? vi.fn<(event: ReactDragEvent<Element>) => void>()}
      onDragVideoEnd={vi.fn()}
      onUpdateVideoItem={vi.fn()}
      onUpdateHtmlItem={vi.fn()}
      onDeleteHtmlItem={vi.fn()}
      groupPlaybackInfo={null}
      activeGroupPlaybackItem={null}
      activeGroupPlaybackCanvasBounds={null}
      activeGroupPlaybackScreenBounds={null}
      activeGroupPlaybackGroupName={null}
      onToggleGroupPlaybackPause={vi.fn()}
      onStopGroupPlayback={vi.fn()}
      onGroupPlaybackVideoEnded={vi.fn()}
      onExportGroupPlaybackAsGif={vi.fn()}
      registerViewportLayer={options?.registerViewportLayer}
      registerViewportCallback={options?.registerViewportCallback}
    />
  )

  return { portalHost }
}

afterEach(() => {
  latestCanvas3DStageProps = null
  canvas3DStageSyncViewportMock.mockReset()
  videoOverlayProps.clear()
  htmlOverlayProps.clear()
  fileOverlayProps.clear()
  textOverlayProps.clear()
  annotationOverlayProps.clear()
  renderedOverlayOrder.length = 0
  vi.clearAllMocks()
  document.body.innerHTML = ''
})

describe('ProjectCanvasPageVisualOverlays selection chrome routing', () => {
  it('suppresses single-select 3D highlighting when the DOM placeholder overlay owns selection chrome', () => {
    const modelItem = createModel3DItem('model-1')

    renderVisualOverlays({
      renderedModel3DItems: [modelItem],
      selectedIds: new Set([modelItem.id])
    })

    expect(screen.getByTestId('canvas-3d-stage')).toBeInTheDocument()
    expect(
      (latestCanvas3DStageProps?.items as Array<{ id: string }> | undefined)?.map((item) => item.id)
    ).toEqual([modelItem.id])
    expect(Array.from((latestCanvas3DStageProps?.selectedIds as Set<string>) ?? [])).toEqual([])
  })

  it('forwards the canonical session key to the shared 3D stage', () => {
    const modelItem = createModel3DItem('model-1')
    const sessionKey = 'canvas:thread:project-2:thread:agent-9'

    renderVisualOverlays({
      renderedModel3DItems: [modelItem],
      sessionKey
    })

    expect(latestCanvas3DStageProps?.sessionKey).toBe(sessionKey)
  })

  it('renders a full top-left name badge for each 3D model item', () => {
    const modelItem = createModel3DItem('model-1')
    modelItem.fileName = 'd09c439c-a446-4081-981f-479b0d4ebc7f_1776542466_0.glb'

    renderVisualOverlays({
      renderedModel3DItems: [modelItem]
    })

    const nameBadge = document.querySelector(
      `[data-canvas-overlay="model3d-name"][data-canvas-item-id="${modelItem.id}"]`
    ) as HTMLElement | null
    expect(nameBadge).not.toBeNull()
    expect(screen.getByText(modelItem.fileName)).toBeInTheDocument()
    expect(nameBadge?.getAttribute('title')).toBe(modelItem.fileName)
    expect(nameBadge).toHaveStyle({ width: 'max-content' })
    expect(nameBadge).toHaveStyle({ maxWidth: '228px' })
    expect(screen.getByText(modelItem.fileName)).toHaveStyle({
      whiteSpace: 'nowrap',
      textOverflow: 'ellipsis'
    })
  })

  it('keeps the 3D name badge aligned with drag preview sync events', () => {
    const modelItem = createModel3DItem('model-1')

    renderVisualOverlays({
      renderedModel3DItems: [modelItem]
    })

    const nameBadge = document.querySelector(
      `[data-canvas-overlay="model3d-name"][data-canvas-item-id="${modelItem.id}"]`
    ) as HTMLElement | null
    expect(nameBadge).not.toBeNull()
    expect(nameBadge).toHaveStyle({ left: '126px', top: '86px', maxWidth: '228px' })

    act(() => {
      window.dispatchEvent(
        new CustomEvent(`canvas-sync-${modelItem.id}`, {
          detail: {
            x: 240,
            y: 160,
            rotation: 0,
            scaleX: 1,
            scaleY: 1
          }
        })
      )
    })

    expect(nameBadge).toHaveStyle({ left: '246px', top: '166px', maxWidth: '228px' })

    act(() => {
      window.dispatchEvent(new CustomEvent(`canvas-reset-${modelItem.id}`))
    })

    expect(nameBadge).toHaveStyle({ left: '126px', top: '86px', maxWidth: '228px' })
  })

  it('keeps multi-select 3D highlighting in the shared WebGL stage', () => {
    const firstModelItem = createModel3DItem('model-1')
    const secondModelItem = createModel3DItem('model-2')

    renderVisualOverlays({
      renderedModel3DItems: [firstModelItem, secondModelItem],
      selectedIds: new Set([firstModelItem.id, secondModelItem.id])
    })

    expect(Array.from((latestCanvas3DStageProps?.selectedIds as Set<string>) ?? []).sort()).toEqual(
      [firstModelItem.id, secondModelItem.id]
    )
  })

  it('passes attached caption parent items through to annotation overlays', () => {
    const parentImageItem = createImageItem('image-1')
    const captionItem: CanvasAnnotationItem = {
      ...createAnnotationItem('annotation-1'),
      shape: 'text-anno',
      label: '',
      text: 'caption',
      attachedToId: parentImageItem.id,
      attachmentPlacement: 'bottom-center'
    }

    renderVisualOverlays({
      annotationItems: [captionItem],
      items: [parentImageItem, captionItem]
    })

    expect(annotationOverlayProps.get(captionItem.id)?.attachedParentItem).toBe(parentImageItem)
  })

  it('registers the DOM overlay viewport layer with the shared viewport driver', () => {
    const registerViewportLayer = vi.fn<(element: HTMLElement | null) => void>()

    renderVisualOverlays({
      annotationItems: [createAnnotationItem('annotation-1')],
      registerViewportLayer
    })

    const registeredLayer = registerViewportLayer.mock.calls.find(
      ([element]) => element instanceof HTMLDivElement
    )?.[0]

    expect(registeredLayer).toBeInstanceOf(HTMLDivElement)
  })

  it('forwards live viewport changes to the 3D stage camera sync handle', () => {
    const modelItem = createModel3DItem('model-viewport-sync')
    let registeredViewportCallback:
      | ((pos: { x: number; y: number }, scale: number) => void)
      | null = null
    const unregisterViewportCallback = vi.fn()

    renderVisualOverlays({
      renderedModel3DItems: [modelItem],
      registerViewportCallback: (callback) => {
        registeredViewportCallback = callback
        return unregisterViewportCallback
      }
    })

    expect(registeredViewportCallback).toBeTypeOf('function')

    act(() => {
      registeredViewportCallback?.({ x: -240, y: 96 }, 1.35)
    })

    expect(canvas3DStageSyncViewportMock).toHaveBeenCalledWith({ x: -240, y: 96 }, 1.35)
  })

  it('forwards viewport interaction state to the shared 3D stage', () => {
    const modelItem = createModel3DItem('model-moving')

    renderVisualOverlays({
      renderedModel3DItems: [modelItem],
      isViewportInteracting: true
    })

    expect(latestCanvas3DStageProps?.isViewportInteracting).toBe(true)
  })

  it('suppresses the preview selection outline for a single selected video item', () => {
    const videoItem = createVideoItem('video-1')

    renderVisualOverlays({
      videoItems: [videoItem],
      selectedIds: new Set([videoItem.id])
    })

    expect(videoOverlayProps.get(videoItem.id)?.isSelected).toBe(true)
    expect(videoOverlayProps.get(videoItem.id)?.showSelectionOutline).toBe(false)
  })

  it('keeps only visible videos mounted and exposes truthful video budget counters', () => {
    const activeVideo = createVideoItem('video-active')
    const pausedVideo = createVideoItem('video-paused')
    pausedVideo.x = 420
    pausedVideo.playing = false
    const posterVideo = createVideoItem('video-poster')
    posterVideo.x = 840
    posterVideo.width = 40
    posterVideo.height = 24
    posterVideo.playing = false
    const offscreenVideo = createVideoItem('video-offscreen')
    offscreenVideo.x = 4000
    offscreenVideo.y = 3000

    renderVisualOverlays({
      videoItems: [activeVideo, pausedVideo, posterVideo, offscreenVideo]
    })

    expect(screen.getByTestId(`video-overlay-${activeVideo.id}`)).toBeInTheDocument()
    expect(screen.getByTestId(`video-overlay-${pausedVideo.id}`)).toBeInTheDocument()
    expect(screen.getByTestId(`video-overlay-${posterVideo.id}`)).toBeInTheDocument()
    expect(screen.queryByTestId(`video-overlay-${offscreenVideo.id}`)).not.toBeInTheDocument()
    expect(videoOverlayProps.get(activeVideo.id)?.budgetMode).toBe('visible-paused')
    expect(videoOverlayProps.get(posterVideo.id)?.budgetMode).toBe('poster-frame')

    const budgetRoot = document.querySelector(
      '[data-project-canvas-video-total-count]'
    ) as HTMLElement | null
    expect(budgetRoot?.dataset.projectCanvasVideoTotalCount).toBe('4')
    expect(budgetRoot?.dataset.projectCanvasVideoVisiblePausedCount).toBe('2')
    expect(budgetRoot?.dataset.projectCanvasVideoPosterFrameCount).toBe('1')
    expect(budgetRoot?.dataset.projectCanvasVideoUnmountedCount).toBe('1')
  })

  it('caps active-playing video overlays and degrades the rest into paused, poster, and unmounted modes', () => {
    const activeVisibleVideos = Array.from({ length: 12 }, (_, index) => {
      const item = createVideoItem(`video-active-${index}`)
      item.x = 24 + (index % 4) * 220
      item.y = 24 + Math.floor(index / 4) * 160
      item.width = 240
      item.height = 135
      item.zIndex = index
      item.playing = true
      return item
    })
    const posterVideos = Array.from({ length: 6 }, (_, index) => {
      const item = createVideoItem(`video-poster-${index}`)
      item.x = 32 + index * 52
      item.y = 560
      item.width = 40
      item.height = 24
      item.zIndex = 100 + index
      item.playing = false
      return item
    })
    const offscreenVideos = Array.from({ length: 8 }, (_, index) => {
      const item = createVideoItem(`video-offscreen-${index}`)
      item.x = 4200 + index * 240
      item.y = 3200 + index * 180
      item.zIndex = 200 + index
      item.playing = Boolean(index % 2)
      return item
    })
    const selectedPriorityVideo = createVideoItem('video-selected-priority')
    selectedPriorityVideo.x = 40
    selectedPriorityVideo.y = 40
    selectedPriorityVideo.width = 300
    selectedPriorityVideo.height = 168
    selectedPriorityVideo.zIndex = 999
    selectedPriorityVideo.playing = true

    renderVisualOverlays({
      videoItems: [
        selectedPriorityVideo,
        ...activeVisibleVideos,
        ...posterVideos,
        ...offscreenVideos
      ],
      selectedIds: new Set([selectedPriorityVideo.id])
    })

    const budgetRoot = document.querySelector(
      '[data-project-canvas-video-total-count]'
    ) as HTMLElement | null

    expect(budgetRoot?.dataset.projectCanvasVideoTotalCount).toBe('27')
    expect(budgetRoot?.dataset.projectCanvasVideoActivePlayingCount).toBe('4')
    expect(budgetRoot?.dataset.projectCanvasVideoVisiblePausedCount).toBe('8')
    expect(budgetRoot?.dataset.projectCanvasVideoPosterFrameCount).toBe('7')
    expect(budgetRoot?.dataset.projectCanvasVideoUnmountedCount).toBe('8')
    expect(budgetRoot?.dataset.projectCanvasMountedVideoOverlayCount).toBe('19')
    expect(
      Array.from(videoOverlayProps.values()).filter(
        (props) => props.budgetMode === 'active-playing'
      ).length
    ).toBe(4)
    expect(videoOverlayProps.get(selectedPriorityVideo.id)?.budgetMode).toBe('active-playing')
  })

  it('rerenders video and html overlays when non-select tools enable pointer passthrough', () => {
    const videoItem = createVideoItem('video-hand-tool')
    const htmlItem = createHtmlItem('html-hand-tool')
    const portalHost = document.createElement('div')
    document.body.appendChild(portalHost)

    const { rerender } = render(
      <ProjectCanvasPageVisualOverlays
        canvasContainerRef={{ current: portalHost }}
        canvasContainerElement={portalHost}
        sessionKey="canvas:thread:project-1:thread:agent-1"
        renderedModel3DItems={[]}
        videoItems={[videoItem]}
        htmlItems={[htmlItem]}
        annotationItems={[]}
        textItems={[]}
        fileItems={[]}
        editingTextItemId={null}
        activeOcrHover={null}
        selectedIds={new Set()}
        tool="select"
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        stageSize={{ width: 1280, height: 720 }}
        itemsLength={2}
        forceRenderAllItemsForExport={false}
        onSelectItem={vi.fn()}
        onDragOver={vi.fn()}
        onDrop={vi.fn()}
        onDragVideoEnd={vi.fn()}
        onUpdateVideoItem={vi.fn()}
        onUpdateHtmlItem={vi.fn()}
        onDeleteHtmlItem={vi.fn()}
        groupPlaybackInfo={null}
        activeGroupPlaybackItem={null}
        activeGroupPlaybackCanvasBounds={null}
        activeGroupPlaybackScreenBounds={null}
        activeGroupPlaybackGroupName={null}
        onToggleGroupPlaybackPause={vi.fn()}
        onStopGroupPlayback={vi.fn()}
        onGroupPlaybackVideoEnded={vi.fn()}
        onExportGroupPlaybackAsGif={vi.fn()}
      />
    )

    expect(videoOverlayProps.get(videoItem.id)?.allowPointerPassthrough).toBe(false)
    expect(htmlOverlayProps.get(htmlItem.id)?.allowPointerPassthrough).toBe(false)

    rerender(
      <ProjectCanvasPageVisualOverlays
        canvasContainerRef={{ current: portalHost }}
        canvasContainerElement={portalHost}
        sessionKey="canvas:thread:project-1:thread:agent-1"
        renderedModel3DItems={[]}
        videoItems={[videoItem]}
        htmlItems={[htmlItem]}
        annotationItems={[]}
        textItems={[]}
        fileItems={[]}
        editingTextItemId={null}
        activeOcrHover={null}
        selectedIds={new Set()}
        tool="hand"
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        stageSize={{ width: 1280, height: 720 }}
        itemsLength={2}
        forceRenderAllItemsForExport={false}
        onSelectItem={vi.fn()}
        onDragOver={vi.fn()}
        onDrop={vi.fn()}
        onDragVideoEnd={vi.fn()}
        onUpdateVideoItem={vi.fn()}
        onUpdateHtmlItem={vi.fn()}
        onDeleteHtmlItem={vi.fn()}
        groupPlaybackInfo={null}
        activeGroupPlaybackItem={null}
        activeGroupPlaybackCanvasBounds={null}
        activeGroupPlaybackScreenBounds={null}
        activeGroupPlaybackGroupName={null}
        onToggleGroupPlaybackPause={vi.fn()}
        onStopGroupPlayback={vi.fn()}
        onGroupPlaybackVideoEnded={vi.fn()}
        onExportGroupPlaybackAsGif={vi.fn()}
      />
    )

    expect(videoOverlayProps.get(videoItem.id)?.allowPointerPassthrough).toBe(true)
    expect(htmlOverlayProps.get(htmlItem.id)?.allowPointerPassthrough).toBe(true)

    rerender(
      <ProjectCanvasPageVisualOverlays
        canvasContainerRef={{ current: portalHost }}
        canvasContainerElement={portalHost}
        sessionKey="canvas:thread:project-1:thread:agent-1"
        renderedModel3DItems={[]}
        videoItems={[videoItem]}
        htmlItems={[htmlItem]}
        annotationItems={[]}
        textItems={[]}
        fileItems={[]}
        editingTextItemId={null}
        activeOcrHover={null}
        selectedIds={new Set()}
        tool="annotate"
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        stageSize={{ width: 1280, height: 720 }}
        itemsLength={2}
        forceRenderAllItemsForExport={false}
        onSelectItem={vi.fn()}
        onDragOver={vi.fn()}
        onDrop={vi.fn()}
        onDragVideoEnd={vi.fn()}
        onUpdateVideoItem={vi.fn()}
        onUpdateHtmlItem={vi.fn()}
        onDeleteHtmlItem={vi.fn()}
        groupPlaybackInfo={null}
        activeGroupPlaybackItem={null}
        activeGroupPlaybackCanvasBounds={null}
        activeGroupPlaybackScreenBounds={null}
        activeGroupPlaybackGroupName={null}
        onToggleGroupPlaybackPause={vi.fn()}
        onStopGroupPlayback={vi.fn()}
        onGroupPlaybackVideoEnded={vi.fn()}
        onExportGroupPlaybackAsGif={vi.fn()}
      />
    )

    expect(videoOverlayProps.get(videoItem.id)?.allowPointerPassthrough).toBe(true)
    expect(htmlOverlayProps.get(htmlItem.id)?.allowPointerPassthrough).toBe(true)
  })

  it('captures external drag events from portal overlays so drops stay allowed over existing items', () => {
    const videoItem = createVideoItem('video-drop-capture')
    const onDragOver = vi.fn<(event: ReactDragEvent<Element>) => void>((event) => {
      event.preventDefault()
    })
    const onDrop = vi.fn<(event: ReactDragEvent<Element>) => void>()

    renderVisualOverlays({
      videoItems: [videoItem],
      onDragOver,
      onDrop
    })

    const childOverlay = screen.getByTestId(`video-overlay-${videoItem.id}`)
    childOverlay.addEventListener('dragover', (event) => {
      event.stopPropagation()
    })
    childOverlay.addEventListener('drop', (event) => {
      event.stopPropagation()
    })

    fireEvent.dragEnter(childOverlay, {
      dataTransfer: { files: [] }
    })
    fireEvent.dragOver(childOverlay, {
      dataTransfer: { files: [] }
    })
    fireEvent.drop(childOverlay, {
      dataTransfer: { files: [] }
    })

    expect(onDragOver).toHaveBeenCalledTimes(2)
    expect(onDrop).toHaveBeenCalledTimes(1)
  })

  it('renders DOM overlays in truthful global zIndex order across types', () => {
    const videoItem = createVideoItem('video-z')
    videoItem.zIndex = 20
    const htmlItem = createHtmlItem('html-z')
    htmlItem.zIndex = 40
    const fileItem = createFileItem('file-z')
    fileItem.zIndex = 10
    const textItem = createTextItem('text-z')
    textItem.zIndex = 50
    const annotationItem = createAnnotationItem('annotation-z')
    annotationItem.zIndex = 30

    renderVisualOverlays({
      videoItems: [videoItem],
      htmlItems: [htmlItem],
      fileItems: [fileItem],
      textItems: [textItem],
      annotationItems: [annotationItem]
    })

    expect(renderedOverlayOrder).toEqual([
      'file:file-z',
      'video:video-z',
      'annotation:annotation-z',
      'html:html-z',
      'text:text-z'
    ])
  })

  it('keeps equal-zIndex DOM overlays in deterministic bucket and input order', () => {
    const firstVideoItem = createVideoItem('video-equal-first')
    const secondVideoItem = createVideoItem('video-equal-second')
    const htmlItem = createHtmlItem('html-equal')
    const fileItem = createFileItem('file-equal')
    const textItem = createTextItem('text-equal')
    const annotationItem = createAnnotationItem('annotation-equal')
    ;[firstVideoItem, secondVideoItem, htmlItem, fileItem, textItem, annotationItem].forEach(
      (item) => {
        item.zIndex = 10
      }
    )

    renderVisualOverlays({
      videoItems: [secondVideoItem, firstVideoItem],
      htmlItems: [htmlItem],
      fileItems: [fileItem],
      textItems: [textItem],
      annotationItems: [annotationItem]
    })

    expect(renderedOverlayOrder).toEqual([
      'video:video-equal-second',
      'video:video-equal-first',
      'html:html-equal',
      'file:file-equal',
      'text:text-equal',
      'annotation:annotation-equal'
    ])
  })

  it('exposes truthful overlay mount counts for the current viewport slice', () => {
    const modelItem = createModel3DItem('model-1')
    const visibleVideo = createVideoItem('video-visible')
    const offscreenVideo = createVideoItem('video-offscreen')
    offscreenVideo.x = 4000
    offscreenVideo.y = 3000
    const htmlItem = createHtmlItem('html-1')
    const offscreenHtmlItem = createHtmlItem('html-offscreen')
    offscreenHtmlItem.x = 4000
    offscreenHtmlItem.y = 3000
    const fileItem = createFileItem('file-1')
    const offscreenFileItem = createFileItem('file-offscreen')
    offscreenFileItem.x = 4000
    offscreenFileItem.y = 3000
    const textItem = createTextItem('text-1')
    const offscreenTextItem = createTextItem('text-offscreen')
    offscreenTextItem.x = 4000
    offscreenTextItem.y = 3000
    const annotationItem = createAnnotationItem('annotation-1')
    const offscreenAnnotationItem = createAnnotationItem('annotation-offscreen')
    offscreenAnnotationItem.x = 4000
    offscreenAnnotationItem.y = 3000

    const { portalHost } = renderVisualOverlays({
      renderedModel3DItems: [modelItem],
      videoItems: [visibleVideo, offscreenVideo],
      htmlItems: [htmlItem, offscreenHtmlItem],
      fileItems: [fileItem, offscreenFileItem],
      textItems: [textItem, offscreenTextItem],
      annotationItems: [annotationItem, offscreenAnnotationItem]
    })

    const metricsRoot = portalHost.querySelector(
      '[data-project-canvas-overlay-total-count]'
    ) as HTMLElement | null

    expect(metricsRoot?.dataset.projectCanvasCanvas3dOverlayCount).toBe('1')
    expect(metricsRoot?.dataset.projectCanvasMountedVideoOverlayCount).toBe('1')
    expect(metricsRoot?.dataset.projectCanvasHtmlOverlayCount).toBe('1')
    expect(metricsRoot?.dataset.projectCanvasFileOverlayCount).toBe('1')
    expect(metricsRoot?.dataset.projectCanvasTextOverlayCount).toBe('1')
    expect(metricsRoot?.dataset.projectCanvasAnnotationOverlayCount).toBe('1')
    expect(metricsRoot?.dataset.projectCanvasDomOverlayCount).toBe('5')
    expect(metricsRoot?.dataset.projectCanvasOverlayTotalCount).toBe('6')
  })

  it('bypasses unmounting when forced export rendering is active', () => {
    const offscreenVideo = createVideoItem('video-offscreen')
    offscreenVideo.x = 4000
    offscreenVideo.y = 3000

    renderVisualOverlays({
      videoItems: [offscreenVideo],
      forceRenderAllItemsForExport: true
    })

    expect(screen.getByTestId(`video-overlay-${offscreenVideo.id}`)).toBeInTheDocument()
    expect(videoOverlayProps.get(offscreenVideo.id)?.budgetMode).toBe('visible-paused')
  })

  it('renders only the html overlay items passed through the viewport-aware pipeline', () => {
    const visibleHtml = createHtmlItem('html-visible')
    const offscreenHtml = createHtmlItem('html-offscreen')
    offscreenHtml.x = 4000
    offscreenHtml.y = 3000

    renderVisualOverlays({
      htmlItems: [visibleHtml, offscreenHtml]
    })

    expect(screen.getByTestId(`html-overlay-${visibleHtml.id}`)).toBeInTheDocument()
    expect(screen.queryByTestId(`html-overlay-${offscreenHtml.id}`)).not.toBeInTheDocument()
    expect(htmlOverlayProps.get(visibleHtml.id)?.item).toEqual(visibleHtml)
  })

  it('keeps selected offscreen text, file, and annotation overlays mounted for editing chrome', () => {
    const offscreenFile = createFileItem('file-offscreen')
    offscreenFile.x = 4000
    offscreenFile.y = 3000
    const offscreenText = createTextItem('text-offscreen')
    offscreenText.x = 4000
    offscreenText.y = 3000
    const offscreenAnnotation = createAnnotationItem('annotation-offscreen')
    offscreenAnnotation.x = 4000
    offscreenAnnotation.y = 3000

    renderVisualOverlays({
      fileItems: [offscreenFile],
      textItems: [offscreenText],
      annotationItems: [offscreenAnnotation],
      editingTextItemId: offscreenText.id,
      selectedIds: new Set([offscreenFile.id, offscreenText.id, offscreenAnnotation.id])
    })

    expect(screen.getByTestId(`file-overlay-${offscreenFile.id}`)).toBeInTheDocument()
    expect(screen.getByTestId(`text-overlay-${offscreenText.id}`)).toBeInTheDocument()
    expect(screen.getByTestId(`annotation-overlay-${offscreenAnnotation.id}`)).toBeInTheDocument()
  })

  it('suppresses the preview selection outline for a single selected file item', () => {
    const fileItem = createFileItem('file-1')

    renderVisualOverlays({
      fileItems: [fileItem],
      selectedIds: new Set([fileItem.id])
    })

    expect(fileOverlayProps.get(fileItem.id)?.isSelected).toBe(true)
    expect(fileOverlayProps.get(fileItem.id)?.showSelectionOutline).toBe(false)
  })

  it('suppresses the preview selection outline and forwards editing state for a selected text item', () => {
    const textItem = createTextItem('text-1')

    renderVisualOverlays({
      textItems: [textItem],
      selectedIds: new Set([textItem.id]),
      editingTextItemId: textItem.id
    })

    expect(textOverlayProps.get(textItem.id)?.isSelected).toBe(true)
    expect(textOverlayProps.get(textItem.id)?.showSelectionOutline).toBe(false)
    expect(textOverlayProps.get(textItem.id)?.isEditing).toBe(true)
  })

  it('hides the independent text overlay when a single selected text item is owned by the rect overlay', () => {
    const textItem = createTextItem('text-owned-by-rect')

    renderVisualOverlays({
      textItems: [textItem],
      selectedIds: new Set([textItem.id])
    })

    expect(textOverlayProps.get(textItem.id)?.isSelected).toBe(true)
    expect(textOverlayProps.get(textItem.id)?.showSelectionOutline).toBe(false)
    expect(textOverlayProps.get(textItem.id)?.isEditing).toBe(true)
  })

  it('forwards OCR emphasis and editing state to annotation overlays', () => {
    const annotationItem = createAnnotationItem('annotation-1')

    renderVisualOverlays({
      annotationItems: [annotationItem],
      activeOcrHover: {
        bundleId: annotationItem.ocrBundleId!,
        bboxIds: [annotationItem.ocrBoxId!],
        cellIds: []
      },
      editingTextItemId: annotationItem.id
    })

    expect(annotationOverlayProps.get(annotationItem.id)?.isEmphasized).toBe(true)
    expect(annotationOverlayProps.get(annotationItem.id)?.isEditing).toBe(true)
  })
})
