import React from 'react'
import { Box, IconButton, MenuItem, TextField, Typography } from '@mui/material'
import AddPhotoAlternateOutlinedIcon from '@mui/icons-material/AddPhotoAlternateOutlined'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'

import PanelShell from './PanelShell'
import { SectionLabel, TipBanner } from './ui'
import { hyColors, scrollbarSx } from './theme'
import type { Hy3dImageAttachment, Hy3dMediaState, Hy3dParams, Hy3dProfileTemplate } from './types'
import { PROFILE_TEMPLATE_OPTIONS } from './types'
import { getDroppedImageFile, hasDroppedImageData } from './imageDrop'
import { useImagePasteTarget } from './useImagePasteTarget'

interface ProfilePanelProps {
  params: Hy3dParams
  mediaState: Hy3dMediaState
  onParamsChange: (p: Partial<Hy3dParams>) => void
  onMediaStateChange: (state: Partial<Hy3dMediaState>) => void
  onGenerate?: () => void
}

const TEMPLATE_MENU_BG = '#181a1f'
const TEMPLATE_MENU_ITEM_BG = '#20232b'
const TEMPLATE_MENU_ITEM_SELECTED_BG = 'rgba(126,115,253,0.22)'

const toImageAttachment = async (file: File): Promise<Hy3dImageAttachment> => {
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('Failed to read image'))
    reader.readAsDataURL(file)
  })

  return {
    type: 'image',
    url,
    fileName: file.name,
    mimeType: file.type || 'image/png',
    slot: 'profile'
  }
}

const ProfilePanel: React.FC<ProfilePanelProps> = ({
  params,
  mediaState,
  onParamsChange,
  onMediaStateChange,
  onGenerate
}) => {
  const profileImage = mediaState.profileRefImage
  const [isDragOver, setIsDragOver] = React.useState(false)
  const templateFieldRef = React.useRef<HTMLDivElement | null>(null)
  const [templateMenuWidth, setTemplateMenuWidth] = React.useState<number>(0)
  const selectedTemplate =
    PROFILE_TEMPLATE_OPTIONS.find((item) => item.value === params.profileTemplate) ||
    PROFILE_TEMPLATE_OPTIONS[0]

  React.useLayoutEffect(() => {
    const node = templateFieldRef.current
    if (!node) return

    const updateWidth = () => {
      const nextWidth = Math.round(node.getBoundingClientRect().width)
      setTemplateMenuWidth((current) => (current === nextWidth ? current : nextWidth))
    }

    updateWidth()

    const observer =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => updateWidth()) : null

    observer?.observe(node)
    window.addEventListener('resize', updateWidth)

    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', updateWidth)
    }
  }, [])

  const applyProfileFile = React.useCallback(
    async (file: File) => {
      onMediaStateChange({ profileRefImage: await toImageAttachment(file) })
    },
    [onMediaStateChange]
  )

  const { getPasteTargetProps } = useImagePasteTarget({
    onPasteImage: async (_targetId, file) => {
      await applyProfileFile(file)
    }
  })

  const handleUpload = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.onchange = async (event: Event) => {
      const file = (event.target as HTMLInputElement).files?.[0]
      if (file) {
        await applyProfileFile(file)
      }
    }
    input.click()
  }

  const handleDragOver = React.useCallback((event: React.DragEvent) => {
    if (!hasDroppedImageData(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = React.useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setIsDragOver(false)
  }, [])

  const handleDrop = React.useCallback(
    async (event: React.DragEvent) => {
      event.preventDefault()
      event.stopPropagation()
      setIsDragOver(false)

      const file = await getDroppedImageFile(event.dataTransfer)
      if (!file) return

      await applyProfileFile(file)
    },
    [applyProfileFile]
  )

  const stopMenuWheelPropagation = React.useCallback((event: React.WheelEvent<HTMLElement>) => {
    event.stopPropagation()
  }, [])

  return (
    <PanelShell
      title="3D 人物生成"
      submitLabel="生成人物模型"
      submitDisabled={!profileImage}
      onSubmit={onGenerate}
    >
      <TipBanner>
        官方接口要求上传真人头像，并在可选的 Template 参数中选择一个官方模板；不传 Template
        时将走接口默认模板。
      </TipBanner>

      <SectionLabel>人物头像</SectionLabel>
      {profileImage ? (
        <Box
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={(event) => void handleDrop(event)}
          {...getPasteTargetProps('profile')}
          sx={{
            position: 'relative',
            width: '100%',
            borderRadius: '10px',
            overflow: 'hidden',
            border: `1px solid ${isDragOver ? hyColors.primaryHover : hyColors.softBorder}`,
            bgcolor: hyColors.card,
            mb: 2,
            outline: 'none'
          }}
        >
          <Box
            component="img"
            src={profileImage.url}
            alt="人物头像"
            sx={{ width: '100%', maxHeight: 220, objectFit: 'contain', display: 'block' }}
          />
          <Box sx={{ position: 'absolute', top: 6, right: 6 }}>
            <IconButton
              size="small"
              onClick={() => onMediaStateChange({ profileRefImage: null })}
              sx={{ bgcolor: 'rgba(0,0,0,0.6)', color: '#ff4d4f', width: 26, height: 26 }}
            >
              <DeleteOutlineIcon sx={{ fontSize: 15 }} />
            </IconButton>
          </Box>
        </Box>
      ) : (
        <Box
          onClick={handleUpload}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={(event) => void handleDrop(event)}
          {...getPasteTargetProps('profile')}
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 1,
            py: 4,
            borderRadius: '10px',
            border: `1.5px dashed ${isDragOver ? hyColors.primaryHover : hyColors.dashedBorder}`,
            bgcolor: isDragOver ? hyColors.softHoverBg : hyColors.softBg,
            cursor: 'pointer',
            mb: 2,
            outline: 'none',
            '&:hover': { borderColor: hyColors.softHoverBorder, bgcolor: hyColors.softHoverBg }
          }}
        >
          <AddPhotoAlternateOutlinedIcon sx={{ fontSize: 20, color: hyColors.mutedIcon }} />
          <Typography sx={{ fontSize: 12, color: hyColors.textSecondary }}>上传头像</Typography>
        </Box>
      )}

      <SectionLabel info="Template 对应腾讯云官方模板枚举。">人物模板</SectionLabel>
      <Box ref={templateFieldRef}>
        <TextField
          select
          fullWidth
          value={params.profileTemplate}
          SelectProps={{
            renderValue: (value) =>
              PROFILE_TEMPLATE_OPTIONS.find((item) => item.value === value)?.label ||
              selectedTemplate.label,
            MenuProps: {
              disableScrollLock: true,
              PaperProps: {
                elevation: 0,
                onWheel: stopMenuWheelPropagation,
                sx: {
                  mt: 0.8,
                  width: templateMenuWidth ? `${templateMenuWidth}px` : undefined,
                  minWidth: templateMenuWidth ? `${templateMenuWidth}px` : undefined,
                  maxWidth: templateMenuWidth
                    ? `${templateMenuWidth}px`
                    : 'min(360px, calc(100vw - 32px))',
                  maxHeight: 332,
                  position: 'relative',
                  bgcolor: TEMPLATE_MENU_BG,
                  backgroundColor: `${TEMPLATE_MENU_BG} !important`,
                  backgroundImage: 'none !important',
                  backdropFilter: 'none !important',
                  opacity: '1 !important',
                  border: `1px solid ${hyColors.softBorder}`,
                  boxShadow: '0 18px 40px rgba(0,0,0,0.48)',
                  overflow: 'hidden',
                  '&::before': {
                    content: '""',
                    position: 'absolute',
                    inset: 0,
                    bgcolor: TEMPLATE_MENU_BG,
                    zIndex: 0
                  }
                }
              },
              MenuListProps: {
                onWheel: stopMenuWheelPropagation,
                sx: {
                  position: 'relative',
                  zIndex: 1,
                  py: 0.45,
                  px: 0.45,
                  maxHeight: 316,
                  overflowY: 'auto',
                  overscrollBehavior: 'contain',
                  bgcolor: 'transparent',
                  backgroundImage: 'none',
                  ...scrollbarSx
                }
              }
            }
          }}
          onChange={(event) =>
            onParamsChange({
              profileTemplate: event.target.value as Hy3dProfileTemplate
            })
          }
          sx={{
            '& .MuiOutlinedInput-root': {
              minHeight: 48,
              alignItems: 'center',
              bgcolor: hyColors.card,
              color: hyColors.textPrimary,
              fontSize: 13,
              borderRadius: '12px',
              '& fieldset': { borderColor: 'transparent' },
              '&:hover': { bgcolor: hyColors.cardHover },
              '&.Mui-focused fieldset': { borderColor: hyColors.primary, borderWidth: '1px' }
            },
            '& .MuiSelect-select': {
              py: 0.8
            }
          }}
        >
          {PROFILE_TEMPLATE_OPTIONS.map((item) => (
            <MenuItem
              key={item.value}
              value={item.value}
              sx={{
                py: 0.7,
                px: 0.9,
                mb: 0.35,
                borderRadius: '12px',
                alignItems: 'flex-start',
                bgcolor: TEMPLATE_MENU_ITEM_BG,
                border: `1px solid rgba(255,255,255,0.04)`,
                '&:hover': {
                  bgcolor: 'rgba(255,255,255,0.08)'
                },
                '&.Mui-selected': {
                  bgcolor: TEMPLATE_MENU_ITEM_SELECTED_BG
                },
                '&.Mui-selected:hover': {
                  bgcolor: 'rgba(126,115,253,0.28)'
                }
              }}
            >
              <Box sx={{ minWidth: 0 }}>
                <Typography
                  sx={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: '#ffffff',
                    lineHeight: 1.3
                  }}
                >
                  {item.label}
                </Typography>
                <Typography
                  sx={{
                    mt: 0.2,
                    fontSize: 10,
                    color: 'rgba(255,255,255,0.72)',
                    lineHeight: 1.35
                  }}
                >
                  {item.value}
                </Typography>
              </Box>
            </MenuItem>
          ))}
        </TextField>
      </Box>
    </PanelShell>
  )
}

export default ProfilePanel
