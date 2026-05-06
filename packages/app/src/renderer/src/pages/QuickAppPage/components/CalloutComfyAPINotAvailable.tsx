import { ObjectInfoMap } from '@shared/comfy/types'
import { Alert, AlertTitle, Typography, Box } from '@mui/material'
import { GoToConnectComfyAPIButton } from './GoToConnectComfyAPIButton'
import { useTranslation } from 'react-i18next'

type CalloutComfyAPINotAvailableProps = {
  isDesignMode: boolean
  objectInfos: ObjectInfoMap
}

export const CalloutComfyAPINotAvailable = ({
  isDesignMode,
  objectInfos
}: CalloutComfyAPINotAvailableProps) => {
  const { t } = useTranslation()

  const show = !objectInfos || Object.keys(objectInfos).length === 0
  if (!show) {
    return null
  }

  if (isDesignMode) {
    return (
      <Alert severity="warning" sx={{ '& .MuiAlert-message': { width: '100%' } }}>
        <AlertTitle>{t('qapp.callout.comfy_api_not_available_title')}</AlertTitle>
        <Typography variant="body2">
          {t('qapp.callout.comfy_api_not_available_desc_design')}
        </Typography>
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 1 }}>
          <GoToConnectComfyAPIButton />
        </Box>
      </Alert>
    )
  }

  return (
    <Alert severity="warning" sx={{ '& .MuiAlert-message': { width: '100%' } }}>
      <AlertTitle>{t('qapp.callout.comfy_api_not_available_title')}</AlertTitle>
      <Typography variant="body2">
        {t('qapp.callout.comfy_api_not_available_desc_execute')}
      </Typography>
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 1 }}>
        <GoToConnectComfyAPIButton />
      </Box>
    </Alert>
  )
}
