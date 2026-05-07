// packages/app/src/renderer/src/pages/SettingsPage/PanelAbout.tsx

import React from 'react'
import { PanelProps } from './PanelProps'
import {
  Box,
  Typography,
  Divider,
  Card,
  CardContent,
  List,
  ListItem,
  ListItemText,
  ListItemIcon
} from '@mui/material'
import { Info as InfoIcon, Code as CodeIcon } from '@mui/icons-material'
import SettingSection from './components/SettingSection'
import ExternalLink from '@renderer/components/ExternalLInk'
import { PACKAGE_VERSION } from '@shared/config/viteEnv'
import { useTranslation } from 'react-i18next'

const SOURCE_CODE_URL = 'https://github.com/MagicPotTeam/magicpot-open'
const LICENSE_URL = `${SOURCE_CODE_URL}/blob/master/LICENSE`

const PanelAbout: React.FC<PanelProps> = ({ settingsValue, saveSettings }: PanelProps) => {
  const { t } = useTranslation()

  return (
    <Box sx={{ p: 2 }}>
      <SettingSection title="">
        <Card sx={{ mb: 3 }}>
          <CardContent>
            <Typography variant="h6" sx={{ mb: 2, color: 'primary.main' }}>
              {t('about.title_app')}
            </Typography>
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{
                mb: 2,
                whiteSpace: 'pre-line' // 或者 'pre-wrap'
              }}
            >
              {t('about.description_app')}
            </Typography>
          </CardContent>
        </Card>

        <List>
          <ListItem>
            <ListItemIcon>
              <InfoIcon color="primary" />
            </ListItemIcon>
            <ListItemText primary={t('about.version_label')} secondary={PACKAGE_VERSION} />
          </ListItem>
          <Divider />
          <ListItem>
            <ListItemIcon>
              <CodeIcon color="primary" />
            </ListItemIcon>
            <ListItemText
              primary={t('about.developer_label')}
              secondary={t('about.developer_name')}
            />
          </ListItem>
          <Divider />
          <ListItem>
            <ListItemIcon>
              <InfoIcon color="primary" />
            </ListItemIcon>
            <ListItemText primary={t('about.license_label')} secondary={t('about.license_name')} />
          </ListItem>
          <Divider />
          <ListItem>
            <ListItemIcon>
              <CodeIcon color="primary" />
            </ListItemIcon>
            <ListItemText
              primary={t('about.source_code_label')}
              secondary={<ExternalLink href={SOURCE_CODE_URL}>{SOURCE_CODE_URL}</ExternalLink>}
            />
          </ListItem>
          <Divider />
          <ListItem>
            <ListItemIcon>
              <InfoIcon color="primary" />
            </ListItemIcon>
            <ListItemText
              primary={t('about.license_text_label')}
              secondary={
                <ExternalLink href={LICENSE_URL}>{t('about.license_text_action')}</ExternalLink>
              }
            />
          </ListItem>
          <Divider />
          <ListItem>
            <ListItemIcon>
              <InfoIcon color="primary" />
            </ListItemIcon>
            <ListItemText
              primary={t('about.warranty_label')}
              secondary={t('about.warranty_text')}
            />
          </ListItem>
        </List>
      </SettingSection>
    </Box>
  )
}

export default PanelAbout
