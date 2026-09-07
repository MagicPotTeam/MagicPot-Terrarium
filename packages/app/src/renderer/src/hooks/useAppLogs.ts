import { useCallback, useEffect, useRef, useState } from 'react'
import { newAbortHandler } from '@shared/api/apiUtils/abortHandler'
import { isServerStreamingError } from '@shared/api/apiUtils/streaming'
import { api } from '@renderer/utils/windowUtils'
import { createLogBuffer } from '@renderer/utils/logBuffer'
import { retainLogLines } from '@renderer/utils/logText'

export function useAppLogs() {
  const [output, setOutput] = useState({ lines: [] as string[], firstIndex: 0, generation: 0 })
  const bufferRef = useRef<ReturnType<typeof createLogBuffer> | null>(null)

  useEffect(() => {
    const [abortSender, abortReceiver] = newAbortHandler()
    let mounted = true
    const buffer = createLogBuffer((incoming) => {
      setOutput((previous) => {
        const { lines, removed } = retainLogLines(previous.lines, incoming)
        return { ...previous, lines, firstIndex: previous.firstIndex + removed }
      })
    })
    bufferRef.current = buffer
    const start = async () => {
      try {
        await api().svcLog.watchAppLogs(
          {},
          {
            onData: (data) => {
              if (!mounted) return
              const time = new Date(data.timestamp).toLocaleTimeString()
              const level = data.level === 'info' ? '' : `[${data.level.toUpperCase()}] `
              buffer.push(`${time} ${level}${data.message}`)
            },
            abortReceiver
          }
        )
      } catch (error) {
        if (mounted && !isServerStreamingError(error)) console.error('Watch logs failed:', error)
      }
    }
    void start()
    return () => {
      mounted = false
      buffer.dispose()
      bufferRef.current = null
      abortSender.abort()
    }
  }, [])

  const clear = useCallback(() => {
    bufferRef.current?.clear()
    setOutput((previous) => ({ lines: [], firstIndex: 0, generation: previous.generation + 1 }))
  }, [])

  return { ...output, clear }
}
