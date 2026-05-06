import React, { useEffect } from 'react'
import { TextField } from '@mui/material'
import { InputProps } from './InputProps'
import BaseInputTextField from './BaseInputTextField'

type InputTextAreaProps = InputProps<string> & {
  placeholder: string
  rows?: number
  minRows?: number
}

const InputTextArea: React.FC<InputTextAreaProps> = ({
  value,
  label,
  onChange,
  placeholder,
  rows,
  minRows = 4,
  Icon
}) => {
  return (
    <BaseInputTextField
      multiline
      rows={rows}
      minRows={rows ? undefined : minRows}
      fullWidth
      label={label}
      value={value}
      onChange={onChange}
      Icon={Icon}
      placeholder={placeholder}
    />
  )
}

export default InputTextArea
