import { useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useConfig } from '@renderer/hooks/useConfig'
import { useMessage } from '@renderer/hooks/useMessage'
import { useComfyStatus } from '@renderer/store/hooks/comfyStatus'
import { api } from '@renderer/utils/windowUtils'
import { ComfyHistory } from '@shared/comfy/types'
import { ResultItem } from '@shared/qApp/resultTypes'
import { useQAppContext } from '../components/QAppContext'
import { transformResults } from '../ResultList/resultTransformers'
import { dispatchQAppResultsToCanvas } from '../utils/qAppCanvasDispatch'
import { normalizeQAppErrorMessage } from '../utils/qAppErrorMessage'
import {
  clearPendingQAppRun,
  readPendingQAppRun,
  writePendingQAppRun
} from '../utils/qAppPendingRun'
import { buildQAppSubmitWorkflowRequest } from '../utils/qAppSubmitWorkflow'
import { waitForQAppPromptResult } from '../utils/qAppPromptResult'
import { readPendingQAppGenerationSessionId } from '../utils/qAppTaskPackBridge'
import { resolveQAppSessionKey } from '../utils/qAppSessionIdentity'
import {
  checkQAppDependencies,
  hasBlockingQAppDependencyIssues
} from '../utils/qAppDependencyCheck'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const readCandidateMessage = (value: unknown, depth = 0): string | null => {
  if (depth > 3) return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed || null
  }

  if (value instanceof Error) {
    const trimmed = value.message.trim()
    return trimmed || null
  }

  if (!isRecord(value)) {
    return null
  }

  for (const key of ['message', 'error', 'detail', 'exception_message'] as const) {
    const nested = readCandidateMessage(value[key], depth + 1)
    if (nested) return nested
  }

  if ('payload' in value) {
    const payloadMessage = readCandidateMessage(value.payload, depth + 1)
    if (payloadMessage) return payloadMessage
  }

  return null
}

export const formatQAppErrorMessage = (raw: unknown): string => {
  const candidate = readCandidateMessage(raw)
  if (candidate) {
    return normalizeQAppErrorMessage(candidate)
  }

  if (isRecord(raw) && typeof raw.status === 'number') {
    return normalizeQAppErrorMessage(`HTTP ${raw.status}`)
  }

  return normalizeQAppErrorMessage(String(raw))
}

const summarizeGeneratedResults = (resultItems: ResultItem[]) => {
  let imageCount = 0
  let videoCount = 0

  for (const item of resultItems) {
    if (item.type === 'image') imageCount += 1
    if (item.type === 'video') videoCount += 1
  }

  const parts: string[] = []
  if (imageCount > 0) parts.push(`${imageCount} 张图`)
  if (videoCount > 0) parts.push(`${videoCount} 个视频`)
  return parts.join('、')
}

export const useQAppRunner = (projectId?: string) => {
  const { t } = useTranslation()
  const {
    validate,
    buildWorkflow,
    buildSubmitExtraData,
    workflow,
    qAppCfg,
    currentQAppKey,
    submitClientId,
    submitSessionKey
  } = useQAppContext()
  const { configUtils } = useConfig()
  const {
    state: { isConnected, isRunning, objectInfos },
    setIsRunning,
    setObjectInfos,
    appendResults,
    setErrorPromptStatus
  } = useComfyStatus()
  const { notifySuccess, notifyError } = useMessage()
  const recoveringPromptIdsRef = useRef<Set<string>>(new Set())

  const processPromptResult = useCallback(
    async (promptId: string, result: ComfyHistory) => {
      const qAppKey = currentQAppKey || ''

      if (result.status.status_str === 'error') {
        clearPendingQAppRun(qAppKey, projectId)
        setErrorPromptStatus(promptId, result.status)

        for (const message of result.status.messages) {
          if (message[0] === 'prompt_error') {
            notifyError(
              `${t('quickapp.generate.error')}: ${formatQAppErrorMessage(message[1].error.message)}`
            )
          }

          if (message[0] === 'execution_error') {
            notifyError(
              `${t('quickapp.generate.error')}: ${formatQAppErrorMessage(
                message[1].exception_message
              )}`
            )
          }
        }

        return
      }

      const resultItems = await transformResults(promptId, result, qAppCfg?.outputNodeIds)

      if (!resultItems || resultItems.length === 0) {
        clearPendingQAppRun(qAppKey, projectId)
        notifyError('工作流执行完成，但没有生成任何输出。请检查工作流配置是否正确。')
        return
      }

      appendResults(resultItems)

      const generationSessionId = readPendingQAppGenerationSessionId(qAppKey)
      const canvasDispatchCounts = dispatchQAppResultsToCanvas(
        resultItems,
        projectId,
        generationSessionId ?? undefined
      )

      clearPendingQAppRun(qAppKey, projectId)

      const summary = summarizeGeneratedResults(resultItems)
      if (canvasDispatchCounts.totalCount > 0) {
        notifySuccess(
          summary
            ? `跑完喽，已将 ${summary} 放进参考区。`
            : `跑完喽，已生成 ${resultItems.length} 个结果。`
        )
      } else {
        notifySuccess(
          summary
            ? `工作流执行完成，已生成 ${summary}。`
            : `工作流执行完成，已生成 ${resultItems.length} 个结果。`
        )
      }

      console.log(`${t('quickapp.generate.complete')} - 生成了 ${resultItems.length} 个结果`)
    },
    [
      appendResults,
      currentQAppKey,
      notifyError,
      notifySuccess,
      projectId,
      qAppCfg?.outputNodeIds,
      setErrorPromptStatus,
      t
    ]
  )

  const runDependencyPreflight = useCallback(async (): Promise<boolean> => {
    let latestObjectInfos = objectInfos
    if (isConnected && Object.keys(latestObjectInfos || {}).length === 0) {
      try {
        latestObjectInfos = await api().svcComfy.getObjectInfo({})
        setObjectInfos(latestObjectInfos)
      } catch (error) {
        console.warn('[qAppDependencyPreflight] failed to refresh object info:', error)
      }
    }

    const report = await checkQAppDependencies({
      cfg: qAppCfg,
      workflow,
      objectInfos: latestObjectInfos,
      configUtils
    })

    if (!hasBlockingQAppDependencyIssues(report)) {
      return true
    }

    const parts: string[] = []
    if (report.missingModels.length > 0) {
      parts.push(
        t('qapp.callout.preflight_missing_models', {
          count: report.missingModels.length,
          names: report.missingModels.map((item) => item.model.name).join(', ')
        })
      )
    }
    if (report.missingNodeClasses.length > 0) {
      parts.push(
        t('qapp.callout.preflight_missing_nodes', {
          count: report.missingNodeClasses.length,
          names: report.missingNodeClasses.join(', ')
        })
      )
    }

    notifyError(t('qapp.callout.preflight_failed', { items: parts.join(', ') }))
    return false
  }, [configUtils, isConnected, notifyError, objectInfos, qAppCfg, setObjectInfos, t, workflow])

  useEffect(() => {
    const qAppKey = currentQAppKey?.trim()
    if (!qAppKey || !isConnected) return

    const pendingRun = readPendingQAppRun(qAppKey, projectId)
    if (!pendingRun) return
    if (recoveringPromptIdsRef.current.has(pendingRun.promptId)) return

    let cancelled = false
    recoveringPromptIdsRef.current.add(pendingRun.promptId)
    setIsRunning(true)

    void (async () => {
      try {
        const result = await waitForQAppPromptResult(api().svcComfy, pendingRun.promptId)
        if (cancelled) return
        await processPromptResult(pendingRun.promptId, result)
      } catch (error) {
        if (!cancelled) {
          notifyError(`${t('quickapp.generate.error')}: ${formatQAppErrorMessage(error)}`)
        }
      } finally {
        recoveringPromptIdsRef.current.delete(pendingRun.promptId)
        if (!cancelled) {
          setIsRunning(false)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [currentQAppKey, isConnected, notifyError, processPromptResult, projectId, setIsRunning, t])

  const run = useCallback(async () => {
    if (!validate || !buildWorkflow) {
      notifyError('快应用尚未加载完成')
      return
    }

    if (!isConnected) {
      notifyError('ComfyUI 未连接')
      return
    }

    try {
      if (!(await runDependencyPreflight())) return
      if (!(await validate())) return

      setIsRunning(true)

      const workflow = await buildWorkflow()
      const generationSessionId = readPendingQAppGenerationSessionId(currentQAppKey || '')
      const { prompt_id } = await api().svcComfy.submitWorkflow(
        buildQAppSubmitWorkflowRequest({
          prompt: workflow,
          qAppKey: currentQAppKey,
          clientId: submitClientId,
          sessionKey: resolveQAppSessionKey({
            qAppKey: currentQAppKey,
            projectId,
            generationSessionId: generationSessionId ?? undefined,
            submitSessionKey
          }),
          extraData: buildSubmitExtraData?.()
        })
      )

      writePendingQAppRun({
        promptId: prompt_id,
        qAppKey: currentQAppKey || '',
        projectId
      })

      setIsRunning(false)

      const result = await waitForQAppPromptResult(api().svcComfy, prompt_id)
      await processPromptResult(prompt_id, result)
    } catch (error) {
      notifyError(`${t('quickapp.generate.error')}: ${formatQAppErrorMessage(error)}`)
    } finally {
      setIsRunning(false)
    }
  }, [
    buildWorkflow,
    buildSubmitExtraData,
    currentQAppKey,
    isConnected,
    notifyError,
    processPromptResult,
    projectId,
    runDependencyPreflight,
    setIsRunning,
    submitClientId,
    submitSessionKey,
    t,
    validate
  ])

  return { run, isRunning }
}
