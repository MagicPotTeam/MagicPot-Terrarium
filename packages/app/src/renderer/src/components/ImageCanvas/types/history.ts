export type PenShape = 'round' | 'square'

export type HistoryLine = {
  tool: string
  width: number
  shape: PenShape
  points: number[] // [x1, y1, x2, y2, ...]
}

export type History = {
  top: number // top == lines.length if no undo
  lines: HistoryLine[] // available lines: [0, top)
}

export interface HistoryHandler {
  pushHistory: (tool: string, width: number, shape: PenShape, pos: { x: number; y: number }) => void
  updateHistory: (point: { x: number; y: number }) => void
  undoHistory: () => void
  redoHistory: () => void
  clearHistory: () => void
  topLine: () => HistoryLine
  validLines: () => HistoryLine[]
}

export type HistoryActionProps = {}
