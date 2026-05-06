export type CanvasSyncDetail = {
  x: number
  y: number
  rotation: number
  scaleX: number
  scaleY: number
}

const pendingDetails = new Map<string, CanvasSyncDetail>()
let pendingFrame: number | null = null

function flushPendingCanvasSync() {
  pendingFrame = null
  const entries = Array.from(pendingDetails.entries())
  pendingDetails.clear()

  entries.forEach(([id, detail]) => {
    window.dispatchEvent(new CustomEvent(`canvas-sync-${id}`, { detail }))
  })
}

export function scheduleCanvasSync(id: string, detail: CanvasSyncDetail) {
  pendingDetails.set(id, detail)

  if (pendingFrame != null) return

  pendingFrame = window.requestAnimationFrame(flushPendingCanvasSync)
}

export function cancelCanvasSync(id: string) {
  pendingDetails.delete(id)
  if (pendingDetails.size === 0 && pendingFrame != null) {
    window.cancelAnimationFrame(pendingFrame)
    pendingFrame = null
  }
}
