import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { KonvaEventObject } from 'konva/lib/Node'
import { Layer, Image as KonvaImage, Group } from 'react-konva'
import { Box, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material'
import { ToolInfo, ToolProps, ToolRef, ToolValue } from './types/tools'
import HandTool from './tools/Hand'
import { loadImage } from './utils/imageUtils'
import { HistoryResults } from './components/HistoryResults'
import { HistoryProvider } from './contexts/HistoryContext'
import { CanvasStage, CanvasStageRef } from './components/CanvasStage'
import { TransformProvider } from './contexts/TransformContext'
import { BackHand } from '@mui/icons-material'
import { DebugInfo } from './components/DebugInfo'

type BaseImageCanvasProps = {
  tools: ToolInfo[]
  actions: React.ReactNode
  paintWidth: number
  paintHeight: number
  children: (toolRefs: Partial<Record<ToolValue, ToolRef | null>>) => React.ReactNode
}

export default function BaseImageCanvas({
  tools,
  actions,
  paintWidth,
  paintHeight,
  children
}: BaseImageCanvasProps) {
  const stageRef = useRef<CanvasStageRef | null>(null)

  const [tool, setTool] = useState<ToolValue>(tools[0].key)
  const toolRefs = useRef<Partial<Record<ToolValue, ToolRef | null>>>({})

  const [isDebug, setIsDebug] = useState(false)

  const handleMouseDown = (e: KonvaEventObject<MouseEvent>) => {
    // 按下鼠标形状
    stageRef.current?.setCursor(toolRefs.current[tool]?.mouseDownCursor)

    const pos = e.target.getStage()?.getPointerPosition()
    if (!pos) {
      return
    }
    const relativePos = e.target.getStage()?.getRelativePointerPosition()
    if (!relativePos) {
      return
    }

    toolRefs.current[tool]?.handleMouseDown({
      pos,
      relativePos
    })
  }

  const handleMouseMove = (e: KonvaEventObject<MouseEvent>) => {
    const pos = e.target.getStage()?.getPointerPosition()
    if (!pos) {
      return
    }
    const relativePos = e.target.getStage()?.getRelativePointerPosition()
    if (!relativePos) {
      return
    }
    toolRefs.current[tool]?.handleMouseMove({
      pos,
      relativePos
    })
  }

  const handleMouseUp = (e: KonvaEventObject<MouseEvent>) => {
    toolRefs.current[tool]?.handleMouseUp()
    // 抬起鼠标形状
    stageRef.current?.setCursor(toolRefs.current[tool]?.mouseUpCursor)
  }

  useLayoutEffect(() => {
    stageRef.current?.setCursor(toolRefs.current[tool]?.mouseUpCursor)
  }, [tool])

  return (
    <HistoryProvider>
      <TransformProvider>
        <Box
          width={'100%'}
          height={'100%'}
          sx={{
            display: 'flex',
            flexDirection: 'column'
          }}
        >
          {/* 工具栏 */}
          <Box
            sx={{
              display: 'flex',
              gap: 4,
              flexShrink: 0,
              px: 2,
              py: 1
            }}
          >
            <ToggleButtonGroup
              exclusive
              value={tool}
              onChange={(_, value) => {
                setTool(value)
                stageRef.current?.setCursor(toolRefs.current[value]?.mouseUpCursor)
              }}
            >
              {tools.map(({ key, Icon }) => {
                return (
                  <ToggleButton key={key} value={key}>
                    {Icon && <Icon />}
                  </ToggleButton>
                )
              })}
            </ToggleButtonGroup>
            {tools.map(({ Tool, key }) => (
              <Box
                key={key}
                sx={{
                  height: '100%',
                  display: key === tool ? 'flex' : 'none',
                  flex: 1,
                  alignItems: 'center',
                  gap: 2
                }}
              >
                <Tool
                  ref={(ref) => {
                    toolRefs.current[key] = ref
                  }}
                />
              </Box>
            ))}
            <Box sx={{ flex: 1 }} />
            {actions}
          </Box>
          {/* 画布容器 */}
          <Box sx={{ flex: 1, minHeight: 0 }}>
            {/* 画布 */}
            <CanvasStage
              ref={stageRef}
              onMouseMove={handleMouseMove}
              onMouseDown={handleMouseDown}
              onMouseUp={handleMouseUp}
              paintWidth={paintWidth}
              paintHeight={paintHeight}
            >
              {children(toolRefs.current)}
            </CanvasStage>
            {/* debug info */}
          </Box>
          {isDebug && <DebugInfo />}
        </Box>
      </TransformProvider>
    </HistoryProvider>
  )
}
