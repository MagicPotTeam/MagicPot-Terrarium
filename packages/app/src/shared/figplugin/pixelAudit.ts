import { z } from 'zod'

export const FIGPLUGIN_PIXEL_POLICY = 'rgba8-exact-v1' as const
const id = z.string().regex(/^[a-f0-9]{32}$/)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const requestId = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_-]{1,80}$(?![\s\S])/)
const executionLineageFields = {
  requestId: requestId.optional(),
  runId: id.optional(),
  correlationId: id.optional()
}
const targetId = z.string().min(1).max(160)
const pixelCount = z
  .number()
  .int()
  .min(0)
  .max(512 * 512)
const bounds = z
  .object({
    x: z.number().int().min(0).max(511),
    y: z.number().int().min(0).max(511),
    width: z.number().int().min(1).max(512),
    height: z.number().int().min(1).max(512)
  })
  .strict()
const compared = z
  .object({
    targetId,
    status: z.literal('compared'),
    pixelCount: pixelCount.min(1),
    changedPixels: pixelCount,
    maxChannelDelta: z.number().int().min(0).max(255),
    absoluteDelta: z
      .number()
      .int()
      .min(0)
      .max(512 * 512 * 4 * 255),
    changedBounds: bounds.nullable()
  })
  .strict()
export const figPluginPixelTargetSchema = z
  .discriminatedUnion('status', [
    compared,
    z.object({ targetId, status: z.literal('dimensions-changed') }).strict(),
    z.object({ targetId, status: z.literal('unavailable') }).strict()
  ])
  .superRefine((value, ctx) => {
    if (value.status !== 'compared') return
    const changed = value.changedPixels
    const invalid =
      changed > value.pixelCount ||
      (changed === 0 &&
        (value.maxChannelDelta !== 0 ||
          value.absoluteDelta !== 0 ||
          value.changedBounds !== null)) ||
      (changed > 0 &&
        (value.maxChannelDelta < 1 ||
          value.absoluteDelta < Math.max(changed, value.maxChannelDelta) ||
          value.absoluteDelta > changed * 4 * value.maxChannelDelta ||
          !value.changedBounds ||
          changed > value.changedBounds.width * value.changedBounds.height))
    if (invalid)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Inconsistent pixel metrics' })
  })
export type FigPluginPixelTarget = z.output<typeof figPluginPixelTargetSchema>
const targets = z
  .array(figPluginPixelTargetSchema)
  .min(1)
  .max(20)
  .superRefine((value, ctx) => {
    if (new Set(value.map((target) => target.targetId)).size !== value.length)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate pixel target' })
  })
const fields = {
  policy: z.literal(FIGPLUGIN_PIXEL_POLICY),
  baselineId: id,
  baselineEvidenceSha256: hash,
  visualEvidenceSha256: hash,
  targets
}
export const figPluginPixelAuditRequestSchema = z
  .object({
    protocol: z.literal(1),
    executionId: id,
    actionId: id,
    ...executionLineageFields,
    ...fields
  })
  .strict()
export type FigPluginPixelAuditRequest = z.output<typeof figPluginPixelAuditRequestSchema>

export function summarizePixelTargets(value: readonly FigPluginPixelTarget[]) {
  const comparedTargets = value.filter((target) => target.status === 'compared').length
  const unavailableTargets = value.filter((target) => target.status === 'unavailable').length
  const changedTargets = value.filter(
    (target) =>
      target.status === 'dimensions-changed' ||
      (target.status === 'compared' && target.changedPixels > 0)
  ).length
  const changedPixels = value.reduce(
    (sum, target) => sum + (target.status === 'compared' ? target.changedPixels : 0),
    0
  )
  return {
    outcome: unavailableTargets
      ? ('incomplete' as const)
      : changedTargets
        ? ('different' as const)
        : ('match' as const),
    comparedTargets,
    unavailableTargets,
    changedTargets,
    changedPixels
  }
}
export const figPluginPixelAuditSchema = z
  .object({
    ...fields,
    checkedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    outcome: z.enum(['match', 'different', 'incomplete']),
    comparedTargets: z.number().int().min(0).max(20),
    unavailableTargets: z.number().int().min(0).max(20),
    changedTargets: z.number().int().min(0).max(20),
    changedPixels: z
      .number()
      .int()
      .min(0)
      .max(20 * 512 * 512)
  })
  .strict()
  .superRefine((value, ctx) => {
    const expected = summarizePixelTargets(value.targets)
    if (
      Object.keys(expected).some(
        (key) => value[key as keyof typeof expected] !== expected[key as keyof typeof expected]
      )
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Pixel summary mismatch' })
  })
export type FigPluginPixelAudit = z.output<typeof figPluginPixelAuditSchema>

type Comparison = {
  baselineId: string
  baselineEvidenceSha256: string
  visualEvidenceSha256: string
  targets: Array<{
    targetId: string
    baseline: { sha256: string; width: number; height: number }
    current: { sha256: string; width: number; height: number }
  }>
}
/** Structural validation of host-reported evidence, not independent attestation of pixels. */
export function pixelAuditMatchesComparison(
  audit: Pick<
    FigPluginPixelAudit,
    'baselineId' | 'baselineEvidenceSha256' | 'visualEvidenceSha256' | 'targets'
  >,
  comparison: Comparison
): boolean {
  if (
    audit.baselineId !== comparison.baselineId ||
    audit.baselineEvidenceSha256 !== comparison.baselineEvidenceSha256 ||
    audit.visualEvidenceSha256 !== comparison.visualEvidenceSha256 ||
    audit.targets.length !== comparison.targets.length
  )
    return false
  const current = new Map(comparison.targets.map((target) => [target.targetId, target]))
  return audit.targets.every((target) => {
    const ref = current.get(target.targetId)
    if (!ref) return false
    const sameDimensions =
      ref.baseline.width === ref.current.width && ref.baseline.height === ref.current.height
    if (target.status === 'unavailable') return true
    if (target.status === 'dimensions-changed') return !sameDimensions
    const area = target.changedBounds
    return (
      sameDimensions &&
      target.pixelCount === ref.current.width * ref.current.height &&
      !(ref.baseline.sha256 === ref.current.sha256 && target.changedPixels !== 0) &&
      (!area ||
        (area.x + area.width <= ref.current.width && area.y + area.height <= ref.current.height))
    )
  })
}
