import { HistoryHandler, HistoryLine } from './history'
import { TransformHandler } from './transform'

export type Coord = { x: number; y: number }

export type ToolValue = 'pen' | 'eraser' | 'hand'

export type MouseDownCtx = {
  pos: Coord
  relativePos: Coord
}

export type MouseMoveCtx = {
  pos: Coord
  relativePos: Coord
}

export type ToolRef = {
  id: string
  value: ToolValue
  mouseUpCursor: string
  mouseDownCursor: string
  handleMouseDown: (ctx: MouseDownCtx) => void
  handleMouseMove: (ctx: MouseMoveCtx) => void
  handleMouseUp: () => void
  renderLine: (line: HistoryLine, index: number) => React.ReactNode
}

export type ToolProps = {
  ref: React.Ref<ToolRef>
}

// Tool, Icon, ToolValue
export type ToolInfo = {
  Tool: React.FC<ToolProps>
  Icon: React.ComponentType
  key: ToolValue
}
