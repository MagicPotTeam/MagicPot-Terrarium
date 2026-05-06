// packages/app/src/renderer/src/pages/QuickAppPage/components/StatusBar.tsx
import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Box,
  Typography,
  Stack,
  Chip,
  Divider,
  Button,
  IconButton,
  LinearProgress
} from '@mui/material'
import { Refresh as RefreshIcon, Close as CloseIcon } from '@mui/icons-material'
import { useMessage } from '@renderer/hooks/useMessage'
import { useComfyStatus } from '@renderer/store/hooks/comfyStatus'
import { useComfyProcess } from '@renderer/store/hooks/comfyProcess'
import { api } from '@renderer/utils/windowUtils'
import { useComfyEventCallback } from '@renderer/hooks/useComfyEvent'
import { ProgressChip } from '@renderer/components/ProgressChip'
import { newAbortHandler } from '@shared/api/apiUtils/abortHandler'
import { WatchQueueResp } from '@shared/api/svcComfy'
import {
  getQueueOverallProgress,
  type QueueAnimationStates
} from '@renderer/components/sidePanelQueueUtils'
import ErrorModalInfo from './ErrorModalInfo'

import { isEqual } from 'es-toolkit'
import { useTranslation } from 'react-i18next'

type StatusBarProps = {
  status?: string
}

export default function StatusBar({ status }: StatusBarProps) {
  const { t } = useTranslation()
  const { notifySuccess, notifyError } = useMessage()

  // 任务队列状态
  const [queueState, setQueueState] = useState<WatchQueueResp>({
    queue_running: [],
    queue_pending: [],
    queue_error: []
  })

  // 错误提示弹窗的 prompt_id
  const [errorModalPromptId, setErrorModalPromptId] = useState<string | null>(null)

  // 进行中任务进度
  const [animationStates, setAnimationStates] = useState<QueueAnimationStates>({})

  useComfyEventCallback((event) => {
    if (event.type === 'progress') {
      const { prompt_id, value, max } = event.data
      setAnimationStates((prev) => ({
        ...prev,
        [prompt_id]: { value, max }
      }))
    }
  }, [])

  // QuickApp 全局状态
  const {
    state: { isConnected },
    setIsConnected,
    setObjectInfos
  } = useComfyStatus()
  const { state: comfyProcessState } = useComfyProcess()
  const prevIsRunningRef = useRef<boolean>(comfyProcessState.isRunning)

  // 刷新全局状态
  const refreshStatus = useCallback(
    async (options: { notify?: boolean } = {}) => {
      try {
        const objectInfo = await api().svcComfy.getObjectInfo({})
        setIsConnected(true)
        setObjectInfos(objectInfo)
        if (options.notify !== false) {
          notifySuccess(t('quickapp.status.connected_to_server'))
        }
        return true
      } catch (error) {
        setIsConnected(false)
        return false
      }
    },
    [t, notifySuccess, setIsConnected, setObjectInfos]
  )

  // 组件挂载时检查连接并获取任务队列状态
  useEffect(() => {
    const [abortSender, abortReceiver] = newAbortHandler()

    const init = async () => {
      const resultIsConnected = await refreshStatus({ notify: false })
      if (!resultIsConnected) return

      await api().svcComfy.watchQueue(
        {},
        {
          onData: (resp) => {
            setQueueState((prev) => {
              if (isEqual(prev, resp)) {
                return prev
              }
              return resp
            })
          },
          abortReceiver
        }
      )
    }

    init()
    return () => abortSender.abort()
  }, [refreshStatus])

  useEffect(() => {
    const handleComfyReady = () => {
      void refreshStatus({ notify: false })
    }

    window.addEventListener('comfyui:ready', handleComfyReady)
    return () => {
      window.removeEventListener('comfyui:ready', handleComfyReady)
    }
  }, [refreshStatus])

  useEffect(() => {
    if (isConnected) {
      return
    }

    const reconnectTimer = window.setInterval(() => {
      void refreshStatus({ notify: false })
    }, 3000)

    return () => {
      window.clearInterval(reconnectTimer)
    }
  }, [isConnected, refreshStatus])

  useEffect(() => {
    if (!prevIsRunningRef.current && comfyProcessState.isRunning) {
      refreshStatus({ notify: false })
    }
    prevIsRunningRef.current = comfyProcessState.isRunning
  }, [comfyProcessState.isRunning, refreshStatus])

  // 计算总体进度（如果有多个任务，取平均值）
  const overallProgress = getQueueOverallProgress(queueState.queue_running, animationStates)
  const hasRunningTasks = queueState.queue_running.length > 0

  return (
    <Box sx={{ borderTop: 1, borderColor: 'divider', bgcolor: 'background.paper' }}>
      {/* 全局进度条 */}
      {hasRunningTasks && (
        <Box sx={{ width: '100%', position: 'relative' }}>
          <LinearProgress
            variant={overallProgress === null ? 'indeterminate' : 'determinate'}
            value={(overallProgress ?? 0) * 100}
            color="primary"
            sx={{
              height: 4,
              '& .MuiLinearProgress-bar': {
                transition: 'transform 0.2s linear'
              }
            }}
          />
          <Typography
            variant="caption"
            sx={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              color: 'text.secondary',
              fontWeight: 600,
              textShadow: '0 0 4px rgba(255,255,255,0.8)',
              pointerEvents: 'none'
            }}
          >
            {overallProgress === null ? '运行中' : `${Math.round(overallProgress * 100)}%`}
          </Typography>
        </Box>
      )}

      <Box sx={{ p: 2 }}>
        <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
          {/* 连接状态 */}
          <Chip
            label={isConnected ? t('quickapp.status.connected') : t('quickapp.status.disconnected')}
            color={isConnected ? 'success' : 'error'}
            size="small"
            icon={<RefreshIcon />}
            onClick={() => void refreshStatus()}
            sx={{ minWidth: 80 }}
          />

          {/* 失败队列 */}
          {queueState.queue_error.length > 0 && (
            <>
              <Divider orientation="vertical" flexItem />
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                <Typography variant="body2" color="text.secondary" sx={{ fontStyle: 'italic' }}>
                  {t('quickapp.queue.error')}
                </Typography>
              </Box>
              <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', alignItems: 'center' }}>
                {queueState.queue_error.map((item) => {
                  const promptId = item[1]
                  return (
                    <Box key={promptId} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                      <ProgressChip
                        label={`${promptId.substring(0, 10)}...`}
                        progress={0}
                        size="small"
                        color="error"
                        onClick={() => setErrorModalPromptId(promptId)}
                        sx={{ minWidth: 100 }}
                      />
                      <IconButton
                        size="small"
                        onClick={async () => {
                          try {
                            await api().svcComfy.cancelQueueItem({ prompt_id: promptId })
                            notifySuccess(t('quickapp.queue.cancel_success'))
                          } catch (error) {
                            notifyError(t('quickapp.queue.cancel_failed'))
                          }
                        }}
                        sx={{ padding: 0.5 }}
                      >
                        <CloseIcon fontSize="small" />
                      </IconButton>
                    </Box>
                  )
                })}
              </Box>
            </>
          )}

          {/* 运行中状态 */}
          {hasRunningTasks && (
            <>
              <Divider orientation="vertical" flexItem />
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                <Typography variant="body2" sx={{ fontWeight: 600, color: 'text.primary' }}>
                  ⚡ 运行中 ({queueState.queue_running.length})
                </Typography>
                <IconButton
                  size="small"
                  onClick={async () => {
                    try {
                      await Promise.all(
                        queueState.queue_running.map((item) =>
                          api().svcComfy.cancelQueueItem({ prompt_id: item[1] })
                        )
                      )
                      notifySuccess(t('quickapp.queue.cancel_success'))
                    } catch (error) {
                      notifyError(t('quickapp.queue.cancel_failed'))
                    }
                  }}
                  sx={{
                    p: 0.25,
                    color: 'error.main',
                    '&:hover': { bgcolor: 'error.main', color: '#fff' }
                  }}
                >
                  <CloseIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Box>
            </>
          )}

          {/* 等待中队列 */}
          {queueState.queue_pending.length > 0 && (
            <>
              <Divider orientation="vertical" flexItem />
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                <Typography variant="body2" color="text.secondary" sx={{ fontStyle: 'italic' }}>
                  {t('quickapp.queue.pending').replace(
                    '{n}',
                    String(queueState.queue_pending.length)
                  )}
                </Typography>
                <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', alignItems: 'center' }}>
                  {queueState.queue_pending.map((item) => {
                    const promptId = item[1]
                    return (
                      <Box key={promptId} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                        <ProgressChip
                          label={`${promptId.substring(0, 10)}...`}
                          progress={0}
                          size="small"
                          sx={{ minWidth: 100 }}
                        />
                        <IconButton
                          size="small"
                          onClick={async () => {
                            try {
                              await api().svcComfy.cancelQueueItem({ prompt_id: promptId })
                              notifySuccess(t('quickapp.queue.cancel_success'))
                            } catch (error) {
                              notifyError(t('quickapp.queue.cancel_failed'))
                            }
                          }}
                          sx={{ padding: 0.5 }}
                        >
                          <CloseIcon fontSize="small" />
                        </IconButton>
                      </Box>
                    )
                  })}
                </Box>
              </Box>
            </>
          )}

          {/* 队列为空状态 */}
          {queueState.queue_running.length === 0 &&
            queueState.queue_pending.length === 0 &&
            queueState.queue_error.length === 0 && (
              <>
                <Divider orientation="vertical" flexItem />
                <Typography variant="body2" color="text.secondary" sx={{ fontStyle: 'italic' }}>
                  {t('quickapp.queue.empty')}
                </Typography>
              </>
            )}
        </Stack>
      </Box>

      <ErrorModalInfo promptId={errorModalPromptId} setPromptId={setErrorModalPromptId} />
    </Box>
  )
}
