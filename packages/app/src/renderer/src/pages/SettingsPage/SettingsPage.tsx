import React, { Suspense, useCallback, useMemo, useState } from 'react'
import { Box, CircularProgress, IconButton, Tooltip, Typography } from '@mui/material'
import {
  Build as BuildIcon,
  Code,
  Extension as ExtensionIcon,
  Hub as HubIcon,
  Info as InfoIcon,
  Settings as SettingsIcon
} from '@mui/icons-material'
import { useTheme } from '@mui/material/styles'
import { useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Config, DEFAULT_CONFIG } from '@shared/config/config'
import { BUILD_MODE, PACKAGE_VERSION } from '@shared/config/viteEnv'
import type { DeepPartial } from '@shared/utils/utilTypes'
import { lazyWithRetry } from '@renderer/utils/lazyWithRetry'
import { useConfig } from '@renderer/hooks/useConfig'
import PanelAbout from './PanelAbout'
import PanelEnvironment from './PanelEnvironment'
import PanelGeneral from './PanelGeneral'
import PanelLLM from './PanelLLM'
import PanelMcp from './PanelMcp'
import type { PanelProps, SettingsTab } from './PanelProps'

const PanelPlugin = lazyWithRetry(() => import('./PanelPlugin'))

interface SettingsPageProps {
  onClose?: () => void
}

const SettingsPage: React.FC<SettingsPageProps> = ({ onClose }) => {
  const theme = useTheme()
  const isLight = theme.palette.mode === 'light'
  const { t, i18n } = useTranslation()
  const isChineseUi = i18n.language?.toLowerCase().startsWith('zh')
  const location = useLocation()
  const defaultTab = location.state?.tab as SettingsTab | undefined
  const [currentTab, setCurrentTab] = useState<SettingsTab>(defaultTab || 'general')
  const { config, isReady, updateConfig } = useConfig()

  const settingsValue: Config = isReady ? config : DEFAULT_CONFIG
  const isLoading = !isReady
  const saveSettings = useCallback(
    (value: DeepPartial<Config>) => updateConfig(value),
    [updateConfig]
  )

  const localizedText = useCallback(
    (key: string, fallback: string) => {
      const value = t(key)
      return value === key ? fallback : value
    },
    [t]
  )

  const tabText = useCallback(
    (key: string, chineseFallback: string, englishFallback: string) =>
      isChineseUi ? chineseFallback : localizedText(key, englishFallback),
    [isChineseUi, localizedText]
  )

  const settingsPageBackground = isLight ? theme.palette.background.default : '#111111'
  const settingsTextColor = theme.palette.text.primary
  const settingsMutedColor = theme.palette.text.secondary
  const settingsLineColor = isLight ? 'rgba(17, 24, 39, 0.08)' : 'rgba(255, 255, 255, 0.08)'
  const settingsSectionSurface = isLight ? '#eef0f7' : '#1d1d1d'
  const settingsInputSurface = isLight ? '#f7f8fc' : '#252525'
  const settingsInputHoverSurface = isLight ? '#f0f2f9' : '#2b2b2b'
  const settingsMetaColor = isLight ? '#667085' : '#b7c7ff'
  const settingsHoverTextColor = isLight ? theme.palette.text.primary : '#d4d4d8'
  const settingsHoverSurface = isLight ? 'rgba(17, 24, 39, 0.06)' : 'rgba(255, 255, 255, 0.06)'

  const tabs = useMemo<
    {
      label: string
      value: SettingsTab
      icon: React.ReactNode
      Panel: React.ComponentType<PanelProps>
      description: string
    }[]
  >(
    () => [
      {
        label: t('settings.tabs.general'),
        value: 'general',
        icon: <SettingsIcon sx={{ fontSize: 18 }} />,
        Panel: PanelGeneral,
        description: t('settings.tab_descs.general')
      },
      {
        label: t('settings.tabs.environment'),
        value: 'environment',
        icon: <BuildIcon sx={{ fontSize: 18 }} />,
        Panel: PanelEnvironment,
        description: t('settings.tab_descs.environment')
      },
      {
        label: tabText('settings.tabs.plugin', '快应用 API', 'Quick App API'),
        value: 'plugin',
        icon: <ExtensionIcon sx={{ fontSize: 18 }} />,
        Panel: PanelPlugin,
        description: tabText(
          'settings.tab_descs.plugin',
          '快应用 API 配置',
          'Quick App API settings'
        )
      },
      {
        label: tabText('settings.tabs.llm', 'Agent线程配置', 'Agent Threads'),
        value: 'llm',
        icon: <Code sx={{ fontSize: 18 }} />,
        Panel: PanelLLM,
        description: tabText('settings.tab_descs.llm', 'Agent线程配置', 'Agent thread settings')
      },
      {
        label: localizedText('settings.tabs.mcp', 'MCP'),
        value: 'mcp',
        icon: <HubIcon sx={{ fontSize: 18 }} />,
        Panel: PanelMcp,
        description: localizedText(
          'settings.tab_descs.mcp',
          isChineseUi
            ? 'MCP 服务器会通过 Model Context Protocol 为代理提供外部工具。代理会将发现到的工具注册为 mcp.<server>.<tool> 形式的具体工具并直接调用它们。'
            : 'MCP servers expose external tools to the agent via the Model Context Protocol. The agent registers discovered tools as concrete aliases like mcp.<server>.<tool> and calls them directly.'
        )
      },
      {
        label: t('settings.tabs.about'),
        value: 'about',
        icon: <InfoIcon sx={{ fontSize: 18 }} />,
        Panel: PanelAbout,
        description: t('settings.tab_descs.about')
      }
    ],
    [isChineseUi, localizedText, t, tabText]
  )

  const activeTab = tabs.find((tab) => tab.value === currentTab) || tabs[0]
  const Panel = activeTab.Panel

  return (
    <Box
      sx={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        bgcolor: settingsPageBackground,
        color: settingsTextColor
      }}
    >
      <Box sx={{ px: 4, pt: 3, pb: 1.5 }}>
        <Box
          sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 }}
        >
          <Typography sx={{ fontSize: 16, fontWeight: 700, color: '#8b7bff' }}>
            {t('menu.settings')}
          </Typography>

          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <Typography sx={{ fontSize: 12, fontWeight: 500, color: settingsMetaColor }}>
              Magic Pot {BUILD_MODE} {PACKAGE_VERSION}
            </Typography>
            {onClose && (
              <Tooltip title={t('general.close')} arrow>
                <IconButton
                  size="small"
                  onClick={onClose}
                  sx={{
                    color: settingsMutedColor,
                    '&:hover': {
                      bgcolor: settingsHoverSurface,
                      color: settingsTextColor
                    }
                  }}
                >
                  <Box component="span" sx={{ fontSize: 18, lineHeight: 1 }}>
                    x
                  </Box>
                </IconButton>
              </Tooltip>
            )}
          </Box>
        </Box>

        <Box sx={{ mt: 2 }}>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 3,
              overflowX: 'auto',
              pb: 0.75,
              borderBottom: `1px solid ${settingsLineColor}`,
              '&::-webkit-scrollbar': {
                display: 'none'
              }
            }}
          >
            {tabs.map((tab) => {
              const isActive = tab.value === currentTab
              return (
                <Box
                  key={tab.value}
                  onClick={() => setCurrentTab(tab.value)}
                  sx={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 1,
                    pb: 1,
                    borderBottom: isActive ? '2px solid #7d72fc' : '2px solid transparent',
                    color: isActive ? '#7d72fc' : settingsTextColor,
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                    transition: 'color 0.18s ease, border-color 0.18s ease',
                    '&:hover': {
                      color: isActive ? '#7d72fc' : settingsHoverTextColor
                    }
                  }}
                >
                  {tab.icon}
                  <Typography sx={{ fontSize: 14, fontWeight: 700 }}>{tab.label}</Typography>
                </Box>
              )
            })}
          </Box>

          <Typography sx={{ mt: 1.25, fontSize: 12, color: settingsMutedColor }}>
            {activeTab.description}
          </Typography>
        </Box>
      </Box>

      {isLoading ? (
        <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <CircularProgress />
        </Box>
      ) : (
        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            overflow: 'auto',
            px: 2,
            pb: 2,
            '& .MuiOutlinedInput-root': {
              bgcolor: settingsInputSurface,
              borderRadius: 3,
              color: settingsTextColor,
              boxShadow: 'none',
              transition: 'background-color 0.18s ease',
              '& fieldset': {
                border: 'none'
              },
              '&:hover': {
                bgcolor: settingsInputHoverSurface
              },
              '&:hover fieldset': {
                border: 'none'
              },
              '&.Mui-focused': {
                bgcolor: settingsInputHoverSurface
              },
              '&.Mui-focused fieldset': {
                border: 'none'
              },
              '& .MuiInputBase-input': {
                color: settingsTextColor
              },
              '& .MuiInputBase-input::placeholder': {
                color: settingsMutedColor,
                opacity: 0.82
              },
              '& .MuiSvgIcon-root': {
                color: settingsMutedColor
              }
            },
            '& .MuiInputLabel-root': {
              color: settingsMutedColor,
              fontWeight: 500
            },
            '& .MuiInputLabel-root.Mui-focused': {
              color: isLight ? '#6157dc' : '#c9c2ff'
            },
            '& .MuiFormHelperText-root': {
              color: settingsMutedColor,
              marginLeft: 0,
              marginTop: 0.75
            },
            '& .MuiAlert-root': {
              border: 'none',
              borderRadius: 3,
              boxShadow: 'none',
              bgcolor: settingsSectionSurface,
              color: settingsTextColor
            },
            '& .MuiCard-root': {
              border: 'none',
              borderRadius: 3,
              boxShadow: 'none',
              bgcolor: settingsSectionSurface
            },
            '& .MuiAccordion-root': {
              border: 'none',
              boxShadow: 'none',
              bgcolor: settingsSectionSurface,
              borderRadius: 4,
              '&:before': {
                display: 'none'
              }
            },
            '& .MuiChip-root': {
              bgcolor: settingsInputSurface,
              color: settingsTextColor
            }
          }}
        >
          <Suspense
            fallback={
              <Box
                sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                <CircularProgress />
              </Box>
            }
          >
            <Panel
              settingsValue={settingsValue}
              saveSettings={saveSettings}
              onSelectTab={setCurrentTab}
            />
          </Suspense>
        </Box>
      )}
    </Box>
  )
}

export default SettingsPage
