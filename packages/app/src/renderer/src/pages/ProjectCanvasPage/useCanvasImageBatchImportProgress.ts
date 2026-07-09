import { useCallback, useEffect, useRef, useState } from 'react'

import type { CanvasImageBatchImportProgress } from './useCanvasAssetIntake'

const IMAGE_BATCH_IMPORT_COMPLETE_CLEAR_DELAY_MS = 1200

export function useCanvasImageBatchImportProgress() {
  const [imageBatchImportProgress, setImageBatchImportProgress] =
    useState<CanvasImageBatchImportProgress | null>(null)
  const imageBatchImportClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const isImageBatchImportActive =
    imageBatchImportProgress !== null && imageBatchImportProgress.phase !== 'complete'

  const handleImageBatchImportProgress = useCallback(
    (progress: CanvasImageBatchImportProgress | null) => {
      if (imageBatchImportClearTimerRef.current) {
        clearTimeout(imageBatchImportClearTimerRef.current)
        imageBatchImportClearTimerRef.current = null
      }

      setImageBatchImportProgress(progress)

      if (progress?.phase === 'complete') {
        imageBatchImportClearTimerRef.current = setTimeout(() => {
          setImageBatchImportProgress(null)
          imageBatchImportClearTimerRef.current = null
        }, IMAGE_BATCH_IMPORT_COMPLETE_CLEAR_DELAY_MS)
      }
    },
    []
  )

  useEffect(() => {
    return () => {
      if (imageBatchImportClearTimerRef.current) {
        clearTimeout(imageBatchImportClearTimerRef.current)
      }
    }
  }, [])

  return {
    imageBatchImportProgress,
    isImageBatchImportActive,
    handleImageBatchImportProgress
  }
}
