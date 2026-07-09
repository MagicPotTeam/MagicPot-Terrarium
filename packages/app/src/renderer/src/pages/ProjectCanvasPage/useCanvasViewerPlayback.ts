import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEventHandler,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from 'react'

import { removeCanvasItemsWithAttachedCaptions } from './canvasAttachedCaptionUtils'
import { useCanvasSpatialIndexLifecycle } from './useCanvasSpatialIndexLifecycle'
import type { CanvasTool } from './projectCanvasPageShared'
import type { CanvasHtmlItem, CanvasItem, CanvasModel3DItem, CanvasVideoItem } from './types'
import {
  buildCanvasPlaybackVisibilitySpatialIndex,
  buildTextureObjectUrlMap,
  resolveActiveModel3DItem,
  resolvePlayableVideoItems,
  resolveRenderableHtmlItems,
  resolveRenderedModel3DItems,
  resolveVisibleCanvasItems
} from './canvasViewerPlaybackUtils'
import { CANVAS_3D_RENDER_ACTIVATION_IMMEDIATE_MS } from './canvas3DRenderActivation'

type NotifyFn = (message: string) => unknown

type PlaybackGroupState = {
  itemIds: string[]
} | null

type UseCanvasViewerPlaybackOptions = {
  canvasActiveRef: MutableRefObject<boolean>
  forceRenderAllItemsForExport?: boolean
  groupPlayback: PlaybackGroupState
  isViewportInteracting?: boolean
  items: CanvasItem[]
  lastClickedIdRef: MutableRefObject<string | null>
  notifyError?: NotifyFn
  selectedIds: Set<string>
  setItems: Dispatch<SetStateAction<CanvasItem[]>>
  setItemsWithHistory: Dispatch<SetStateAction<CanvasItem[]>>
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>
  setTool: Dispatch<SetStateAction<CanvasTool>>
  sortedItems: CanvasItem[]
  stagePos: { x: number; y: number }
  stageScale: number
  stageSize?: { width: number; height: number } | null
  model3DViewerItemId?: string | null
  pendingTextureModelId?: string | null
  textureImportDialogOpen?: boolean
  setModel3DViewerItemId?: Dispatch<SetStateAction<string | null>>
  setPendingTextureModelId?: Dispatch<SetStateAction<string | null>>
  setTextureImportDialogOpen?: Dispatch<SetStateAction<boolean>>
  textureInputRef?: MutableRefObject<HTMLInputElement | null>
}

export function useCanvasViewerPlayback({
  canvasActiveRef,
  forceRenderAllItemsForExport = false,
  groupPlayback,
  isViewportInteracting = false,
  items,
  lastClickedIdRef,
  notifyError,
  selectedIds,
  setItems,
  setItemsWithHistory,
  setSelectedIds,
  setTool,
  sortedItems,
  stagePos,
  stageScale,
  stageSize,
  model3DViewerItemId: controlledModel3DViewerItemId,
  pendingTextureModelId: controlledPendingTextureModelId,
  textureImportDialogOpen: controlledTextureImportDialogOpen,
  setModel3DViewerItemId: controlledSetModel3DViewerItemId,
  setPendingTextureModelId: controlledSetPendingTextureModelId,
  setTextureImportDialogOpen: controlledSetTextureImportDialogOpen,
  textureInputRef: controlledTextureInputRef
}: UseCanvasViewerPlaybackOptions) {
  const [uncontrolledTextureImportDialogOpen, setUncontrolledTextureImportDialogOpen] =
    useState(false)
  const [uncontrolledPendingTextureModelId, setUncontrolledPendingTextureModelId] = useState<
    string | null
  >(null)
  const [uncontrolledModel3DViewerItemId, setUncontrolledModel3DViewerItemId] = useState<
    string | null
  >(null)
  const uncontrolledTextureInputRef = useRef<HTMLInputElement>(null)
  const modelRenderTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  const textureImportDialogOpen =
    controlledTextureImportDialogOpen ?? uncontrolledTextureImportDialogOpen
  const pendingTextureModelId = controlledPendingTextureModelId ?? uncontrolledPendingTextureModelId
  const model3DViewerItemId = controlledModel3DViewerItemId ?? uncontrolledModel3DViewerItemId
  const setTextureImportDialogOpen =
    controlledSetTextureImportDialogOpen ?? setUncontrolledTextureImportDialogOpen
  const setPendingTextureModelId =
    controlledSetPendingTextureModelId ?? setUncontrolledPendingTextureModelId
  const setModel3DViewerItemId =
    controlledSetModel3DViewerItemId ?? setUncontrolledModel3DViewerItemId
  const textureInputRef = controlledTextureInputRef ?? uncontrolledTextureInputRef

  const activateModel3DRender = useCallback(
    (itemId: string, delay = CANVAS_3D_RENDER_ACTIVATION_IMMEDIATE_MS) => {
      const existingTimer = modelRenderTimersRef.current[itemId]
      if (existingTimer) {
        clearTimeout(existingTimer)
      }

      const commitActivation = () => {
        setItems((prev) =>
          prev.map((item) =>
            item.id === itemId && item.type === 'model3d'
              ? ({ ...item, deferRender: false } as CanvasModel3DItem)
              : item
          )
        )
        delete modelRenderTimersRef.current[itemId]
      }

      if (delay <= 0) {
        commitActivation()
        return
      }

      modelRenderTimersRef.current[itemId] = setTimeout(commitActivation, delay)
    },
    [setItems]
  )

  useEffect(
    () => () => {
      Object.values(modelRenderTimersRef.current).forEach((timer) => clearTimeout(timer))
    },
    []
  )

  const deferredStagePos = useDeferredValue(stagePos)
  const deferredStageScale = useDeferredValue(stageScale)
  const deferredStageSize = useDeferredValue(stageSize)
  const visibleStagePos = isViewportInteracting ? deferredStagePos : stagePos
  const visibleStageScale = isViewportInteracting ? deferredStageScale : stageScale
  const visibleStageSize = isViewportInteracting ? deferredStageSize : stageSize

  const playbackVisibilitySpatialIndex = useMemo(
    () =>
      buildCanvasPlaybackVisibilitySpatialIndex({
        groupPlaybackItemIds: groupPlayback?.itemIds,
        sortedItems
      }),
    [groupPlayback?.itemIds, sortedItems]
  )

  useCanvasSpatialIndexLifecycle(playbackVisibilitySpatialIndex)

  const { itemById, itemOrderById } = useMemo(() => {
    return {
      itemById: new Map<string, CanvasItem>(sortedItems.map((item) => [item.id, item] as const)),
      itemOrderById: new Map<string, number>(
        sortedItems.map((item, index) => [item.id, index] as const)
      )
    }
  }, [sortedItems])

  const visibleItems = useMemo(
    () =>
      resolveVisibleCanvasItems({
        forceRenderAllItemsForExport,
        groupPlaybackItemIds: groupPlayback?.itemIds,
        itemById,
        itemOrderById,
        selectedIds,
        spatialIndex: playbackVisibilitySpatialIndex,
        sortedItems,
        stagePos: visibleStagePos,
        stageScale: visibleStageScale,
        stageSize: visibleStageSize
      }),
    [
      forceRenderAllItemsForExport,
      groupPlayback?.itemIds,
      itemById,
      itemOrderById,
      playbackVisibilitySpatialIndex,
      selectedIds,
      sortedItems,
      visibleStagePos,
      visibleStageScale,
      visibleStageSize
    ]
  )

  const renderedModel3DItems = useMemo(
    () =>
      resolveRenderedModel3DItems({
        forceRenderAllItemsForExport,
        groupPlaybackItemIds: groupPlayback?.itemIds,
        sortedItems,
        visibleItems
      }),
    [forceRenderAllItemsForExport, groupPlayback?.itemIds, sortedItems, visibleItems]
  )

  const videoItems = useMemo(
    () =>
      resolvePlayableVideoItems({
        groupPlaybackItemIds: groupPlayback?.itemIds,
        sortedItems
      }),
    [groupPlayback?.itemIds, sortedItems]
  )

  const htmlItems = useMemo(
    () =>
      resolveRenderableHtmlItems({
        forceRenderAllItemsForExport,
        groupPlaybackItemIds: groupPlayback?.itemIds,
        sortedItems,
        visibleItems
      }),
    [forceRenderAllItemsForExport, groupPlayback?.itemIds, sortedItems, visibleItems]
  )

  const activeModel3DItem = useMemo(
    () => resolveActiveModel3DItem(items, model3DViewerItemId),
    [items, model3DViewerItemId]
  )

  useEffect(() => {
    if (model3DViewerItemId && !activeModel3DItem) {
      setModel3DViewerItemId(null)
    }
  }, [activeModel3DItem, model3DViewerItemId, setModel3DViewerItemId])

  const handleOpenModel3DViewer = useCallback(
    (itemId: string) => {
      const targetItem = items.find(
        (item): item is CanvasModel3DItem => item.id === itemId && item.type === 'model3d'
      )
      if (!targetItem) return

      canvasActiveRef.current = true
      lastClickedIdRef.current = itemId
      setTool('select')
      setSelectedIds(new Set([itemId]))
      setModel3DViewerItemId(itemId)
    },
    [canvasActiveRef, items, lastClickedIdRef, setModel3DViewerItemId, setSelectedIds, setTool]
  )

  const handleCloseModel3DViewer = useCallback(() => {
    setModel3DViewerItemId(null)
  }, [setModel3DViewerItemId])

  const handleRequestModel3DTextureImport = useCallback(
    (item: CanvasModel3DItem) => {
      setPendingTextureModelId(item.id)
      setTextureImportDialogOpen(true)
    },
    [setPendingTextureModelId, setTextureImportDialogOpen]
  )

  const finalizeTextureImportDialog = useCallback(
    (targetId: string | null) => {
      if (targetId) {
        activateModel3DRender(targetId)
      }

      setTextureImportDialogOpen(false)
      setPendingTextureModelId(null)
    },
    [activateModel3DRender, setPendingTextureModelId, setTextureImportDialogOpen]
  )

  const handleCloseTextureImportDialog = useCallback(() => {
    finalizeTextureImportDialog(pendingTextureModelId)
  }, [finalizeTextureImportDialog, pendingTextureModelId])

  const handleSkipTextureImportDialog = useCallback(() => {
    finalizeTextureImportDialog(pendingTextureModelId)
  }, [finalizeTextureImportDialog, pendingTextureModelId])

  const handleOpenTextureImportInput = useCallback(() => {
    textureInputRef.current?.click()
  }, [textureInputRef])

  const handleUpdateModel3DTextures = useCallback(
    (itemId: string, textures: Record<string, string>) => {
      setItemsWithHistory((prev) =>
        prev.map((item) =>
          item.id === itemId && item.type === 'model3d' ? { ...item, textures } : item
        )
      )
    },
    [setItemsWithHistory]
  )

  const handleTextureFilesSelected: ChangeEventHandler<HTMLInputElement> = useCallback(
    (event) => {
      const files = event.target.files
      if (!files || files.length === 0 || !pendingTextureModelId) return

      const textures = buildTextureObjectUrlMap(Array.from(files))
      if (Object.keys(textures).length > 0) {
        handleUpdateModel3DTextures(pendingTextureModelId, textures)
      } else {
        notifyError?.('No usable texture files were selected.')
      }

      finalizeTextureImportDialog(pendingTextureModelId)
      event.target.value = ''
    },
    [finalizeTextureImportDialog, handleUpdateModel3DTextures, notifyError, pendingTextureModelId]
  )

  const handleUpdateVideoItem = useCallback(
    (id: string, updates: Partial<CanvasVideoItem>) => {
      setItems((prev) =>
        prev.map((item) =>
          item.id === id && item.type === 'video' ? { ...item, ...updates } : item
        )
      )
    },
    [setItems]
  )

  const handleToggleVideoPlayback = useCallback(
    (item: CanvasVideoItem) => {
      handleUpdateVideoItem(item.id, { playing: !item.playing })
    },
    [handleUpdateVideoItem]
  )

  const handleUpdateHtmlItem = useCallback(
    (id: string, updates: Partial<CanvasHtmlItem>) => {
      setItemsWithHistory((prev) =>
        prev.map((item) =>
          item.id === id && item.type === 'html' ? { ...item, ...updates } : item
        )
      )
    },
    [setItemsWithHistory]
  )

  const handleDeleteHtmlItem = useCallback(
    (id: string) => {
      setItemsWithHistory((prev) => removeCanvasItemsWithAttachedCaptions(prev, [id]).nextItems)
      setSelectedIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    },
    [setItemsWithHistory, setSelectedIds]
  )

  return {
    activateModel3DRender,
    activeModel3DItem,
    handleCloseModel3DViewer,
    handleCloseTextureImportDialog,
    handleDeleteHtmlItem,
    handleOpenModel3DViewer,
    handleOpenTextureImportInput,
    handleRequestModel3DTextureImport,
    handleSkipTextureImportDialog,
    handleTextureFilesSelected,
    handleToggleVideoPlayback,
    handleUpdateHtmlItem,
    handleUpdateModel3DTextures,
    handleUpdateVideoItem,
    htmlItems,
    model3DViewerItemId,
    pendingTextureModelId,
    renderedModel3DItems,
    setModel3DViewerItemId,
    setPendingTextureModelId,
    setTextureImportDialogOpen,
    textureImportDialogOpen,
    textureInputRef,
    videoItems,
    visibleItems
  }
}
