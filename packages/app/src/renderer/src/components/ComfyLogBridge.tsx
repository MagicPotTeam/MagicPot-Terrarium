import { useEffect } from 'react'
import { newAbortHandler } from '@shared/api/apiUtils/abortHandler'
import { isServerStreamingError } from '@shared/api/apiUtils/streaming'
import { useAppDispatch } from '@renderer/store'
import { addOutputBatch } from '@renderer/store/slices/comfyProcess'
import { api } from '@renderer/utils/windowUtils'

export const COMFY_LOG_BATCH_SIZE = 100
export const COMFY_LOG_BATCH_INTERVAL_MS = 100

export default function ComfyLogBridge(): null {
  const dispatch = useAppDispatch()

  useEffect(() => {
    const [abortSender, abortReceiver] = newAbortHandler()
    let unmounted = false
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    let pendingOutput: string[] = []

    const flushPendingOutput = () => {
      if (flushTimer !== null) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      if (unmounted || pendingOutput.length === 0) {
        return
      }
      const output = pendingOutput
      pendingOutput = []
      dispatch(addOutputBatch(output))
    }

    const scheduleFlush = () => {
      if (flushTimer !== null) {
        return
      }
      flushTimer = setTimeout(flushPendingOutput, COMFY_LOG_BATCH_INTERVAL_MS)
    }

    const start = async () => {
      try {
        await api().svcLog.watchComfyLogs(
          {},
          {
            onData: (data) => {
              if (unmounted) {
                return
              }
              pendingOutput.push(data.message)
              if (pendingOutput.length >= COMFY_LOG_BATCH_SIZE) {
                flushPendingOutput()
              } else {
                scheduleFlush()
              }
            },
            abortReceiver
          }
        )
        flushPendingOutput()
      } catch (error) {
        flushPendingOutput()
        if (unmounted || isServerStreamingError(error)) {
          return
        }
        console.error('Watch ComfyUI logs failed:', error)
      }
    }

    void start()

    return () => {
      flushPendingOutput()
      unmounted = true
      abortSender.abort()
    }
  }, [dispatch])

  return null
}
