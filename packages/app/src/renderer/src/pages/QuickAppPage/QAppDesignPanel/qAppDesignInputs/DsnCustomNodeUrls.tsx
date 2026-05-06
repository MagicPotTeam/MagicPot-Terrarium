import React from 'react'
import InputTextList from '@renderer/components/inputs/InputTextList'
import DsnComponentLayout from './components/DsnComponentLayout'
import InputSwitch from '@renderer/components/inputs/InputSwitch'
import { Alert } from '@mui/material'
import { useTranslation } from 'react-i18next'

type DsnCustomNodeUrlsProps = {
  enabled: boolean
  setEnabled: (enabled: boolean) => void
  value: string[]
  setValue: (value: string[]) => void
}

const DsnCustomNodeUrls: React.FC<DsnCustomNodeUrlsProps> = ({
  value,
  setValue,
  enabled,
  setEnabled
}) => {
  const { t } = useTranslation()

  return (
    <>
      <InputSwitch
        label={t('custom_app.enable_custom_node_urls')}
        value={enabled}
        onChange={(value) => setEnabled(value)}
      />
      {enabled && (
        <DsnComponentLayout>
          <Alert severity="info">{t('custom_app.custom_node_urls_info')}</Alert>
          <InputTextList
            label={t('custom_app.custom_node_urls')}
            value={value}
            onChange={setValue}
          />
        </DsnComponentLayout>
      )}
    </>
  )
}

export default DsnCustomNodeUrls
