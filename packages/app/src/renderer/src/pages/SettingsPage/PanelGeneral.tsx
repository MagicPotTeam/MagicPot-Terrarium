import React, { useState } from 'react'
import {
  Box,
  Stack,
  TextField,
  IconButton,
  InputAdornment,
  Typography,
  Checkbox,
  FormControlLabel
} from '@mui/material'
import {
  Language as LanguageIcon,
  Palette as PaletteIcon,
  FolderOpen as FolderOpenIcon
} from '@mui/icons-material'
import { useColorScheme, useTheme } from '@mui/material/styles'
import { useTranslation } from 'react-i18next'
import InputSelect from '../../components/inputs/InputSelect'
import { PanelProps } from './PanelProps'
import { useMessage } from '@renderer/hooks/useMessage'
import { useConfig } from '@renderer/hooks/useConfig'
import { api } from '@renderer/utils/windowUtils'

const PanelGeneral: React.FC<PanelProps> = ({ settingsValue: _ }: PanelProps) => {
  const { notifyInfo } = useMessage()
  const { mode, setMode } = useColorScheme()
  const theme = useTheme()
  const isLight = theme.palette.mode === 'light'
  const panelTextColor = isLight ? '#1f2542' : 'text.primary'
  const panelMutedColor = isLight ? '#656d8b' : 'text.secondary'
  const panelCardSurface = isLight ? '#eef0f7' : '#1d1d1d'
  const { config, updateConfig } = useConfig()
  const { t, i18n } = useTranslation()

  const [value, setValue] = useState<{ language: 'zh-CN' | 'en-US' }>({
    language: i18n.language as 'zh-CN' | 'en-US'
  })

  const [confirmDelete, setConfirmDelete] = useState(
    () => localStorage.getItem('confirmDeleteProject') !== 'false'
  )

  const generalCardSx = {
    px: 2.5,
    py: 2.25,
    borderRadius: 3,
    bgcolor: panelCardSurface
  } as const

  const applyLanguage = (lang: 'zh-CN' | 'en-US') => {
    setValue({ language: lang })
    i18n.changeLanguage(lang === 'zh-CN' ? 'zh-CN' : 'en-US')
  }

  const handlePickDownloadDir = async () => {
    const result = await api().svcDialog.showOpenDialog({
      title: t('general.download_dir_title'),
      properties: ['openDirectory'],
      defaultPath: config.download_dir || undefined
    })
    if (result.canceled || !result.filePaths?.length) return

    const dir = result.filePaths[0]
    updateConfig({ download_dir: dir })
    localStorage.setItem('qapp.downloadDir', dir)
  }

  return (
    <Box
      sx={{
        p: 3,
        color: panelTextColor,
        '& .MuiFormControlLabel-label': {
          color: panelTextColor,
          fontWeight: 500
        }
      }}
    >
      <Stack spacing={3}>
        <Box sx={generalCardSx}>
          <Stack spacing={2.5}>
            <InputSelect
              value={value.language}
              label={t('general.language')}
              Icon={LanguageIcon}
              onChange={(nextValue) => {
                applyLanguage(nextValue as 'zh-CN' | 'en-US')
              }}
              items={[
                { label: t('general.language_zh'), value: 'zh-CN' },
                { label: t('general.language_en'), value: 'en-US' }
              ]}
            />

            <InputSelect
              value={mode || 'system'}
              label={t('general.theme')}
              Icon={PaletteIcon}
              onChange={(nextValue) => {
                setMode(nextValue as 'light' | 'dark' | 'system')
                if (nextValue === 'light') {
                  notifyInfo(t('general.toast_theme_light'))
                } else if (nextValue === 'dark') {
                  notifyInfo(t('general.toast_theme_dark'))
                } else {
                  notifyInfo(t('general.toast_theme_system'))
                }
              }}
              items={[
                { label: t('general.theme_system'), value: 'system' },
                { label: t('general.theme_light'), value: 'light' },
                { label: t('general.theme_dark'), value: 'dark' }
              ]}
            />
          </Stack>
        </Box>

        <Box sx={generalCardSx}>
          <Typography variant="body2" sx={{ mb: 0.75, fontWeight: 700, color: panelTextColor }}>
            {t('general.download_dir')}
          </Typography>
          <TextField
            fullWidth
            size="small"
            value={config.download_dir || ''}
            placeholder={t('general.download_dir_placeholder')}
            onChange={(event) => {
              const dir = event.target.value
              updateConfig({ download_dir: dir })
              localStorage.setItem('qapp.downloadDir', dir)
            }}
            InputProps={{
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton
                    size="small"
                    onClick={handlePickDownloadDir}
                    sx={{ color: panelMutedColor }}
                  >
                    <FolderOpenIcon sx={{ fontSize: 18 }} />
                  </IconButton>
                </InputAdornment>
              )
            }}
          />
          <Typography
            variant="caption"
            sx={{ color: panelMutedColor, mt: 0.9, display: 'block', lineHeight: 1.55 }}
          >
            {t('general.download_dir_desc')}
          </Typography>
        </Box>

        <Box sx={generalCardSx}>
          <FormControlLabel
            sx={{ m: 0 }}
            control={
              <Checkbox
                checked={confirmDelete}
                onChange={(event) => {
                  const checked = event.target.checked
                  setConfirmDelete(checked)
                  localStorage.setItem('confirmDeleteProject', checked ? 'true' : 'false')
                }}
                size="small"
              />
            }
            label={t('general.confirm_delete_project')}
          />
        </Box>
      </Stack>
    </Box>
  )
}

export default PanelGeneral
