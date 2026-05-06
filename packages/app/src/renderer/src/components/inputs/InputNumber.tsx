import React, { useEffect } from 'react'
import BaseInputNumber from './BaseInputNumber'
import { InputProps } from './InputProps'

type InputNumberProps = InputProps<number> & {
  min?: number
  max?: number
  step?: number
}

const InputNumber: React.FC<InputNumberProps> = ({
  value,
  label,
  onChange,
  Icon,
  min,
  max,
  step
}) => {
  const [internalValue, setInternalValue] = React.useState<string>(value.toString())

  const handleBlur = () => {
    let newValue = Number(internalValue)
    if (Number.isNaN(newValue)) {
      newValue = min !== undefined ? min : 0
    }
    if (min !== undefined && newValue < min) {
      newValue = min
    }
    if (max !== undefined && newValue > max) {
      newValue = max
    }

    // 如果值有变化，触发 onChange
    if (newValue !== value) {
      onChange(newValue)
    }
    setInternalValue(newValue.toString())
  }

  // value 更新时触发更新 internalValue
  useEffect(() => {
    setInternalValue((prev) => (prev !== value.toString() ? value.toString() : prev))
  }, [value])

  const inputProps: {
    startAdornment?: React.ReactNode
    inputProps?: {
      min?: number
      max?: number
    }
  } = {}
  if (Icon) {
    inputProps.startAdornment = React.createElement(Icon, {
      sx: { mr: 1, color: 'text.secondary' }
    })
  }

  return (
    <BaseInputNumber
      value={internalValue}
      label={label}
      onChange={(e) => setInternalValue(e.toString())}
      onBlur={handleBlur}
      min={min}
      max={max}
      step={step}
      // slotProps={{
      //   input: inputProps
      // }}
    />
  )
}

export default InputNumber
