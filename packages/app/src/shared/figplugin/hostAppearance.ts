import { z } from 'zod'

// Read-only observations. No resource bytes, URLs, native objects or write capabilities.
const unit = z.number().finite().min(0).max(1)
const percent = z.number().finite().min(0).max(100)
const scalar = z.number().finite().min(-1e6).max(1e6)
const unavailable = z.object({ status: z.literal('unavailable') }).strict()
// Stop before element validation/allocation beyond the cap. Never invoke native iterators.
function boundedArray<T extends z.ZodTypeAny>(item: T, max: number, min = 0) {
  return z.preprocess((raw) => {
    try {
      if (!Array.isArray(raw)) return null
      const count = raw.length
      if (!Number.isSafeInteger(count) || count < min || count > max) return null
      const copy: unknown[] = []
      for (let i = 0; i < count; i++) copy.push(raw[i])
      return copy
    } catch {
      return null
    }
  }, z.array(item).min(min).max(max))
}
const rgb = z.object({ r: unit, g: unit, b: unit }).strict()
const rgba = rgb.extend({ a: unit }).strict()
const transform = z.tuple([z.tuple([scalar, scalar, scalar]), z.tuple([scalar, scalar, scalar])])
const common = {
  visible: z.boolean().optional(),
  opacity: unit.optional(),
  blendMode: z
    .string()
    .regex(/^[A-Z][A-Z_]{0,31}$(?![\s\S])/)
    .optional()
}
const filterValue = z.number().finite().min(-1).max(1)
const filters = z
  .object({
    exposure: filterValue.optional(),
    contrast: filterValue.optional(),
    saturation: filterValue.optional(),
    temperature: filterValue.optional(),
    tint: filterValue.optional(),
    highlights: filterValue.optional(),
    shadows: filterValue.optional()
  })
  .strict()
const paintSchema = z.union([
  z.object({ type: z.literal('SOLID'), color: rgb, ...common }).strict(),
  z
    .object({
      type: z.enum(['GRADIENT_LINEAR', 'GRADIENT_RADIAL', 'GRADIENT_ANGULAR', 'GRADIENT_DIAMOND']),
      gradientTransform: transform,
      gradientStops: boundedArray(z.object({ position: unit, color: rgba }).strict(), 16, 1),
      ...common
    })
    .strict(),
  z
    .object({
      type: z.literal('IMAGE'),
      coverage: z.literal('reference-only'),
      imageHash: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,128}$(?![\s\S])/)
        .nullable(),
      scaleMode: z.enum(['FILL', 'FIT', 'CROP', 'TILE']),
      imageTransform: transform.optional(),
      scalingFactor: z.number().finite().positive().max(1e6).optional(),
      rotation: scalar.optional(),
      filters: filters.optional(),
      ...common
    })
    .strict(),
  // Preserve position in the paint stack, never falsely turn an unknown paint into absence.
  z.object({ type: z.literal('unavailable') }).strict()
])
const paintList = z.union([
  unavailable,
  z.object({ status: z.literal('mixed') }).strict(),
  z.object({ status: z.literal('available'), paints: boundedArray(paintSchema, 16) }).strict()
])
const psColor = z.discriminatedUnion('model', [
  z
    .object({
      model: z.literal('RGB'),
      red: z.number().finite().min(0).max(255),
      green: z.number().finite().min(0).max(255),
      blue: z.number().finite().min(0).max(255)
    })
    .strict(),
  z
    .object({
      model: z.literal('CMYK'),
      cyan: percent,
      magenta: percent,
      yellow: percent,
      black: percent
    })
    .strict(),
  z.object({ model: z.literal('GRAYSCALE'), gray: percent }).strict(),
  z
    .object({
      model: z.literal('LAB'),
      l: percent,
      a: z.number().finite().min(-128).max(127),
      b: z.number().finite().min(-128).max(127)
    })
    .strict(),
  z
    .object({
      model: z.literal('HSB'),
      hue: z.number().finite().min(0).max(360),
      saturation: percent,
      brightness: percent
    })
    .strict()
])
export const hostAppearanceSchema = z
  .union([
    unavailable,
    z
      .object({
        status: z.literal('available'),
        kind: z.literal('figma-paints'),
        coverage: z.literal('paint-properties-only'),
        colorEncoding: z.literal('document-rgb-0..1'),
        documentColorProfile: z.enum(['LEGACY', 'SRGB', 'DISPLAY_P3', 'unknown']),
        fills: paintList,
        strokes: paintList
      })
      .strict(),
    z
      .object({
        status: z.literal('available'),
        kind: z.literal('photoshop-text-color'),
        coverage: z.literal('primary-style-only'),
        colorEncoding: z.literal('native-unconverted'),
        color: psColor
      })
      .strict()
  ])
  .superRefine((value, ctx) => {
    // Plain validated ASCII/numeric observations only; bound the serialized result per node.
    if (JSON.stringify(value).length > 12 * 1024)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Appearance is too large' })
  })
export type HostAppearance = z.output<typeof hostAppearanceSchema>
type Paint = z.output<typeof paintSchema>
type PaintList = z.output<typeof paintList>
const record = (v: unknown): Record<string, unknown> => {
  if (v === null || typeof v !== 'object' || Array.isArray(v))
    throw new Error('INVALID_OBSERVATION')
  return v as Record<string, unknown>
}
const copyColor = (v: unknown, alpha: boolean) => {
  const c = record(v)
  // r/g/b are the document-profile projection, not the optional authored sourceColor.
  return { r: c.r, g: c.g, b: c.b, ...(alpha ? { a: c.a } : {}) }
}
const copyTransform = (v: unknown) => {
  if (!Array.isArray(v) || v.length !== 2) throw new Error('INVALID_OBSERVATION')
  const result: unknown[][] = []
  for (let i = 0; i < 2; i++) {
    const row = v[i]
    if (!Array.isArray(row) || row.length !== 3) throw new Error('INVALID_OBSERVATION')
    result.push([row[0], row[1], row[2]])
  }
  return result
}
function observePaint(raw: unknown): Paint {
  try {
    const p = record(raw)
    const commonFields: Record<string, unknown> = {}
    for (const key of ['visible', 'opacity', 'blendMode']) {
      const value = p[key]
      if (value !== undefined) commonFields[key] = value
    }
    let value: Record<string, unknown>
    if (p.type === 'SOLID')
      value = { type: p.type, color: copyColor(p.color, false), ...commonFields }
    else if (
      ['GRADIENT_LINEAR', 'GRADIENT_RADIAL', 'GRADIENT_ANGULAR', 'GRADIENT_DIAMOND'].includes(
        p.type as string
      )
    ) {
      const stops = p.gradientStops
      if (!Array.isArray(stops)) return { type: 'unavailable' }
      const count = stops.length
      if (!Number.isSafeInteger(count) || count < 1 || count > 16) return { type: 'unavailable' }
      const observedStops: unknown[] = []
      for (let i = 0; i < count; i++) {
        const stop = record(stops[i])
        observedStops.push({ position: stop.position, color: copyColor(stop.color, true) })
      }
      value = {
        type: p.type,
        gradientTransform: copyTransform(p.gradientTransform),
        gradientStops: observedStops,
        ...commonFields
      }
    } else if (p.type === 'IMAGE') {
      value = {
        type: p.type,
        coverage: 'reference-only',
        imageHash: p.imageHash,
        scaleMode: p.scaleMode,
        ...commonFields
      }
      if (p.imageTransform !== undefined) value.imageTransform = copyTransform(p.imageTransform)
      for (const key of ['scalingFactor', 'rotation']) {
        const v = p[key]
        if (v !== undefined) value[key] = v
      }
      if (p.filters !== undefined) {
        const source = record(p.filters)
        const result: Record<string, unknown> = {}
        for (const key of [
          'exposure',
          'contrast',
          'saturation',
          'temperature',
          'tint',
          'highlights',
          'shadows'
        ]) {
          const v = source[key]
          if (v !== undefined) result[key] = v
        }
        value.filters = result
      }
    } else return { type: 'unavailable' }
    const checked = paintSchema.safeParse(value)
    return checked.success ? checked.data : { type: 'unavailable' }
  } catch {
    return { type: 'unavailable' }
  }
}
function observePaints(value: unknown, mixed: unknown): PaintList {
  try {
    if (typeof mixed === 'symbol' && value === mixed) return { status: 'mixed' }
    if (!Array.isArray(value)) return { status: 'unavailable' }
    const count = value.length
    if (!Number.isSafeInteger(count) || count < 0 || count > 16) return { status: 'unavailable' }
    const paints: Paint[] = []
    for (let i = 0; i < count; i++) paints.push(observePaint(value[i]))
    return { status: 'available', paints }
  } catch {
    return { status: 'unavailable' }
  }
}
export function figmaAppearance(
  fills: unknown,
  strokes: unknown,
  profile: unknown,
  mixed?: unknown
): HostAppearance {
  try {
    const result = hostAppearanceSchema.safeParse({
      status: 'available',
      kind: 'figma-paints',
      coverage: 'paint-properties-only',
      colorEncoding: 'document-rgb-0..1',
      documentColorProfile: ['LEGACY', 'SRGB', 'DISPLAY_P3'].includes(profile as string)
        ? profile
        : 'unknown',
      fills: observePaints(fills, mixed),
      strokes: observePaints(strokes, mixed)
    })
    return result.success ? result.data : { status: 'unavailable' }
  } catch {
    return { status: 'unavailable' }
  }
}
/** Read SolidColor.base, not rgb/cmyk/etc conversion accessors. Only bounded native components. */
export function photoshopTextAppearance(rawBase: unknown): HostAppearance {
  try {
    const base = record(rawBase)
    let color: Record<string, unknown>
    switch (base.typename) {
      case 'RGBColor':
        color = { model: 'RGB', red: base.red, green: base.green, blue: base.blue }
        break
      case 'CMYKColor':
        color = {
          model: 'CMYK',
          cyan: base.cyan,
          magenta: base.magenta,
          yellow: base.yellow,
          black: base.black
        }
        break
      case 'GrayColor':
        color = { model: 'GRAYSCALE', gray: base.gray }
        break
      case 'LabColor':
        color = { model: 'LAB', l: base.l, a: base.a, b: base.b }
        break
      case 'HSBColor':
        color = {
          model: 'HSB',
          hue: base.hue,
          saturation: base.saturation,
          brightness: base.brightness
        }
        break
      default:
        return { status: 'unavailable' }
    }
    const result = hostAppearanceSchema.safeParse({
      status: 'available',
      kind: 'photoshop-text-color',
      coverage: 'primary-style-only',
      colorEncoding: 'native-unconverted',
      color
    })
    return result.success ? result.data : { status: 'unavailable' }
  } catch {
    return { status: 'unavailable' }
  }
}
