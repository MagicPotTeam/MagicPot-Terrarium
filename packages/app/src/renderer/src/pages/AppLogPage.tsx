import React, { useState, useEffect, useRef } from 'react'
import { Box, Paper, Typography, Button, Stack } from '@mui/material'
import { Terminal as TerminalIcon } from '@mui/icons-material'
import { useTheme } from '@mui/material/styles'
import { api } from '@renderer/utils/windowUtils'
import { useTranslation } from 'react-i18next'
import { newAbortHandler } from '@shared/api/apiUtils/abortHandler'
import { isServerStreamingError } from '@shared/api/apiUtils/streaming'

const SCROLL_TO_BOTTOM_THRESHOLD = 20
const MAX_LOG_LINES = 1000

type LogLine = {
  message: string
  level: string
  timestamp: string
}

const AppLogPage: React.FC = () => {
  const { t } = useTranslation()
  const theme = useTheme()
  const isLight = theme.palette.mode === 'light'
  const consoleBackground = isLight ? '#f8fafc' : '#0d1117'
  const consoleTextColor = isLight ? '#1f2937' : '#c9d1d9'
  const consoleMutedColor = isLight ? '#667085' : '#8b949e'
  const consoleScrollbarTrack = isLight ? '#e5e7eb' : '#161b22'
  const consoleScrollbarThumb = isLight ? '#c0c8d2' : '#30363d'
  const consoleErrorColor = isLight ? '#b42318' : '#ff7b72'
  const consoleWarnColor = isLight ? '#b54708' : '#e3b341'
  const [logs, setLogs] = useState<LogLine[]>([])
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true)
  const outputRef = useRef<HTMLDivElement>(null)

  // 检查是否滚动到底部
  const isScrolledToBottom = () => {
    if (!outputRef.current) return true
    const { scrollTop, scrollHeight, clientHeight } = outputRef.current
    return Math.abs(scrollTop + clientHeight - scrollHeight) < SCROLL_TO_BOTTOM_THRESHOLD
  }

  const scrollToBottom = () => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }

  const handleScroll = () => {
    setShouldAutoScroll(isScrolledToBottom())
  }

  // 这里的 useEffect 用于处理自动滚动
  useEffect(() => {
    if (shouldAutoScroll) {
      scrollToBottom()
    }
  }, [logs, shouldAutoScroll])

  // 监听日志
  useEffect(() => {
    const [abortSender, abortReceiver] = newAbortHandler()
    let mounted = true

    const startWatching = async () => {
      try {
        await api().svcLog.watchAppLogs(
          {},
          {
            onData: (data) => {
              if (!mounted) return

              const timeStr = new Date(data.timestamp).toLocaleTimeString()
              const levelPrefix = data.level === 'info' ? '' : `[${data.level.toUpperCase()}] `
              const newLine = {
                message: `${timeStr} ${levelPrefix}${data.message}`,
                level: data.level,
                timestamp: timeStr
              }

              setLogs((prev) => {
                const next = [...prev, newLine]
                if (next.length > MAX_LOG_LINES) {
                  return next.slice(next.length - MAX_LOG_LINES)
                }
                return next
              })
            },
            abortReceiver
          }
        )
      } catch (error) {
        if (mounted && !abortReceiver.isAborted() && !isServerStreamingError(error)) {
          console.error('Watch logs failed:', error)
        }
      }
    }

    void startWatching()

    return () => {
      mounted = false
      abortSender.abort()
    }
  }, [])

  const handleClearLogs = () => {
    setLogs([])
  }

  const handleForceScrollToBottom = () => {
    setShouldAutoScroll(true)
    scrollToBottom()
  }

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
        <Box sx={{ p: 3, borderBottom: 1, borderColor: 'divider' }}>
          <Stack direction="row" justifyContent="flex-end" alignItems="center">
            <Stack direction="row" spacing={2}>
              <Button onClick={handleClearLogs}>{t('common.clear', '清空')}</Button>
              <Button
                variant="outlined"
                startIcon={<TerminalIcon />}
                onClick={handleForceScrollToBottom}
                size="small"
              >
                {t('terminal.btn_scroll_bottom', '滚动到底部')}
              </Button>
            </Stack>
          </Stack>
        </Box>

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
              }
            }}
          >
            {logs.map((line, index) => (
              <Box
                key={index}
                sx={{
                  mb: 0.5,
                  lineHeight: 1.4,
                  color:
                    line.level === 'error'
                      ? consoleErrorColor
                      : line.level === 'warn'
                        ? consoleWarnColor
                        : consoleTextColor
                }}
              >
                {line.message}
              </Box>
            ))}
            {logs.length === 0 && (
              <Typography variant="body2" sx={{ color: consoleMutedColor }}>
                日志监听已就绪...
              </Typography>
            )}
          </Box>
        </Box>
      </Paper>
    </Box>
  )
}

export default AppLogPage
