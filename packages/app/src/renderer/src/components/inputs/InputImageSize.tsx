import React, { useEffect } from 'react'
import { TextField, Box } from '@mui/material'
import { InputProps } from './InputProps'

type ImageSize = {
  width: number
  height: number
}

type InputImageSizeProps = InputProps<ImageSize> & {
  placeholder?: {
    width: string
    height: string
  }
}

const InputImageSize: React.FC<InputImageSizeProps> = ({
  value,
  label,
  onChange,
  placeholder = { width: '宽度', height: '高度' },
  Icon
}) => {
  const [internalValue, setInternalValue] = React.useState<ImageSize>(value)

  const handleBlur = () => {
    // 如果值有变化，触发 onChange
    if (internalValue.width !== value.width || internalValue.height !== value.height) {
      onChange(internalValue)
    }
  }

  const handleWidthChange = (newWidth: number) => {
    setInternalValue((prev) => ({ ...prev, width: newWidth }))
  }

  const handleHeightChange = (newHeight: number) => {
    setInternalValue((prev) => ({ ...prev, height: newHeight }))
  }

  // value 更新时触发更新 internalValue
  useEffect(() => {
    setInternalValue((prev) =>
      prev.width !== value.width || prev.height !== value.height ? value : prev
    )
  }, [value])

  return (
    <Box sx={{ display: 'flex', gap: 2 }}>
      <TextField
        type="number"
        value={internalValue.width}
        label="宽"
        onChange={(e) => handleWidthChange(Number(e.target.value))}
        onBlur={handleBlur}
        placeholder={placeholder.width}
        sx={{ flex: 1 }}
        slotProps={
          Icon && {
            input: {
              startAdornment: React.createElement(Icon, {
                sx: { mr: 1, color: 'text.secondary' }
              })
            }
          }
        }
      />
      <TextField
        type="number"
        value={internalValue.height}
        label="高"
        onChange={(e) => handleHeightChange(Number(e.target.value))}
        onBlur={handleBlur}
        placeholder={placeholder.height}
        sx={{ flex: 1 }}
        slotProps={
          Icon && {
            input: {
              startAdornment: React.createElement(Icon, {
                sx: { mr: 1, color: 'text.secondary' }
              })
            }
          }
        }
      />
    </Box>
  )
}

export default InputImageSize
