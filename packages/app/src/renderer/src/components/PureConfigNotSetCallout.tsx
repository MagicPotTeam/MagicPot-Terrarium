import { Alert, AlertTitle, Link, Typography } from '@mui/material'
import { useConfig } from '@renderer/hooks/useConfig'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

type PureConfigNotSetCalloutProps = {
  needNavigate?: boolean
}

const PureConfigNotSetCallout: React.FC<PureConfigNotSetCalloutProps> = ({
  needNavigate = true
}: PureConfigNotSetCalloutProps) => {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { configUtils } = useConfig()
  const comfyuiApiAvailable = configUtils.isComfyUIAPIAvailable()

  if (comfyuiApiAvailable) {
    return null
  }

  const notSetItem = t('environment.err_comfyui_origin_required')

  return (
    <Alert severity="warning">
      <AlertTitle>配置未完成</AlertTitle>
      <Typography>{notSetItem}</Typography>
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

export default PureConfigNotSetCallout
