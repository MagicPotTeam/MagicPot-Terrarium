import React from 'react'
import { HelpOutline } from '@mui/icons-material'
import { IconButton, SxProps, Theme, Tooltip } from '@mui/material'

type QuestionTooltipProps = {
  iconSx?: SxProps<Theme>
  children: React.ReactNode
}

const QuestionTooltip: React.FC<QuestionTooltipProps> = ({ children, iconSx }) => {
  return (
    <Tooltip title={children}>
      <HelpOutline fontSize="small" sx={{ color: 'text.secondary', ...iconSx }} />
    </Tooltip>
  )
}

export default QuestionTooltip
