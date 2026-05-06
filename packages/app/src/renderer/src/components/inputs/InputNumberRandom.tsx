import React, { useCallback, forwardRef, useImperativeHandle } from 'react'
import { IconButton, InputAdornment, TextField } from '@mui/material'
import { InputProps } from './InputProps'
import { Refresh } from '@mui/icons-material'

type InputNumberRandomProps = InputProps<number> & {
  placeholder: string
  randomFlag?: number // If the value is randomFlag, it will be set to a random value
  randomMax?: number
  showRefreshButton?: boolean // 是否显示刷新按钮
  endAdornment?: React.ReactNode // 自定义结束按钮
}

const InputNumberRandom = forwardRef<
  { refresh: () => void; getValue: () => number },
  InputNumberRandomProps
>(
  (
    {
      value,
      label,
      onChange,
      placeholder,
      Icon,
      randomFlag = -1,
      randomMax = 0xffffffff, // uint32 最大值
      showRefreshButton = true, // 默认显示刷新按钮
      endAdornment // 自定义结束按钮
    },
    ref
  ) => {
    const [internalValue, setInternalValue] = React.useState(value)

    const refresh = useCallback(() => {
      const randomValue = Math.floor(Math.random() * randomMax)
      setInternalValue(randomValue)
      onChange(randomValue)
    }, [randomMax, onChange])

    // 暴露 refresh 和 getValue 方法给父组件
    useImperativeHandle(
      ref,
      () => ({
        refresh,
        getValue: () => internalValue
      }),
      [refresh, internalValue]
    )

    // 使用 useEffect 处理随机值初始化
    React.useEffect(() => {
      if (value === randomFlag) {
        refresh()
      }
    }, [value, randomFlag, refresh])

    // ✅ 修复：同步外部 value 变化 - 直接同步，不做条件判断
    React.useEffect(() => {
      if (value !== undefined) {
        setInternalValue(value)
      }
    }, [value]) // 只依赖 value

    const handleBlur = () => {
      // 如果值有变化，触发 onChange
      if (internalValue !== value) {
        onChange(internalValue)
      }
    }

    const inputProps: {
      startAdornment?: React.ReactNode
      endAdornment?: React.ReactNode
    } = {}

    // 结束按钮：优先使用自定义按钮，否则根据 showRefreshButton 决定
    if (endAdornment) {
      inputProps.endAdornment = endAdornment
    } else if (showRefreshButton) {
      inputProps.endAdornment = (
        <InputAdornment position="end">
          <IconButton onClick={refresh}>
            <Refresh />
          </IconButton>
        </InputAdornment>
      )
    }

    if (Icon) {
      inputProps.startAdornment = React.createElement(Icon, {
        sx: { mr: 1, color: 'text.secondary' }
      })
    }

    return (
      <TextField
        type="number"
        value={internalValue}
        label={label}
        onChange={(e) => setInternalValue(Number(e.target.value))}
        onBlur={handleBlur}
        placeholder={placeholder}
        slotProps={{
          input: inputProps
        }}
      />
    )
  }
)

InputNumberRandom.displayName = 'InputNumberRandom'

export default InputNumberRandom
