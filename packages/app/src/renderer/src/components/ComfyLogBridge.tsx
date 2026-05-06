import { useEffect } from 'react'
import { newAbortHandler } from '@shared/api/apiUtils/abortHandler'
import { isServerStreamingError } from '@shared/api/apiUtils/streaming'
import { useComfyProcess } from '@renderer/store/hooks/comfyProcess'
import { api } from '@renderer/utils/windowUtils'

export default function ComfyLogBridge(): null {
  const { addOutput } = useComfyProcess()

  useEffect(() => {
    const [abortSender, abortReceiver] = newAbortHandler()
    let unmounted = false

    const start = async () => {
      try {
        await api().svcLog.watchComfyLogs(
          {},
          {
            onData: (data) => {
              if (unmounted) {
                return
              }
              addOutput(data.message)
            },
            abortReceiver
          }
        )
      } catch (error) {
        if (unmounted || isServerStreamingError(error)) {
          return
        }
        console.error('Watch ComfyUI logs failed:', error)
      }
    }

    void start()

    return () => {
      unmounted = true
      abortSender.abort()
    }
  }, [addOutput])

  return null
}
