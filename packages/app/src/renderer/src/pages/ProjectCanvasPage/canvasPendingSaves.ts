// packages/app/src/renderer/src/pages/ProjectCanvasPage/canvasPendingSaves.ts
// The canvas page's save run per canvas (a run can make several saves: a
// metadata-only attempt, then a full save, then a save of what changed
// meanwhile). Anything that loads a board in order to write it back waits for
// that run first, so it never writes a snapshot older than the run's result.

const pendingCanvasSaveById = new Map<string, Promise<void>>()

export function rememberPendingCanvasSave(canvasId: string, promise: Promise<void>): void {
  pendingCanvasSaveById.set(canvasId, promise)
  void promise
    .finally(() => {
      if (pendingCanvasSaveById.get(canvasId) === promise) {
        pendingCanvasSaveById.delete(canvasId)
      }
    })
    .catch(() => {
      // waitForPendingCanvasSave handles the original promise; this only consumes finally().
    })
}

/** Resolves once the save run of this canvas in flight (if any) has finished, successful or not. */
export async function waitForPendingCanvasSave(canvasId: string): Promise<void> {
  // A run can be replaced by the next one while it is awaited: wait for that one too.
  for (;;) {
    const pendingSave = pendingCanvasSaveById.get(canvasId)
    if (!pendingSave) return
    try {
      await pendingSave
    } catch {
      // saveCanvasItems normalizes failures internally; keep restore best-effort if that changes.
    }
    if (pendingCanvasSaveById.get(canvasId) === pendingSave) return
  }
}
