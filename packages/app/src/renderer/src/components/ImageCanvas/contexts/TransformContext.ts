import { useState, createContext, createElement, useContext } from 'react'
import { Coord } from '../types/tools'
import { Transform, TransformHandler } from '../types/transform'

type TransformContextType = {
  transform: Transform
  transformHandler: TransformHandler
}

const TransformContext = createContext<TransformContextType>({
  transform: { imagePosition: { x: 0, y: 0 }, scaleRatio: 100 },
  transformHandler: {
    resizeImageView: () => {},
    scaleAtPoint: () => {},
    moveFromTo: () => {},
    toCanvasConfig: () => ({ x: 0, y: 0, width: 0, height: 0, pixelRatio: 0 }),
    toStageProps: () => ({ x: 0, y: 0, scaleX: 0, scaleY: 0 })
  }
})

export const TransformProvider = ({ children }: { children: React.ReactNode }) => {
  const [imagePosition, setImagePosition] = useState({ x: 0, y: 0 })
  const [scaleRatio, setScaleRatio] = useState(100)

  const resizeImageView = (
    canvasWidth: number,
    canvasHeight: number,
    imageWidth: number,
    imageHeight: number
  ) => {
    const initRatio = Math.min(canvasWidth / imageWidth, canvasHeight / imageHeight)
    setScaleRatio(initRatio * 100)
    setImagePosition({
      x: (canvasWidth - imageWidth * initRatio) / 2,
      y: (canvasHeight - imageHeight * initRatio) / 2
    })
  }

  const scaleAtPoint = (point: Coord, ratioDelta: number) => {
    const oldScale = scaleRatio
    let newScale = scaleRatio

    if (ratioDelta < 0) {
      newScale = Math.min(500, scaleRatio + 10)
    } else {
      newScale = Math.max(25, scaleRatio - 10)
    }

    const mousePointTo = {
      x: (point.x - imagePosition.x * (oldScale / 100)) / (oldScale / 100),
      y: (point.y - imagePosition.y * (oldScale / 100)) / (oldScale / 100)
    }

    const newPos = {
      x: point.x - mousePointTo.x * (newScale / 100),
      y: point.y - mousePointTo.y * (newScale / 100)
    }

    setScaleRatio(newScale)
    setImagePosition({
      x: newPos.x / (newScale / 100),
      y: newPos.y / (newScale / 100)
    })
  }

  const moveFromTo = (from: Coord, to: Coord) => {
    const deltaX = to.x - from.x
    const deltaY = to.y - from.y
    setImagePosition({
      x: imagePosition.x + deltaX / (scaleRatio / 100),
      y: imagePosition.y + deltaY / (scaleRatio / 100)
    })
  }

  const toCanvasConfig = (imageWidth: number, imageHeight: number) => {
    return {
      x: imagePosition.x * (scaleRatio / 100),
      y: imagePosition.y * (scaleRatio / 100),
      width: imageWidth * (scaleRatio / 100),
      height: imageHeight * (scaleRatio / 100),
      pixelRatio: 100 / scaleRatio
    }
  }

  const toStageProps = () => {
    return {
      x: imagePosition.x * (scaleRatio / 100),
      y: imagePosition.y * (scaleRatio / 100),
      scaleX: scaleRatio / 100,
      scaleY: scaleRatio / 100
    }
  }

  const transformHandler = {
    resizeImageView,
    scaleAtPoint,
    moveFromTo,
    toCanvasConfig,
    toStageProps
  }

  return createElement(
    TransformContext.Provider,
    { value: { transform: { imagePosition, scaleRatio }, transformHandler } },
    children
  )
}

export const useTransform = () => {
  return useContext(TransformContext)
}
