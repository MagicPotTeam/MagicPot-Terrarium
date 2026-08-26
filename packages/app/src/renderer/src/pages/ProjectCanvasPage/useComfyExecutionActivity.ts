import { useEffect, useMemo, useState } from 'react'

import {
  COMFY_EXECUTION_ACTIVITY_CHANGE_EVENT,
  getComfyExecutionActivitySnapshot,
  type ComfyExecutionActivitySnapshot
} from '../../utils/comfyExecutionActivity'

export type UseComfyExecutionActivityOptions = Record<string, never>

export function useComfyExecutionActivity() {
  const [comfyExecutionActivity, setComfyExecutionActivity] =
    useState<ComfyExecutionActivitySnapshot>(() => getComfyExecutionActivitySnapshot())

  useEffect(() => {
    const handleComfyExecutionActivityChange = (event: Event) => {
      const detail = (event as CustomEvent<ComfyExecutionActivitySnapshot>).detail
      setComfyExecutionActivity(detail ?? getComfyExecutionActivitySnapshot())
    }

    window.addEventListener(
      COMFY_EXECUTION_ACTIVITY_CHANGE_EVENT,
      handleComfyExecutionActivityChange
    )
    setComfyExecutionActivity(getComfyExecutionActivitySnapshot())

    return () => {
      window.removeEventListener(
        COMFY_EXECUTION_ACTIVITY_CHANGE_EVENT,
        handleComfyExecutionActivityChange
      )
    }
  }, [])

  const isCanvasPerformanceThrottled = useMemo(
    () => comfyExecutionActivity.active,
    [comfyExecutionActivity.active]
  )

  return {
    comfyExecutionActivity,
    isCanvasPerformanceThrottled
  }
}
