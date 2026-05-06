import React from 'react'
import { Box, Button, Paper, Stack, Typography } from '@mui/material'
import { OpenInNew as OpenInNewIcon, AspectRatio as AspectRatioIcon } from '@mui/icons-material'
import { useNavigate } from 'react-router-dom'
import {
  getImageEditWorkflowUnavailableLabel,
  IMAGE_PERSPECTIVE_WORKFLOW
} from './imageEditWorkflowTargets'
import { useImageEditWorkflowAvailability } from './useImageEditWorkflowAvailability'

export const ViewplanePanel: React.FC = () => {
  const navigate = useNavigate()
  const { isChecking, isLaunchable } = useImageEditWorkflowAvailability(IMAGE_PERSPECTIVE_WORKFLOW)

  const openPerspectiveWorkflow = () => {
    const trimmedKey = IMAGE_PERSPECTIVE_WORKFLOW.key.trim()
    if (!trimmedKey) return
    navigate('/qappdesign', { state: { loadQAppKey: trimmedKey } })
  }

  return (
    <Paper
      elevation={8}
      sx={(theme) => ({
        width: 380,
        borderRadius: 3,
        p: 2.5,
        border: '1px solid',
        borderColor: theme.palette.divider,
        bgcolor: theme.palette.mode === 'dark' ? 'rgba(20,24,35,0.98)' : 'background.paper'
      })}
    >
      <Stack spacing={2}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
          <AspectRatioIcon color="primary" />
          <Box>
            <Typography variant="subtitle1" sx={{ fontWeight: 800, lineHeight: 1.15 }}>
              Viewplane opens the shipped image perspective workflow
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              This entrypoint is no longer a dead toggle. It opens the shipped image-side
              perspective workflow in the Quick App designer so users can work from a real template.
            </Typography>
          </Box>
        </Box>

        <Box
          sx={(theme) => ({
            borderRadius: 2,
            px: 1.5,
            py: 1.25,
            bgcolor:
              theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.04)' : 'rgba(79,95,228,0.06)',
            border: '1px dashed',
            borderColor:
              theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.12)' : 'rgba(79,95,228,0.2)'
          })}
        >
          <Typography variant="caption" color="text.secondary">
            {IMAGE_PERSPECTIVE_WORKFLOW.entryLabel}
          </Typography>
          <Typography variant="body2" sx={{ fontWeight: 700 }}>
            {IMAGE_PERSPECTIVE_WORKFLOW.key}
          </Typography>
        </Box>

        <Button
          variant="contained"
          endIcon={<OpenInNewIcon />}
          disabled={!isLaunchable}
          onClick={openPerspectiveWorkflow}
          sx={{ alignSelf: 'flex-start' }}
        >
          Open viewplane workflow
        </Button>

        <Typography variant="caption" color="text.secondary">
          {isChecking
            ? 'Checking shipped workflow availability...'
            : isLaunchable
              ? 'Shipped Quick App template is available.'
              : getImageEditWorkflowUnavailableLabel(IMAGE_PERSPECTIVE_WORKFLOW)}
        </Typography>
      </Stack>
    </Paper>
  )
}
