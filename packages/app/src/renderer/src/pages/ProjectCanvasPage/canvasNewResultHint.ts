export const CANVAS_NEW_RESULT_HINT_EVENT = 'canvas:new-result-hint'

export type CanvasNewResultHintDetail = {
  itemId: string
  canvasId?: string
  generationSessionId?: string
  source: 'quickapp'
}
