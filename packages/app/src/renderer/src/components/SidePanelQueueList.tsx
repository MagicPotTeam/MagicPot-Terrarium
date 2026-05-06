import React from 'react'
import { Box, Typography, IconButton, Stack } from '@mui/material'
import { Close as CloseIcon } from '@mui/icons-material'
import { QueueItem } from '@shared/comfy/types'
import { QueueState } from './SidePanel'
import { api } from '@renderer/utils/windowUtils'

export const SidePanelQueueList: React.FC<{
  queueState: QueueState
  notifySuccess: (msg: string) => void
  notifyError: (msg: string) => void
}> = ({ queueState, notifySuccess, notifyError }) => {
  const handleCancelClick = async (promptId: string) => {
    try {
      await api().svcComfy.cancelQueueItem({ prompt_id: promptId })
      notifySuccess('已取消')
    } catch {
      notifyError('取消失败')
    }
  }

  const handleCancelAll = async (list: QueueItem[]) => {
    try {
      await Promise.all(list.map((item) => api().svcComfy.cancelQueueItem({ prompt_id: item[1] })))
      notifySuccess('成功取消所有任务')
    } catch {
      notifyError('取消失败')
    }
  }

  return (
    <Box
      sx={(theme) => ({
        px: 1.5,
        py: 1.5,
        borderBottom: 1,
        borderColor: 'divider',
        maxHeight: 280,
        overflowY: 'auto',
        bgcolor: theme.palette.mode === 'dark' ? 'rgba(0,0,0,0.15)' : 'rgba(0,0,0,0.02)',
        boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.02)'
      })}
    >
      {queueState.queue_running.length > 0 && (
        <Box sx={{ mb: 1.5 }}>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              mb: 0.75
            }}
          >
            <Typography
              sx={{
                fontSize: 11,
                fontWeight: 700,
                color: 'primary.main',
                display: 'flex',
                alignItems: 'center',
                gap: 0.5
              }}
            >
              <span style={{ animation: 'pulse-opacity 1.5s infinite' }}>⚡</span> 运行中 (
              {queueState.queue_running.length})
            </Typography>
            <IconButton
              size="small"
              onClick={() => handleCancelAll(queueState.queue_running)}
              title="取消所有"
              sx={(theme) => ({
                p: 0.25,
                color: 'error.main',
                bgcolor:
                  theme.palette.mode === 'dark'
                    ? 'rgba(211, 47, 47, 0.1)'
                    : 'rgba(211, 47, 47, 0.05)',
                '&:hover': { bgcolor: 'error.main', color: '#fff' }
              })}
            >
              <CloseIcon sx={{ fontSize: 13 }} />
            </IconButton>
          </Box>
          <Stack spacing={0.75}>
            {queueState.queue_running.map((item) => {
              const promptId = item[1]
              return (
                <Box
                  key={`running-${promptId}`}
                  sx={(theme) => ({
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    py: 0.75,
                    px: 1.25,
                    borderRadius: '8px',
                    bgcolor:
                      theme.palette.mode === 'dark'
                        ? 'rgba(0, 120, 212, 0.1)'
                        : 'rgba(0, 120, 212, 0.05)',
                    border: '1px solid',
                    borderColor:
                      theme.palette.mode === 'dark'
                        ? 'rgba(0, 120, 212, 0.2)'
                        : 'rgba(0, 120, 212, 0.15)'
                  })}
                >
                  <Typography
                    sx={{
                      fontSize: 11,
                      color: 'text.primary',
                      fontFamily: 'monospace',
                      opacity: 0.9
                    }}
                  >
                    {promptId.substring(0, 8)}...
                  </Typography>
                </Box>
              )
            })}
          </Stack>
        </Box>
      )}

      {queueState.queue_pending.length > 0 && (
        <Box sx={{ mb: 1.5 }}>
          <Typography
            sx={{ fontSize: 11, fontWeight: 700, color: 'text.secondary', mb: 0.75, px: 0.5 }}
          >
            排队中 ({queueState.queue_pending.length})
          </Typography>
          <Stack spacing={0.75}>
            {queueState.queue_pending.map((item) => {
              const promptId = item[1]
              return (
                <Box
                  key={promptId}
                  sx={(theme) => ({
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    py: 0.5,
                    px: 1.25,
                    borderRadius: '8px',
                    bgcolor:
                      theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
                    border: '1px solid',
                    borderColor: 'divider'
                  })}
                >
                  <Typography
                    sx={{ fontSize: 11, color: 'text.disabled', fontFamily: 'monospace' }}
                  >
                    {promptId.substring(0, 8)}...
                  </Typography>
                  <IconButton
                    size="small"
                    onClick={() => handleCancelClick(promptId)}
                    sx={{ p: 0.25, opacity: 0.5, '&:hover': { opacity: 1, color: 'error.main' } }}
                  >
                    <CloseIcon sx={{ fontSize: 12 }} />
                  </IconButton>
                </Box>
              )
            })}
          </Stack>
        </Box>
      )}

      {queueState.queue_error.length > 0 && (
        <Box>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              mb: 0.75,
              px: 0.5
            }}
          >
            <Typography sx={{ fontSize: 11, fontWeight: 700, color: 'error.main' }}>
              失败 ({queueState.queue_error.length})
            </Typography>
            <Typography
              onClick={() => handleCancelAll(queueState.queue_error)}
              sx={{
                fontSize: 10,
                color: 'text.disabled',
                cursor: 'pointer',
                '&:hover': { color: 'error.main', textDecoration: 'underline' }
              }}
            >
              清除全部
            </Typography>
          </Box>
          <Stack spacing={0.75}>
            {queueState.queue_error.map((item) => {
              const promptId = item[1]
              return (
                <Box
                  key={promptId}
                  sx={(theme) => ({
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    py: 0.5,
                    px: 1.25,
                    borderRadius: '8px',
                    bgcolor:
                      theme.palette.mode === 'dark'
                        ? 'rgba(211, 47, 47, 0.05)'
                        : 'rgba(211, 47, 47, 0.03)',
                    border: '1px solid',
                    borderColor:
                      theme.palette.mode === 'dark'
                        ? 'rgba(211, 47, 47, 0.2)'
                        : 'rgba(211, 47, 47, 0.15)'
                  })}
                >
                  <Typography sx={{ fontSize: 11, color: 'error.main', fontFamily: 'monospace' }}>
                    {promptId.substring(0, 8)}...
                  </Typography>
                  <IconButton
                    size="small"
                    onClick={() => handleCancelClick(promptId)}
                    sx={{
                      p: 0.25,
                      color: 'error.main',
                      opacity: 0.7,
                      '&:hover': { opacity: 1, bgcolor: 'error.main', color: '#fff' }
                    }}
                  >
                    <CloseIcon sx={{ fontSize: 12 }} />
                  </IconButton>
                </Box>
              )
            })}
          </Stack>
        </Box>
      )}
    </Box>
  )
}
