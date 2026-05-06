import React from 'react'
import { Box, IconButton, Tooltip, Divider, styled, useTheme } from '@mui/material'
import {
  Create as CreateIcon,
  AutoFixHigh as AutoFixHighIcon,
  Crop as CropIcon,
  ZoomOutMap as ZoomOutMapIcon,
  AspectRatio as AspectRatioIcon,
  LightMode as LightModeIcon,
  ThreeSixty as ThreeSixtyIcon,
  DownloadOutlined,
  Close as CloseIcon,
  Clear as EraseIcon
} from '@mui/icons-material'
import { useTranslation } from 'react-i18next'

const ToolbarButton = styled(IconButton)(({ theme }) => ({
  color: theme.palette.text.primary,
  padding: '6px',
  borderRadius: '8px',
  '&:hover': {
    backgroundColor: theme.palette.mode === 'light' ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.1)'
  },
  '&.active': {
    backgroundColor: theme.palette.primary.main,
    color: theme.palette.primary.contrastText
  }
}))

const ToolLabel = styled('span')(({ theme }) => ({
  fontSize: '12px',
  fontWeight: 500,
  marginLeft: '4px'
}))

export type EditToolState = {
  activeTool: 'none' | 'lighting' | 'multiAngle' | 'crop' | string
}

type ToolbarIcon = React.ComponentType<{ fontSize?: 'inherit' | 'small' | 'medium' | 'large' }>

type Props = {
  activeTool: string
  onSelectTool: (tool: string) => void
  onDownload: () => void
  onClose?: () => void
}

export const ImageEditToolbar: React.FC<Props> = ({
  activeTool,
  onSelectTool,
  onDownload,
  onClose
}) => {
  const { t } = useTranslation()
  const theme = useTheme()
  const isLight = theme.palette.mode === 'light'

  const ActionButton = ({
    icon: Icon,
    label,
    value,
    tooltip
  }: {
    icon: ToolbarIcon
    label: string
    value: string
    tooltip?: string
  }) => (
    <Tooltip title={tooltip ?? label} arrow>
      <ToolbarButton
        className={activeTool === value ? 'active' : ''}
        aria-label={tooltip ?? label}
        onClick={() => onSelectTool(activeTool === value ? 'none' : value)}
      >
        <Icon fontSize="small" />
        <ToolLabel>{label}</ToolLabel>
      </ToolbarButton>
    </Tooltip>
  )

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.5,
        backgroundColor: isLight ? 'rgba(255,255,255,0.9)' : 'rgba(30,30,30,0.9)',
        backdropFilter: 'blur(10px)',
        borderRadius: '12px',
        padding: '6px 12px',
        boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
        border: `1px solid ${isLight ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.1)'}`
      }}
    >
      <ActionButton icon={CreateIcon} label={t('image_edit.redraw')} value="redraw" />
      <ActionButton icon={EraseIcon} label={t('image_edit.erase')} value="erase" />
      <ActionButton icon={AutoFixHighIcon} label={t('image_edit.matting')} value="matting" />
      <ActionButton icon={AutoFixHighIcon} label={t('image_edit.enhance')} value="enhance" />
      <ActionButton icon={ZoomOutMapIcon} label={t('image_edit.outpaint')} value="outpaint" />
      <ActionButton icon={AspectRatioIcon} label={t('image_edit.viewplane')} value="viewplane" />
      <ActionButton
        icon={LightModeIcon}
        label={t('image_edit.lighting')}
        value="lighting"
        tooltip={t('image_edit.lighting_tooltip')}
      />

      <Divider orientation="vertical" flexItem sx={{ mx: 1, my: 0.5 }} />

      <ActionButton
        icon={ThreeSixtyIcon}
        label={t('image_edit.multi_angle')}
        value="multiAngle"
        tooltip={t('image_edit.multi_angle_tooltip')}
      />

      <Divider orientation="vertical" flexItem sx={{ mx: 1, my: 0.5 }} />

      <ActionButton icon={CropIcon} label={t('image_edit.crop')} value="crop" />

      <Tooltip title={t('image_edit.download')} arrow>
        <ToolbarButton onClick={onDownload}>
          <DownloadOutlined fontSize="small" />
        </ToolbarButton>
      </Tooltip>

      {onClose && (
        <Tooltip title={t('image_edit.close')} arrow>
          <ToolbarButton onClick={onClose} sx={{ ml: 0.5 }}>
            <CloseIcon fontSize="small" />
          </ToolbarButton>
        </Tooltip>
      )}
    </Box>
  )
}
