import React from 'react'
import { InputProps } from './InputProps'
import BaseInputTextField from './BaseInputTextField'

type InputTextProps = InputProps<string> & {
  placeholder: string
  errorText?: string
  shrinkLabel?: boolean
}

const InputText: React.FC<InputTextProps> = ({
  value,
  label,
  onChange,
  placeholder,
  Icon,
  errorText,
  shrinkLabel
}) => {
  return (
    <BaseInputTextField
      multiline
      minRows={1}
      fullWidth
      errorText={errorText}
      label={label}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      Icon={Icon}
      shrinkLabel={shrinkLabel}
    />
  )
}

export default InputText
