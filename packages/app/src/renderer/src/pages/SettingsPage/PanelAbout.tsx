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
  ListItemIcon,
  Stack,
  Chip,
  IconButton,
  Tooltip,
  LinearProgress
} from '@mui/material'
import {
  Info as InfoIcon,
  Code as CodeIcon,
  SystemUpdateAlt as UpdateIcon,
  Refresh as RefreshIcon,
  Download as DownloadIcon,
  RestartAlt as RestartIcon
} from '@mui/icons-material'
import SettingSection from './components/SettingSection'
import ExternalLink from '@renderer/components/ExternalLInk'
import { api } from '@renderer/utils/windowUtils'
import {
  PACKAGE_VERSION,
  UPDATE_PROVIDER_CHANNEL,
  UPDATE_PROVIDER_OWNER,
  UPDATE_PROVIDER_REPO
} from '@shared/config/viteEnv'
import type { AppUpdateStatus, AppUpdateSvc, AppUpdateState } from '@shared/api/svcAppUpdate'
import { newAbortHandler } from '@shared/api/apiUtils/abortHandler'
import { useTranslation } from 'react-i18next'

const SOURCE_CODE_URL = 'https://github.com/MagicPotTeam/magicpot-open'
const LICENSE_URL = `${SOURCE_CODE_URL}/blob/master/LICENSE`

type ChipColor = 'default' | 'primary' | 'secondary' | 'error' | 'info' | 'success' | 'warning'

const UPDATE_PROVIDER = {
  type: 'github' as const,
  owner: UPDATE_PROVIDER_OWNER,
  repo: UPDATE_PROVIDER_REPO,
  channel: UPDATE_PROVIDER_CHANNEL
}

const FALLBACK_UPDATE_STATUS: AppUpdateStatus = {
  state: 'unsupported',
  currentVersion: PACKAGE_VERSION,
  provider: UPDATE_PROVIDER,
  supported: false,
  canCheck: false,
  canDownload: false,
  canInstall: false
}

const UPDATE_STATE_COLOR: Record<AppUpdateState, ChipColor> = {
  idle: 'default',
  unsupported: 'default',
  checking: 'info',
  available: 'primary',
  'not-available': 'success',
  downloading: 'info',
  downloaded: 'success',
  installing: 'warning',
  error: 'error'
}

function getUpdateService(): Partial<AppUpdateSvc> | null {
  try {
    return (api() as unknown as { svcAppUpdate?: Partial<AppUpdateSvc> }).svcAppUpdate ?? null
  } catch {
    return null
  }
}

function isBusy(status: AppUpdateStatus): boolean {
  return ['checking', 'downloading', 'installing'].includes(status.state)
}

const PanelAbout: React.FC<PanelProps> = (_props: PanelProps) => {
  const { t } = useTranslation()
  const [updateStatus, setUpdateStatus] = React.useState<AppUpdateStatus>(FALLBACK_UPDATE_STATUS)

  React.useEffect(() => {
    const service = getUpdateService()
    if (typeof service?.getStatus !== 'function') {
      setUpdateStatus(FALLBACK_UPDATE_STATUS)
      return
    }

    let cancelled = false
    const [abortSender, abortReceiver] = newAbortHandler()

    service
      .getStatus({})
      .then((status) => {
        if (!cancelled) {
          setUpdateStatus(status)
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setUpdateStatus({
            ...FALLBACK_UPDATE_STATUS,
            state: 'error',
            supported: true,
            errorMessage: error instanceof Error ? error.message : String(error)
          })
        }
      })

    if (typeof service.watchStatus === 'function') {
      void service
        .watchStatus(
          {},
          {
            abortReceiver,
            onData: (status) => {
              if (!cancelled) {
                setUpdateStatus(status)
              }
            }
          }
        )
        .catch(() => undefined)
    }

    return () => {
      cancelled = true
      abortSender.abort()
    }
  }, [])

  const runUpdateAction = React.useCallback(
    (action: 'checkForUpdates' | 'downloadUpdate' | 'installUpdate') => {
      const service = getUpdateService()
      const method = service?.[action]
      if (typeof method !== 'function') {
        setUpdateStatus(FALLBACK_UPDATE_STATUS)
        return
      }

      void method({})
        .then((status) => setUpdateStatus(status))
        .catch((error: unknown) => {
          setUpdateStatus((current) => ({
            ...current,
            state: 'error',
            errorMessage: error instanceof Error ? error.message : String(error)
          }))
        })
    },
    []
  )

  const stateKey = updateStatus.state.replaceAll('-', '_')
  const progressPercent =
    typeof updateStatus.progress?.percent === 'number'
      ? Math.max(0, Math.min(100, Math.round(updateStatus.progress.percent)))
      : null
  const updateDetail = React.useMemo(() => {
    if (updateStatus.errorMessage) {
      return updateStatus.errorMessage
    }
    if (updateStatus.state === 'available') {
      return t('about.update.detail_available', {
        version: updateStatus.latestVersion || t('about.update.version_unknown')
      })
    }
    if (updateStatus.state === 'downloaded') {
      return t('about.update.detail_downloaded', {
        version: updateStatus.latestVersion || t('about.update.version_unknown')
      })
    }
    if (updateStatus.state === 'downloading' && progressPercent !== null) {
      return t('about.update.detail_downloading', { percent: String(progressPercent) })
    }
    if (updateStatus.state === 'not-available') {
      return t('about.update.detail_not_available')
    }
    if (updateStatus.state === 'unsupported') {
      return t('about.update.detail_unsupported')
    }
    return t('about.update.detail_idle')
  }, [
    progressPercent,
    t,
    updateStatus.errorMessage,
    updateStatus.latestVersion,
    updateStatus.state
  ])

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
                whiteSpace: 'pre-line'
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
          <ListItem
            alignItems="flex-start"
            secondaryAction={
              updateStatus.supported ? (
                <Stack direction="row" spacing={0.5}>
                  <Tooltip title={t('about.update.action_check')}>
                    <span>
                      <IconButton
                        size="small"
                        aria-label={t('about.update.action_check')}
                        disabled={!updateStatus.canCheck || isBusy(updateStatus)}
                        onClick={() => runUpdateAction('checkForUpdates')}
                      >
                        <RefreshIcon fontSize="small" />
                      </IconButton>
                    </span>
                  </Tooltip>
                  <Tooltip title={t('about.update.action_download')}>
                    <span>
                      <IconButton
                        size="small"
                        aria-label={t('about.update.action_download')}
                        disabled={!updateStatus.canDownload || isBusy(updateStatus)}
                        onClick={() => runUpdateAction('downloadUpdate')}
                      >
                        <DownloadIcon fontSize="small" />
                      </IconButton>
                    </span>
                  </Tooltip>
                  <Tooltip title={t('about.update.action_install')}>
                    <span>
                      <IconButton
                        size="small"
                        aria-label={t('about.update.action_install')}
                        disabled={!updateStatus.canInstall || isBusy(updateStatus)}
                        onClick={() => runUpdateAction('installUpdate')}
                      >
                        <RestartIcon fontSize="small" />
                      </IconButton>
                    </span>
                  </Tooltip>
                </Stack>
              ) : null
            }
          >
            <ListItemIcon>
              <UpdateIcon color={updateStatus.supported ? 'primary' : 'disabled'} />
            </ListItemIcon>
            <ListItemText
              secondaryTypographyProps={{ component: 'div' }}
              primary={
                <Stack
                  direction="row"
                  alignItems="center"
                  spacing={1}
                  sx={{ pr: updateStatus.supported ? 12 : 0, flexWrap: 'wrap' }}
                >
                  <Typography variant="body1">{t('about.update.title')}</Typography>
                  <Chip
                    size="small"
                    color={UPDATE_STATE_COLOR[updateStatus.state]}
                    label={t(`about.update.state.${stateKey}`)}
                  />
                </Stack>
              }
              secondary={
                <Box sx={{ pr: updateStatus.supported ? 12 : 0 }}>
                  <Typography variant="body2" color="text.secondary">
                    {updateDetail}
                  </Typography>
                  {updateStatus.state === 'downloading' ? (
                    <LinearProgress
                      variant={progressPercent === null ? 'indeterminate' : 'determinate'}
                      value={progressPercent ?? 0}
                      sx={{ mt: 1, maxWidth: 280 }}
                    />
                  ) : null}
                </Box>
              }
            />
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
