import { Button } from '@mui/material'
import { useNavigate } from 'react-router-dom'
import { useConfig } from '@renderer/hooks/useConfig'
import { useTranslation } from 'react-i18next'
import { useAppDispatch } from '@renderer/store'
import { setBottomPanelTab } from '@renderer/store/slices/layoutSlice'

type GoToConnectComfyAPIButtonProps = {
  afterClick?: () => void
}

export const GoToConnectComfyAPIButton = ({ afterClick }: GoToConnectComfyAPIButtonProps) => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { configUtils } = useConfig()
  const dispatch = useAppDispatch()

  return (
    <Button
      color="inherit"
      size="small"
      onClick={() => {
        if (configUtils.isComfyUICommandAvailable()) {
          dispatch(setBottomPanelTab('comfyui'))
        } else {
          navigate('/settings', { state: { tab: 'environment' } })
        }
        afterClick?.()
      }}
    >
      {t('quickapp.snackbar.go')}
    </Button>
  )
}
