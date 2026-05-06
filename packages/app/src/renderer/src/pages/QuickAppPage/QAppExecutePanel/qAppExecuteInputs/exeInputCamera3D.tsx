import React from 'react'
import { getJsonPath, setJsonPath } from '@shared/utils/jsonPath'
import { ExeInputBuilder, ExeInputProps } from './types'
import { useImperativeHandle } from 'react'
import { Box, Slider, Typography } from '@mui/material'
import { useQAppInputState } from '../../components/QAppContext'

type Camera3DValue = {
  horizontal: number
  vertical: number
  zoom: number
}

const buildExeInputCamera3D: ExeInputBuilder<'InputCamera3D'> = (cfg, workflow) => {
  const { label, horizontalSlot, verticalSlot, zoomSlot } = cfg

  const defaultHorizontal = getJsonPath(horizontalSlot, workflow)
  const defaultVertical = getJsonPath(verticalSlot, workflow)
  const defaultZoom = getJsonPath(zoomSlot, workflow)

  const id = `QAppInputCamera3D-${label}`
  const formKey = `${horizontalSlot}|${verticalSlot}|${zoomSlot}`

  const QAppInputCamera3D: React.FC<ExeInputProps> = ({ ref }) => {
    const [value, setValue] = useQAppInputState<Camera3DValue>(formKey, {
      horizontal: typeof defaultHorizontal === 'number' ? defaultHorizontal : 0,
      vertical: typeof defaultVertical === 'number' ? defaultVertical : 0,
      zoom: typeof defaultZoom === 'number' ? defaultZoom : 1
    })

    useImperativeHandle(
      ref,
      () => ({
        id,
        modifyWorkflow: (workflow) => {
          setJsonPath(horizontalSlot, workflow, value.horizontal)
          setJsonPath(verticalSlot, workflow, value.vertical)
          setJsonPath(zoomSlot, workflow, value.zoom)
        },
        validate: () => ''
      }),
      [value]
    )

    return (
      <Box sx={{ width: '100%', px: 1 }}>
        <Typography variant="body2" sx={{ mb: 1, color: 'text.secondary' }}>
          {label}
        </Typography>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <Box>
            <Typography variant="caption" color="text.secondary">
              水平角度: {value.horizontal}°
            </Typography>
            <Slider
              value={value.horizontal}
              onChange={(_, v) => setValue({ ...value, horizontal: v as number })}
              min={-180}
              max={180}
              step={1}
              size="small"
            />
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary">
              垂直角度: {value.vertical}°
            </Typography>
            <Slider
              value={value.vertical}
              onChange={(_, v) => setValue({ ...value, vertical: v as number })}
              min={-90}
              max={90}
              step={1}
              size="small"
            />
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary">
              缩放: {value.zoom}
            </Typography>
            <Slider
              value={value.zoom}
              onChange={(_, v) => setValue({ ...value, zoom: v as number })}
              min={0.1}
              max={5}
              step={0.1}
              size="small"
            />
          </Box>
        </Box>
      </Box>
    )
  }

  QAppInputCamera3D.displayName = id
  return QAppInputCamera3D
}

export default buildExeInputCamera3D
