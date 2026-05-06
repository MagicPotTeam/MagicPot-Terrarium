import React from 'react'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import ProjectCanvasPageOverlayDialogAssembly from './ProjectCanvasPageOverlayDialogAssembly'

vi.mock('./ProjectCanvasPageSelectionOverlays', () => ({
  default: () => <div data-testid="selection-overlays" />
}))

vi.mock('./ProjectCanvasPageVisualOverlays', () => ({
  default: () => <div data-testid="visual-overlays" />
}))

vi.mock('./ProjectCanvasPageInlineTextEditor', () => ({
  default: () => <div data-testid="inline-text-editor" />
}))

vi.mock('./ProjectCanvasPageHiddenInputs', () => ({
  default: () => <div data-testid="hidden-inputs" />
}))

vi.mock('./ProjectCanvasPageShortcutDialog', () => ({
  default: () => <div data-testid="shortcut-dialog" />
}))

vi.mock('./Dialogs/CanvasTargetDialog', () => ({
  default: () => <div data-testid="canvas-target-dialog" />
}))

vi.mock('./Dialogs/FigmaBindingDialog', () => ({
  default: () => <div data-testid="figma-binding-dialog" />
}))

vi.mock('./ProjectCanvasPageDialogs', () => ({
  default: () => <div data-testid="dialogs" />
}))

vi.mock('./ProjectCanvasPageColorPopovers', () => ({
  default: () => <div data-testid="color-popovers" />
}))

const baseProps = {
  selectionOverlaysProps: {} as React.ComponentProps<any>,
  visualOverlaysProps: { itemsLength: 1 } as React.ComponentProps<any>,
  inlineTextEditorProps: {} as React.ComponentProps<any>,
  hiddenInputsProps: {} as React.ComponentProps<any>,
  shortcutDialogProps: {} as React.ComponentProps<any>,
  canvasTargetDialogProps: {} as React.ComponentProps<any>,
  figmaBindingDialogProps: {} as React.ComponentProps<any>,
  dialogsProps: {} as React.ComponentProps<any>,
  colorPopoversProps: {} as React.ComponentProps<any>
}

describe('ProjectCanvasPageOverlayDialogAssembly', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('keeps visual overlays mounted for the empty canvas while viewport chrome is suspended', () => {
    render(
      <ProjectCanvasPageOverlayDialogAssembly
        {...baseProps}
        suspendViewportChrome
        visualOverlaysProps={{ itemsLength: 0 } as React.ComponentProps<any>}
      />
    )

    expect(screen.queryByTestId('selection-overlays')).not.toBeInTheDocument()
    expect(screen.getByTestId('visual-overlays')).toBeInTheDocument()
  })

  it('suspends only selection overlays for non-empty canvases', () => {
    render(<ProjectCanvasPageOverlayDialogAssembly {...baseProps} suspendViewportChrome />)

    expect(screen.queryByTestId('selection-overlays')).not.toBeInTheDocument()
    expect(screen.getByTestId('visual-overlays')).toBeInTheDocument()
  })
})
