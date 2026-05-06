import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Box,
  Button,
  Divider,
  FormControl,
  InputLabel,
  ListItemIcon,
  ListItemText,
  MenuItem,
  Popover,
  Select,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import type { SelectChangeEvent } from '@mui/material/Select'
import CheckIcon from '@mui/icons-material/Check'
import CloseIcon from '@mui/icons-material/Close'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import ImageOutlinedIcon from '@mui/icons-material/ImageOutlined'
import { useTranslation } from 'react-i18next'
import { normalizeOpenAIImageGenerationSize } from '@shared/llm'
import type {
  OpenAIImageGenerationAction,
  OpenAIImageGenerationBackground,
  OpenAIImageGenerationOptions,
  OpenAIImageGenerationOutputFormat,
  OpenAIImageGenerationQuality
} from '@shared/llm'
import { DEFAULT_CHAT_IMAGE_GENERATION_OPTIONS } from './ChatImageGenerationSettings.constants'

type ChatImageGenerationSettingsProps = {
  value: OpenAIImageGenerationOptions
  onChange: (next: OpenAIImageGenerationOptions) => void
  onCloseParentMenu?: () => void
  referenceImageSize?: {
    width: number
    height: number
  }
  active?: boolean
  variant?: 'activeChip' | 'button' | 'menuItem'
}

type Choice<T extends string> = {
  value: T
  label: string
}

type SizeDraft = {
  width: string
  height: string
}

const SIZE_VALUE_PATTERN = /^([1-9]\d{0,4})x([1-9]\d{0,4})$/i
const SIZE_DIMENSION_STEP = 16
const MAX_SIZE_DRAFT_DIMENSION = 3840

const getSizeLabel = (
  size?: string,
  referenceImageSize?: ChatImageGenerationSettingsProps['referenceImageSize'],
  autoLabel = 'Auto'
): string => {
  const normalized =
    normalizeOpenAIImageGenerationSize(size) ||
    String(size || '')
      .trim()
      .toLowerCase()
  if (normalized && normalized !== 'auto') {
    if (normalized === '3840x2160') return '4K'
    if (normalized === '2160x3840') return '4K'
    return normalized
  }

  if (referenceImageSize) {
    return (
      normalizeOpenAIImageGenerationSize(
        `${referenceImageSize.width}x${referenceImageSize.height}`
      ) || `${referenceImageSize.width}x${referenceImageSize.height}`
    )
  }

  if (!normalized || normalized === 'auto') return autoLabel
  if (normalized === '3840x2160') return '4K'
  if (normalized === '2160x3840') return '4K'
  return normalized
}

const parseSizeValue = (size?: string): SizeDraft => {
  const normalized = String(size || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
  const match = normalized.match(SIZE_VALUE_PATTERN)
  return match ? { width: match[1], height: match[2] } : { width: '', height: '' }
}

const normalizeDimensionInput = (value: string): string =>
  value.replace(/\D/g, '').slice(0, 8).replace(/^0+/, '')

const clampDimensionInput = (value: string): string => {
  const normalized = normalizeDimensionInput(value)
  if (!normalized) return ''
  return String(Math.min(MAX_SIZE_DRAFT_DIMENSION, Number(normalized)))
}

const resolveWidthInput = (
  value: string
): {
  heightRemainder: string
  shouldFocusHeight: boolean
  width: string
} => {
  const normalized = normalizeDimensionInput(value)
  if (!normalized) {
    return { width: '', heightRemainder: '', shouldFocusHeight: false }
  }

  const maxWidthText = String(MAX_SIZE_DRAFT_DIMENSION)
  const widthText =
    normalized.length > maxWidthText.length ? normalized.slice(0, maxWidthText.length) : normalized
  const width = clampDimensionInput(widthText)
  const heightRemainder =
    normalized.length > maxWidthText.length
      ? clampDimensionInput(normalized.slice(maxWidthText.length))
      : ''

  return {
    width,
    heightRemainder,
    shouldFocusHeight:
      normalized.length > maxWidthText.length || Number(normalized) >= MAX_SIZE_DRAFT_DIMENSION
  }
}

const buildSizeValue = (draft: SizeDraft): string =>
  draft.width && draft.height ? `${draft.width}x${draft.height}` : 'auto'

const referenceSizeToDraft = (
  referenceImageSize?: ChatImageGenerationSettingsProps['referenceImageSize']
): SizeDraft | undefined =>
  referenceImageSize
    ? parseSizeValue(
        normalizeOpenAIImageGenerationSize(
          `${referenceImageSize.width}x${referenceImageSize.height}`
        )
      )
    : undefined

const ChatImageGenerationSettings: React.FC<ChatImageGenerationSettingsProps> = ({
  value,
  onChange,
  onCloseParentMenu,
  referenceImageSize,
  active = true,
  variant = 'button'
}) => {
  const { i18n } = useTranslation()
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  const [anchorPosition, setAnchorPosition] = useState<{ left: number; top: number } | null>(null)
  const heightInputRef = useRef<HTMLInputElement | null>(null)
  const isSettingsOpen = Boolean(anchorEl || anchorPosition)

  useEffect(() => {
    if (active) return
    setAnchorEl(null)
    setAnchorPosition(null)
  }, [active])

  const isChineseUi =
    i18n.language?.toLowerCase().startsWith('zh') ||
    i18n.resolvedLanguage?.toLowerCase().startsWith('zh')
  const copy = (zh: string, en: string) => (isChineseUi ? zh : en)
  const autoLabel = copy('自动', 'Auto')
  const settings = useMemo(() => ({ ...DEFAULT_CHAT_IMAGE_GENERATION_OPTIONS, ...value }), [value])
  const parsedSizeDraft = useMemo(() => parseSizeValue(settings.size), [settings.size])
  const [sizeDraft, setSizeDraft] = useState<SizeDraft>(() =>
    parseSizeValue(value.size || DEFAULT_CHAT_IMAGE_GENERATION_OPTIONS.size)
  )
  const referenceSizeDraft = referenceSizeToDraft(referenceImageSize)
  const hasExplicitSizeDraft = Boolean(parsedSizeDraft.width && parsedSizeDraft.height)
  const displayedSizeDraft = hasExplicitSizeDraft ? sizeDraft : referenceSizeDraft || sizeDraft
  const buttonLabel = getSizeLabel(settings.size, referenceImageSize, autoLabel)
  const isAutoSize = buttonLabel === autoLabel
  const isEnabled =
    settings.enabled === true || settings.action === 'generate' || settings.action === 'edit'
  const displayedButtonLabel = isEnabled && !isAutoSize ? buttonLabel : copy('图像', 'Image')
  const menuItemSecondaryLabel = isEnabled
    ? !isAutoSize
      ? buttonLabel
      : autoLabel
    : copy('关闭', 'Off')
  useEffect(() => {
    if (!isSettingsOpen) {
      setSizeDraft(parsedSizeDraft)
    }
  }, [isSettingsOpen, parsedSizeDraft])

  const qualityOptions: Array<Choice<OpenAIImageGenerationQuality>> = [
    { value: 'auto', label: autoLabel },
    { value: 'low', label: copy('低', 'Low') },
    { value: 'medium', label: copy('中', 'Medium') },
    { value: 'high', label: copy('高', 'High') }
  ]
  const backgroundOptions: Array<Choice<OpenAIImageGenerationBackground>> = [
    { value: 'auto', label: autoLabel },
    { value: 'opaque', label: copy('不透明', 'Opaque') },
    { value: 'transparent', label: copy('透明', 'Transparent') }
  ]
  const formatOptions: Array<Choice<OpenAIImageGenerationOutputFormat>> = [
    { value: 'png', label: 'PNG' },
    { value: 'webp', label: 'WebP' },
    { value: 'jpeg', label: 'JPEG' }
  ]
  const actionOptions: Array<Choice<OpenAIImageGenerationAction>> = [
    { value: 'auto', label: autoLabel },
    { value: 'generate', label: copy('生成', 'Generate') },
    { value: 'edit', label: copy('编辑', 'Edit') }
  ]

  const updateSettings = (next: OpenAIImageGenerationOptions) => {
    onChange(next)
  }

  const closeSettings = () => {
    setAnchorEl(null)
    setAnchorPosition(null)
  }

  const openSettings = (event: React.MouseEvent<HTMLElement>) => {
    if (variant === 'menuItem') {
      if (!isEnabled) {
        updateSettings({
          ...settings,
          enabled: true
        })
      }
      const rect = event.currentTarget.getBoundingClientRect()
      setAnchorPosition({
        left: Math.round(rect.right + 8),
        top: Math.round(rect.top)
      })
      window.setTimeout(() => onCloseParentMenu?.(), 0)
      return
    }

    setAnchorEl(event.currentTarget)
  }

  const handleDisable = (event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const next: OpenAIImageGenerationOptions = {
      ...settings,
      enabled: false
    }
    delete next.action
    closeSettings()
    updateSettings(next)
  }

  const handleSelect =
    <K extends keyof OpenAIImageGenerationOptions>(key: K) =>
    (event: SelectChangeEvent<string>) => {
      const nextValue = event.target.value
      const next = {
        ...settings,
        [key]: nextValue
      } as OpenAIImageGenerationOptions
      if (key === 'action' && nextValue === 'auto') {
        delete next.action
      } else if (key === 'action') {
        next.enabled = true
      }
      updateSettings(next)
    }

  const handleSizeDimensionChange =
    (key: keyof SizeDraft) =>
    (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      let nextDraft: SizeDraft
      let shouldFocusHeight = false
      if (key === 'width') {
        const nextWidth = resolveWidthInput(event.target.value)
        nextDraft = {
          ...displayedSizeDraft,
          width: nextWidth.width,
          height: nextWidth.heightRemainder || displayedSizeDraft.height
        }
        shouldFocusHeight = nextWidth.shouldFocusHeight
      } else {
        nextDraft = {
          ...displayedSizeDraft,
          height: clampDimensionInput(event.target.value)
        }
      }

      setSizeDraft(nextDraft)
      updateSettings({
        ...settings,
        size: buildSizeValue(nextDraft)
      })
      if (shouldFocusHeight) {
        window.setTimeout(() => heightInputRef.current?.focus(), 0)
      }
    }

  return (
    <>
      {variant === 'menuItem' ? (
        <MenuItem
          data-testid="chat-image-generation-settings-menu-item"
          onClick={openSettings}
          sx={{ minWidth: 220 }}
        >
          <ListItemIcon>
            <ImageOutlinedIcon fontSize="small" color={isEnabled ? 'primary' : 'inherit'} />
          </ListItemIcon>
          <ListItemText
            primary={copy('图像生成', 'Image generation')}
            secondary={menuItemSecondaryLabel}
            primaryTypographyProps={{ fontSize: 13, fontWeight: 600 }}
            secondaryTypographyProps={{ fontSize: 11 }}
          />
          {isEnabled ? <CheckIcon color="primary" sx={{ fontSize: 17, ml: 1 }} /> : null}
        </MenuItem>
      ) : variant === 'activeChip' ? (
        <Box
          data-testid="chat-image-generation-active-chip"
          sx={(theme) => ({
            display: 'inline-flex',
            alignItems: 'center',
            height: 28,
            borderRadius: 1,
            overflow: 'hidden',
            bgcolor:
              theme.palette.mode === 'dark' ? 'rgba(59,130,246,0.14)' : 'rgba(59,130,246,0.08)',
            color: 'primary.main',
            border: '1px solid',
            borderColor:
              theme.palette.mode === 'dark' ? 'rgba(96,165,250,0.2)' : 'rgba(37,99,235,0.16)'
          })}
        >
          <Tooltip title={copy('取消图像生成', 'Disable image generation')}>
            <Button
              data-testid="chat-image-generation-disable-button"
              size="small"
              onClick={handleDisable}
              sx={{
                minWidth: 0,
                width: 24,
                height: 28,
                p: 0,
                borderRadius: 0,
                color: 'text.secondary',
                '&:hover': {
                  bgcolor: 'action.hover',
                  color: 'text.primary'
                }
              }}
            >
              <CloseIcon sx={{ fontSize: 15 }} />
            </Button>
          </Tooltip>
          <Button
            size="small"
            onClick={openSettings}
            sx={{
              minWidth: 0,
              height: 28,
              px: 0.5,
              py: 0,
              borderRadius: 0,
              color: 'primary.main',
              textTransform: 'none',
              '&:hover': {
                bgcolor: 'action.hover'
              }
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.35, minWidth: 0 }}>
              <ImageOutlinedIcon sx={{ fontSize: 15, opacity: 0.9, flex: '0 0 auto' }} />
              <Typography
                sx={{
                  fontSize: 12,
                  fontWeight: 700,
                  lineHeight: 1,
                  maxWidth: 54,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
              >
                {copy('图像', 'Image')}
              </Typography>
              <ExpandMoreIcon sx={{ fontSize: 15, opacity: 0.7, flex: '0 0 auto' }} />
            </Box>
          </Button>
        </Box>
      ) : (
        <Tooltip
          title={
            isEnabled
              ? copy('图像生成已启用', 'Image generation enabled')
              : copy('图像生成参数', 'Image generation settings')
          }
        >
          <Button
            data-testid="chat-image-generation-settings-button"
            size="small"
            onClick={openSettings}
            sx={{
              minWidth: 0,
              height: 28,
              px: 0.5,
              py: 0.25,
              borderRadius: 1,
              color: isEnabled ? 'primary.main' : 'text.secondary',
              bgcolor: isEnabled ? 'action.selected' : 'transparent',
              textTransform: 'none',
              '&:hover': {
                bgcolor: 'action.hover',
                color: 'text.primary'
              }
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.35, minWidth: 0 }}>
              <ImageOutlinedIcon sx={{ fontSize: 15, opacity: 0.85, flex: '0 0 auto' }} />
              <Typography
                sx={{
                  fontSize: 12,
                  fontWeight: 700,
                  lineHeight: 1,
                  maxWidth: 48,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
              >
                {displayedButtonLabel}
              </Typography>
              <ExpandMoreIcon sx={{ fontSize: 15, opacity: 0.7, flex: '0 0 auto' }} />
            </Box>
          </Button>
        </Tooltip>
      )}

      <Popover
        anchorEl={anchorEl}
        anchorPosition={anchorPosition || undefined}
        anchorReference={anchorPosition ? 'anchorPosition' : 'anchorEl'}
        open={active && isSettingsOpen}
        onClose={closeSettings}
        transformOrigin={{ horizontal: 'left', vertical: 'bottom' }}
        anchorOrigin={{ horizontal: 'left', vertical: 'top' }}
        slotProps={{
          paper: {
            sx: (theme) => ({
              mb: 1,
              width: 280,
              borderRadius: 2,
              border: '1px solid',
              borderColor:
                theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
              bgcolor: theme.palette.mode === 'dark' ? '#252628' : '#ffffff',
              boxShadow:
                theme.palette.mode === 'dark'
                  ? '0 8px 32px rgba(0,0,0,0.4)'
                  : '0 8px 32px rgba(0,0,0,0.08)'
            })
          }
        }}
      >
        <Box sx={{ px: 1.5, py: 1.25 }}>
          <Box sx={{ display: 'grid', gridTemplateColumns: '1fr', gap: 1.25 }}>
            <Box>
              <Typography sx={{ mb: 0.5, fontSize: 12, color: 'text.secondary', fontWeight: 700 }}>
                {copy('尺寸', 'Size')}
              </Typography>
              <Typography sx={{ mb: 0.75, fontSize: 11, color: 'text.secondary' }}>
                {copy(
                  `宽度和高度需为 ${SIZE_DIMENSION_STEP} 的倍数`,
                  `W/H must be multiples of ${SIZE_DIMENSION_STEP}`
                )}
              </Typography>
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: '1fr auto 1fr',
                  alignItems: 'center',
                  gap: 0.75
                }}
              >
                <TextField
                  size="small"
                  label={copy('宽', 'W')}
                  value={displayedSizeDraft.width}
                  onChange={handleSizeDimensionChange('width')}
                  placeholder={autoLabel}
                  inputProps={{
                    inputMode: 'numeric',
                    pattern: '[0-9]*'
                  }}
                  fullWidth
                />
                <Typography sx={{ fontSize: 13, color: 'text.secondary', fontWeight: 700 }}>
                  x
                </Typography>
                <TextField
                  size="small"
                  label={copy('高', 'H')}
                  inputRef={heightInputRef}
                  value={displayedSizeDraft.height}
                  onChange={handleSizeDimensionChange('height')}
                  placeholder={autoLabel}
                  inputProps={{
                    inputMode: 'numeric',
                    pattern: '[0-9]*'
                  }}
                  fullWidth
                />
              </Box>
            </Box>

            <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1 }}>
              <FormControl size="small" fullWidth>
                <InputLabel>{copy('质量', 'Quality')}</InputLabel>
                <Select
                  label={copy('质量', 'Quality')}
                  value={settings.quality || 'auto'}
                  onChange={handleSelect('quality')}
                >
                  {qualityOptions.map((option) => (
                    <MenuItem key={option.value} value={option.value}>
                      {option.label}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>

              <FormControl size="small" fullWidth>
                <InputLabel>{copy('格式', 'Format')}</InputLabel>
                <Select
                  label={copy('格式', 'Format')}
                  value={settings.outputFormat || 'png'}
                  onChange={handleSelect('outputFormat')}
                >
                  {formatOptions.map((option) => (
                    <MenuItem key={option.value} value={option.value}>
                      {option.label}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Box>

            <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1 }}>
              <FormControl size="small" fullWidth>
                <InputLabel>{copy('背景', 'Background')}</InputLabel>
                <Select
                  label={copy('背景', 'Background')}
                  value={settings.background || 'auto'}
                  onChange={handleSelect('background')}
                >
                  {backgroundOptions.map((option) => (
                    <MenuItem key={option.value} value={option.value}>
                      {option.label}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>

              <FormControl size="small" fullWidth>
                <InputLabel>{copy('动作', 'Action')}</InputLabel>
                <Select
                  label={copy('动作', 'Action')}
                  value={settings.action || 'auto'}
                  onChange={handleSelect('action')}
                >
                  {actionOptions.map((option) => (
                    <MenuItem key={option.value} value={option.value}>
                      {option.label}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Box>
          </Box>
        </Box>
      </Popover>
    </>
  )
}

export default ChatImageGenerationSettings
