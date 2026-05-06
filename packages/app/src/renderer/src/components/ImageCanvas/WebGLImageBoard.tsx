import { Box } from '@mui/material'
import { Application, Container, Sprite } from 'pixi.js'
import React, { useEffect, useMemo, useRef, useState } from 'react'

export type WebGLImageBoardItem = {
  id: string
  image: HTMLImageElement
  x: number
  y: number
  width: number
  height: number
}

type WebGLImageBoardProps = {
  image?: HTMLImageElement
  items?: WebGLImageBoardItem[]
  allowItemDrag?: boolean
}

type SpriteRecord = {
  sprite: Sprite
  image: HTMLImageElement
}

export default function WebGLImageBoard({
  image,
  items,
  allowItemDrag = false
}: WebGLImageBoardProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const appRef = useRef<Application | null>(null)
  const worldRef = useRef<Container | null>(null)
  const spriteRecordsRef = useRef(new Map<string, SpriteRecord>())
  const [isInitialized, setIsInitialized] = useState(false)

  const renderItems = useMemo<WebGLImageBoardItem[]>(
    () =>
      items ??
      (image
        ? [
            {
              id: 'image',
              image,
              x: 0,
              y: 0,
              width: image.naturalWidth || image.width,
              height: image.naturalHeight || image.height
            }
          ]
        : []),
    [image, items]
  )

  useEffect(() => {
    const host = hostRef.current
    if (!host) {
      return
    }

    let disposed = false
    const spriteRecords = spriteRecordsRef.current

    const initialize = async () => {
      const app = new Application()
      await app.init({
        resizeTo: host,
        backgroundAlpha: 0,
        antialias: true,
        autoDensity: true,
        autoStart: false,
        sharedTicker: false,
        preference: 'webgl',
        powerPreference: 'high-performance'
      })

      if (disposed) {
        app.destroy(true, { children: true })
        return
      }

      const world = new Container()
      world.sortableChildren = true
      app.stage.addChild(world)
      appRef.current = app
      worldRef.current = world
      host.replaceChildren(app.canvas as HTMLCanvasElement)
      setIsInitialized(true)
      app.render()
    }

    void initialize()

    return () => {
      disposed = true
      spriteRecords.forEach((record) => {
        record.sprite.removeFromParent()
        record.sprite.destroy()
      })
      spriteRecords.clear()
      worldRef.current = null
      if (appRef.current) {
        appRef.current.destroy(true, { children: true })
        appRef.current = null
      }
      host.replaceChildren()
    }
  }, [])

  useEffect(() => {
    const world = worldRef.current
    const app = appRef.current
    if (!world || !app || !isInitialized) {
      return
    }

    const nextIds = new Set(renderItems.map((item) => item.id))
    spriteRecordsRef.current.forEach((record, itemId) => {
      if (nextIds.has(itemId)) {
        return
      }
      record.sprite.removeFromParent()
      record.sprite.destroy()
      spriteRecordsRef.current.delete(itemId)
    })

    renderItems.forEach((item) => {
      const existing = spriteRecordsRef.current.get(item.id)
      const sprite =
        existing && existing.image === item.image ? existing.sprite : Sprite.from(item.image)

      if (!existing || existing.image !== item.image) {
        if (existing) {
          existing.sprite.removeFromParent()
          existing.sprite.destroy()
        }
        world.addChild(sprite)
        spriteRecordsRef.current.set(item.id, { sprite, image: item.image })
      }

      sprite.position.set(item.x, item.y)
      sprite.width = item.width
      sprite.height = item.height
      sprite.eventMode = allowItemDrag ? 'static' : 'none'
      sprite.cursor = allowItemDrag ? 'move' : 'default'
    })

    app.render()
  }, [allowItemDrag, isInitialized, renderItems])

  return (
    <Box
      ref={hostRef}
      sx={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        pointerEvents: 'none'
      }}
    />
  )
}
