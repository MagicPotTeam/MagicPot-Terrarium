import React, { useState } from 'react'
import { Box, IconButton } from '@mui/material'
import { Delete } from '@mui/icons-material'
import InputText from '@renderer/components/inputs/InputText'
import { QAppCfgAllComponentType, QAppCfgInputType } from '@shared/qApp/cfgTypes'
import { QAppCfgComponentNameMap } from '@shared/qApp/consts'

type InputLabelState = {
  label: string
  InputLabel: React.FC
}

export const useInputLabel = (
  defaultLabel: string | undefined,
  id: string,
  inputType: QAppCfgAllComponentType,
  onDelete: () => void
): InputLabelState => {
  const [label, setLabel] = useState<string>(defaultLabel || QAppCfgComponentNameMap[inputType])
  return {
    label,
    InputLabel: () => {
      return (
        <Box sx={{ display: 'flex', flexDirection: 'row', gap: 1 }}>
          <InputText label="Label" value={label} onChange={setLabel} placeholder="Label" />
          <Box sx={{ flex: 1 }} />
          <IconButton onClick={onDelete}>
            <Delete />
          </IconButton>
        </Box>
      )
    }
  }
}

export default useInputLabel
