import React, { useId, useImperativeHandle, useState } from 'react'
import { BackHand } from '@mui/icons-material'
import { ToolProps } from '../types/tools'
import { Coord, MouseDownCtx, MouseMoveCtx } from '../types/tools'
import { HistoryLine } from '../types/history'
import { useTransform } from '../contexts/TransformContext'

export const HandTool = ({ ref, ...props }: ToolProps) => {
  const id = useId()
  const [lastMousePosition, setLastMousePosition] = useState<Coord | null>(null)
  const { transformHandler } = useTransform()

  useImperativeHandle(ref, () => ({
    id,
    value: 'hand' as const,
    Icon: BackHand,
    mouseUpCursor: 'default',
    mouseDownCursor: 'default',
    handleMouseDown: (ctx: MouseDownCtx) => {
      setLastMousePosition(ctx.pos)
    },
    handleMouseMove: (ctx: MouseMoveCtx) => {
      if (!lastMousePosition) {
        return
      }
      transformHandler.moveFromTo(lastMousePosition, ctx.pos)
      setLastMousePosition(ctx.pos)
    },
    handleMouseUp: () => {
      setLastMousePosition(null)
    },
    renderLine: (line: HistoryLine, index: number) => {
      return <></>
    }
  }))

  return <></>
}

export default HandTool
