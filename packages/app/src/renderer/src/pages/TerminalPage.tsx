// packages/app/src/renderer/src/pages/Terminal/TerminalPage.tsx
import React, { useState, useRef, useEffect, useCallback } from 'react'
import { Box, Paper, Typography, Button, Stack } from '@mui/material'
import {
  Terminal as TerminalIcon,
  PlayArrow as PlayArrowIcon,
  Stop as StopIcon
} from '@mui/icons-material'
import { api } from '@renderer/utils/windowUtils'
import { useComfyProcess } from '@renderer/store/hooks/comfyProcess'
import { useLocation } from 'react-router-dom'
import { isServerStreamingError } from '@shared/api/apiUtils/streaming'
import { useTranslation } from 'react-i18next'
import { useTheme } from '@mui/material/styles'

const SCROLL_TO_BOTTOM_THRESHOLD = 20

const TerminalPage: React.FC = () => {
  const { t } = useTranslation()
  const theme = useTheme()
  const isLight = theme.palette.mode === 'light'
  const consoleBackground = isLight ? '#f8fafc' : '#0d1117'
  const consoleTextColor = isLight ? '#1f2937' : '#c9d1d9'
  const consoleMutedColor = isLight ? '#667085' : '#8b949e'
  const consoleScrollbarTrack = isLight ? '#e5e7eb' : '#161b22'
  const consoleScrollbarThumb = isLight ? '#c0c8d2' : '#30363d'
  const location = useLocation()
  const { state, setPid, setIsRunning, addOutput } = useComfyProcess()
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true)
  const outputRef = useRef<HTMLDivElement>(null)
  const autoStartRef = useRef(false)

  // 检查是否滚动到底部
  const isScrolledToBottom = () => {
    if (!outputRef.current) return true
    const { scrollTop, scrollHeight, clientHeight } = outputRef.current
    return Math.abs(scrollTop + clientHeight - scrollHeight) < SCROLL_TO_BOTTOM_THRESHOLD
  }

  // 滚动到底部
  const scrollToBottom = () => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }

  // 处理滚动事件
  const handleScroll = () => {
    setShouldAutoScroll(isScrolledToBottom())
  }

  // 当输出更新时自动滚动
  useEffect(() => {
    if (shouldAutoScroll) {
      scrollToBottom()
    }
  }, [state.output, shouldAutoScroll])

  const handleStartServer = useCallback(async () => {
    if (state.isRunning) {
      return
    }

    try {
      const { pid } = await api().svcHyper.comfyPortDetect({})
      if (pid !== 0) {
        if (pid !== state.pid) {
          setPid(pid)
        }
        window.dispatchEvent(new CustomEvent('comfyui:ready'))
        return
      }

      setIsRunning(true)
      addOutput(t('terminal.starting_server'))
      await api().svcHyper.startComfyUI(
        {},
        {
          onData: (data) => {
            if (data.pid !== 0 && data.pid !== state.pid) {
              setPid(data.pid)
            }
          }
        }
      )
    } catch (error) {
      if (isServerStreamingError(error)) {
        addOutput('ERROR> ' + error.message)
      } else {
        addOutput('ERROR> ' + String(error))
      }
    } finally {
      setIsRunning(false)
    }
  }, [setIsRunning, addOutput, setPid, state.isRunning, state.pid, t])

  // 快速启动逻辑（仅一次）
  useEffect(() => {
    const quickStart = location.state?.quickStart
    if (quickStart && !state.isRunning && !autoStartRef.current) {
      autoStartRef.current = true
      handleStartServer()
    }
  }, [location.state, state.isRunning, handleStartServer])

  const handleStopServer = async () => {
    addOutput(t('terminal.stopping_server'))
    await api().svcHyper.killSubProcess({ pid: state.pid })
    addOutput(t('terminal.server_stopped'))
    setIsRunning(false)
  }

  // 强制滚动到底部
  const handleForceScrollToBottom = () => {
    setShouldAutoScroll(true)
    scrollToBottom()
  }

  //（保留：你原来的快速命令示例列表，这里只是展示，不做国际化）
  const quickCommands = [
    { label: '启动 ComfyUI', command: 'python main.py' },
    { label: '检查 GPU', command: 'nvidia-smi' },
    { label: '检查 Python', command: 'python --version' },
    { label: '列出模型', command: 'ls models/' }
  ]

  return (
    <Box sx={{ height: '100%', display: 'flex', bgcolor: 'background.default' }}>
      <Paper
        sx={(tMui) => ({
          flex: 1,
          m: 2,
          display: 'flex',
          flexDirection: 'column',
          bgcolor: tMui.palette.mode === 'light' ? '#d1d2e6' : undefined
        })}
      >
        {/* 头部 */}
        <Box sx={{ p: 3, borderBottom: 1, borderColor: 'divider' }}>
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            {state.pid !== 0 && (
              <Typography variant="body2" color="text.secondary">
                {t('terminal.pid_label')}: {state.pid}
              </Typography>
            )}

            {/* 占位，用于稳定按钮到右侧 */}
            <Box />

            <Stack direction="row" spacing={2}>
              <Button
                variant="contained"
                color="success"
                startIcon={<PlayArrowIcon />}
                onClick={handleStartServer}
                disabled={state.isRunning}
              >
                {t('terminal.btn_start')}
              </Button>
              <Button
                variant="contained"
                color="error"
                startIcon={<StopIcon />}
                onClick={handleStopServer}
                disabled={!state.isRunning}
              >
                {t('terminal.btn_stop')}
              </Button>
              <Button
                variant="outlined"
                startIcon={<TerminalIcon />}
                onClick={handleForceScrollToBottom}
                size="small"
              >
                {t('terminal.btn_scroll_bottom')}
              </Button>
            </Stack>
          </Stack>
        </Box>

        {/* 端口占用提醒 */}

        {/* 终端输出区域 */}
        <Box
          sx={{
            flex: 1,
            p: 2,
            bgcolor: consoleBackground,
            color: consoleTextColor,
            fontFamily: 'monospace',
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column'
          }}
        >
          <Box
            ref={outputRef}
            onScroll={handleScroll}
            sx={{
              flex: 1,
              overflow: 'auto',
              wordBreak: 'break-all',
              whiteSpace: 'pre-wrap',
              '&::-webkit-scrollbar': { width: '8px', height: '8px' },
              '&::-webkit-scrollbar-track': { background: consoleScrollbarTrack },
              '&::-webkit-scrollbar-thumb': {
                background: consoleScrollbarThumb,
                borderRadius: '4px'
              },
              '&::-webkit-scrollbar-thumb:hover': {
                background: isLight ? '#a8b3c2' : '#484f58'
              },
              '&::-webkit-scrollbar-corner': { background: consoleScrollbarTrack }
            }}
          >
            {state.output.map((line, index) => (
              <Box key={index} sx={{ mb: 0.5, lineHeight: 1.4 }}>
                {line}
              </Box>
            ))}
            {state.output.length === 0 && (
              <Typography variant="body2" sx={{ color: consoleMutedColor }}>
                {t('terminal.title_ready')}
              </Typography>
            )}
          </Box>
        </Box>
      </Paper>
    </Box>
  )
}

export default TerminalPage
