import { generateCanvasSpatialTileBrowserCrop } from './canvasSpatialTileBrowserCrop.worker'
import type {
  CanvasSpatialTileBrowserCropMessage,
  CanvasSpatialTileBrowserCropRequest,
  CanvasSpatialTileBrowserCropResult,
  CanvasSpatialTileWorkerMessage
} from './canvasSpatialTileWorkerProtocol'

export type CanvasSpatialTileRequest = CanvasSpatialTileBrowserCropRequest & { key?: string }
export type CanvasSpatialTileResult = CanvasSpatialTileBrowserCropResult & { key?: string }

export type CanvasSpatialTileWorkerClientOptions = {
  createWorker?: () => Worker | null
}

type PendingRequest = {
  resolve: (result: CanvasSpatialTileResult) => void
  reject: (error: unknown) => void
  key?: string
}

function createDefaultWorker(): Worker | null {
  if (typeof Worker !== 'function') return null
  try {
    return new Worker(new URL('./canvasSpatialTileBrowserCrop.worker.ts', import.meta.url), {
      type: 'module'
    })
  } catch {
    return null
  }
}

function createRequestId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`
}

/** Independent browser-crop client; this is not the canvas thumbnail worker pool. */
export class CanvasSpatialTileWorkerClient {
  private readonly createWorker: () => Worker | null
  private worker: Worker | null = null
  private readonly pending = new Map<string, PendingRequest>()
  private readonly inFlightByKey = new Map<string, Promise<CanvasSpatialTileResult>>()

  constructor(options: CanvasSpatialTileWorkerClientOptions = {}) {
    this.createWorker = options.createWorker ?? createDefaultWorker
  }

  generate(request: CanvasSpatialTileRequest): Promise<CanvasSpatialTileResult> {
    if (request.key) {
      const existing = this.inFlightByKey.get(request.key)
      if (existing) return existing
    }

    const promise = this.dispatch(request)
    if (request.key) {
      this.inFlightByKey.set(request.key, promise)
      void promise.then(
        () => {
          if (this.inFlightByKey.get(request.key!) === promise)
            this.inFlightByKey.delete(request.key!)
        },
        () => {
          if (this.inFlightByKey.get(request.key!) === promise)
            this.inFlightByKey.delete(request.key!)
        }
      )
    }
    return promise
  }

  /** Single-task backend entrypoint. Batch is a convenience only, not a scheduler. */
  /** @deprecated Use generate for single-task execution or an injected scheduler. */
  generateBatch(requests: readonly CanvasSpatialTileRequest[]): Promise<CanvasSpatialTileResult[]> {
    return Promise.all(requests.map((request) => this.generate(request)))
  }

  dispose(): void {
    const error = new Error('Spatial tile worker client disposed.')
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    this.worker?.removeEventListener('message', this.onMessage)
    this.worker?.removeEventListener('error', this.onError)
    this.worker?.terminate()
    this.worker = null
    this.inFlightByKey.clear()
  }

  private dispatch(request: CanvasSpatialTileRequest): Promise<CanvasSpatialTileResult> {
    const worker = this.ensureWorker()
    if (!worker) {
      return generateCanvasSpatialTileBrowserCrop({
        source: request.source,
        descriptor: request.descriptor,
        geometry: request.geometry,
        scaleDenominator: request.scaleDenominator,
        preferWebp: request.preferWebp ?? true
      }).then((result) => ({ ...result, ...(request.key ? { key: request.key } : {}) }))
    }

    const requestId = createRequestId()
    const message: CanvasSpatialTileBrowserCropMessage = {
      type: 'generate-browser-crop',
      requestId,
      source: request.source,
      sourceWidth: request.descriptor.sourceWidth,
      sourceHeight: request.descriptor.sourceHeight,
      geometry: request.geometry,
      scaleDenominator: request.scaleDenominator,
      preferWebp: request.preferWebp ?? true
    }
    return new Promise<CanvasSpatialTileResult>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve,
        reject,
        ...(request.key ? { key: request.key } : {})
      })
      try {
        worker.postMessage(message)
      } catch (error) {
        this.pending.delete(requestId)
        reject(error)
      }
    })
  }

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker
    const worker = this.createWorker()
    if (!worker) return null
    worker.addEventListener('message', this.onMessage)
    worker.addEventListener('error', this.onError)
    this.worker = worker
    return worker
  }

  private onMessage = (event: MessageEvent<CanvasSpatialTileWorkerMessage>): void => {
    const message = event.data
    const pending = this.pending.get(message?.requestId)
    if (!pending) return
    this.pending.delete(message.requestId)
    if (message.type === 'error') {
      pending.reject(new Error(message.error))
      return
    }
    pending.resolve({ ...message.result, ...(pending.key ? { key: pending.key } : {}) })
  }

  private onError = (event: Event): void => {
    const error = new Error('Spatial tile worker failed.')
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    const worker = this.worker
    this.worker = null
    worker?.removeEventListener('message', this.onMessage)
    worker?.removeEventListener('error', this.onError)
    worker?.terminate()
    void event
  }
}

export function createCanvasSpatialTileWorkerClient(
  options?: CanvasSpatialTileWorkerClientOptions
): CanvasSpatialTileWorkerClient {
  return new CanvasSpatialTileWorkerClient(options)
}
