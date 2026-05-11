import React from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ThemeProvider } from '@mui/material'
import { describe, expect, it, vi } from 'vitest'
import type { Stage as KonvaStage } from 'konva/lib/Stage'

import { theme } from '@renderer/theme'
import ProjectCanvasPageSelectionOverlays from './ProjectCanvasPageSelectionOverlays'
import type { CanvasDragPayload } from './projectCanvasPageShared'
import type { CanvasItem, CanvasVideoItem } from './types'

vi.mock('react-konva', () => ({
  Line: () => null
}))

vi.mock('konva', () => ({
  default: {}
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: {
      language: 'en-US',
      resolvedLanguage: 'en-US'
    }
  })
}))

function createImageItem(
  overrides: Partial<Extract<CanvasItem, { type: 'image' }>> = {}
): CanvasItem {
  return {
    id: 'image-1',
    type: 'image',
    src: 'image-1.png',
    x: 120,
    y: 180,
    width: 96,
    height: 96,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false,
    ...overrides
  }
}

function createVideoItem(overrides: Partial<CanvasVideoItem> = {}): CanvasVideoItem {
  return {
    id: 'video-1',
    type: 'video',
    src: 'video-1.mp4',
    fileName: 'video-1.mp4',
    x: 120,
    y: 180,
    width: 160,
    height: 90,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false,
    playing: true,
    muted: true,
    volume: 1,
    ...overrides
  }
}

function createTextItem(): CanvasItem {
  return {
    id: 'text-1',
    type: 'text',
    text: 'Canvas text',
    fill: '#ffffff',
    fontSize: 24,
    fontFamily: 'system-ui',
    fontWeight: 'normal',
    x: 80,
    y: 120,
    width: 180,
    height: 72,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false
  }
}

function createAnnotationItem(
  overrides: Partial<Extract<CanvasItem, { type: 'annotation' }>> = {}
): CanvasItem {
  return {
    id: 'annotation-1',
    type: 'annotation',
    shape: 'text-anno',
    stroke: '#ef4444',
    fillOpacity: 0,
    strokeWidth: 2,
    label: '',
    text: '123',
    fontSize: 28,
    x: 40,
    y: 186,
    width: 260,
    height: 48,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 2,
    locked: false,
    ...overrides
  }
}

function createFileItem(
  overrides: Partial<Extract<CanvasItem, { type: 'file' }>> = {}
): CanvasItem {
  return {
    id: 'file-1',
    type: 'file',
    src: 'blob:file-1',
    fileName: 'sheet.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    fileKind: 'excel',
    x: 100,
    y: 140,
    width: 180,
    height: 96,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false,
    editable: true,
    previewSheets: [
      {
        id: 'sheet-1',
        name: 'Sheet1',
        rows: 1,
        cols: 1,
        cells: [{ row: 1, col: 1, text: 'A1' }]
      }
    ],
    ...overrides
  }
}

function mockCanvasContainerRect(element: HTMLElement) {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      left: 10,
      top: 20,
      right: 1010,
      bottom: 620,
      width: 1000,
      height: 600,
      x: 10,
      y: 20,
      toJSON: () => ({})
    })
  })
}

function mockElementRect(
  element: HTMLElement,
  rect: {
    left: number
    top: number
    width: number
    height: number
  }
) {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      left: rect.left,
      top: rect.top,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      width: rect.width,
      height: rect.height,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({})
    })
  })
}

describe('ProjectCanvasPageSelectionOverlays', () => {
  it('hides selection overlay chrome while the canvas marquee flag is active', async () => {
    const canvasContainer = document.createElement('div')
    Object.defineProperty(canvasContainer, 'clientWidth', {
      configurable: true,
      value: 800
    })
    Object.defineProperty(canvasContainer, 'clientHeight', {
      configurable: true,
      value: 600
    })
    canvasContainer.setAttribute('data-project-canvas-marquee-active', 'true')
    document.body.appendChild(canvasContainer)

    const imageItem = createImageItem()
    const stage = {
      findOne: vi.fn(() => ({
        getClientRect: () => ({
          x: 120,
          y: 180,
          width: 96,
          height: 96
        })
      }))
    }

    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPageSelectionOverlays
          tool="select"
          selectionOverlayGroups={[]}
          exactSelectedGroup={null}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          stageSize={{ width: 800, height: 600 }}
          selectedIds={new Set([imageItem.id])}
          items={[imageItem]}
          stageRef={{ current: stage as unknown as KonvaStage }}
          canvasContainerRef={{ current: canvasContainer }}
          canvasContainerElement={canvasContainer}
          lastClickedId={imageItem.id}
          mediaCaptionActionLabel="Caption"
          legacySelectionToolbarEnabled={false}
          groupCreateLabel="Create group"
          handleFocusGroup={vi.fn()}
          buildCanvasDragPayload={vi.fn(() => ({ sourceCanvasId: 'canvas-1' }))}
          setCanvasDragPayload={vi.fn()}
          handleFlipImage={vi.fn()}
          handleCropImage={vi.fn()}
          handleExplodeImage={vi.fn()}
          handleCopyCanvasImage={vi.fn()}
          handleDownloadCanvasImage={vi.fn()}
          handleOpenAgentSendMenu={vi.fn()}
          handleOpenMediaCaptionEditor={vi.fn()}
          handleSendCanvasItemsToAgent={vi.fn()}
          handleToggleVideoPlayback={vi.fn()}
          resolvedVideoBudgetModeById={new Map()}
          handleOpenModel3DViewer={vi.fn()}
          handleOpenDccExportMenu={vi.fn()}
          handleDownloadBlobItem={vi.fn()}
          handleExportCanvasFile={vi.fn()}
          handleCopyCanvasItemsAsImage={vi.fn()}
          handleDownloadCanvasItemsAsImage={vi.fn()}
          getQuickCanvasItemsImageUrl={vi.fn(() => null)}
          prepareQuickCanvasItemsImageUrl={vi.fn(async () => null)}
          handleGenerateCanvasItems={vi.fn()}
          handleCreateGroup={vi.fn()}
          fileExportActionLabel="Export file"
          Model3DIcon={() => null}
          ExportIcon={() => null}
        />
      </ThemeProvider>
    )

    const overlayRoot = await waitFor(() => {
      const node = canvasContainer.querySelector(
        '[data-project-canvas-selection-overlays="true"]'
      ) as HTMLElement | null
      expect(node).toBeTruthy()
      return node as HTMLElement
    })
    expect(getComputedStyle(overlayRoot).display).toBe('none')

    canvasContainer.remove()
  })

  it('does not mount multi-selection action chrome while marquee release is settling', () => {
    const canvasContainer = document.createElement('div')
    Object.defineProperty(canvasContainer, 'clientWidth', {
      configurable: true,
      value: 800
    })
    Object.defineProperty(canvasContainer, 'clientHeight', {
      configurable: true,
      value: 600
    })
    document.body.appendChild(canvasContainer)

    const firstImageItem = createImageItem({ id: 'image-1', x: 120, y: 180 })
    const secondImageItem = createImageItem({ id: 'image-2', x: 260, y: 180 })
    const prepareQuickCanvasItemsImageUrl = vi.fn(async () => null)

    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPageSelectionOverlays
          tool="select"
          selectionOverlayGroups={[]}
          exactSelectedGroup={null}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          stageSize={{ width: 800, height: 600 }}
          selectedIds={new Set([firstImageItem.id, secondImageItem.id])}
          items={[firstImageItem, secondImageItem]}
          stageRef={{ current: null }}
          canvasContainerRef={{ current: canvasContainer }}
          canvasContainerElement={canvasContainer}
          lastClickedId={secondImageItem.id}
          mediaCaptionActionLabel="Caption"
          legacySelectionToolbarEnabled={false}
          groupCreateLabel="Create group"
          suppressSelectionChrome
          handleFocusGroup={vi.fn()}
          buildCanvasDragPayload={vi.fn(() => ({ sourceCanvasId: 'canvas-1' }))}
          setCanvasDragPayload={vi.fn()}
          handleFlipImage={vi.fn()}
          handleCropImage={vi.fn()}
          handleExplodeImage={vi.fn()}
          handleCopyCanvasImage={vi.fn()}
          handleDownloadCanvasImage={vi.fn()}
          handleOpenAgentSendMenu={vi.fn()}
          handleOpenMediaCaptionEditor={vi.fn()}
          handleSendCanvasItemsToAgent={vi.fn()}
          handleToggleVideoPlayback={vi.fn()}
          resolvedVideoBudgetModeById={new Map()}
          handleOpenModel3DViewer={vi.fn()}
          handleOpenDccExportMenu={vi.fn()}
          handleDownloadBlobItem={vi.fn()}
          handleExportCanvasFile={vi.fn()}
          handleCopyCanvasItemsAsImage={vi.fn()}
          handleDownloadCanvasItemsAsImage={vi.fn()}
          getQuickCanvasItemsImageUrl={vi.fn(() => null)}
          prepareQuickCanvasItemsImageUrl={prepareQuickCanvasItemsImageUrl}
          handleGenerateCanvasItems={vi.fn()}
          handleCreateGroup={vi.fn()}
          fileExportActionLabel="Export file"
          Model3DIcon={() => null}
          ExportIcon={() => null}
        />
      </ThemeProvider>
    )

    expect(
      canvasContainer.querySelector('[data-project-canvas-selection-overlays="true"]')
    ).not.toBeNull()
    expect(canvasContainer.querySelector('.selection-action-stack')).toBeNull()
    expect(prepareQuickCanvasItemsImageUrl).not.toHaveBeenCalled()

    canvasContainer.remove()
  })

  it('renders floating toolbars inside the canvas container portal instead of the page shell', async () => {
    const canvasContainer = document.createElement('div')
    Object.defineProperty(canvasContainer, 'clientWidth', {
      configurable: true,
      value: 800
    })
    Object.defineProperty(canvasContainer, 'clientHeight', {
      configurable: true,
      value: 600
    })
    document.body.appendChild(canvasContainer)

    const stage = {
      findOne: vi.fn(() => ({
        getClientRect: () => ({
          x: 120,
          y: 180,
          width: 96,
          height: 96
        })
      }))
    }
    const buildCanvasDragPayload = vi.fn(
      (): CanvasDragPayload => ({
        sourceCanvasId: 'canvas-1'
      })
    )
    const stageRef = {
      current: {
        getStage: () => stage
      }
    } as unknown as React.RefObject<KonvaStage | null>

    const renderResult = render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPageSelectionOverlays
          tool="select"
          selectionOverlayGroups={[]}
          exactSelectedGroup={null}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          stageSize={{ width: 800, height: 600 }}
          selectedIds={new Set(['image-1'])}
          items={[createImageItem()]}
          stageRef={stageRef}
          canvasContainerRef={{ current: canvasContainer }}
          lastClickedId="image-1"
          mediaCaptionActionLabel="Edit caption"
          legacySelectionToolbarEnabled={false}
          groupCreateLabel="Group"
          handleFocusGroup={vi.fn()}
          buildCanvasDragPayload={buildCanvasDragPayload}
          setCanvasDragPayload={vi.fn()}
          handleFlipImage={vi.fn()}
          handleCropImage={vi.fn()}
          handleCopyCanvasImage={vi.fn()}
          handleDownloadCanvasImage={vi.fn()}
          handleOpenAgentSendMenu={vi.fn()}
          handleOpenMediaCaptionEditor={vi.fn()}
          handleSendCanvasItemsToAgent={vi.fn()}
          handleToggleVideoPlayback={vi.fn()}
          handleOpenModel3DViewer={vi.fn()}
          handleOpenDccExportMenu={vi.fn()}
          handleDownloadBlobItem={vi.fn()}
          handleCopyCanvasItemsAsImage={vi.fn()}
          handleDownloadCanvasItemsAsImage={vi.fn()}
          getQuickCanvasItemsImageUrl={vi.fn(() => null)}
          prepareQuickCanvasItemsImageUrl={vi.fn(async () => null)}
          handleGenerateCanvasItems={vi.fn()}
          handleCreateGroup={vi.fn()}
          Model3DIcon={() => null}
          ExportIcon={() => null}
        />
      </ThemeProvider>
    )

    await waitFor(() => {
      expect(canvasContainer.querySelector('.image-action-toolbar')).toBeTruthy()
    })

    expect(renderResult.container.querySelector('.image-action-toolbar')).toBeNull()

    canvasContainer.remove()
  })

  it('anchors the image toolbar to the image interaction overlay instead of a stale generic node', async () => {
    const canvasContainer = document.createElement('div')
    Object.defineProperty(canvasContainer, 'clientWidth', {
      configurable: true,
      value: 800
    })
    Object.defineProperty(canvasContainer, 'clientHeight', {
      configurable: true,
      value: 600
    })
    document.body.appendChild(canvasContainer)

    const staleOverlay = document.createElement('div')
    staleOverlay.setAttribute('data-canvas-item-id', 'image-1')
    const imageInteractionOverlay = document.createElement('div')
    imageInteractionOverlay.setAttribute('data-canvas-item-id', 'image-1')
    imageInteractionOverlay.setAttribute('data-canvas-overlay', 'image-interaction')
    canvasContainer.appendChild(staleOverlay)
    canvasContainer.appendChild(imageInteractionOverlay)

    mockCanvasContainerRect(canvasContainer)
    mockElementRect(staleOverlay, {
      left: 40,
      top: 50,
      width: 24,
      height: 24
    })
    mockElementRect(imageInteractionOverlay, {
      left: 520,
      top: 360,
      width: 96,
      height: 96
    })

    const stage = {
      findOne: vi.fn(() => null)
    }
    const stageRef = {
      current: {
        getStage: () => stage
      }
    } as unknown as React.RefObject<KonvaStage | null>

    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPageSelectionOverlays
          tool="select"
          selectionOverlayGroups={[]}
          exactSelectedGroup={null}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          stageSize={{ width: 800, height: 600 }}
          selectedIds={new Set(['image-1'])}
          items={[createImageItem()]}
          stageRef={stageRef}
          canvasContainerRef={{ current: canvasContainer }}
          lastClickedId="image-1"
          mediaCaptionActionLabel="Edit caption"
          legacySelectionToolbarEnabled={false}
          groupCreateLabel="Group"
          handleFocusGroup={vi.fn()}
          buildCanvasDragPayload={vi.fn((): CanvasDragPayload => ({ sourceCanvasId: 'canvas-1' }))}
          setCanvasDragPayload={vi.fn()}
          handleFlipImage={vi.fn()}
          handleCropImage={vi.fn()}
          handleExtractImage={vi.fn()}
          handleCopyCanvasImage={vi.fn()}
          handleDownloadCanvasImage={vi.fn()}
          handleOpenAgentSendMenu={vi.fn()}
          handleOpenMediaCaptionEditor={vi.fn()}
          handleSendCanvasItemsToAgent={vi.fn()}
          handleToggleVideoPlayback={vi.fn()}
          handleOpenModel3DViewer={vi.fn()}
          handleOpenDccExportMenu={vi.fn()}
          handleDownloadBlobItem={vi.fn()}
          handleCopyCanvasItemsAsImage={vi.fn()}
          handleDownloadCanvasItemsAsImage={vi.fn()}
          getQuickCanvasItemsImageUrl={vi.fn(() => null)}
          prepareQuickCanvasItemsImageUrl={vi.fn(async () => null)}
          handleGenerateCanvasItems={vi.fn()}
          handleCreateGroup={vi.fn()}
          Model3DIcon={() => null}
          ExportIcon={() => null}
        />
      </ThemeProvider>
    )

    const toolbar = await waitFor(() => {
      const element = canvasContainer.querySelector('.image-action-toolbar') as HTMLElement | null
      expect(element).toBeTruthy()
      return element as HTMLElement
    })

    expect(parseFloat(getComputedStyle(toolbar).left)).toBeGreaterThan(500)
    expect(parseFloat(getComputedStyle(toolbar).top)).toBeGreaterThan(250)

    canvasContainer.remove()
  })

  it('keeps the single-image toolbar in sync with live viewport callbacks', async () => {
    let viewportCallback: ((pos: { x: number; y: number }, scale: number) => void) | null = null
    const registerViewportCallback = vi.fn(
      (callback: (pos: { x: number; y: number }, scale: number) => void) => {
        viewportCallback = callback
        return vi.fn()
      }
    )

    const canvasContainer = document.createElement('div')
    Object.defineProperty(canvasContainer, 'clientWidth', {
      configurable: true,
      value: 800
    })
    Object.defineProperty(canvasContainer, 'clientHeight', {
      configurable: true,
      value: 600
    })
    document.body.appendChild(canvasContainer)
    mockCanvasContainerRect(canvasContainer)

    const imageInteractionOverlay = document.createElement('div')
    imageInteractionOverlay.setAttribute('data-canvas-item-id', 'image-1')
    imageInteractionOverlay.setAttribute('data-canvas-overlay', 'image-interaction')
    canvasContainer.appendChild(imageInteractionOverlay)

    let overlayRect = {
      left: 220,
      top: 180,
      width: 96,
      height: 96
    }
    Object.defineProperty(imageInteractionOverlay, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: overlayRect.left,
        top: overlayRect.top,
        right: overlayRect.left + overlayRect.width,
        bottom: overlayRect.top + overlayRect.height,
        width: overlayRect.width,
        height: overlayRect.height,
        x: overlayRect.left,
        y: overlayRect.top,
        toJSON: () => ({})
      })
    })

    const stageRef = {
      current: {
        getStage: () => null
      }
    } as unknown as React.RefObject<KonvaStage | null>

    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPageSelectionOverlays
          tool="select"
          selectionOverlayGroups={[]}
          exactSelectedGroup={null}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          stageSize={{ width: 800, height: 600 }}
          selectedIds={new Set(['image-1'])}
          items={[createImageItem()]}
          stageRef={stageRef}
          canvasContainerRef={{ current: canvasContainer }}
          canvasContainerElement={canvasContainer}
          registerViewportCallback={registerViewportCallback}
          lastClickedId="image-1"
          mediaCaptionActionLabel="Edit caption"
          legacySelectionToolbarEnabled={false}
          groupCreateLabel="Group"
          handleFocusGroup={vi.fn()}
          buildCanvasDragPayload={vi.fn((): CanvasDragPayload => ({ sourceCanvasId: 'canvas-1' }))}
          setCanvasDragPayload={vi.fn()}
          handleFlipImage={vi.fn()}
          handleCropImage={vi.fn()}
          handleExtractImage={vi.fn()}
          handleCopyCanvasImage={vi.fn()}
          handleDownloadCanvasImage={vi.fn()}
          handleOpenAgentSendMenu={vi.fn()}
          handleOpenMediaCaptionEditor={vi.fn()}
          handleSendCanvasItemsToAgent={vi.fn()}
          handleToggleVideoPlayback={vi.fn()}
          handleOpenModel3DViewer={vi.fn()}
          handleOpenDccExportMenu={vi.fn()}
          handleDownloadBlobItem={vi.fn()}
          handleCopyCanvasItemsAsImage={vi.fn()}
          handleDownloadCanvasItemsAsImage={vi.fn()}
          getQuickCanvasItemsImageUrl={vi.fn(() => null)}
          prepareQuickCanvasItemsImageUrl={vi.fn(async () => null)}
          handleGenerateCanvasItems={vi.fn()}
          handleCreateGroup={vi.fn()}
          Model3DIcon={() => null}
          ExportIcon={() => null}
        />
      </ThemeProvider>
    )

    const toolbar = await waitFor(() => {
      const element = canvasContainer.querySelector('.image-action-toolbar') as HTMLElement | null
      expect(element).toBeTruthy()
      return element as HTMLElement
    })

    await waitFor(() => {
      expect(registerViewportCallback).toHaveBeenCalledTimes(1)
      expect(viewportCallback).toBeTypeOf('function')
    })

    const initialLeft = parseFloat(getComputedStyle(toolbar).left)
    const initialTop = parseFloat(getComputedStyle(toolbar).top)

    overlayRect = {
      left: 520,
      top: 300,
      width: 96,
      height: 96
    }

    act(() => {
      viewportCallback?.({ x: 120, y: 80 }, 1.5)
    })

    expect(parseFloat(getComputedStyle(toolbar).left)).toBeGreaterThan(initialLeft + 100)
    expect(parseFloat(getComputedStyle(toolbar).top)).toBeGreaterThan(initialTop + 50)

    canvasContainer.remove()
  })

  it('defers selection toolbar viewport sync while wheel interaction is active', async () => {
    let viewportCallback: ((pos: { x: number; y: number }, scale: number) => void) | null = null
    let interactionCallback: ((active: boolean) => void) | null = null
    const registerViewportCallback = vi.fn(
      (callback: (pos: { x: number; y: number }, scale: number) => void) => {
        viewportCallback = callback
        return vi.fn()
      }
    )
    const registerViewportInteractionCallback = vi.fn((callback: (active: boolean) => void) => {
      interactionCallback = callback
      callback(false)
      return vi.fn()
    })

    const canvasContainer = document.createElement('div')
    Object.defineProperty(canvasContainer, 'clientWidth', {
      configurable: true,
      value: 800
    })
    Object.defineProperty(canvasContainer, 'clientHeight', {
      configurable: true,
      value: 600
    })
    document.body.appendChild(canvasContainer)
    mockCanvasContainerRect(canvasContainer)

    const imageInteractionOverlay = document.createElement('div')
    imageInteractionOverlay.setAttribute('data-canvas-item-id', 'image-1')
    imageInteractionOverlay.setAttribute('data-canvas-overlay', 'image-interaction')
    canvasContainer.appendChild(imageInteractionOverlay)

    let overlayRect = {
      left: 220,
      top: 180,
      width: 96,
      height: 96
    }
    Object.defineProperty(imageInteractionOverlay, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: overlayRect.left,
        top: overlayRect.top,
        right: overlayRect.left + overlayRect.width,
        bottom: overlayRect.top + overlayRect.height,
        width: overlayRect.width,
        height: overlayRect.height,
        x: overlayRect.left,
        y: overlayRect.top,
        toJSON: () => ({})
      })
    })

    const stageRef = {
      current: {
        getStage: () => null
      }
    } as unknown as React.RefObject<KonvaStage | null>

    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPageSelectionOverlays
          tool="select"
          selectionOverlayGroups={[]}
          exactSelectedGroup={null}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          stageSize={{ width: 800, height: 600 }}
          selectedIds={new Set(['image-1'])}
          items={[createImageItem()]}
          stageRef={stageRef}
          canvasContainerRef={{ current: canvasContainer }}
          canvasContainerElement={canvasContainer}
          registerViewportCallback={registerViewportCallback}
          registerViewportInteractionCallback={registerViewportInteractionCallback}
          lastClickedId="image-1"
          mediaCaptionActionLabel="Edit caption"
          legacySelectionToolbarEnabled={false}
          groupCreateLabel="Group"
          handleFocusGroup={vi.fn()}
          buildCanvasDragPayload={vi.fn((): CanvasDragPayload => ({ sourceCanvasId: 'canvas-1' }))}
          setCanvasDragPayload={vi.fn()}
          handleFlipImage={vi.fn()}
          handleCropImage={vi.fn()}
          handleExtractImage={vi.fn()}
          handleCopyCanvasImage={vi.fn()}
          handleDownloadCanvasImage={vi.fn()}
          handleOpenAgentSendMenu={vi.fn()}
          handleOpenMediaCaptionEditor={vi.fn()}
          handleSendCanvasItemsToAgent={vi.fn()}
          handleToggleVideoPlayback={vi.fn()}
          handleOpenModel3DViewer={vi.fn()}
          handleOpenDccExportMenu={vi.fn()}
          handleDownloadBlobItem={vi.fn()}
          handleCopyCanvasItemsAsImage={vi.fn()}
          handleDownloadCanvasItemsAsImage={vi.fn()}
          getQuickCanvasItemsImageUrl={vi.fn(() => null)}
          prepareQuickCanvasItemsImageUrl={vi.fn(async () => null)}
          handleGenerateCanvasItems={vi.fn()}
          handleCreateGroup={vi.fn()}
          Model3DIcon={() => null}
          ExportIcon={() => null}
        />
      </ThemeProvider>
    )

    const toolbar = await waitFor(() => {
      const element = canvasContainer.querySelector('.image-action-toolbar') as HTMLElement | null
      expect(element).toBeTruthy()
      return element as HTMLElement
    })

    await waitFor(() => {
      expect(viewportCallback).toBeTypeOf('function')
      expect(interactionCallback).toBeTypeOf('function')
    })

    const initialLeft = parseFloat(getComputedStyle(toolbar).left)

    act(() => {
      interactionCallback?.(true)
    })
    overlayRect = {
      left: 520,
      top: 300,
      width: 96,
      height: 96
    }
    act(() => {
      viewportCallback?.({ x: 120, y: 80 }, 1.5)
    })

    expect(parseFloat(getComputedStyle(toolbar).left)).toBeCloseTo(initialLeft)

    act(() => {
      interactionCallback?.(false)
    })

    await waitFor(() => {
      expect(parseFloat(getComputedStyle(toolbar).left)).toBeGreaterThan(initialLeft + 100)
    })

    canvasContainer.remove()
  })

  it('re-syncs the image toolbar on the next animation frame when the interaction overlay mounts after the first measurement', async () => {
    let queuedAnimationFrame: FrameRequestCallback | null = null
    const requestAnimationFrameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback) => {
        queuedAnimationFrame = callback
        return 1
      })
    const cancelAnimationFrameSpy = vi
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation(() => {})

    const canvasContainer = document.createElement('div')
    Object.defineProperty(canvasContainer, 'clientWidth', {
      configurable: true,
      value: 800
    })
    Object.defineProperty(canvasContainer, 'clientHeight', {
      configurable: true,
      value: 600
    })
    document.body.appendChild(canvasContainer)
    mockCanvasContainerRect(canvasContainer)

    const stage = {
      findOne: vi.fn(() => null)
    }
    const stageRef = {
      current: {
        getStage: () => stage
      }
    } as unknown as React.RefObject<KonvaStage | null>

    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPageSelectionOverlays
          tool="select"
          selectionOverlayGroups={[]}
          exactSelectedGroup={null}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          stageSize={{ width: 800, height: 600 }}
          selectedIds={new Set(['image-1'])}
          items={[createImageItem()]}
          stageRef={stageRef}
          canvasContainerRef={{ current: canvasContainer }}
          lastClickedId="image-1"
          mediaCaptionActionLabel="Edit caption"
          legacySelectionToolbarEnabled={false}
          groupCreateLabel="Group"
          handleFocusGroup={vi.fn()}
          buildCanvasDragPayload={vi.fn((): CanvasDragPayload => ({ sourceCanvasId: 'canvas-1' }))}
          setCanvasDragPayload={vi.fn()}
          handleFlipImage={vi.fn()}
          handleCropImage={vi.fn()}
          handleExtractImage={vi.fn()}
          handleCopyCanvasImage={vi.fn()}
          handleDownloadCanvasImage={vi.fn()}
          handleOpenAgentSendMenu={vi.fn()}
          handleOpenMediaCaptionEditor={vi.fn()}
          handleSendCanvasItemsToAgent={vi.fn()}
          handleToggleVideoPlayback={vi.fn()}
          handleOpenModel3DViewer={vi.fn()}
          handleOpenDccExportMenu={vi.fn()}
          handleDownloadBlobItem={vi.fn()}
          handleCopyCanvasItemsAsImage={vi.fn()}
          handleDownloadCanvasItemsAsImage={vi.fn()}
          getQuickCanvasItemsImageUrl={vi.fn(() => null)}
          prepareQuickCanvasItemsImageUrl={vi.fn(async () => null)}
          handleGenerateCanvasItems={vi.fn()}
          handleCreateGroup={vi.fn()}
          Model3DIcon={() => null}
          ExportIcon={() => null}
        />
      </ThemeProvider>
    )

    const toolbar = await waitFor(() => {
      const element = canvasContainer.querySelector('.image-action-toolbar') as HTMLElement | null
      expect(element).toBeTruthy()
      return element as HTMLElement
    })

    const mountedOverlay = document.createElement('div')
    mountedOverlay.setAttribute('data-canvas-item-id', 'image-1')
    mountedOverlay.setAttribute('data-canvas-overlay', 'image-interaction')
    canvasContainer.appendChild(mountedOverlay)
    mockElementRect(mountedOverlay, {
      left: 520,
      top: 360,
      width: 96,
      height: 96
    })

    expect(queuedAnimationFrame).not.toBeNull()

    await act(async () => {
      queuedAnimationFrame?.(16)
    })

    expect(parseFloat(getComputedStyle(toolbar).left)).toBeGreaterThan(500)
    expect(parseFloat(getComputedStyle(toolbar).top)).toBeGreaterThan(250)

    requestAnimationFrameSpy.mockRestore()
    cancelAnimationFrameSpy.mockRestore()
    canvasContainer.remove()
  })

  it('falls back to item geometry when the live stage node is unavailable', async () => {
    const canvasContainer = document.createElement('div')
    Object.defineProperty(canvasContainer, 'clientWidth', {
      configurable: true,
      value: 800
    })
    Object.defineProperty(canvasContainer, 'clientHeight', {
      configurable: true,
      value: 600
    })
    document.body.appendChild(canvasContainer)

    const stage = {
      findOne: vi.fn(() => null)
    }
    const stageRef = {
      current: {
        getStage: () => stage
      }
    } as unknown as React.RefObject<KonvaStage | null>

    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPageSelectionOverlays
          tool="select"
          selectionOverlayGroups={[]}
          exactSelectedGroup={null}
          stagePos={{ x: 10, y: 20 }}
          stageScale={2}
          stageSize={{ width: 800, height: 600 }}
          selectedIds={new Set(['image-1'])}
          items={[createImageItem()]}
          stageRef={stageRef}
          canvasContainerRef={{ current: canvasContainer }}
          lastClickedId="image-1"
          mediaCaptionActionLabel="Edit caption"
          legacySelectionToolbarEnabled={false}
          groupCreateLabel="Group"
          handleFocusGroup={vi.fn()}
          buildCanvasDragPayload={vi.fn((): CanvasDragPayload => ({ sourceCanvasId: 'canvas-1' }))}
          setCanvasDragPayload={vi.fn()}
          handleFlipImage={vi.fn()}
          handleCropImage={vi.fn()}
          handleCopyCanvasImage={vi.fn()}
          handleDownloadCanvasImage={vi.fn()}
          handleOpenAgentSendMenu={vi.fn()}
          handleOpenMediaCaptionEditor={vi.fn()}
          handleSendCanvasItemsToAgent={vi.fn()}
          handleToggleVideoPlayback={vi.fn()}
          handleOpenModel3DViewer={vi.fn()}
          handleOpenDccExportMenu={vi.fn()}
          handleDownloadBlobItem={vi.fn()}
          handleCopyCanvasItemsAsImage={vi.fn()}
          handleDownloadCanvasItemsAsImage={vi.fn()}
          getQuickCanvasItemsImageUrl={vi.fn(() => null)}
          prepareQuickCanvasItemsImageUrl={vi.fn(async () => null)}
          handleGenerateCanvasItems={vi.fn()}
          handleCreateGroup={vi.fn()}
          Model3DIcon={() => null}
          ExportIcon={() => null}
        />
      </ThemeProvider>
    )

    await waitFor(() => {
      const toolbar = canvasContainer.querySelector('.image-action-toolbar') as HTMLElement | null
      expect(toolbar).toBeTruthy()
      expect(
        within(toolbar as HTMLElement).getByLabelText('\u62d6\u62fd\u63d0\u53d6\u8d44\u6e90')
      ).toBeInTheDocument()
      expect(within(toolbar as HTMLElement).getByLabelText('复制该图片')).toBeInTheDocument()
    })

    expect(stage.findOne).toHaveBeenCalledWith('#image-1')

    canvasContainer.remove()
  })

  it('shows readable Chinese tooltip copy for image flip and crop actions', async () => {
    const canvasContainer = document.createElement('div')
    Object.defineProperty(canvasContainer, 'clientWidth', {
      configurable: true,
      value: 800
    })
    Object.defineProperty(canvasContainer, 'clientHeight', {
      configurable: true,
      value: 600
    })
    document.body.appendChild(canvasContainer)

    const stage = {
      findOne: vi.fn(() => ({
        getClientRect: () => ({
          x: 120,
          y: 180,
          width: 96,
          height: 96
        })
      }))
    }
    const stageRef = {
      current: {
        getStage: () => stage
      }
    } as unknown as React.RefObject<KonvaStage | null>

    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPageSelectionOverlays
          tool="select"
          selectionOverlayGroups={[]}
          exactSelectedGroup={null}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          stageSize={{ width: 800, height: 600 }}
          selectedIds={new Set(['image-1'])}
          items={[createImageItem()]}
          stageRef={stageRef}
          canvasContainerRef={{ current: canvasContainer }}
          lastClickedId="image-1"
          mediaCaptionActionLabel="Edit caption"
          legacySelectionToolbarEnabled={false}
          groupCreateLabel="Group"
          handleFocusGroup={vi.fn()}
          buildCanvasDragPayload={vi.fn((): CanvasDragPayload => ({ sourceCanvasId: 'canvas-1' }))}
          setCanvasDragPayload={vi.fn()}
          handleFlipImage={vi.fn()}
          handleCropImage={vi.fn()}
          handleCopyCanvasImage={vi.fn()}
          handleDownloadCanvasImage={vi.fn()}
          handleOpenAgentSendMenu={vi.fn()}
          handleOpenMediaCaptionEditor={vi.fn()}
          handleSendCanvasItemsToAgent={vi.fn()}
          handleToggleVideoPlayback={vi.fn()}
          handleOpenModel3DViewer={vi.fn()}
          handleOpenDccExportMenu={vi.fn()}
          handleDownloadBlobItem={vi.fn()}
          handleCopyCanvasItemsAsImage={vi.fn()}
          handleDownloadCanvasItemsAsImage={vi.fn()}
          getQuickCanvasItemsImageUrl={vi.fn(() => null)}
          prepareQuickCanvasItemsImageUrl={vi.fn(async () => null)}
          handleGenerateCanvasItems={vi.fn()}
          handleCreateGroup={vi.fn()}
          Model3DIcon={() => null}
          ExportIcon={() => null}
        />
      </ThemeProvider>
    )

    await waitFor(() => {
      expect(canvasContainer.querySelector('.image-action-toolbar')).toBeTruthy()
    })

    const flipButton = canvasContainer.querySelector(
      '.canvas-image-flip-button'
    ) as HTMLButtonElement | null
    const cropButton = canvasContainer.querySelector(
      '.canvas-image-crop-button'
    ) as HTMLButtonElement | null

    expect(flipButton).toBeTruthy()
    expect(cropButton).toBeTruthy()

    fireEvent.mouseOver(flipButton as HTMLButtonElement)
    expect(await screen.findByText('水平翻转图片')).toBeInTheDocument()

    fireEvent.mouseLeave(flipButton as HTMLButtonElement)
    fireEvent.mouseOver(cropButton as HTMLButtonElement)
    expect(await screen.findByText('裁剪图片')).toBeInTheDocument()

    canvasContainer.remove()
  })

  it('shows a play affordance for selected videos downgraded out of active-playing budget', async () => {
    const canvasContainer = document.createElement('div')
    Object.defineProperty(canvasContainer, 'clientWidth', {
      configurable: true,
      value: 800
    })
    Object.defineProperty(canvasContainer, 'clientHeight', {
      configurable: true,
      value: 600
    })
    document.body.appendChild(canvasContainer)

    const stage = {
      findOne: vi.fn(() => ({
        getClientRect: () => ({
          x: 120,
          y: 180,
          width: 160,
          height: 90
        })
      }))
    }
    const handleToggleVideoPlayback = vi.fn()
    const stageRef = {
      current: {
        getStage: () => stage
      }
    } as unknown as React.RefObject<KonvaStage | null>
    const videoItem = createVideoItem()

    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPageSelectionOverlays
          tool="select"
          selectionOverlayGroups={[]}
          exactSelectedGroup={null}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          stageSize={{ width: 800, height: 600 }}
          selectedIds={new Set(['video-1'])}
          items={[videoItem]}
          stageRef={stageRef}
          canvasContainerRef={{ current: canvasContainer }}
          lastClickedId="video-1"
          mediaCaptionActionLabel="Edit caption"
          legacySelectionToolbarEnabled={false}
          groupCreateLabel="Group"
          handleFocusGroup={vi.fn()}
          buildCanvasDragPayload={vi.fn((): CanvasDragPayload => ({ sourceCanvasId: 'canvas-1' }))}
          setCanvasDragPayload={vi.fn()}
          handleFlipImage={vi.fn()}
          handleCropImage={vi.fn()}
          handleCopyCanvasImage={vi.fn()}
          handleDownloadCanvasImage={vi.fn()}
          handleOpenAgentSendMenu={vi.fn()}
          handleOpenMediaCaptionEditor={vi.fn()}
          handleSendCanvasItemsToAgent={vi.fn()}
          handleToggleVideoPlayback={handleToggleVideoPlayback}
          resolvedVideoBudgetModeById={new Map([[videoItem.id, 'visible-paused']])}
          handleOpenModel3DViewer={vi.fn()}
          handleOpenDccExportMenu={vi.fn()}
          handleDownloadBlobItem={vi.fn()}
          handleCopyCanvasItemsAsImage={vi.fn()}
          handleDownloadCanvasItemsAsImage={vi.fn()}
          getQuickCanvasItemsImageUrl={vi.fn(() => null)}
          prepareQuickCanvasItemsImageUrl={vi.fn(async () => null)}
          handleGenerateCanvasItems={vi.fn()}
          handleCreateGroup={vi.fn()}
          Model3DIcon={() => null}
          ExportIcon={() => null}
        />
      </ThemeProvider>
    )

    const toolbar = await waitFor(() => {
      const el = canvasContainer.querySelector('.blob-item-action-toolbar') as HTMLElement | null
      expect(el).toBeTruthy()
      return el as HTMLElement
    })

    const playButton = within(toolbar).getByLabelText('播放视频')
    expect(playButton).toBeInTheDocument()
    expect(within(toolbar).queryByLabelText('暂停播放')).toBeNull()

    fireEvent.click(playButton)
    expect(handleToggleVideoPlayback).toHaveBeenCalledWith(videoItem, true)

    canvasContainer.remove()
  })

  it('mounts into the canvas container after the ref becomes available on a later render', async () => {
    const canvasContainer = document.createElement('div')
    Object.defineProperty(canvasContainer, 'clientWidth', {
      configurable: true,
      value: 800
    })
    Object.defineProperty(canvasContainer, 'clientHeight', {
      configurable: true,
      value: 600
    })
    document.body.appendChild(canvasContainer)

    const stage = {
      findOne: vi.fn(() => null)
    }
    const stageRef = {
      current: {
        getStage: () => stage
      }
    } as unknown as React.RefObject<KonvaStage | null>
    const canvasContainerRef = { current: null as HTMLDivElement | null }

    const renderResult = render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPageSelectionOverlays
          tool="select"
          selectionOverlayGroups={[]}
          exactSelectedGroup={null}
          stagePos={{ x: 10, y: 20 }}
          stageScale={2}
          stageSize={{ width: 800, height: 600 }}
          selectedIds={new Set(['image-1'])}
          items={[createImageItem()]}
          stageRef={stageRef}
          canvasContainerRef={canvasContainerRef}
          lastClickedId="image-1"
          mediaCaptionActionLabel="Edit caption"
          legacySelectionToolbarEnabled={false}
          groupCreateLabel="Group"
          handleFocusGroup={vi.fn()}
          buildCanvasDragPayload={vi.fn((): CanvasDragPayload => ({ sourceCanvasId: 'canvas-1' }))}
          setCanvasDragPayload={vi.fn()}
          handleFlipImage={vi.fn()}
          handleCropImage={vi.fn()}
          handleCopyCanvasImage={vi.fn()}
          handleDownloadCanvasImage={vi.fn()}
          handleOpenAgentSendMenu={vi.fn()}
          handleOpenMediaCaptionEditor={vi.fn()}
          handleSendCanvasItemsToAgent={vi.fn()}
          handleToggleVideoPlayback={vi.fn()}
          handleOpenModel3DViewer={vi.fn()}
          handleOpenDccExportMenu={vi.fn()}
          handleDownloadBlobItem={vi.fn()}
          handleCopyCanvasItemsAsImage={vi.fn()}
          handleDownloadCanvasItemsAsImage={vi.fn()}
          getQuickCanvasItemsImageUrl={vi.fn(() => null)}
          prepareQuickCanvasItemsImageUrl={vi.fn(async () => null)}
          handleGenerateCanvasItems={vi.fn()}
          handleCreateGroup={vi.fn()}
          Model3DIcon={() => null}
          ExportIcon={() => null}
        />
      </ThemeProvider>
    )

    expect(canvasContainer.querySelector('.image-action-toolbar')).toBeNull()

    canvasContainerRef.current = canvasContainer
    renderResult.rerender(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPageSelectionOverlays
          tool="select"
          selectionOverlayGroups={[]}
          exactSelectedGroup={null}
          stagePos={{ x: 10, y: 20 }}
          stageScale={2}
          stageSize={{ width: 800, height: 600 }}
          selectedIds={new Set(['image-1'])}
          items={[createImageItem()]}
          stageRef={stageRef}
          canvasContainerRef={canvasContainerRef}
          lastClickedId="image-1"
          mediaCaptionActionLabel="Edit caption"
          legacySelectionToolbarEnabled={false}
          groupCreateLabel="Group"
          handleFocusGroup={vi.fn()}
          buildCanvasDragPayload={vi.fn((): CanvasDragPayload => ({ sourceCanvasId: 'canvas-1' }))}
          setCanvasDragPayload={vi.fn()}
          handleFlipImage={vi.fn()}
          handleCropImage={vi.fn()}
          handleCopyCanvasImage={vi.fn()}
          handleDownloadCanvasImage={vi.fn()}
          handleOpenAgentSendMenu={vi.fn()}
          handleOpenMediaCaptionEditor={vi.fn()}
          handleSendCanvasItemsToAgent={vi.fn()}
          handleToggleVideoPlayback={vi.fn()}
          handleOpenModel3DViewer={vi.fn()}
          handleOpenDccExportMenu={vi.fn()}
          handleDownloadBlobItem={vi.fn()}
          handleCopyCanvasItemsAsImage={vi.fn()}
          handleDownloadCanvasItemsAsImage={vi.fn()}
          getQuickCanvasItemsImageUrl={vi.fn(() => null)}
          prepareQuickCanvasItemsImageUrl={vi.fn(async () => null)}
          handleGenerateCanvasItems={vi.fn()}
          handleCreateGroup={vi.fn()}
          Model3DIcon={() => null}
          ExportIcon={() => null}
        />
      </ThemeProvider>
    )

    await waitFor(() => {
      expect(canvasContainer.querySelector('.image-action-toolbar')).toBeTruthy()
    })

    canvasContainer.remove()
  })

  it('prepares and reuses a cached quick drag preview for text selections', async () => {
    const canvasContainer = document.createElement('div')
    Object.defineProperty(canvasContainer, 'clientWidth', {
      configurable: true,
      value: 800
    })
    Object.defineProperty(canvasContainer, 'clientHeight', {
      configurable: true,
      value: 600
    })
    document.body.appendChild(canvasContainer)

    const stage = {
      findOne: vi.fn(() => null)
    }
    const stageRef = {
      current: {
        getStage: () => stage
      }
    } as unknown as React.RefObject<KonvaStage | null>
    const buildCanvasDragPayload = vi.fn(
      (): CanvasDragPayload => ({
        sourceCanvasId: 'canvas-1'
      })
    )
    const setCanvasDragPayload = vi.fn()
    const prepareQuickCanvasItemsImageUrl = vi.fn(async () => 'blob:preview-text')
    const getQuickCanvasItemsImageUrl = vi.fn(() => 'blob:preview-text')

    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPageSelectionOverlays
          tool="select"
          selectionOverlayGroups={[]}
          exactSelectedGroup={null}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          stageSize={{ width: 800, height: 600 }}
          selectedIds={new Set(['text-1'])}
          items={[createTextItem()]}
          stageRef={stageRef}
          canvasContainerRef={{ current: canvasContainer }}
          lastClickedId="text-1"
          mediaCaptionActionLabel="Edit caption"
          legacySelectionToolbarEnabled={false}
          groupCreateLabel="Group"
          handleFocusGroup={vi.fn()}
          buildCanvasDragPayload={buildCanvasDragPayload}
          setCanvasDragPayload={setCanvasDragPayload}
          handleFlipImage={vi.fn()}
          handleCropImage={vi.fn()}
          handleCopyCanvasImage={vi.fn()}
          handleDownloadCanvasImage={vi.fn()}
          handleOpenAgentSendMenu={vi.fn()}
          handleOpenMediaCaptionEditor={vi.fn()}
          handleSendCanvasItemsToAgent={vi.fn()}
          handleToggleVideoPlayback={vi.fn()}
          handleOpenModel3DViewer={vi.fn()}
          handleOpenDccExportMenu={vi.fn()}
          handleDownloadBlobItem={vi.fn()}
          handleCopyCanvasItemsAsImage={vi.fn()}
          handleDownloadCanvasItemsAsImage={vi.fn()}
          getQuickCanvasItemsImageUrl={getQuickCanvasItemsImageUrl}
          prepareQuickCanvasItemsImageUrl={prepareQuickCanvasItemsImageUrl}
          handleGenerateCanvasItems={vi.fn()}
          handleCreateGroup={vi.fn()}
          Model3DIcon={() => null}
          ExportIcon={() => null}
        />
      </ThemeProvider>
    )

    await waitFor(() => {
      expect(prepareQuickCanvasItemsImageUrl).toHaveBeenCalledWith([
        expect.objectContaining({ id: 'text-1' })
      ])
    })

    const dragButton = canvasContainer.querySelector(
      '.textlike-action-toolbar button[draggable="true"]'
    ) as HTMLButtonElement | null
    expect(dragButton).toBeTruthy()

    const dataTransfer = {
      setData: vi.fn(),
      effectAllowed: 'all'
    } as unknown as DataTransfer

    fireEvent.dragStart(dragButton as HTMLButtonElement, { dataTransfer })

    expect(buildCanvasDragPayload).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'text-1' })],
      expect.objectContaining({
        objectUrl: 'blob:preview-text',
        previewImageUrl: 'blob:preview-text'
      })
    )
    expect(setCanvasDragPayload).toHaveBeenCalled()

    canvasContainer.remove()
  })

  it('starts text selection drags even before the preview image is cached', async () => {
    const canvasContainer = document.createElement('div')
    Object.defineProperty(canvasContainer, 'clientWidth', {
      configurable: true,
      value: 800
    })
    Object.defineProperty(canvasContainer, 'clientHeight', {
      configurable: true,
      value: 600
    })
    document.body.appendChild(canvasContainer)

    const stage = {
      findOne: vi.fn(() => null)
    }
    const stageRef = {
      current: {
        getStage: () => stage
      }
    } as unknown as React.RefObject<KonvaStage | null>
    const textDragPayload: CanvasDragPayload = {
      sourceCanvasId: 'canvas-1',
      textContent: 'Canvas text'
    }
    const buildCanvasDragPayload = vi.fn(() => textDragPayload)
    const setCanvasDragPayload = vi.fn()

    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPageSelectionOverlays
          tool="select"
          selectionOverlayGroups={[]}
          exactSelectedGroup={null}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          stageSize={{ width: 800, height: 600 }}
          selectedIds={new Set(['text-1'])}
          items={[createTextItem()]}
          stageRef={stageRef}
          canvasContainerRef={{ current: canvasContainer }}
          lastClickedId="text-1"
          mediaCaptionActionLabel="Edit caption"
          legacySelectionToolbarEnabled={false}
          groupCreateLabel="Group"
          handleFocusGroup={vi.fn()}
          buildCanvasDragPayload={buildCanvasDragPayload}
          setCanvasDragPayload={setCanvasDragPayload}
          handleFlipImage={vi.fn()}
          handleCropImage={vi.fn()}
          handleCopyCanvasImage={vi.fn()}
          handleDownloadCanvasImage={vi.fn()}
          handleOpenAgentSendMenu={vi.fn()}
          handleOpenMediaCaptionEditor={vi.fn()}
          handleSendCanvasItemsToAgent={vi.fn()}
          handleToggleVideoPlayback={vi.fn()}
          handleOpenModel3DViewer={vi.fn()}
          handleOpenDccExportMenu={vi.fn()}
          handleDownloadBlobItem={vi.fn()}
          handleCopyCanvasItemsAsImage={vi.fn()}
          handleDownloadCanvasItemsAsImage={vi.fn()}
          getQuickCanvasItemsImageUrl={vi.fn(() => null)}
          prepareQuickCanvasItemsImageUrl={vi.fn(async () => null)}
          handleGenerateCanvasItems={vi.fn()}
          handleCreateGroup={vi.fn()}
          Model3DIcon={() => null}
          ExportIcon={() => null}
        />
      </ThemeProvider>
    )

    const dragButton = await waitFor(() => {
      const button = canvasContainer.querySelector(
        '.textlike-action-toolbar button[draggable="true"]'
      ) as HTMLButtonElement | null
      expect(button).toBeTruthy()
      return button as HTMLButtonElement
    })

    const dataTransfer = {
      setData: vi.fn(),
      effectAllowed: 'all'
    } as unknown as DataTransfer

    const canvasMouseDown = vi.fn()
    canvasContainer.addEventListener('mousedown', canvasMouseDown)

    fireEvent.mouseDown(dragButton, { button: 0 })
    fireEvent.dragStart(dragButton, { dataTransfer })

    expect(canvasMouseDown).not.toHaveBeenCalled()
    expect(buildCanvasDragPayload).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'text-1' })],
      {}
    )
    expect(setCanvasDragPayload).toHaveBeenCalledWith(dataTransfer, textDragPayload)

    canvasContainer.remove()
  })

  it('positions the text toolbar below the selected text element', async () => {
    const canvasContainer = document.createElement('div')
    Object.defineProperty(canvasContainer, 'clientWidth', {
      configurable: true,
      value: 800
    })
    Object.defineProperty(canvasContainer, 'clientHeight', {
      configurable: true,
      value: 600
    })
    document.body.appendChild(canvasContainer)

    const stage = {
      findOne: vi.fn(() => null)
    }
    const stageRef = {
      current: {
        getStage: () => stage
      }
    } as unknown as React.RefObject<KonvaStage | null>

    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPageSelectionOverlays
          tool="select"
          selectionOverlayGroups={[]}
          exactSelectedGroup={null}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          stageSize={{ width: 800, height: 600 }}
          selectedIds={new Set(['text-1'])}
          items={[createTextItem()]}
          stageRef={stageRef}
          canvasContainerRef={{ current: canvasContainer }}
          lastClickedId="text-1"
          mediaCaptionActionLabel="Edit caption"
          legacySelectionToolbarEnabled={false}
          groupCreateLabel="Group"
          handleFocusGroup={vi.fn()}
          buildCanvasDragPayload={vi.fn((): CanvasDragPayload => ({ sourceCanvasId: 'canvas-1' }))}
          setCanvasDragPayload={vi.fn()}
          handleFlipImage={vi.fn()}
          handleCropImage={vi.fn()}
          handleCopyCanvasImage={vi.fn()}
          handleDownloadCanvasImage={vi.fn()}
          handleOpenAgentSendMenu={vi.fn()}
          handleOpenMediaCaptionEditor={vi.fn()}
          handleSendCanvasItemsToAgent={vi.fn()}
          handleToggleVideoPlayback={vi.fn()}
          handleOpenModel3DViewer={vi.fn()}
          handleOpenDccExportMenu={vi.fn()}
          handleDownloadBlobItem={vi.fn()}
          handleCopyCanvasItemsAsImage={vi.fn()}
          handleDownloadCanvasItemsAsImage={vi.fn()}
          getQuickCanvasItemsImageUrl={vi.fn(() => null)}
          prepareQuickCanvasItemsImageUrl={vi.fn(async () => null)}
          handleGenerateCanvasItems={vi.fn()}
          handleCreateGroup={vi.fn()}
          Model3DIcon={() => null}
          ExportIcon={() => null}
        />
      </ThemeProvider>
    )

    await waitFor(() => {
      expect(canvasContainer.querySelector('.textlike-action-toolbar')).toBeTruthy()
    })

    const toolbar = canvasContainer.querySelector('.textlike-action-toolbar') as HTMLElement | null
    expect(toolbar).toBeTruthy()
    expect(parseFloat(getComputedStyle(toolbar as HTMLElement).top)).toBeGreaterThanOrEqual(204)

    canvasContainer.remove()
  })

  it('keeps the image toolbar centered above the image while avoiding protected annotations', async () => {
    const canvasContainer = document.createElement('div')
    Object.defineProperty(canvasContainer, 'clientWidth', {
      configurable: true,
      value: 800
    })
    Object.defineProperty(canvasContainer, 'clientHeight', {
      configurable: true,
      value: 600
    })
    document.body.appendChild(canvasContainer)

    const stage = {
      findOne: vi.fn((selector: string) =>
        selector === '#image-1'
          ? {
              getClientRect: () => ({
                x: 120,
                y: 20,
                width: 220,
                height: 150
              })
            }
          : null
      )
    }
    const stageRef = {
      current: {
        getStage: () => stage
      }
    } as unknown as React.RefObject<KonvaStage | null>

    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPageSelectionOverlays
          tool="select"
          selectionOverlayGroups={[]}
          exactSelectedGroup={null}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          stageSize={{ width: 800, height: 600 }}
          selectedIds={new Set(['image-1'])}
          items={[
            createImageItem({ x: 120, y: 20, width: 220, height: 150 }),
            createAnnotationItem()
          ]}
          stageRef={stageRef}
          canvasContainerRef={{ current: canvasContainer }}
          lastClickedId="image-1"
          mediaCaptionActionLabel="Edit caption"
          legacySelectionToolbarEnabled={false}
          groupCreateLabel="Group"
          handleFocusGroup={vi.fn()}
          buildCanvasDragPayload={vi.fn((): CanvasDragPayload => ({ sourceCanvasId: 'canvas-1' }))}
          setCanvasDragPayload={vi.fn()}
          handleFlipImage={vi.fn()}
          handleCropImage={vi.fn()}
          handleExtractImage={vi.fn()}
          handleCopyCanvasImage={vi.fn()}
          handleDownloadCanvasImage={vi.fn()}
          handleOpenAgentSendMenu={vi.fn()}
          handleOpenMediaCaptionEditor={vi.fn()}
          handleSendCanvasItemsToAgent={vi.fn()}
          handleToggleVideoPlayback={vi.fn()}
          handleOpenModel3DViewer={vi.fn()}
          handleOpenDccExportMenu={vi.fn()}
          handleDownloadBlobItem={vi.fn()}
          handleCopyCanvasItemsAsImage={vi.fn()}
          handleDownloadCanvasItemsAsImage={vi.fn()}
          getQuickCanvasItemsImageUrl={vi.fn(() => null)}
          prepareQuickCanvasItemsImageUrl={vi.fn(async () => null)}
          handleGenerateCanvasItems={vi.fn()}
          handleCreateGroup={vi.fn()}
          Model3DIcon={() => null}
          ExportIcon={() => null}
        />
      </ThemeProvider>
    )

    await waitFor(() => {
      expect(canvasContainer.querySelector('.image-action-toolbar')).toBeTruthy()
    })

    const toolbar = canvasContainer.querySelector('.image-action-toolbar') as HTMLElement | null
    expect(toolbar).toBeTruthy()
    expect(parseFloat(getComputedStyle(toolbar as HTMLElement).left)).toBeGreaterThan(200)
    expect(parseFloat(getComputedStyle(toolbar as HTMLElement).left)).toBeLessThan(260)
    expect(parseFloat(getComputedStyle(toolbar as HTMLElement).top)).toBeLessThan(40)

    canvasContainer.remove()
  })

  it('keeps the single-image toolbar centered even when an exact-group chip is present', async () => {
    const canvasContainer = document.createElement('div')
    Object.defineProperty(canvasContainer, 'clientWidth', {
      configurable: true,
      value: 800
    })
    Object.defineProperty(canvasContainer, 'clientHeight', {
      configurable: true,
      value: 600
    })
    document.body.appendChild(canvasContainer)

    const stage = {
      findOne: vi.fn((selector: string) =>
        selector === '#image-1'
          ? {
              getClientRect: () => ({
                x: 120,
                y: 80,
                width: 220,
                height: 150
              })
            }
          : null
      )
    }
    const stageRef = {
      current: {
        getStage: () => stage
      }
    } as unknown as React.RefObject<KonvaStage | null>
    const selectedImage = createImageItem({ x: 120, y: 80, width: 220, height: 150 })
    const exactSelectedGroup = {
      id: 'group-1',
      name: '组合2',
      itemIds: ['image-1'],
      createdAt: '2026-04-22T00:00:00.000Z',
      bounds: { x: 120, y: 80, width: 220, height: 150 },
      validItems: [selectedImage]
    }

    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPageSelectionOverlays
          tool="select"
          selectionOverlayGroups={[exactSelectedGroup]}
          exactSelectedGroup={exactSelectedGroup}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          stageSize={{ width: 800, height: 600 }}
          selectedIds={new Set(['image-1'])}
          items={[selectedImage]}
          stageRef={stageRef}
          canvasContainerRef={{ current: canvasContainer }}
          lastClickedId="image-1"
          mediaCaptionActionLabel="Edit caption"
          legacySelectionToolbarEnabled={false}
          groupCreateLabel="Group"
          handleFocusGroup={vi.fn()}
          buildCanvasDragPayload={vi.fn((): CanvasDragPayload => ({ sourceCanvasId: 'canvas-1' }))}
          setCanvasDragPayload={vi.fn()}
          handleFlipImage={vi.fn()}
          handleCropImage={vi.fn()}
          handleExtractImage={vi.fn()}
          handleCopyCanvasImage={vi.fn()}
          handleDownloadCanvasImage={vi.fn()}
          handleOpenAgentSendMenu={vi.fn()}
          handleOpenMediaCaptionEditor={vi.fn()}
          handleSendCanvasItemsToAgent={vi.fn()}
          handleToggleVideoPlayback={vi.fn()}
          handleOpenModel3DViewer={vi.fn()}
          handleOpenDccExportMenu={vi.fn()}
          handleDownloadBlobItem={vi.fn()}
          handleCopyCanvasItemsAsImage={vi.fn()}
          handleDownloadCanvasItemsAsImage={vi.fn()}
          getQuickCanvasItemsImageUrl={vi.fn(() => null)}
          prepareQuickCanvasItemsImageUrl={vi.fn(async () => null)}
          handleGenerateCanvasItems={vi.fn()}
          handleCreateGroup={vi.fn()}
          Model3DIcon={() => null}
          ExportIcon={() => null}
        />
      </ThemeProvider>
    )

    await waitFor(() => {
      expect(canvasContainer.querySelector('.image-action-toolbar')).toBeTruthy()
      expect(canvasContainer.querySelector('[data-canvas-overlay="group-chip"]')).toBeTruthy()
    })

    const toolbar = canvasContainer.querySelector('.image-action-toolbar') as HTMLElement | null
    expect(toolbar).toBeTruthy()
    expect(parseFloat(getComputedStyle(toolbar as HTMLElement).left)).toBeGreaterThan(200)
    expect(parseFloat(getComputedStyle(toolbar as HTMLElement).left)).toBeLessThan(260)
    expect(parseFloat(getComputedStyle(toolbar as HTMLElement).top)).toBeLessThan(80)

    canvasContainer.remove()
  })

  it('prefers the selected image interaction overlay rect over unrelated nodes with the same item id', async () => {
    const canvasContainer = document.createElement('div')
    Object.defineProperty(canvasContainer, 'clientWidth', {
      configurable: true,
      value: 800
    })
    Object.defineProperty(canvasContainer, 'clientHeight', {
      configurable: true,
      value: 600
    })
    document.body.appendChild(canvasContainer)

    const unrelatedNode = document.createElement('div')
    unrelatedNode.setAttribute('data-canvas-item-id', 'image-1')
    canvasContainer.appendChild(unrelatedNode)
    Object.defineProperty(unrelatedNode, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 520,
        top: 200,
        right: 720,
        bottom: 320,
        width: 200,
        height: 120,
        x: 520,
        y: 200,
        toJSON: () => ({})
      })
    })

    const selectedOverlayNode = document.createElement('div')
    selectedOverlayNode.setAttribute('data-canvas-item-id', 'image-1')
    selectedOverlayNode.setAttribute('data-canvas-overlay', 'image-interaction')
    canvasContainer.appendChild(selectedOverlayNode)
    Object.defineProperty(selectedOverlayNode, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 120,
        top: 20,
        right: 340,
        bottom: 170,
        width: 220,
        height: 150,
        x: 120,
        y: 20,
        toJSON: () => ({})
      })
    })

    const stage = {
      findOne: vi.fn(() => ({
        getClientRect: () => ({
          x: 520,
          y: 200,
          width: 200,
          height: 120
        })
      }))
    }
    const stageRef = {
      current: {
        getStage: () => stage
      }
    } as unknown as React.RefObject<KonvaStage | null>

    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPageSelectionOverlays
          tool="select"
          selectionOverlayGroups={[]}
          exactSelectedGroup={null}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          stageSize={{ width: 800, height: 600 }}
          selectedIds={new Set(['image-1'])}
          items={[createImageItem({ x: 120, y: 20, width: 220, height: 150 })]}
          stageRef={stageRef}
          canvasContainerRef={{ current: canvasContainer }}
          lastClickedId="image-1"
          mediaCaptionActionLabel="Edit caption"
          legacySelectionToolbarEnabled={false}
          groupCreateLabel="Group"
          handleFocusGroup={vi.fn()}
          buildCanvasDragPayload={vi.fn((): CanvasDragPayload => ({ sourceCanvasId: 'canvas-1' }))}
          setCanvasDragPayload={vi.fn()}
          handleFlipImage={vi.fn()}
          handleCropImage={vi.fn()}
          handleExplodeImage={vi.fn()}
          handleCopyCanvasImage={vi.fn()}
          handleDownloadCanvasImage={vi.fn()}
          handleOpenAgentSendMenu={vi.fn()}
          handleOpenMediaCaptionEditor={vi.fn()}
          handleSendCanvasItemsToAgent={vi.fn()}
          handleToggleVideoPlayback={vi.fn()}
          handleOpenModel3DViewer={vi.fn()}
          handleOpenDccExportMenu={vi.fn()}
          handleDownloadBlobItem={vi.fn()}
          handleCopyCanvasItemsAsImage={vi.fn()}
          handleDownloadCanvasItemsAsImage={vi.fn()}
          getQuickCanvasItemsImageUrl={vi.fn(() => null)}
          prepareQuickCanvasItemsImageUrl={vi.fn(async () => null)}
          handleGenerateCanvasItems={vi.fn()}
          handleCreateGroup={vi.fn()}
          Model3DIcon={() => null}
          ExportIcon={() => null}
        />
      </ThemeProvider>
    )

    await waitFor(() => {
      const toolbar = canvasContainer.querySelector('.image-action-toolbar') as HTMLElement | null
      expect(toolbar).toBeTruthy()
      expect(parseFloat(getComputedStyle(toolbar as HTMLElement).left)).toBeGreaterThan(200)
      expect(parseFloat(getComputedStyle(toolbar as HTMLElement).left)).toBeLessThan(260)
    })

    canvasContainer.remove()
  })

  it('re-measures the image toolbar after the interaction overlay mounts on the next frame', async () => {
    const canvasContainer = document.createElement('div')
    Object.defineProperty(canvasContainer, 'clientWidth', {
      configurable: true,
      value: 800
    })
    Object.defineProperty(canvasContainer, 'clientHeight', {
      configurable: true,
      value: 600
    })
    document.body.appendChild(canvasContainer)

    const stage = {
      findOne: vi.fn(() => ({
        getClientRect: () => ({
          x: 520,
          y: 200,
          width: 200,
          height: 120
        })
      }))
    }
    const stageRef = {
      current: {
        getStage: () => stage
      }
    } as unknown as React.RefObject<KonvaStage | null>

    function DeferredImageOverlayHarness() {
      React.useEffect(() => {
        const selectedOverlayNode = document.createElement('div')
        selectedOverlayNode.setAttribute('data-canvas-item-id', 'image-1')
        selectedOverlayNode.setAttribute('data-canvas-overlay', 'image-interaction')
        canvasContainer.appendChild(selectedOverlayNode)
        Object.defineProperty(selectedOverlayNode, 'getBoundingClientRect', {
          configurable: true,
          value: () => ({
            left: 120,
            top: 20,
            right: 340,
            bottom: 170,
            width: 220,
            height: 150,
            x: 120,
            y: 20,
            toJSON: () => ({})
          })
        })

        return () => {
          selectedOverlayNode.remove()
        }
      }, [])

      return (
        <ProjectCanvasPageSelectionOverlays
          tool="select"
          selectionOverlayGroups={[]}
          exactSelectedGroup={null}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          stageSize={{ width: 800, height: 600 }}
          selectedIds={new Set(['image-1'])}
          items={[createImageItem({ x: 120, y: 20, width: 220, height: 150 })]}
          stageRef={stageRef}
          canvasContainerRef={{ current: canvasContainer }}
          canvasContainerElement={canvasContainer}
          lastClickedId="image-1"
          mediaCaptionActionLabel="Edit caption"
          legacySelectionToolbarEnabled={false}
          groupCreateLabel="Group"
          handleFocusGroup={vi.fn()}
          buildCanvasDragPayload={vi.fn((): CanvasDragPayload => ({ sourceCanvasId: 'canvas-1' }))}
          setCanvasDragPayload={vi.fn()}
          handleFlipImage={vi.fn()}
          handleCropImage={vi.fn()}
          handleExplodeImage={vi.fn()}
          handleCopyCanvasImage={vi.fn()}
          handleDownloadCanvasImage={vi.fn()}
          handleOpenAgentSendMenu={vi.fn()}
          handleOpenMediaCaptionEditor={vi.fn()}
          handleSendCanvasItemsToAgent={vi.fn()}
          handleToggleVideoPlayback={vi.fn()}
          handleOpenModel3DViewer={vi.fn()}
          handleOpenDccExportMenu={vi.fn()}
          handleDownloadBlobItem={vi.fn()}
          handleCopyCanvasItemsAsImage={vi.fn()}
          handleDownloadCanvasItemsAsImage={vi.fn()}
          getQuickCanvasItemsImageUrl={vi.fn(() => null)}
          prepareQuickCanvasItemsImageUrl={vi.fn(async () => null)}
          handleGenerateCanvasItems={vi.fn()}
          handleCreateGroup={vi.fn()}
          Model3DIcon={() => null}
          ExportIcon={() => null}
        />
      )
    }

    render(
      <ThemeProvider theme={theme}>
        <DeferredImageOverlayHarness />
      </ThemeProvider>
    )

    await waitFor(() => {
      const toolbar = canvasContainer.querySelector('.image-action-toolbar') as HTMLElement | null
      expect(toolbar).toBeTruthy()
      expect(parseFloat(getComputedStyle(toolbar as HTMLElement).left)).toBeGreaterThan(200)
      expect(parseFloat(getComputedStyle(toolbar as HTMLElement).left)).toBeLessThan(260)
      expect(parseFloat(getComputedStyle(toolbar as HTMLElement).top)).toBeCloseTo(16, 0)
    })

    canvasContainer.remove()
  })

  it('keeps the exact-group chip anchored to the selection top-left instead of drifting around the toolbar', async () => {
    const canvasContainer = document.createElement('div')
    Object.defineProperty(canvasContainer, 'clientWidth', {
      configurable: true,
      value: 1000
    })
    Object.defineProperty(canvasContainer, 'clientHeight', {
      configurable: true,
      value: 600
    })
    document.body.appendChild(canvasContainer)

    const stage = {
      findOne: vi.fn(() => null)
    }
    const stageRef = {
      current: {
        getStage: () => stage
      }
    } as unknown as React.RefObject<KonvaStage | null>
    const selectedItems = [
      createImageItem({
        id: 'image-1',
        x: 240,
        y: 120,
        width: 120,
        height: 96,
        src: 'image-1.png'
      }),
      createImageItem({ id: 'image-2', x: 420, y: 140, width: 120, height: 96, src: 'image-2.png' })
    ]
    const exactSelectedGroup = {
      id: 'group-1',
      name: '组合2',
      itemIds: ['image-1', 'image-2'],
      createdAt: '2026-04-22T00:00:00.000Z',
      bounds: { x: 240, y: 120, width: 300, height: 116 },
      validItems: selectedItems
    }

    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPageSelectionOverlays
          tool="select"
          selectionOverlayGroups={[exactSelectedGroup]}
          exactSelectedGroup={exactSelectedGroup}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          stageSize={{ width: 1000, height: 600 }}
          selectedIds={new Set(['image-1', 'image-2'])}
          items={selectedItems}
          stageRef={stageRef}
          canvasContainerRef={{ current: canvasContainer }}
          lastClickedId="image-1"
          mediaCaptionActionLabel="Edit caption"
          legacySelectionToolbarEnabled={false}
          groupCreateLabel="Group"
          handleFocusGroup={vi.fn()}
          buildCanvasDragPayload={vi.fn((): CanvasDragPayload => ({ sourceCanvasId: 'canvas-1' }))}
          setCanvasDragPayload={vi.fn()}
          handleFlipImage={vi.fn()}
          handleCropImage={vi.fn()}
          handleCopyCanvasImage={vi.fn()}
          handleDownloadCanvasImage={vi.fn()}
          handleOpenAgentSendMenu={vi.fn()}
          handleOpenMediaCaptionEditor={vi.fn()}
          handleSendCanvasItemsToAgent={vi.fn()}
          handleToggleVideoPlayback={vi.fn()}
          handleOpenModel3DViewer={vi.fn()}
          handleOpenDccExportMenu={vi.fn()}
          handleDownloadBlobItem={vi.fn()}
          handleCopyCanvasItemsAsImage={vi.fn()}
          handleDownloadCanvasItemsAsImage={vi.fn()}
          getQuickCanvasItemsImageUrl={vi.fn(() => null)}
          prepareQuickCanvasItemsImageUrl={vi.fn(async () => null)}
          handleGenerateCanvasItems={vi.fn()}
          handleCreateGroup={vi.fn()}
          Model3DIcon={() => null}
          ExportIcon={() => null}
        />
      </ThemeProvider>
    )

    await waitFor(() => {
      expect(canvasContainer.querySelector('.group-action-toolbar')).toBeTruthy()
    })

    const groupChip = canvasContainer.querySelector(
      '[data-canvas-overlay="group-chip"]'
    ) as HTMLElement | null
    const toolbar = canvasContainer.querySelector('.group-action-toolbar') as HTMLElement | null

    expect(groupChip).toBeTruthy()
    expect(toolbar).toBeTruthy()
    expect((groupChip as HTMLElement).dataset.canvasGroupChipPlacement).toBe('default')
    expect(parseFloat(getComputedStyle(groupChip as HTMLElement).left)).toBeCloseTo(240, 0)
    expect(parseFloat(getComputedStyle(groupChip as HTMLElement).top)).toBeGreaterThan(70)
    expect(parseFloat(getComputedStyle(groupChip as HTMLElement).top)).toBeLessThan(80)

    canvasContainer.remove()
  })

  it('keeps the exact-group chip and toolbar in sync with live multi-selection bounds while moving the group', async () => {
    const canvasContainer = document.createElement('div')
    Object.defineProperty(canvasContainer, 'clientWidth', {
      configurable: true,
      value: 1000
    })
    Object.defineProperty(canvasContainer, 'clientHeight', {
      configurable: true,
      value: 700
    })
    document.body.appendChild(canvasContainer)

    const stageRef = {
      current: {
        getStage: () => null
      }
    } as unknown as React.RefObject<KonvaStage | null>
    const selectedItems = [
      createImageItem({
        id: 'image-1',
        x: 240,
        y: 120,
        width: 120,
        height: 96,
        src: 'image-1.png'
      }),
      createImageItem({ id: 'image-2', x: 420, y: 140, width: 120, height: 96, src: 'image-2.png' })
    ]
    const exactSelectedGroup = {
      id: 'group-1',
      name: '组合2',
      itemIds: ['image-1', 'image-2'],
      createdAt: '2026-04-22T00:00:00.000Z',
      bounds: { x: 240, y: 120, width: 300, height: 116 },
      validItems: selectedItems
    }

    const renderOverlays = (
      liveMultiSelectionBounds: {
        x: number
        y: number
        width: number
        height: number
      } | null
    ) => (
      <ThemeProvider theme={theme}>
        <ProjectCanvasPageSelectionOverlays
          tool="select"
          selectionOverlayGroups={[exactSelectedGroup]}
          exactSelectedGroup={exactSelectedGroup}
          liveMultiSelectionBounds={liveMultiSelectionBounds}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          stageSize={{ width: 1000, height: 700 }}
          selectedIds={new Set(['image-1', 'image-2'])}
          items={selectedItems}
          stageRef={stageRef}
          canvasContainerRef={{ current: canvasContainer }}
          canvasContainerElement={canvasContainer}
          lastClickedId="image-1"
          mediaCaptionActionLabel="Edit caption"
          legacySelectionToolbarEnabled={false}
          groupCreateLabel="Group"
          handleFocusGroup={vi.fn()}
          buildCanvasDragPayload={vi.fn((): CanvasDragPayload => ({ sourceCanvasId: 'canvas-1' }))}
          setCanvasDragPayload={vi.fn()}
          handleFlipImage={vi.fn()}
          handleCropImage={vi.fn()}
          handleCopyCanvasImage={vi.fn()}
          handleDownloadCanvasImage={vi.fn()}
          handleOpenAgentSendMenu={vi.fn()}
          handleOpenMediaCaptionEditor={vi.fn()}
          handleSendCanvasItemsToAgent={vi.fn()}
          handleToggleVideoPlayback={vi.fn()}
          handleOpenModel3DViewer={vi.fn()}
          handleOpenDccExportMenu={vi.fn()}
          handleDownloadBlobItem={vi.fn()}
          handleCopyCanvasItemsAsImage={vi.fn()}
          handleDownloadCanvasItemsAsImage={vi.fn()}
          getQuickCanvasItemsImageUrl={vi.fn(() => null)}
          prepareQuickCanvasItemsImageUrl={vi.fn(async () => null)}
          handleGenerateCanvasItems={vi.fn()}
          handleCreateGroup={vi.fn()}
          Model3DIcon={() => null}
          ExportIcon={() => null}
        />
      </ThemeProvider>
    )

    const { rerender } = render(renderOverlays({ x: 240, y: 120, width: 300, height: 116 }))

    const groupChip = await waitFor(() => {
      const element = canvasContainer.querySelector(
        '[data-canvas-overlay="group-chip"]'
      ) as HTMLElement | null
      expect(element).toBeTruthy()
      return element as HTMLElement
    })
    const toolbar = canvasContainer.querySelector('.group-action-toolbar') as HTMLElement | null
    expect(toolbar).toBeTruthy()

    const initialChipLeft = parseFloat(getComputedStyle(groupChip).left)
    const initialChipTop = parseFloat(getComputedStyle(groupChip).top)
    const initialToolbarLeft = parseFloat(getComputedStyle(toolbar as HTMLElement).left)
    const initialToolbarTop = parseFloat(getComputedStyle(toolbar as HTMLElement).top)

    rerender(renderOverlays({ x: 320, y: 210, width: 300, height: 116 }))

    await waitFor(() => {
      expect(parseFloat(getComputedStyle(groupChip).left)).toBeGreaterThan(initialChipLeft + 60)
      expect(parseFloat(getComputedStyle(groupChip).top)).toBeGreaterThan(initialChipTop + 60)
      expect(parseFloat(getComputedStyle(toolbar as HTMLElement).left)).toBeGreaterThan(
        initialToolbarLeft + 60
      )
      expect(parseFloat(getComputedStyle(toolbar as HTMLElement).top)).toBeGreaterThan(
        initialToolbarTop + 60
      )
    })

    canvasContainer.remove()
  })

  it('anchors the exact-group chip to the current selected item bounds when the stored group bounds are stale', async () => {
    const canvasContainer = document.createElement('div')
    Object.defineProperty(canvasContainer, 'clientWidth', {
      configurable: true,
      value: 1000
    })
    Object.defineProperty(canvasContainer, 'clientHeight', {
      configurable: true,
      value: 700
    })
    document.body.appendChild(canvasContainer)
    mockCanvasContainerRect(canvasContainer)

    const stageRef = {
      current: {
        getStage: () => null
      }
    } as unknown as React.RefObject<KonvaStage | null>
    const movedSelectedItems = [
      createImageItem({
        id: 'image-1',
        x: 420,
        y: 320,
        width: 120,
        height: 96,
        src: 'image-1.png'
      }),
      createImageItem({
        id: 'image-2',
        x: 600,
        y: 340,
        width: 120,
        height: 96,
        src: 'image-2.png'
      })
    ]
    const staleExactSelectedGroup = {
      id: 'group-1',
      name: 'Group 2',
      itemIds: ['image-1', 'image-2'],
      createdAt: '2026-04-22T00:00:00.000Z',
      bounds: { x: 80, y: 40, width: 300, height: 116 },
      validItems: movedSelectedItems
    }

    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPageSelectionOverlays
          tool="select"
          selectionOverlayGroups={[staleExactSelectedGroup]}
          exactSelectedGroup={staleExactSelectedGroup}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          stageSize={{ width: 1000, height: 700 }}
          selectedIds={new Set(['image-1', 'image-2'])}
          items={movedSelectedItems}
          stageRef={stageRef}
          canvasContainerRef={{ current: canvasContainer }}
          canvasContainerElement={canvasContainer}
          lastClickedId="image-1"
          mediaCaptionActionLabel="Edit caption"
          legacySelectionToolbarEnabled={false}
          groupCreateLabel="Group"
          handleFocusGroup={vi.fn()}
          buildCanvasDragPayload={vi.fn((): CanvasDragPayload => ({ sourceCanvasId: 'canvas-1' }))}
          setCanvasDragPayload={vi.fn()}
          handleFlipImage={vi.fn()}
          handleCropImage={vi.fn()}
          handleCopyCanvasImage={vi.fn()}
          handleDownloadCanvasImage={vi.fn()}
          handleOpenAgentSendMenu={vi.fn()}
          handleOpenMediaCaptionEditor={vi.fn()}
          handleSendCanvasItemsToAgent={vi.fn()}
          handleToggleVideoPlayback={vi.fn()}
          handleOpenModel3DViewer={vi.fn()}
          handleOpenDccExportMenu={vi.fn()}
          handleDownloadBlobItem={vi.fn()}
          handleCopyCanvasItemsAsImage={vi.fn()}
          handleDownloadCanvasItemsAsImage={vi.fn()}
          getQuickCanvasItemsImageUrl={vi.fn(() => null)}
          prepareQuickCanvasItemsImageUrl={vi.fn(async () => null)}
          handleGenerateCanvasItems={vi.fn()}
          handleCreateGroup={vi.fn()}
          Model3DIcon={() => null}
          ExportIcon={() => null}
        />
      </ThemeProvider>
    )

    const groupChip = await waitFor(() => {
      const element = canvasContainer.querySelector(
        '[data-canvas-overlay="group-chip"]'
      ) as HTMLElement | null
      expect(element).toBeTruthy()
      return element as HTMLElement
    })

    expect(parseFloat(getComputedStyle(groupChip).left)).toBeCloseTo(420, 0)
    expect(parseFloat(getComputedStyle(groupChip).top)).toBeGreaterThan(270)
    expect(parseFloat(getComputedStyle(groupChip).top)).toBeLessThan(295)

    canvasContainer.remove()
  })

  it('anchors the matching group chip to the current selected bounds even before exactSelectedGroup catches up', async () => {
    const canvasContainer = document.createElement('div')
    Object.defineProperty(canvasContainer, 'clientWidth', {
      configurable: true,
      value: 1000
    })
    Object.defineProperty(canvasContainer, 'clientHeight', {
      configurable: true,
      value: 700
    })
    document.body.appendChild(canvasContainer)
    mockCanvasContainerRect(canvasContainer)

    const stageRef = {
      current: {
        getStage: () => null
      }
    } as unknown as React.RefObject<KonvaStage | null>
    const movedSelectedItems = [
      createImageItem({
        id: 'image-1',
        x: 420,
        y: 320,
        width: 120,
        height: 96,
        src: 'image-1.png'
      }),
      createImageItem({
        id: 'image-2',
        x: 600,
        y: 340,
        width: 120,
        height: 96,
        src: 'image-2.png'
      })
    ]
    const matchingSelectedGroup = {
      id: 'group-1',
      name: 'Group 2',
      itemIds: ['image-1', 'image-2'],
      createdAt: '2026-04-22T00:00:00.000Z',
      bounds: { x: 80, y: 40, width: 300, height: 116 },
      validItems: movedSelectedItems
    }

    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPageSelectionOverlays
          tool="select"
          selectionOverlayGroups={[matchingSelectedGroup]}
          exactSelectedGroup={null}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          stageSize={{ width: 1000, height: 700 }}
          selectedIds={new Set(['image-1', 'image-2'])}
          items={movedSelectedItems}
          stageRef={stageRef}
          canvasContainerRef={{ current: canvasContainer }}
          canvasContainerElement={canvasContainer}
          lastClickedId="image-1"
          mediaCaptionActionLabel="Edit caption"
          legacySelectionToolbarEnabled={false}
          groupCreateLabel="Group"
          handleFocusGroup={vi.fn()}
          buildCanvasDragPayload={vi.fn((): CanvasDragPayload => ({ sourceCanvasId: 'canvas-1' }))}
          setCanvasDragPayload={vi.fn()}
          handleFlipImage={vi.fn()}
          handleCropImage={vi.fn()}
          handleCopyCanvasImage={vi.fn()}
          handleDownloadCanvasImage={vi.fn()}
          handleOpenAgentSendMenu={vi.fn()}
          handleOpenMediaCaptionEditor={vi.fn()}
          handleSendCanvasItemsToAgent={vi.fn()}
          handleToggleVideoPlayback={vi.fn()}
          handleOpenModel3DViewer={vi.fn()}
          handleOpenDccExportMenu={vi.fn()}
          handleDownloadBlobItem={vi.fn()}
          handleCopyCanvasItemsAsImage={vi.fn()}
          handleDownloadCanvasItemsAsImage={vi.fn()}
          getQuickCanvasItemsImageUrl={vi.fn(() => null)}
          prepareQuickCanvasItemsImageUrl={vi.fn(async () => null)}
          handleGenerateCanvasItems={vi.fn()}
          handleCreateGroup={vi.fn()}
          Model3DIcon={() => null}
          ExportIcon={() => null}
        />
      </ThemeProvider>
    )

    const groupChip = await waitFor(() => {
      const element = canvasContainer.querySelector(
        '[data-canvas-overlay="group-chip"]'
      ) as HTMLElement | null
      expect(element).toBeTruthy()
      return element as HTMLElement
    })

    expect(parseFloat(getComputedStyle(groupChip).left)).toBeCloseTo(420, 0)
    expect(parseFloat(getComputedStyle(groupChip).top)).toBeGreaterThan(270)
    expect(parseFloat(getComputedStyle(groupChip).top)).toBeLessThan(295)

    canvasContainer.remove()
  })

  it('keeps the exact-group chip anchored to the group top-left while live viewport zoom changes its size', async () => {
    let viewportCallback: ((pos: { x: number; y: number }, scale: number) => void) | null = null
    const registerViewportCallback = vi.fn(
      (callback: (pos: { x: number; y: number }, scale: number) => void) => {
        viewportCallback = callback
        return vi.fn()
      }
    )

    const canvasContainer = document.createElement('div')
    Object.defineProperty(canvasContainer, 'clientWidth', {
      configurable: true,
      value: 1000
    })
    Object.defineProperty(canvasContainer, 'clientHeight', {
      configurable: true,
      value: 700
    })
    document.body.appendChild(canvasContainer)
    mockCanvasContainerRect(canvasContainer)

    const stageRef = {
      current: {
        getStage: () => null
      }
    } as unknown as React.RefObject<KonvaStage | null>
    const selectedImage = createImageItem({
      x: 120,
      y: 180,
      width: 220,
      height: 150
    })
    const exactSelectedGroup = {
      id: 'group-1',
      name: '组合2',
      itemIds: ['image-1'],
      createdAt: '2026-04-22T00:00:00.000Z',
      bounds: { x: 120, y: 180, width: 220, height: 150 },
      validItems: [selectedImage]
    }
    const stagePosRef = { current: { x: 20, y: 30 } }
    const stageScaleRef = { current: 1 }

    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPageSelectionOverlays
          tool="select"
          selectionOverlayGroups={[exactSelectedGroup]}
          exactSelectedGroup={exactSelectedGroup}
          stagePos={stagePosRef.current}
          stagePosRef={stagePosRef}
          stageScale={stageScaleRef.current}
          stageScaleRef={stageScaleRef}
          stageSize={{ width: 1000, height: 700 }}
          selectedIds={new Set(['image-1'])}
          items={[selectedImage]}
          stageRef={stageRef}
          canvasContainerRef={{ current: canvasContainer }}
          canvasContainerElement={canvasContainer}
          registerViewportCallback={registerViewportCallback}
          lastClickedId="image-1"
          mediaCaptionActionLabel="Edit caption"
          legacySelectionToolbarEnabled={false}
          groupCreateLabel="Group"
          handleFocusGroup={vi.fn()}
          buildCanvasDragPayload={vi.fn((): CanvasDragPayload => ({ sourceCanvasId: 'canvas-1' }))}
          setCanvasDragPayload={vi.fn()}
          handleFlipImage={vi.fn()}
          handleCropImage={vi.fn()}
          handleExtractImage={vi.fn()}
          handleCopyCanvasImage={vi.fn()}
          handleDownloadCanvasImage={vi.fn()}
          handleOpenAgentSendMenu={vi.fn()}
          handleOpenMediaCaptionEditor={vi.fn()}
          handleSendCanvasItemsToAgent={vi.fn()}
          handleToggleVideoPlayback={vi.fn()}
          handleOpenModel3DViewer={vi.fn()}
          handleOpenDccExportMenu={vi.fn()}
          handleDownloadBlobItem={vi.fn()}
          handleCopyCanvasItemsAsImage={vi.fn()}
          handleDownloadCanvasItemsAsImage={vi.fn()}
          getQuickCanvasItemsImageUrl={vi.fn(() => null)}
          prepareQuickCanvasItemsImageUrl={vi.fn(async () => null)}
          handleGenerateCanvasItems={vi.fn()}
          handleCreateGroup={vi.fn()}
          Model3DIcon={() => null}
          ExportIcon={() => null}
        />
      </ThemeProvider>
    )

    const groupChip = await waitFor(() => {
      const element = canvasContainer.querySelector(
        '[data-canvas-overlay="group-chip"]'
      ) as HTMLElement | null
      expect(element).toBeTruthy()
      return element as HTMLElement
    })

    await waitFor(() => {
      expect(registerViewportCallback).toHaveBeenCalledTimes(1)
      expect(viewportCallback).toBeTypeOf('function')
    })

    const initialLeft = parseFloat(getComputedStyle(groupChip).left)
    const initialTop = parseFloat(getComputedStyle(groupChip).top)
    const initialWidth = parseFloat(getComputedStyle(groupChip).width)

    expect(initialLeft).toBeCloseTo(140, 0)
    expect(initialTop).toBeGreaterThan(150)
    expect(initialTop).toBeLessThan(170)

    stagePosRef.current = { x: 50, y: 70 }
    stageScaleRef.current = 0.25

    act(() => {
      viewportCallback?.(stagePosRef.current, stageScaleRef.current)
    })

    expect(parseFloat(getComputedStyle(groupChip).left)).toBeCloseTo(80, 0)
    expect(parseFloat(getComputedStyle(groupChip).top)).toBeGreaterThan(80)
    expect(parseFloat(getComputedStyle(groupChip).top)).toBeLessThan(95)
    expect(parseFloat(getComputedStyle(groupChip).width)).toBeLessThan(initialWidth)

    canvasContainer.remove()
  })

  it('keeps the exact-group chip and group toolbar in sync with live viewport zoom callbacks for multi-selection', async () => {
    let viewportCallback: ((pos: { x: number; y: number }, scale: number) => void) | null = null
    const registerViewportCallback = vi.fn(
      (callback: (pos: { x: number; y: number }, scale: number) => void) => {
        viewportCallback = callback
        return vi.fn()
      }
    )

    const canvasContainer = document.createElement('div')
    Object.defineProperty(canvasContainer, 'clientWidth', {
      configurable: true,
      value: 1000
    })
    Object.defineProperty(canvasContainer, 'clientHeight', {
      configurable: true,
      value: 700
    })
    document.body.appendChild(canvasContainer)
    mockCanvasContainerRect(canvasContainer)

    const stageRef = {
      current: {
        getStage: () => null
      }
    } as unknown as React.RefObject<KonvaStage | null>
    const selectedItems = [
      createImageItem({
        id: 'image-1',
        x: 80,
        y: 40,
        width: 120,
        height: 96,
        src: 'image-1.png'
      }),
      createImageItem({
        id: 'image-2',
        x: 260,
        y: 60,
        width: 120,
        height: 96,
        src: 'image-2.png'
      })
    ]
    const exactSelectedGroup = {
      id: 'group-1',
      name: 'Group 2',
      itemIds: ['image-1', 'image-2'],
      createdAt: '2026-04-22T00:00:00.000Z',
      bounds: { x: 80, y: 40, width: 300, height: 116 },
      validItems: selectedItems
    }
    const stagePosRef = { current: { x: 20, y: 30 } }
    const stageScaleRef = { current: 1 }

    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPageSelectionOverlays
          tool="select"
          selectionOverlayGroups={[exactSelectedGroup]}
          exactSelectedGroup={exactSelectedGroup}
          stagePos={stagePosRef.current}
          stagePosRef={stagePosRef}
          stageScale={stageScaleRef.current}
          stageScaleRef={stageScaleRef}
          stageSize={{ width: 1000, height: 700 }}
          selectedIds={new Set(['image-1', 'image-2'])}
          items={selectedItems}
          stageRef={stageRef}
          canvasContainerRef={{ current: canvasContainer }}
          canvasContainerElement={canvasContainer}
          registerViewportCallback={registerViewportCallback}
          lastClickedId="image-1"
          mediaCaptionActionLabel="Edit caption"
          legacySelectionToolbarEnabled={false}
          groupCreateLabel="Group"
          handleFocusGroup={vi.fn()}
          buildCanvasDragPayload={vi.fn((): CanvasDragPayload => ({ sourceCanvasId: 'canvas-1' }))}
          setCanvasDragPayload={vi.fn()}
          handleFlipImage={vi.fn()}
          handleCropImage={vi.fn()}
          handleCopyCanvasImage={vi.fn()}
          handleDownloadCanvasImage={vi.fn()}
          handleOpenAgentSendMenu={vi.fn()}
          handleOpenMediaCaptionEditor={vi.fn()}
          handleSendCanvasItemsToAgent={vi.fn()}
          handleToggleVideoPlayback={vi.fn()}
          handleOpenModel3DViewer={vi.fn()}
          handleOpenDccExportMenu={vi.fn()}
          handleDownloadBlobItem={vi.fn()}
          handleCopyCanvasItemsAsImage={vi.fn()}
          handleDownloadCanvasItemsAsImage={vi.fn()}
          getQuickCanvasItemsImageUrl={vi.fn(() => null)}
          prepareQuickCanvasItemsImageUrl={vi.fn(async () => null)}
          handleGenerateCanvasItems={vi.fn()}
          handleCreateGroup={vi.fn()}
          Model3DIcon={() => null}
          ExportIcon={() => null}
        />
      </ThemeProvider>
    )

    const groupChip = await waitFor(() => {
      const element = canvasContainer.querySelector(
        '[data-canvas-overlay="group-chip"]'
      ) as HTMLElement | null
      expect(element).toBeTruthy()
      return element as HTMLElement
    })
    const toolbar = await waitFor(() => {
      const element = canvasContainer.querySelector('.group-action-toolbar') as HTMLElement | null
      expect(element).toBeTruthy()
      return element as HTMLElement
    })

    await waitFor(() => {
      expect(registerViewportCallback).toHaveBeenCalledTimes(1)
      expect(viewportCallback).toBeTypeOf('function')
    })

    const initialChipLeft = parseFloat(getComputedStyle(groupChip).left)
    const initialChipTop = parseFloat(getComputedStyle(groupChip).top)
    const initialChipWidth = parseFloat(getComputedStyle(groupChip).width)
    const initialToolbarLeft = parseFloat(getComputedStyle(toolbar).left)
    const initialToolbarTop = parseFloat(getComputedStyle(toolbar).top)

    stagePosRef.current = { x: 55, y: 65 }
    stageScaleRef.current = 0.35

    act(() => {
      viewportCallback?.(stagePosRef.current, stageScaleRef.current)
    })

    const nextChipLeft = parseFloat(getComputedStyle(groupChip).left)
    const nextChipTop = parseFloat(getComputedStyle(groupChip).top)
    const nextChipWidth = parseFloat(getComputedStyle(groupChip).width)
    const nextToolbarLeft = parseFloat(getComputedStyle(toolbar).left)
    const nextToolbarTop = parseFloat(getComputedStyle(toolbar).top)

    expect(nextChipLeft).toBeLessThan(initialChipLeft - 10)
    expect(Math.abs(nextChipTop - initialChipTop)).toBeGreaterThan(10)
    expect(nextChipWidth).toBeLessThan(initialChipWidth)
    expect(nextToolbarLeft).toBeLessThan(initialToolbarLeft - 60)
    expect(Math.abs(nextToolbarTop - initialToolbarTop)).toBeGreaterThan(5)
    expect(parseFloat(getComputedStyle(groupChip).zIndex)).toBeGreaterThan(
      parseFloat(getComputedStyle(toolbar).zIndex)
    )

    canvasContainer.remove()
  })

  it('shows an export action for selected file items outside the preview dialog', async () => {
    const canvasContainer = document.createElement('div')
    Object.defineProperty(canvasContainer, 'clientWidth', {
      configurable: true,
      value: 800
    })
    Object.defineProperty(canvasContainer, 'clientHeight', {
      configurable: true,
      value: 600
    })
    document.body.appendChild(canvasContainer)

    const stage = {
      findOne: vi.fn(() => ({
        getClientRect: () => ({
          x: 100,
          y: 140,
          width: 180,
          height: 96
        })
      }))
    }
    const stageRef = {
      current: {
        getStage: () => stage
      }
    } as unknown as React.RefObject<KonvaStage | null>
    const handleExportCanvasFile = vi.fn()

    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPageSelectionOverlays
          tool="select"
          selectionOverlayGroups={[]}
          exactSelectedGroup={null}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          stageSize={{ width: 800, height: 600 }}
          selectedIds={new Set(['file-1'])}
          items={[createFileItem()]}
          stageRef={stageRef}
          canvasContainerRef={{ current: canvasContainer }}
          lastClickedId="file-1"
          mediaCaptionActionLabel="Edit caption"
          legacySelectionToolbarEnabled={false}
          groupCreateLabel="Group"
          handleFocusGroup={vi.fn()}
          buildCanvasDragPayload={vi.fn((): CanvasDragPayload => ({ sourceCanvasId: 'canvas-1' }))}
          setCanvasDragPayload={vi.fn()}
          handleFlipImage={vi.fn()}
          handleCropImage={vi.fn()}
          handleCopyCanvasImage={vi.fn()}
          handleDownloadCanvasImage={vi.fn()}
          handleOpenAgentSendMenu={vi.fn()}
          handleOpenMediaCaptionEditor={vi.fn()}
          handleSendCanvasItemsToAgent={vi.fn()}
          handleToggleVideoPlayback={vi.fn()}
          handleOpenModel3DViewer={vi.fn()}
          handleOpenDccExportMenu={vi.fn()}
          handleDownloadBlobItem={vi.fn()}
          handleExportCanvasFile={handleExportCanvasFile}
          handleCopyCanvasItemsAsImage={vi.fn()}
          handleDownloadCanvasItemsAsImage={vi.fn()}
          getQuickCanvasItemsImageUrl={vi.fn(() => null)}
          prepareQuickCanvasItemsImageUrl={vi.fn(async () => null)}
          handleGenerateCanvasItems={vi.fn()}
          handleCreateGroup={vi.fn()}
          fileExportActionLabel="Export file"
          Model3DIcon={() => null}
          ExportIcon={() => null}
        />
      </ThemeProvider>
    )

    const exportButton = await waitFor(() => {
      const toolbar = canvasContainer.querySelector(
        '.file-item-action-toolbar'
      ) as HTMLElement | null
      expect(toolbar).toBeTruthy()
      return within(toolbar as HTMLElement).getByLabelText('Export file')
    })

    fireEvent.click(exportButton)

    expect(handleExportCanvasFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'file-1' }),
      'original'
    )

    canvasContainer.remove()
  })

  it('shows export format choices for document-style file items', async () => {
    const canvasContainer = document.createElement('div')
    Object.defineProperty(canvasContainer, 'clientWidth', {
      configurable: true,
      value: 800
    })
    Object.defineProperty(canvasContainer, 'clientHeight', {
      configurable: true,
      value: 600
    })
    document.body.appendChild(canvasContainer)

    const stage = {
      findOne: vi.fn(() => ({
        getClientRect: () => ({
          x: 100,
          y: 140,
          width: 180,
          height: 96
        })
      }))
    }
    const stageRef = {
      current: {
        getStage: () => stage
      }
    } as unknown as React.RefObject<KonvaStage | null>
    const handleExportCanvasFile = vi.fn()

    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPageSelectionOverlays
          tool="select"
          selectionOverlayGroups={[]}
          exactSelectedGroup={null}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          stageSize={{ width: 800, height: 600 }}
          selectedIds={new Set(['file-1'])}
          items={[
            createFileItem({
              fileName: 'brief.docx',
              mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              fileKind: 'word',
              editable: false,
              previewSheets: undefined,
              previewText: 'Document preview'
            })
          ]}
          stageRef={stageRef}
          canvasContainerRef={{ current: canvasContainer }}
          lastClickedId="file-1"
          mediaCaptionActionLabel="Edit caption"
          legacySelectionToolbarEnabled={false}
          groupCreateLabel="Group"
          handleFocusGroup={vi.fn()}
          buildCanvasDragPayload={vi.fn((): CanvasDragPayload => ({ sourceCanvasId: 'canvas-1' }))}
          setCanvasDragPayload={vi.fn()}
          handleFlipImage={vi.fn()}
          handleCropImage={vi.fn()}
          handleCopyCanvasImage={vi.fn()}
          handleDownloadCanvasImage={vi.fn()}
          handleOpenAgentSendMenu={vi.fn()}
          handleOpenMediaCaptionEditor={vi.fn()}
          handleSendCanvasItemsToAgent={vi.fn()}
          handleToggleVideoPlayback={vi.fn()}
          handleOpenModel3DViewer={vi.fn()}
          handleOpenDccExportMenu={vi.fn()}
          handleDownloadBlobItem={vi.fn()}
          handleExportCanvasFile={handleExportCanvasFile}
          handleCopyCanvasItemsAsImage={vi.fn()}
          handleDownloadCanvasItemsAsImage={vi.fn()}
          getQuickCanvasItemsImageUrl={vi.fn(() => null)}
          prepareQuickCanvasItemsImageUrl={vi.fn(async () => null)}
          handleGenerateCanvasItems={vi.fn()}
          handleCreateGroup={vi.fn()}
          fileExportActionLabel="Export file"
          Model3DIcon={() => null}
          ExportIcon={() => null}
        />
      </ThemeProvider>
    )

    const exportButton = await waitFor(() => {
      const toolbar = canvasContainer.querySelector(
        '.file-item-action-toolbar'
      ) as HTMLElement | null
      expect(toolbar).toBeTruthy()
      return within(toolbar as HTMLElement).getByLabelText('Export file')
    })

    fireEvent.click(exportButton)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Markdown (.md)' }))

    expect(handleExportCanvasFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'file-1' }),
      'md'
    )

    canvasContainer.remove()
  })
})
