import { Alert, AlertTitle, Link, Typography } from '@mui/material'
import { useConfig } from '@renderer/hooks/useConfig'
import { useNavigate } from 'react-router-dom'
type RemoteConfigNotSetCalloutProps = {
  needNavigate?: boolean
}

const RemoteConfigNotSetCallout: React.FC<RemoteConfigNotSetCalloutProps> = ({
  needNavigate = true
}: RemoteConfigNotSetCalloutProps) => {
  const navigate = useNavigate()
  const { config, configUtils } = useConfig()
  const originAvailable = configUtils.isComfyUIAPIAvailable()

  if (!config.use_remote_comfyui) {
    return null
  }

  if (originAvailable) {
    return null
  }

  return (
    <Alert severity="warning">
      <AlertTitle>配置未完成</AlertTitle>
      <Typography>你正在使用远程 ComfyUI，但未设置 ComfyUI 的地址，无法正常使用。</Typography>
      {needNavigate && (
        <Typography>
          请在“设置”中设置。{' '}
          {
            <Link onClick={() => navigate('/settings', { state: { tab: 'environment' } })}>
              前往设置
            </Link>
          }
        </Typography>
      )}
    </Alert>
  )
}

export default RemoteConfigNotSetCallout
