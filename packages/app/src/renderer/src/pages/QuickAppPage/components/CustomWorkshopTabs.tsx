import React from 'react'
import { Box, Tab, Tabs, Button, IconButton, Tooltip } from '@mui/material'
import { Settings as SettingsIcon, Add as AddIcon } from '@mui/icons-material'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'

const CUSTOM_APP_PATH = '/qappdesign'
const CUSTOM_SKILL_PATH = '/custom-skill-manager'
const TARGET_MANAGER_PATH = '/target-manager'

const resolveWorkshopTabValue = (pathname: string): string => {
  if (pathname === CUSTOM_SKILL_PATH) return CUSTOM_SKILL_PATH
  if (pathname === TARGET_MANAGER_PATH) return TARGET_MANAGER_PATH
  return CUSTOM_APP_PATH
}

type CustomWorkshopTabsProps = {
  onCreateClick?: () => void
  onManageClick?: () => void
  showCreate?: boolean
  showManage?: boolean
}

const CustomWorkshopTabs: React.FC<CustomWorkshopTabsProps> = ({
  onCreateClick,
  onManageClick,
  showCreate = false,
  showManage = false
}) => {
  const navigate = useNavigate()
  const location = useLocation()
  const { t } = useTranslation()
  const value = resolveWorkshopTabValue(location.pathname)

  return (
    <Box
      data-testid="custom-workshop-tabs"
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        px: { xs: 2, sm: 3 },
        pt: 1.5,
        pb: 0.5,
        borderBottom: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.paper',
        minHeight: 48
      }}
    >
      <Tabs
        value={value}
        onChange={(_, nextValue: string) => navigate(nextValue)}
        variant="standard"
        sx={{
          minHeight: 40,
          '& .MuiTabs-indicator': {
            height: 2,
            borderRadius: 1
          },
          '& .MuiTabs-flexContainer': {
            gap: 0.5
          },
          '& .MuiTab-root': {
            minHeight: 40,
            minWidth: 0,
            px: 1.5,
            py: 0.5,
            textTransform: 'none',
            fontWeight: 600,
            fontSize: 14,
            letterSpacing: 0
          }
        }}
      >
        <Tab
          value={CUSTOM_APP_PATH}
          label={t('menu.custom_app', { defaultValue: '自定义快应用' })}
        />
        <Tab
          value={CUSTOM_SKILL_PATH}
          label={t('custom_workshop.custom_skill', { defaultValue: '自定义技能' })}
        />
        <Tab
          value={TARGET_MANAGER_PATH}
          label={t('custom_workshop.target', { defaultValue: '自定义目标' })}
        />
      </Tabs>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        {showManage && onManageClick && (
          <Tooltip title={t('custom_workshop.manage', { defaultValue: '管理' })}>
            <IconButton size="small" onClick={onManageClick} sx={{ color: 'text.secondary' }}>
              <SettingsIcon sx={{ fontSize: 20 }} />
            </IconButton>
          </Tooltip>
        )}
        {showCreate && onCreateClick && (
          <Button
            variant="outlined"
            size="small"
            startIcon={<AddIcon />}
            onClick={onCreateClick}
            sx={{
              textTransform: 'none',
              fontWeight: 600,
              fontSize: 13,
              borderRadius: 2,
              px: 1.5,
              py: 0.5,
              borderColor: 'divider',
              color: 'text.primary',
              '&:hover': {
                borderColor: 'text.secondary',
                bgcolor: 'action.hover'
              }
            }}
          >
            {t('custom_workshop.create', { defaultValue: '创建' })}
          </Button>
        )}
      </Box>
    </Box>
  )
}

export default CustomWorkshopTabs
