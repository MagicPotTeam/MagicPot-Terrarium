import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from 'react'
import type { Config } from '@shared/config/config'
import type { CanvasFigmaBinding } from '@shared/figma'
import { clearCanvasItems, loadCanvasItems, saveCanvasItems } from './canvasStorage'
import { getExactSelectedGroupBounds, resolveCanvasFitBounds } from './canvasFitBoundsUtils'
import type { CanvasExportBounds } from './groupPlaybackUtils'
import type { CanvasGroup, CanvasGroupBranch, CanvasImageItem, CanvasItem } from './types'

type StagePosition = {
  x: number
  y: number
}

type StageSize = {
  width: number
  height: number
}

type CanvasBounds = {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

type SetItemsWithHistoryFn = (
  updater: CanvasItem[] | ((prev: CanvasItem[]) => CanvasItem[])
) => void

type HydrateCanvasImageItemFn = (item: CanvasImageItem) => Promise<CanvasImageItem | null>

type UseCanvasViewportPersistenceOptions = {
  config: Config
  canvasId: string
  items: CanvasItem[]
  groups: CanvasGroup[]
  groupBranches: CanvasGroupBranch[]
  selectedIds: Set<string>
  figmaBinding: CanvasFigmaBinding | null
  stagePos: StagePosition
  stageScale: number
  stageSize: StageSize
  maxFitStageScale: number
  clampStageScale: (value: number, max?: number) => number
  getCanvasItemsVisualBounds: (targetItems: CanvasItem[]) => CanvasExportBounds | null
  hydrateCanvasImageItemForCanvas: HydrateCanvasImageItemFn
  nextZIndexRef: MutableRefObject<number>
  setItems: Dispatch<SetStateAction<CanvasItem[]>>
  setItemsWithHistory: SetItemsWithHistoryFn
  setGroups: Dispatch<SetStateAction<CanvasGroup[]>>
  setGroupBranches: Dispatch<SetStateAction<CanvasGroupBranch[]>>
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>
  setStagePos: Dispatch<SetStateAction<StagePosition>>
  setStageScale: Dispatch<SetStateAction<number>>
  setFigmaBinding: Dispatch<SetStateAction<CanvasFigmaBinding | null>>
  handleImportFiles: (files: File[]) => Promise<unknown>
  addModel3DToCanvas: (file: File) => Promise<unknown> | unknown
  addVideoToCanvas: (file: File) => Promise<unknown> | unknown
  suspendAutoSave?: boolean
}

function buildCanvasPersistenceStructuralSignature(
  items: CanvasItem[],
  groups: CanvasGroup[],
  groupBranches: CanvasGroupBranch[],
  figmaBinding: CanvasFigmaBinding | null
): string {
  const itemSignature = items
    .map((item) => {
      const src = 'src' in item && typeof item.src === 'string' ? item.src : ''
      const textureSignature =
        item.type === 'model3d' && item.textures
          ? Object.entries(item.textures)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([name, textureSrc]) => `${name}:${textureSrc}`)
              .join('|')
          : ''

      return `${item.id}:${item.type}:${src}:${textureSignature}`
    })
    .join('||')

  const groupSignature = groups
    .map((group) => `${group.id}:${group.name}:${group.branchId ?? ''}:${group.itemIds.join(',')}`)
    .join('||')
  const branchSignature = groupBranches.map((branch) => `${branch.id}:${branch.name}`).join('||')

  return `${itemSignature}__${groupSignature}__${branchSignature}__${JSON.stringify(figmaBinding ?? null)}`
}

export function useCanvasViewportPersistence({
  config,
  canvasId,
  items,
  groups,
  groupBranches,
  selectedIds,
  figmaBinding,
  stagePos,
  stageScale,
  stageSize,
  maxFitStageScale,
  clampStageScale,
  getCanvasItemsVisualBounds,
  hydrateCanvasImageItemForCanvas,
  nextZIndexRef,
  setItems,
  setItemsWithHistory,
  setGroups,
  setGroupBranches,
  setSelectedIds,
  setStagePos,
  setStageScale,
  setFigmaBinding,
  handleImportFiles,
  addModel3DToCanvas,
  addVideoToCanvas,
  suspendAutoSave = false
}: UseCanvasViewportPersistenceOptions) {
  const latestPersistedCanvasStateRef = useRef<{
    items: CanvasItem[]
    groups: CanvasGroup[]
    groupBranches: CanvasGroupBranch[]
    figmaBinding: CanvasFigmaBinding | null
  }>({
    items: [],
    groups: [],
    groupBranches: [],
    figmaBinding: null
  })
  const pendingCanvasSaveTimerRef = useRef<number | null>(null)
  const hasPendingCanvasChangesRef = useRef(false)
  const canvasSaveInFlightRef = useRef<Promise<void> | null>(null)
  const saveAgainAfterInFlightRef = useRef(false)
  const lastStructuralCanvasSignatureRef = useRef<string | null>(null)
  const isRestoringRef = useRef(false)
  const suspendAutoSaveRef = useRef(suspendAutoSave)
  const [fitTrigger, setFitTrigger] = useState(0)
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false)

  useEffect(() => {
    suspendAutoSaveRef.current = suspendAutoSave
  }, [suspendAutoSave])

  const setStageScaleAroundViewportCenter = useCallback(
    (nextScale: number) => {
      if (
        !stageSize.width ||
        !stageSize.height ||
        !Number.isFinite(stageScale) ||
        stageScale === 0
      ) {
        setStageScale(nextScale)
        return
      }

      const centerCanvasX = (stageSize.width / 2 - stagePos.x) / stageScale
      const centerCanvasY = (stageSize.height / 2 - stagePos.y) / stageScale

      setStageScale(nextScale)
      setStagePos({
        x: stageSize.width / 2 - centerCanvasX * nextScale,
        y: stageSize.height / 2 - centerCanvasY * nextScale
      })
    },
    [
      setStagePos,
      setStageScale,
      stagePos.x,
      stagePos.y,
      stageScale,
      stageSize.height,
      stageSize.width
    ]
  )

  const focusCanvasBounds = useCallback(
    (bounds: CanvasBounds | null, padding: number = 60) => {
      if (!bounds || !stageSize.width || !stageSize.height) return

      const width = Math.max(bounds.maxX - bounds.minX, 1)
      const height = Math.max(bounds.maxY - bounds.minY, 1)
      const availableWidth = Math.max(stageSize.width - padding * 2, 1)
      const availableHeight = Math.max(stageSize.height - padding * 2, 1)
      const scale = clampStageScale(
        Math.min(availableWidth / width, availableHeight / height, maxFitStageScale),
        maxFitStageScale
      )
      const cx = (bounds.minX + bounds.maxX) / 2
      const cy = (bounds.minY + bounds.maxY) / 2

      setStageScale(scale)
      setStagePos({
        x: stageSize.width / 2 - cx * scale,
        y: stageSize.height / 2 - cy * scale
      })
    },
    [
      clampStageScale,
      maxFitStageScale,
      setStagePos,
      setStageScale,
      stageSize.height,
      stageSize.width
    ]
  )

  const handleFitAll = useCallback(() => {
    if (items.length === 0) {
      setStagePos({ x: 0, y: 0 })
      setStageScale(1)
      return
    }

    focusCanvasBounds(
      resolveCanvasFitBounds({
        items,
        selectedIds,
        exactSelectedGroupBounds: getExactSelectedGroupBounds({
          groups,
          items,
          selectedIds,
          getCanvasItemsVisualBounds
        }),
        getCanvasItemsVisualBounds
      })
    )
  }, [
    focusCanvasBounds,
    getCanvasItemsVisualBounds,
    groups,
    items,
    selectedIds,
    setStagePos,
    setStageScale
  ])

  const handleClear = useCallback(() => {
    for (const item of items) {
      if (item.type === 'model3d' || item.type === 'video' || item.type === 'file') {
        URL.revokeObjectURL(item.src)
      }
    }

    setItemsWithHistory([])
    setGroups([])
    setGroupBranches([])
    setSelectedIds(new Set())
    clearCanvasItems(canvasId).catch(() => {
      /* ignore */
    })
  }, [canvasId, items, setGroupBranches, setGroups, setItemsWithHistory, setSelectedIds])

  const openClearConfirmDialog = useCallback(() => {
    setClearConfirmOpen(true)
  }, [])

  const closeClearConfirmDialog = useCallback(() => {
    setClearConfirmOpen(false)
  }, [])

  const handleConfirmClearDialog = useCallback(() => {
    handleClear()
    setClearConfirmOpen(false)
  }, [handleClear])

  useEffect(() => {
    latestPersistedCanvasStateRef.current = {
      items,
      groups,
      groupBranches,
      figmaBinding
    }

    if (!isRestoringRef.current) {
      hasPendingCanvasChangesRef.current = true
    }
  }, [figmaBinding, groupBranches, groups, items])

  const clearPendingCanvasSave = useCallback(() => {
    if (pendingCanvasSaveTimerRef.current !== null) {
      window.clearTimeout(pendingCanvasSaveTimerRef.current)
      pendingCanvasSaveTimerRef.current = null
    }
  }, [])

  const persistLatestCanvasState = useCallback(() => {
    if (isRestoringRef.current) return Promise.resolve()

    clearPendingCanvasSave()

    if (canvasSaveInFlightRef.current) {
      saveAgainAfterInFlightRef.current = true
      hasPendingCanvasChangesRef.current = false
      return canvasSaveInFlightRef.current
    }

    const drainCanvasSaves = async () => {
      try {
        do {
          saveAgainAfterInFlightRef.current = false
          hasPendingCanvasChangesRef.current = false
          const snapshot = latestPersistedCanvasStateRef.current
          await saveCanvasItems(
            snapshot.items,
            canvasId,
            snapshot.groups,
            snapshot.groupBranches,
            snapshot.figmaBinding
          )
        } while (saveAgainAfterInFlightRef.current || hasPendingCanvasChangesRef.current)
      } finally {
        canvasSaveInFlightRef.current = null
      }
    }

    canvasSaveInFlightRef.current = drainCanvasSaves()
    return canvasSaveInFlightRef.current
  }, [canvasId, clearPendingCanvasSave])

  useEffect(() => {
    let cancelled = false

    const restore = async () => {
      isRestoringRef.current = true
      try {
        const saved = await loadCanvasItems(canvasId)
        if (cancelled || saved.items.length === 0) {
          if (!cancelled) {
            setGroups(saved.groups)
            setGroupBranches(saved.groupBranches || [])
            setFigmaBinding(saved.figmaBinding)
          }
          isRestoringRef.current = false
          return
        }

        const restored: CanvasItem[] = []
        let maxZ = 0
        for (const item of saved.items) {
          maxZ = Math.max(maxZ, item.zIndex)
          restored.push(item)
        }

        if (!cancelled) {
          setItems(restored)
          setGroups(saved.groups)
          setGroupBranches(saved.groupBranches || [])
          setFigmaBinding(saved.figmaBinding)
          nextZIndexRef.current = maxZ + 1
          if (restored.length > 0) {
            window.setTimeout(() => {
              if (!cancelled) {
                setFitTrigger(Date.now())
              }
            }, 300)
          }
        }

        const imageHydrationEntries = await Promise.all(
          saved.items.map(async (item) => {
            if (item.type !== 'image' || !item.src) {
              return null
            }

            const hydratedItem = await hydrateCanvasImageItemForCanvas(item)
            if (!hydratedItem) {
              console.warn('[Canvas] Skipped restoring an image item because hydration failed.')
              return null
            }

            return [item.id, hydratedItem] as const
          })
        )

        if (!cancelled) {
          const hydratedImageItems = new Map(
            imageHydrationEntries.filter(
              (entry): entry is readonly [string, CanvasImageItem] => entry !== null
            )
          )

          if (hydratedImageItems.size > 0) {
            setItems((currentItems) =>
              currentItems.map((item) => hydratedImageItems.get(item.id) ?? item)
            )
          }
        }
      } catch (error) {
        console.error('[Canvas] Failed to restore canvas state.', error)
      } finally {
        isRestoringRef.current = false
      }
    }

    void restore()

    return () => {
      cancelled = true
    }
  }, [
    canvasId,
    hydrateCanvasImageItemForCanvas,
    nextZIndexRef,
    setFigmaBinding,
    setGroupBranches,
    setGroups,
    setItems
  ])

  useEffect(() => {
    if (isRestoringRef.current) return

    const nextStructuralSignature = buildCanvasPersistenceStructuralSignature(
      items,
      groups,
      groupBranches,
      figmaBinding
    )

    if (lastStructuralCanvasSignatureRef.current === null) {
      lastStructuralCanvasSignatureRef.current = nextStructuralSignature
      return
    }

    if (lastStructuralCanvasSignatureRef.current === nextStructuralSignature) {
      return
    }

    lastStructuralCanvasSignatureRef.current = nextStructuralSignature
  }, [figmaBinding, groupBranches, groups, items])

  useEffect(() => {
    if (!hasPendingCanvasChangesRef.current) return

    clearPendingCanvasSave()
    if (suspendAutoSave) {
      return clearPendingCanvasSave
    }

    pendingCanvasSaveTimerRef.current = window.setTimeout(() => {
      void persistLatestCanvasState()
    }, 250)

    return clearPendingCanvasSave
  }, [
    clearPendingCanvasSave,
    figmaBinding,
    groupBranches,
    groups,
    items,
    persistLatestCanvasState,
    suspendAutoSave
  ])

  useEffect(() => {
    const flushPendingCanvasSave = (force = false) => {
      if (!hasPendingCanvasChangesRef.current) return
      if (!force && suspendAutoSaveRef.current) return
      void persistLatestCanvasState()
    }

    const handleVisibilityChange = () => {
      if (document.hidden) {
        flushPendingCanvasSave()
      }
    }

    const handleWindowBlur = () => {
      flushPendingCanvasSave()
    }
    const handlePageExit = () => {
      flushPendingCanvasSave(true)
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('blur', handleWindowBlur)
    window.addEventListener('beforeunload', handlePageExit)
    window.addEventListener('pagehide', handlePageExit)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('blur', handleWindowBlur)
      window.removeEventListener('beforeunload', handlePageExit)
      window.removeEventListener('pagehide', handlePageExit)
    }
  }, [persistLatestCanvasState])

  useEffect(
    () => () => {
      if (isRestoringRef.current) return

      if (hasPendingCanvasChangesRef.current) {
        void persistLatestCanvasState()
        return
      }

      clearPendingCanvasSave()
      void persistLatestCanvasState()
    },
    [canvasId, clearPendingCanvasSave, persistLatestCanvasState]
  )

  useEffect(() => {
    if (fitTrigger > 0 && items.length > 0) {
      handleFitAll()
      setFitTrigger(0)
    }
  }, [fitTrigger, handleFitAll, items.length])

  const handleFileSelect = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files
      if (!files) return
      await handleImportFiles(Array.from(files))
      event.target.value = ''
    },
    [handleImportFiles]
  )

  const handleModelSelect = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files
      if (!files) return

      for (const file of Array.from(files)) {
        await addModel3DToCanvas(file)
      }

      event.target.value = ''
    },
    [addModel3DToCanvas]
  )

  const handleVideoSelect = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files
      if (!files) return

      for (const file of Array.from(files)) {
        await addVideoToCanvas(file)
      }

      event.target.value = ''
    },
    [addVideoToCanvas]
  )

  return {
    clearConfirmOpen,
    closeClearConfirmDialog,
    focusCanvasBounds,
    handleConfirmClearDialog,
    handleFileSelect,
    handleFitAll,
    handleModelSelect,
    handleVideoSelect,
    openClearConfirmDialog,
    setStageScaleAroundViewportCenter
  }
}
