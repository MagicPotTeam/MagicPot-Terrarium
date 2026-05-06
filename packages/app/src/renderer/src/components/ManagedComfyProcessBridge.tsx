import { useEffect, useRef } from 'react'
import { newAbortHandler } from '@shared/api/apiUtils/abortHandler'
import type { AbortSender } from '@shared/api/apiUtils/abortHandler'
import { isServerStreamingError } from '@shared/api/apiUtils/streaming'
import { useConfig } from '@renderer/hooks/useConfig'
import { useComfyProcess } from '@renderer/store/hooks/comfyProcess'
import { api, hasManagedComfyStartupApi } from '@renderer/utils/windowUtils'

export default function ManagedComfyProcessBridge(): null {
  const { isReady, config, configUtils } = useConfig()
  const { state, setPid, setIsRunning, addOutput } = useComfyProcess()
  const managedComfyStartupApiAvailable = hasManagedComfyStartupApi()
  const hasAttemptedInitialAttachRef = useRef(false)
  const isUnmountedRef = useRef(false)
  const attachAbortSenderRef = useRef<AbortSender | null>(null)

  useEffect(() => {
    return () => {
      isUnmountedRef.current = true
      attachAbortSenderRef.current?.abort()
    }
  }, [])

  useEffect(() => {
    if (!isReady || hasAttemptedInitialAttachRef.current) {
      return
    }

    if (
      config.use_remote_comfyui ||
      !configUtils.isComfyUICommandAvailable() ||
      !managedComfyStartupApiAvailable ||
      state.pid !== 0
    ) {
      return
    }

    hasAttemptedInitialAttachRef.current = true

    const attachManagedComfyProcess = async () => {
      let hasActiveLogStream = false

      try {
        const { pid } = await api().svcHyper.comfyPortDetect({})
        if (isUnmountedRef.current || pid === 0) {
          return
        }

        const [abortSender, abortReceiver] = newAbortHandler()
        attachAbortSenderRef.current = abortSender
        hasActiveLogStream = true

        setPid(pid)
        setIsRunning(true)
        window.dispatchEvent(new CustomEvent('comfyui:ready'))
        addOutput(`> [comfyui] detected existing process with pid: ${pid}`)

        await api().svcHyper.connectSubProcess(
          { pid },
          {
            onData: (data) => {
              if (isUnmountedRef.current) {
                return
              }
              if (data.pid !== 0) {
                setPid(data.pid)
              }
            },
            abortReceiver
          }
        )
      } catch (error: unknown) {
        if (isUnmountedRef.current) {
          return
        }
        if (isServerStreamingError(error)) {
          addOutput('ERROR> ' + error.message)
        } else {
          addOutput('ERROR> ' + String(error))
        }
      } finally {
        if (!isUnmountedRef.current && hasActiveLogStream) {
          setIsRunning(false)
        }
        attachAbortSenderRef.current = null
      }
    }

    void attachManagedComfyProcess()
  }, [
    isReady,
    config.use_remote_comfyui,
    configUtils,
    managedComfyStartupApiAvailable,
    state.pid,
    setPid,
    setIsRunning,
    addOutput
  ])

  return null
}
