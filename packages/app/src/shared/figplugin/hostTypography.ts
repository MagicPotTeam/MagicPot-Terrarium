import { z } from 'zod'

// Observed font metadata, not install paths, downloadable font files or write permission.
const label = z.string().min(1).max(128)
const axes = z
  .record(z.string().regex(/^[A-Za-z0-9 ]{4}$/), z.number().finite().min(-1e6).max(1e6))
  .refine((value) => Object.keys(value).length <= 16)
  .transform((value) =>
    Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  )
export const hostFontNameSchema = z
  .object({ family: label, style: label, variationSettings: axes.optional() })
  .strict()
const run = z
  .object({
    start: z.number().int().min(0).max(4096),
    end: z.number().int().min(0).max(4096),
    font: hostFontNameSchema,
    fontSizePx: z.number().finite().min(1).max(1e6)
  })
  .strict()
const figmaTypographySchema = z
  .object({
    status: z.literal('available'),
    kind: z.literal('figma-font-runs'),
    hasMissingFont: z.boolean(),
    characterCount: z.number().int().min(0).max(4096),
    runs: z.array(run).min(1).max(64)
  })
  .strict()
  .superRefine((value, ctx) => {
    let offset = 0
    for (const item of value.runs) {
      if (
        item.start !== offset ||
        item.end < item.start ||
        (value.characterCount > 0 && item.end === item.start)
      ) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Incomplete font ranges' })
      }
      offset = item.end
    }
    if (offset !== value.characterCount || (offset === 0 && value.runs.length !== 1))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Incomplete font ranges' })
    const fonts = [...new Set(value.runs.map((item) => JSON.stringify(item.font)))].sort()
    if (fonts.length > 16 || utf8Bytes(JSON.stringify(fonts)) > 4096)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Font metadata is too large' })
  })
export const hostTypographySchema = z.union([
  z.object({ status: z.literal('unavailable') }).strict(),
  figmaTypographySchema,
  z
    .object({
      status: z.literal('available'),
      kind: z.literal('photoshop-character-style'),
      coverage: z.literal('primary-style-only'),
      fontPostScriptName: label,
      size: z
        .object({ value: z.number().finite().min(0.01).max(1296), unit: z.literal('px-at-72ppi') })
        .strict()
    })
    .strict()
])
export type HostTypography = z.output<typeof hostTypographySchema>
export type HostFontName = z.output<typeof hostFontNameSchema>
function utf8Bytes(text: string): number {
  let size = 0
  for (const char of text) {
    const point = char.codePointAt(0)!
    size += point <= 127 ? 1 : point <= 2047 ? 2 : point <= 65535 ? 3 : 4
  }
  return size
}

/** Copies just requested observations, never characters, native errors or other object fields. */
export function figmaTypography(
  text: unknown,
  hasMissingFont: unknown,
  segments: unknown
): HostTypography {
  try {
    if (
      typeof text !== 'string' ||
      text.length > 4096 ||
      !Array.isArray(segments) ||
      segments.length < 1 ||
      segments.length > 64
    )
      return { status: 'unavailable' }
    const runs = segments.map((segment) => ({
      start: segment.start,
      end: segment.end,
      font: hostFontNameSchema.parse(segment.fontName),
      fontSizePx: segment.fontSize
    }))
    const parsed = figmaTypographySchema.safeParse({
      status: 'available',
      kind: 'figma-font-runs',
      characterCount: text.length,
      hasMissingFont,
      runs
    })
    return parsed.success ? parsed.data : { status: 'unavailable' }
  } catch {
    return { status: 'unavailable' }
  }
}
export function photoshopTypography(font: unknown, size: unknown): HostTypography {
  try {
    const parsed = hostTypographySchema.safeParse({
      status: 'available',
      kind: 'photoshop-character-style',
      coverage: 'primary-style-only',
      fontPostScriptName: font,
      size: { value: size, unit: 'px-at-72ppi' }
    })
    return parsed.success ? parsed.data : { status: 'unavailable' }
  } catch {
    return { status: 'unavailable' }
  }
}
/** Stable font identity only, not a claim to preserve every style run on text replacement. */
export function typographyFontKey(input: HostTypography): string | undefined {
  if (input.status !== 'available') return undefined
  return input.kind === 'figma-font-runs'
    ? JSON.stringify([...new Set(input.runs.map((item) => JSON.stringify(item.font)))].sort())
    : JSON.stringify({ postScriptName: input.fontPostScriptName })
}
export function requiredFigmaFonts(input: HostTypography): HostFontName[] {
  const value = figmaTypographySchema.parse(input)
  if (value.hasMissingFont) throw new Error('FONT_UNAVAILABLE')
  const unique = new Map(value.runs.map((item) => [JSON.stringify(item.font), item.font]))
  return [...unique.values()]
}
