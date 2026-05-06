import React, { useEffect, useState } from 'react'
import { TextField, TextFieldProps } from '@mui/material'

/**
 * https://mui.com/material-ui/react-text-field/#type-quot-number-quot
 * 由于以上原因，这个 Base 组件不考虑数字输入的情况
 */

type BaseInputTextFieldProps = Omit<
  TextFieldProps,
  'type' | 'value' | 'onChange' | 'error' | 'helperText' | 'onBlur'
> & {
  value: string
  onChange: (value: string) => void
  Icon?: React.ComponentType<{ sx: { mr: number; color: string } }>
  errorText?: string
  maxLength?: number
  onBlur?: TextFieldProps['onBlur']
  updateMode?: 'blur' | 'change'
  shrinkLabel?: boolean
}

/**
 * 输入文本的 Base 组件
 * 自动处理了 value 的频繁触发更新问题
 * 只在 onBlur 时触发 onChange
 * @param param0
 * @returns
 */
const BaseInputTextField: React.FC<BaseInputTextFieldProps> = ({
  value,
  onChange,
  Icon,
  maxLength,
  errorText,
  onBlur,
  updateMode = 'blur',
  shrinkLabel = false,
  ...props
}) => {
  const [internalValue, setInternalValue] = useState<string>(value)

  const handleBlur: TextFieldProps['onBlur'] = (e) => {
    // 如果以 onBlur 提交，且值有变化，触发 onChange
    if (updateMode === 'blur' && internalValue !== value) {
      onChange(internalValue)
    }

    // 代理 onBlur
    onBlur?.(e)
  }

  // value 更新时触发更新 internalValue
  useEffect(() => {
    setInternalValue((prev) => (prev !== value ? value : prev))
  }, [value])

  // 在不动其他 slotProps 的情况下，添加 Icon
  let slotProps: TextFieldProps<'standard'>['slotProps'] = props.slotProps
  if (Icon) {
    if (!slotProps) {
      slotProps = {}
    }
    if (!slotProps.input) {
      slotProps.input = {}
    }
    slotProps.input = {
      ...slotProps.input,
      startAdornment: React.createElement(Icon, {
        sx: { mr: 1, color: 'text.secondary' }
      })
    }
  }
  if (maxLength) {
    if (!slotProps) {
      slotProps = {}
    }
    slotProps.htmlInput = {
      ...slotProps.htmlInput,
      maxLength: maxLength
    }
  }
  if (slotProps) {
    props.slotProps = slotProps
  }

  // 设置 InputLabelProps 让 label 始终显示在上方
  const inputLabelProps = shrinkLabel ? { shrink: true } : undefined

  return (
    <TextField
      {...props}
      error={!!errorText}
      helperText={errorText}
      value={internalValue}
      InputLabelProps={inputLabelProps}
      onChange={(e) => {
        const nextValue = e.target.value
        setInternalValue(nextValue)
        if (updateMode === 'change' && nextValue !== value) {
          onChange(nextValue)
        }
      }}
      onBlur={handleBlur}
    />
  )
}

export default BaseInputTextField
