import React from 'react'
import { Box, Chip, Fade, InputBaseProps, TextFieldSlotsAndSlotProps } from '@mui/material'
import { InputProps } from './InputProps'
import styled from '@emotion/styled'
import BaseInputTextField from './BaseInputTextField'
import CircularProgress from '@mui/material/CircularProgress'
import PromptTagEditor from './PromptTagEditor'
import { getDroppedTextContent } from '@renderer/utils/droppedImageUtils'

const EndAdornmentClose = styled(Box)`
  display: flex;
  gap: 8px;
  right: 10px;
  bottom: 10px;
  position: absolute;
  background: rgba(30, 30, 30, 0.85);
  backdrop-filter: blur(4px);
  padding: 4px 6px;
  border-radius: 8px;
`

type InputTextAreaFunctionalProps = InputProps<string> & {
  placeholder: string
  maxLength?: number
  maxRows?: number
  showTagEditor?: boolean
  tagEditorStorageKey?: string
  buttons?: {
    text: string
    onClick: () => Promise<void>
    onDrop?: (event: React.DragEvent<HTMLDivElement>) => Promise<void>
  }[]
}

const InputTextAreaFunctional: React.FC<InputTextAreaFunctionalProps> = ({
  value,
  label,
  onChange,
  placeholder,
  Icon,
  buttons,
  maxLength,
  maxRows = 8,
  showTagEditor = true,
  tagEditorStorageKey
}) => {
  const [isFocused, setIsFocused] = React.useState(false)
  const containerRef = React.useRef<HTMLDivElement>(null)
  const [isLoading, setIsLoading] = React.useState(false)
  const [activeDropButton, setActiveDropButton] = React.useState<string | null>(null)

  const slotProps: TextFieldSlotsAndSlotProps<InputBaseProps>['slotProps'] = {}
  slotProps.htmlInput = {
    onDragOver: (event: React.DragEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const droppedText = getDroppedTextContent(event.dataTransfer)
      if (!droppedText) return

      event.preventDefault()
      event.stopPropagation()
      event.dataTransfer.dropEffect = 'copy'
    },
    onDrop: (event: React.DragEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const droppedText = getDroppedTextContent(event.dataTransfer)
      if (!droppedText) return

      event.preventDefault()
      event.stopPropagation()

      const target = event.currentTarget
      const baseValue = target.value ?? value ?? ''
      const selectionStart =
        typeof target.selectionStart === 'number' ? target.selectionStart : baseValue.length
      const selectionEnd =
        typeof target.selectionEnd === 'number' ? target.selectionEnd : selectionStart
      const nextValue =
        baseValue.slice(0, selectionStart) + droppedText + baseValue.slice(selectionEnd)
      const nextSelection = selectionStart + droppedText.length

      onChange(nextValue)
      window.requestAnimationFrame(() => {
        if (document.activeElement !== target) {
          target.focus()
        }
        target.setSelectionRange(nextSelection, nextSelection)
      })
    }
  }
  if (buttons) {
    slotProps.input = {
      endAdornment: (
        <Fade in={!isFocused}>
          <EndAdornmentClose>
            {buttons.map((button) => {
              const runButtonAction = async (action: () => Promise<void>) => {
                if (isLoading) return
                setIsLoading(true)
                try {
                  await action()
                } finally {
                  setIsLoading(false)
                }
              }

              const isDropTarget = Boolean(button.onDrop)
              const isDropActive = activeDropButton === button.text

              return (
                <Chip
                  key={button.text}
                  variant="filled"
                  onClick={() => {
                    void runButtonAction(button.onClick)
                  }}
                  disabled={isLoading}
                  label={button.text}
                  onDragOver={
                    isDropTarget
                      ? (event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          event.dataTransfer.dropEffect = 'copy'
                          if (activeDropButton !== button.text) {
                            setActiveDropButton(button.text)
                          }
                        }
                      : undefined
                  }
                  onDragLeave={
                    isDropTarget
                      ? () => {
                          if (activeDropButton === button.text) {
                            setActiveDropButton(null)
                          }
                        }
                      : undefined
                  }
                  onDrop={
                    isDropTarget
                      ? (event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          setActiveDropButton(null)
                          void runButtonAction(() => button.onDrop!(event))
                        }
                      : undefined
                  }
                  sx={{
                    border: isDropActive ? '1px solid' : '1px solid transparent',
                    borderColor: isDropActive ? 'primary.main' : 'transparent',
                    backgroundColor: isDropActive ? 'rgba(99, 102, 241, 0.18)' : undefined,
                    '&:hover': {
                      backgroundColor: 'primary.main',
                      color: 'primary.contrastText'
                    }
                  }}
                />
              )
            })}
          </EndAdornmentClose>
        </Fade>
      )
    }
  }

  return (
    <Box
      sx={{
        width: '100%',
        maxWidth: '100%',
        overflowX: 'hidden',
        overflowY: 'visible',
        pt: 1,
        display: 'flex',
        flexDirection: 'column',
        gap: showTagEditor ? 0.75 : 0
      }}
      onDragLeave={() => {
        if (activeDropButton) {
          setActiveDropButton(null)
        }
      }}
    >
      <Box sx={{ position: 'relative', overflowY: 'visible' }}>
        <BaseInputTextField
          ref={containerRef}
          multiline
          minRows={buttons ? 5 : 4}
          maxRows={maxRows}
          fullWidth
          label={label}
          value={value}
          onChange={onChange}
          onBlur={() => setIsFocused(false)}
          onFocus={() => setIsFocused(true)}
          Icon={Icon}
          placeholder={placeholder}
          slotProps={slotProps}
          sx={buttons ? { '& .MuiInputBase-input': { pb: '44px' } } : undefined}
          disabled={isLoading}
          maxLength={maxLength}
          updateMode={showTagEditor ? 'change' : 'blur'}
          shrinkLabel
        />
        {isLoading && (
          <Box
            sx={{
              position: 'absolute',
              top: 0,
              right: 0,
              bottom: 0,
              left: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              bgcolor: 'rgba(255,255,255,0.6)',
              borderRadius: 1,
              zIndex: 2,
              pointerEvents: 'auto'
            }}
          >
            <CircularProgress />
          </Box>
        )}
      </Box>

      {showTagEditor && (
        <PromptTagEditor value={value} onChange={onChange} storageKey={tagEditorStorageKey} />
      )}
    </Box>
  )
}

export default InputTextAreaFunctional
