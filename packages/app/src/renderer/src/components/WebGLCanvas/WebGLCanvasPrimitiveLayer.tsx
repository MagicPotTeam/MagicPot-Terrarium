import { Container, Graphics } from 'pixi.js'
import React, { useEffect, useMemo, useRef } from 'react'
import { useRequiredWebGLCanvasRuntime } from './WebGLCanvasContext'
import type { WebGLCanvasPrimitive } from './webglCanvasTypes'

type WebGLCanvasPrimitiveLayerProps = {
  primitives: WebGLCanvasPrimitive[]
  role: 'editor' | 'mask'
}

function drawPrimitive(
  graphics: Graphics,
  primitive: WebGLCanvasPrimitive,
  role: 'editor' | 'mask'
) {
  const fillAlpha = primitive.alpha ?? (role === 'mask' ? 0.18 : 0.1)
  const strokeWidth = primitive.strokeWidth ?? 1.5

  graphics.position.set(primitive.x, primitive.y)
  graphics.scale.set(1)
  graphics.rotation = (primitive.rotation ?? 0) * (Math.PI / 180)
  graphics.alpha = primitive.alpha ?? 1

  const fillStyle = primitive.fill ? { color: primitive.fill, alpha: fillAlpha } : null
  const strokeStyle = primitive.stroke
    ? { color: primitive.stroke, alpha: 1, width: strokeWidth }
    : null

  switch (primitive.kind) {
    case 'rect':
      graphics.rect(0, 0, primitive.width, primitive.height)
      if (fillStyle) {
        graphics.fill(fillStyle)
      }
      if (strokeStyle) {
        graphics.stroke(strokeStyle)
      }
      break
    case 'ellipse':
      graphics.ellipse(
        primitive.width / 2,
        primitive.height / 2,
        primitive.width / 2,
        primitive.height / 2
      )
      if (fillStyle) {
        graphics.fill(fillStyle)
      }
      if (strokeStyle) {
        graphics.stroke(strokeStyle)
      }
      break
    case 'line':
      graphics.moveTo(0, 0)
      graphics.lineTo(primitive.width, primitive.height)
      if (strokeStyle) {
        graphics.stroke(strokeStyle)
      }
      break
    case 'polygon': {
      const points = primitive.points ?? []
      if (points.length > 0) {
        graphics.moveTo(points[0].x, points[0].y)
        for (let index = 1; index < points.length; index += 1) {
          graphics.lineTo(points[index].x, points[index].y)
        }
        if (primitive.closed !== false) {
          graphics.closePath()
        }
        if (fillStyle) {
          graphics.fill(fillStyle)
        }
        if (strokeStyle) {
          graphics.stroke(strokeStyle)
        }
      }
      break
    }
  }
}

export default function WebGLCanvasPrimitiveLayer({
  primitives,
  role
}: WebGLCanvasPrimitiveLayerProps) {
  const runtime = useRequiredWebGLCanvasRuntime()
  const containerRef = useRef<Container | null>(null)

  const sortedPrimitives = useMemo(
    () => [...primitives].sort((left, right) => (left.zIndex ?? 0) - (right.zIndex ?? 0)),
    [primitives]
  )

  useEffect(() => {
    if (!containerRef.current) {
      const container = new Container()
      container.sortableChildren = true
      runtime.world.addChild(container)
      containerRef.current = container
    }

    const container = containerRef.current
    if (!container) {
      return
    }

    container.removeChildren()

    sortedPrimitives.forEach((primitive) => {
      const graphics = new Graphics()
      graphics.zIndex = primitive.zIndex ?? 0
      drawPrimitive(graphics, primitive, role)
      container.addChild(graphics)
    })

    runtime.app.render()
  }, [role, runtime.app, runtime.world, sortedPrimitives])

  useEffect(
    () => () => {
      containerRef.current?.removeFromParent()
      containerRef.current = null
    },
    []
  )

  return null
}
