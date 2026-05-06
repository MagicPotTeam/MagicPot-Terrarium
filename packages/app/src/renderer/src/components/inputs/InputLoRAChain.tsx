import React, { RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'
import InputSlider from './InputSlider'
import {
  Autocomplete,
  Box,
  Card,
  CardActions,
  CardContent,
  IconButton,
  Paper,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import { Add, Delete } from '@mui/icons-material'
import InputSelect from './InputSelect'
import { ComfyUtils } from '@renderer/utils/comfyUtils'
import { api } from '@renderer/utils/windowUtils'
import { bytesToObjectUrl } from '@renderer/utils/fileUtils'
import { InputProps } from './InputProps'

export type LoRAConfig = {
  lora_name: string
  strength_model: number
  strength_clip: number
}

type InputLoraProps = {
  index: number
  currentLora: LoRAConfig
  handleUpdate: (index: number, newValue: Partial<LoRAConfig>) => void
  loraOptions: string[]
  loraName2ImageName: Record<string, string>
  comfyUtilsRef: RefObject<ComfyUtils>
}

const InputLora: React.FC<InputLoraProps> = ({
  index,
  currentLora,
  handleUpdate,
  loraOptions,
  loraName2ImageName,
  comfyUtilsRef
}) => {
  const [imageObjUrl, setImageObjUrl] = useState<string | null>(null)
  const [imageHeight, setImageHeight] = useState<number | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const [gridTemplateColumns, setGridTemplateColumns] = useState<string>('1fr')

  useEffect(() => {
    ;(async () => {
      try {
        const imageName = loraName2ImageName[currentLora.lora_name]
        if (imageName) {
          const res = await comfyUtilsRef.current.viewImage({ name: imageName })
          setImageObjUrl(bytesToObjectUrl(res.image, 'image/png'))
          setGridTemplateColumns(`1fr 3fr`)
          return
        }
      } catch (error) {
        console.info('failed to view image', currentLora.lora_name, error)
      }
      setImageObjUrl(null)
      setGridTemplateColumns(`1fr`)
    })()
  }, [currentLora.lora_name, loraName2ImageName, comfyUtilsRef])

  useLayoutEffect(() => {
    if (boxRef.current) {
      const rect = boxRef.current.getBoundingClientRect()
      setImageHeight(rect.height)
    }
  }, [boxRef])

  return (
    <>
      <Autocomplete
        value={currentLora.lora_name || null}
        onChange={(event, newValue) => {
          handleUpdate(index, { lora_name: newValue || '' })
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
            style={{ whiteSpace: 'normal', wordBreak: 'break-word', padding: '8px 16px' }}
          >
            {option}
          </li>
        )}
        sx={{
          '& .MuiOutlinedInput-root': {
            backgroundColor: 'background.paper'
          }
        }}
      />
      <Box sx={{ display: 'grid', gridTemplateColumns: gridTemplateColumns, gap: 1, mt: 2 }}>
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
              handleUpdate(index, {
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
              handleUpdate(index, {
                strength_clip: v
              })
            }
            min={0}
            max={1.2}
            step={0.01}
            defaultValue={1}
          />
        </Box>
      </Box>
    </>
  )
}

type InputLoRAChainProps = InputProps<LoRAConfig[]> & {
  placeholder?: string
  lora_options: string[]
}

const InputLoRAChain: React.FC<InputLoRAChainProps> = ({
  label,
  value,
  onChange,
  Icon,
  placeholder,
  lora_options
}) => {
  const handleChange = (newValue: LoRAConfig[]) => {
    onChange(newValue)
  }
  const handleUpdate = (index: number, newValue: Partial<LoRAConfig>) => {
    handleChange(value.map((lora, i) => (i === index ? { ...lora, ...newValue } : lora)))
  }
  const handleDelete = (index: number) => {
    handleChange(value.filter((lora, i) => i !== index))
  }
  const handleAdd = () => {
    handleChange([...value, { ...defaultLoraConfig }])
  }

  const comfyUtilsRef = useRef(new ComfyUtils(api().svcComfy, api().svcPysssss))
  const [loraName2ImageName, setLoraName2ImageName] = useState<Record<string, string>>({})
  useEffect(() => {
    ;(async () => {
      const loraName2ImageName = await comfyUtilsRef.current.listImages({ type: 'loras' })
      setLoraName2ImageName(loraName2ImageName)
    })()
  }, [comfyUtilsRef])

  const defaultLoraConfig: LoRAConfig = {
    lora_name: '',
    strength_model: 1,
    strength_clip: 1
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
            <Card key={index}>
              <CardContent>
                <InputLora
                  index={index}
                  currentLora={currentLora}
                  handleUpdate={handleUpdate}
                  loraOptions={lora_options}
                  loraName2ImageName={loraName2ImageName}
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
