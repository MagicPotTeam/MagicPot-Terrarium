import { Image as ImageIcon } from '@mui/icons-material'
import { Alert, Button, CircularProgress } from '@mui/material'
import { writeSelectedLoraTriggerWordFiles } from '@renderer/components/inputs/loraTriggerWordFiles'
import { useConfig } from '@renderer/hooks/useConfig'
import { useMessage } from '@renderer/hooks/useMessage'
import { useComfyStatus } from '@renderer/store/hooks/comfyStatus'
import { api } from '@renderer/utils/windowUtils'
import { ComfyHistory, Workflow } from '@shared/comfy/types'
import { ResultItem } from '@shared/qApp/resultTypes'
import React, { useState } from 'react'
import { transformResults } from '../ResultList/resultTransformers'
import { useTranslation } from 'react-i18next'
import { useQAppContext } from '../components/QAppContext'
import { dispatchQAppResultsToCanvas } from '../utils/qAppCanvasDispatch'
import { normalizeQAppErrorMessage } from '../utils/qAppErrorMessage'
import { buildQAppSubmitWorkflowRequest } from '../utils/qAppSubmitWorkflow'
import { readPendingQAppGenerationSessionId } from '../utils/qAppTaskPackBridge'
import { resolveQAppSessionKey } from '../utils/qAppSessionIdentity'
import type { ProjectTraceEventStatus } from '@shared/projectTrace'
import { emitProjectTraceRuntimeEvent } from '@renderer/features/projectTrace/projectTraceRuntime'

type SubmitWorkflowButtonProps = {
  isConnected: boolean
  isDesignMode: boolean
  outputNodeIds?: string[]
  validate: () => Promise<boolean> | boolean
  buildWorkflow: () => Promise<Workflow> | Workflow
}

const summarizeGeneratedResults = (resultItems: ResultItem[]) => {
  let imageCount = 0
  let videoCount = 0

  for (const item of resultItems) {
    if (item.type === 'image') imageCount += 1
    if (item.type === 'video') videoCount += 1
  }

  const parts: string[] = []
  if (imageCount > 0) parts.push(`${imageCount} 张图片`)
  if (videoCount > 0) parts.push(`${videoCount} 个视频`)
  return parts.join('、')
}

const summarizeResultKinds = (resultItems: ResultItem[]): string[] =>
  Array.from(new Set(resultItems.map((item) => item.type))).slice(0, 12)

const SubmitWorkflowButton: React.FC<SubmitWorkflowButtonProps> = ({
  isConnected,
  isDesignMode,
  outputNodeIds,
  validate,
  buildWorkflow
}) => {
  const { t } = useTranslation()
  const { currentQAppKey, buildSubmitExtraData, formState, submitClientId, submitSessionKey } =
    useQAppContext()
  const { configUtils } = useConfig()
  const { notifySuccess, notifyError } = useMessage()
  const [status, setStatus] = useState<string>('')
  const {
    state: { isRunning },
    setIsRunning,
    appendResults,
    setErrorPromptStatus
  } = useComfyStatus()

  const emitQuickAppTraceEvent = (
    traceStatus: ProjectTraceEventStatus,
    safeSummary: string,
    options?: {
      entityCount?: number
      outputKinds?: string[]
      riskSignals?: string[]
    }
  ) => {
    emitProjectTraceRuntimeEvent({
      scope: 'quick_app',
      action: 'quick_app_submit_workflow',
      label: currentQAppKey || 'Quick App',
      status: traceStatus,
      safeSummary,
      entityType: 'quick_app_result',
      entityCount: options?.entityCount,
      inputKinds: ['workflow'],
      outputKinds: options?.outputKinds,
      affectedItemCount: options?.entityCount,
      createdItemCount: traceStatus === 'success' ? options?.entityCount : undefined,
      riskSignals: options?.riskSignals
    })
  }

  const generateImage = async () => {
    try {
      if (!(await validate())) {
        return
      }

      setIsRunning(true)
      setStatus(t('quickapp.generate.submitting'))
      emitQuickAppTraceEvent('info', 'Quick app workflow submission started.')

      const workflow = await buildWorkflow()
      const generationSessionId = readPendingQAppGenerationSessionId(currentQAppKey || '')
      const { prompt_id } = await api().svcComfy.submitWorkflow(
        buildQAppSubmitWorkflowRequest({
          prompt: workflow,
          qAppKey: currentQAppKey,
          clientId: submitClientId,
          sessionKey: resolveQAppSessionKey({
            qAppKey: currentQAppKey,
            generationSessionId: generationSessionId ?? undefined,
            submitSessionKey
          }),
          extraData: buildSubmitExtraData?.()
        })
      )
      setStatus(t('quickapp.generate.waiting'))
      setIsRunning(false)

      const result = await new Promise<ComfyHistory>((resolve, reject) => {
        api()
          .svcComfy.waitPromptId(
            { prompt_id },
            {
              onData: (data) => {
                resolve(data[prompt_id])
              }
            }
          )
          .catch((error) => {
            reject(error)
          })
      })

      if (result.status.status_str === 'error') {
        setErrorPromptStatus(prompt_id, result.status)
        emitQuickAppTraceEvent('error', 'Quick app workflow returned an execution error.', {
          riskSignals: ['execution_error']
        })
        const messages = result.status.messages
        for (const message of messages) {
          if (message[0] === 'prompt_error') {
            const msg = normalizeQAppErrorMessage(message[1].error.message)
            setStatus(`失败: ${t('quickapp.generate.error')}: ${msg}`)
            notifyError(`${t('quickapp.generate.error')}: ${msg}`)
          }
          if (message[0] === 'execution_error') {
            const msg = normalizeQAppErrorMessage(message[1].exception_message)
            setStatus(`失败: ${t('quickapp.generate.error')}: ${msg}`)
            notifyError(`${t('quickapp.generate.error')}: ${msg}`)
          }
        }
        return
      }

      const resultItems = await transformResults(prompt_id, result, outputNodeIds)

      if (!resultItems || resultItems.length === 0) {
        const errorMsg = '工作流执行完成，但没有生成任何输出。请检查工作流配置是否正确。'
        setStatus(`⚠️ ${errorMsg}`)
        notifyError(errorMsg)
        emitQuickAppTraceEvent(
          'warning',
          'Quick app workflow completed without generated output.',
          {
            riskSignals: ['empty_output']
          }
        )
        return
      }

      try {
        await writeSelectedLoraTriggerWordFiles({ formState, configUtils })
      } catch (error) {
        console.warn('[LoRA trigger words] failed to write sidecar files:', error)
      }

      appendResults(resultItems)
      dispatchQAppResultsToCanvas(resultItems, undefined, generationSessionId ?? undefined)
      emitQuickAppTraceEvent('success', `Quick app generated ${resultItems.length} result(s).`, {
        entityCount: resultItems.length,
        outputKinds: summarizeResultKinds(resultItems)
      })
      const summary = summarizeGeneratedResults(resultItems)
      setStatus(summary ? `成功: ${summary}` : `成功: 已生成 ${resultItems.length} 个结果`)
      console.log(`${t('quickapp.generate.complete')} - 生成了 ${resultItems.length} 个结果`)
    } catch (error) {
      console.error('Generate image error:', error)
      const rawMessage = error instanceof Error ? error.message : String(error)
      let errorMessage = normalizeQAppErrorMessage(rawMessage)

      if (errorMessage.includes('[Errno 2]') && errorMessage.includes('input')) {
        errorMessage = '请先加载图像后再生成'
      }

      setStatus(`失败: ${t('quickapp.generate.error')}: ${errorMessage}`)
      notifyError(`${t('quickapp.generate.error')}: ${errorMessage}`)
      emitQuickAppTraceEvent('error', 'Quick app workflow failed before completion.', {
        riskSignals: ['runtime_error']
      })
    } finally {
      setIsRunning(false)
    }
  }

  return (
    <>
      <Button
        variant="contained"
        size="large"
        fullWidth
        onClick={generateImage}
        disabled={isRunning || !isConnected || isDesignMode}
        startIcon={isRunning ? <CircularProgress size={20} /> : <ImageIcon />}
        sx={{ height: 48 }}
      >
        {isRunning ? t('quickapp.generate.generating') : t('quickapp.generate.button')}
      </Button>

      {status && <Alert severity={status.includes('失败') ? 'error' : 'info'}>{status}</Alert>}
    </>
  )
}

export default SubmitWorkflowButton
