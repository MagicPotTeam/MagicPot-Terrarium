import React, { useEffect, useId, useImperativeHandle } from 'react'
import { Brush, Circle, Square } from '@mui/icons-material'
import { MouseDownCtx, MouseMoveCtx, ToolProps } from '../types/tools'
import { HistoryLine, PenShape } from '../types/history'
import { useState } from 'react'
import { Line } from 'react-konva'
import { Slider, ToggleButton, ToggleButtonGroup } from '@mui/material'
import { useHistory } from '../contexts/HistoryContext'

export const PenTool = (color: string): React.FC<ToolProps> => {
  const PenTool = ({ ref, ...props }: ToolProps) => {
    const id = useId()
    const [isDrawing, setIsDrawing] = useState(false)
    const [penSize, setPenSize] = useState(20)
    const [penshape, setPenshape] = useState<PenShape>('round')
    const { historyHandler } = useHistory()

    useEffect(() => {
      console.log('PenTool isDrawing change', id, isDrawing)
    }, [id, isDrawing])

    useImperativeHandle(
      ref,
      () => ({
        id,
        value: 'pen' as const,
        Icon: Brush,
        mouseUpCursor: 'crosshair',
        mouseDownCursor: 'crosshair',
        handleMouseDown: (ctx: MouseDownCtx) => {
          console.log('handleMouseDown', id, isDrawing)
          historyHandler.pushHistory('pen', penSize, penshape, ctx.relativePos)
          setIsDrawing(true)
        },
        handleMouseMove: (ctx: MouseMoveCtx) => {
          console.log('handleMouseMove', id, isDrawing)
          if (!isDrawing) {
            return
          }
          historyHandler.updateHistory(ctx.relativePos)
        },
        handleMouseUp: () => {
          console.log('handleMouseUp', id, isDrawing)
          setIsDrawing(false)
        },
        renderLine: (line: HistoryLine, index: number) => {
          return (
            <Line
              key={index}
              points={line.points}
              stroke={color}
              strokeWidth={line.width}
              lineCap={line.shape}
              lineJoin="round"
              globalCompositeOperation="source-over"
            />
          )
        }
      }),
      [id, isDrawing, penSize, penshape, historyHandler]
    )

    return (
      <>
        <ToggleButtonGroup exclusive value={penshape} onChange={(_, value) => setPenshape(value)}>
          <ToggleButton value="round">
            <Circle />
          </ToggleButton>
          <ToggleButton value="square">
            <Square />
          </ToggleButton>
        </ToggleButtonGroup>
        <Slider
          min={1}
          max={100}
          step={1}
          value={penSize}
          onChange={(_, value) => setPenSize(value)}
        />
      </>
    )
  }

  return PenTool
}
