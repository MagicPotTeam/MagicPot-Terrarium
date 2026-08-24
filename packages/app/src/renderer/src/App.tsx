// packages/app/src/renderer/src/App.tsx
import React, { useEffect, useRef, useState } from 'react'
import { HashRouter } from 'react-router-dom'
import Layout from './components/Layout'
import CanvasProjectDropBridge from './components/CanvasProjectDropBridge'
import { useConfig } from './hooks/useConfig'
import { useComfyProcess } from './store/hooks/comfyProcess'
import { api } from './utils/windowUtils'
import { isServerStreamingError } from '@shared/api/apiUtils/streaming'
import { DndProvider } from 'react-dnd'
import { getAppDndManager } from './utils/dndManager'
import ComfyLogBridge from './components/ComfyLogBridge'
import ManagedComfyProcessBridge from './components/ManagedComfyProcessBridge'
import MagicAgentApprovalCenter from './components/MagicAgentApprovalCenter'
import { useComfyEventCallback } from './hooks/useComfyEvent'
import { handleComfyExecutionActivityEvent } from './utils/comfyExecutionActivity'
import { useTranslation } from 'react-i18next'
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
      <AutoStartEmbeddedComfyUI />
    </>
  )
}

function AutoStartEmbeddedComfyUI(): null {
  const { t } = useTranslation()
  const { isReady, buildEnv, configUtils } = useConfig()
  const { state, setPid, setIsRunning, setIsManaged, addOutput } = useComfyProcess()
  const attemptedRef = useRef(false)

  useEffect(() => {
    if (!isReady || attemptedRef.current) return
    const bundledRuntimeAvailable =
      buildEnv.env.buildMode === 'embedded' &&
      Boolean(buildEnv.embeddedDefaults.comfyuiDir.trim()) &&
      Boolean(buildEnv.embeddedDefaults.pythonCmd.trim()) &&
      buildEnv.embeddedDefaults.comfyuiArgs.length > 0
    if (!bundledRuntimeAvailable || !configUtils.isComfyUICommandAvailable() || state.isRunning) {
      attemptedRef.current = true
      return
    }

    attemptedRef.current = true
    let cancelled = false

    const startEmbeddedComfyUI = async () => {
      let startedProcessStream = false
      try {
        const { pid } = await api().svcHyper.comfyPortDetect({})
        if (cancelled) return
        if (pid !== 0) {
          setPid(pid)
          setIsManaged(false)
          setIsRunning(true)
          window.dispatchEvent(new CustomEvent('comfyui:ready'))
          return
        }

        startedProcessStream = true
        setIsManaged(true)
        setIsRunning(true)
        addOutput(t('app.embedded_comfyui_starting'))
        await api().svcHyper.startComfyUI(
          {},
          {
            onData: (data) => {
              if (cancelled) return
              if (data.pid !== 0) setPid(data.pid)
              if (data.logLine?.includes('To see the GUI go to')) {
                window.dispatchEvent(new CustomEvent('comfyui:ready'))
              }
            }
          }
        )
      } catch (error: unknown) {
        if (cancelled) return
        addOutput(
          'ERROR> ' + (isServerStreamingError(error) ? (error as Error).message : String(error))
        )
      } finally {
        if (!cancelled && startedProcessStream) setIsRunning(false)
      }
    }

    void startEmbeddedComfyUI()
    return () => {
      cancelled = true
    }
  }, [
    addOutput,
    buildEnv.embeddedDefaults.comfyuiArgs,
    buildEnv.embeddedDefaults.comfyuiDir,
    buildEnv.embeddedDefaults.pythonCmd,
    buildEnv.env.buildMode,
    configUtils,
    isReady,
    setIsManaged,
    setIsRunning,
    setPid,
    state.isRunning,
    t
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
        <CanvasProjectDropBridge />
        <MagicAgentApprovalCenter />
        <Layout />
      </HashRouter>
    </DndProvider>
  )
}

export default App
