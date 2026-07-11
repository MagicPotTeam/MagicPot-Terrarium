import type React from 'react'

import type { CanvasGroupSummary } from './groupMenuUtils'
import type { CanvasGroupPlaybackState } from './useCanvasGroupPlayback'
import type { CanvasTool } from './projectCanvasPageShared'
import type { AnnotationShape, CanvasGroup, CanvasGroupBranch, CanvasItem } from './types'

export type ProjectCanvasPageTranslate = (key: string, options?: Record<string, unknown>) => string

export type ProjectCanvasViewportPoint = {
  x: number
  y: number
}

export type ProjectCanvasViewportSize = {
  width: number
  height: number
}

export type ProjectCanvasToolShortcutContextMenu = {
  x: number
  y: number
  toolKey: string
} | null

export type ProjectCanvasExportContextMenuPosition = {
  x: number
  y: number
}

export type ProjectCanvasToolbarTheme = {
  palette: {
    divider?: string
    mode?: string
    background: { paper: string }
    primary: { main: string }
    text: { primary: string }
    common: { white: string; black: string }
  }
}

type ProjectCanvasLooseRuntimeValue = ReturnType<typeof JSON.parse>

export type ProjectCanvasPageToolbarGroupTreeProps = {
  groupBranches: CanvasGroupBranch[]
  groupSummaries: CanvasGroupSummary[]
  exactSelectedGroup: CanvasGroup | null
  handleCreateGroupBranch: (nameDraft?: string) => CanvasGroupBranch
  handleDeleteGroupBranch: (branchId: string | null) => void
  handleFocusGroupBranch: (branchId: string | null) => void
  handleMoveGroupToBranch: (groupId: string, branchId: string | null) => void
  handleRenameGroup: (groupId: string, nextNameDraft: string) => void
  handleRenameGroupBranch: (branchId: string, nextNameDraft: string) => void
}

export type ProjectCanvasPageTopToolbarProps = ProjectCanvasPageToolbarGroupTreeProps & {
  [key: string]: ProjectCanvasLooseRuntimeValue
  alpha: (color: string, value: number) => string
  annoTool: AnnotationShape | string
  annotationColor: string
  annotationFillEnabled: boolean
  annotationStrokeWidth: number
  annotationToolbarBorderColor: string
  annotationToolbarHoverSurface: string
  annotationToolbarIdleSurface: string
  annotationToolbarMutedText: string
  annotationToolbarShadow: string
  annotationToolbarStrongText: string
  annotationToolbarSurface: string
  bgColor: string
  canPlayGroupSummary: (group: CanvasGroupSummary) => boolean
  clampStageScale: (value: number) => number
  closeExportMenus: () => void
  countLabel: string
  currentShortcut: string
  exportCtxMenuPos: ProjectCanvasExportContextMenuPosition | null
  exportMenuAnchor: HTMLElement | null
  exportSubmenuAnchor: HTMLElement | null
  exportSubmenuPlacement: 'left' | 'right'
  exportableItems: readonly unknown[]
  generationTraceRecentRecords: readonly unknown[]
  groupMenuAnchor: HTMLElement | null
  groupPlayback: CanvasGroupPlaybackState | null
  handleAutoArrangeGroup: (group: CanvasGroup) => void
  handleCloseExportContextMenu: () => void
  handleCloseExportSubmenu: () => void
  handleCloseGroupMenu: () => void
  handleDeleteGroup: (groupId: string) => void
  handleExportCanvasProjectFile: () => void | Promise<void>
  handleExportScopeWithFormat: (
    scope: 'scene' | 'selected-scene' | 'all-elements' | 'selected-elements',
    format: 'png' | 'jpeg' | 'svg'
  ) => void
  handleFitAll: () => void
  handleFocusGroup: (group: CanvasGroup) => void
  handleOpenCanvasTaggingDialog?: () => void
  handleOpenExportContextMenu: (position: ProjectCanvasExportContextMenuPosition) => void
  handleOpenExportMenu: (anchorEl: HTMLElement) => void
  handleOpenGenerationTraceHistory: () => void
  handleOpenGroupMenu: (anchorEl: HTMLElement) => void
  handleSaveCanvas: () => void | Promise<void>
  handleSaveCanvasAs: () => void | Promise<void>
  handleSaveCanvasAsFromContextMenu: () => void | Promise<void>
  handleToggleAnnotationFillMode: () => void
  handleToolbarImportClick: () => void
  hasSelectedTextItem: boolean
  isChineseUi: boolean
  isLightCanvasTheme: boolean
  items: CanvasItem[]
  linePickerAnchor: HTMLElement | null
  openClearConfirmDialog: () => void
  openExportSubmenu: (anchorEl: HTMLElement) => void
  pauseGroupPlayback: () => void
  resumeGroupPlayback: () => void
  scalePercent: number
  selectedExportableItems: readonly unknown[]
  selectedIds: Set<string>
  setAnnoTool: React.Dispatch<React.SetStateAction<AnnotationShape>>
  setAnnotationStrokeWidth: React.Dispatch<React.SetStateAction<number>>
  setBgColorPickerAnchor: React.Dispatch<React.SetStateAction<HTMLElement | null>>
  setColorPickerAnchor: React.Dispatch<React.SetStateAction<HTMLElement | null>>
  setItemsWithHistory: React.Dispatch<React.SetStateAction<CanvasItem[]>>
  setLinePickerAnchor: React.Dispatch<React.SetStateAction<HTMLElement | null>>
  setShapePickerAnchor: React.Dispatch<React.SetStateAction<HTMLElement | null>>
  setShortcutDialogOpen: React.Dispatch<React.SetStateAction<boolean>>
  setStagePos: React.Dispatch<React.SetStateAction<ProjectCanvasViewportPoint>>
  setStageScale: React.Dispatch<React.SetStateAction<number>>
  setStageScaleAroundViewportCenter: (scale: number) => void
  setTool: React.Dispatch<React.SetStateAction<CanvasTool>>
  setToolShortcutCtxMenu: React.Dispatch<React.SetStateAction<ProjectCanvasToolShortcutContextMenu>>
  setToolShortcutRecorded: React.Dispatch<React.SetStateAction<string>>
  shapePickerAnchor: HTMLElement | null
  showAnnotationFillToggle: boolean
  showAnnotationStrokeControl: boolean
  stagePos: ProjectCanvasViewportPoint
  stageScale: number
  stageSize: ProjectCanvasViewportSize | null
  startGroupPlayback: (group: CanvasGroupSummary) => void
  stopGroupPlayback: () => void
  t: ProjectCanvasPageTranslate
  theme: ProjectCanvasToolbarTheme
  tool: CanvasTool
  toolShortcutCtxMenu: ProjectCanvasToolShortcutContextMenu
  toolShortcutRecorded: string
  toolShortcuts: Record<string, string>
  updateToolShortcut: (toolKey: string, combo: string) => void
}

export type ProjectCanvasPageShellRuntimeProps = Record<string, ProjectCanvasLooseRuntimeValue>
