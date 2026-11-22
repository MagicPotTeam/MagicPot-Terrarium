import React from 'react'
import { fireEvent, render, waitFor } from '@testing-library/react'
import { ThemeProvider } from '@mui/material'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { theme } from '@renderer/theme'
import ProjectCanvasPageShell from './ProjectCanvasPageShell'
import type { CanvasItem } from './types'

// The real selection overlays render through the real Shell; everything else is a stub.
vi.mock('react-konva', () => ({ Line: () => null }))
vi.mock('konva', () => ({ default: {} }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en-US', resolvedLanguage: 'en-US' }
  })
}))

function stub() {
  return { default: () => null }
}
vi.mock('./ProjectCanvasPageTopToolbar', () => stub())
vi.mock('./ProjectCanvasPageStageScene', () => stub())
vi.mock('./ProjectCanvasPageVisualOverlays', () => stub())
vi.mock('./ProjectCanvasPageInlineTextEditor', () => stub())
vi.mock('./ProjectCanvasPageHiddenInputs', () => stub())
vi.mock('./ProjectCanvasPageShortcutDialog', () => stub())
vi.mock('./Dialogs/CanvasTargetDialog', () => stub())
vi.mock('./Dialogs/FigmaBindingDialog', () => stub())
vi.mock('./ProjectCanvasPageDialogs', () => stub())
vi.mock('./ProjectCanvasPageColorPopovers', () => stub())

function createImageItem(id: string, x: number): CanvasItem {
  return {
    id,
    type: 'image',
    src: `${id}.png`,
    x,
    y: 40,
    width: 120,
    height: 96,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false
  }
}

function createCanvasContainer() {
  const element = document.createElement('div')
  Object.defineProperty(element, 'clientWidth', { configurable: true, value: 1000 })
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: 700 })
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      left: 0,
      top: 0,
      right: 1000,
      bottom: 700,
      width: 1000,
      height: 700,
      x: 0,
      y: 0,
      toJSON: () => ({})
    })
  })
  document.body.appendChild(element)
  return element
}

const items = [createImageItem('image-1', 80), createImageItem('image-2', 260)]
const selectedIds = new Set(['image-1', 'image-2'])

// Models useCanvasExportWorkflow: the quick drag-preview cache key includes the committed viewport,
// so the page builds new prepare / get helpers whenever the viewport changes, and only prepare
// fills the cache.
function PageHarness({
  container,
  stagePos,
  stageScale,
  setCanvasDragPayload
}: {
  container: HTMLDivElement
  stagePos: { x: number; y: number }
  stageScale: number
  setCanvasDragPayload: (...args: unknown[]) => void
}) {
  const cacheRef = React.useRef(new Map<string, string>())
  const cacheKey = JSON.stringify({ stagePos, stageScale })
  const prepareQuickCanvasItemsImageUrl = React.useCallback(async () => {
    const imageUrl = `blob:${cacheKey}`
    cacheRef.current.set(cacheKey, imageUrl)
    return imageUrl
  }, [cacheKey])
  const getQuickCanvasItemsImageUrl = React.useCallback(
    () => cacheRef.current.get(cacheKey) ?? null,
    [cacheKey]
  )
  const containerRef = React.useRef(container)
  const props: Record<string, unknown> = {
    canvasContainerRef: containerRef,
    stageRef: { current: null },
    lastClickedIdRef: { current: 'image-2' },
    selectedIds,
    items,
    visibleItems: items,
    videoItems: [],
    htmlItems: [],
    renderedModel3DItems: [],
    selectionOverlayGroups: [],
    historySnapshots: [],
    stagePos,
    stageScale,
    scalePercent: Math.round(stageScale * 100),
    stageSize: { width: 1000, height: 700 },
    isViewportInteracting: false,
    tool: 'select',
    exactSelectedGroup: null,
    groupPlayback: null,
    inlineTextEdit: null,
    activeOcrHover: null,
    mediaCaptionActionLabel: 'Caption',
    labelDialogOpen: false,
    labelDialogText: '',
    isLegacySelectionToolbarEnabled: () => false,
    t: (key: string) => key,
    buildCanvasDragPayload: () => ({ sourceCanvasId: 'canvas-1' }),
    setCanvasDragPayload,
    getQuickCanvasItemsImageUrl,
    prepareQuickCanvasItemsImageUrl
  }
  return (
    <ThemeProvider theme={theme}>
      <ProjectCanvasPageShell {...(props as React.ComponentProps<typeof ProjectCanvasPageShell>)} />
    </ThemeProvider>
  )
}

describe('ProjectCanvasPageShell selection drag-out', () => {
  let container: HTMLDivElement | null = null

  afterEach(() => {
    container?.remove()
    container = null
  })

  async function startSelectionDrag() {
    const dragButton = await waitFor(() => {
      const element = container?.querySelector('.drag-action-button') as HTMLElement | null
      expect(element).toBeTruthy()
      return element as HTMLElement
    })
    const dataTransfer = { setData: vi.fn(), effectAllowed: 'all' } as unknown as DataTransfer
    return fireEvent.dragStart(dragButton, { dataTransfer })
  }

  it('still drags a multi-selection out of the canvas after a committed pan and zoom', async () => {
    container = createCanvasContainer()
    const setCanvasDragPayload = vi.fn()
    const view = render(
      <PageHarness
        container={container}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        setCanvasDragPayload={setCanvasDragPayload}
      />
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await startSelectionDrag()).toBe(true)
    expect(setCanvasDragPayload).toHaveBeenCalledTimes(1)

    // A pan and a zoom commit a new viewport: the cached preview no longer matches.
    view.rerender(
      <PageHarness
        container={container}
        stagePos={{ x: -150, y: 60 }}
        stageScale={0.5}
        setCanvasDragPayload={setCanvasDragPayload}
      />
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(await startSelectionDrag()).toBe(true)
    expect(setCanvasDragPayload).toHaveBeenCalledTimes(2)
  })
})
