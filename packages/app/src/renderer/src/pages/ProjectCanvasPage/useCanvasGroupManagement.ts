import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from 'react'
import { resolveAutoArrangeSpatialGridLayout } from './groupAutoArrangeUtils'
import { normalizeGroupNameDraft } from './groupMenuUtils'
import { buildNormalizedDefaultGroupName } from './canvasGroupNameUtils'
import {
  applyCanvasGroupBranchDeletion,
  findFirstCanvasGroupInBranch,
  moveCanvasGroupToBranch,
  realignCanvasGroupsIntoBranchRow
} from './groupTreeUtils'
import {
  getCanvasItemBounds,
  getCanvasItemsBounds,
  translateCanvasItem,
  type CanvasTool
} from './projectCanvasPageShared'
import type { CanvasGroup, CanvasGroupBranch, CanvasItem } from './types'
import type { SelectionRect } from './useCanvasTargetWorkflow'

type CanvasBounds = {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

type NotifyFn = (message: string) => unknown

type TranslateFn = (key: string, options?: Record<string, unknown>) => string

type UseCanvasGroupManagementOptions = {
  groups: CanvasGroup[]
  groupBranches: CanvasGroupBranch[]
  items: CanvasItem[]
  selectedIds: Set<string>
  setGroups: Dispatch<SetStateAction<CanvasGroup[]>>
  setGroupBranches: Dispatch<SetStateAction<CanvasGroupBranch[]>>
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>
  setTool: Dispatch<SetStateAction<CanvasTool>>
  setSelectionRect: Dispatch<SetStateAction<SelectionRect | null>>
  setItemsWithHistory: (items: CanvasItem[]) => void
  focusCanvasBounds: (bounds: CanvasBounds | null, padding?: number) => void
  lastClickedIdRef: MutableRefObject<string | null>
  language?: string | null
  notifyError: NotifyFn
  notifyWarning: NotifyFn
  t: TranslateFn
}

export function useCanvasGroupManagement({
  groups,
  groupBranches,
  items,
  selectedIds,
  setGroups,
  setGroupBranches,
  setSelectedIds,
  setTool,
  setSelectionRect,
  setItemsWithHistory,
  focusCanvasBounds,
  lastClickedIdRef,
  language,
  notifyError,
  notifyWarning,
  t
}: UseCanvasGroupManagementOptions) {
  const [groupMenuAnchor, setGroupMenuAnchor] = useState<HTMLElement | null>(null)
  const [groupRenameId, setGroupRenameId] = useState<string | null>(null)
  const [groupRenameDraft, setGroupRenameDraft] = useState('')
  const groupRenameInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!groupRenameId) return

    const rafId = window.requestAnimationFrame(() => {
      const input = groupRenameInputRef.current
      if (!input) return
      input.focus()
      input.select()
    })

    return () => window.cancelAnimationFrame(rafId)
  }, [groupRenameId])

  const handleCancelGroupRename = useCallback(() => {
    setGroupRenameId(null)
    setGroupRenameDraft('')
  }, [])

  const handleCloseGroupMenu = useCallback(() => {
    handleCancelGroupRename()
    setGroupMenuAnchor(null)
  }, [handleCancelGroupRename])

  const handleOpenGroupMenu = useCallback((anchor: HTMLElement) => {
    setGroupMenuAnchor(anchor)
  }, [])

  const handleStartGroupRename = useCallback((group: Pick<CanvasGroup, 'id' | 'name'>) => {
    setGroupRenameId(group.id)
    setGroupRenameDraft(group.name)
  }, [])

  const handleCommitGroupRename = useCallback(
    (groupId: string, fallbackName: string) => {
      const nextName = normalizeGroupNameDraft(groupRenameDraft, fallbackName)

      setGroups((prev) =>
        prev.map((group) =>
          group.id === groupId && group.name !== nextName ? { ...group, name: nextName } : group
        )
      )
      handleCancelGroupRename()
    },
    [groupRenameDraft, handleCancelGroupRename, setGroups]
  )

  const handleRenameGroup = useCallback(
    (groupId: string, nextNameDraft: string) => {
      const fallbackName = groups.find((group) => group.id === groupId)?.name ?? ''
      const nextName = normalizeGroupNameDraft(nextNameDraft, fallbackName)
      if (!nextName) return

      setGroups((prev) =>
        prev.map((group) =>
          group.id === groupId && group.name !== nextName ? { ...group, name: nextName } : group
        )
      )
      if (groupRenameId === groupId) {
        handleCancelGroupRename()
      }
    },
    [groupRenameId, groups, handleCancelGroupRename, setGroups]
  )

  const handleCreateGroupBranch = useCallback(
    (nameDraft?: string) => {
      const defaultName = t('canvas.group_branch_default_name', {
        index: groupBranches.length + 1,
        defaultValue: `Branch ${groupBranches.length + 1}`
      })
      const nextBranch: CanvasGroupBranch = {
        id: `group-branch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: normalizeGroupNameDraft(nameDraft ?? '', defaultName),
        createdAt: new Date().toISOString()
      }

      setGroupBranches((prev) => [...prev, nextBranch])
      return nextBranch
    },
    [groupBranches.length, setGroupBranches, t]
  )

  const handleRenameGroupBranch = useCallback(
    (branchId: string, nextNameDraft: string) => {
      const fallbackName =
        groupBranches.find((branch) => branch.id === branchId)?.name ||
        t('canvas.group_branch_default_name', {
          index: groupBranches.length,
          defaultValue: 'Branch'
        })
      const nextName = normalizeGroupNameDraft(nextNameDraft, fallbackName)
      if (!nextName) return

      setGroupBranches((prev) =>
        prev.map((branch) =>
          branch.id === branchId && branch.name !== nextName
            ? { ...branch, name: nextName }
            : branch
        )
      )
    },
    [groupBranches, setGroupBranches, t]
  )

  const handleDeleteGroupBranch = useCallback(
    (branchId: string | null) => {
      const { nextGroups, nextGroupBranches } = applyCanvasGroupBranchDeletion({
        groups,
        groupBranches,
        branchId
      })

      setGroupBranches(nextGroupBranches)
      setGroups(nextGroups)
    },
    [groupBranches, groups, setGroupBranches, setGroups]
  )

  const autoArrangeGroupItems = useCallback(
    (group: CanvasGroup) => {
      const targetItems = items.filter((item) => group.itemIds.includes(item.id))
      if (targetItems.length === 0) {
        notifyError(t('canvas.group_missing_items'))
        return
      }

      setSelectionRect(null)
      const layoutEntries = targetItems.map((item, index) => {
        const bounds = getCanvasItemBounds(item)
        return {
          item,
          index,
          bounds,
          width: Math.max(bounds.maxX - bounds.minX, 1),
          height: Math.max(bounds.maxY - bounds.minY, 1)
        }
      })

      const groupBounds = getCanvasItemsBounds(targetItems)
      if (!groupBounds) {
        notifyError(t('canvas.group_missing_items'))
        return
      }

      const spatialGrid = resolveAutoArrangeSpatialGridLayout(
        layoutEntries.map((entry) => ({
          index: entry.index,
          minX: entry.bounds.minX,
          minY: entry.bounds.minY,
          width: entry.width,
          height: entry.height
        }))
      )

      const columns = spatialGrid.columns
      const rows = spatialGrid.rows
      const gap = 4
      const columnWidths = Array.from({ length: columns }, () => 0)
      const rowHeights = Array.from({ length: rows }, () => 0)

      for (const assignment of spatialGrid.assignments) {
        const entry = layoutEntries[assignment.index]
        columnWidths[assignment.col] = Math.max(columnWidths[assignment.col], entry.width)
        rowHeights[assignment.row] = Math.max(rowHeights[assignment.row], entry.height)
      }

      const columnOffsets = columnWidths.map((_, columnIndex) => {
        let offset = 0
        for (let index = 0; index < columnIndex; index += 1) {
          offset += columnWidths[index] + gap
        }
        return offset
      })
      const rowOffsets = rowHeights.map((_, rowIndex) => {
        let offset = 0
        for (let index = 0; index < rowIndex; index += 1) {
          offset += rowHeights[index] + gap
        }
        return offset
      })

      const arrangedItemsById = new Map<string, CanvasItem>()
      const orderedItems: CanvasItem[] = []
      for (const assignment of spatialGrid.assignments) {
        const entry = layoutEntries[assignment.index]
        const targetMinX = groupBounds.minX + columnOffsets[assignment.col]
        const targetMinY = groupBounds.minY + rowOffsets[assignment.row]
        const dx = targetMinX - entry.bounds.minX
        const dy = targetMinY - entry.bounds.minY
        const translated = translateCanvasItem(entry.item, dx, dy)
        arrangedItemsById.set(entry.item.id, translated)
        orderedItems.push(translated)
      }

      const nextItems = items.map((item) => arrangedItemsById.get(item.id) || item)
      const arrangedItemIds = orderedItems.map((item) => item.id)

      setItemsWithHistory(nextItems)
      setGroups((prev) =>
        prev.map((candidate) =>
          candidate.id === group.id ? { ...candidate, itemIds: arrangedItemIds } : candidate
        )
      )
      setTool('select')
      setSelectedIds(new Set(arrangedItemIds))
      lastClickedIdRef.current = arrangedItemIds[arrangedItemIds.length - 1] ?? null
      focusCanvasBounds(getCanvasItemsBounds(orderedItems), 120)
      handleCloseGroupMenu()
    },
    [
      focusCanvasBounds,
      handleCloseGroupMenu,
      items,
      lastClickedIdRef,
      notifyError,
      setGroups,
      setItemsWithHistory,
      setSelectedIds,
      setSelectionRect,
      setTool,
      t
    ]
  )

  const handleCreateGroup = useCallback(() => {
    const validSelectedIds = items.filter((item) => selectedIds.has(item.id)).map((item) => item.id)
    if (validSelectedIds.length === 0) {
      notifyError(t('canvas.group_create_empty'))
      return
    }

    const conflictingGroupIds = groups
      .filter((group) => group.itemIds.some((itemId) => validSelectedIds.includes(itemId)))
      .map((group) => group.id)
    if (conflictingGroupIds.length > 0) {
      notifyWarning(t('canvas.group_conflict'))
      setGroups((prev) =>
        prev
          .map((group) => {
            if (!conflictingGroupIds.includes(group.id)) return group
            const remainingIds = group.itemIds.filter((id) => !validSelectedIds.includes(id))
            return { ...group, itemIds: remainingIds }
          })
          .filter((group) => group.itemIds.length > 0)
      )
    }

    const nextIndex =
      groups.reduce((maxValue, group) => Math.max(maxValue, group.defaultIndex ?? 0), 0) + 1
    const nextGroup: CanvasGroup = {
      id: `group-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: buildNormalizedDefaultGroupName(nextIndex, language),
      itemIds: validSelectedIds,
      createdAt: new Date().toISOString(),
      branchId: null,
      defaultIndex: nextIndex
    }

    setGroups((prev) => [...prev, nextGroup])
    autoArrangeGroupItems(nextGroup)
  }, [
    autoArrangeGroupItems,
    groups,
    items,
    language,
    notifyError,
    notifyWarning,
    selectedIds,
    setGroups,
    t
  ])

  const handleFocusGroup = useCallback(
    (group: CanvasGroup) => {
      const targetItems = items.filter((item) => group.itemIds.includes(item.id))
      if (targetItems.length === 0) {
        notifyError(t('canvas.group_missing_items'))
        return
      }

      setTool('select')
      setSelectionRect(null)
      setSelectedIds(new Set(targetItems.map((item) => item.id)))
      lastClickedIdRef.current = targetItems[targetItems.length - 1]?.id || null
      focusCanvasBounds(getCanvasItemsBounds(targetItems), 120)
      handleCloseGroupMenu()
    },
    [
      focusCanvasBounds,
      handleCloseGroupMenu,
      items,
      lastClickedIdRef,
      notifyError,
      setSelectedIds,
      setSelectionRect,
      setTool,
      t
    ]
  )

  const handleFocusGroupBranch = useCallback(
    (branchId: string | null) => {
      const firstGroup = findFirstCanvasGroupInBranch(groups, groupBranches, branchId)
      if (!firstGroup) {
        handleCloseGroupMenu()
        return
      }

      handleFocusGroup(firstGroup)
    },
    [groupBranches, groups, handleCloseGroupMenu, handleFocusGroup]
  )

  const handleMoveGroupToBranch = useCallback(
    (groupId: string, targetBranchId: string | null) => {
      const { nextGroups, targetBranchGroupIds } = moveCanvasGroupToBranch({
        groups,
        groupBranches,
        groupId,
        targetBranchId
      })

      if (nextGroups === groups) {
        return
      }

      const nextItems =
        targetBranchGroupIds.length > 1
          ? realignCanvasGroupsIntoBranchRow({
              items,
              groups: nextGroups,
              groupIds: targetBranchGroupIds
            })
          : items

      if (nextItems !== items) {
        setItemsWithHistory(nextItems)
      }

      setGroups(nextGroups)

      const movedGroup = nextGroups.find((group) => group.id === groupId)
      if (!movedGroup) {
        handleCloseGroupMenu()
        return
      }

      const targetItems = nextItems.filter((item) => movedGroup.itemIds.includes(item.id))
      if (targetItems.length === 0) {
        handleCloseGroupMenu()
        return
      }

      setTool('select')
      setSelectionRect(null)
      setSelectedIds(new Set(targetItems.map((item) => item.id)))
      lastClickedIdRef.current = targetItems[targetItems.length - 1]?.id || null
      focusCanvasBounds(getCanvasItemsBounds(targetItems), 120)
      handleCloseGroupMenu()
    },
    [
      focusCanvasBounds,
      groupBranches,
      groups,
      handleCloseGroupMenu,
      items,
      lastClickedIdRef,
      setGroups,
      setItemsWithHistory,
      setSelectedIds,
      setSelectionRect,
      setTool
    ]
  )

  const handleAutoArrangeGroup = useCallback(
    (group: CanvasGroup) => {
      autoArrangeGroupItems(group)
    },
    [autoArrangeGroupItems]
  )

  const handleDeleteGroup = useCallback(
    (groupId: string) => {
      setGroups((prev) => prev.filter((group) => group.id !== groupId))
      if (groupRenameId === groupId) {
        handleCancelGroupRename()
      }
    },
    [groupRenameId, handleCancelGroupRename, setGroups]
  )

  return {
    groupMenuAnchor,
    groupRenameDraft,
    groupRenameId,
    groupRenameInputRef,
    handleAutoArrangeGroup,
    handleCancelGroupRename,
    handleCloseGroupMenu,
    handleCommitGroupRename,
    handleCreateGroup,
    handleCreateGroupBranch,
    handleDeleteGroup,
    handleDeleteGroupBranch,
    handleFocusGroup,
    handleFocusGroupBranch,
    handleMoveGroupToBranch,
    handleOpenGroupMenu,
    handleRenameGroup,
    handleRenameGroupBranch,
    handleStartGroupRename,
    setGroupRenameDraft
  }
}
