import React, { type DragEvent as ReactDragEvent } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'

import ProjectCanvasPageVisualOverlays from './ProjectCanvasPageVisualOverlays'
import ProjectCanvasImageInteractionOverlay from './components/ProjectCanvasImageInteractionOverlay'
import ProjectCanvasMultiSelectionTransformOverlay from './components/ProjectCanvasMultiSelectionTransformOverlay'
import { getCanvasItemBounds } from './projectCanvasPageShared'
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
  teamLabelImageItems?: CanvasImageItem[]
  items?: CanvasItem[]
  editingTextItemId?: string | null
  activeOcrHover?: CanvasOcrHoverDetail | null
  selectedIds?: Set<string>
  sessionKey?: string
  isViewportInteracting?: boolean
  forceRenderAllItemsForExport?: boolean
  dragContextRef?: React.RefObject<{ draggingId: string | null }>
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

  const element = (
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
      teamLabelImageItems={options?.teamLabelImageItems}
      items={items}
      editingTextItemId={options?.editingTextItemId ?? null}
      activeOcrHover={options?.activeOcrHover ?? null}
      selectedIds={options?.selectedIds ?? new Set()}
      dragContextRef={options?.dragContextRef}
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

  const view = render(element)
  return { portalHost, rerenderImages: (images: CanvasImageItem[]) => view.rerender(React.cloneElement(element, { items: images, teamLabelImageItems: images })) }
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

describe('team image labels', () => {
  it.each(['drag', 'resize', 'rotate'] as const)('tracks a real image %s preview and resets on interaction unmount without changing another label', (kind) => {
    const image: CanvasImageItem = { id: 'image-one', type: 'image', src: 'fixture', teamImageLabel: '甲·图1', x: 100, y: 140, width: 200, height: 120, rotation: 0, scaleX: 1, scaleY: 1, zIndex: 1, locked: false }
    const other = { ...image, id: 'image-two', teamImageLabel: '乙·图1', x: 450 }
    const { portalHost } = renderVisualOverlays({ items: [image, other], teamLabelImageItems: [image, other] })
    const labels = portalHost.querySelectorAll('[data-canvas-team-image-label]')
    expect(labels).toHaveLength(2)
    const label = portalHost.querySelector<HTMLElement>('[data-canvas-team-image-label="image-one"]')!
    const otherLabel = portalHost.querySelector<HTMLElement>('[data-canvas-team-image-label="image-two"]')!
    const frames = new Map<number, FrameRequestCallback>()
    let nextFrame = 0
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++nextFrame, callback); return nextFrame })
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id) })
    const canvasRef = React.createRef<HTMLDivElement>()
    const onPreview = vi.fn()
    const interaction = render(<div data-testid="team-image-canvas" ref={canvasRef}><ProjectCanvasImageInteractionOverlay canvasContainerRef={canvasRef} item={image} isSelected showTransformer isDraggable stagePos={{ x: 0, y: 0 }} stageScale={1} broadcastDomPreviewSync onPreviewChange={onPreview} onSelect={vi.fn()} onDragEnd={vi.fn()} onTransformEnd={vi.fn()} /></div>)
    try {
      const root = screen.getByTestId('team-image-canvas')
      vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 20, right: 1010, bottom: 620, width: 1000, height: 600, x: 10, y: 20, toJSON: () => ({}) })
      const target = kind === 'drag' ? root.querySelector('[data-canvas-overlay="image-interaction"]') : root.querySelector(kind === 'resize' ? '[data-canvas-image-handle="bottom-right"]' : '[data-canvas-image-rotate-hotspot="top-left"]')
      expect(target).not.toBeNull()
      const start = kind === 'rotate' ? { clientX: 210, clientY: 120 } : { clientX: 310, clientY: 280 }
      const end = kind === 'rotate' ? { clientX: 310, clientY: 220 } : { clientX: 410, clientY: 340 }
      fireEvent.pointerDown(target!, { pointerId: 89, button: 0, ...start })
      fireEvent.pointerMove(window, { pointerId: 89, ...end })
      act(() => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(16)) })
      expect(onPreview).toHaveBeenCalled()
      const preview = onPreview.mock.calls.at(-1)![1]
      const bounds = getCanvasItemBounds({ ...image, ...preview })
      expect(parseFloat(label.style.left)).toBeCloseTo(bounds.minX)
      expect(parseFloat(label.style.top)).toBeCloseTo(bounds.minY)
      expect(preview).not.toMatchObject({ x: image.x, y: image.y, rotation: image.rotation, scaleX: image.scaleX, scaleY: image.scaleY })
      expect(otherLabel.style.left).toBe('450px')
      interaction.unmount()
      expect(label.style.left).toBe('100px')
      expect(label.style.top).toBe('140px')
      expect(otherLabel.style.left).toBe('450px')
    } finally { interaction.unmount(); raf.mockRestore(); cancel.mockRestore() }
  })

  it('flushes multi-selection label previews on pointerup before a delayed commit render', () => {
    const first: CanvasImageItem = { id: 'instant-first', type: 'image', src: 'fixture', teamImageLabel: '甲·图1', x: 100, y: 140, width: 200, height: 120, rotation: 0, scaleX: 1, scaleY: 1, zIndex: 1, locked: false }
    const second = { ...first, id: 'instant-second', teamImageLabel: '乙·图1', x: 360, y: 180, width: 100, height: 80 }
    const { portalHost, rerenderImages } = renderVisualOverlays({ items: [first, second], teamLabelImageItems: [first, second] })
    const label = (id: string) => portalHost.querySelector<HTMLElement>(`[data-canvas-team-image-label="${id}"]`)!
    const frames = new Map<number, FrameRequestCallback>()
    let id = 0
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++id, callback); return id })
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(frame => { frames.delete(frame) })
    const ref = React.createRef<HTMLDivElement>()
    const commit = vi.fn()
    const view = render(<div data-testid="instant-canvas" ref={ref}><ProjectCanvasMultiSelectionTransformOverlay canvasContainerRef={ref} items={[first, second]} stagePos={{ x: 0, y: 0 }} stageScale={1} onTransformEnd={commit} /></div>)
    try {
      const root = screen.getByTestId('instant-canvas')
      vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 20, right: 1010, bottom: 620, width: 1000, height: 600, x: 10, y: 20, toJSON: () => ({}) })
      fireEvent.pointerDown(root.querySelector('[data-canvas-multi-select-drag-surface="true"]')!, { pointerId: 42, clientX: 260, clientY: 200, button: 0 })
      fireEvent.pointerMove(window, { pointerId: 42, clientX: 308, clientY: 236 })
      fireEvent.pointerUp(window, { pointerId: 42, clientX: 308, clientY: 236 })
      expect(commit).toHaveBeenCalledOnce()
      expect(label(first.id).style.left).toBe('148px')
      expect(label(second.id).style.left).toBe('408px')
      act(() => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(16)) })
      expect(label(first.id).style.left).toBe('148px')
      const updates = commit.mock.calls[0][0] as { id: string; attrs: Partial<CanvasImageItem> }[]
      rerenderImages([first, second].map(item => ({ ...item, ...updates.find(update => update.id === item.id)!.attrs })))
      expect(label(first.id).style.left).toBe('148px')
      expect(label(second.id).style.left).toBe('408px')
    } finally { view.unmount(); raf.mockRestore(); cancel.mockRestore() }
  })

  it('follows real multi-selection drag previews for both labels and resets separately on unmount', () => {
    const first: CanvasImageItem = { id: 'group-first', type: 'image', src: 'fixture', teamImageLabel: '甲·图1', x: 100, y: 140, width: 200, height: 120, rotation: 0, scaleX: 1, scaleY: 1, zIndex: 1, locked: false }
    const second = { ...first, id: 'group-second', teamImageLabel: '乙·图1', x: 360, y: 180, width: 100, height: 80 }
    const other = { ...first, id: 'group-other', teamImageLabel: '旁观', x: 600 }
    const { portalHost } = renderVisualOverlays({ items: [first, second, other], teamLabelImageItems: [first, second, other] })
    const label = (id: string) => portalHost.querySelector<HTMLElement>(`[data-canvas-team-image-label="${id}"]`)!
    expect(portalHost.querySelectorAll('[data-canvas-team-image-label]')).toHaveLength(3)
    const frames = new Map<number, FrameRequestCallback>()
    let frameId = 0
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++frameId, callback); return frameId })
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id) })
    const canvasRef = React.createRef<HTMLDivElement>()
    const onTransformEnd = vi.fn()
    const interaction = render(<div data-testid="group-canvas" ref={canvasRef}><ProjectCanvasMultiSelectionTransformOverlay canvasContainerRef={canvasRef} items={[first, second]} stagePos={{ x: 0, y: 0 }} stageScale={1} onTransformEnd={onTransformEnd} /></div>)
    try {
      const root = screen.getByTestId('group-canvas')
      vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 20, right: 1010, bottom: 620, width: 1000, height: 600, x: 10, y: 20, toJSON: () => ({}) })
      const drag = root.querySelector('[data-canvas-multi-select-drag-surface="true"]')!
      expect(drag).not.toBeNull()
      fireEvent.pointerDown(drag, { pointerId: 42, clientX: 260, clientY: 200, button: 0 })
      fireEvent.pointerMove(window, { pointerId: 42, clientX: 308, clientY: 236 })
      act(() => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(16)) })
      expect(label(first.id).style.left).toBe('148px')
      expect(label(first.id).style.top).toBe('176px')
      expect(label(second.id).style.left).toBe('408px')
      expect(label(second.id).style.top).toBe('216px')
      expect(label(other.id).style.left).toBe('600px')
      expect(portalHost.querySelectorAll('[data-canvas-team-image-label]')).toHaveLength(3)
      interaction.unmount()
      expect(onTransformEnd).not.toHaveBeenCalled()
      expect(label(first.id).style.left).toBe('100px')
      expect(label(first.id).style.top).toBe('140px')
      expect(label(second.id).style.left).toBe('360px')
      expect(label(second.id).style.top).toBe('180px')
      expect(label(other.id).style.left).toBe('600px')
      expect(portalHost.querySelectorAll('[data-canvas-team-image-label]')).toHaveLength(3)
    } finally { interaction.unmount(); raf.mockRestore(); cancel.mockRestore() }
  })

  it('retains both label previews through pointerup and follows the committed parent items', () => {
    const first: CanvasImageItem = { id: 'commit-first', type: 'image', src: 'fixture', teamImageLabel: '甲·图1', x: 100, y: 140, width: 200, height: 120, rotation: 0, scaleX: 1, scaleY: 1, zIndex: 1, locked: false }
    const second = { ...first, id: 'commit-second', teamImageLabel: '乙·图1', x: 360, y: 180, width: 100, height: 80 }
    const other = { ...first, id: 'commit-other', teamImageLabel: '旁观', x: 600 }
    const { portalHost, rerenderImages } = renderVisualOverlays({ items: [first, second, other], teamLabelImageItems: [first, second, other] })
    const label = (id: string) => portalHost.querySelector<HTMLElement>(`[data-canvas-team-image-label="${id}"]`)!
    const frames = new Map<number, FrameRequestCallback>()
    let frameId = 0
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++frameId, callback); return frameId })
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id) })
    const canvasRef = React.createRef<HTMLDivElement>()
    const onTransformEnd = vi.fn()
    const interaction = render(<div data-testid="commit-canvas" ref={canvasRef}><ProjectCanvasMultiSelectionTransformOverlay canvasContainerRef={canvasRef} items={[first, second]} stagePos={{ x: 0, y: 0 }} stageScale={1} onTransformEnd={onTransformEnd} /></div>)
    try {
      const root = screen.getByTestId('commit-canvas')
      vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 20, right: 1010, bottom: 620, width: 1000, height: 600, x: 10, y: 20, toJSON: () => ({}) })
      const drag = root.querySelector('[data-canvas-multi-select-drag-surface="true"]')!
      fireEvent.pointerDown(drag, { pointerId: 42, clientX: 260, clientY: 200, button: 0 })
      fireEvent.pointerMove(window, { pointerId: 42, clientX: 308, clientY: 236 })
      act(() => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(16)) })
      const positions = () => [label(first.id).style.left, label(first.id).style.top, label(second.id).style.left, label(second.id).style.top, label(other.id).style.left, label(other.id).style.top]
      const expected = ['148px', '176px', '408px', '216px', '600px', '140px']
      expect(positions()).toEqual(expected)
      fireEvent.pointerUp(window, { pointerId: 42, clientX: 308, clientY: 236 })
      expect(onTransformEnd).toHaveBeenCalledTimes(1)
      expect(positions()).toEqual(expected)
      const updates = onTransformEnd.mock.calls[0][0] as Array<{ id: string; attrs: Partial<CanvasImageItem> }>
      expect(updates.map(update => update.id)).toEqual([first.id, second.id])
      const committed = [first, second, other].map(item => ({ ...item, ...updates.find(update => update.id === item.id)?.attrs }))
      rerenderImages(committed)
      expect(positions()).toEqual(expected)
      expect(portalHost.querySelectorAll('[data-canvas-team-image-label]')).toHaveLength(3)
      interaction.unmount()
      expect(positions()).toEqual(expected)
    } finally { interaction.unmount(); raf.mockRestore(); cancel.mockRestore() }
  })

  it('keeps both team labels aligned through an unflushed multi-selection resize and delayed parent commit', () => {
    const first: CanvasImageItem = { id: 'resize-first', type: 'image', src: 'fixture', teamImageLabel: '甲·图1', x: 100, y: 140, width: 200, height: 120, rotation: 0, scaleX: 1, scaleY: 1, zIndex: 1, locked: false }
    const second = { ...first, id: 'resize-second', teamImageLabel: '乙·图1', x: 360, y: 180, width: 100, height: 80 }
    const other = { ...first, id: 'resize-other', teamImageLabel: '旁观', x: 600 }
    const { portalHost, rerenderImages } = renderVisualOverlays({ items: [first, second, other], teamLabelImageItems: [first, second, other] })
    const label = (id: string) => portalHost.querySelector<HTMLElement>(`[data-canvas-team-image-label="${id}"]`)!
    const positions = () => [label(first.id).style.left, label(first.id).style.top, label(second.id).style.left, label(second.id).style.top, label(other.id).style.left, label(other.id).style.top]
    const frames = new Map<number, FrameRequestCallback>()
    let frameId = 0
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++frameId, callback); return frameId })
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id) })
    const canvasRef = React.createRef<HTMLDivElement>()
    const onTransformEnd = vi.fn()
    const interaction = render(<div data-testid="resize-canvas" ref={canvasRef}><ProjectCanvasMultiSelectionTransformOverlay canvasContainerRef={canvasRef} items={[first, second]} stagePos={{ x: 0, y: 0 }} stageScale={1} onTransformEnd={onTransformEnd} /></div>)
    try {
      const root = screen.getByTestId('resize-canvas')
      vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 20, right: 1010, bottom: 620, width: 1000, height: 600, x: 10, y: 20, toJSON: () => ({}) })
      const handle = root.querySelector('[data-canvas-multi-select-handle="bottom-right"]')!
      expect(handle).not.toBeNull()
      fireEvent.pointerDown(handle, { pointerId: 41, clientX: 470, clientY: 280, button: 0 })
      fireEvent.pointerMove(window, { pointerId: 41, clientX: 650, clientY: 340 })
      expect(positions()).toEqual(['100px', '140px', '360px', '180px', '600px', '140px'])
      fireEvent.pointerUp(window, { pointerId: 41, clientX: 650, clientY: 340 })
      expect(onTransformEnd).toHaveBeenCalledOnce()
      const expected = ['100px', '140px', '490px', '200px', '600px', '140px']
      expect(positions()).toEqual(expected)
      expect(onTransformEnd).toHaveBeenCalledWith([
        { id: first.id, attrs: { x: 100, y: 140, scaleX: 1.5, scaleY: 1.5 } },
        { id: second.id, attrs: { x: 490, y: 200, scaleX: 1.5, scaleY: 1.5 } }
      ])
      act(() => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(16)) })
      expect(positions()).toEqual(expected)
      const updates = onTransformEnd.mock.calls[0][0] as Array<{ id: string; attrs: Partial<CanvasImageItem> }>
      rerenderImages([first, second, other].map(item => ({ ...item, ...updates.find(update => update.id === item.id)?.attrs })))
      expect(positions()).toEqual(expected)
      expect(portalHost.querySelectorAll('[data-canvas-team-image-label]')).toHaveLength(3)
      interaction.unmount()
      expect(positions()).toEqual(expected)
    } finally { interaction.unmount(); raf.mockRestore(); cancel.mockRestore() }
  })

  it('positions labels at independently calculated transformed AABB corners', () => {
    const base: CanvasImageItem = { id: 'bounds-image', type: 'image', src: 'fixture', teamImageLabel: '几何', x: 100, y: 140, width: 200, height: 120, rotation: 90, scaleX: 2, scaleY: 0.5, zIndex: 1, locked: false }
    const { portalHost } = renderVisualOverlays({ items: [base], teamLabelImageItems: [base] })
    const label = portalHost.querySelector<HTMLElement>('[data-canvas-team-image-label="bounds-image"]')!
    expect(parseFloat(label.style.left)).toBeCloseTo(40)
    expect(parseFloat(label.style.top)).toBeCloseTo(140)
  })

  it('renders only explicit labels and follows canvas preview without becoming an item hit target', () => {
    const image: CanvasImageItem = { id: 'team-image', type: 'image', src: 'fixture', fileName: '文案·图1.png', teamImageLabel: '文案·图1', x: 10, y: 20, width: 100, height: 50, rotation: 0, scaleX: 1, scaleY: 1, zIndex: 1, locked: false }
    const ordinary: CanvasImageItem = { ...image, id: 'ordinary', teamImageLabel: undefined }
    const layer = vi.fn()
    const { portalHost: host } = renderVisualOverlays({ items: [image, ordinary], teamLabelImageItems: [image], registerViewportLayer: layer })
    const badge = host.querySelector('[data-canvas-team-image-label="team-image"]') as HTMLElement
    expect(badge.textContent).toBe('文案·图1')
    expect(host.querySelector('[data-canvas-team-image-label="ordinary"]')).toBeNull()
    expect(badge.hasAttribute('data-canvas-item-id')).toBe(false)
    expect(getComputedStyle(badge).pointerEvents).toBe('none')
    expect(layer).toHaveBeenCalledWith(badge.parentElement)
    expect(badge.style.left).toBe('10px'); expect(badge.style.top).toBe('20px')
    act(() => window.dispatchEvent(new CustomEvent('canvas-sync-team-image', { detail: { x: 50, y: 70, rotation: 0, scaleX: 1, scaleY: 1 } })))
    expect(badge.style.left).toBe('50px'); expect(badge.style.top).toBe('70px')
    act(() => window.dispatchEvent(new Event('canvas-reset-team-image')))
    expect(badge.style.left).toBe('10px'); expect(badge.style.top).toBe('20px')
  })
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

  it('keeps the independent text overlay visible while its placeholder drag is active', () => {
    const textItem = createTextItem('text-dragged-by-placeholder')

    renderVisualOverlays({
      textItems: [textItem],
      selectedIds: new Set([textItem.id]),
      dragContextRef: { current: { draggingId: textItem.id } }
    })

    expect(textOverlayProps.get(textItem.id)?.isSelected).toBe(true)
    expect(textOverlayProps.get(textItem.id)?.showSelectionOutline).toBe(false)
    expect(textOverlayProps.get(textItem.id)?.isEditing).toBe(false)
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

  it('keeps an editing annotation visible while its placeholder drag is active', () => {
    const annotationItem: CanvasAnnotationItem = {
      ...createAnnotationItem('annotation-dragged-by-placeholder'),
      shape: 'text-anno',
      text: 'Dragged annotation text'
    }

    renderVisualOverlays({
      annotationItems: [annotationItem],
      selectedIds: new Set([annotationItem.id]),
      editingTextItemId: annotationItem.id,
      dragContextRef: { current: { draggingId: annotationItem.id } }
    })

    expect(annotationOverlayProps.get(annotationItem.id)?.isEditing).toBe(false)
  })
})
