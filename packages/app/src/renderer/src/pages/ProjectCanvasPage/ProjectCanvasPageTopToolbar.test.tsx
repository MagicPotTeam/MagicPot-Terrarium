import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { ThemeProvider } from '@mui/material'
import { describe, expect, it, vi } from 'vitest'

import { theme } from '@renderer/theme'
import ProjectCanvasPageTopToolbar from './ProjectCanvasPageTopToolbar'

vi.mock('./ProjectCanvasPageExportMenus', () => ({
  default: () => null
}))

function createTranslate() {
  return (key: string, options?: Record<string, unknown>) => {
    switch (key) {
      case 'canvas.group_toolbar':
        return '组合'
      case 'canvas.group_toolbar_count':
        return `组合 ${options?.count ?? ''}`.trim()
      case 'canvas.group_empty':
        return '暂无组合'
      case 'canvas.group_empty_hint':
        return '先选中元素，再点击画布中的“组合”按钮创建'
      case 'canvas.group_item_count':
        return `${options?.valid ?? 0} / ${options?.total ?? 0} 个元素`
      case 'canvas.group_branch_create':
        return '分枝'
      case 'canvas.group_branch_placeholder':
        return '分枝名称'
      case 'canvas.group_branch_ungrouped':
        return '未归类'
      case 'canvas.group_branch_delete':
        return '删除分枝'
      case 'canvas.group_branch_empty_hint':
        return '点击分枝或组合可快速定位'
      case 'canvas.group_branch_default_name':
        return `分枝 ${options?.index ?? ''}`.trim()
      case 'canvas.group_move_to_branch':
        return `移动到 ${options?.name ?? ''}`.trim()
      case 'canvas.group_rename':
        return '重命名'
      case 'canvas.group_action_more':
        return '更多操作'
      case 'canvas.group_playback_start':
        return '开始播放'
      case 'canvas.group_playback_pause':
        return '暂停播放'
      case 'canvas.group_playback_resume':
        return '继续播放'
      case 'canvas.group_auto_arrange':
        return '整理'
      case 'canvas.group_delete':
        return '删除组合'
      case 'canvas.action_fit_all':
        return '适配全部'
      case 'canvas.action_save_with_shortcut':
        return `导出 ${options?.shortcut ?? ''}`.trim()
      case 'canvas.action_clear':
        return '清空'
      case 'canvas.tool_import':
        return '导入'
      case 'canvas.tool_select':
        return '选择'
      case 'canvas.tool_hand':
        return '手型'
      case 'canvas.shape_rect':
        return '矩形'
      case 'canvas.shape_arrow':
        return '箭头'
      case 'canvas.shape_line':
        return '直线'
      case 'canvas.tool_freedraw':
        return '画笔'
      case 'canvas.tool_text':
        return '文字'
      case 'canvas.action_screenshot':
        return `截图 ${options?.shortcut ?? ''}`.trim()
      default:
        return key
    }
  }
}

function buildBaseProps(overrides: Record<string, unknown> = {}) {
  const t = createTranslate()

  return {
    CANVAS_IMPORT_ACCEPT: 'image/*',
    DccExportIcon: () => null,
    MODEL_IMPORT_EXTENSIONS: ['.glb'],
    Model3DIcon: () => null,
    activeFileDialogItem: null,
    activeGroupPlaybackCanvasBounds: null,
    activeGroupPlaybackGroup: null,
    activeGroupPlaybackItem: null,
    activeGroupPlaybackScreenBounds: null,
    activeModel3DItem: null,
    activeOcrHover: null,
    agentSendMenuAnchor: null,
    agentSendMenuItemIds: [],
    alpha: () => 'rgba(15,23,42,0.2)',
    annoTool: 'rect',
    annotationColor: '#ffffff',
    annotationFillEnabled: false,
    annotationFillOpacity: 0.2,
    annotationStrokeWidth: 2,
    annotationToolbarBorderColor: 'rgba(255,255,255,0.16)',
    annotationToolbarHoverSurface: 'rgba(255,255,255,0.08)',
    annotationToolbarIdleSurface: 'rgba(15,23,42,0.64)',
    annotationToolbarMutedText: 'rgba(255,255,255,0.6)',
    annotationToolbarShadow: 'none',
    annotationToolbarStrongText: '#ffffff',
    annotationToolbarSurface: 'rgba(15,23,42,0.9)',
    bgColor: '#101828',
    bgColorPickerAnchor: null,
    brushWidthAnchor: null,
    buildCanvasDragPayload: vi.fn(),
    canPlayGroupSummary: vi.fn(() => false),
    canvasTargetControlProfileId: null,
    canvasTargetDialogOpen: false,
    canvasTargetError: null,
    canvasTargetLoading: false,
    canvasTargetProfileSelectOptions: [],
    canvasTargetReport: null,
    canvasTargetSelectedSchemeId: null,
    canvasTargetStageProfiles: [],
    canvasTargetTargetItemCount: 0,
    canvasTargetUserIntent: '',
    canvasContainerRef: { current: null },
    clampStageScale: (value: number) => value,
    clearConfirmOpen: false,
    closeClearConfirmDialog: vi.fn(),
    closeExportMenus: vi.fn(),
    colorPickerAnchor: null,
    contextMenuTarget: null,
    countLabel: '0 项',
    cropOverlayRef: { current: null },
    croppingImageId: null,
    currentShortcut: 'Ctrl+Shift+A',
    cursorStyle: 'default',
    targetSchemes: [],
    dccExportMenuAnchor: null,
    dccExportMenuItemId: null,
    drawingState: null,
    exactSelectedGroup: null,
    exportCtxMenuPos: null,
    exportMenuAnchor: null,
    exportSubmenuAnchor: null,
    exportSubmenuPlacement: 'bottom-end',
    exportableItems: [],
    figmaAccessToken: '',
    figmaAutoCheckIntervalMinutes: 60,
    figmaBindingDialogOpen: false,
    figmaBindingError: null,
    figmaBusyAction: null,
    figmaDialogBinding: null,
    figmaFileKeyOrUrlInput: '',
    figmaGlobalAutoCheckEnabled: false,
    fileDialogDraftContent: '',
    fileInputRef: { current: null },
    generationTaskDialogOpen: false,
    generationTaskPack: null,
    generationTraceHistoryDialogOpen: false,
    generationTraceRecentRecords: [],
    gridColor: 'rgba(255,255,255,0.08)',
    groupBranches: [],
    groupMenuAnchor: null,
    groupPlayback: null,
    groupRenameDraft: '',
    groupRenameId: null,
    groupRenameInputRef: { current: null },
    groupSummaries: [],
    handleAutoArrangeGroup: vi.fn(),
    handleBgColorChange: vi.fn(),
    handleBringForward: vi.fn(),
    handleBringToFront: vi.fn(),
    handleCancelCanvasTarget: vi.fn(),
    handleCancelGroupRename: vi.fn(),
    handleCheckFigmaUpdate: vi.fn(),
    handleCloseAgentSendMenu: vi.fn(),
    handleCloseCanvasTargetDialog: vi.fn(),
    handleCloseDccExportMenu: vi.fn(),
    handleCloseExportContextMenu: vi.fn(),
    handleCloseExportSubmenu: vi.fn(),
    handleExportCanvasProjectFile: vi.fn(),
    handleCloseFigmaBindingDialog: vi.fn(),
    handleCloseFileDialog: vi.fn(),
    handleCloseGenerationTaskDialog: vi.fn(),
    handleCloseGenerationTraceHistory: vi.fn(),
    handleCloseGroupMenu: vi.fn(),
    handleCloseImageContextMenu: vi.fn(),
    handleCloseModel3DViewer: vi.fn(),
    handleCloseTextureImportDialog: vi.fn(),
    handleCommitGroupRename: vi.fn(),
    handleConfirmClearDialog: vi.fn(),
    handleConfirmGenerationTaskPackWithTraceRefresh: vi.fn(),
    handleConfirmLabelDialog: vi.fn(),
    handleContinueGenerationTraceRecord: vi.fn(),
    handleCopyCanvasImage: vi.fn(),
    handleCopyCanvasItemsAsImage: vi.fn(),
    handleCreateGroup: vi.fn(),
    handleCreateGroupBranch: vi.fn(),
    handleCropImage: vi.fn(),
    handleDeleteGenerationTraceHistoryRecord: vi.fn(),
    handleDeleteGroup: vi.fn(),
    handleDeleteGroupBranch: vi.fn(),
    handleDeleteHtmlItem: vi.fn(),
    handleDownloadBlobItem: vi.fn(),
    handleDownloadCanvasImage: vi.fn(),
    handleDownloadCanvasItemsAsImage: vi.fn(),
    handleDragEnd: vi.fn(),
    handleDragOver: vi.fn(),
    handleDrop: vi.fn(),
    handleExportGroupPlaybackAsGif: vi.fn(),
    handleExportScopeWithFormat: vi.fn(),
    handleFigmaDraftAutoCheckUpdatesChange: vi.fn(),
    handleFigmaDraftPageChange: vi.fn(),
    handleFileSelect: vi.fn(),
    handleFitAll: vi.fn(),
    handleFlipImage: vi.fn(),
    handleFocusGroup: vi.fn(),
    handleFocusGroupBranch: vi.fn(),
    handleMoveGroupToBranch: vi.fn(),
    handleGenerateCanvasItems: vi.fn(),
    handleGroupPlaybackVideoEnded: vi.fn(),
    handleImageContextMenu: vi.fn(),
    handleModelSelect: vi.fn(),
    handleOpenAgentSendMenu: vi.fn(),
    handleOpenDccExportMenu: vi.fn(),
    handleOpenExportContextMenu: vi.fn(),
    handleOpenExportMenu: vi.fn(),
    handleOpenFileDialog: vi.fn(),
    handleOpenGenerationTraceHistory: vi.fn(),
    handleOpenGroupMenu: vi.fn(),
    handleOpenMediaCaptionEditor: vi.fn(),
    handleOpenModel3DViewer: vi.fn(),
    handleOpenTextureImportFromContextMenu: vi.fn(),
    handleOpenTextureImportInput: vi.fn(),
    handleRequestModel3DTextureImport: vi.fn(),
    handleResize: vi.fn(),
    handleRenameGroup: vi.fn(),
    handleRenameGroupBranch: vi.fn(),
    handleResolveFigmaBinding: vi.fn(),
    handleRunCanvasTarget: vi.fn(),
    handleSaveCanvas: vi.fn(),
    handleSaveCanvasAs: vi.fn(),
    handleSaveCanvasAsFromContextMenu: vi.fn(),
    handleSaveFigmaBinding: vi.fn(),
    handleSaveFileDialog: vi.fn(),
    handleSelectAgentTargetApp: vi.fn(),
    handleSelectDccExportTarget: vi.fn(),
    handleSendBackward: vi.fn(),
    handleSendCanvasItemsToAgent: vi.fn(),
    handleSendToBack: vi.fn(),
    handleSkipTextureImportDialog: vi.fn(),
    handleStageMouseDown: vi.fn(),
    handleStageMouseMove: vi.fn(),
    handleStageMouseUp: vi.fn(),
    handleStartGroupRename: vi.fn(),
    handleSyncFigmaBinding: vi.fn(),
    handleTextureFilesSelected: vi.fn(),
    handleToggleAnnotationFillMode: vi.fn(),
    handleToggleVideoPlayback: vi.fn(),
    handleToolbarImportClick: vi.fn(),
    handleTransformEnd: vi.fn(),
    handleUnbindFigmaBinding: vi.fn(),
    handleUpdateGenerationTraceDecision: vi.fn(),
    handleUpdateHtmlItem: vi.fn(),
    handleUpdateModel3DTextures: vi.fn(),
    handleUpdateVideoItem: vi.fn(),
    handleVideoSelect: vi.fn(),
    hasSelectedTextItem: false,
    htmlItems: [],
    imageContextMenu: null,
    inlineTextAreaRef: { current: null },
    inlineTextEdit: null,
    isChineseUi: true,
    isFillableAnnotationShape: vi.fn(() => false),
    isLegacySelectionToolbarEnabled: vi.fn(() => false),
    isLightCanvasTheme: false,
    isMiddleMouseRef: { current: false },
    itemIdSet: new Set<string>(),
    items: [],
    labelDialogOpen: false,
    labelDialogText: '',
    lastClickedIdRef: { current: null },
    linePickerAnchor: null,
    mediaCaptionActionLabel: '编辑说明',
    mediaCaptionPlaceholder: '请输入说明',
    modelInputRef: { current: null },
    nextZIndex: { current: 1 },
    notifyError: vi.fn(),
    openTargetManager: vi.fn(),
    openClearConfirmDialog: vi.fn(),
    openExportSubmenu: vi.fn(),
    pauseGroupPlayback: vi.fn(),
    recordedShortcut: '',
    renderedModel3DItems: [],
    resumeGroupPlayback: vi.fn(),
    scalePercent: 100,
    selectedExportableItems: [],
    selectedIds: new Set<string>(),
    selectionOverlayGroups: [],
    selectionRect: null,
    setActiveOcrHover: vi.fn(),
    setAnnoTool: vi.fn(),
    setAnnotationColor: vi.fn(),
    setAnnotationStrokeWidth: vi.fn(),
    setBgColorPickerAnchor: vi.fn(),
    setBgCustomColor: vi.fn(),
    setBrushWidthAnchor: vi.fn(),
    setCanvasTargetControlProfileId: vi.fn(),
    setCanvasTargetSelectedSchemeId: vi.fn(),
    setCanvasTargetStageProfiles: vi.fn(),
    setCanvasTargetUserIntent: vi.fn(),
    setCanvasDragPayload: vi.fn(),
    setColorPickerAnchor: vi.fn(),
    setCroppingImageId: vi.fn(),
    setCurrentShortcut: vi.fn(),
    setFigmaFileKeyOrUrlInput: vi.fn(),
    setFileDialogDraftContent: vi.fn(),
    setGroupRenameDraft: vi.fn(),
    setGroupBranches: vi.fn(),
    setInlineTextEdit: vi.fn(),
    setItems: vi.fn(),
    setItemsWithHistory: vi.fn(),
    setLabelDialogItemId: vi.fn(),
    setLabelDialogOpen: vi.fn(),
    setLabelDialogText: vi.fn(),
    setLinePickerAnchor: vi.fn(),
    setRecordedShortcut: vi.fn(),
    setSelectedIds: vi.fn(),
    setShapePickerAnchor: vi.fn(),
    setShortcutDialogOpen: vi.fn(),
    setStagePos: vi.fn(),
    setStageScale: vi.fn(),
    setStageScaleAroundViewportCenter: vi.fn(),
    setTool: vi.fn(),
    setToolShortcutCtxMenu: vi.fn(),
    setToolShortcutRecorded: vi.fn(),
    shapePickerAnchor: null,
    shortcutDialogOpen: false,
    shouldForceShapeCreationCrosshair: false,
    showAnnotationFillToggle: false,
    showAnnotationStrokeControl: false,
    showGrid: false,
    stagePos: { x: 0, y: 0 },
    stageRef: { current: null },
    stageScale: 1,
    stageSize: { width: 1280, height: 720 },
    startGroupPlayback: vi.fn(),
    stopGroupPlayback: vi.fn(),
    t,
    textureImportDialogOpen: false,
    textureInputRef: { current: null },
    theme,
    tool: 'select',
    toolShortcutCtxMenu: null,
    toolShortcutRecorded: '',
    toolShortcuts: {
      select: 'V',
      hand: 'H',
      rect: 'R',
      arrow: 'A',
      freedraw: 'B',
      text: 'T',
      export: 'Ctrl+E'
    },
    transparentPattern: '',
    updateToolShortcut: vi.fn(),
    videoInputRef: { current: null },
    videoItems: [],
    visibleItems: [],
    ...overrides
  }
}

function installPointerCaptureStubs() {
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
    configurable: true,
    value: vi.fn()
  })
  Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', {
    configurable: true,
    value: vi.fn()
  })
}

function clickZoomChip() {
  installPointerCaptureStubs()
  const zoomChip = screen.getByText(/100%/).closest('.MuiChip-root')

  expect(zoomChip).toBeTruthy()

  fireEvent.pointerDown(zoomChip as HTMLElement, { pointerId: 1, clientX: 100 })
  fireEvent.pointerUp(window, { pointerId: 1, clientX: 100 })
}

describe('ProjectCanvasPageTopToolbar', () => {
  it('uses the main save button for direct save and keeps export options behind the adjacent menu trigger', () => {
    const handleSaveCanvas = vi.fn()
    const handleOpenExportMenu = vi.fn()

    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPageTopToolbar
          {...buildBaseProps({
            items: [
              {
                id: 'item-1',
                type: 'text',
                text: 'A',
                x: 0,
                y: 0,
                width: 10,
                height: 10,
                rotation: 0,
                scaleX: 1,
                scaleY: 1,
                zIndex: 1,
                locked: false,
                fontSize: 12,
                fontFamily: 'Arial',
                fill: '#fff'
              }
            ],
            handleSaveCanvas,
            handleOpenExportMenu
          })}
        />
      </ThemeProvider>
    )

    const buttons = screen.getAllByRole('button')
    const saveButton = buttons.find((button) =>
      button.querySelector('[data-testid="FileDownloadIcon"]')
    )
    const menuButton = buttons.find((button) =>
      button.querySelector('[data-testid="ChevronRightIcon"]')
    )

    expect(saveButton).toBeDefined()
    expect(menuButton).toBeDefined()

    fireEvent.click(saveButton as HTMLElement)
    expect(handleSaveCanvas).toHaveBeenCalledTimes(1)
    expect(handleOpenExportMenu).not.toHaveBeenCalled()

    fireEvent.click(menuButton as HTMLElement)
    expect(handleOpenExportMenu).toHaveBeenCalledTimes(1)
  })

  it('keeps the toolbar above overflowing stage overlays', () => {
    const { container } = render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPageTopToolbar {...buildBaseProps()} />
      </ThemeProvider>
    )

    expect(container.firstElementChild).toHaveStyle({
      position: 'relative',
      zIndex: '1'
    })
  })

  it('resets 100% zoom onto a concrete selected item instead of the empty viewport center', () => {
    const setStagePos = vi.fn()
    const setStageScale = vi.fn()
    const setStageScaleAroundViewportCenter = vi.fn()

    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPageTopToolbar
          {...buildBaseProps({
            items: [
              {
                id: 'unselected-nearest',
                type: 'image',
                src: 'ignored.png',
                x: 5450,
                y: 5250,
                width: 100,
                height: 100,
                rotation: 0,
                scaleX: 1,
                scaleY: 1,
                zIndex: 10,
                locked: false
              },
              {
                id: 'selected-far',
                type: 'image',
                src: 'far.png',
                x: 0,
                y: 0,
                width: 100,
                height: 100,
                rotation: 0,
                scaleX: 1,
                scaleY: 1,
                zIndex: 1,
                locked: false
              },
              {
                id: 'selected-near',
                type: 'image',
                src: 'near.png',
                x: 5200,
                y: 5100,
                width: 200,
                height: 100,
                rotation: 0,
                scaleX: 1,
                scaleY: 1,
                zIndex: 2,
                locked: false
              }
            ],
            selectedIds: new Set(['selected-far', 'selected-near']),
            stagePos: { x: -5000, y: -5000 },
            stageScale: 1,
            stageSize: { width: 1000, height: 600 },
            setStagePos,
            setStageScale,
            setStageScaleAroundViewportCenter
          })}
        />
      </ThemeProvider>
    )

    clickZoomChip()

    expect(setStageScale).toHaveBeenCalledWith(1)
    expect(setStagePos).toHaveBeenCalledWith({ x: -4800, y: -4850 })
    expect(setStageScaleAroundViewportCenter).not.toHaveBeenCalled()
  })

  it('falls back to the viewport-centered 100% reset when there is no canvas content', () => {
    const setStagePos = vi.fn()
    const setStageScale = vi.fn()
    const setStageScaleAroundViewportCenter = vi.fn()

    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPageTopToolbar
          {...buildBaseProps({
            selectedIds: new Set(['missing-item']),
            setStagePos,
            setStageScale,
            setStageScaleAroundViewportCenter
          })}
        />
      </ThemeProvider>
    )

    clickZoomChip()

    expect(setStageScaleAroundViewportCenter).toHaveBeenCalledWith(1)
    expect(setStageScale).not.toHaveBeenCalled()
    expect(setStagePos).not.toHaveBeenCalled()
  })

  it('opens the group menu from the toolbar chip and focuses the clicked group', async () => {
    const handleFocusGroup = vi.fn()

    function TestHarness() {
      const [groupMenuAnchor, setGroupMenuAnchor] = React.useState<HTMLElement | null>(null)
      const group = {
        id: 'group-1',
        name: '测试组合',
        itemIds: ['item-1', 'item-2'],
        createdAt: '2026-04-21T00:00:00.000Z',
        validItems: [
          {
            id: 'item-1',
            type: 'image',
            src: 'one.png',
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            zIndex: 1,
            locked: false
          },
          {
            id: 'item-2',
            type: 'image',
            src: 'two.png',
            x: 120,
            y: 0,
            width: 100,
            height: 100,
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            zIndex: 2,
            locked: false
          }
        ],
        validCount: 2,
        totalCount: 2
      }

      const props = buildBaseProps({
        groupMenuAnchor,
        groupSummaries: [group],
        handleOpenGroupMenu: (anchor: HTMLElement) => setGroupMenuAnchor(anchor),
        handleCloseGroupMenu: () => setGroupMenuAnchor(null),
        handleFocusGroup
      })

      return (
        <ThemeProvider theme={theme}>
          <ProjectCanvasPageTopToolbar {...props} />
        </ThemeProvider>
      )
    }

    render(<TestHarness />)

    fireEvent.click(screen.getByRole('button', { name: '组合' }))

    expect(await screen.findByText('测试组合')).toBeInTheDocument()
    expect(screen.getByText('2 / 2 个元素')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '测试组合' }))

    expect(handleFocusGroup).toHaveBeenCalledTimes(1)
    expect(handleFocusGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'group-1',
        name: '测试组合'
      })
    )
  })

  it('still renders the group tree when branch handlers are temporarily missing', async () => {
    const toolbarLabel = createTranslate()('canvas.group_toolbar')
    const group = {
      id: 'group-1',
      name: 'Legacy Group',
      itemIds: ['item-1'],
      createdAt: '2026-04-21T00:00:00.000Z',
      validItems: [],
      validCount: 1,
      totalCount: 1
    }

    function TestHarness() {
      const [groupMenuAnchor, setGroupMenuAnchor] = React.useState<HTMLElement | null>(null)

      const props = buildBaseProps({
        groupBranches: undefined,
        groupMenuAnchor,
        groupSummaries: [group],
        handleCreateGroupBranch: undefined,
        handleDeleteGroupBranch: undefined,
        handleFocusGroupBranch: undefined,
        handleMoveGroupToBranch: undefined,
        handleOpenGroupMenu: (anchor: HTMLElement) => setGroupMenuAnchor(anchor),
        handleCloseGroupMenu: () => setGroupMenuAnchor(null),
        handleRenameGroup: undefined,
        handleRenameGroupBranch: undefined
      })

      return (
        <ThemeProvider theme={theme}>
          <ProjectCanvasPageTopToolbar {...props} />
        </ThemeProvider>
      )
    }

    render(<TestHarness />)

    fireEvent.click(screen.getByRole('button', { name: toolbarLabel }))

    expect(await screen.findByRole('button', { name: 'Legacy Group' })).toBeInTheDocument()
  })

  it('renders the group toolbar chip without the group count suffix', () => {
    const t = createTranslate()
    const toolbarLabel = t('canvas.group_toolbar')

    const props = buildBaseProps({
      groupSummaries: [
        {
          id: 'group-1',
          name: 'Group 1',
          itemIds: ['item-1'],
          createdAt: '2026-04-21T00:00:00.000Z',
          validItems: [],
          validCount: 1,
          totalCount: 1
        }
      ],
      t
    })

    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPageTopToolbar {...props} />
      </ThemeProvider>
    )

    const groupButton = screen.getByRole('button', { name: toolbarLabel })

    expect(groupButton.textContent).toBe(toolbarLabel)
  })
})
