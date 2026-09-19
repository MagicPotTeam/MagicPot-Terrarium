import { Container, Sprite, type Texture } from 'pixi.js'
import {
  buildCanvasSpatialTilePolicy,
  type CanvasSpatialTilePolicyDecision
} from './canvasSpatialTilePolicy'
import {
  buildCanvasSpatialTileRenderModel,
  type CanvasSpatialTileRenderModel
} from './canvasSpatialTileRenderModel'
import { CanvasSpatialTileResourceManager } from './canvasSpatialTileResourceManager'
import {
  CanvasSpatialTileScheduler,
  type CanvasSpatialTileSchedulerTask
} from './canvasSpatialTileScheduler'
import type { CanvasSpatialTileBrowserCropResult } from './canvasSpatialTileWorkerProtocol'
import type { CanvasSpatialTileRect } from './canvasSpatialTileTypes'
import type {
  ProjectCanvasInteractionProxy,
  ProjectCanvasRenderableTransform
} from './projectCanvasRenderBoundary'
import type { CanvasImageSourceIdentity } from './canvasThumbnailTypes'

export type CanvasSpatialTileTextureAllocation = {
  texture: Texture
  dispose: () => void
}

export type CanvasSpatialTileReconcileItemInput = {
  itemId: string
  zIndex: number
  interactionProxy: ProjectCanvasInteractionProxy
  transform: ProjectCanvasRenderableTransform
  sourceWidth: number
  sourceHeight: number
  crop?: CanvasSpatialTileRect
  sourceIdentity: CanvasImageSourceIdentity
  source: Blob
  policyInput: Omit<Parameters<typeof buildCanvasSpatialTilePolicy>[0], 'sourceIdentity' | 'source'>
  policy?: CanvasSpatialTilePolicyDecision
}

export type CanvasSpatialTileReconcileResult = {
  policy: CanvasSpatialTilePolicyDecision
  renderModel: CanvasSpatialTileRenderModel | null
  ready: boolean
  presentation: Container | null
  textures: Texture[]
  textureBytes: number
}

export type CanvasSpatialTileReconcileOptions = {
  world: Container
  scheduler: CanvasSpatialTileScheduler
  resourceManager: CanvasSpatialTileResourceManager
  createTexture: (
    result: CanvasSpatialTileBrowserCropResult
  ) => Promise<CanvasSpatialTileTextureAllocation>
  itemRuntimeKey: string
  generation: number
  signal?: AbortSignal
  onPresentationDispose?: () => void
  onPresentationCommit?: (input: { tileCount: number; textureBytes: number }) => boolean | void
  onTextureAllocationStart?: (bytes: number, tileIndex: number) => boolean
  onTextureAllocationComplete?: (bytes: number, tileIndex: number) => void
}

const abortError = () => new DOMException('Spatial tile presentation cancelled.', 'AbortError')

/**
 * Opt-in integration seam: policy tasks are scheduled first, all visible tile
 * textures are assembled off-screen, and only the complete container is
 * committed to the resource manager. The caller performs the final world swap
 * so the ordinary sprite path remains the fallback.
 */
export async function reconcileCanvasSpatialTiles(
  input: CanvasSpatialTileReconcileItemInput,
  options: CanvasSpatialTileReconcileOptions
): Promise<CanvasSpatialTileReconcileResult> {
  const policy =
    input.policy ??
    buildCanvasSpatialTilePolicy({
      ...input.policyInput,
      sourceIdentity: input.sourceIdentity,
      source: input.source
    })
  if (!policy.enabled || !policy.descriptor) {
    return {
      policy,
      renderModel: null,
      ready: false,
      presentation: null,
      textures: [],
      textureBytes: 0
    }
  }
  if (options.signal?.aborted) throw abortError()

  const resourceRequest = options.resourceManager.begin({
    tileKey: options.itemRuntimeKey,
    sourceKey: input.sourceIdentity.cacheKey,
    level: policy.level ?? 0,
    config: `${policy.descriptor.tileSize}:${policy.descriptor.gutter}`,
    generation: options.generation
  })
  const results = new Map<string, CanvasSpatialTileBrowserCropResult>()
  try {
    await Promise.all(
      policy.tasks.map(async (task) => {
        if (options.signal?.aborted) throw abortError()
        const result = await options.scheduler.schedule({
          ...task,
          generation: options.generation,
          scopeKey: options.itemRuntimeKey,
          signal: options.signal,
          isGenerationCurrent: () => options.resourceManager.isCurrent(resourceRequest)
        } as CanvasSpatialTileSchedulerTask)
        results.set(task.tileKey, result)
      })
    )
    if (options.signal?.aborted) throw abortError()
    if (!options.resourceManager.isCurrent(resourceRequest)) {
      return {
        policy,
        renderModel: null,
        ready: false,
        presentation: null,
        textures: [],
        textureBytes: 0
      }
    }

    const presentation = new Container()
    presentation.label = `${input.itemId}:spatial-tiles`
    const allocations: CanvasSpatialTileTextureAllocation[] = []
    let resourceCommitted = false
    try {
      const crop = input.crop ?? {
        x: 0,
        y: 0,
        width: input.sourceWidth,
        height: input.sourceHeight
      }
      for (const [tileIndex, tile] of policy.visibleTiles.entries()) {
        const result = results.get(tile.key)
        if (!result) throw new Error(`Visible spatial tile is not ready: ${tile.key}`)
        const textureBytes = Math.max(1, result.width) * Math.max(1, result.height) * 4
        if (
          options.onTextureAllocationStart &&
          !options.onTextureAllocationStart(textureBytes, tileIndex)
        ) {
          throw new Error('Spatial tile GPU upload budget denied.')
        }
        let allocation: CanvasSpatialTileTextureAllocation
        try {
          allocation = await options.createTexture(result)
        } finally {
          options.onTextureAllocationComplete?.(textureBytes, tileIndex)
        }
        allocations.push(allocation)
        const sprite = new Sprite(allocation.texture)
        sprite.position.set(
          tile.geometry.originalSourceRect.x - crop.x,
          tile.geometry.originalSourceRect.y - crop.y
        )
        sprite.width = tile.geometry.originalSourceRect.width
        sprite.height = tile.geometry.originalSourceRect.height
        presentation.addChild(sprite)
      }

      presentation.position.set(input.transform.x, input.transform.y)
      presentation.rotation = input.transform.rotation
      presentation.scale.set(
        (input.transform.width / crop.width) * input.transform.scaleX,
        (input.transform.height / crop.height) * input.transform.scaleY
      )
      presentation.zIndex = input.zIndex

      const textures = allocations.map(({ texture }) => texture)
      const textureBytes = policy.visibleTiles.reduce((total, tile) => {
        const result = results.get(tile.key)
        return total + (result ? Math.max(1, result.width) * Math.max(1, result.height) * 4 : 0)
      }, 0)
      const committed = options.resourceManager.commit(resourceRequest, {
        value: presentation,
        ownership: 'owned',
        disposables: [
          ...allocations.map(({ dispose }) => dispose),
          () => {
            options.onPresentationDispose?.()
            presentation.removeFromParent()
            presentation.destroy({ children: true })
          }
        ]
      })
      if (!committed) {
        // commit() owns stale-asset disposal when the generation is no longer current.
        return {
          policy,
          renderModel: null,
          ready: false,
          presentation: null,
          textures: [],
          textureBytes: 0
        }
      }
      resourceCommitted = true
      const canPresent =
        options.onPresentationCommit?.({
          tileCount: policy.visibleTiles.length,
          textureBytes
        }) !== false
      if (!canPresent) {
        options.resourceManager.invalidateTile(options.itemRuntimeKey, options.generation)
        return {
          policy,
          renderModel: null,
          ready: false,
          presentation: null,
          textures: [],
          textureBytes: 0
        }
      }
      options.world.addChild(presentation)

      const firstTile = policy.visibleTiles[0]
      const renderModel = firstTile
        ? buildCanvasSpatialTileRenderModel({
            mode: 'tiles',
            itemId: input.itemId,
            zIndex: input.zIndex,
            interactionProxy: input.interactionProxy,
            transform: input.transform,
            sourceWidth: input.sourceWidth,
            sourceHeight: input.sourceHeight,
            crop,
            tileKey: firstTile.key,
            geometry: firstTile.geometry
          })
        : null
      if (!renderModel) {
        options.resourceManager.invalidateTile(options.itemRuntimeKey, options.generation)
        return {
          policy,
          renderModel: null,
          ready: false,
          presentation: null,
          textures: [],
          textureBytes: 0
        }
      }
      return { policy, renderModel, ready: true, presentation, textures, textureBytes }
    } catch (error) {
      if (resourceCommitted) {
        options.resourceManager.invalidateTile(options.itemRuntimeKey, options.generation)
      } else {
        allocations.forEach(({ dispose }) => dispose())
        presentation.destroy({ children: true })
      }
      throw error
    }
  } catch (error) {
    if (options.signal?.aborted || (error as { name?: unknown } | null)?.name === 'AbortError') {
      options.resourceManager.invalidateTile(options.itemRuntimeKey, options.generation)
      throw abortError()
    }
    throw error
  }
}
