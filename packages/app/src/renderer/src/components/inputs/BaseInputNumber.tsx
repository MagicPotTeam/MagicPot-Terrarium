/* eslint-disable @typescript-eslint/no-explicit-any */
import { TextField } from '@mui/material'
import { styled } from '@mui/material/styles'
import InputAdornment from '@mui/material/InputAdornment'
import IconButton from '@mui/material/IconButton'
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp'
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown'
import React, { FC } from 'react'

const CustomTextField = styled(TextField)(({ theme }) => ({
  borderRadius: theme.shape.borderRadius,
  '& input:valid:focus  + div + fieldset': {
    borderWidth: 1
  },
  '& input:invalid:focus + fieldset': {
    borderWidth: 1
  },
  '& .MuiFormHelperText-root': {
    marginLeft: 0
  },
  // 隐藏 input[type="number"] 的浏览器默认箭头
  '& input[type="number"]::-webkit-inner-spin-button': {
    WebkitAppearance: 'none',
    margin: 0
  },
  '& input[type="number"]::-webkit-outer-spin-button': {
    WebkitAppearance: 'none',
    margin: 0
  },
  '& input[type="number"]': {
    MozAppearance: 'textfield'
  }
}))

function firValue(
  val: string,
  precision: number | null,
  min: number | null,
  max: number | null,
  prefix: string = '',
  suffix: string = '',
  length: number = 30,
  clamp: boolean = true
) {
  let value = val.replace(prefix, '').replace(suffix, '')
  let result: string
  let sign = value[0]
  value = (sign === '-' ? '-' : '') + String(value.replace('-', '').slice(0, length))
  const parts = value.split('.')
  let part_one = parts[0].replace(/\D/gi, '')
  if (parts.length > 1 && part_one === '') {
    part_one = '0'
  }
  const part_two = parts
    .filter((elm, i) => i !== 0)
    .join('')
    .replace(/\D/gi, '')
  if (part_two) {
    if (sign !== '-') {
      sign = ''
    }
    result = sign + part_one + '.' + part_two
  } else {
    if (sign !== '-') {
      sign = ''
    }
    if (parts.length === 2 && parts[1] === '') {
      result = sign + part_one + '.'
    } else {
      result = sign + part_one
    }
  }
  if (Number.isInteger(precision) && precision !== null) {
    const fraction = result.split('.')
    const result_fixed = Number(result).toFixed(precision)
    const result_fixed_fraction = result_fixed.split('.')
    if (fraction.length > 1 && fraction[1] !== '' && fraction[1].length > precision) {
      if (precision === 0) {
        result = String(result_fixed_fraction[0])
      } else {
        result = result_fixed_fraction[0] + '.' + result_fixed_fraction[1]
      }
    } else if (fraction.length > 1) {
      if (precision === 0) {
        result = String(result_fixed_fraction[0])
      }
    }
  }

  if (clamp) {
    if (max !== null) {
      if (Number(result) > max) {
        result = String(max)
      }
    }
    if (min !== null) {
      if (Number(result) < min) {
        result = String(min)
      }
    }
  }
  return result
}

interface NumberInputProps {
  onChange: (value: string | number) => void
  label?: string
  value: number | string
  onBlur?: (value: string | number) => void
  step?: number
  precision?: number
  max?: number
  min?: number
  length?: number
  size?: 'small' | 'medium'
  sx?: { [key: string]: string }
  inputStyle?: { [key: string]: any }
  error?: boolean
  helperText?: string
  disabled?: boolean
  prefix?: string
  suffix?: string
  'data-testid'?: string
  buttons?: boolean
}

const NumberInput: FC<NumberInputProps> = ({ ...props }) => {
  return (
    <CustomTextField
      size={props.size}
      disabled={props.disabled === true}
      label={props.label}
      onChange={(e) => {
        const result = firValue(
          e.target.value,
          props.precision !== undefined ? props.precision : null,
          props.min !== undefined ? props.min : null,
          props.max !== undefined ? props.max : null,
          props.prefix,
          props.suffix,
          props.length,
          false
        )
        if (props.onChange) {
          props.onChange(result)
        }
      }}
      onBlur={(e) => {
        if (props.onBlur) {
          props.onBlur(e.target.value)
        }
      }}
      value={
        String(props.value).length === 0
          ? props.value
          : (props.prefix ? props.prefix : '') + props.value + (props.suffix ? props.suffix : '')
      }
      inputProps={{
        'data-testid': props['data-testid'],
        style: {
          textAlign: 'left',
          fontSize: '14px',
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
          ...props.inputStyle
        }
      }}
      sx={{
        ...props.sx
      }}
      error={props.error}
      helperText={props.helperText}
      InputProps={
        props.buttons === false
          ? {}
          : {
              endAdornment: (
                <InputAdornment
                  position="end"
                  sx={props.disabled === true ? { display: 'none' } : { lineHeight: '14px' }}
                >
                  <div>
                    <div>
                      <IconButton
                        onBlur={() => {
                          if (props.onBlur) {
                            props.onBlur(props.value)
                          }
                        }}
                        disabled={props.disabled === true}
                        onClick={(e) => {
                          e.stopPropagation()

                          if (props.step) {
                            if (props.onChange) {
                              const result = firValue(
                                String(Number(props.value) + props.step),
                                props.precision !== undefined ? props.precision : null,
                                props.min !== undefined ? props.min : null,
                                props.max !== undefined ? props.max : null,
                                props.prefix,
                                props.suffix
                              )
                              props.onChange(result)
                            }
                          } else {
                            if (props.onChange) {
                              const result = firValue(
                                String(Number(props.value) + 1),
                                props.precision !== undefined ? props.precision : null,
                                props.min !== undefined ? props.min : null,
                                props.max !== undefined ? props.max : null,
                                props.prefix,
                                props.suffix
                              )
                              props.onChange(result)
                            }
                          }
                        }}
                        size="small"
                        sx={{
                          width: '10px',
                          height: '10px',
                          margin: 0,
                          padding: '1px 4px !important'
                        }}
                      >
                        <KeyboardArrowUpIcon sx={{ width: '18px', height: '18px' }} />
                      </IconButton>
                    </div>
                    <div>
                      <IconButton
                        onBlur={() => {
                          if (props.onBlur) {
                            props.onBlur(props.value)
                          }
                        }}
                        disabled={props.disabled === true}
                        onClick={(e) => {
                          e.stopPropagation()
                          if (props.step) {
                            if (props.onChange) {
                              const result = firValue(
                                String(Number(props.value) - props.step),
                                props.precision !== undefined ? props.precision : null,
                                props.min !== undefined ? props.min : null,
                                props.max !== undefined ? props.max : null,
                                props.prefix,
                                props.suffix
                              )
                              props.onChange(result)
                            }
                          } else {
                            if (props.onChange) {
                              const result = firValue(
                                String(Number(props.value) - 1),
                                props.precision !== undefined ? props.precision : null,
                                props.min !== undefined ? props.min : null,
                                props.max !== undefined ? props.max : null,
                                props.prefix,
                                props.suffix
                              )
                              props.onChange(result)
                            }
                          }
                        }}
                        size="small"
                        sx={{
                          width: '10px',
                          height: '10px',
                          margin: 0,
                          padding: '1px 4px !important'
                        }}
                      >
                        {' '}
                        <KeyboardArrowDownIcon sx={{ width: '18px', height: '18px' }} />
                      </IconButton>
                    </div>
                  </div>
                </InputAdornment>
              )
            }
      }
    />
  )
}

export default NumberInput
