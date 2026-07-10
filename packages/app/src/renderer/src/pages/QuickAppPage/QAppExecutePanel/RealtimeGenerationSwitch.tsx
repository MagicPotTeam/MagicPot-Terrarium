import { PhotoLibraryOutlined } from '@mui/icons-material'
import { Switch, FormControlLabel, Tooltip, Box } from '@mui/material'
import { useMessage } from '@renderer/hooks/useMessage'
import { useQAppContext } from '../components/QAppContext'
import { useComfyStatus } from '@renderer/store/hooks/comfyStatus'
import React, { useEffect, useState } from 'react'
import { api } from '@renderer/utils/windowUtils'
import { useTranslation } from 'react-i18next'
import { QAppCfgInput } from '@shared/qApp/cfgTypes'
import { transformResults } from '../ResultList/resultTransformers'
import { dispatchQAppResultsToCanvas } from '../utils/qAppCanvasDispatch'
import { readPendingQAppGenerationSessionId } from '../utils/qAppTaskPackBridge'
import { valueToFileItem } from '@shared/comfy/funcs'

type RealtimeGenerationSwitchProps = {
  isConnected: boolean
  isDesignMode: boolean
  buildWorkflow: () =>
    | Promise<import('@shared/comfy/types').Workflow>
    | import('@shared/comfy/types').Workflow
  outputNodeIds?: string[]
}

/**
 * 实时绘画开关
 * 当队列为空时，自动从 Photoshop 读取图像、生成、并发送回 Photoshop
 */
const RealtimeGenerationSwitch: React.FC<RealtimeGenerationSwitchProps> = ({
  isConnected,
  isDesignMode,
  buildWorkflow,
  outputNodeIds
}) => {
  const { t } = useTranslation()
  const { notifySuccess, notifyError } = useMessage()
  const { qAppCfg, workflow, setFormStateValue, currentQAppKey } = useQAppContext()
  const { appendResults } = useComfyStatus()
  const [isRunning, setIsRunning] = useState(false)

  // 获取实时绘画状态并处理更新
  useEffect(() => {
    let disposed = false
    let statusRequestInFlight = false
    const checkStatus = async () => {
      if (disposed || statusRequestInFlight) return
      statusRequestInFlight = true
      try {
        const status = await api().svcPhotoshop.getRealtimeGenerationStatus({})
        if (disposed) return
        setIsRunning(status.isRunning)

        // 处理最新加载的图像（更新输入框）
        if (status.latestLoadedImage) {
          try {
            const { imageValue, imageInputSlot } = status.latestLoadedImage
            // 解析图像值（可能是字符串或 JSON 字符串）
            let parsedValue: string
            try {
              parsedValue = JSON.parse(imageValue)
            } catch {
              parsedValue = imageValue
            }
            setFormStateValue(imageInputSlot, parsedValue)
            console.log('[实时绘画] 已更新图像输入框:', imageInputSlot, parsedValue)
          } catch (error) {
            console.error('[实时绘画] 更新图像输入框失败:', error)
          }
        }

        // 处理最新生成的结果（添加到结果列表）
        if (status.latestGeneratedResult) {
          try {
            const { promptId, history, outputNodeIds } = status.latestGeneratedResult
            const resultItems = await transformResults(promptId, history, outputNodeIds)
            appendResults(resultItems)
            dispatchQAppResultsToCanvas(
              resultItems,
              undefined,
              readPendingQAppGenerationSessionId(currentQAppKey || '') ?? undefined
            )
            console.log('[实时绘画] 已添加生成结果到结果列表:', resultItems.length, '项')
          } catch (error) {
            console.error('[实时绘画] 添加生成结果失败:', error)
          }
        }
      } catch (error) {
        if (!disposed) {
          console.error('获取实时绘画状态失败:', error)
        }
      } finally {
        statusRequestInFlight = false
      }
    }
    void checkStatus()
    const interval = setInterval(() => void checkStatus(), 2000)
    return () => {
      disposed = true
      clearInterval(interval)
    }
  }, [appendResults, currentQAppKey, setFormStateValue])

  // 查找图像输入节点
  const findImageInputSlot = (): string | null => {
    if (!qAppCfg) return null
    for (const input of qAppCfg.inputs) {
      if (input.component === 'Section' || input.component === 'Description') {
        continue
      }
      const inputCfg = input as QAppCfgInput
      if (inputCfg.component === 'InputComfyImage' && 'slot' in inputCfg) {
        return inputCfg.slot
      }
    }
    return null
  }

  const handleToggle = async (checked: boolean) => {
    try {
      if (checked) {
        // 启动实时绘画
        if (!qAppCfg || !workflow || !outputNodeIds || outputNodeIds.length === 0) {
          notifyError('无法启动实时绘画：缺少必要的配置')
          return
        }

        const imageInputSlot = findImageInputSlot()
        if (!imageInputSlot) {
          notifyError('无法启动实时绘画：未找到图像输入节点')
          return
        }

        // 构建工作流模板（不包含图像输入，因为图像会从 Photoshop 读取）
        const workflowTemplate = await buildWorkflow()

        const result = await api().svcPhotoshop.startRealtimeGeneration({
          workflowTemplate: JSON.stringify(workflowTemplate),
          imageInputSlot,
          outputNodeIds,
          pollInterval: 2000
        })

        if (result.success) {
          setIsRunning(true)
          notifySuccess('实时绘画已启动')
        } else {
          notifyError(`启动实时绘画失败: ${result.error || '未知错误'}`)
        }
      } else {
        // 停止实时绘画
        const result = await api().svcPhotoshop.stopRealtimeGeneration({})
        if (result.success) {
          setIsRunning(false)
          notifySuccess('实时绘画已停止')
        } else {
          notifyError('停止实时绘画失败')
        }
      }
    } catch (error) {
      console.error('切换实时绘画失败:', error)
      notifyError(`切换实时绘画失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const imageInputSlot = findImageInputSlot()
  const canStart =
    !isDesignMode &&
    isConnected &&
    qAppCfg &&
    workflow &&
    outputNodeIds &&
    outputNodeIds.length > 0 &&
    imageInputSlot

  // 如果不支持，直接不显示
  if (!canStart) {
    return null
  }

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
      <Tooltip
        title={
          isRunning
            ? '点击停止实时绘画'
            : '点击启动实时绘画:当队列为空时，自动从Photoshop 读取图像生成'
        }
      >
        <FormControlLabel
          control={
            <Switch
              checked={isRunning}
              onChange={(e) => handleToggle(e.target.checked)}
              color="primary"
            />
          }
          label={
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <PhotoLibraryOutlined fontSize="small" />
              <span>实时绘画</span>
            </Box>
          }
        />
      </Tooltip>
    </Box>
  )
}

export default RealtimeGenerationSwitch
