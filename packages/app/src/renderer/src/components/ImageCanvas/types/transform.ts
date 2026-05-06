import { Coord } from './tools'

export type Transform = {
  imagePosition: Coord
  scaleRatio: number
}

export interface TransformHandler {
  resizeImageView: (
    canvasWidth: number,
    canvasHeight: number,
    imageWidth: number,
    imageHeight: number
  ) => void
  scaleAtPoint: (point: Coord, ratioDelta: number) => void
  moveFromTo: (from: Coord, to: Coord) => void
  toCanvasConfig: (
    imageWidth: number,
    imageHeight: number
  ) => {
    x: number
    y: number
    width: number
    height: number
    pixelRatio: number
  }
  toStageProps: () => {
    x: number
    y: number
    scaleX: number
    scaleY: number
  }
}
