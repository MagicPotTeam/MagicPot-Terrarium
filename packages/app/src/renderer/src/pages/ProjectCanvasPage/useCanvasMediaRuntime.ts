/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CanvasItem, CanvasModel3DItem } from './types'
import { CANVAS_3D_RENDER_ACTIVATION_IMMEDIATE_MS } from './canvas3DRenderActivation'

type UseCanvasMediaRuntimeOptions = any

export function useCanvasMediaRuntime(options: UseCanvasMediaRuntimeOptions) {
  const { canvasActiveRef, items, lastClickedIdRef, setItems, setSelectedIds, setTool } = options

  const [textureImportDialogOpen, setTextureImportDialogOpen] = useState(false)
  const [pendingTextureModelId, setPendingTextureModelId] = useState<string | null>(null)
  const [model3DViewerItemId, setModel3DViewerItemId] = useState<string | null>(null)
  const textureInputRef = useRef<HTMLInputElement>(null)
  const modelRenderTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  const activateModel3DRender = useCallback(
    (itemId: string, delay = CANVAS_3D_RENDER_ACTIVATION_IMMEDIATE_MS) => {
      const existingTimer = modelRenderTimersRef.current[itemId]
      if (existingTimer) {
        clearTimeout(existingTimer)
      }

      const commitActivation = () => {
        setItems((prev: CanvasItem[]) =>
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

  useEffect(() => {
    const modelRenderTimers = modelRenderTimersRef.current
    return () => {
      Object.values(modelRenderTimers).forEach((timer) => clearTimeout(timer))
    }
  }, [])

  const activeModel3DItem = useMemo(
    () =>
      model3DViewerItemId
        ? (items.find(
            (item: CanvasItem): item is CanvasModel3DItem =>
              item.id === model3DViewerItemId && item.type === 'model3d'
          ) ?? null)
        : null,
    [items, model3DViewerItemId]
  )

  useEffect(() => {
    if (model3DViewerItemId && !activeModel3DItem) {
      setModel3DViewerItemId(null)
    }
  }, [activeModel3DItem, model3DViewerItemId])

  const handleOpenModel3DViewer = useCallback(
    (itemId: string) => {
      const targetItem = items.find(
        (item: CanvasItem): item is CanvasModel3DItem =>
          item.id === itemId && item.type === 'model3d'
      )
      if (!targetItem) return

      canvasActiveRef.current = true
      lastClickedIdRef.current = itemId
      setTool('select')
      setSelectedIds(new Set([itemId]))
      setModel3DViewerItemId(itemId)
    },
    [canvasActiveRef, items, lastClickedIdRef, setSelectedIds, setTool]
  )

  const handleCloseModel3DViewer = useCallback(() => {
    setModel3DViewerItemId(null)
  }, [])

  const handleRequestModel3DTextureImport = useCallback((item: CanvasModel3DItem) => {
    setPendingTextureModelId(item.id)
    setTextureImportDialogOpen(true)
  }, [])

  const handleCloseTextureImportDialog = useCallback(() => {
    if (pendingTextureModelId) {
      activateModel3DRender(pendingTextureModelId)
    }
    setTextureImportDialogOpen(false)
    setPendingTextureModelId(null)
  }, [activateModel3DRender, pendingTextureModelId])

  const handleSkipTextureImportDialog = useCallback(() => {
    if (pendingTextureModelId) {
      activateModel3DRender(pendingTextureModelId)
    }
    setTextureImportDialogOpen(false)
    setPendingTextureModelId(null)
  }, [activateModel3DRender, pendingTextureModelId])

  const handleOpenTextureImportInput = useCallback(() => {
    textureInputRef.current?.click()
  }, [])

  return {
    activateModel3DRender,
    activeModel3DItem,
    handleCloseModel3DViewer,
    handleCloseTextureImportDialog,
    handleOpenModel3DViewer,
    handleOpenTextureImportInput,
    handleRequestModel3DTextureImport,
    handleSkipTextureImportDialog,
    model3DViewerItemId,
    pendingTextureModelId,
    setModel3DViewerItemId,
    setPendingTextureModelId,
    setTextureImportDialogOpen,
    textureImportDialogOpen,
    textureInputRef
  }
}
