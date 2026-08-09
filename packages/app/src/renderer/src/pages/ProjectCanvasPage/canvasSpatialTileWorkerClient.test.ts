import { describe, expect, it, vi } from 'vitest'
import { CanvasSpatialTileWorkerClient } from './canvasSpatialTileWorkerClient'
import type { CanvasSpatialTileBrowserCropResult } from './canvasSpatialTileWorkerProtocol'

const geometry = {
  address: { level: 1, x: 0, y: 0 },
  decodeRect: { x: 0, y: 0, width: 4, height: 4 },
  levelRect: { x: 1, y: 1, width: 2, height: 2 },
  originalSourceRect: { x: 2, y: 2, width: 4, height: 4 },
  contentOffset: { x: 1, y: 1 }
}
const request = {
  source: new Blob(['source']),
  descriptor: { sourceWidth: 8, sourceHeight: 8 },
  geometry,
  scaleDenominator: 2,
  preferWebp: false,
  key: 'tile'
}
const response: CanvasSpatialTileBrowserCropResult = {
  blob: new Blob(['tile']),
  mimeType: 'image/png',
  width: 4,
  height: 4,
  contentRectInBitmap: { x: 1, y: 1, width: 2, height: 2 },
  geometry
}

describe('CanvasSpatialTileWorkerClient', () => {
  it('passes scale and geometry through the mock Worker and dedupes keys', async () => {
    const listeners = new Map<string, (event: MessageEvent<any>) => void>()
    const worker = {
      postMessage: vi.fn((message: any) =>
        queueMicrotask(() =>
          listeners.get('message')?.({
            data: { type: 'success', requestId: message.requestId, result: response }
          } as MessageEvent)
        )
      ),
      addEventListener: vi.fn((type: string, fn: any) => listeners.set(type, fn)),
      removeEventListener: vi.fn(),
      terminate: vi.fn()
    } as unknown as Worker
    const client = new CanvasSpatialTileWorkerClient({ createWorker: () => worker })
    const first = client.generate(request)
    const duplicate = client.generate(request)
    expect(duplicate).toBe(first)
    await first
    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ scaleDenominator: 2, geometry })
    )
    await expect(first).resolves.toMatchObject({
      contentRectInBitmap: response.contentRectInBitmap,
      geometry
    })
    client.dispose()
  })

  it('dispose rejects pending Worker requests', async () => {
    const worker = {
      postMessage: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      terminate: vi.fn()
    } as unknown as Worker
    const client = new CanvasSpatialTileWorkerClient({ createWorker: () => worker })
    const pending = client.generate({ ...request, key: 'pending' })
    const observed = pending.catch((error) => error)
    client.dispose()
    await expect(observed).resolves.toMatchObject({
      message: 'Spatial tile worker client disposed.'
    })
  })
})
