import { useEffect, useLayoutEffect, useRef } from 'react'
import { newAbortHandler } from '@shared/api/apiUtils/abortHandler'
import type { AbortSender } from '@shared/api/apiUtils/abortHandler'
import { isServerStreamingError } from '@shared/api/apiUtils/streaming'
import { useConfig } from '@renderer/hooks/useConfig'
import { useComfyProcess } from '@renderer/store/hooks/comfyProcess'
import { api, hasManagedComfyStartupApi } from '@renderer/utils/windowUtils'
import { detectManagedComfyProcess } from './managedComfyDetectionCoordinator'

export default function ManagedComfyProcessBridge(): null {
  const { isReady, configUtils } = useConfig()
  const { state, setPid, setIsRunning, setIsManaged, addOutput } = useComfyProcess()
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

  useLayoutEffect(() => {
    if (!isReady || hasAttemptedInitialAttachRef.current) {
      return
    }

    if (
      !configUtils.isManagedComfyUICommandAvailable() ||
      !managedComfyStartupApiAvailable ||
      state.pid !== 0
    ) {
      return
    }

    hasAttemptedInitialAttachRef.current = true

    const attachManagedComfyProcess = async () => {
      let confirmedManagedAttach = false

      try {
        const { pid } = await detectManagedComfyProcess(() => api().svcHyper.comfyPortDetect({}))
        if (isUnmountedRef.current || pid === 0) {
          return
        }

        const [abortSender, abortReceiver] = newAbortHandler()
        attachAbortSenderRef.current = abortSender

        await api().svcHyper.connectSubProcess(
          { pid },
          {
            onData: (data) => {
              if (isUnmountedRef.current) {
                return
              }
              if (!confirmedManagedAttach) {
                confirmedManagedAttach = true
                setPid(data.pid || pid)
                setIsManaged(true)
                setIsRunning(true)
                window.dispatchEvent(new CustomEvent('comfyui:ready'))
                addOutput(`> [comfyui] detected existing managed process with pid: ${pid}`)
              } else if (data.pid !== 0) {
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
        if (!isUnmountedRef.current && confirmedManagedAttach) {
          setIsRunning(false)
        }
        attachAbortSenderRef.current = null
      }
    }

    void attachManagedComfyProcess()
  }, [
    isReady,
    configUtils,
    managedComfyStartupApiAvailable,
    state.pid,
    setPid,
    setIsRunning,
    setIsManaged,
    addOutput
  ])

  return null
}
