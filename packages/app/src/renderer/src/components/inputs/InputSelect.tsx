import React, { useId } from 'react'
import { Box, FormControl, InputLabel, MenuItem, Select } from '@mui/material'
import { InputProps } from './InputProps'
import QuestionTooltip from '../QuestionTooltip'

type InputSelectProps = InputProps<string> & {
  items: { label: string; value: string }[]
  error?: boolean
  ref?: React.Ref<HTMLDivElement>
}

const InputSelect: React.FC<InputSelectProps> = ({
  value,
  label,
  onChange,
  tooltip,
  items,
  Icon,
  error,
  ref
}) => {
  const selectId = useId()
  const labelId = `${selectId}-label`

  return (
    <FormControl fullWidth>
      <InputLabel
        id={labelId}
        htmlFor={selectId}
        sx={{
          fontSize: '1rem',
          fontWeight: 400,
          lineHeight: 1.5
        }}
      >
        {label}
      </InputLabel>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Select
          id={selectId}
          labelId={labelId}
          fullWidth
          ref={ref}
          value={value}
          label={label}
          onChange={(e) => onChange(e.target.value)}
          error={error}
          startAdornment={
            Icon && React.createElement(Icon, { sx: { mr: 1, color: 'text.secondary' } })
          }
          sx={{
            minWidth: '100px',
            fontSize: '1rem',
            fontWeight: 400,
            lineHeight: 1.5,
            color: 'text.secondary',
            '& .MuiSelect-select': {
              fontSize: '1rem',
              fontWeight: 400,
              lineHeight: 1.5,
              color: 'text.secondary'
            }
          }}
        >
          {items.map((item) => (
            <MenuItem
              key={item.value}
              value={item.value}
              sx={{
                fontSize: '1rem',
                fontWeight: 400,
                lineHeight: 1.5
              }}
            >
              {item.label}
            </MenuItem>
          ))}
        </Select>
        {tooltip && <QuestionTooltip>{tooltip}</QuestionTooltip>}
      </Box>
    </FormControl>
  )
}

export default InputSelect
