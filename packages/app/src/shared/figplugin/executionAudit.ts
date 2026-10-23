import { z } from 'zod'
import { figPluginExecutionStatusSchema } from './execution'

export const FIGPLUGIN_AUDIT_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const FIGPLUGIN_AUDIT_MAX_RECORDS = 256
export const FIGPLUGIN_AUDIT_MAX_BYTES = 1024 * 1024
export const FIGPLUGIN_AUDIT_MAX_LINE_BYTES = 4096

export const figPluginExecutionAuditEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    at: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    executionId: z
      .string()
      .length(32)
      .regex(/^[a-f0-9]{32}$/),
    callId: z
      .string()
      .length(32)
      .regex(/^[a-f0-9]{32}$/),
    requestId: z.string().min(1).max(80),
    pluginId: z.string().min(1).max(128),
    host: z.enum(['figma', 'photoshop']),
    projectId: z.string().min(1).max(160),
    state: z.enum([
      'awaiting-approval',
      'approved',
      'claimed',
      'executing',
      'readback',
      'completed',
      'cancelled',
      'denied',
      'failed',
      'expired'
    ]),
    completed: z.number().int().min(0).max(20),
    total: z.number().int().min(1).max(20),
    effect: z.enum(['none', 'applied', 'rolled-back', 'partial', 'unknown']),
    risk: z.enum(['low', 'medium', 'high']),
    planSha256: z
      .string()
      .length(64)
      .regex(/^[a-f0-9]{64}$/),
    previewSha256: z
      .string()
      .length(64)
      .regex(/^[a-f0-9]{64}$/),
    adapterVersion: z.string().min(1).max(64),
    rollback: z.enum(['verified-in-place', 'native-history', 'none']),
    visualAudit: z.enum(['hash-only', 'unavailable']),
    visualEvidenceCount: z.number().int().min(1).max(20).optional(),
    visualEvidenceSha256: z
      .string()
      .length(64)
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    visualBaselineId: z
      .string()
      .length(32)
      .regex(/^[a-f0-9]{32}$/)
      .optional(),
    visualBaselineEvidenceSha256: z
      .string()
      .length(64)
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    visualBaselineAcceptedAt: z.number().int().min(0).optional(),
    visualBaselineExpiresAt: z.number().int().min(0).optional(),
    maxCorrectionRounds: z.number().int().min(1).max(10).optional(),
    visualComparisonBaselineId: z
      .string()
      .length(32)
      .regex(/^[a-f0-9]{32}$/)
      .optional(),
    visualComparisonTargetCount: z.number().int().min(1).max(20).optional(),
    visualComparisonChangedCount: z.number().int().min(0).max(20).optional(),
    visualComparisonSha256: z
      .string()
      .length(64)
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    visualCorrectionAuthorizationId: z
      .string()
      .length(32)
      .regex(/^[a-f0-9]{32}$/)
      .optional(),
    visualCorrectionRound: z.number().int().min(1).max(10).optional(),
    visualCorrectionMaxRounds: z.number().int().min(1).max(10).optional(),
    visualCorrectionTargetCount: z.number().int().min(1).max(20).optional(),
    visualCorrectionComparisonSha256: z
      .string()
      .length(64)
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    visualCorrectionExpiresAt: z.number().int().min(0).optional(),
    taskRecovery: z
      .object({
        baselineId: z.string().regex(/^[a-f0-9]{32}$/),
        sourceExecutionId: z.string().regex(/^[a-f0-9]{32}$/),
        round: z.number().int().min(1).max(3),
        maxCorrectionRounds: z.literal(3),
        targetCount: z.number().int().min(1).max(20),
        consumed: z.boolean(),
        reassociationRequested: z.literal(true).optional(),
        documentReassociationRequested: z.literal(true).optional()
      })
      .strict()
      .optional(),
    correctionAttempt: z
      .object({
        authorizationId: z.string().regex(/^[a-f0-9]{32}$/),
        baselineId: z.string().regex(/^[a-f0-9]{32}$/),
        sourceExecutionId: z.string().regex(/^[a-f0-9]{32}$/),
        round: z.number().int().min(1).max(3),
        maxCorrectionRounds: z.literal(3),
        targetCount: z.number().int().min(1).max(20),
        consumed: z.boolean()
      })
      .strict()
      .optional(),
    pixelAudit: z
      .object({
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
      .optional(),
    durationMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    errorCode: figPluginExecutionStatusSchema.innerType().shape.errorCode
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.pixelAudit &&
      (value.state !== 'completed' ||
        value.effect !== 'applied' ||
        value.visualComparisonBaselineId === undefined)
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Pixel audit is not bound to completed comparison'
      })
    if (value.pixelAudit) {
      const a = value.pixelAudit,
        count = value.visualComparisonTargetCount ?? 0
      const resized = count - a.comparedTargets - a.unavailableTargets
      const outcome = a.unavailableTargets ? 'incomplete' : a.changedTargets ? 'different' : 'match'
      if (
        resized < 0 ||
        a.changedTargets < resized ||
        a.changedTargets > count - a.unavailableTargets ||
        a.changedPixels > a.comparedTargets * 512 * 512 ||
        (a.changedPixels > 0 && a.changedTargets <= resized) ||
        a.outcome !== outcome ||
        (a.outcome === 'match' && a.comparedTargets !== count)
      )
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Inconsistent pixel audit summary' })
    }
    if (
      new TextEncoder().encode(`${JSON.stringify(value)}\n`).byteLength >
      FIGPLUGIN_AUDIT_MAX_LINE_BYTES
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Audit event exceeds its byte budget' })
    if (
      value.taskRecovery &&
      (value.correctionAttempt ||
        (['claimed', 'executing', 'readback', 'completed'].includes(value.state) &&
          !value.taskRecovery.consumed))
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid recovery consumption' })
    if (value.completed > value.total)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid audit progress' })
    if (
      value.correctionAttempt &&
      ['claimed', 'executing', 'readback', 'completed'].includes(value.state) &&
      !value.correctionAttempt.consumed
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Active correction was not consumed' })
    if ((value.visualEvidenceCount === undefined) !== (value.visualEvidenceSha256 === undefined))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Incomplete visual evidence audit' })
    if (value.visualEvidenceCount !== undefined && value.state !== 'completed')
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Visual evidence audit is not completed'
      })
    const baselineFields = [
      value.visualBaselineId,
      value.visualBaselineEvidenceSha256,
      value.visualBaselineAcceptedAt,
      value.visualBaselineExpiresAt,
      value.maxCorrectionRounds
    ]
    const baselineCount = baselineFields.filter((field) => field !== undefined).length
    if (baselineCount !== 0 && baselineCount !== baselineFields.length)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Incomplete visual baseline audit' })
    if (
      baselineCount !== 0 &&
      (value.state !== 'completed' ||
        value.effect !== 'applied' ||
        value.visualEvidenceCount === undefined)
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Visual baseline is not accepted success'
      })
    if (
      value.visualBaselineAcceptedAt !== undefined &&
      value.visualBaselineExpiresAt !== undefined &&
      value.visualBaselineExpiresAt <= value.visualBaselineAcceptedAt
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid visual baseline audit expiry' })
    const comparisonFields = [
      value.visualComparisonBaselineId,
      value.visualComparisonTargetCount,
      value.visualComparisonChangedCount,
      value.visualComparisonSha256
    ]
    const comparisonCount = comparisonFields.filter((field) => field !== undefined).length
    if (comparisonCount !== 0 && comparisonCount !== comparisonFields.length)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Incomplete visual comparison audit' })
    if (
      comparisonCount !== 0 &&
      (value.state !== 'completed' ||
        value.effect !== 'applied' ||
        value.visualEvidenceCount === undefined)
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Visual comparison is not applied success'
      })
    if (
      value.visualComparisonTargetCount !== undefined &&
      value.visualEvidenceCount !== undefined &&
      value.visualComparisonTargetCount !== value.visualEvidenceCount
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Visual comparison target count mismatch'
      })
    if (
      value.visualComparisonTargetCount !== undefined &&
      value.visualComparisonChangedCount !== undefined &&
      value.visualComparisonChangedCount > value.visualComparisonTargetCount
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Visual comparison changed count mismatch'
      })
    const correctionFields = [
      value.visualCorrectionAuthorizationId,
      value.visualCorrectionRound,
      value.visualCorrectionMaxRounds,
      value.visualCorrectionTargetCount,
      value.visualCorrectionComparisonSha256,
      value.visualCorrectionExpiresAt
    ]
    const correctionCount = correctionFields.filter((field) => field !== undefined).length
    if (correctionCount !== 0 && correctionCount !== correctionFields.length)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Incomplete visual correction authorization audit'
      })
    if (
      correctionCount !== 0 &&
      (comparisonCount === 0 ||
        value.state !== 'completed' ||
        value.effect !== 'applied' ||
        value.visualComparisonChangedCount === undefined ||
        value.visualComparisonChangedCount < 1)
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Visual correction authorization has no changed comparison'
      })
    if (
      value.visualCorrectionRound !== undefined &&
      value.visualCorrectionMaxRounds !== undefined &&
      value.visualCorrectionRound > value.visualCorrectionMaxRounds
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Visual correction authorization round mismatch'
      })
    if (
      value.visualCorrectionTargetCount !== undefined &&
      value.visualComparisonChangedCount !== undefined &&
      value.visualCorrectionTargetCount !== value.visualComparisonChangedCount
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Visual correction authorization target count mismatch'
      })
    if (
      value.visualCorrectionComparisonSha256 !== undefined &&
      value.visualComparisonSha256 !== undefined &&
      value.visualCorrectionComparisonSha256 !== value.visualComparisonSha256
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Visual correction authorization comparison mismatch'
      })
    if (
      value.visualCorrectionExpiresAt !== undefined &&
      value.visualCorrectionExpiresAt <= value.at
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid visual correction authorization expiry'
      })
  })
export type FigPluginExecutionAuditEvent = z.output<typeof figPluginExecutionAuditEventSchema>

/** This projection is historical evidence, never a session or executable authority. */
export const figPluginExecutionHistoryRequestSchema = z
  .object({
    pluginId: z.string().min(1).max(128).optional(),
    projectId: z.string().min(1).max(160).optional(),
    limit: z.number().int().min(1).max(FIGPLUGIN_AUDIT_MAX_RECORDS).optional()
  })
  .strict()
export type FigPluginExecutionHistoryRequest = z.output<
  typeof figPluginExecutionHistoryRequestSchema
>

export const figPluginExecutionHistorySchema = z
  .object({
    records: z.array(figPluginExecutionAuditEventSchema).max(FIGPLUGIN_AUDIT_MAX_RECORDS),
    truncated: z.boolean(),
    recordedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    retentionMs: z.literal(FIGPLUGIN_AUDIT_TTL_MS),
    maxRecords: z.literal(FIGPLUGIN_AUDIT_MAX_RECORDS),
    maxBytes: z.literal(FIGPLUGIN_AUDIT_MAX_BYTES),
    writeFailed: z.boolean()
  })
  .strict()
export type FigPluginExecutionHistory = z.output<typeof figPluginExecutionHistorySchema>
