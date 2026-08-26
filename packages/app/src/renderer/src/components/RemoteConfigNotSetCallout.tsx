import { Alert, AlertTitle, Link, Typography } from '@mui/material'
import { useConfig } from '@renderer/hooks/useConfig'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
type RemoteConfigNotSetCalloutProps = {
  needNavigate?: boolean
}

const RemoteConfigNotSetCallout: React.FC<RemoteConfigNotSetCalloutProps> = ({
  needNavigate = true
}: RemoteConfigNotSetCalloutProps) => {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { configUtils } = useConfig()
  const originAvailable = configUtils.isComfyUIAPIAvailable()

  if (originAvailable) {
    return null
  }

  return (
    <Alert severity="warning">
      <AlertTitle>{t('environment.comfyui_not_configured_title')}</AlertTitle>
      <Typography>{t('environment.err_comfyui_origin_required')}</Typography>
      {needNavigate && (
        <Typography>
          {t('environment.go_to_settings')}{' '}
          <Link onClick={() => navigate('/settings', { state: { tab: 'environment' } })}>
            {t('environment.go_to_settings_link')}
          </Link>
        </Typography>
      )}
    </Alert>
  )
}

export default RemoteConfigNotSetCallout
