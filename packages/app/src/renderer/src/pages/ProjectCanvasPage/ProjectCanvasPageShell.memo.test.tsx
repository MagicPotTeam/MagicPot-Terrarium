import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'

import ProjectCanvasPageShell from './ProjectCanvasPageShell'

// Each mocked child counts its renders and keeps its latest props. The top toolbar is memoised by
// its own module, like the real one; the overlays and dialogs get their memo from the real
// ProjectCanvasPageOverlayDialogAssembly.
const { renderCounts, latestProps } = vi.hoisted(() => ({
  renderCounts: new Map<string, number>(),
  latestProps: new Map<string, Record<string, unknown>>()
}))

function recordRender(name: string, props: Record<string, unknown>) {
  renderCounts.set(name, (renderCounts.get(name) ?? 0) + 1)
  latestProps.set(name, props)
}

vi.mock('./ProjectCanvasPageTopToolbar', async () => {
  const ReactModule = await import('react')
  return {
    default: ReactModule.memo(function MockTopToolbar(props: Record<string, unknown>) {
      recordRender('toolbar', props)
      return null
    })
  }
})
vi.mock('./ProjectCanvasPageStageScene', () => ({
  default: (props: Record<string, unknown>) => {
    recordRender('stage', props)
    return null
  }
}))

function mockChild(name: string) {
  return {
    default: (props: Record<string, unknown>) => {
      recordRender(name, props)
      return null
    }
  }
}
vi.mock('./ProjectCanvasPageSelectionOverlays', () => mockChild('selectionOverlays'))
vi.mock('./ProjectCanvasPageVisualOverlays', () => mockChild('visualOverlays'))
vi.mock('./ProjectCanvasPageInlineTextEditor', () => mockChild('inlineTextEditor'))
vi.mock('./ProjectCanvasPageHiddenInputs', () => mockChild('hiddenInputs'))
vi.mock('./ProjectCanvasPageShortcutDialog', () => mockChild('shortcutDialog'))
vi.mock('./Dialogs/CanvasTargetDialog', () => mockChild('canvasTargetDialog'))
vi.mock('./Dialogs/FigmaBindingDialog', () => mockChild('figmaBindingDialog'))
vi.mock('./ProjectCanvasPageDialogs', () => mockChild('dialogs'))
vi.mock('./ProjectCanvasPageColorPopovers', () => mockChild('colorPopovers'))

const CHROME = [
  'toolbar',
  'hiddenInputs',
  'shortcutDialog',
  'canvasTargetDialog',
  'figmaBindingDialog',
  'dialogs',
  'colorPopovers'
]

function snapshotCounts() {
  return Object.fromEntries([...renderCounts.entries()])
}

// Values the page keeps stable across renders (refs, state, memoised lists) are created once.
const stablePageValues = {
  canvasContainerRef: { current: document.createElement('div') },
  stageRef: { current: null },
  lastClickedIdRef: { current: null },
  selectedIds: new Set<string>(),
  videoItems: [],
  htmlItems: [],
  renderedModel3DItems: [],
  visibleItems: [],
  items: [],
  selectionOverlayGroups: [],
  historySnapshots: [],
  stagePos: { x: 0, y: 0 },
  stageSize: { width: 1280, height: 720 },
  isLegacySelectionToolbarEnabled: () => false,
  t: (key: string) => key,
  setStageScaleAroundViewportCenter: vi.fn(),
  getQuickCanvasItemsImageUrl: vi.fn(),
  prepareQuickCanvasItemsImageUrl: vi.fn()
}

function createProps(overrides: Record<string, unknown> = {}) {
  return {
    ...stablePageValues,
    isViewportInteracting: false,
    stageScale: 1,
    scalePercent: 100,
    inlineTextEdit: null,
    activeOcrHover: null,
    tool: 'select',
    groupPlayback: null,
    exactSelectedGroup: null,
    mediaCaptionActionLabel: 'Caption',
    labelDialogOpen: false,
    labelDialogText: '',
    // Handlers the page rebuilds on every render.
    handleStageMouseDown: vi.fn(),
    handleBgColorChange: vi.fn(),
    handleRunCanvasTarget: vi.fn(),
    handleConfirmLabelDialog: vi.fn(),
    ...overrides
  }
}

describe('ProjectCanvasPageShell memoised chrome', () => {
  afterEach(() => {
    renderCounts.clear()
    latestProps.clear()
  })

  it('does not re-render the toolbar, dialogs or menus for a gesture start, a committed pan or zoom, or new handlers', () => {
    const { rerender } = render(<ProjectCanvasPageShell {...createProps()} />)
    const initial = snapshotCounts()
    for (const name of CHROME) {
      expect(initial[name], name).toBe(1)
    }

    // Gesture start: the page re-renders with the flag and with fresh handlers.
    const nextBgColorChange = vi.fn()
    const nextRunCanvasTarget = vi.fn()
    rerender(
      <ProjectCanvasPageShell
        {...createProps({
          isViewportInteracting: true,
          handleBgColorChange: nextBgColorChange,
          handleRunCanvasTarget: nextRunCanvasTarget
        })}
      />
    )
    // Gesture end: committed pan and zoom, flag off, fresh handlers again.
    const nextSetScaleAroundCenter = vi.fn()
    rerender(
      <ProjectCanvasPageShell
        {...createProps({
          stagePos: { x: -240, y: 80 },
          stageScale: 2,
          scalePercent: 200,
          handleBgColorChange: nextBgColorChange,
          handleRunCanvasTarget: nextRunCanvasTarget,
          setStageScaleAroundViewportCenter: nextSetScaleAroundCenter
        })}
      />
    )

    const after = snapshotCounts()
    for (const name of CHROME) {
      expect(after[name], name).toBe(1)
    }
    // The stage and the overlays that draw the viewport do follow it.
    expect(after.stage).toBe(3)
    expect(after.visualOverlays).toBe(3)

    // The toolbar never received the viewport as props; it reads the latest one on demand, and its
    // kept handlers call the latest page handlers.
    const toolbarProps = latestProps.get('toolbar') as Record<string, any>
    expect(toolbarProps.stagePos).toBeUndefined()
    expect(toolbarProps.scalePercent).toBeUndefined()
    expect(toolbarProps.isViewportInteracting).toBeUndefined()
    expect(toolbarProps.getStageViewport()).toEqual({
      stagePos: { x: -240, y: 80 },
      stageScale: 2,
      stageSize: { width: 1280, height: 720 }
    })
    toolbarProps.handleBgColorChange('#123456')
    expect(nextBgColorChange).toHaveBeenCalledWith('#123456')
    toolbarProps.setStageScaleAroundViewportCenter(1)
    expect(nextSetScaleAroundCenter).toHaveBeenCalledWith(1)

    // The canvas target dialog's inline onRun calls the latest runner.
    ;(latestProps.get('canvasTargetDialog') as Record<string, any>).onRun()
    expect(nextRunCanvasTarget).toHaveBeenCalledTimes(1)
  })

  it('does not re-render the selection overlays for a gesture start, only for the committed viewport', () => {
    const selectedIds = new Set(['a', 'b'])
    const { rerender } = render(<ProjectCanvasPageShell {...createProps({ selectedIds })} />)
    expect(renderCounts.get('selectionOverlays')).toBe(1)

    rerender(
      <ProjectCanvasPageShell {...createProps({ selectedIds, isViewportInteracting: true })} />
    )
    expect(renderCounts.get('selectionOverlays')).toBe(1)

    rerender(<ProjectCanvasPageShell {...createProps({ selectedIds, stagePos: { x: 5, y: 6 } })} />)
    expect(renderCounts.get('selectionOverlays')).toBe(2)
    const selectionProps = latestProps.get('selectionOverlays') as Record<string, any>
    expect(selectionProps.stagePos).toEqual({ x: 5, y: 6 })
  })

  it('hands the selection overlays the page-built drag-preview preparer so a new viewport re-prepares it', () => {
    // The drag-preview cache key includes the committed viewport, and the page rebuilds the preparer
    // with it. The selection overlays re-prepare the preview when the preparer changes identity, so
    // it must not be replaced by a stable forwarder, or a selection could not be dragged out of the
    // canvas after a pan or zoom.
    const selectedIds = new Set(['a', 'b'])
    const firstPrepare = vi.fn()
    const { rerender } = render(
      <ProjectCanvasPageShell
        {...createProps({ selectedIds, prepareQuickCanvasItemsImageUrl: firstPrepare })}
      />
    )
    expect(latestProps.get('selectionOverlays')?.prepareQuickCanvasItemsImageUrl).toBe(firstPrepare)

    const nextPrepare = vi.fn()
    rerender(
      <ProjectCanvasPageShell
        {...createProps({
          selectedIds,
          stagePos: { x: -120, y: 40 },
          stageScale: 0.5,
          prepareQuickCanvasItemsImageUrl: nextPrepare
        })}
      />
    )
    expect(latestProps.get('selectionOverlays')?.prepareQuickCanvasItemsImageUrl).toBe(nextPrepare)
  })

  it('does not re-render the toolbar for a new stage size after a panel drag', () => {
    const firstStart = vi.fn()
    const { rerender } = render(
      <ProjectCanvasPageShell {...createProps({ startGroupPlayback: firstStart })} />
    )
    expect(renderCounts.get('toolbar')).toBe(1)

    // The page rebuilds its group playback callbacks with the new stage size.
    const nextStart = vi.fn()
    rerender(
      <ProjectCanvasPageShell
        {...createProps({ stageSize: { width: 1220, height: 720 }, startGroupPlayback: nextStart })}
      />
    )
    expect(renderCounts.get('toolbar')).toBe(1)
    const toolbarProps = latestProps.get('toolbar') as Record<string, any>
    toolbarProps.startGroupPlayback({ id: 'group-1' })
    expect(nextStart).toHaveBeenCalledWith({ id: 'group-1' })
    expect(firstStart).not.toHaveBeenCalled()
    expect(toolbarProps.getStageViewport().stageSize).toEqual({ width: 1220, height: 720 })
  })

  it('does not re-render the stage when the page only rebuilds its handlers', () => {
    const { rerender } = render(<ProjectCanvasPageShell {...createProps()} />)
    expect(renderCounts.get('stage')).toBe(1)

    // The deferred-value pass after a commit re-renders the page with fresh handlers only.
    const nextMouseDown = vi.fn()
    rerender(<ProjectCanvasPageShell {...createProps({ handleStageMouseDown: nextMouseDown })} />)
    expect(renderCounts.get('stage')).toBe(1)
    const stageProps = latestProps.get('stage') as Record<string, any>
    stageProps.handleStageMouseDown({ type: 'mousedown' })
    expect(nextMouseDown).toHaveBeenCalledWith({ type: 'mousedown' })
  })

  it('still re-renders a dialog when a value it shows changes', () => {
    const { rerender } = render(<ProjectCanvasPageShell {...createProps()} />)
    expect(renderCounts.get('dialogs')).toBe(1)

    rerender(
      <ProjectCanvasPageShell {...createProps({ labelDialogOpen: true, labelDialogText: 'Hi' })} />
    )
    expect(renderCounts.get('dialogs')).toBe(2)
    const dialogsProps = latestProps.get('dialogs') as Record<string, any>
    expect(dialogsProps.labelEditorDialogProps).toMatchObject({ open: true, text: 'Hi' })

    // The toolbar shows selection-dependent controls, so a new selection re-renders it.
    const toolbarRenders = renderCounts.get('toolbar') ?? 0
    rerender(<ProjectCanvasPageShell {...createProps({ selectedIds: new Set(['x']) })} />)
    expect(renderCounts.get('toolbar')).toBe(toolbarRenders + 1)
  })
})
