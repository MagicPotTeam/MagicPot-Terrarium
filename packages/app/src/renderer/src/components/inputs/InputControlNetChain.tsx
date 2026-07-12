import React, { RefObject, useEffect, useRef, useState } from 'react'
import InputSlider from './InputSlider'
import { Box, Card, CardActions, CardContent, IconButton, Stack, Typography } from '@mui/material'
import { Add, Delete } from '@mui/icons-material'
import InputSelect from './InputSelect'
import { ComfyUtils } from '@renderer/utils/comfyUtils'
import { api } from '@renderer/utils/windowUtils'
import { bytesToObjectUrl } from '@renderer/utils/fileUtils'
import { InputProps } from './InputProps'

export type ControlNetConfig = {
  control_net_name: string
  preprocessor?: string // 预处理器名称，可选
  strength: number
  start_percent: number
  end_percent: number
}

type InputControlNetProps = {
  index: number
  currentControlNet: ControlNetConfig
  handleUpdate: (index: number, newValue: Partial<ControlNetConfig>) => void
  controlNetOptions: string[]
  preprocessorOptions: string[]
  controlNetName2ImageName: Record<string, string>
  comfyUtilsRef: RefObject<ComfyUtils>
}

const InputControlNet: React.FC<InputControlNetProps> = ({
  index,
  currentControlNet,
  handleUpdate,
  controlNetOptions,
  preprocessorOptions,
  controlNetName2ImageName,
  comfyUtilsRef
}) => {
  const [imageObjUrl, setImageObjUrl] = useState<string | null>(null)
  const [imageHeight, setImageHeight] = useState<number | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const [gridTemplateColumns, setGridTemplateColumns] = useState<string>('1fr')

  useEffect(() => {
    let cancelled = false
    let ownedObjectUrl: string | null = null

    ;(async () => {
      try {
        const imageName = controlNetName2ImageName[currentControlNet.control_net_name]
        if (imageName) {
          const res = await comfyUtilsRef.current.viewImage({ name: imageName })
          ownedObjectUrl = bytesToObjectUrl(res.image, 'image/png')
          if (cancelled) {
            URL.revokeObjectURL(ownedObjectUrl)
            return
          }
          setImageObjUrl(ownedObjectUrl)
          setGridTemplateColumns(`1fr 3fr`)
          return
        }
      } catch (error) {
        if (!cancelled) {
          console.info('failed to view image', currentControlNet.control_net_name, error)
        }
      }
      if (!cancelled) {
        setImageObjUrl(null)
        setGridTemplateColumns(`1fr`)
      }
    })()

    return () => {
      cancelled = true
      if (ownedObjectUrl) {
        URL.revokeObjectURL(ownedObjectUrl)
      }
    }
  }, [currentControlNet.control_net_name, controlNetName2ImageName, comfyUtilsRef])

  useEffect(() => {
    const box = boxRef.current
    if (!box) return

    const updateImageHeight = () => setImageHeight(box.getBoundingClientRect().height)
    updateImageHeight()

    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(updateImageHeight)
    observer.observe(box)
    return () => observer.disconnect()
  }, [])

  return (
    <>
      <InputSelect
        label={`ControlNet ${index}`}
        value={currentControlNet.control_net_name}
        onChange={(v) => handleUpdate(index, { control_net_name: v })}
        items={controlNetOptions.map((name) => ({ label: name, value: name })) || []}
      />
      {preprocessorOptions.length > 0 && (
        <Box sx={{ mt: 1.5 }}>
          <InputSelect
            label={`ControlNet ${index} 预处理器`}
            value={currentControlNet.preprocessor || ''}
            onChange={(v) => handleUpdate(index, { preprocessor: v || undefined })}
            items={[
              { label: '无预处理器', value: '' },
              ...preprocessorOptions.map((name) => ({ label: name, value: name }))
            ]}
          />
        </Box>
      )}
      <Box sx={{ display: 'grid', gridTemplateColumns: gridTemplateColumns, gap: 1, mt: 2 }}>
        {imageObjUrl && imageHeight && (
          <Box
            sx={{ display: 'flex', flexDirection: 'column', gap: 1, width: '100%' }}
            ref={boxRef}
          >
            <img
              src={imageObjUrl}
              alt={currentControlNet.control_net_name}
              style={{ height: imageHeight, objectFit: 'contain', borderRadius: '4px' }}
            />
          </Box>
        )}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, width: '100%' }} ref={boxRef}>
          <InputSlider
            value={currentControlNet.strength}
            label={`ControlNet ${index} 强度`}
            onChange={(v) =>
              handleUpdate(index, {
                strength: v
              })
            }
            min={0}
            max={2}
            step={0.01}
            defaultValue={1}
          />
          <InputSlider
            value={currentControlNet.start_percent}
            label={`ControlNet ${index} 开始百分比`}
            onChange={(v) =>
              handleUpdate(index, {
                start_percent: v
              })
            }
            min={0}
            max={1}
            step={0.01}
            defaultValue={0}
          />
          <InputSlider
            value={currentControlNet.end_percent}
            label={`ControlNet ${index} 结束百分比`}
            onChange={(v) =>
              handleUpdate(index, {
                end_percent: v
              })
            }
            min={0}
            max={1}
            step={0.01}
            defaultValue={1}
          />
        </Box>
      </Box>
    </>
  )
}

type InputControlNetChainProps = InputProps<ControlNetConfig[]> & {
  placeholder?: string
  controlnet_options: string[]
  preprocessor_options?: string[]
}

const InputControlNetChain: React.FC<InputControlNetChainProps> = ({
  label,
  value,
  onChange,
  Icon,
  placeholder,
  controlnet_options,
  preprocessor_options = []
}) => {
  const handleChange = (newValue: ControlNetConfig[]) => {
    onChange(newValue)
  }
  const handleUpdate = (index: number, newValue: Partial<ControlNetConfig>) => {
    handleChange(
      value.map((controlNet, i) => (i === index ? { ...controlNet, ...newValue } : controlNet))
    )
  }
  const handleDelete = (index: number) => {
    handleChange(value.filter((controlNet, i) => i !== index))
  }
  const handleAdd = () => {
    handleChange([...value, { ...defaultControlNetConfig }])
  }

  const comfyUtilsRef = useRef(new ComfyUtils(api().svcComfy, api().svcPysssss))
  const [controlNetName2ImageName, setControlNetName2ImageName] = useState<Record<string, string>>(
    {}
  )
  useEffect(() => {
    ;(async () => {
      try {
        // ControlNet 可能没有预览图，这里尝试获取，失败也没关系
        const controlNetName2ImageName = await comfyUtilsRef.current.listImages({ type: 'loras' })
        setControlNetName2ImageName(controlNetName2ImageName)
      } catch (error) {
        // 如果获取失败，使用空对象
        setControlNetName2ImageName({})
      }
    })()
  }, [comfyUtilsRef])

  const defaultControlNetConfig: ControlNetConfig = {
    control_net_name: '',
    preprocessor: undefined,
    strength: 1,
    start_percent: 0,
    end_percent: 1
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
          value.map((currentControlNet, index) => (
            <Card key={index}>
              <CardContent>
                <InputControlNet
                  index={index}
                  currentControlNet={currentControlNet}
                  handleUpdate={handleUpdate}
                  controlNetOptions={controlnet_options}
                  preprocessorOptions={preprocessor_options}
                  controlNetName2ImageName={controlNetName2ImageName}
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
                {placeholder || '请添加 ControlNet'}
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

export default InputControlNetChain
