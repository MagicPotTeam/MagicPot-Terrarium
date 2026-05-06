import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type Dispatch,
  type SetStateAction
} from 'react'
import type { TFunction } from 'i18next'

import {
  buildNormalizedDefaultGroupName,
  shouldRepairNormalizedDefaultGroupName
} from './canvasGroupNameUtils'
import { detectSpatialGridLayout } from './groupAutoArrangeUtils'
import {
  buildGroupPlaybackGif,
  orderGroupItemsByGroupIds,
  type CanvasExportBounds
} from './groupPlaybackUtils'
import { buildVisibleGroupSummaries, type CanvasGroupSummary } from './groupMenuUtils'
import { getCanvasItemsBounds, type CanvasTool } from './projectCanvasPageShared'
import type {
  CanvasGroup,
  CanvasImageItem,
  CanvasItem,
  CanvasModel3DItem,
  CanvasVideoItem
} from './types'

const GROUP_PLAYBACK_IMAGE_FPS = 25
const GROUP_PLAYBACK_MODEL3D_MS = 3000
const GROUP_PLAYBACK_VIDEO_SAFETY_MS = 10 * 60 * 1000

type NotifyFn = (message: string) => unknown

type GroupPlaybackMediaItem = CanvasImageItem | CanvasVideoItem | CanvasModel3DItem

type CanvasFocusBounds = {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

type CanvasSelectionRect = {
  startX: number
  startY: number
  x: number
  y: number
  w: number
  h: number
} | null

export type CanvasGroupPlaybackState = {
  groupId: string
  groupName: string
  itemIds: string[]
  currentIndex: number
  paused: boolean
}

export type CanvasSelectionOverlayGroup = CanvasGroupSummary & {
  bounds: CanvasExportBounds
  selectedMemberIds: string[]
}

type UseCanvasGroupPlaybackOptions = {
  groups: CanvasGroup[]
  items: CanvasItem[]
  selectedIds: Set<string>
  language?: string | null
  getCanvasItemsVisualBounds: (targetItems: CanvasItem[]) => CanvasExportBounds | null
  canvasBoundsToStageRect: (bounds: CanvasExportBounds | null) => CanvasExportBounds | null
  focusCanvasBounds: (bounds: CanvasFocusBounds | null, padding?: number) => void
  handleCloseGroupMenu: () => void
  lastClickedIdRef: MutableRefObject<string | null>
  setItems: Dispatch<SetStateAction<CanvasItem[]>>
  setModel3DViewerItemId: Dispatch<SetStateAction<string | null>>
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>
  setSelectionRect: Dispatch<SetStateAction<CanvasSelectionRect>>
  setTool: Dispatch<SetStateAction<CanvasTool>>
  notifyInfo: NotifyFn
  notifySuccess: NotifyFn
  notifyError: NotifyFn
  t: TFunction
  isChineseUi: boolean
}

export function useCanvasGroupPlayback({
  groups,
  items,
  selectedIds,
  language,
  getCanvasItemsVisualBounds,
  canvasBoundsToStageRect,
  focusCanvasBounds,
  handleCloseGroupMenu,
  lastClickedIdRef,
  setItems,
  setModel3DViewerItemId,
  setSelectedIds,
  setSelectionRect,
  setTool,
  notifyInfo,
  notifySuccess,
  notifyError,
  t,
  isChineseUi
}: UseCanvasGroupPlaybackOptions) {
  const [groupPlayback, setGroupPlayback] = useState<CanvasGroupPlaybackState | null>(null)
  const groupPlaybackTimerRef = useRef<number | null>(null)

  const resolveDisplayGroupName = useCallback(
    (group: CanvasGroup, index: number) =>
      shouldRepairNormalizedDefaultGroupName(group.name)
        ? buildNormalizedDefaultGroupName(group.defaultIndex ?? index + 1, language)
        : group.name,
    [language]
  )

  const resetCanvasSelectionForPlayback = useCallback(() => {
    setTool('select')
    setSelectionRect(null)
    setSelectedIds(new Set())
    lastClickedIdRef.current = null
  }, [lastClickedIdRef, setSelectedIds, setSelectionRect, setTool])

  const clearPlaybackViewerTarget = useCallback(() => {
    setModel3DViewerItemId(null)
  }, [setModel3DViewerItemId])

  const groupSummaries = useMemo(
    () =>
      buildVisibleGroupSummaries(groups, items).map((group, index) => ({
        ...group,
        name: resolveDisplayGroupName(group, index)
      })),
    [groups, items, resolveDisplayGroupName]
  )

  const activeGroupPlaybackItemId = groupPlayback?.itemIds[groupPlayback.currentIndex] ?? null
  const activeGroupPlaybackItem = useMemo(
    () =>
      activeGroupPlaybackItemId
        ? (items.find(
            (item): item is GroupPlaybackMediaItem =>
              item.id === activeGroupPlaybackItemId &&
              (item.type === 'image' || item.type === 'video' || item.type === 'model3d')
          ) ?? null)
        : null,
    [activeGroupPlaybackItemId, items]
  )

  const activeGroupPlaybackGroup = useMemo(
    () =>
      groupPlayback
        ? (groupSummaries.find((group) => group.id === groupPlayback.groupId) ?? null)
        : null,
    [groupPlayback, groupSummaries]
  )

  const activeGroupPlaybackCanvasBounds = useMemo(() => {
    if (!activeGroupPlaybackGroup) return null
    const validItems = activeGroupPlaybackGroup.validItems
    if (validItems.length === 0) return null
    const fullBounds = getCanvasItemsVisualBounds(validItems)
    if (!fullBounds) return null
    const playbackItems = validItems.filter(
      (item): item is GroupPlaybackMediaItem =>
        item.type === 'image' || item.type === 'video' || item.type === 'model3d'
    )
    if (playbackItems.length === 0) return fullBounds

    const maxItemW = Math.max(
      1,
      ...playbackItems.map((item) => Math.abs(item.width * (item.scaleX || 1)))
    )
    const maxItemH = Math.max(
      1,
      ...playbackItems.map((item) => Math.abs(item.height * (item.scaleY || 1)))
    )

    return {
      x: fullBounds.x + fullBounds.width / 2 - maxItemW / 2,
      y: fullBounds.y + fullBounds.height / 2 - maxItemH / 2,
      width: maxItemW,
      height: maxItemH
    }
  }, [activeGroupPlaybackGroup, getCanvasItemsVisualBounds])

  const activeGroupPlaybackScreenBounds = useMemo(
    () => canvasBoundsToStageRect(activeGroupPlaybackCanvasBounds),
    [activeGroupPlaybackCanvasBounds, canvasBoundsToStageRect]
  )

  const activeSelectionGroups = useMemo(
    () =>
      groupSummaries
        .map((group) => {
          const selectedMemberIds = group.validItems
            .filter((item) => selectedIds.has(item.id))
            .map((item) => item.id)
          const bounds = getCanvasItemsVisualBounds(group.validItems)

          return selectedMemberIds.length > 0 && bounds
            ? {
                ...group,
                bounds,
                selectedMemberIds
              }
            : null
        })
        .filter((group): group is CanvasSelectionOverlayGroup => Boolean(group)),
    [getCanvasItemsVisualBounds, groupSummaries, selectedIds]
  )

  const exactSelectedGroup = useMemo(
    () =>
      activeSelectionGroups.find(
        (group) =>
          group.validItems.length > 0 &&
          group.validItems.length === selectedIds.size &&
          group.validItems.every((item) => selectedIds.has(item.id))
      ) ?? null,
    [activeSelectionGroups, selectedIds]
  )

  const selectionOverlayGroups = useMemo(() => {
    if (selectedIds.size > 1) return []
    return activeSelectionGroups
  }, [activeSelectionGroups, selectedIds.size])

  const clearGroupPlaybackTimer = useCallback(() => {
    if (groupPlaybackTimerRef.current !== null) {
      window.clearTimeout(groupPlaybackTimerRef.current)
      groupPlaybackTimerRef.current = null
    }
  }, [])

  const setGroupPlaybackVideoId = useCallback(
    (videoId: string | null) => {
      setItems((prev) => {
        let changed = false
        const next = prev.map((item) => {
          if (item.type !== 'video') return item
          const shouldPlay = item.id === videoId
          if ((item as CanvasVideoItem).playing === shouldPlay) return item
          changed = true
          return { ...item, playing: shouldPlay }
        }) as CanvasItem[]
        return changed ? next : prev
      })
    },
    [setItems]
  )

  const stopGroupPlayback = useCallback(() => {
    clearGroupPlaybackTimer()
    setGroupPlayback(null)
    setGroupPlaybackVideoId(null)
    clearPlaybackViewerTarget()
  }, [clearGroupPlaybackTimer, clearPlaybackViewerTarget, setGroupPlaybackVideoId])

  const pauseGroupPlayback = useCallback(() => {
    clearGroupPlaybackTimer()
    setGroupPlayback((prev) => (prev ? { ...prev, paused: true } : prev))
    setGroupPlaybackVideoId(null)
    clearPlaybackViewerTarget()
  }, [clearGroupPlaybackTimer, clearPlaybackViewerTarget, setGroupPlaybackVideoId])

  const resumeGroupPlayback = useCallback(() => {
    setGroupPlayback((prev) => (prev ? { ...prev, paused: false } : prev))
  }, [])

  const handleExportGroupPlaybackAsGif = useCallback(async () => {
    if (!groupPlayback) return
    const groupItems = orderGroupItemsByGroupIds(
      groupPlayback.itemIds,
      items as GroupPlaybackMediaItem[]
    )
    if (groupItems.length === 0) return

    notifyInfo(
      t('canvas.export_gif_loading', {
        defaultValue: 'Preparing GIF export. Large selections may take a moment...'
      })
    )

    try {
      const blob = await buildGroupPlaybackGif(groupItems, {
        width: 512,
        height: 512,
        imageDelay: 800
      })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${groupPlayback.groupName || 'group'}-export.gif`
      anchor.click()
      URL.revokeObjectURL(url)
      notifySuccess(
        t('canvas.export_gif_success', {
          defaultValue: 'GIF \u5bfc\u51fa\u6210\u529f\u3002'
        })
      )
    } catch (error) {
      console.error(error)
      notifyError(
        t('canvas.export_gif_failed', {
          defaultValue: 'GIF \u5bfc\u51fa\u5931\u8d25\u3002'
        })
      )
    }
  }, [groupPlayback, items, notifyError, notifyInfo, notifySuccess, t])

  const handleGroupPlaybackVideoEnded = useCallback(() => {
    clearGroupPlaybackTimer()
    setGroupPlayback((prev) => {
      if (!prev || prev.paused) return prev
      if (prev.itemIds.length === 0) return null
      return { ...prev, currentIndex: (prev.currentIndex + 1) % prev.itemIds.length }
    })
  }, [clearGroupPlaybackTimer])

  const startGroupPlayback = useCallback(
    (group: CanvasGroupSummary) => {
      const unsortedPlaybackItems = group.itemIds
        .map((itemId) => group.validItems.find((item) => item.id === itemId) ?? null)
        .filter(
          (item): item is GroupPlaybackMediaItem =>
            item?.type === 'image' || item?.type === 'video' || item?.type === 'model3d'
        )

      const spatialEntries = unsortedPlaybackItems.map((item, index) => ({
        index,
        minX: item.x,
        minY: item.y,
        width: Math.abs(item.width * (item.scaleX || 1)),
        height: Math.abs(item.height * (item.scaleY || 1))
      }))
      const { assignments } = detectSpatialGridLayout(spatialEntries)
      const playbackItems = assignments.map((assignment) => unsortedPlaybackItems[assignment.index])

      if (playbackItems.length === 0) {
        notifyError(
          isChineseUi
            ? '\u5f53\u524d\u5206\u7ec4\u4e2d\u6ca1\u6709\u53ef\u64ad\u653e\u7684\u5a92\u4f53\u5143\u7d20\u3002'
            : 'No playable media items found in this group.'
        )
        return
      }

      clearGroupPlaybackTimer()
      setGroupPlaybackVideoId(null)
      clearPlaybackViewerTarget()
      resetCanvasSelectionForPlayback()
      const fullBounds = getCanvasItemsBounds(group.validItems)
      if (fullBounds && playbackItems.length > 0) {
        const maxItemW = Math.max(
          1,
          ...playbackItems.map((item) => Math.abs(item.width * (item.scaleX || 1)))
        )
        const maxItemH = Math.max(
          1,
          ...playbackItems.map((item) => Math.abs(item.height * (item.scaleY || 1)))
        )
        const cx = (fullBounds.minX + fullBounds.maxX) / 2
        const cy = (fullBounds.minY + fullBounds.maxY) / 2
        focusCanvasBounds(
          {
            minX: cx - maxItemW / 2,
            minY: cy - maxItemH / 2,
            maxX: cx + maxItemW / 2,
            maxY: cy + maxItemH / 2
          },
          120
        )
      } else if (fullBounds) {
        focusCanvasBounds(fullBounds, 120)
      }
      handleCloseGroupMenu()
      setGroupPlayback({
        groupId: group.id,
        groupName: group.name,
        itemIds: playbackItems.map((item) => item.id),
        currentIndex: 0,
        paused: false
      })
    },
    [
      clearGroupPlaybackTimer,
      clearPlaybackViewerTarget,
      focusCanvasBounds,
      handleCloseGroupMenu,
      isChineseUi,
      notifyError,
      resetCanvasSelectionForPlayback,
      setGroupPlaybackVideoId
    ]
  )

  useEffect(() => {
    if (groupPlayback) return

    clearGroupPlaybackTimer()
    setGroupPlaybackVideoId(null)
    clearPlaybackViewerTarget()
  }, [clearGroupPlaybackTimer, clearPlaybackViewerTarget, groupPlayback, setGroupPlaybackVideoId])

  useEffect(() => {
    clearGroupPlaybackTimer()
    if (!groupPlayback || groupPlayback.paused) return

    const currentItemId = groupPlayback.itemIds[groupPlayback.currentIndex]
    const currentItem = items.find((item) => item.id === currentItemId) ?? null

    if (!currentItem) {
      const nextValidIndex = groupPlayback.itemIds.findIndex((itemId) =>
        items.some((item) => item.id === itemId)
      )

      if (nextValidIndex === -1) {
        setGroupPlayback(null)
        setGroupPlaybackVideoId(null)
        clearPlaybackViewerTarget()
        return
      }

      setGroupPlayback((prev) => {
        if (!prev) return prev
        const searchNext = (prev.currentIndex + 1) % prev.itemIds.length
        return { ...prev, currentIndex: searchNext }
      })
      return
    }

    resetCanvasSelectionForPlayback()
    setGroupPlaybackVideoId(null)
    clearPlaybackViewerTarget()

    let delayMs = 1000 / GROUP_PLAYBACK_IMAGE_FPS
    if (currentItem.type === 'video') {
      delayMs = GROUP_PLAYBACK_VIDEO_SAFETY_MS
    } else if (currentItem.type === 'model3d') {
      delayMs = GROUP_PLAYBACK_MODEL3D_MS
    }

    groupPlaybackTimerRef.current = window.setTimeout(() => {
      setGroupPlayback((prev) => {
        if (!prev) return prev
        if (prev.itemIds.length === 0) return null
        const nextIndex = (prev.currentIndex + 1) % prev.itemIds.length
        return { ...prev, currentIndex: nextIndex }
      })
    }, delayMs)

    return clearGroupPlaybackTimer
  }, [
    clearGroupPlaybackTimer,
    clearPlaybackViewerTarget,
    groupPlayback,
    items,
    resetCanvasSelectionForPlayback,
    setGroupPlaybackVideoId
  ])

  return {
    activeGroupPlaybackCanvasBounds,
    activeGroupPlaybackGroup,
    activeGroupPlaybackItem,
    activeGroupPlaybackScreenBounds,
    exactSelectedGroup,
    groupPlayback,
    groupSummaries,
    handleExportGroupPlaybackAsGif,
    handleGroupPlaybackVideoEnded,
    pauseGroupPlayback,
    resumeGroupPlayback,
    selectionOverlayGroups,
    startGroupPlayback,
    stopGroupPlayback
  }
}
