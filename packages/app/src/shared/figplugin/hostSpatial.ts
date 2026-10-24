import { z } from 'zod'

// Observations, not layout commands or a restorable document snapshot. Never coerce units.
const coordinate = z.number().finite().min(-10_000_000).max(10_000_000)
const extent = z.number().finite().min(0).max(10_000_000)
const unavailable = z.object({ status: z.literal('unavailable') }).strict()
export const hostSpatialSchema = z.discriminatedUnion('status', [
  unavailable,
  z
    .object({
      status: z.literal('available'),
      coordinateSpace: z.enum(['page', 'document']),
      unit: z.literal('px'),
      boundsKind: z.literal('axis-aligned-no-effects'),
      bounds: z.object({ x: coordinate, y: coordinate, width: extent, height: extent }).strict()
    })
    .strict()
])
export const hostCanvasSchema = z.discriminatedUnion('status', [
  unavailable,
  z
    .object({
      status: z.literal('available'),
      unit: z.literal('px'),
      width: extent.positive(),
      height: extent.positive(),
      resolutionPpi: z.number().finite().positive().max(1_000_000),
      pixelAspectRatio: z.number().finite().positive().max(1_000)
    })
    .strict()
])
export type HostSpatial = z.output<typeof hostSpatialSchema>
export type HostCanvas = z.output<typeof hostCanvasSchema>

/** Native adapters pass only explicitly read scalar properties, never a whole host object. */
export function spatialBounds(
  coordinateSpace: 'page' | 'document',
  x: unknown,
  y: unknown,
  width: unknown,
  height: unknown
): HostSpatial {
  const result = hostSpatialSchema.safeParse({
    status: 'available',
    coordinateSpace,
    unit: 'px',
    boundsKind: 'axis-aligned-no-effects',
    bounds: { x, y, width, height }
  })
  return result.success ? result.data : { status: 'unavailable' }
}
export function spatialEdges(
  left: unknown,
  top: unknown,
  right: unknown,
  bottom: unknown
): HostSpatial {
  if (
    [left, top, right, bottom].some(
      (v) => typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 10_000_000
    )
  )
    return { status: 'unavailable' }
  return spatialBounds(
    'document',
    left,
    top,
    (right as number) - (left as number),
    (bottom as number) - (top as number)
  )
}
export function canvasMetrics(
  width: unknown,
  height: unknown,
  resolutionPpi: unknown,
  pixelAspectRatio: unknown
): HostCanvas {
  const result = hostCanvasSchema.safeParse({
    status: 'available',
    unit: 'px',
    width,
    height,
    resolutionPpi,
    pixelAspectRatio
  })
  return result.success ? result.data : { status: 'unavailable' }
}
