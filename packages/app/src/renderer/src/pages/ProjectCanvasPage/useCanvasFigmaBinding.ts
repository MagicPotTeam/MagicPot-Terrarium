import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from 'react'
import type { CanvasFigmaBinding } from '@shared/figma'
import { api } from '../../utils/windowUtils'
import { getCenteredViewportPosition } from './canvasViewportPlacementUtils'
import { getCanvasItemsBounds, type CanvasTool } from './projectCanvasPageShared'
import type { CanvasGroup, CanvasImageItem, CanvasItem } from './types'

type NotifyFn = (message: string) => unknown

type ViewportBounds = {
  x: number
  y: number
  width: number
  height: number
}

type UseCanvasFigmaBindingOptions = {
  isChineseUi: boolean
  figmaAccessToken: string
  figmaGlobalAutoCheckEnabled: boolean
  figmaAutoCheckIntervalMinutes: number
  items: CanvasItem[]
  nextZIndexRef: MutableRefObject<number>
  getViewportBounds: () => ViewportBounds
  hydrateCanvasImageItemForCanvas: (item: CanvasImageItem) => Promise<CanvasImageItem | null>
  setItems: Dispatch<SetStateAction<CanvasItem[]>>
  setGroups: Dispatch<SetStateAction<CanvasGroup[]>>
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>
  setTool: Dispatch<SetStateAction<CanvasTool>>
  notifySuccess: NotifyFn
  notifyWarning: NotifyFn
  notifyInfo: NotifyFn
}

export function useCanvasFigmaBinding({
  isChineseUi,
  figmaAccessToken,
  figmaGlobalAutoCheckEnabled,
  figmaAutoCheckIntervalMinutes,
  items,
  nextZIndexRef,
  getViewportBounds,
  hydrateCanvasImageItemForCanvas,
  setItems,
  setGroups,
  setSelectedIds,
  setTool,
  notifySuccess,
  notifyWarning,
  notifyInfo
}: UseCanvasFigmaBindingOptions) {
  const [figmaBinding, setFigmaBinding] = useState<CanvasFigmaBinding | null>(null)
  const figmaBindingRef = useRef<CanvasFigmaBinding | null>(null)
  const [figmaBindingDialogOpen, setFigmaBindingDialogOpen] = useState(false)
  const [figmaBindingDraft, setFigmaBindingDraft] = useState<CanvasFigmaBinding | null>(null)
  const [figmaFileKeyOrUrlInput, setFigmaFileKeyOrUrlInput] = useState('')
  const [figmaBusyAction, setFigmaBusyAction] = useState<
    'resolve' | 'bind' | 'sync' | 'check' | null
  >(null)
  const [figmaBindingError, setFigmaBindingError] = useState<string | null>(null)

  useEffect(() => {
    figmaBindingRef.current = figmaBinding
  }, [figmaBinding])

  const buildNextFigmaBindingDraft = useCallback(
    ({
      fileKey,
      fileName,
      pages,
      fileKeyOrUrl,
      version,
      lastModified,
      previous
    }: {
      fileKey: string
      fileName: string
      pages: CanvasFigmaBinding['pages']
      fileKeyOrUrl: string
      version?: string
      lastModified?: string
      previous?: CanvasFigmaBinding | null
    }): CanvasFigmaBinding => {
      const selectedPage =
        pages.find((page) => page.nodeId === previous?.pageNodeId) || pages[0] || undefined

      return {
        fileKey,
        fileName,
        fileUrl: fileKeyOrUrl.trim() || previous?.fileUrl || fileKey,
        pageNodeId: selectedPage?.nodeId,
        pageName: selectedPage?.name,
        pages,
        autoCheckUpdates: previous?.autoCheckUpdates ?? figmaGlobalAutoCheckEnabled,
        lastSyncedAt: previous?.lastSyncedAt,
        lastCheckedAt: previous?.lastCheckedAt,
        lastKnownVersion: version ?? previous?.lastKnownVersion,
        lastKnownModifiedAt: lastModified ?? previous?.lastKnownModifiedAt,
        updateAvailable: previous?.updateAvailable ?? false
      }
    },
    [figmaGlobalAutoCheckEnabled]
  )

  const handleOpenFigmaBindingDialog = useCallback(() => {
    setFigmaBindingDialogOpen(true)
    setFigmaBindingError(null)
    setFigmaBusyAction(null)
    setFigmaBindingDraft(figmaBinding ? { ...figmaBinding } : null)
    setFigmaFileKeyOrUrlInput(figmaBinding?.fileUrl || figmaBinding?.fileKey || '')
  }, [figmaBinding])

  const handleCloseFigmaBindingDialog = useCallback(() => {
    if (figmaBusyAction) return
    setFigmaBindingDialogOpen(false)
    setFigmaBindingError(null)
    setFigmaBusyAction(null)
  }, [figmaBusyAction])

  const handleResolveFigmaBinding = useCallback(async () => {
    const normalizedInput = figmaFileKeyOrUrlInput.trim()
    if (!figmaAccessToken) {
      const message = isChineseUi
        ? '请先在 设置 > 环境部署 中配置 Figma Personal Access Token。'
        : 'Set the Figma Personal Access Token in Settings > Environment first.'
      setFigmaBindingError(message)
      notifyWarning(message)
      return
    }
    if (!normalizedInput) {
      const message = isChineseUi
        ? '请输入 Figma 文件链接或 File Key。'
        : 'Enter a Figma file link or File Key.'
      setFigmaBindingError(message)
      return
    }

    setFigmaBusyAction('resolve')
    setFigmaBindingError(null)
    try {
      const resolved = await api().svcFigma.resolveFile({
        accessToken: figmaAccessToken,
        fileKeyOrUrl: normalizedInput
      })
      setFigmaBindingDraft((prev) =>
        buildNextFigmaBindingDraft({
          fileKey: resolved.fileKey,
          fileName: resolved.fileName,
          pages: resolved.pages,
          fileKeyOrUrl: normalizedInput,
          version: resolved.version,
          lastModified: resolved.lastModified,
          previous: prev ?? figmaBinding
        })
      )
    } catch (error) {
      setFigmaBindingError(error instanceof Error ? error.message : String(error))
    } finally {
      setFigmaBusyAction(null)
    }
  }, [
    buildNextFigmaBindingDraft,
    figmaAccessToken,
    figmaBinding,
    figmaFileKeyOrUrlInput,
    isChineseUi,
    notifyWarning
  ])

  const handleFigmaDraftPageChange = useCallback((pageNodeId: string) => {
    setFigmaBindingDraft((prev) => {
      if (!prev) return prev
      const nextPage = prev.pages.find((page) => page.nodeId === pageNodeId)
      return {
        ...prev,
        pageNodeId,
        pageName: nextPage?.name || prev.pageName
      }
    })
  }, [])

  const handleFigmaDraftAutoCheckUpdatesChange = useCallback((value: boolean) => {
    setFigmaBindingDraft((prev) => (prev ? { ...prev, autoCheckUpdates: value } : prev))
  }, [])

  const handleSaveFigmaBinding = useCallback(() => {
    if (!figmaBindingDraft) return
    setFigmaBusyAction('bind')
    setFigmaBinding(figmaBindingDraft)
    setFigmaBindingDialogOpen(false)
    setFigmaBusyAction(null)
    notifySuccess(
      isChineseUi
        ? `已绑定 Figma 文件：${figmaBindingDraft.fileName}`
        : `Bound Figma file: ${figmaBindingDraft.fileName}`
    )
  }, [figmaBindingDraft, isChineseUi, notifySuccess])

  const handleUnbindFigmaBinding = useCallback(() => {
    setFigmaBinding(null)
    setFigmaBindingDraft(null)
    setFigmaFileKeyOrUrlInput('')
    setFigmaBindingError(null)
    setFigmaBindingDialogOpen(false)
    notifyInfo(
      isChineseUi
        ? '已解除当前画布的 Figma 绑定，画布里的现有元素会保留。'
        : 'Removed the Figma binding from this canvas. Existing canvas elements were kept.'
    )
  }, [isChineseUi, notifyInfo])

  const runFigmaUpdateCheck = useCallback(
    async (candidate: CanvasFigmaBinding, silent: boolean = false) => {
      if (!figmaAccessToken || !candidate.fileKey) return

      if (!silent) {
        setFigmaBusyAction('check')
      }
      setFigmaBindingError(null)

      try {
        const response = await api().svcFigma.checkFileUpdate({
          accessToken: figmaAccessToken,
          fileKey: candidate.fileKey,
          knownLastModified: candidate.lastKnownModifiedAt,
          knownVersion: candidate.lastKnownVersion
        })

        const checkedAt = new Date().toISOString()
        let shouldNotifyUpdate = false

        setFigmaBinding((prev) => {
          if (!prev || prev.fileKey !== candidate.fileKey) return prev
          const selectedPage =
            response.pages.find((page) => page.nodeId === prev.pageNodeId) || response.pages[0]
          shouldNotifyUpdate = response.hasUpdate && !prev.updateAvailable
          return {
            ...prev,
            fileName: response.fileName,
            pages: response.pages,
            pageNodeId: selectedPage?.nodeId || prev.pageNodeId,
            pageName: selectedPage?.name || prev.pageName,
            lastCheckedAt: checkedAt,
            lastKnownVersion: prev.lastKnownVersion || response.version,
            lastKnownModifiedAt: prev.lastKnownModifiedAt || response.lastModified,
            updateAvailable: response.hasUpdate || prev.updateAvailable
          }
        })

        setFigmaBindingDraft((prev) => {
          if (!prev || prev.fileKey !== candidate.fileKey) return prev
          const selectedPage =
            response.pages.find((page) => page.nodeId === prev.pageNodeId) || response.pages[0]
          return {
            ...prev,
            fileName: response.fileName,
            pages: response.pages,
            pageNodeId: selectedPage?.nodeId || prev.pageNodeId,
            pageName: selectedPage?.name || prev.pageName,
            lastCheckedAt: checkedAt,
            lastKnownVersion: prev.lastKnownVersion || response.version,
            lastKnownModifiedAt: prev.lastKnownModifiedAt || response.lastModified,
            updateAvailable: response.hasUpdate || prev.updateAvailable
          }
        })

        if (shouldNotifyUpdate && !silent) {
          notifyInfo(
            isChineseUi
              ? `Figma 文件 ${response.fileName} 有新版本可用，点击同步即可刷新当前画布。`
              : `A newer version of "${response.fileName}" is available. Click sync to refresh the canvas.`
          )
        }
      } catch (error) {
        if (!silent) {
          setFigmaBindingError(error instanceof Error ? error.message : String(error))
        }
      } finally {
        if (!silent) {
          setFigmaBusyAction(null)
        }
      }
    },
    [figmaAccessToken, isChineseUi, notifyInfo]
  )

  const handleCheckFigmaUpdate = useCallback(async () => {
    const candidate = figmaBindingDraft || figmaBinding
    if (!candidate) return
    await runFigmaUpdateCheck(candidate, false)
  }, [figmaBinding, figmaBindingDraft, runFigmaUpdateCheck])

  const handleSyncFigmaBinding = useCallback(async () => {
    const candidate = figmaBindingDraft || figmaBinding
    if (!candidate) return
    if (!figmaAccessToken) {
      const message = isChineseUi
        ? '请先在 设置 > 环境部署 中配置 Figma Personal Access Token。'
        : 'Set the Figma Personal Access Token in Settings > Environment first.'
      setFigmaBindingError(message)
      notifyWarning(message)
      return
    }

    setFigmaBusyAction('sync')
    setFigmaBindingError(null)
    try {
      const response = await api().svcFigma.syncFile({
        accessToken: figmaAccessToken,
        fileKeyOrUrl: candidate.fileUrl || candidate.fileKey,
        pageNodeId: candidate.pageNodeId
      })

      const importedAt = new Date().toISOString()
      const sourceItems = response.items.map(
        (item): CanvasImageItem => ({
          id: `figma-${response.fileKey}-${item.nodeId}-${Math.random().toString(36).slice(2, 8)}`,
          type: 'image',
          src: item.src,
          fileName: item.fileName,
          x: item.x,
          y: item.y,
          width: item.width,
          height: item.height,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          zIndex: 0,
          locked: false,
          sourceWidth: item.width,
          sourceHeight: item.height,
          provenance: {
            kind: 'figma',
            sourceFileName: response.fileName,
            sourceDocumentId: response.fileKey,
            sourceNodeId: item.nodeId,
            ...(item.nodeName ? { sourceNodeName: item.nodeName } : {}),
            importedAt
          }
        })
      )

      const currentFigmaItems = items.filter(
        (item) =>
          item.provenance?.kind === 'figma' &&
          item.provenance?.sourceDocumentId === response.fileKey
      )
      const currentFigmaBounds = getCanvasItemsBounds(currentFigmaItems)
      const importedBounds = getCanvasItemsBounds(sourceItems)

      const positionedItems =
        importedBounds && sourceItems.length > 0
          ? (() => {
              const importedWidth = importedBounds.maxX - importedBounds.minX
              const importedHeight = importedBounds.maxY - importedBounds.minY
              const targetPosition = currentFigmaBounds
                ? { x: currentFigmaBounds.minX, y: currentFigmaBounds.minY }
                : getCenteredViewportPosition(getViewportBounds(), {
                    width: importedWidth,
                    height: importedHeight
                  })
              const offsetX = targetPosition.x - importedBounds.minX
              const offsetY = targetPosition.y - importedBounds.minY
              return sourceItems.map((item) => ({
                ...item,
                x: item.x + offsetX,
                y: item.y + offsetY
              }))
            })()
          : sourceItems

      const restored: CanvasItem[] = []
      let maxZ = nextZIndexRef.current
      for (const item of positionedItems) {
        const hydratedItem = await hydrateCanvasImageItemForCanvas({
          ...item,
          zIndex: maxZ++
        })
        if (hydratedItem) {
          restored.push(hydratedItem)
        }
      }
      nextZIndexRef.current = maxZ

      const nextBinding: CanvasFigmaBinding = {
        ...candidate,
        fileKey: response.fileKey,
        fileName: response.fileName,
        pages: response.pages,
        pageNodeId: response.pageNodeId,
        pageName: response.pageName,
        lastSyncedAt: importedAt,
        lastCheckedAt: importedAt,
        lastKnownVersion: response.version,
        lastKnownModifiedAt: response.lastModified,
        updateAvailable: false
      }

      setFigmaBinding(nextBinding)
      setFigmaBindingDraft(nextBinding)
      setItems((prev) => [
        ...prev.filter(
          (item) =>
            !(
              item.provenance?.kind === 'figma' &&
              item.provenance?.sourceDocumentId === response.fileKey
            )
        ),
        ...restored
      ])
      setGroups((prev) =>
        prev.filter((group) => group.provenance?.sourceDocumentId !== response.fileKey)
      )
      setSelectedIds(new Set(restored.map((item) => item.id)))
      setTool('select')

      if (response.warnings.length > 0) {
        notifyWarning(
          isChineseUi
            ? `Figma 已同步到当前画布，共恢复 ${restored.length} 个元素，并产生 ${response.warnings.length} 条警告。`
            : `Synced ${restored.length} Figma item(s) to the canvas with ${response.warnings.length} warning(s).`
        )
      } else {
        notifySuccess(
          isChineseUi
            ? `Figma 已同步到当前画布，共恢复 ${restored.length} 个元素。`
            : `Synced ${restored.length} Figma item(s) to the canvas.`
        )
      }
    } catch (error) {
      setFigmaBindingError(error instanceof Error ? error.message : String(error))
    } finally {
      setFigmaBusyAction(null)
    }
  }, [
    figmaAccessToken,
    figmaBinding,
    figmaBindingDraft,
    getViewportBounds,
    hydrateCanvasImageItemForCanvas,
    isChineseUi,
    items,
    nextZIndexRef,
    notifySuccess,
    notifyWarning,
    setGroups,
    setItems,
    setSelectedIds,
    setTool
  ])

  useEffect(() => {
    if (!figmaBinding?.fileKey) return
    if (!figmaAccessToken) return
    if (!figmaGlobalAutoCheckEnabled) return
    if (!figmaBinding.autoCheckUpdates) return

    let disposed = false
    let checkInFlight = false
    const checkForUpdates = async () => {
      if (disposed || checkInFlight) return
      const currentBinding = figmaBindingRef.current
      if (!currentBinding?.fileKey || !currentBinding.autoCheckUpdates) return
      const candidate: CanvasFigmaBinding = {
        ...currentBinding,
        pages: [...currentBinding.pages]
      }
      checkInFlight = true
      try {
        await runFigmaUpdateCheck(candidate, true)
      } finally {
        checkInFlight = false
      }
    }

    void checkForUpdates()
    const timer = window.setInterval(
      () => void checkForUpdates(),
      figmaAutoCheckIntervalMinutes * 60 * 1000
    )

    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [
    figmaAccessToken,
    figmaAutoCheckIntervalMinutes,
    figmaBinding?.autoCheckUpdates,
    figmaBinding?.fileKey,
    figmaGlobalAutoCheckEnabled,
    runFigmaUpdateCheck
  ])

  return {
    figmaBinding,
    setFigmaBinding,
    figmaBindingDialogOpen,
    figmaBusyAction,
    figmaBindingError,
    figmaFileKeyOrUrlInput,
    setFigmaFileKeyOrUrlInput,
    figmaDialogBinding: figmaBindingDraft || figmaBinding,
    handleOpenFigmaBindingDialog,
    handleCloseFigmaBindingDialog,
    handleResolveFigmaBinding,
    handleFigmaDraftPageChange,
    handleFigmaDraftAutoCheckUpdatesChange,
    handleSaveFigmaBinding,
    handleUnbindFigmaBinding,
    handleCheckFigmaUpdate,
    handleSyncFigmaBinding
  }
}
