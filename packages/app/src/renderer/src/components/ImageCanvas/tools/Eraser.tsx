import React, { useId, useImperativeHandle, useState } from 'react'
import { ToolProps } from '../types/tools'
import { CleaningServices } from '@mui/icons-material'
import { MouseDownCtx, MouseMoveCtx } from '../types/tools'
import { HistoryLine } from '../types/history'
import { Line } from 'react-konva'
import { Slider } from '@mui/material'
import { useHistory } from '../contexts/HistoryContext'

export const EraserTool = ({ ref, ...props }: ToolProps) => {
  const id = useId()
  const [isEraser, setIsEraser] = useState(false)
  const [eraserSize, setEraserSize] = useState(25)
  const { historyHandler } = useHistory()

  useImperativeHandle(
    ref,
    () => ({
      id,
      value: 'eraser' as const,
      Icon: CleaningServices,
      mouseUpCursor: 'default',
      mouseDownCursor: 'default',
      handleMouseDown: (ctx: MouseDownCtx) => {
        historyHandler.pushHistory('eraser', eraserSize, 'round', ctx.relativePos)
        setIsEraser(true)
      },
      handleMouseMove: (ctx: MouseMoveCtx) => {
        if (!isEraser) {
          return
        }
        historyHandler.updateHistory(ctx.relativePos)
      },
      handleMouseUp: () => {
        setIsEraser(false)
      },
      renderLine: (line: HistoryLine, index: number) => {
        return (
          <Line
            key={index}
            points={line.points}
            stroke="black"
            strokeWidth={line.width}
            lineCap="round"
            lineJoin="round"
            globalCompositeOperation="destination-out"
          />
        )
      }
    }),
    [id, isEraser, eraserSize, historyHandler]
  )

  return (
    <Slider
      min={1}
      max={100}
      step={1}
      value={eraserSize}
      onChange={(_, value) => setEraserSize(value)}
    />
  )
}

export default EraserTool
