// packages/app/src/renderer/src/App.tsx
import React, { useEffect, useState } from 'react'
import { HashRouter } from 'react-router-dom'
import Layout from './components/Layout'
import { useConfig } from './hooks/useConfig'
import { useComfyProcess } from './store/hooks/comfyProcess'
import { api } from './utils/windowUtils'
import { isServerStreamingError } from '@shared/api/apiUtils/streaming'
import { DndProvider } from 'react-dnd'
import { getAppDndManager } from './utils/dndManager'
import ComfyLogBridge from './components/ComfyLogBridge'
import ManagedComfyProcessBridge from './components/ManagedComfyProcessBridge'
import { useComfyEventCallback } from './hooks/useComfyEvent'
import { handleComfyExecutionActivityEvent } from './utils/comfyExecutionActivity'
let hasHandledInitialComfyAutoStart = false
let hasStartedInitialComfyAutoStart = false
const appDndManager = getAppDndManager()

type IdleDeadline = {
  didTimeout: boolean
  timeRemaining: () => number
}

type RequestIdleCallbackHandle = number

type WindowWithIdleCallbacks = typeof window & {
  requestIdleCallback?: RequestIdleCallback
  cancelIdleCallback?: (handle: RequestIdleCallbackHandle) => void
}
type RequestIdleCallback = (
  callback: (deadline: IdleDeadline) => void,
  options?: { timeout?: number }
) => RequestIdleCallbackHandle

const POST_SHELL_IDLE_TIMEOUT_MS = 1500

function requestPostShellIdleCallback(callback: () => void): () => void {
  if (typeof window === 'undefined') {
    let isPending = true
    const timeoutId = setTimeout(() => {
      if (!isPending) {
        return
      }

      isPending = false
      callback()
    }, 0)
    return () => {
      if (!isPending) {
        return
      }

      isPending = false
      clearTimeout(timeoutId)
    }
  }

  const { requestIdleCallback, cancelIdleCallback } = window as WindowWithIdleCallbacks

  if (requestIdleCallback) {
    let isPending = true
    let timeoutId: number | null = null
    const idleHandle = requestIdleCallback(
      () => {
        if (!isPending) {
          return
        }

        isPending = false
        if (timeoutId !== null) {
          window.clearTimeout(timeoutId)
        }
        callback()
      },
      { timeout: POST_SHELL_IDLE_TIMEOUT_MS }
    )
    timeoutId = window.setTimeout(() => {
      if (!isPending) {
        return
      }

      isPending = false
      cancelIdleCallback?.(idleHandle)
      callback()
    }, POST_SHELL_IDLE_TIMEOUT_MS)
    return () => {
      if (!isPending) {
        return
      }

      isPending = false
      cancelIdleCallback?.(idleHandle)
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId)
      }
    }
  }

  let isPending = true
  const timeoutId = window.setTimeout(() => {
    if (!isPending) {
      return
    }

    isPending = false
    callback()
  }, 0)
  return () => {
    if (!isPending) {
      return
    }

    isPending = false
    window.clearTimeout(timeoutId)
  }
}

function DeferredComfyStartupBridges(): React.JSX.Element | null {
  const [shouldMountComfyStartupBridges, setShouldMountComfyStartupBridges] = useState(false)

  useEffect(() => {
    if (shouldMountComfyStartupBridges) {
      return
    }

    return requestPostShellIdleCallback(() => {
      setShouldMountComfyStartupBridges(true)
    })
  }, [shouldMountComfyStartupBridges])

  if (!shouldMountComfyStartupBridges) {
    return null
  }

  return (
    <>
      <ComfyExecutionActivityBridge />
      <ComfyLogBridge />
      <ManagedComfyProcessBridge />
      <AutoStartLocalComfyUI />
    </>
  )
}

function shouldAutoStartLocalComfyUIInThisRuntime(): boolean {
  const configuredValue = import.meta.env.VITE_MAGICPOT_AUTO_START_COMFYUI
  if (configuredValue === 'true') return true
  if (configuredValue === 'false') return false
  return !import.meta.env.DEV
}

function AutoStartLocalComfyUI(): null {
  const { isReady, config, configUtils } = useConfig()
  const { state, setPid, setIsRunning, addOutput } = useComfyProcess()
  const comfyCommandAvailable = configUtils.isComfyUICommandAvailable()

  useEffect(() => {
    if (!isReady || hasHandledInitialComfyAutoStart) {
      return
    }

    if (
      config.use_remote_comfyui ||
      !comfyCommandAvailable ||
      state.isRunning ||
      !shouldAutoStartLocalComfyUIInThisRuntime()
    ) {
      hasHandledInitialComfyAutoStart = true
      return
    }

    if (hasStartedInitialComfyAutoStart) {
      return
    }

    hasHandledInitialComfyAutoStart = true
    hasStartedInitialComfyAutoStart = true

    let cancelled = false

    const startLocalComfyUI = async () => {
      try {
        const { pid } = await api().svcHyper.comfyPortDetect({})
        if (cancelled || pid !== 0) {
          return
        }

        setIsRunning(true)
        addOutput('应用启动，自动启动 ComfyUI...')

        await api().svcHyper.startComfyUI(
          {},
          {
            onData: (data) => {
              if (cancelled) {
                return
              }
              if (data.pid !== 0) {
                setPid(data.pid)
              }

              // ComfyUI 启动完成后通知其他组件刷新
              if (data.logLine?.includes('To see the GUI go to')) {
                window.dispatchEvent(new CustomEvent('comfyui:ready'))
              }
            }
          }
        )
      } catch (error: unknown) {
        if (cancelled) {
          return
        }
        if (isServerStreamingError(error)) {
          addOutput('ERROR> ' + (error as Error).message)
        } else {
          addOutput('ERROR> ' + String(error))
        }
      } finally {
        if (!cancelled) {
          setIsRunning(false)
        }
      }
    }

    void startLocalComfyUI()

    return () => {
      cancelled = true
    }
  }, [
    isReady,
    config.use_remote_comfyui,
    comfyCommandAvailable,
    state.isRunning,
    setPid,
    setIsRunning,
    addOutput
  ])

  return null
}

function ComfyExecutionActivityBridge(): null {
  useComfyEventCallback(handleComfyExecutionActivityEvent, [])
  return null
}

function App(): React.JSX.Element {
  return (
    <DndProvider manager={appDndManager}>
      <HashRouter>
        <DeferredComfyStartupBridges />
        <Layout />
      </HashRouter>
    </DndProvider>
  )
}

export default App
