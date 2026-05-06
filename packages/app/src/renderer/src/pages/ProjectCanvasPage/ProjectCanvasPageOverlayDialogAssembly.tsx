import React from 'react'
import CanvasTargetDialog from './Dialogs/CanvasTargetDialog'
import FigmaBindingDialog from './Dialogs/FigmaBindingDialog'
import ProjectCanvasPageColorPopovers from './ProjectCanvasPageColorPopovers'
import ProjectCanvasPageDialogs from './ProjectCanvasPageDialogs'
import ProjectCanvasPageHiddenInputs from './ProjectCanvasPageHiddenInputs'
import ProjectCanvasPageInlineTextEditor from './ProjectCanvasPageInlineTextEditor'
import ProjectCanvasPageSelectionOverlays from './ProjectCanvasPageSelectionOverlays'
import ProjectCanvasPageShortcutDialog from './ProjectCanvasPageShortcutDialog'
import ProjectCanvasPageVisualOverlays from './ProjectCanvasPageVisualOverlays'

type ProjectCanvasPageOverlayDialogAssemblyProps = {
  suspendViewportChrome?: boolean
  selectionOverlaysProps: React.ComponentProps<typeof ProjectCanvasPageSelectionOverlays>
  visualOverlaysProps: React.ComponentProps<typeof ProjectCanvasPageVisualOverlays>
  inlineTextEditorProps: React.ComponentProps<typeof ProjectCanvasPageInlineTextEditor>
  hiddenInputsProps: React.ComponentProps<typeof ProjectCanvasPageHiddenInputs>
  shortcutDialogProps: React.ComponentProps<typeof ProjectCanvasPageShortcutDialog>
  canvasTargetDialogProps: React.ComponentProps<typeof CanvasTargetDialog>
  figmaBindingDialogProps: React.ComponentProps<typeof FigmaBindingDialog>
  dialogsProps: React.ComponentProps<typeof ProjectCanvasPageDialogs>
  colorPopoversProps: React.ComponentProps<typeof ProjectCanvasPageColorPopovers>
}

export default function ProjectCanvasPageOverlayDialogAssembly({
  suspendViewportChrome = false,
  selectionOverlaysProps,
  visualOverlaysProps,
  inlineTextEditorProps,
  hiddenInputsProps,
  shortcutDialogProps,
  canvasTargetDialogProps,
  figmaBindingDialogProps,
  dialogsProps,
  colorPopoversProps
}: ProjectCanvasPageOverlayDialogAssemblyProps) {
  return (
    <>
      {!suspendViewportChrome && <ProjectCanvasPageSelectionOverlays {...selectionOverlaysProps} />}
      <ProjectCanvasPageVisualOverlays {...visualOverlaysProps} />
      <ProjectCanvasPageInlineTextEditor {...inlineTextEditorProps} />
      <ProjectCanvasPageHiddenInputs {...hiddenInputsProps} />
      <ProjectCanvasPageShortcutDialog {...shortcutDialogProps} />
      <CanvasTargetDialog {...canvasTargetDialogProps} />
      <FigmaBindingDialog {...figmaBindingDialogProps} />
      <ProjectCanvasPageDialogs {...dialogsProps} />
      <ProjectCanvasPageColorPopovers {...colorPopoversProps} />
    </>
  )
}
