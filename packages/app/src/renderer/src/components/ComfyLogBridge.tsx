import { useEffect, useLayoutEffect, useRef } from 'react'
import { newAbortHandler } from '@shared/api/apiUtils/abortHandler'
import { isServerStreamingError } from '@shared/api/apiUtils/streaming'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { addOutputBatch } from '@renderer/store/slices/comfyProcess'
import { api } from '@renderer/utils/windowUtils'
import { createLogBuffer, LOG_BATCH_LINES, LOG_FLUSH_INTERVAL_MS } from '@renderer/utils/logBuffer'

export const COMFY_LOG_BATCH_SIZE = LOG_BATCH_LINES
export const COMFY_LOG_BATCH_INTERVAL_MS = LOG_FLUSH_INTERVAL_MS

export default function ComfyLogBridge(): null {
  const dispatch = useAppDispatch()
  const generation = useAppSelector((state) => state.comfyProcess.outputGeneration ?? 0)
  const bufferRef = useRef<ReturnType<typeof createLogBuffer> | null>(null)

  useLayoutEffect(() => {
    // Clearing the display also discards rows waiting for the next flush, without
    // restarting the subscription (which would replay old logs).
    bufferRef.current?.clear()
  }, [generation])

  useEffect(() => {
    const [abortSender, abortReceiver] = newAbortHandler()
    let unmounted = false
    const buffer = createLogBuffer((output) => dispatch(addOutputBatch(output)))
    bufferRef.current = buffer
    const start = async () => {
      try {
        await api().svcLog.watchComfyLogs(
          {},
          {
            onData: (data) => {
              if (!unmounted) buffer.push(data.message)
            },
            abortReceiver
          }
        )
      } catch (error) {
        if (!unmounted && !isServerStreamingError(error)) {
          console.error('Watch ComfyUI logs failed:', error)
        }
      }
    }
    void start()
    return () => {
      unmounted = true
      buffer.dispose()
      bufferRef.current = null
      abortSender.abort()
    }
  }, [dispatch])

  return null
}
