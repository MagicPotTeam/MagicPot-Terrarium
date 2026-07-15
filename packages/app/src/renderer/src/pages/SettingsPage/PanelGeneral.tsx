import React, { useState } from 'react'
import { Box, Stack, Checkbox, FormControlLabel } from '@mui/material'
import { Language as LanguageIcon, Palette as PaletteIcon } from '@mui/icons-material'
import { useColorScheme, useTheme } from '@mui/material/styles'
import { useTranslation } from 'react-i18next'
import InputSelect from '../../components/inputs/InputSelect'
import { PanelProps } from './PanelProps'
import { useMessage } from '@renderer/hooks/useMessage'

const PanelGeneral: React.FC<PanelProps> = ({ settingsValue: _ }: PanelProps) => {
  const { notifyInfo } = useMessage()
  const { mode, setMode } = useColorScheme()
  const theme = useTheme()
  const isLight = theme.palette.mode === 'light'
  const panelTextColor = isLight ? '#1f2542' : 'text.primary'
  const panelMutedColor = isLight ? '#656d8b' : 'text.secondary'
  const panelCardSurface = isLight ? '#eef0f7' : '#1d1d1d'
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
