import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { appendGenerationTraceCandidate } from './generationTraceRuntime'
import {
  listGenerationTraceRecords,
  removeGenerationTraceRecord,
  updateTraceUserDecision,
  upsertGenerationTraceRecord,
  type GenerationTraceRecord
} from './generationTraceStorage'
import type { CanvasItem } from './types'
import type { GenerationFollowUpIntent } from './useCanvasGenerationWorkflow'

type NotifyFn = (message: string) => unknown

type HandleGenerateCanvasItems = (
  targetItems: CanvasItem[],
  targetScope?: string,
  followUpIntent?: GenerationFollowUpIntent | null
) => Promise<void>

type UseCanvasGenerationTraceOptions = {
  canvasId: string
  items: CanvasItem[]
  isChineseUi: boolean
  notifyWarning: NotifyFn
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>
  handleGenerateCanvasItems: HandleGenerateCanvasItems
  handleConfirmGenerationTaskPack: () => Promise<void>
}

type AppendGenerationTraceCandidateInput = Parameters<typeof appendGenerationTraceCandidate>[0]

export function useCanvasGenerationTrace({
  canvasId,
  items,
  isChineseUi,
  notifyWarning,
  setSelectedIds,
  handleGenerateCanvasItems,
  handleConfirmGenerationTaskPack
}: UseCanvasGenerationTraceOptions) {
  const [generationTraceHistoryDialogOpen, setGenerationTraceHistoryDialogOpen] = useState(false)
  const [generationTraceRecentRecords, setGenerationTraceRecentRecords] = useState<
    GenerationTraceRecord[]
  >(() => listGenerationTraceRecords(canvasId))

  const refreshGenerationTraceRecords = useCallback(() => {
    setGenerationTraceRecentRecords(listGenerationTraceRecords(canvasId))
  }, [canvasId])

  useEffect(() => {
    refreshGenerationTraceRecords()
  }, [refreshGenerationTraceRecords])

  const handleOpenGenerationTraceHistory = useCallback(() => {
    refreshGenerationTraceRecords()
    setGenerationTraceHistoryDialogOpen(true)
  }, [refreshGenerationTraceRecords])

  const handleCloseGenerationTraceHistory = useCallback(() => {
    setGenerationTraceHistoryDialogOpen(false)
  }, [])

  const handleDeleteGenerationTraceHistoryRecord = useCallback(
    (sessionId: string) => {
      const nextRecords = removeGenerationTraceRecord(canvasId, sessionId)
      setGenerationTraceRecentRecords(nextRecords)
    },
    [canvasId]
  )

  const handleUpdateGenerationTraceDecision = useCallback(
    (record: GenerationTraceRecord, decision: GenerationTraceRecord['userDecision']) => {
      const nextRecord = updateTraceUserDecision(record, decision)
      const nextRecords = upsertGenerationTraceRecord(canvasId, nextRecord)
      setGenerationTraceRecentRecords(nextRecords)
    },
    [canvasId]
  )

  const handleContinueGenerationTraceRecord = useCallback(
    async (record: GenerationTraceRecord) => {
      const targetItems = items.filter((item) => record.selectedItemIds.includes(item.id))
      if (targetItems.length === 0) {
        notifyWarning(
          isChineseUi
            ? '\u8fd9\u6761\u51fa\u56fe\u8bb0\u5f55\u5bf9\u5e94\u7684\u753b\u5e03\u5143\u7d20\u5df2\u4e0d\u5b58\u5728\u3002'
            : 'The canvas items for this generation record no longer exist'
        )
        return
      }

      setSelectedIds(new Set(targetItems.map((item) => item.id)))
      setGenerationTraceHistoryDialogOpen(false)
      await handleGenerateCanvasItems(targetItems, undefined, {
        sourceSessionId: record.sessionId,
        decision: record.candidates.length > 0 ? 'refined' : 'retried'
      })
    },
    [handleGenerateCanvasItems, isChineseUi, items, notifyWarning, setSelectedIds]
  )

  const handleConfirmGenerationTaskPackWithTraceRefresh = useCallback(async () => {
    await handleConfirmGenerationTaskPack()
    refreshGenerationTraceRecords()
  }, [handleConfirmGenerationTaskPack, refreshGenerationTraceRecords])

  const handleAppendGenerationTraceCandidate = useCallback(
    (options: AppendGenerationTraceCandidateInput) => {
      const updatedTraceRecord = appendGenerationTraceCandidate(options)
      if (updatedTraceRecord) {
        refreshGenerationTraceRecords()
      }
      return updatedTraceRecord
    },
    [refreshGenerationTraceRecords]
  )

  return {
    generationTraceHistoryDialogOpen,
    generationTraceRecentRecords,
    handleAppendGenerationTraceCandidate,
    handleCloseGenerationTraceHistory,
    handleConfirmGenerationTaskPackWithTraceRefresh,
    handleContinueGenerationTraceRecord,
    handleDeleteGenerationTraceHistoryRecord,
    handleOpenGenerationTraceHistory,
    handleUpdateGenerationTraceDecision
  }
}
