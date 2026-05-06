import React from 'react'
import {
  AccessibilityNewOutlined,
  AutoAwesomeOutlined,
  AutorenewOutlined,
  ChangeHistoryOutlined,
  ChevronRight,
  GridViewOutlined,
  PhotoOutlined,
  PlayArrow,
  TextureOutlined
} from '@mui/icons-material'
import { Box, Collapse, IconButton, Tooltip } from '@mui/material'
import { useTheme } from '@mui/material/styles'

import { hyColors, scrollbarSx } from './theme'
import { WORKFLOW_STEPS } from './types'

interface WorkflowNavBarProps {
  activeStep: string
  onStepClick: (stepId: string) => void
  onRunStep?: (stepId: string) => void
  getStepActionMeta?: (stepId: string) => { label: string; disabled?: boolean }
  renderExpandedContent?: (stepId: string) => React.ReactNode
}

type MenuPaletteLike = {
  inactive?: string
  selectedBg?: string
  hoverBg?: string
}

const getStepIcon = (icon: string): React.ReactNode => {
  const iconSx = { fontSize: 15, color: 'inherit', opacity: 0.9 }

  switch (icon) {
    case 'concept':
      return <AutoAwesomeOutlined sx={iconSx} />
    case 'profile':
      return <AccessibilityNewOutlined sx={iconSx} />
    case 'split':
      return <GridViewOutlined sx={iconSx} />
    case 'topology':
      return <ChangeHistoryOutlined sx={iconSx} />
    case 'uv':
      return <PhotoOutlined sx={iconSx} />
    case 'texture':
      return <TextureOutlined sx={iconSx} />
    case 'convert':
      return <AutorenewOutlined sx={iconSx} />
    default:
      return null
  }
}

const WorkflowNavBar: React.FC<WorkflowNavBarProps> = ({
  activeStep,
  onStepClick,
  onRunStep,
  getStepActionMeta,
  renderExpandedContent
}) => {
  const theme = useTheme()
  const menuPalette = ((theme.palette as typeof theme.palette & { menu?: MenuPaletteLike }).menu ||
    {}) as MenuPaletteLike
  const inactiveTextColor = menuPalette.inactive || theme.palette.text.secondary
  const selectedRowColor =
    menuPalette.selectedBg ||
    (theme.palette.mode === 'dark' ? 'rgba(126, 115, 253, 0.18)' : 'rgba(53, 98, 231, 0.12)')
  const hoverRowColor =
    menuPalette.hoverBg ||
    (theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)')

  return (
    <Box
      sx={{
        flex: 1,
        minHeight: 0,
        py: 0.5,
        overflowY: 'auto',
        overflowX: 'hidden',
        ...scrollbarSx
      }}
    >
      <Box
        sx={{
          mx: 0.5,
          borderRadius: 2,
          overflow: 'hidden',
          border: `1px solid ${hyColors.border}`,
          bgcolor:
            theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.015)' : 'rgba(255,255,255,0.7)'
        }}
      >
        {WORKFLOW_STEPS.map((step, index) => {
          const isActive = step.id === activeStep
          const stepActionMeta = getStepActionMeta?.(step.id)
          const rowBg = isActive ? selectedRowColor : 'transparent'

          return (
            <Box
              key={step.id}
              sx={{
                borderBottom:
                  index === WORKFLOW_STEPS.length - 1 ? 'none' : `1px solid ${hyColors.border}`
              }}
            >
              <Box
                role="button"
                tabIndex={step.enabled ? 0 : -1}
                aria-label={step.label}
                aria-expanded={isActive}
                aria-pressed={isActive}
                aria-disabled={!step.enabled}
                onClick={() => step.enabled && onStepClick(step.id)}
                onKeyDown={(event) => {
                  if (!step.enabled) return

                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onStepClick(step.id)
                  }
                }}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  width: '100%',
                  minHeight: 44,
                  py: 0.35,
                  pl: 1.5,
                  pr: 0.65,
                  cursor: step.enabled ? 'pointer' : 'default',
                  userSelect: 'none',
                  outline: 'none',
                  opacity: step.enabled ? 1 : 0.38,
                  color: isActive ? '#ffffff' : inactiveTextColor,
                  bgcolor: rowBg,
                  transition: 'background-color 0.16s ease, color 0.16s ease, opacity 0.16s ease',
                  '&:hover': step.enabled
                    ? {
                        bgcolor: isActive ? selectedRowColor : hoverRowColor,
                        color: isActive ? '#ffffff' : theme.palette.text.primary
                      }
                    : {},
                  '&:focus-visible': {
                    bgcolor: isActive ? selectedRowColor : hoverRowColor,
                    color: isActive ? '#ffffff' : theme.palette.text.primary
                  }
                }}
              >
                <Box
                  sx={{
                    width: 18,
                    height: 18,
                    mr: 1.1,
                    flexShrink: 0,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                  }}
                >
                  {getStepIcon(step.icon)}
                </Box>

                <Box
                  sx={{
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontSize: 14,
                    fontWeight: isActive ? 700 : 500
                  }}
                >
                  {step.label}
                </Box>

                {isActive && onRunStep ? (
                  <Tooltip title={stepActionMeta?.label || 'Run current step'}>
                    <span>
                      <IconButton
                        size="small"
                        aria-label={stepActionMeta?.label || `${step.label} run`}
                        disabled={Boolean(stepActionMeta?.disabled)}
                        onClick={(event) => {
                          event.stopPropagation()
                          onRunStep(step.id)
                        }}
                        sx={{
                          p: 0.5,
                          ml: 0.5,
                          flexShrink: 0,
                          color: stepActionMeta?.disabled ? hyColors.disabledText : '#7E73FD',
                          bgcolor: stepActionMeta?.disabled ? hyColors.disabledBg : '#ffffff',
                          borderRadius: 1,
                          boxShadow: stepActionMeta?.disabled
                            ? 'none'
                            : '0 2px 4px rgba(0,0,0,0.15)',
                          transition:
                            'background-color 0.15s ease, transform 0.1s ease, box-shadow 0.15s ease',
                          '&:hover': stepActionMeta?.disabled
                            ? {}
                            : {
                                bgcolor: '#f8f8f8',
                                transform: 'scale(1.12)',
                                boxShadow: '0 4px 8px rgba(0,0,0,0.2)'
                              },
                          '&:active': stepActionMeta?.disabled
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
                        <PlayArrow sx={{ fontSize: 20 }} />
                      </IconButton>
                    </span>
                  </Tooltip>
                ) : (
                  <ChevronRight
                    sx={{
                      ml: 0.5,
                      flexShrink: 0,
                      fontSize: 18,
                      color: theme.palette.text.disabled
                    }}
                  />
                )}
              </Box>

              {renderExpandedContent && (
                <Collapse in={isActive} timeout={100} unmountOnExit>
                  <Box
                    sx={{
                      px: 0.5,
                      pb: 1.1,
                      bgcolor: rowBg,
                      '& .hy3d-panel-shell': {
                        height: 'auto',
                        minHeight: 0,
                        bgcolor: 'transparent'
                      },
                      '& .hy3d-panel-shell-header': {
                        display: 'none'
                      },
                      '& .hy3d-panel-shell-body': {
                        px: 1.6,
                        py: 1.3,
                        overflow: 'visible',
                        flex: 'none'
                      }
                    }}
                  >
                    {renderExpandedContent(step.id)}
                  </Box>
                </Collapse>
              )}
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}

export default WorkflowNavBar
