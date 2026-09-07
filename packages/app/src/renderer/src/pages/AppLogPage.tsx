import React, { useState } from 'react'
import { Box, Paper, Button, Stack } from '@mui/material'
import { Terminal as TerminalIcon } from '@mui/icons-material'
import { useTheme } from '@mui/material/styles'
import { useTranslation } from 'react-i18next'
import { useAppLogs } from '@renderer/hooks/useAppLogs'
import VirtualLogViewport from '@renderer/components/VirtualLogViewport'

const AppLogPage: React.FC = () => {
  const { t } = useTranslation()
  const theme = useTheme()
  const isLight = theme.palette.mode === 'light'
  const { lines, firstIndex, generation, clear } = useAppLogs()
  const [tailRequest, setTailRequest] = useState(0)

  return (
    <Box sx={{ height: '100%', minHeight: 0, display: 'flex', bgcolor: 'background.default' }}>
      <Paper
        sx={(tMui) => ({
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          m: 2,
          display: 'flex',
          flexDirection: 'column',
          bgcolor: tMui.palette.mode === 'light' ? '#d1d2e6' : undefined
        })}
      >
        <Box sx={{ p: 3, borderBottom: 1, borderColor: 'divider' }}>
          <Stack direction="row" justifyContent="flex-end" alignItems="center">
            <Stack direction="row" spacing={2}>
              <Button onClick={clear}>{t('common.clear', '清空')}</Button>
              <Button
                variant="outlined"
                startIcon={<TerminalIcon />}
                onClick={() => setTailRequest((value) => value + 1)}
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
            minHeight: 0,
            display: 'flex',
            p: 2,
            bgcolor: isLight ? '#f8fafc' : '#0d1117'
          }}
        >
          <VirtualLogViewport
            lines={lines}
            firstIndex={firstIndex}
            generation={generation}
            tailRequest={tailRequest}
            label={t('terminal.terminal_log', 'Application logs')}
            emptyText="日志监听已就绪..."
            style={{ color: isLight ? '#1f2937' : '#c9d1d9' }}
            lineColor={(line) =>
              line.includes('[ERROR]')
                ? isLight
                  ? '#b42318'
                  : '#ff7b72'
                : line.includes('[WARN]')
                  ? isLight
                    ? '#b54708'
                    : '#e3b341'
                  : undefined
            }
          />
        </Box>
      </Paper>
    </Box>
  )
}

export default AppLogPage
