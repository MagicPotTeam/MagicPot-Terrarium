import { useEffect } from 'react'

import {
  PROJECT_TRACE_REALTIME_ADVICE_EVENT,
  type ProjectTraceRealtimeAdviceEvent
} from '@renderer/features/projectTrace/projectTraceRuntime'

export type UseProjectTraceRealtimeAdviceOptions = {
  canvasId: string
  notifyWarning: (message: string, autoHideDuration?: number) => void
}

export function useProjectTraceRealtimeAdvice({
  canvasId,
  notifyWarning
}: UseProjectTraceRealtimeAdviceOptions) {
  useEffect(() => {
    const handleRealtimeAdvice = (event: Event) => {
      const detail = (event as CustomEvent<ProjectTraceRealtimeAdviceEvent>).detail
      if (!detail?.advice || detail.projectId !== canvasId) return
      notifyWarning(detail.advice.advice, 8000)
    }

    window.addEventListener(PROJECT_TRACE_REALTIME_ADVICE_EVENT, handleRealtimeAdvice)
    return () =>
      window.removeEventListener(PROJECT_TRACE_REALTIME_ADVICE_EVENT, handleRealtimeAdvice)
  }, [canvasId, notifyWarning])
}
