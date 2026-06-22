import React, { RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import InputSlider from './InputSlider'
import {
  Autocomplete,
  Box,
  Button,
  Card,
  CardActions,
  CardContent,
  IconButton,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import { Add, Delete, PlaylistAdd } from '@mui/icons-material'
import { ComfyUtils } from '@renderer/utils/comfyUtils'
import { api } from '@renderer/utils/windowUtils'
import { bytesToObjectUrl } from '@renderer/utils/fileUtils'
import { InputProps } from './InputProps'
import { isEqual } from 'es-toolkit'
import { useTranslation } from 'react-i18next'

const TRIGGER_WORDS_LABEL_FALLBACK = 'Trigger words note'
const TRIGGER_WORDS_PLACEHOLDER_FALLBACK = 'Enter trigger words for this LoRA'
const TRIGGER_WORDS_HELPER_FALLBACK =
  'Trigger words are read after selecting a LoRA; click "Append trigger words" to add them to the prompt'
const APPEND_TRIGGER_WORDS_LABEL_FALLBACK = 'Append trigger words'

export type LoRAConfig = {
  lora_name: string
  strength_model: number
  strength_clip: number
  trigger_words?: string
}

type InputLoraProps = {
  index: number
  rowId: string
  currentLora: LoRAConfig
  handleUpdateByRowId: (rowId: string, newValue: Partial<LoRAConfig>) => LoRAConfig[] | undefined
  loraOptions: string[]
  loraName2ImageName: Record<string, string>
  onLoraSelected?: (
    loraName: string,
    triggerWords?: string,
    nextLoras?: LoRAConfig[]
  ) => string | void | Promise<string | void>
  onLoraTriggerWordsConfirmed?: (
    loraName: string,
    triggerWords: string
  ) => string | void | Promise<string | void>
  onAppendLoraTriggerWords?: (lora: LoRAConfig) => string | void | Promise<string | void>
  comfyUtilsRef: RefObject<ComfyUtils>
}

const InputLora: React.FC<InputLoraProps> = ({
  index,
  rowId,
  currentLora,
  handleUpdateByRowId,
  loraOptions,
  loraName2ImageName,
  onLoraSelected,
  onLoraTriggerWordsConfirmed,
  onAppendLoraTriggerWords,
  comfyUtilsRef
}) => {
  const { t } = useTranslation()
  const triggerWordsLabel = t('input.lora.trigger_words_label', {
    defaultValue: TRIGGER_WORDS_LABEL_FALLBACK
  })
  const triggerWordsPlaceholder = t('input.lora.trigger_words_placeholder', {
    defaultValue: TRIGGER_WORDS_PLACEHOLDER_FALLBACK
  })
  const triggerWordsHelper = t('input.lora.trigger_words_helper', {
    defaultValue: TRIGGER_WORDS_HELPER_FALLBACK
  })
  const appendTriggerWordsLabel = t('input.lora.append_trigger_words', {
    defaultValue: APPEND_TRIGGER_WORDS_LABEL_FALLBACK
  })
  const [imageObjUrl, setImageObjUrl] = useState<string | null>(null)
  const [imageHeight, setImageHeight] = useState<number | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const [gridTemplateColumns, setGridTemplateColumns] = useState<string>('1fr')
  const loraSelectionRequestRef = useRef(0)
  const loraPreviewRequestRef = useRef(0)
  const handleUpdateByRowIdRef = useRef(handleUpdateByRowId)
  const currentLoraNameRef = useRef(currentLora.lora_name)
  const imageObjUrlRef = useRef<string | null>(null)

  useEffect(() => {
    handleUpdateByRowIdRef.current = handleUpdateByRowId
  }, [handleUpdateByRowId])

  useEffect(() => {
    currentLoraNameRef.current = currentLora.lora_name
  }, [currentLora.lora_name])

  const updateImageObjUrl = useCallback((nextUrl: string | null) => {
    setImageObjUrl((prev) => {
      if (prev && prev !== nextUrl) {
        URL.revokeObjectURL(prev)
      }
      imageObjUrlRef.current = nextUrl
      return nextUrl
    })
  }, [])

  useEffect(
    () => () => {
      loraSelectionRequestRef.current += 1
      loraPreviewRequestRef.current += 1
      if (imageObjUrlRef.current) {
        URL.revokeObjectURL(imageObjUrlRef.current)
        imageObjUrlRef.current = null
      }
    },
    []
  )

  useEffect(() => {
    const requestId = loraPreviewRequestRef.current + 1
    loraPreviewRequestRef.current = requestId
    let createdUrl: string | null = null

    updateImageObjUrl(null)
    setGridTemplateColumns(`1fr`)

    const imageName = loraName2ImageName[currentLora.lora_name]
    if (!imageName) {
      return () => {
        if (loraPreviewRequestRef.current === requestId) {
          loraPreviewRequestRef.current += 1
        }
      }
    }

    ;(async () => {
      try {
        const res = await comfyUtilsRef.current.viewImage({ name: imageName })
        createdUrl = bytesToObjectUrl(res.image, 'image/png')
        if (loraPreviewRequestRef.current !== requestId) {
          URL.revokeObjectURL(createdUrl)
          createdUrl = null
          return
        }
        updateImageObjUrl(createdUrl)
        createdUrl = null
        setGridTemplateColumns(`1fr 3fr`)
      } catch (error) {
        if (loraPreviewRequestRef.current !== requestId) {
          return
        }
        console.info('failed to view image', currentLora.lora_name, error)
        updateImageObjUrl(null)
        setGridTemplateColumns(`1fr`)
      }
    })()

    return () => {
      if (loraPreviewRequestRef.current === requestId) {
        loraPreviewRequestRef.current += 1
      }
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl)
        createdUrl = null
      }
    }
  }, [currentLora.lora_name, loraName2ImageName, comfyUtilsRef, updateImageObjUrl])

  useLayoutEffect(() => {
    if (boxRef.current) {
      const rect = boxRef.current.getBoundingClientRect()
      setImageHeight(rect.height)
    }
  }, [boxRef])

  const currentTriggerWords = currentLora.lora_name ? currentLora.trigger_words || '' : ''

  return (
    <Box sx={{ containerType: 'inline-size' }}>
      <Autocomplete
        value={currentLora.lora_name || null}
        onChange={(event, newValue) => {
          const requestId = loraSelectionRequestRef.current + 1
          loraSelectionRequestRef.current = requestId
          const nextLoraName = newValue || ''
          const nextLoras = handleUpdateByRowIdRef.current(rowId, {
            lora_name: nextLoraName,
            trigger_words: ''
          })
          if (nextLoraName) {
            void Promise.resolve(onLoraSelected?.(nextLoraName, '', nextLoras))
              .then((loadedTriggerWords) => {
                if (
                  !loadedTriggerWords ||
                  loraSelectionRequestRef.current !== requestId ||
                  currentLoraNameRef.current !== nextLoraName
                ) {
                  return
                }
                handleUpdateByRowIdRef.current(rowId, {
                  lora_name: nextLoraName,
                  trigger_words: loadedTriggerWords
                })
              })
              .catch((error) => {
                console.warn('[InputLoRAChain] failed to load LoRA trigger words:', error)
              })
          }
        }}
        options={loraOptions}
        freeSolo={false}
        disableClearable={false}
        renderInput={(params) => (
          <TextField
            {...params}
            label={`Lora ${index}`}
            variant="outlined"
            size="small"
            placeholder="输入搜索或选择..."
          />
        )}
        ListboxProps={{
          style: {
            maxHeight: '400px',
            overflow: 'auto'
          }
        }}
        renderOption={(props, option) => (
          <li
            {...props}
            key={option}
            style={{ whiteSpace: 'normal', wordBreak: 'break-word', padding: '8px 16px' }}
          >
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="body2">{option}</Typography>
            </Box>
          </li>
        )}
        sx={{
          '& .MuiOutlinedInput-root': {
            backgroundColor: 'background.paper'
          }
        }}
      />
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: gridTemplateColumns,
          gap: 1,
          mt: 1.5,
          '@container (max-width: 360px)': {
            mt: 1
          }
        }}
      >
        {imageObjUrl && imageHeight && (
          <Box
            sx={{ display: 'flex', flexDirection: 'column', gap: 1, width: '100%' }}
            ref={boxRef}
          >
            <img
              src={imageObjUrl}
              alt={currentLora.lora_name}
              style={{ height: imageHeight, objectFit: 'contain', borderRadius: '4px' }}
            />
          </Box>
        )}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, width: '100%' }} ref={boxRef}>
          {/* 替换 InputSlider 为 LoraSlider */}
          <InputSlider
            value={currentLora.strength_model}
            label={`Lora ${index} 模型强度`}
            onChange={(v) =>
              handleUpdateByRowIdRef.current(rowId, {
                strength_model: v
              })
            }
            min={0}
            max={1.2}
            step={0.01}
            defaultValue={1}
          />
          <InputSlider
            value={currentLora.strength_clip}
            label={`Lora ${index} CLIP强度`}
            onChange={(v) =>
              handleUpdateByRowIdRef.current(rowId, {
                strength_clip: v
              })
            }
            min={0}
            max={1.2}
            step={0.01}
            defaultValue={1}
          />
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr)',
              gap: 1,
              alignItems: 'flex-start'
            }}
          >
            <TextField
              value={currentTriggerWords}
              label={`Lora ${index} ${triggerWordsLabel}`}
              placeholder={triggerWordsPlaceholder}
              onChange={(event) => {
                if (!currentLora.lora_name) {
                  return
                }
                const nextTriggerWords = event.target.value
                handleUpdateByRowIdRef.current(rowId, { trigger_words: nextTriggerWords })
              }}
              onBlur={() => {
                if (currentLora.lora_name && currentTriggerWords.trim()) {
                  void Promise.resolve(
                    onLoraTriggerWordsConfirmed?.(currentLora.lora_name, currentTriggerWords)
                  ).catch((error) => {
                    console.warn('[InputLoRAChain] failed to confirm LoRA trigger words:', error)
                  })
                }
              }}
              size="small"
              disabled={!currentLora.lora_name}
              multiline
              minRows={1}
              maxRows={3}
              helperText={triggerWordsHelper}
              sx={{
                minWidth: 0,
                '& .MuiInputBase-root': {
                  alignItems: 'flex-start'
                },
                '& .MuiFormHelperText-root': {
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis'
                },
                '@container (max-width: 360px)': {
                  '& .MuiFormHelperText-root': {
                    whiteSpace: 'normal',
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical'
                  }
                }
              }}
            />
            <Button
              variant="outlined"
              size="small"
              startIcon={<PlaylistAdd />}
              disabled={!currentLora.lora_name || !currentTriggerWords.trim()}
              onClick={() => {
                if (!currentLora.lora_name || !currentTriggerWords.trim()) {
                  return
                }
                void Promise.resolve(onAppendLoraTriggerWords?.(currentLora)).catch((error) => {
                  console.warn('[InputLoRAChain] failed to append LoRA trigger words:', error)
                })
              }}
              sx={{
                height: 40,
                minHeight: 40,
                whiteSpace: 'nowrap',
                justifySelf: 'stretch'
              }}
            >
              {appendTriggerWordsLabel}
            </Button>
          </Box>
        </Box>
      </Box>
    </Box>
  )
}

type InputLoRAChainProps = InputProps<LoRAConfig[]> & {
  placeholder?: string
  lora_options: string[]
  onLoraSelected?: (
    loraName: string,
    triggerWords?: string,
    nextLoras?: LoRAConfig[]
  ) => string | void | Promise<string | void>
  onAppendLoraTriggerWords?: (lora: LoRAConfig) => string | void | Promise<string | void>
}

const InputLoRAChain: React.FC<InputLoRAChainProps> = ({
  label,
  value,
  onChange,
  Icon,
  placeholder,
  lora_options,
  onLoraSelected,
  onAppendLoraTriggerWords
}) => {
  const rowIdsRef = useRef<string[]>([])
  const nextRowIdRef = useRef(0)
  const valueRef = useRef(value)
  valueRef.current = value

  const createRowId = () => `lora-row-${nextRowIdRef.current++}`
  while (rowIdsRef.current.length < value.length) {
    rowIdsRef.current.push(createRowId())
  }
  if (rowIdsRef.current.length > value.length) {
    rowIdsRef.current = rowIdsRef.current.slice(0, value.length)
  }

  const handleChange = useCallback(
    (newValue: LoRAConfig[]) => {
      valueRef.current = newValue
      onChange(newValue)
    },
    [onChange]
  )
  const handleUpdateByRowId = useCallback(
    (rowId: string, newValue: Partial<LoRAConfig>) => {
      const rowIndex = rowIdsRef.current.indexOf(rowId)
      if (rowIndex === -1) {
        return undefined
      }
      const currentValue = valueRef.current
      if (!currentValue[rowIndex]) {
        return undefined
      }
      const nextValue = currentValue.map((lora, i) =>
        i === rowIndex ? { ...lora, ...newValue } : lora
      )
      handleChange(nextValue)
      return nextValue
    },
    [handleChange]
  )
  const handleDelete = (index: number) => {
    rowIdsRef.current.splice(index, 1)
    handleChange(valueRef.current.filter((lora, i) => i !== index))
  }
  const handleAdd = () => {
    rowIdsRef.current.push(createRowId())
    handleChange([...valueRef.current, { ...defaultLoraConfig }])
  }
  const comfyUtilsRef = useRef(new ComfyUtils(api().svcComfy, api().svcPysssss))
  const [loraName2ImageName, setLoraName2ImageName] = useState<Record<string, string>>({})
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const nextLoraName2ImageName = await comfyUtilsRef.current.listImages({ type: 'loras' })
        if (cancelled) return
        setLoraName2ImageName((prev) =>
          isEqual(prev, nextLoraName2ImageName) ? prev : nextLoraName2ImageName
        )
      } catch (error) {
        if (cancelled) return
        console.warn('[InputLoRAChain] failed to list LoRA preview images:', error)
        setLoraName2ImageName((prev) => (Object.keys(prev).length === 0 ? prev : {}))
      }
    })()

    return () => {
      cancelled = true
    }
  }, [comfyUtilsRef])

  const defaultLoraConfig: LoRAConfig = {
    lora_name: '',
    strength_model: 1,
    strength_clip: 1,
    trigger_words: ''
  }
  return (
    <Box sx={{ overflow: 'auto' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 0.5 }}>
        {Icon &&
          React.createElement(Icon, {
            sx: { mr: 1, color: 'text.secondary' }
          })}
        <Typography variant="body2" color="text.secondary">
          {label}
        </Typography>
      </Box>
      <Stack sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {value &&
          value.map((currentLora, index) => (
            <Card key={rowIdsRef.current[index] ?? index}>
              <CardContent>
                <InputLora
                  index={index}
                  rowId={rowIdsRef.current[index] ?? `${index}`}
                  currentLora={currentLora}
                  handleUpdateByRowId={handleUpdateByRowId}
                  loraOptions={lora_options}
                  loraName2ImageName={loraName2ImageName}
                  onLoraSelected={onLoraSelected}
                  onLoraTriggerWordsConfirmed={onLoraSelected}
                  onAppendLoraTriggerWords={onAppendLoraTriggerWords}
                  comfyUtilsRef={comfyUtilsRef}
                />
              </CardContent>
              <CardActions>
                <IconButton
                  onClick={() => handleDelete(index)}
                  sx={{
                    marginLeft: 'auto'
                  }}
                >
                  <Delete />
                </IconButton>
              </CardActions>
            </Card>
          ))}
        {value && value.length === 0 && (
          <Card>
            <CardContent>
              <Typography variant="body2" color="text.secondary">
                {placeholder || '请添加 Lora'}
              </Typography>
            </CardContent>
          </Card>
        )}
        <Card>
          <Box sx={{ display: 'flex', justifyContent: 'center' }}>
            <IconButton color="primary" size="large" onClick={() => handleAdd()}>
              <Add />
            </IconButton>
          </Box>
        </Card>
      </Stack>
    </Box>
  )
}

export default InputLoRAChain
