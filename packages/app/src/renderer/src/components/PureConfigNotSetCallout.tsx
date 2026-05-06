import { Alert, AlertTitle, Link, Typography } from '@mui/material'
import { useConfig } from '@renderer/hooks/useConfig'
import { BUILD_MODE_NAME } from '@shared/config/viteEnv'
import { useNavigate } from 'react-router-dom'

type PureConfigNotSetCalloutProps = {
  needNavigate?: boolean
}

const PureConfigNotSetCallout: React.FC<PureConfigNotSetCalloutProps> = ({
  needNavigate = true
}: PureConfigNotSetCalloutProps) => {
  const navigate = useNavigate()
  const { config, configUtils } = useConfig()
  const comfyuiDirAvailable = configUtils.isComfyUIDirAvailable()
  const pythonCmdAvailable = configUtils.isPythonCmdAvailable()

  if (config.use_remote_comfyui) {
    return null
  }

  if (comfyuiDirAvailable && pythonCmdAvailable) {
    return null
  }

  const notSetItem = [
    {
      label: ' ComfyUI 路径',
      available: comfyuiDirAvailable
    },
    {
      label: ' Python 路径',
      available: pythonCmdAvailable
    }
  ]

  return (
    <Alert severity="warning">
      <AlertTitle>配置未完成</AlertTitle>
      <Typography>
        你正在使用{BUILD_MODE_NAME}，且未在配置中设置
        {notSetItem.map((item) => item.label).join('与')}
        ，无法正常使用。
      </Typography>
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

export default PureConfigNotSetCallout
