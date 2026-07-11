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

type CanvasPersistenceSnapshot = {
  canvasId: string
  items: CanvasItem[]
  groups: CanvasGroup[]
  groupBranches: CanvasGroupBranch[]
  figmaBinding: CanvasFigmaBinding | null
}

const pendingCanvasSaveById = new Map<string, Promise<void>>()

function rememberPendingCanvasSave(canvasId: string, promise: Promise<void>) {
  pendingCanvasSaveById.set(canvasId, promise)
  void promise
    .finally(() => {
      if (pendingCanvasSaveById.get(canvasId) === promise) {
        pendingCanvasSaveById.delete(canvasId)
      }
    })
    .catch(() => {
      // waitForPendingCanvasSave handles the original promise; this only consumes finally().
    })
}

async function waitForPendingCanvasSave(canvasId: string): Promise<void> {
  const pendingSave = pendingCanvasSaveById.get(canvasId)
  if (!pendingSave) return

  try {
    await pendingSave
  } catch {
    // saveCanvasItems normalizes failures internally; keep restore best-effort if that changes.
  }
}

function areArrayItemsSame<T>(left: readonly T[], right: readonly T[]): boolean {
  return (
    left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
  )
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
  const latestPersistedCanvasStateRef = useRef<CanvasPersistenceSnapshot>({
    canvasId,
    items: [],
    groups: [],
    groupBranches: [],
    figmaBinding: null
  })
  const pendingCanvasSaveTimerRef = useRef<number | null>(null)
  const hasPendingCanvasChangesRef = useRef(false)
  const canvasSaveInFlightRef = useRef<{ canvasId: string; promise: Promise<void> } | null>(null)
  const saveAgainAfterInFlightRef = useRef(false)
  const lastStructuralCanvasSignatureRef = useRef<string | null>(null)
  const isRestoringRef = useRef(false)
  const activeCanvasIdRef = useRef(canvasId)
  const restoreGenerationRef = useRef(0)
  const shouldClearCanvasBeforeRestoreRef = useRef(false)
  const suspendAutoSaveRef = useRef(suspendAutoSave)
  const latestHydrateCanvasImageItemForCanvasRef = useRef(hydrateCanvasImageItemForCanvas)
  const latestNextZIndexRefRef = useRef(nextZIndexRef)
  const [fitTrigger, setFitTrigger] = useState(0)
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false)

  if (activeCanvasIdRef.current !== canvasId) {
    activeCanvasIdRef.current = canvasId
    restoreGenerationRef.current += 1
    isRestoringRef.current = true
    shouldClearCanvasBeforeRestoreRef.current = true
    hasPendingCanvasChangesRef.current = false
    saveAgainAfterInFlightRef.current = false
    lastStructuralCanvasSignatureRef.current = null
  }

  useEffect(() => {
    suspendAutoSaveRef.current = suspendAutoSave
  }, [suspendAutoSave])

  useEffect(() => {
    latestHydrateCanvasImageItemForCanvasRef.current = hydrateCanvasImageItemForCanvas
    latestNextZIndexRefRef.current = nextZIndexRef
  }, [hydrateCanvasImageItemForCanvas, nextZIndexRef])

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
      canvasId,
      items,
      groups,
      groupBranches,
      figmaBinding
    }

    if (!isRestoringRef.current) {
      hasPendingCanvasChangesRef.current = true
    }
  }, [canvasId, figmaBinding, groupBranches, groups, items])

  const clearPendingCanvasSave = useCallback(() => {
    if (pendingCanvasSaveTimerRef.current !== null) {
      window.clearTimeout(pendingCanvasSaveTimerRef.current)
      pendingCanvasSaveTimerRef.current = null
    }
  }, [])

  const persistLatestCanvasState = useCallback(() => {
    if (isRestoringRef.current) return Promise.resolve()

    clearPendingCanvasSave()

    const saveInFlight = canvasSaveInFlightRef.current
    if (saveInFlight?.canvasId === canvasId) {
      saveAgainAfterInFlightRef.current = true
      hasPendingCanvasChangesRef.current = false
      return saveInFlight.promise
    }

    const saveCanvasId = canvasId
    let savePromise: Promise<void> | null = null
    const drainCanvasSaves = async () => {
      try {
        do {
          saveAgainAfterInFlightRef.current = false
          hasPendingCanvasChangesRef.current = false
          const snapshot = latestPersistedCanvasStateRef.current
          if (snapshot.canvasId !== saveCanvasId) {
            break
          }
          await saveCanvasItems(
            snapshot.items,
            saveCanvasId,
            snapshot.groups,
            snapshot.groupBranches,
            snapshot.figmaBinding
          )
        } while (saveAgainAfterInFlightRef.current || hasPendingCanvasChangesRef.current)
      } finally {
        if (savePromise && canvasSaveInFlightRef.current?.promise === savePromise) {
          canvasSaveInFlightRef.current = null
        }
      }
    }

    savePromise = drainCanvasSaves()
    canvasSaveInFlightRef.current = { canvasId: saveCanvasId, promise: savePromise }
    rememberPendingCanvasSave(saveCanvasId, savePromise)
    return savePromise
  }, [canvasId, clearPendingCanvasSave])

  useEffect(() => {
    let cancelled = false
    const restoreGeneration = restoreGenerationRef.current

    const restore = async () => {
      isRestoringRef.current = true
      try {
        clearPendingCanvasSave()
        hasPendingCanvasChangesRef.current = false
        saveAgainAfterInFlightRef.current = false
        lastStructuralCanvasSignatureRef.current = null
        if (shouldClearCanvasBeforeRestoreRef.current) {
          shouldClearCanvasBeforeRestoreRef.current = false
          setItems((currentItems) => (currentItems.length === 0 ? currentItems : []))
          setGroups((currentGroups) => (currentGroups.length === 0 ? currentGroups : []))
          setGroupBranches((currentBranches) =>
            currentBranches.length === 0 ? currentBranches : []
          )
          setSelectedIds((currentSelectedIds) =>
            currentSelectedIds.size === 0 ? currentSelectedIds : new Set()
          )
          setFigmaBinding((currentBinding) => (currentBinding === null ? currentBinding : null))
          latestNextZIndexRefRef.current.current = 1
        }

        await waitForPendingCanvasSave(canvasId)
        if (cancelled || restoreGenerationRef.current !== restoreGeneration) {
          return
        }

        const saved = await loadCanvasItems(canvasId)
        if (cancelled || restoreGenerationRef.current !== restoreGeneration) {
          return
        }

        const restored: CanvasItem[] = []
        let maxZ = 0
        for (const item of saved.items) {
          maxZ = Math.max(maxZ, item.zIndex)
          restored.push(item)
        }

        setItems((currentItems) =>
          areArrayItemsSame(currentItems, restored) ? currentItems : restored
        )
        setGroups((currentGroups) =>
          areArrayItemsSame(currentGroups, saved.groups) ? currentGroups : saved.groups
        )
        setGroupBranches((currentBranches) => {
          const savedBranches = saved.groupBranches || []
          return areArrayItemsSame(currentBranches, savedBranches) ? currentBranches : savedBranches
        })
        setFigmaBinding((currentBinding) =>
          Object.is(currentBinding, saved.figmaBinding) ? currentBinding : saved.figmaBinding
        )
        latestNextZIndexRefRef.current.current = maxZ + 1
        if (restored.length > 0) {
          window.setTimeout(() => {
            if (!cancelled) {
              setFitTrigger(Date.now())
            }
          }, 300)
        }

        if (restored.length === 0) {
          return
        }

        const imageHydrationEntries = await Promise.all(
          saved.items.map(async (item) => {
            if (item.type !== 'image' || !item.src) {
              return null
            }

            const hydratedItem = await latestHydrateCanvasImageItemForCanvasRef.current(item)
            if (!hydratedItem) {
              console.warn('[Canvas] Skipped restoring an image item because hydration failed.')
              return null
            }

            return [item.id, hydratedItem] as const
          })
        )

        if (!cancelled && restoreGenerationRef.current === restoreGeneration) {
          const hydratedImageItems = new Map(
            imageHydrationEntries.filter(
              (entry): entry is readonly [string, CanvasImageItem] => entry !== null
            )
          )

          if (hydratedImageItems.size > 0) {
            setItems((currentItems) => {
              let changed = false
              const nextItems = currentItems.map((item) => {
                const hydratedItem = hydratedImageItems.get(item.id)
                if (!hydratedItem || hydratedItem === item) {
                  return item
                }
                changed = true
                return hydratedItem
              })
              return changed ? nextItems : currentItems
            })
          }
        }
      } catch (error) {
        console.error('[Canvas] Failed to restore canvas state.', error)
      } finally {
        if (restoreGenerationRef.current === restoreGeneration) {
          isRestoringRef.current = false
        }
      }
    }

    void restore()

    return () => {
      cancelled = true
      restoreGenerationRef.current += 1
    }
  }, [
    canvasId,
    clearPendingCanvasSave,
    setFigmaBinding,
    setGroupBranches,
    setGroups,
    setItems,
    setSelectedIds
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
      const input = event.currentTarget
      const files = input.files
      if (!files) return
      const selectedFiles = Array.from(files)
      // Clear the hidden input before the async import pipeline starts. Large Electron/Playwright
      // selections keep the FileList alive until the value is reset, which can retain thousands of
      // file payloads throughout cold thumbnail generation.
      input.value = ''
      try {
        await handleImportFiles(selectedFiles)
      } finally {
        selectedFiles.length = 0
        input.value = ''
      }
    },
    [handleImportFiles]
  )

  const handleModelSelect = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const input = event.currentTarget
      const files = input.files
      if (!files) return
      const selectedFiles = Array.from(files)
      input.value = ''

      try {
        for (let index = 0; index < selectedFiles.length; index += 1) {
          const file = selectedFiles[index]
          selectedFiles[index] = undefined as unknown as File
          await addModel3DToCanvas(file)
        }
      } finally {
        selectedFiles.length = 0
        input.value = ''
      }
    },
    [addModel3DToCanvas]
  )

  const handleVideoSelect = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const input = event.currentTarget
      const files = input.files
      if (!files) return
      const selectedFiles = Array.from(files)
      input.value = ''

      try {
        for (let index = 0; index < selectedFiles.length; index += 1) {
          const file = selectedFiles[index]
          selectedFiles[index] = undefined as unknown as File
          await addVideoToCanvas(file)
        }
      } finally {
        selectedFiles.length = 0
        input.value = ''
      }
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
