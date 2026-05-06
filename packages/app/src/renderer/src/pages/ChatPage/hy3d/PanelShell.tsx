import React from 'react'
import { Box, IconButton, Tooltip, Typography } from '@mui/material'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'

import { hyColors, scrollbarSx } from './theme'

interface PanelShellProps {
  title: string
  submitLabel: string
  submitIcon?: 'rocket' | 'sparkle'
  submitDisabled?: boolean
  onSubmit?: () => void
  children: React.ReactNode
}

const PanelShell: React.FC<PanelShellProps> = ({
  title,
  submitLabel,
  submitDisabled = false,
  onSubmit,
  children
}) => {
  return (
    <Box
      className="hy3d-panel-shell"
      sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
    >
      <Box
        className="hy3d-panel-shell-header"
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          px: 2.2,
          py: 1.35,
          borderBottom: `1px solid ${hyColors.border}`,
          flexShrink: 0
        }}
      >
        <Typography
          sx={{
            fontSize: 16,
            fontWeight: 600,
            color: hyColors.textPrimary,
            letterSpacing: '0.3px'
          }}
        >
          {title}
        </Typography>

        <Tooltip title={submitLabel}>
          <span>
            <IconButton
              size="small"
              aria-label={submitLabel}
              disabled={submitDisabled}
              onClick={onSubmit}
              sx={{
                p: 0.5,
                flexShrink: 0,
                ml: 0.5,
                color: submitDisabled ? hyColors.disabledText : '#7E73FD',
                bgcolor: submitDisabled ? hyColors.disabledBg : '#ffffff',
                borderRadius: 1,
                boxShadow: submitDisabled ? 'none' : '0 2px 4px rgba(0,0,0,0.15)',
                transition:
                  'background-color 0.15s ease, transform 0.1s ease, box-shadow 0.15s ease',
                '&:hover': submitDisabled
                  ? {}
                  : {
                      bgcolor: '#f8f8f8',
                      transform: 'scale(1.12)',
                      boxShadow: '0 4px 8px rgba(0,0,0,0.2)'
                    },
                '&:active': submitDisabled
                  ? {}
                  : {
                      transform: 'scale(0.95)'
                    },
                '&.Mui-disabled': {
                  bgcolor: hyColors.disabledBg,
                  color: hyColors.disabledText
                }
              }}
            >
              <PlayArrowIcon sx={{ fontSize: 20 }} />
            </IconButton>
          </span>
        </Tooltip>
      </Box>

      <Box
        className="hy3d-panel-shell-body"
        sx={{
          flex: 1,
          overflow: 'auto',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          px: 2.2,
          py: 1.7,
          ...scrollbarSx
        }}
      >
        {children}
      </Box>
    </Box>
  )
}

export default PanelShell
