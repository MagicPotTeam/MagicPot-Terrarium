import React from 'react'
import { Box, FormControlLabel, Switch, Typography } from '@mui/material'
import { useTheme } from '@mui/material/styles'
import { InputProps } from './InputProps'
import QuestionTooltip from '../QuestionTooltip'

type InputSwitchProps = InputProps<boolean> & {
  label: string
}

const InputSwitch: React.FC<InputSwitchProps> = ({ value, label, onChange, Icon, tooltip }) => {
  const theme = useTheme()
  const isLight = theme.palette.mode === 'light'

  return (
    <Box
      sx={{
        width: '100%',
        px: 1.5,
        py: 1.25,
        borderRadius: 2.5,
        bgcolor: isLight ? '#f7f8fc' : '#252525',
        WebkitAppRegion: 'no-drag'
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography variant="caption" color="text.secondary">
          {label}
        </Typography>
        {tooltip && <QuestionTooltip>{tooltip}</QuestionTooltip>}
      </Box>
      <FormControlLabel
        sx={{
          m: 0,
          mt: 0.5,
          width: '100%',
          justifyContent: 'space-between',
          WebkitAppRegion: 'no-drag',
          '& .MuiFormControlLabel-label': {
            color: 'text.secondary',
            fontSize: 12
          }
        }}
        label={
          Icon ? (
            React.createElement(Icon, {
              sx: { mr: 0, color: 'text.secondary' }
            })
          ) : (
            <Box />
          )
        }
        labelPlacement="start"
        control={
          <Switch
            checked={!!value}
            onChange={(e) => onChange(e.target.checked)}
            inputProps={{ 'aria-label': label }}
          />
        }
      />
    </Box>
  )
}

export default InputSwitch
