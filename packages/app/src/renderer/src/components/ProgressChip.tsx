import React, { MouseEventHandler } from 'react'
import { Chip, LinearProgress, Box, SxProps, Theme } from '@mui/material'

export type ProgressChipProps = {
  label: string
  progress: number // 0-1
  color?: 'default' | 'primary' | 'secondary' | 'error' | 'info' | 'success' | 'warning'
  size?: 'small' | 'medium'
  onClick?: MouseEventHandler<HTMLDivElement>
  icon?: React.ReactElement
  sx?: SxProps<Theme>
  showPercentage?: boolean
}

export const ProgressChip: React.FC<ProgressChipProps> = ({
  label,
  progress,
  color,
  size,
  onClick,
  icon,
  sx,
  showPercentage = true
}) => {
  const progressPercent = Math.round(progress * 100)
  const displayLabel = showPercentage ? `${label} ${progressPercent}%` : label

  return (
    <Box
      sx={{
        position: 'relative',
        display: 'inline-flex',
        flexDirection: 'column',
        ...sx
      }}
    >
      <Chip
        onClick={onClick}
        label={displayLabel}
        color={color}
        size={size}
        icon={icon}
        variant="outlined"
        sx={{
          position: 'relative',
          minWidth: showPercentage ? 140 : 100
        }}
      />
      <LinearProgress
        variant="determinate"
        value={progress * 100}
        color={color === 'error' ? 'error' : color === 'warning' ? 'warning' : 'primary'}
        sx={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          height: 3,
          borderRadius: '0 0 16px 16px',
          backgroundColor: 'transparent',
          '& .MuiLinearProgress-bar': {
            borderRadius: '0 0 16px 16px'
          }
        }}
      />
    </Box>
  )
}
