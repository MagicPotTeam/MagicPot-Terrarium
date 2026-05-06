import React from 'react'
import { Box, Button, Paper, Stack, Typography } from '@mui/material'
import { OpenInNew as OpenInNewIcon, ThreeSixty as ThreeSixtyIcon } from '@mui/icons-material'
import { useNavigate } from 'react-router-dom'
import {
  getImageEditWorkflowUnavailableLabel,
  IMAGE_PERSPECTIVE_WORKFLOW
} from './imageEditWorkflowTargets'
import { useImageEditWorkflowAvailability } from './useImageEditWorkflowAvailability'

export const MultiAnglePanel: React.FC = () => {
  const navigate = useNavigate()
  const { isChecking, isLaunchable } = useImageEditWorkflowAvailability(IMAGE_PERSPECTIVE_WORKFLOW)

  const openMultiAngleQApp = () => {
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
          <ThreeSixtyIcon color="primary" />
          <Box>
            <Typography variant="subtitle1" sx={{ fontWeight: 800, lineHeight: 1.15 }}>
              {IMAGE_PERSPECTIVE_WORKFLOW.title}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              This is the image-side perspective and lighting entrypoint. It opens the shipped
              multi-angle workflow with angle controls and zoom controls instead of a stubbed
              placeholder.
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

        <Stack direction="row" spacing={1} justifyContent="flex-end" useFlexGap flexWrap="wrap">
          <Button variant="outlined" disabled={!isLaunchable} onClick={openMultiAngleQApp}>
            Open image workflow in designer
          </Button>
          <Button
            variant="contained"
            endIcon={<OpenInNewIcon />}
            disabled={!isLaunchable}
            onClick={openMultiAngleQApp}
          >
            Open multi-angle template
          </Button>
        </Stack>

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
