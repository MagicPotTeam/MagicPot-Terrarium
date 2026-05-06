import { Stage as KonvaStage } from 'konva/lib/Stage'
import { useImperativeHandle, useRef } from 'react'
import { Stage, StageProps } from 'react-konva'
import { TransformHandler } from '../types/transform'
import MaxSizeLayout from '@renderer/components/MaxSizeLayout'
import { useTransform } from '../contexts/TransformContext'
import { KonvaEventObject } from 'konva/lib/Node'

export type CanvasStageRef = {
  stage: KonvaStage | null
  setCursor: (cursor?: string) => void
}

type CanvasStageProps = Omit<StageProps, 'ref'> & {
  ref: React.Ref<CanvasStageRef | null>
  paintWidth: number
  paintHeight: number
}

export const CanvasStage = ({
  ref,
  children,
  paintWidth,
  paintHeight,
  ...props
}: CanvasStageProps) => {
  const stageRef = useRef<KonvaStage>(null)
  const { transformHandler } = useTransform()

  useImperativeHandle(ref, () => ({
    stage: stageRef.current,
    setCursor: (cursor?: string) => {
      if (!cursor) {
        return
      }
      const container = stageRef.current?.container?.()
      if (container) {
        container.style.cursor = cursor
      }
    }
  }))

  const onResize = (width: number, height: number) => {
    console.log('onResize', width, height)
    stageRef.current?.width(width)
    stageRef.current?.height(height)
    transformHandler.resizeImageView(width, height, paintWidth, paintHeight)
  }

  const handleWheel = (e: KonvaEventObject<WheelEvent>) => {
    // TODO: 放到 Tools 上
    e.evt.preventDefault()

    const pos = e.target.getStage()?.getPointerPosition()
    if (!pos) {
      return
    }

    transformHandler.scaleAtPoint(pos, e.evt.deltaY)
  }

  return (
    <MaxSizeLayout onResize={onResize}>
      <Stage ref={stageRef} {...props} {...transformHandler.toStageProps()} onWheel={handleWheel}>
        {children}
      </Stage>
    </MaxSizeLayout>
  )
}
