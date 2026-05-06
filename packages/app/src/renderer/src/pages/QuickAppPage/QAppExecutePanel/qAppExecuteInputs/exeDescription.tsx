import { QAppCfgDescription } from '@shared/qApp/cfgTypes'
import { ExeInputBuilder, ExeInputProps } from './types'
import React, { useImperativeHandle } from 'react'
import { Alert, AlertTitle, Typography } from '@mui/material'
import { useQAppLabel } from '../../hooks/useQAppLabel'

export const buildExeDescription: ExeInputBuilder<'Description'> = (cfg, workflow) => {
  const { label, title, variant, description } = cfg
  const id = `QAppDescription-${label}`

  const QAppDescription: React.FC<ExeInputProps> = ({ ref }) => {
    const translatedTitle = useQAppLabel(title || '')
    const translatedDescription = useQAppLabel(description || '')

    useImperativeHandle(
      ref,
      () => ({
        id,
        modifyWorkflow: (workflow) => {},
        validate: (workflow) => ''
      }),
      []
    )
    return (
      <Alert severity={variant}>
        {title && <AlertTitle>{translatedTitle}</AlertTitle>}
        <Typography variant="body1">{translatedDescription}</Typography>
      </Alert>
    )
  }

  QAppDescription.displayName = id
  return QAppDescription
}

export default buildExeDescription
