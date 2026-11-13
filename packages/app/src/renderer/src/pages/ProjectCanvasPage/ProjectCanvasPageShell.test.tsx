import { hideCanvasItemsTransiently, showCanvasItemsTransiently } from './canvasTransientVisibility'
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'

import ProjectCanvasPageShell from './ProjectCanvasPageShell'
import type {
  CanvasAnnotationItem,
  CanvasFileItem,
  CanvasModel3DItem,
  CanvasTextItem
} from './types'

type StageSceneProps = {
  onLiveMultiSelectionBoundsChange: (bounds: {
    x: number
    y: number
    width: number
    height: number
  }) => void
}

type OverlayAssemblyProps = {
  suspendViewportChrome: boolean
  selectionOverlaysProps: {
    registerViewportCallback?: unknown
    liveMultiSelectionBounds?: { x: number; y: number; width: number; height: number } | null
  }
  visualOverlaysProps: {
    teamLabelImageItems: Array<{ id: string }>
    items: Array<{ id: string }>
    annotationItems: CanvasAnnotationItem[]
    textItems: CanvasTextItem[]
    fileItems: CanvasFileItem[]
    renderedModel3DItems: CanvasModel3DItem[]
    registerViewportLayer?: unknown
    isViewportInteracting?: boolean
  }
}

let latestOverlayAssemblyProps: OverlayAssemblyProps | null = null

const { latestStageSceneProps, stageSceneRenderMock } = vi.hoisted(() => ({
  latestStageSceneProps: { current: null as StageSceneProps | null },
  stageSceneRenderMock: vi.fn()
}))

vi.mock('./ProjectCanvasPageTopToolbar', () => ({
  default: () => <div data-testid="top-toolbar" />
}))

vi.mock('./ProjectCanvasPageStageScene', () => ({
  default: (props: StageSceneProps) => {
    latestStageSceneProps.current = props
    stageSceneRenderMock(props)
    return <div data-testid="stage-scene" />
  }
}))

vi.mock('./ProjectCanvasPageOverlayDialogAssembly', () => ({
  default: (props: OverlayAssemblyProps) => {
    latestOverlayAssemblyProps = props
    return <div data-testid="overlay-assembly" />
  }
}))

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
    shape: 'text-anno',
    stroke: '#ef4444',
    fillOpacity: 0,
    strokeWidth: 2,
    label: '',
    text: '123',
    x: 24,
    y: 28,
    width: 180,
    height: 96,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 2,
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
    zIndex: 3,
    locked: false,
    editable: true
  }
}

function createModel3DItem(id: string): CanvasModel3DItem {
  return {
    id,
    type: 'model3d',
    src: `${id}.glb`,
    fileName: `${id}.glb`,
    x: 96,
    y: 128,
    width: 240,
    height: 180,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 4,
    locked: false
  }
}

describe('ProjectCanvasPageShell visual overlay routing', () => {
  afterEach(() => {
    latestOverlayAssemblyProps = null
    latestStageSceneProps.current = null
    vi.clearAllMocks()
  })

  it('routes only visible non-hidden labelled images and rechecks on rerender', () => {
    const image = { id: 'visible', type: 'image' as const, src: 'fixture', teamImageLabel: '文案·图1', x: 0, y: 0, width: 100, height: 100, rotation: 0, scaleX: 1, scaleY: 1, zIndex: 1, locked: false }
    const outside = { ...image, id: 'outside' }, hidden = { ...image, id: 'hidden' }, ordinary = { ...image, id: 'ordinary', teamImageLabel: undefined }
    const visible = [image, hidden, ordinary], all = [image, hidden, ordinary, outside]
    const props = { canvasContainerRef: { current: document.createElement('div') }, stagePos: { x: 0, y: 0 }, stageScale: 1, stageSize: { width: 1280, height: 720 }, selectedIds: new Set<string>(), videoItems: [], htmlItems: [], renderedModel3DItems: [], visibleItems: visible, items: all, inlineTextEdit: null, activeOcrHover: null, tool: 'select', selectionOverlayGroups: [], lastClickedIdRef: { current: null }, isLegacySelectionToolbarEnabled: () => false, t: (key: string) => key }
    hideCanvasItemsTransiently(['hidden'])
    try {
      const page = render(<ProjectCanvasPageShell {...props} />)
      expect(latestOverlayAssemblyProps?.visualOverlaysProps.teamLabelImageItems.map(x => x.id)).toEqual(['visible'])
      expect(latestOverlayAssemblyProps?.visualOverlaysProps.items).toBe(all)
      act(() => showCanvasItemsTransiently(['hidden']))
      page.rerender(<ProjectCanvasPageShell {...props} isViewportInteracting />)
      expect(latestOverlayAssemblyProps?.visualOverlaysProps.teamLabelImageItems.map(x => x.id)).toEqual(['visible', 'hidden'])
    } finally { showCanvasItemsTransiently(['hidden']) }
  })

  it.fails('P6: updates labelled images on visibility changes without prop rerenders or duplicate notifications', () => {
    const image = { id: 'subscription-image', type: 'image' as const, src: 'fixture', teamImageLabel: '甲·图1', x: 0, y: 0, width: 100, height: 100, rotation: 0, scaleX: 1, scaleY: 1, zIndex: 1, locked: false }
    const props = { canvasContainerRef: { current: document.createElement('div') }, stagePos: { x: 0, y: 0 }, stageScale: 1, stageSize: { width: 1280, height: 720 }, selectedIds: new Set<string>(), videoItems: [], htmlItems: [], renderedModel3DItems: [], visibleItems: [image], items: [image], inlineTextEdit: null, activeOcrHover: null, tool: 'select', selectionOverlayGroups: [], lastClickedIdRef: { current: null }, isLegacySelectionToolbarEnabled: () => false, t: (key: string) => key }
    const renders = vi.fn()
    const page = render(<React.Profiler id="shell" onRender={renders}><ProjectCanvasPageShell {...props} /></React.Profiler>)
    try {
      expect(latestOverlayAssemblyProps?.visualOverlaysProps.teamLabelImageItems.map(item => item.id)).toEqual([image.id])
      act(() => hideCanvasItemsTransiently([image.id, image.id]))
      expect(latestOverlayAssemblyProps?.visualOverlaysProps.teamLabelImageItems).toEqual([])
      const afterHide = renders.mock.calls.length
      act(() => hideCanvasItemsTransiently([image.id]))
      expect(renders).toHaveBeenCalledTimes(afterHide)
      act(() => showCanvasItemsTransiently([image.id, image.id]))
      expect(latestOverlayAssemblyProps?.visualOverlaysProps.teamLabelImageItems.map(item => item.id)).toEqual([image.id])
      const afterShow = renders.mock.calls.length
      act(() => showCanvasItemsTransiently([image.id]))
      expect(renders).toHaveBeenCalledTimes(afterShow)
      page.unmount()
      const afterUnmount = renders.mock.calls.length
      act(() => { hideCanvasItemsTransiently([image.id]); showCanvasItemsTransiently([image.id]) })
      expect(renders).toHaveBeenCalledTimes(afterUnmount)
    } finally { page.unmount(); showCanvasItemsTransiently([image.id]) }
  })

  it('keeps visual overlays mounted during viewport interaction and forwards the shared viewport driver', () => {
    const textItem = createTextItem('text-1')
    const annotationItem = createAnnotationItem('annotation-1')
    const fileItem = createFileItem('file-1')
    const modelItem = createModel3DItem('model-1')
    const registerViewportLayer = vi.fn()

    render(
      <ProjectCanvasPageShell
        canvasContainerRef={{ current: document.createElement('div') }}
        isViewportInteracting
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        stageSize={{ width: 1280, height: 720 }}
        selectedIds={new Set<string>()}
        videoItems={[]}
        htmlItems={[]}
        renderedModel3DItems={[modelItem]}
        visibleItems={[annotationItem, textItem, fileItem]}
        items={[annotationItem, textItem, fileItem, modelItem]}
        inlineTextEdit={null}
        activeOcrHover={null}
        tool="select"
        canvasAgentSessionKey="canvas:thread:project-1:thread:agent-1"
        forceRenderAllItemsForExport={false}
        handleDragOver={vi.fn()}
        handleDrop={vi.fn()}
        handleDragEnd={vi.fn()}
        handleUpdateVideoItem={vi.fn()}
        handleImageContextMenu={vi.fn()}
        handleUpdateHtmlItem={vi.fn()}
        handleDeleteHtmlItem={vi.fn()}
        groupPlayback={null}
        activeGroupPlaybackItem={null}
        activeGroupPlaybackCanvasBounds={null}
        activeGroupPlaybackScreenBounds={null}
        activeGroupPlaybackGroup={null}
        pauseGroupPlayback={vi.fn()}
        resumeGroupPlayback={vi.fn()}
        setSelectedIds={vi.fn()}
        selectionOverlayGroups={[]}
        exactSelectedGroup={null}
        stageRef={{ current: null }}
        lastClickedIdRef={{ current: null }}
        mediaCaptionActionLabel="Caption"
        isLegacySelectionToolbarEnabled={() => false}
        t={(key: string) => key}
        registerViewportLayer={registerViewportLayer}
      />
    )

    expect(screen.getByTestId('overlay-assembly')).toBeInTheDocument()
    expect(latestOverlayAssemblyProps?.suspendViewportChrome).toBe(false)
    expect(latestOverlayAssemblyProps?.selectionOverlaysProps?.registerViewportCallback).toBe(
      undefined
    )
    expect(
      (
        latestOverlayAssemblyProps?.visualOverlaysProps?.annotationItems as CanvasAnnotationItem[]
      ).map((item) => item.id)
    ).toEqual([annotationItem.id])
    expect(
      (latestOverlayAssemblyProps?.visualOverlaysProps?.textItems as CanvasTextItem[]).map(
        (item) => item.id
      )
    ).toEqual([textItem.id])
    expect(
      (latestOverlayAssemblyProps?.visualOverlaysProps?.fileItems as CanvasFileItem[]).map(
        (item) => item.id
      )
    ).toEqual([fileItem.id])
    expect(
      (
        latestOverlayAssemblyProps?.visualOverlaysProps?.renderedModel3DItems as CanvasModel3DItem[]
      ).map((item) => item.id)
    ).toEqual([modelItem.id])
    expect(latestOverlayAssemblyProps?.visualOverlaysProps?.registerViewportLayer).toBe(
      registerViewportLayer
    )
    expect(latestOverlayAssemblyProps?.visualOverlaysProps?.isViewportInteracting).toBe(true)
  })

  it('keeps selection overlays mounted for multi-selection during viewport interaction', () => {
    const firstItem = createTextItem('text-1')
    const secondItem = createAnnotationItem('annotation-1')

    render(
      <ProjectCanvasPageShell
        canvasContainerRef={{ current: document.createElement('div') }}
        isViewportInteracting
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        stageSize={{ width: 1280, height: 720 }}
        selectedIds={new Set<string>([firstItem.id, secondItem.id])}
        videoItems={[]}
        htmlItems={[]}
        renderedModel3DItems={[]}
        visibleItems={[firstItem, secondItem]}
        items={[firstItem, secondItem]}
        inlineTextEdit={null}
        activeOcrHover={null}
        tool="select"
        canvasAgentSessionKey="canvas:thread:project-1:thread:agent-1"
        forceRenderAllItemsForExport={false}
        handleDragOver={vi.fn()}
        handleDrop={vi.fn()}
        handleDragEnd={vi.fn()}
        handleUpdateVideoItem={vi.fn()}
        handleImageContextMenu={vi.fn()}
        handleUpdateHtmlItem={vi.fn()}
        handleDeleteHtmlItem={vi.fn()}
        groupPlayback={null}
        activeGroupPlaybackItem={null}
        activeGroupPlaybackCanvasBounds={null}
        activeGroupPlaybackScreenBounds={null}
        activeGroupPlaybackGroup={null}
        pauseGroupPlayback={vi.fn()}
        resumeGroupPlayback={vi.fn()}
        setSelectedIds={vi.fn()}
        selectionOverlayGroups={[]}
        exactSelectedGroup={null}
        stageRef={{ current: null }}
        lastClickedIdRef={{ current: firstItem.id }}
        mediaCaptionActionLabel="Caption"
        isLegacySelectionToolbarEnabled={() => false}
        t={(key: string) => key}
      />
    )

    expect(screen.getByTestId('overlay-assembly')).toBeInTheDocument()
    expect(latestOverlayAssemblyProps?.suspendViewportChrome).toBe(false)
  })

  it('does not re-render the stage scene for live multi-selection bounds updates', () => {
    const firstItem = createTextItem('text-1')
    const secondItem = createAnnotationItem('annotation-1')

    render(
      <ProjectCanvasPageShell
        canvasContainerRef={{ current: document.createElement('div') }}
        isViewportInteracting={false}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        stageSize={{ width: 1280, height: 720 }}
        selectedIds={new Set<string>([firstItem.id, secondItem.id])}
        videoItems={[]}
        htmlItems={[]}
        renderedModel3DItems={[]}
        visibleItems={[firstItem, secondItem]}
        items={[firstItem, secondItem]}
        inlineTextEdit={null}
        activeOcrHover={null}
        tool="select"
        canvasAgentSessionKey="canvas:thread:project-1:thread:agent-1"
        forceRenderAllItemsForExport={false}
        handleDragOver={vi.fn()}
        handleDrop={vi.fn()}
        handleDragEnd={vi.fn()}
        handleUpdateVideoItem={vi.fn()}
        handleImageContextMenu={vi.fn()}
        handleUpdateHtmlItem={vi.fn()}
        handleDeleteHtmlItem={vi.fn()}
        groupPlayback={null}
        activeGroupPlaybackItem={null}
        activeGroupPlaybackCanvasBounds={null}
        activeGroupPlaybackScreenBounds={null}
        activeGroupPlaybackGroup={null}
        pauseGroupPlayback={vi.fn()}
        resumeGroupPlayback={vi.fn()}
        setSelectedIds={vi.fn()}
        selectionOverlayGroups={[]}
        exactSelectedGroup={null}
        stageRef={{ current: null }}
        lastClickedIdRef={{ current: firstItem.id }}
        mediaCaptionActionLabel="Caption"
        isLegacySelectionToolbarEnabled={() => false}
        t={(key: string) => key}
      />
    )

    const renderCountAfterMount = stageSceneRenderMock.mock.calls.length

    act(() => {
      latestStageSceneProps.current?.onLiveMultiSelectionBoundsChange({
        x: 128,
        y: 160,
        width: 360,
        height: 140
      })
    })

    expect(stageSceneRenderMock).toHaveBeenCalledTimes(renderCountAfterMount)
    expect(latestOverlayAssemblyProps?.selectionOverlaysProps?.liveMultiSelectionBounds).toEqual({
      x: 128,
      y: 160,
      width: 360,
      height: 140
    })
  })

  it('shows image batch import progress without re-rendering the stage scene', () => {
    const firstItem = createTextItem('text-progress-1')
    const shellProps = {
      canvasContainerRef: { current: document.createElement('div') },
      isViewportInteracting: false,
      stagePos: { x: 0, y: 0 },
      stageScale: 1,
      stageSize: { width: 1280, height: 720 },
      selectedIds: new Set<string>(),
      videoItems: [],
      htmlItems: [],
      renderedModel3DItems: [],
      visibleItems: [firstItem],
      items: [firstItem],
      inlineTextEdit: null,
      activeOcrHover: null,
      tool: 'select',
      canvasAgentSessionKey: 'canvas:thread:project-1:thread:agent-1',
      forceRenderAllItemsForExport: false,
      handleDragOver: vi.fn(),
      handleDrop: vi.fn(),
      handleDragEnd: vi.fn(),
      handleUpdateVideoItem: vi.fn(),
      handleImageContextMenu: vi.fn(),
      handleUpdateHtmlItem: vi.fn(),
      handleDeleteHtmlItem: vi.fn(),
      groupPlayback: null,
      activeGroupPlaybackItem: null,
      activeGroupPlaybackCanvasBounds: null,
      activeGroupPlaybackScreenBounds: null,
      activeGroupPlaybackGroup: null,
      pauseGroupPlayback: vi.fn(),
      resumeGroupPlayback: vi.fn(),
      setSelectedIds: vi.fn(),
      selectionOverlayGroups: [],
      exactSelectedGroup: null,
      stageRef: { current: null },
      lastClickedIdRef: { current: null },
      mediaCaptionActionLabel: 'Caption',
      isLegacySelectionToolbarEnabled: () => false,
      isChineseUi: false,
      theme: {
        palette: {
          divider: '#334155',
          background: { paper: '#111827' },
          primary: { main: '#60a5fa' }
        },
        shadows: Array.from({ length: 25 }, () => 'none')
      },
      t: (key: string) => key
    }

    const { rerender } = render(<ProjectCanvasPageShell {...shellProps} />)
    const renderCountAfterMount = stageSceneRenderMock.mock.calls.length

    rerender(
      <ProjectCanvasPageShell
        {...shellProps}
        imageBatchImportProgress={{
          phase: 'preparing',
          total: 72,
          processed: 24,
          imported: 0,
          failed: 0
        }}
      />
    )

    expect(screen.getByTestId('canvas-image-batch-import-progress')).toHaveTextContent(
      'Importing images 8/72'
    )
    expect(screen.getByTestId('canvas-image-batch-import-progress')).toHaveTextContent('12%')

    rerender(
      <ProjectCanvasPageShell
        {...shellProps}
        imageBatchImportProgress={{
          phase: 'loading',
          total: 72,
          processed: 24,
          imported: 24,
          failed: 0
        }}
      />
    )

    expect(screen.getByTestId('canvas-image-batch-import-progress')).toHaveTextContent(
      'Importing images 41/72'
    )
    expect(screen.getByTestId('canvas-image-batch-import-progress')).toHaveTextContent('57%')
    expect(stageSceneRenderMock).toHaveBeenCalledTimes(renderCountAfterMount)
    expect(latestStageSceneProps.current).not.toHaveProperty('imageBatchImportProgress')
  })
})
