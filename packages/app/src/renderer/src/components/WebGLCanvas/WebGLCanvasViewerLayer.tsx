import { Container, Sprite, Texture } from 'pixi.js'
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react'
import { useRequiredWebGLCanvasRuntime } from './WebGLCanvasContext'
import type { WebGLCanvasImageItem, WebGLCanvasImagePreview } from './webglCanvasTypes'

type WebGLCanvasViewerLayerProps = {
  items: WebGLCanvasImageItem[]
  stagePos?: { x: number; y: number }
  stageScale?: number
  onReadyChange?: (ready: boolean) => void
  onLoadedIdsChange?: (loadedIds: Set<string>) => void
}

type SpriteRecord = {
  sprite: Sprite
  image: HTMLImageElement
}

export type WebGLCanvasViewerLayerHandle = {
  syncItemPreview: (itemId: string, preview: WebGLCanvasImagePreview | null) => void
}

function buildSpriteTexture(item: WebGLCanvasImageItem): Texture {
  return Texture.from(item.image)
}

function applySpriteTransform(
  sprite: Sprite,
  item: WebGLCanvasImageItem | WebGLCanvasImagePreview
): void {
  sprite.position.set(item.x, item.y)
  sprite.scale.set(item.scaleX, item.scaleY)
  sprite.width = item.width
  sprite.height = item.height
  sprite.rotation = (item.rotation * Math.PI) / 180
}

const WebGLCanvasViewerLayer = forwardRef<
  WebGLCanvasViewerLayerHandle,
  WebGLCanvasViewerLayerProps
>(function WebGLCanvasViewerLayer(
  {
    items,
    stagePos: _stagePos,
    stageScale: _stageScale,
    onReadyChange,
    onLoadedIdsChange
  }: WebGLCanvasViewerLayerProps,
  ref
) {
  const runtime = useRequiredWebGLCanvasRuntime()
  const containerRef = useRef<Container | null>(null)
  const spriteRecordsRef = useRef(new Map<string, SpriteRecord>())
  const previewStateRef = useRef(new Map<string, WebGLCanvasImagePreview>())

  const upsertContainer = useCallback(() => {
    if (containerRef.current) {
      return containerRef.current
    }

    const container = new Container()
    container.sortableChildren = true
    runtime.world.addChild(container)
    containerRef.current = container
    return container
  }, [runtime.world])

  useEffect(() => {
    onReadyChange?.(runtime.state.ready)
  }, [onReadyChange, runtime.state.ready])

  useEffect(() => {
    const container = upsertContainer()
    const spriteRecords = spriteRecordsRef.current
    const nextIds = new Set(items.map((item) => item.id))

    spriteRecords.forEach((record, itemId) => {
      if (nextIds.has(itemId)) {
        return
      }
      record.sprite.removeFromParent()
      record.sprite.destroy()
      spriteRecords.delete(itemId)
    })

    items.forEach((item) => {
      const preview = previewStateRef.current.get(item.id)
      const transform = preview ?? item
      const existing = spriteRecords.get(item.id)
      const texture =
        existing && existing.image === item.image
          ? existing.sprite.texture
          : buildSpriteTexture(item)
      const sprite =
        existing && existing.image === item.image ? existing.sprite : Sprite.from(texture)

      if (!existing || existing.image !== item.image) {
        if (existing) {
          existing.sprite.removeFromParent()
          existing.sprite.destroy()
        }
        container.addChild(sprite)
        spriteRecords.set(item.id, { sprite, image: item.image })
      }

      sprite.zIndex = item.zIndex
      applySpriteTransform(sprite, transform)
    })

    runtime.app.render()
    onLoadedIdsChange?.(new Set(items.map((item) => item.id)))
  }, [items, onLoadedIdsChange, runtime.app, upsertContainer])

  useImperativeHandle(
    ref,
    () => ({
      syncItemPreview(itemId, preview) {
        const record = spriteRecordsRef.current.get(itemId)
        if (!record) {
          if (preview) {
            previewStateRef.current.set(itemId, preview)
          } else {
            previewStateRef.current.delete(itemId)
          }
          return
        }

        if (preview) {
          previewStateRef.current.set(itemId, preview)
          applySpriteTransform(record.sprite, preview)
        } else {
          previewStateRef.current.delete(itemId)
          const sourceItem = items.find((item) => item.id === itemId)
          if (sourceItem) {
            applySpriteTransform(record.sprite, sourceItem)
          }
        }

        runtime.app.render()
      }
    }),
    [items, runtime.app]
  )

  useEffect(
    () => () => {
      spriteRecordsRef.current.forEach((record) => {
        record.sprite.removeFromParent()
        record.sprite.destroy()
      })
      spriteRecordsRef.current.clear()
      previewStateRef.current.clear()
      containerRef.current?.removeFromParent()
      containerRef.current = null
    },
    []
  )

  return null
})

export default WebGLCanvasViewerLayer
