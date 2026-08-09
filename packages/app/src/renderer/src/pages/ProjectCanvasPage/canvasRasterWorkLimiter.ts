type QueuedCanvasRasterWork = () => void

const canvasRasterWorkQueue: QueuedCanvasRasterWork[] = []
let canvasRasterWorkActive = false

function runNextCanvasRasterWork(): void {
  if (canvasRasterWorkActive) return

  const next = canvasRasterWorkQueue.shift()
  if (!next) return

  canvasRasterWorkActive = true
  next()
}

export function runWithCanvasRasterWorkLimit<T>(work: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    canvasRasterWorkQueue.push(() => {
      void Promise.resolve()
        .then(work)
        .then(resolve, reject)
        .finally(() => {
          canvasRasterWorkActive = false
          runNextCanvasRasterWork()
        })
    })
    runNextCanvasRasterWork()
  })
}
