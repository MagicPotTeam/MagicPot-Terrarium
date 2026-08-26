import InputSwitch from '@renderer/components/inputs/InputSwitch'
import { useTranslation } from 'react-i18next'
import { Alert, MenuItem, Stack, TextField } from '@mui/material'

export type DsnBatchProcessProps = {
  enabled: boolean
  setEnabled: (enabled: boolean) => void
  imageInputSlot: string
  imageInputSlots?: string[]
  setImageInputSlot?: (slot: string) => void
  outputNodeIds: string[]
}

const DsnBatchProcess = ({
  enabled,
  setEnabled,
  imageInputSlot,
  imageInputSlots = imageInputSlot ? [imageInputSlot] : [],
  setImageInputSlot,
  outputNodeIds
}: DsnBatchProcessProps) => {
  const { t } = useTranslation()
  const available = Boolean(imageInputSlot) && outputNodeIds.length > 0

  return (
    <Stack spacing={1.5} sx={{ width: '100%' }}>
      {imageInputSlots.length > 1 && setImageInputSlot && (
        <TextField
          select
          size="small"
          label={t('qapp.design.batch_process_image_input')}
          value={imageInputSlot}
          onChange={(event) => setImageInputSlot(event.target.value)}
          disabled={outputNodeIds.length === 0}
        >
          {imageInputSlots.map((slot) => (
            <MenuItem key={slot} value={slot}>
              {slot}
            </MenuItem>
          ))}
        </TextField>
      )}
      <InputSwitch
        label={t('qapp.design.batch_process_enabled')}
        value={enabled}
        onChange={setEnabled}
        disabled={!available}
      />
      {!available && (
        <Alert severity="warning">
          {t('qapp.design.batch_process_missing_binding', {
            defaultValue: 'Batch processing requires an image input and at least one output node.'
          })}
        </Alert>
      )}
      {enabled && available && (
        <Alert severity="info">
          {t('qapp.design.batch_process_info', {
            defaultValue: `Batch processing will use ${imageInputSlot} as the image input field.`
          })}
        </Alert>
      )}
    </Stack>
  )
}

export default DsnBatchProcess
