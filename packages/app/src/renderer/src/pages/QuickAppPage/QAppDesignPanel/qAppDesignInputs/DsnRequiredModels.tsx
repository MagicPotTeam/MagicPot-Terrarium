import React, { useCallback } from 'react'
import { Box, Button, IconButton, Typography, TextField, Select, MenuItem } from '@mui/material'
import { Add, Delete } from '@mui/icons-material'
import DsnComponentLayout from './components/DsnComponentLayout'
import InputSwitch from '@renderer/components/inputs/InputSwitch'
import { Alert } from '@mui/material'
import { QAppRequiredModel } from '@shared/qApp/cfgTypes'

type DsnRequiredModelsProps = {
  enabled: boolean
  setEnabled: (enabled: boolean) => void
  value: QAppRequiredModel[]
  setValue: (value: QAppRequiredModel[]) => void
}

const emptyModel: QAppRequiredModel = { name: '', size: '', dir: '', url: '' }
type RequiredModelBaseDir = NonNullable<QAppRequiredModel['baseDir']>
type RequiredModelTextField = 'name' | 'size' | 'dir' | 'url'

const ModelItem: React.FC<{
  index: number
  model: QAppRequiredModel
  onRemove: (index: number) => void
  onUpdate: (index: number, model: QAppRequiredModel) => void
}> = ({ index, model, onRemove, onUpdate }) => {
  const handleChange = (field: RequiredModelTextField, value: string) => {
    onUpdate(index, { ...model, [field]: value })
  }

  const handleBaseDirChange = (baseDir: RequiredModelBaseDir) => {
    onUpdate(index, { ...model, baseDir: baseDir === 'comfyui' ? undefined : baseDir })
  }

  return (
    <Box
      sx={(t) => ({
        p: 1.5,
        borderRadius: 1,
        bgcolor: t.palette.mode === 'dark' ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
        border: `1px solid ${t.palette.divider}`,
        display: 'flex',
        flexDirection: 'column',
        gap: 1
      })}
    >
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
        <TextField
          size="small"
          label="模型文件名"
          value={model.name}
          onChange={(e) => handleChange('name', e.target.value)}
          sx={{ flex: 3 }}
          placeholder="model.safetensors"
        />
        <TextField
          size="small"
          label="大小"
          value={model.size}
          onChange={(e) => handleChange('size', e.target.value)}
          sx={{ flex: 1 }}
          placeholder="11 GB"
        />
        <IconButton onClick={() => onRemove(index)} size="small">
          <Delete />
        </IconButton>
      </Box>
      <Box sx={{ display: 'flex', gap: 1 }}>
        <Select
          size="small"
          value={model.baseDir ?? 'comfyui'}
          onChange={(e) => handleBaseDirChange(e.target.value as RequiredModelBaseDir)}
          sx={{ minWidth: 132 }}
        >
          <MenuItem value="comfyui">ComfyUI</MenuItem>
          <MenuItem value="portableHome">Portable home</MenuItem>
        </Select>
        <TextField
          size="small"
          label="放置目录"
          value={model.dir}
          onChange={(e) => handleChange('dir', e.target.value)}
          sx={{ flex: 1 }}
          placeholder="models/unet"
        />
        <TextField
          size="small"
          label="下载链接"
          value={model.url}
          onChange={(e) => handleChange('url', e.target.value)}
          sx={{ flex: 2 }}
          placeholder="https://huggingface.co/..."
        />
      </Box>
    </Box>
  )
}

const DsnRequiredModels: React.FC<DsnRequiredModelsProps> = ({
  value,
  setValue,
  enabled,
  setEnabled
}) => {
  const addModel = useCallback(() => {
    setValue([...value, { ...emptyModel }])
  }, [value, setValue])

  const removeModel = useCallback(
    (index: number) => {
      setValue(value.filter((_, i) => i !== index))
    },
    [value, setValue]
  )

  const updateModel = useCallback(
    (index: number, model: QAppRequiredModel) => {
      setValue(value.map((v, i) => (i === index ? model : v)))
    },
    [value, setValue]
  )

  return (
    <>
      <InputSwitch
        label="是否设置所需模型"
        value={enabled}
        onChange={(value) => setEnabled(value)}
      />
      {enabled && (
        <DsnComponentLayout>
          <Alert severity="info">
            如果设置了所需模型，当检测到模型文件不存在时，会在快应用界面提示用户下载。
          </Alert>
          <Typography variant="caption" color="text.secondary">
            所需模型
          </Typography>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {value.map((model, index) => (
              <ModelItem
                key={index}
                index={index}
                model={model}
                onRemove={removeModel}
                onUpdate={updateModel}
              />
            ))}
            <Button variant="text" color="inherit" onClick={addModel}>
              <Add />
              添加模型
            </Button>
          </Box>
        </DsnComponentLayout>
      )}
    </>
  )
}

export default DsnRequiredModels
