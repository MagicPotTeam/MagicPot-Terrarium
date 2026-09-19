import { Container, Texture } from 'pixi.js'
import { describe, expect, it, vi } from 'vitest'
import { CanvasSpatialTileResourceManager } from './canvasSpatialTileResourceManager'
import { CanvasSpatialTileScheduler } from './canvasSpatialTileScheduler'
import { reconcileCanvasSpatialTiles } from './canvasSpatialTileReconcile'
import type { CanvasImageSourceIdentity } from './canvasThumbnailTypes'

const sourceIdentity: CanvasImageSourceIdentity = {
  version: 1,
  kind: 'session-blob',
  sourceKey: 'session:giant',
  sizeBytes: 10,
  mimeType: 'image/png',
  cacheKey: 'session:giant'
}

function baseInput() {
  return {
    itemId: 'giant-1',
    zIndex: 3,
    interactionProxy: 'canvas-image-node' as const,
    transform: { x: 0, y: 0, width: 8192, height: 8192, scaleX: 1, scaleY: 1, rotation: 0 },
    sourceWidth: 8192,
    sourceHeight: 8192,
    sourceIdentity,
    source: new Blob(['source'], { type: 'image/png' }),
    policyInput: {
      sourceWidth: 8192,
      sourceHeight: 8192,
      crop: { x: 0, y: 0, width: 8192, height: 8192 },
      item: { x: 0, y: 0, width: 8192, height: 8192, scaleX: 1, scaleY: 1, rotation: 0 },
      stageScale: 1,
      stagePos: { x: 0, y: 0 },
      deviceScale: 1,
      viewport: { x: 0, y: 0, width: 512, height: 512 },
      visible: true,
      tileSize: 512,
      gutter: 2,
      levels: [0]
    }
  }
}

describe('reconcileCanvasSpatialTiles', () => {
  it('leaves ordinary ineligible images on the fallback path', async () => {
    const input = baseInput()
    const result = await reconcileCanvasSpatialTiles(
      {
        ...input,
        sourceWidth: 1024,
        sourceHeight: 1024,
        policyInput: { ...input.policyInput, sourceWidth: 1024, sourceHeight: 1024 }
      },
      {
        world: new Container(),
        scheduler: new CanvasSpatialTileScheduler({ generate: vi.fn() }),
        resourceManager: new CanvasSpatialTileResourceManager(),
        createTexture: async () => ({ texture: Texture.EMPTY, dispose: vi.fn() }),
        itemRuntimeKey: 'item:1',
        generation: 1
      }
    )
    expect(result.policy.enabled).toBe(false)
    expect(result.ready).toBe(false)
  })

  it('admits and releases each tile GPU upload reservation around texture allocation', async () => {
    const input = baseInput()
    const world = new Container()
    const uploadBytes: Array<[number, number]> = []
    const completedBytes: Array<[number, number]> = []
    const generate = vi.fn(async (task: any) => ({
      blob: new Blob(['tile']),
      mimeType: 'image/png' as const,
      width: task.geometry.decodeRect.width,
      height: task.geometry.decodeRect.height,
      contentRectInBitmap: task.geometry.levelRect,
      geometry: task.geometry
    }))
    await reconcileCanvasSpatialTiles(input, {
      world,
      scheduler: new CanvasSpatialTileScheduler({ generate }),
      resourceManager: new CanvasSpatialTileResourceManager(),
      createTexture: async (result) => ({ texture: Texture.EMPTY, dispose: vi.fn(), result }),
      itemRuntimeKey: 'item:upload',
      generation: 1,
      onTextureAllocationStart: (bytes, tileIndex) => {
        uploadBytes.push([bytes, tileIndex])
        return true
      },
      onTextureAllocationComplete: (bytes, tileIndex) => completedBytes.push([bytes, tileIndex])
    })
    expect(uploadBytes.length).toBeGreaterThan(0)
    expect(completedBytes).toEqual(uploadBytes)
  })

  it('rejects a tile when the upload budget hook denies allocation and leaves no presentation', async () => {
    const input = baseInput()
    const world = new Container()
    const resourceManager = new CanvasSpatialTileResourceManager()
    await expect(
      reconcileCanvasSpatialTiles(input, {
        world,
        scheduler: new CanvasSpatialTileScheduler({
          generate: async (task: any) => ({
            blob: new Blob(['tile']),
            mimeType: 'image/png' as const,
            width: task.geometry.decodeRect.width,
            height: task.geometry.decodeRect.height,
            contentRectInBitmap: task.geometry.levelRect,
            geometry: task.geometry
          })
        }),
        resourceManager,
        createTexture: async () => ({ texture: Texture.EMPTY, dispose: vi.fn() }),
        itemRuntimeKey: 'item:denied',
        generation: 1,
        onTextureAllocationStart: () => false
      })
    ).rejects.toThrow('GPU upload budget denied')
    expect(world.children).toHaveLength(0)
    expect(resourceManager.getMetricsSnapshot().activeAssetCount).toBe(0)
  })

  it('attaches one complete presentation after all visible tiles are ready', async () => {
    const input = baseInput()
    const world = new Container()
    const generate = vi.fn(async (task: any) => ({
      blob: new Blob(['tile']),
      mimeType: 'image/png' as const,
      width: task.geometry.decodeRect.width,
      height: task.geometry.decodeRect.height,
      contentRectInBitmap: task.geometry.levelRect,
      geometry: task.geometry
    }))
    const result = await reconcileCanvasSpatialTiles(input, {
      world,
      scheduler: new CanvasSpatialTileScheduler({ generate }),
      resourceManager: new CanvasSpatialTileResourceManager(),
      createTexture: async () => ({ texture: Texture.EMPTY, dispose: vi.fn() }),
      itemRuntimeKey: 'item:giant',
      generation: 1
    })
    expect(result.policy).toEqual(expect.objectContaining({ enabled: true, reason: 'eligible' }))
    expect(result.ready).toBe(true)
    expect(result.presentation).not.toBeNull()
    expect(world.children).toHaveLength(1)
    expect(generate).toHaveBeenCalledTimes(result.policy.tasks.length)
    result.presentation?.removeFromParent()
    result.presentation?.destroy({ children: true })
  })
})
