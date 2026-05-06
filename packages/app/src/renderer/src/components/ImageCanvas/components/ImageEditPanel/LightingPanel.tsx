import React from 'react'
import { Box, Button, Paper, Stack, Typography } from '@mui/material'
import { LightMode as LightModeIcon, OpenInNew as OpenInNewIcon } from '@mui/icons-material'
import { useNavigate } from 'react-router-dom'
import {
  getImageEditWorkflowUnavailableLabel,
  IMAGE_PERSPECTIVE_WORKFLOW,
  VIDEO_PERSPECTIVE_WORKFLOW
} from './imageEditWorkflowTargets'
import { useImageEditWorkflowAvailability } from './useImageEditWorkflowAvailability'

type WorkflowCardProps = {
  workflow: typeof IMAGE_PERSPECTIVE_WORKFLOW
  variant: 'outlined' | 'contained'
  onOpen: (workflowKey: string) => void
}

const WorkflowCard: React.FC<WorkflowCardProps> = ({ workflow, variant, onOpen }) => {
  const { isChecking, isLaunchable } = useImageEditWorkflowAvailability(workflow)

  return (
    <Box
      sx={(theme) => ({
        borderRadius: 2,
        px: 1.5,
        py: 1.25,
        bgcolor: theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.04)' : 'rgba(79,95,228,0.06)',
        border: '1px dashed',
        borderColor:
          theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.12)' : 'rgba(79,95,228,0.2)'
      })}
    >
      <Stack spacing={1}>
        <Box>
          <Typography variant="caption" color="text.secondary">
            {workflow.entryLabel}
          </Typography>
          <Typography variant="body2" sx={{ fontWeight: 700 }}>
            {workflow.key}
          </Typography>
        </Box>

        <Box>
          <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>
            {workflow.title}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
            {workflow.description}
          </Typography>
        </Box>

        <Button
          variant={variant}
          endIcon={<OpenInNewIcon />}
          disabled={!isLaunchable}
          onClick={() => onOpen(workflow.key.trim())}
          sx={{ alignSelf: 'flex-start' }}
        >
          {workflow.launchLabel}
        </Button>

        <Typography variant="caption" color="text.secondary">
          {isChecking
            ? 'Checking shipped workflow availability...'
            : isLaunchable
              ? 'Shipped Quick App template is available.'
              : getImageEditWorkflowUnavailableLabel(workflow)}
        </Typography>
      </Stack>
    </Box>
  )
}

export const LightingPanel: React.FC = () => {
  const navigate = useNavigate()

  const openWorkflow = (workflowKey: string) => {
    const trimmedKey = workflowKey.trim()
    if (!trimmedKey) return
    navigate('/qappdesign', { state: { loadQAppKey: trimmedKey } })
  }

  return (
    <Paper
      elevation={8}
      sx={(theme) => ({
        width: 420,
        borderRadius: 3,
        p: 2.5,
        border: '1px solid',
        borderColor: theme.palette.divider,
        bgcolor: theme.palette.mode === 'dark' ? 'rgba(20,24,35,0.98)' : 'background.paper'
      })}
    >
      <Stack spacing={2}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
          <LightModeIcon color="primary" />
          <Box>
            <Typography variant="subtitle1" sx={{ fontWeight: 800, lineHeight: 1.15 }}>
              Perspective and lighting open real shipped workflows
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              These entrypoints do not route to a stub. The image-side launcher opens the shipped
              multi-angle template, and the video-side launcher opens the shipped Wan 2.2
              image-to-video template.
            </Typography>
          </Box>
        </Box>

        <Stack spacing={1.25}>
          <WorkflowCard
            workflow={IMAGE_PERSPECTIVE_WORKFLOW}
            variant="outlined"
            onOpen={openWorkflow}
          />
          <WorkflowCard
            workflow={VIDEO_PERSPECTIVE_WORKFLOW}
            variant="contained"
            onOpen={openWorkflow}
          />
        </Stack>

        <Typography variant="caption" color="text.secondary">
          If a workflow key is missing, the button stays disabled rather than navigating to a
          placeholder.
        </Typography>
      </Stack>
    </Paper>
  )
}
