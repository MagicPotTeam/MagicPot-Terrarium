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

// The page re-renders on every gesture start and end and on every committed viewport change. Each
// overlay and dialog is memoised so that only the ones whose props changed render again; the shell
// passes their props through useStableCallbackProps, so their callbacks keep one identity and always
// call the latest handler.
const MemoizedSelectionOverlays = React.memo(ProjectCanvasPageSelectionOverlays)
const MemoizedVisualOverlays = React.memo(ProjectCanvasPageVisualOverlays)
const MemoizedInlineTextEditor = React.memo(ProjectCanvasPageInlineTextEditor)
const MemoizedHiddenInputs = React.memo(ProjectCanvasPageHiddenInputs)
const MemoizedShortcutDialog = React.memo(ProjectCanvasPageShortcutDialog)
const MemoizedCanvasTargetDialog = React.memo(CanvasTargetDialog)
const MemoizedFigmaBindingDialog = React.memo(FigmaBindingDialog)
const MemoizedDialogs = React.memo(ProjectCanvasPageDialogs)
const MemoizedColorPopovers = React.memo(ProjectCanvasPageColorPopovers)

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
      {!suspendViewportChrome && <MemoizedSelectionOverlays {...selectionOverlaysProps} />}
      <MemoizedVisualOverlays {...visualOverlaysProps} />
      <MemoizedInlineTextEditor {...inlineTextEditorProps} />
      <MemoizedHiddenInputs {...hiddenInputsProps} />
      <MemoizedShortcutDialog {...shortcutDialogProps} />
      <MemoizedCanvasTargetDialog {...canvasTargetDialogProps} />
      <MemoizedFigmaBindingDialog {...figmaBindingDialogProps} />
      <MemoizedDialogs {...dialogsProps} />
      <MemoizedColorPopovers {...colorPopoversProps} />
    </>
  )
}
