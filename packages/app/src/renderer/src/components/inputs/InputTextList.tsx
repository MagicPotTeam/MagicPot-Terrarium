import React, { useCallback, useEffect, useRef, useState } from 'react'
import { InputProps } from './InputProps'
import { isEqual } from 'es-toolkit'
import { Box, Button, IconButton, Typography } from '@mui/material'
import BaseInputTextField from './BaseInputTextField'
import { Add, Delete } from '@mui/icons-material'

type InputTextListItemProps = {
  index: number
  value: string
  onRemove: (index: number) => void
  onSet: (index: number, value: string) => void
}

const InputTextListItem: React.FC<InputTextListItemProps> = ({ index, value, onRemove, onSet }) => {
  const onChange = useCallback(
    (value: string) => {
      onSet(index, value)
    },
    [index, onSet]
  )
  const onRemoveClick = useCallback(() => {
    onRemove(index)
  }, [index, onRemove])

  return (
    <Box
      sx={{ display: 'flex', flexDirection: 'row', gap: 1, width: '100%', alignItems: 'center' }}
    >
      <Box sx={{ width: '100%', flex: 1 }}>
        <BaseInputTextField value={value} onChange={onChange} fullWidth />
      </Box>
      <Box>
        <IconButton onClick={onRemoveClick}>
          <Delete />
        </IconButton>
      </Box>
    </Box>
  )
}

type InputTextListProps = InputProps<string[]>

const InputTextList: React.FC<InputTextListProps> = ({ value, label, onChange, Icon }) => {
  const [internalValue, setInternalValue] = useState<string[]>(value)
  const lastCommittedValueRef = useRef(value)

  useEffect(() => {
    setInternalValue((prev) => {
      if (isEqual(prev, value)) return prev
      lastCommittedValueRef.current = value
      return value
    })
  }, [value])

  useEffect(() => {
    if (isEqual(lastCommittedValueRef.current, internalValue)) {
      return
    }
    lastCommittedValueRef.current = internalValue
    onChange(internalValue)
  }, [internalValue, onChange])

  const addItem = useCallback(() => {
    setInternalValue((prev) => [...prev, ''])
  }, [])
  const removeItem = useCallback((index: number) => {
    setInternalValue((prev) => prev.filter((_, i) => i !== index))
  }, [])
  const setItem = useCallback((index: number, value: string) => {
    setInternalValue((prev) => prev.map((v, i) => (i === index ? value : v)))
  }, [])

  return (
    <Box>
      <Box sx={{ mb: 1 }}>
        <Typography variant="caption" color="text.secondary">
          {label}
        </Typography>
      </Box>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, width: '100%' }}>
        {internalValue.map((item, index) => (
          <InputTextListItem
            key={index}
            index={index}
            value={item}
            onRemove={removeItem}
            onSet={setItem}
          />
        ))}
        <Button variant="text" color="inherit" onClick={addItem}>
          <Add />
          {label}
        </Button>
      </Box>
    </Box>
  )
}

export default InputTextList
