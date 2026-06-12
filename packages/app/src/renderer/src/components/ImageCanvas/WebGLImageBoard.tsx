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

type ContentBounds = {
  minX: number
  minY: number
  width: number
  height: number
}

const IMAGE_BOARD_FIT_PADDING = 24

function getBoardHostSize(host: HTMLDivElement) {
  const rect = host.getBoundingClientRect()
  const width = rect.width || host.clientWidth
  const height = rect.height || host.clientHeight

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null
  }

  return { width, height }
}

function getContentBounds(items: WebGLImageBoardItem[]): ContentBounds | null {
  if (items.length === 0) {
    return null
  }

  const minX = Math.min(...items.map((item) => item.x))
  const minY = Math.min(...items.map((item) => item.y))
  const maxX = Math.max(...items.map((item) => item.x + item.width))
  const maxY = Math.max(...items.map((item) => item.y + item.height))
  const width = maxX - minX
  const height = maxY - minY

  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null
  }

  return { minX, minY, width, height }
}

function fitWorldToHost(world: Container, items: WebGLImageBoardItem[], host: HTMLDivElement) {
  const hostSize = getBoardHostSize(host)
  const contentBounds = getContentBounds(items)

  if (!hostSize || !contentBounds) {
    world.position.set(0, 0)
    world.scale.set(1, 1)
    return
  }

  const padding = Math.min(IMAGE_BOARD_FIT_PADDING, hostSize.width / 4, hostSize.height / 4)
  const availableWidth = Math.max(1, hostSize.width - padding * 2)
  const availableHeight = Math.max(1, hostSize.height - padding * 2)
  const scale = Math.min(
    1,
    availableWidth / contentBounds.width,
    availableHeight / contentBounds.height
  )
  const renderedWidth = contentBounds.width * scale
  const renderedHeight = contentBounds.height * scale
  const x = (hostSize.width - renderedWidth) / 2 - contentBounds.minX * scale
  const y = (hostSize.height - renderedHeight) / 2 - contentBounds.minY * scale

  world.scale.set(scale, scale)
  world.position.set(x, y)
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

    const host = hostRef.current
    if (host) {
      fitWorldToHost(world, renderItems, host)
    }

    app.render()
  }, [allowItemDrag, isInitialized, renderItems])

  useEffect(() => {
    const host = hostRef.current
    const world = worldRef.current
    const app = appRef.current
    if (!host || !world || !app || !isInitialized) {
      return
    }

    const updateLayout = () => {
      fitWorldToHost(world, renderItems, host)
      app.render()
    }

    updateLayout()

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateLayout)
      return () => window.removeEventListener('resize', updateLayout)
    }

    const observer = new ResizeObserver(updateLayout)
    observer.observe(host)
    window.addEventListener('resize', updateLayout)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateLayout)
    }
  }, [isInitialized, renderItems])

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
